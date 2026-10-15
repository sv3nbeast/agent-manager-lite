import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertClaudeDesktopNetworkCapability, prepareClaudeDesktopNetwork } from '../src/main/claudeDesktopNetwork'
import type { DesktopPlan } from '../src/main/instanceRuntime'

// A small valid ASAR exercises the same bounded archive reader in Node and
// packaged Electron. Nothing in the synthetic application is executable.
function archive(path: string, source: string, main = '.vite/build/native-entry.js') {
  const entries = [
    ['package.json', JSON.stringify({ name: '@ant/desktop', main })],
    [main.replace(/^\.\//, ''), source],
  ]
  const files: any = { files: {} }, bodies: Buffer[] = []
  let offset = 0
  for (const [entry, body] of entries) {
    const buffer = Buffer.from(body), parts = entry.split('/')
    let parent = files
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ??= { files: {} }
    parent.files[parts.at(-1)!] = { size: buffer.length, offset: String(offset) }
    bodies.push(buffer); offset += buffer.length
  }
  const json = Buffer.from(JSON.stringify(files)), header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4), size = Buffer.alloc(8)
  header.writeUInt32LE(header.length - 4, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8)
  size.writeUInt32LE(4, 0); size.writeUInt32LE(header.length, 4)
  writeFileSync(path, Buffer.concat([size, header, ...bodies]))
}

const nativeSource = 'const schema={flatKey:"egressProxyUrl",support:{enabled:{scopes:["3p","1p"]}},appBehaviorOnly:true}; const names=["configLibrary","_meta.json","appliedId","egressProxyPacUrl","proxy-server","proxy-pac-url","-3p"];'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-network-'))), application = join(root, 'Claude.app')
  mkdirSync(join(application, 'Contents', 'Resources'), { recursive: true })
  const asar = join(application, 'Contents', 'Resources', 'app.asar')
  archive(asar, nativeSource)
  const instance = join(root, 'instance'), desktopDirectory = join(instance, 'desktop'), directory = join(instance, 'home')
  mkdirSync(desktopDirectory, { recursive: true }); mkdirSync(directory)
  const plan: DesktopPlan = { clientType: 'claude_code', mode: 'desktop', application, executable: join(application, 'Contents', 'MacOS', 'Claude'), desktopDirectory, directory, workingDirectory: join(instance, 'workspace'), args: [], nonce: randomUUID(), networkRoute: { mode: 'proxy', url: 'http://127.0.0.1:21918' } }
  const library = `${desktopDirectory}-3p/configLibrary`, meta = join(library, '_meta.json'), journal = join(instance, '.cml-claude-desktop-network.json')
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  const current = () => read(join(library, `${read(meta).appliedId}.json`))
  const setup = (config: Record<string, unknown>, extraMeta: Record<string, unknown> = {}) => {
    mkdirSync(library, { recursive: true })
    const id = randomUUID(), path = join(library, `${id}.json`)
    writeFileSync(path, JSON.stringify(config)); writeFileSync(meta, JSON.stringify({ appliedId: id, ...extraMeta }))
    return { id, path }
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, instance, application, asar, plan, library, meta, journal, setup, read, current }
}

test('native Desktop proxy preserves local settings and metadata without selecting a login or deployment mode', t => {
  const f = fixture(t)
  const original = { theme: 'dark', inferenceProvider: 'native-user-choice', egressProxyPacUrl: 'https://native.invalid/proxy.pac', toolPolicy: { allow: ['Read'] } }
  const source = f.setup(original, { libraryVersion: 3, favorites: ['local'] })
  const deployment = join(`${f.plan.desktopDirectory}-3p`, 'claude_desktop_config.json')
  writeFileSync(deployment, '{"deploymentMode":"3p","custom":true}')
  prepareClaudeDesktopNetwork(f.plan)
  const firstId = f.read(f.meta).appliedId
  assert.notEqual(firstId, source.id)
  assert.deepEqual(f.current(), { theme: 'dark', inferenceProvider: 'native-user-choice', toolPolicy: { allow: ['Read'] }, egressProxyUrl: 'http://127.0.0.1:21918' })
  assert.deepEqual(f.read(source.path), original)
  assert.deepEqual(f.read(f.meta), { appliedId: firstId, libraryVersion: 3, favorites: ['local'] })
  assert.equal(readFileSync(deployment, 'utf8'), '{"deploymentMode":"3p","custom":true}')
  for (const path of [f.meta, f.journal, join(f.library, `${firstId}.json`)]) assert.equal(lstatSync(path).mode & 0o777, 0o600)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:22918' }
  prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.read(f.meta).appliedId, firstId, 'normal restarts reuse the manager entry')
  assert.equal(f.current().egressProxyUrl, 'http://127.0.0.1:22918')
  f.plan.networkRoute = undefined
  prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.current(), original)
  assert.equal(f.read(f.meta).appliedId, source.id)
  assert.equal(existsSync(f.journal), false)
  assert.equal(existsSync(join(f.library, `${firstId}.json`)), false)
})

