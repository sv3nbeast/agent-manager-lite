import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { randomUUID } from 'node:crypto'
import * as library from '../src/shared/providerLibrary'
import type { Account, ManagerAPI } from '../src/shared/types'

const path = new URL('../src/renderer/src/components/AccountEditor.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'account-editor-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function account(name: string): Account {
  return { id: randomUUID(), revision: 2, name, kind: 'api_key', baseUrl: `https://${name.toLowerCase()}.invalid/v1`, models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: 1, credentialConfigured: true }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function mount(overrides: Partial<ManagerAPI> = {}, selected?: Account) {
  const accounts = [account('First'), account('Second')]
  if (selected) accounts[0] = selected
  const props = vue.reactive({ open: true, account: accounts[0] as Account | undefined })
  const writes: unknown[] = [], events: unknown[] = [], infos: string[] = [], reads: unknown[] = []
  const manager = vue.reactive({ data: { accounts, providers: [] }, error: '', loading: false,
    async execute(action: () => Promise<any>) { await action(); return true } })
  const api: Partial<ManagerAPI> = {
    readAccountKey: async input => { reads.push(input); return `fixture-${input.id}` },
    editAccount: async input => { writes.push(structuredClone(input)); return manager.data as any },
    addAccount: async input => { writes.push(structuredClone(input)); return manager.data as any },
    mutateProvider: async input => { writes.push(structuredClone(input)); return manager.data as any },
    ...overrides
  }
  const exports = {}
  const context = { module: { exports }, exports, window: { manager: api }, console,
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { message: { success() {}, info(value: string) { infos.push(value) } } }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('/providerLibrary') ? library
      : id.endsWith('/providerUsage') ? { integrationTypeOptions: [] } : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let vnode: vue.VNode
  const host = vue.defineComponent({ setup: () => () => {
    vnode = vue.h(component, { open: props.open, account: props.account, 'onUpdate:open': (value: boolean) => { events.push(value); props.open = value } })
    return vnode
  } })
  const container = { children: [] as object[] }
  renderer.render(vue.h(host), container)
  return { state: vnode!.component!.setupState as Record<string, any>, props, accounts, manager, writes, events, infos, reads, unmount: () => renderer.render(null, container) }
}
const flush = async () => { await Promise.resolve(); await vue.nextTick(); await Promise.resolve() }
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test('independent editor shows its saved key and metadata saves do not rotate it', async t => {
  const ui = mount(); t.after(ui.unmount)
  assert.equal(ui.state.keyLoading, true)
  await ui.state.save(); assert.equal(ui.writes.length, 0)
  await flush()
  assert.equal(ui.state.form.apiKey, `fixture-${ui.accounts[0].id}`)
  ui.state.form.note = 'Updated note'
  await ui.state.save()
  assert.deepEqual(ui.writes[0], { id: ui.accounts[0].id, revision: 2, changes: { note: 'Updated note' } })
  assert.equal(ui.state.form.apiKey, '')
})

test('rotated key is submitted once; clearing a saved key blocks saving', async t => {
  const ui = mount(); t.after(ui.unmount); await flush()
  ui.state.form.apiKey = ''
  await ui.state.save(); assert.equal(ui.writes.length, 0); assert.deepEqual(ui.infos, ['请输入 API Key'])
  ui.state.form.apiKey = 'fixture-new-key'
  await ui.state.save()
  assert.deepEqual((ui.writes[0] as any).changes, { apiKey: 'fixture-new-key' })
})

test('cancel clears keys immediately and late reads cannot populate a different account', async t => {
  const first = deferred<string>(), second = deferred<string>(); let calls = 0
  const ui = mount({ readAccountKey: () => ++calls === 1 ? first.promise : second.promise }); t.after(ui.unmount)
  ui.state.close(); assert.equal(ui.state.form.apiKey, ''); await flush()
  ui.props.account = ui.accounts[1]; ui.props.open = true; await flush()
  second.resolve('fixture-second-secret'); await flush()
  assert.equal(ui.state.form.apiKey, 'fixture-second-secret')
  first.resolve('fixture-first-secret'); await flush()
  assert.equal(ui.state.form.apiKey, 'fixture-second-secret')
  ui.state.close(); await flush(); assert.equal(ui.state.form.apiKey, ''); assert.equal(ui.writes.length, 0)
})

test('account switch while still open starts a new read; unmount discards its response', async t => {
  const first = deferred<string>(), second = deferred<string>(); let calls = 0
  const ui = mount({ readAccountKey: () => ++calls === 1 ? first.promise : second.promise })
  ui.props.account = ui.accounts[1]; await flush()
  first.resolve('fixture-first-secret'); await flush()
  assert.equal(ui.state.form.apiKey, '')
  ui.unmount(); second.resolve('fixture-second-secret'); await flush()
  assert.equal(ui.state.form.apiKey, ''); assert.equal(ui.writes.length, 0)
})

test('destination changes clear the old key, reject late reads and require explicit replacement even on return', async t => {
  const late = deferred<string>(), ui = mount({ readAccountKey: () => late.promise }); t.after(ui.unmount)
  ui.state.form.baseUrl = 'https://third.invalid/v1'
  assert.equal(ui.state.keyLoading, false); assert.equal(ui.state.keyNeedsEntry, true)
  await ui.state.save(); assert.equal(ui.writes.length, 0)
  ui.state.form.apiKey = 'fixture-third-key'
  late.resolve('fixture-old-key'); await flush()
  assert.equal(ui.state.form.apiKey, 'fixture-third-key')
  ui.state.form.baseUrl = ui.accounts[0].baseUrl
  assert.equal(ui.state.form.apiKey, '')
  ui.state.form.apiKey = 'fixture-explicit-key'
  await ui.state.save()
  assert.deepEqual((ui.writes[0] as any).changes, { apiKey: 'fixture-explicit-key' })
})

test('failed reads hide returned error details and changed revisions block saving', async t => {
  const ui = mount({ readAccountKey: async () => { throw new Error('fixture-secret-must-not-appear') } }); t.after(ui.unmount); await flush()
  assert.ok(ui.state.keyError); assert.ok(!ui.state.keyError.includes('fixture-secret-must-not-appear'))
  await ui.state.save(); assert.equal(ui.writes.length, 0)
  const late = deferred<string>(), stale = mount({ readAccountKey: () => late.promise }); t.after(stale.unmount)
  stale.accounts[0].revision = 3
  late.resolve('fixture-old-key'); await flush()
  assert.equal(stale.state.form.apiKey, ''); assert.match(stale.state.keyError, /账号已变化/)
  await stale.state.save(); assert.equal(stale.writes.length, 0)
})

test('managed connections and login accounts preserve their existing editor and do not read API keys', async t => {
  for (const selected of [{ ...account('Managed'), providerId: randomUUID(), providerKeyId: randomUUID() }, { ...account('Login'), kind: 'oauth' as const }]) {
    const ui = mount({}, selected); t.after(ui.unmount); await flush()
    assert.equal(ui.reads.length, 0)
    ui.state.form.note = 'Only metadata'; await ui.state.save()
    assert.deepEqual(plain((ui.writes[0] as any).changes), { note: 'Only metadata' })
  }
})

test('a late successful save does not close a subsequently opened account editor', async t => {
  const saved = deferred<any>(), ui = mount({ editAccount: () => saved.promise }); t.after(ui.unmount); await flush()
  ui.state.form.note = 'Saved first'; const saving = ui.state.save()
  ui.state.close(); await flush(); ui.props.account = ui.accounts[1]; ui.props.open = true; await flush()
  saved.resolve(ui.manager.data); await saving; await flush()
  assert.equal(ui.props.open, true); assert.equal(ui.state.form.apiKey, `fixture-${ui.accounts[1].id}`)
})

test('reopening the same account uses its newest revision after both props are patched', async t => {
  const ui = mount(); t.after(ui.unmount); await flush()
  ui.state.close(); await flush()
  const newer = { ...ui.accounts[0], revision: 3, note: 'Saved note' }
  ui.manager.data.accounts[0] = newer
  // Vue patches the open prop before account; with synchronous initialization
  // an unchanged account ID would start a read at the previous revision.
  ui.props.open = true
  ui.props.account = newer
  await flush()
  assert.equal((ui.reads.at(-1) as any).revision, 3)
  assert.equal(ui.state.editingAccount.revision, 3)
  assert.equal(ui.state.form.note, 'Saved note')
  assert.equal(ui.state.keyError, '')
  assert.equal(ui.state.form.apiKey, `fixture-${newer.id}`)
})

test('a late unlink result cannot close another account editor', async t => {
  const selected = { ...account('Managed'), providerId: randomUUID(), providerKeyId: randomUUID() }
  const unlinked = deferred<any>(), ui = mount({ mutateProvider: () => unlinked.promise }, selected); t.after(ui.unmount); await flush()
  const unlinking = ui.state.unlink()
  ui.state.close(); await flush(); ui.props.account = ui.accounts[1]; ui.props.open = true; await flush()
  unlinked.resolve(ui.manager.data); await unlinking; await flush()
  assert.equal(ui.props.open, true)
  assert.equal(ui.state.form.apiKey, `fixture-${ui.accounts[1].id}`)
})
