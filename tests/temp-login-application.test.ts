import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as Vue from 'vue'
import { Store } from '../src/main/store'
import { Instances } from '../src/main/instances'
import { OfficialTempLogin, supportsOfficialTempLogin } from '../src/main/tempLogin'
import type { DesktopRuntime } from '../src/main/instanceRuntime'
import type { InstanceApplication } from '../src/shared/instances'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-login-applications-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const application = (name: string, executable: string): InstanceApplication => {
    const path = join(root, `${name}.app`); mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(path, 'Contents', 'MacOS', executable), 'fixture-not-executed', { mode: 0o700 })
    return { id: `fixture-${name}`, name, path, kind: 'desktop' }
  }
  const codex = application('Codex', 'Codex'), chatgpt = application('ChatGPT', 'ChatGPT')
  const store = new Store(join(root, 'vault'), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const runtime: DesktopRuntime = { find: async () => undefined, launch: async () => assert.fail('An unsupported app must not be launched'), stop: async () => {}, focus: async () => {} }
  return { root, codex, chatgpt, store, runtime }
}

test('official login verifies the actual Codex executable and rejects ChatGPT even when its reported capability is forged', async t => {
  const f = fixture(t)
  assert.equal(supportsOfficialTempLogin(f.codex), true)
  assert.equal(supportsOfficialTempLogin(f.chatgpt), false)
  assert.equal(supportsOfficialTempLogin({ ...f.codex, kind: 'cli' }), false)
  const login = new OfficialTempLogin(f.store, () => [{ ...f.chatgpt, supportsTempLogin: true }], f.runtime)
  t.after(() => login.stop())
  assert.throws(() => login.start({ applicationId: f.chatgpt.id, interceptAuthUrl: false, credentialStore: 'file' }), /Codex/)
  assert.equal(login.current().running, false)
  assert.equal(existsSync(join(f.store.directory, 'temp-login')), false)
  assert.equal(f.store.read().accounts.length, 0)
})

test('official login capability disappears when its executable is missing, not executable, or redirected through a symlink', t => {
  const f = fixture(t), executable = join(f.codex.path, 'Contents', 'MacOS', 'Codex')
  chmodSync(executable, 0o600); assert.equal(supportsOfficialTempLogin(f.codex), false)
  rmSync(executable); symlinkSync(join(f.chatgpt.path, 'Contents', 'MacOS', 'ChatGPT'), executable)
  assert.equal(supportsOfficialTempLogin(f.codex), false)
  rmSync(executable); assert.equal(supportsOfficialTempLogin(f.codex), false)
})

test('application discovery derives login capability while existing general ChatGPT registrations remain usable', async t => {
  const f = fixture(t), instances = new Instances(f.store, () => assert.fail('Discovery must not create a gateway'), async () => assert.fail('Discovery must not load credentials'), f.runtime)
  t.after(() => instances.closeAll())
  const chatgpt = instances.registerApplication(f.chatgpt.path), codex = instances.registerApplication(f.codex.path)
  const applications = instances.applications()
  assert.equal(applications.find(a => a.id === chatgpt.id)?.supportsTempLogin, false)
  assert.equal(applications.find(a => a.id === codex.id)?.supportsTempLogin, true)
  assert.ok(f.store.read().instanceApplications?.some(a => a.id === chatgpt.id))
  assert.ok(f.store.read().instanceApplications?.every(a => !Object.hasOwn(a, 'supportsTempLogin')))
  rmSync(join(f.codex.path, 'Contents', 'MacOS', 'Codex'))
  assert.equal(instances.applications().find(a => a.id === codex.id)?.supportsTempLogin, false)
})

function panel(t: TestContext, applications: InstanceApplication[]) {
  const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/TempLoginPanel.vue'), 'utf8')
  const descriptor = parse(source).descriptor
  const compiled = ts.transpileModule(compileScript(descriptor, { id: 'temp-login-capability-test' }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const manager = Vue.reactive({ data: { instanceApplications: applications }, loading: false })
  const exported: { default?: { setup: (props: unknown, context: unknown) => Record<string, any> } } = {}
  runInNewContext(compiled, { exports: exported, require: (name: string) => {
    if (name === 'vue') return Vue
    if (name === '../store') return { useManager: () => manager }
    throw new Error(`Unexpected test import: ${name}`)
  } })
  assert.ok(exported.default)
  const scope = Vue.effectScope(); t.after(() => scope.stop())
  const bindings = scope.run(() => exported.default!.setup({ disabled: false }, { expose: () => {} }))!
  return { manager, bindings }
}

test('the actual login panel defaults to supported Codex rather than an earlier ChatGPT or CLI entry', async t => {
  const f = fixture(t), { manager, bindings } = panel(t, [
    { ...f.chatgpt, supportsTempLogin: false }, { id: 'cli', name: 'Codex CLI', path: '/fixture/codex', kind: 'cli', supportsTempLogin: false },
    { ...f.codex, supportsTempLogin: true }
  ])
  assert.equal(bindings.applicationId.value, f.codex.id)
  assert.deepEqual(bindings.applications.value.map((a: InstanceApplication) => a.id), [f.codex.id])
  manager.data.instanceApplications = [{ ...f.chatgpt, supportsTempLogin: false }]
  await Vue.nextTick()
  assert.equal(bindings.applicationId.value, '')
  assert.equal(bindings.applications.value.length, 0)
})

test('legacy or unsupported applications are not silently treated as temporary-login capable', t => {
  const f = fixture(t), { bindings } = panel(t, [f.chatgpt, f.codex])
  assert.equal(bindings.applicationId.value, '')
  assert.equal(bindings.applications.value.length, 0)
})