test('inherit on a new instance performs no writes and proxy to inherit removes the old loopback pin', t => {
  const f = fixture(t)
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(existsSync(`${f.plan.desktopDirectory}-3p`), false)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23918' }; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(Object.keys(f.current()), ['egressProxyUrl'])
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(existsSync(f.meta), false)
  assert.deepEqual(readdirSync(f.library), [])
  assert.equal(existsSync(f.journal), false)
  prepareClaudeDesktopNetwork(f.plan)
})

test('original fixed proxy and PAC settings return after multiple network changes', t => {
  const f = fixture(t), original = { egressProxyUrl: 'https://native.invalid:443', egressProxyPacUrl: 'https://native.invalid/pac', width: 900 }
  f.setup(original)
  for (const url of ['http://127.0.0.1:25001', 'http://[::1]:25002', 'http://127.0.0.1:25003']) {
    f.plan.networkRoute = { mode: 'proxy', url }; prepareClaudeDesktopNetwork(f.plan)
    assert.equal(f.current().egressProxyUrl, url); assert.equal(f.current().egressProxyPacUrl, undefined)
  }
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.current(), original)
})

test('native settings edited while using the managed proxy survive restart and inherit', t => {
  const f = fixture(t), source = f.setup({ theme: 'light', retained: true })
  prepareClaudeDesktopNetwork(f.plan)
  const path = join(f.library, `${f.read(f.meta).appliedId}.json`)
  writeFileSync(path, JSON.stringify({ ...f.current(), theme: 'dark', newSetting: { on: true } }))
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:26001' }; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.current().theme, 'dark')
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.read(f.meta).appliedId, source.id)
  assert.deepEqual(f.current(), { theme: 'dark', retained: true, newSetting: { on: true } })
})

test('native settings created in a fresh profile remain selected when the proxy is removed', t => {
  const f = fixture(t)
  prepareClaudeDesktopNetwork(f.plan)
  const id = f.read(f.meta).appliedId, path = join(f.library, `${id}.json`)
  writeFileSync(path, JSON.stringify({ ...f.current(), customSetting: 'preserve' }))
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.read(f.meta).appliedId, id)
  assert.deepEqual(f.current(), { customSetting: 'preserve' })
  assert.equal(existsSync(f.journal), false)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:27001' }; prepareClaudeDesktopNetwork(f.plan)
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.current(), { customSetting: 'preserve' })
})

test('independent edits to original config merge without losing a native change', t => {
  const f = fixture(t), source = f.setup({ theme: 'light', native: 1 })
  prepareClaudeDesktopNetwork(f.plan)
  writeFileSync(source.path, JSON.stringify({ theme: 'light', native: 2 }))
  writeFileSync(join(f.library, `${f.read(f.meta).appliedId}.json`), JSON.stringify({ ...f.current(), theme: 'dark' }))
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.current(), { theme: 'dark', native: 2 })
})

test('conflicting native edits preserve both source files and block before changing selection', t => {
  const f = fixture(t), source = f.setup({ theme: 'light' })
  prepareClaudeDesktopNetwork(f.plan)
  const selected = f.read(f.meta).appliedId, path = join(f.library, `${selected}.json`)
  writeFileSync(source.path, '{"theme":"system"}'); writeFileSync(path, JSON.stringify({ ...f.current(), theme: 'dark' }))
  f.plan.networkRoute = undefined
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /均已修改/)
  assert.equal(f.read(source.path).theme, 'system'); assert.equal(f.read(path).theme, 'dark')
  assert.equal(f.read(f.meta).appliedId, selected); assert.ok(existsSync(f.journal))
})

test('selecting another native config while stopped is preserved and old manager pin is removed', t => {
  const f = fixture(t), source = f.setup({ theme: 'dark' })
  prepareClaudeDesktopNetwork(f.plan)
  const managedId = f.read(f.meta).appliedId, next = randomUUID()
  writeFileSync(join(f.library, `${next}.json`), '{"native":"selected"}')
  writeFileSync(f.meta, JSON.stringify({ appliedId: next, keep: 1 }))
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.read(f.meta), { appliedId: next, keep: 1 })
  assert.deepEqual(f.current(), { native: 'selected' })
  assert.deepEqual(f.read(source.path), { theme: 'dark' })
  assert.equal(existsSync(join(f.library, `${managedId}.json`)), false)
})

test('native proxy edits are retained rather than being mistaken for the manager loopback pin', t => {
  const f = fixture(t), source = f.setup({ egressProxyUrl: 'https://old.invalid:443', theme: 'dark' })
  prepareClaudeDesktopNetwork(f.plan)
  writeFileSync(join(f.library, `${f.read(f.meta).appliedId}.json`), JSON.stringify({ ...f.current(), egressProxyUrl: 'https://new.invalid:443', egressProxyPacUrl: 'https://new.invalid/pac' }))
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.read(f.meta).appliedId, source.id)
  assert.deepEqual(f.current(), { egressProxyUrl: 'https://new.invalid:443', theme: 'dark', egressProxyPacUrl: 'https://new.invalid/pac' })
})

test('only a credential-free loopback HTTP route can be persisted', t => {
  const f = fixture(t)
  for (const url of ['http://user:secret@127.0.0.1:8080', 'https://127.0.0.1:8080', 'http://proxy.invalid:8080', 'http://127.0.0.1:8080/?key=secret', 'http://127.0.0.1:65536']) {
    f.plan.networkRoute = { mode: 'proxy', url }
    assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /网络路由/)
    assert.equal(existsSync(f.journal), false)
  }
  f.plan.networkRoute = { mode: 'direct' }
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /直连必须先准备/)
  assert.equal(existsSync(`${f.plan.desktopDirectory}-3p`), false)
})

test('journal stores references and hashes, not native credential values', t => {
  const f = fixture(t), credential = 'native-local-credential-do-not-journal'
  f.setup({ nativeCustomField: credential, egressProxyUrl: 'https://native.invalid:443' })
  prepareClaudeDesktopNetwork(f.plan)
  const journal = readFileSync(f.journal, 'utf8')
  assert.equal(journal.includes(credential), false)
  assert.equal(journal.includes('native.invalid'), false)
  assert.equal(f.current().nativeCustomField, credential, 'existing native values stay in their original instance scope')
})

test('hybrid organization configuration is preserved and proxy override fails explicitly', t => {
  const f = fixture(t), source = f.setup({ keep: true }, { hybridPointer: 'https://organization.invalid/config' })
  const before = readFileSync(f.meta, 'utf8')
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /组织或共享配置/)
  assert.equal(readFileSync(f.meta, 'utf8'), before)
  assert.equal(existsSync(f.journal), false)
  assert.deepEqual(f.read(source.path), { keep: true })
})

test('missing native proxy capability fails explicitly, while inherit can still recover old pins', t => {
  const f = fixture(t)
  prepareClaudeDesktopNetwork(f.plan)
  archive(f.asar, nativeSource.replace('egressProxyUrl', 'unsupported'))
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.equal(existsSync(f.meta), false)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:28001' }
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /未提供已验证/)
  assert.equal(existsSync(f.journal), false)
})

test('native capability detection accepts packaging and property order changes without a version table', t => {
  const f = fixture(t)
  const source = nativeSource.replace('flatKey:"egressProxyUrl",support:{enabled:{scopes:["3p","1p"]}},appBehaviorOnly:true', '"appBehaviorOnly":!0,\n"support":{enabled:{scopes:["1p", "3p"]}},\n"flatKey":"egressProxyUrl"')
  for (const main of ['dist/native-start.cjs', './desktop-main.mjs']) {
    archive(f.asar, source, main)
    assert.doesNotThrow(() => assertClaudeDesktopNetworkCapability(f.application))
  }
  archive(f.asar, source.replace('"appBehaviorOnly":!0', '"appBehaviorOnly":false'), 'dist/native-start.cjs')
  assert.throws(() => assertClaudeDesktopNetworkCapability(f.application), /未提供已验证/)
})

test('unsafe directories, linked files and malformed applied IDs cannot escape the instance', t => {
  const f = fixture(t), outside = join(f.root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, `${f.plan.desktopDirectory}-3p`)
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /目录不安全/)
  assert.deepEqual(readdirSync(outside), [])
  rmSync(`${f.plan.desktopDirectory}-3p`)
  f.setup({ keep: true })
  writeFileSync(f.meta, JSON.stringify({ appliedId: '../../outside' }))
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /标识无效/)
  const original = join(outside, 'native.json'); writeFileSync(original, '{"keep":true}')
  const id = randomUUID(); writeFileSync(f.meta, JSON.stringify({ appliedId: id }))
  symlinkSync(original, join(f.library, `${id}.json`))
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /安全读取/)
  rmSync(join(f.library, `${id}.json`)); linkSync(original, join(f.library, `${id}.json`))
  assert.throws(() => prepareClaudeDesktopNetwork(f.plan), /类型或大小/)
  assert.equal(readFileSync(original, 'utf8'), '{"keep":true}')
})

test('an interrupted prepare before selecting the manager entry recovers on the next start', t => {
  const f = fixture(t), source = f.setup({ keep: true })
  prepareClaudeDesktopNetwork(f.plan)
  const managerId = f.read(f.meta).appliedId
  // Simulate the state after journal/entry creation but before metadata commit.
  writeFileSync(f.meta, JSON.stringify({ appliedId: source.id }))
  prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.read(f.meta).appliedId, managerId)
  assert.equal(f.current().keep, true)
  f.plan.networkRoute = undefined; prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.current(), { keep: true })
})

test('installed Claude Desktop proxy capability is inspected without launching or modifying it', t => {
  const application = '/Applications/Claude.app'
  if (process.platform !== 'darwin' || !existsSync(join(application, 'Contents', 'Resources', 'app.asar'))) { t.skip('native Claude Desktop is not installed'); return }
  assert.doesNotThrow(() => assertClaudeDesktopNetworkCapability(application))
})
