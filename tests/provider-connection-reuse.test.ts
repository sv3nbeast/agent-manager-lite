import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { Store } from '../src/main/store'
import { createAPIAccount, importParsedAccounts } from '../src/main/accounts'
import { mutateProvider } from '../src/main/providerLibrary'
import * as clients from '../src/shared/agentClients'
import * as providers from '../src/shared/providerLibrary'
import * as instances from '../src/shared/instances'
import * as windows from '../src/shared/modelContextWindows'
import { validationErrors } from '../src/renderer/src/formFeedback'
import type { AppSnapshot } from '../src/shared/types'

const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const path = new URL('../src/renderer/src/components/InstancesView.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'provider-connection-reuse-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
async function settle() { for (let n = 0; n < 5; n++) await vue.nextTick() }

function fixture(t: { after(fn: () => void): void }, wireApi: 'responses' | 'chat_completions' = 'responses') {
  const root = mkdtempSync(join(tmpdir(), 'aml-provider-reuse-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'vault'), codec)
  const account = createAPIAccount({ name: 'Imported connection', baseUrl: 'https://EXAMPLE.invalid:443/Team/v1/', apiKey: 'fixture-reusable-secret',
    models: ['connection-model'], wireApi, defaultTier: 'standard', modelContextWindows: { 'connection-model': 512000 }, note: 'Keep this note', tags: ['keep'] })
  account.proxy = { mode: 'custom', url: 'http://proxy-user:fixture-proxy-pass@127.0.0.1:9123' }
  importParsedAccounts(store, [account])
  mutateProvider(store, { action: 'create', details: { name: 'Supplier', baseUrl: 'https://example.invalid/Team/v1', models: ['provider-model'],
    wireApi: 'responses', defaultTier: 'fast', modelContextWindows: { 'provider-model': 1000000 } } })
  return { root, store, account: store.read().accounts[0] }
}

function mount(store: Store, options: { inUse?: (id: string) => boolean } = {}) {
  const writes: unknown[] = [], saved: instances.InstanceInput[] = []
  const manager = vue.reactive({ data: store.snapshot() as AppSnapshot, error: '', loading: false,
    async execute(action: () => Promise<AppSnapshot>) { try { this.data = await action(); return true } catch (cause) { this.error = String(cause); return false } } })
  const exports = {}, context = { module: { exports }, exports, document: { querySelector: () => null },
    window: { manager: {
      listInstanceWorkingDirectories: async () => [], readModelContextDefaults: async () => [],
      mutateProvider: async (input: unknown) => { writes.push(input); mutateProvider(store, input, options.inUse); return store.snapshot() },
      saveInstance: async (input: { details: instances.InstanceInput }) => { saved.push(input.details); return store.snapshot() }
    } },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { Modal: {}, message: { success() {} } } : id === '@ant-design/icons-vue' ? {}
      : id.endsWith('/agentClients') ? clients : id.endsWith('/providerLibrary') ? providers : id.endsWith('/instances') ? instances : id.endsWith('/modelContextWindows') ? windows
      : id === '../formFeedback' ? { validationErrors, useFormFeedback: () => () => {} }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }; component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }, vnode = vue.h(component)
  renderer.render(vnode, container)
  return { manager, writes, saved, state: vnode.component!.setupState as Record<string, any>, unmount: () => renderer.render(null, container) }
}

function selectSupplier(ui: ReturnType<typeof mount>, mode: 'local_api' | 'native' = 'local_api') {
  ui.state.edit(); ui.state.resourceKind = 'provider'; ui.state.form.connectionMode = mode; ui.state.changeConnectionMode()
  const provider = ui.manager.data.providers![0], key = provider.keys[0]
  ui.state.selectSupplier(`${provider.id}:${key.id}`)
  ui.state.step = 1
}

test('reconciled provider keys expose exact reusable identities without changing managed links or existing connection metadata', t => {
  const f = fixture(t), provider = f.store.read().providers![0], before = f.store.read()
  const differentPath = createAPIAccount({ name: 'Other case', baseUrl: 'https://example.invalid/team/v1', apiKey: f.account.credentials.apiKey!, models: ['other'] })
  const differentKey = createAPIAccount({ name: 'Other key', baseUrl: provider.baseUrl, apiKey: 'fixture-other-secret', models: ['other'] })
  importParsedAccounts(f.store, [differentPath, differentKey])
  const stored = f.store.read(), snapshot = f.store.snapshot(), key = snapshot.providers![0].keys.find(key => key.name === f.account.name)!
  assert.deepEqual(key.accountIds, [], 'A credential match must not establish supplier ownership')
  assert.deepEqual(key.reusableAccountIds, [f.account.id], 'Normalize URL host/port/trailing slash but preserve path case and exact key')
  assert.deepEqual(f.store.read(), stored, 'Snapshot projection does not modify persisted data')
  assert.deepEqual(stored.accounts.find(account => account.id === f.account.id), before.accounts[0])
  assert.equal(JSON.stringify(snapshot).includes('fixture-reusable-secret'), false)
  assert.equal(JSON.stringify(snapshot).includes('fixture-proxy-pass'), false)
  const restarted = new Store(f.store.directory, codec)
  assert.deepEqual(restarted.snapshot().providers![0].keys.find(item => item.id === key.id)?.reusableAccountIds, [f.account.id])
})

test('wizard reuses a reconciled standalone API connection for multiple instances without creating or projecting an account', async t => {
  const f = fixture(t), before = f.store.read(), ui = mount(f.store); t.after(ui.unmount)
  for (let n = 0; n < 2; n++) {
    selectSupplier(ui)
    assert.equal(ui.state.selectedSupplier.reusingStandalone, true)
    assert.equal(ui.state.form.model, 'connection-model', 'Use the existing connection model list, not supplier defaults')
    assert.equal(await ui.state.ensureResource(), true)
    await ui.state.nextStep()
    assert.equal(ui.state.step, 2); assert.equal(ui.state.form.accountId, f.account.id)
    assert.equal(ui.state.contextLabel, '512K · API 连接设置')
    ui.state.form.applicationId = 'fixture-application'; ui.state.form.name = `Instance ${n}`
    await ui.state.save()
    assert.equal(ui.saved[n].accountId, f.account.id)
  }
  assert.equal(ui.writes.length, 0, 'No implicit createAccount/linkAccount requests for an existing credential')
  assert.equal(ui.saved.length, 2)
  assert.deepEqual(f.store.read(), before, 'Preserve models, protocol, tier, contexts, proxy, tags, credentials and ownership')
})

test('native compatibility follows the reusable connection protocol, not the supplier declaration', async t => {
  const f = fixture(t, 'chat_completions'), before = f.store.read(), ui = mount(f.store); t.after(ui.unmount)
  selectSupplier(ui, 'native'); await settle()
  assert.equal(ui.state.selectedSupplier.disabled, true)
  assert.equal(await ui.state.ensureResource(), false)
  assert.match(ui.state.error, /已有 API 连接.*改用本地 API/)
  assert.equal(ui.writes.length, 0)
  selectSupplier(ui, 'local_api')
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.state.selectedAccount.wireApi, 'chat_completions')
  assert.deepEqual(f.store.read(), before)
})

test('native reuse can use an existing Responses connection even when standalone supplier defaults use Chat Completions', async t => {
  const f = fixture(t)
  f.store.transaction(state => { state.providers![0].wireApi = 'chat_completions'; delete state.accounts[0].proxy })
  const ui = mount(f.store); t.after(ui.unmount)
  selectSupplier(ui, 'native')
  assert.equal(ui.state.selectedSupplier.disabled, false)
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.state.selectedAccount.wireApi, 'responses'); assert.equal(ui.writes.length, 0)
  ui.state.form.model = 'provider-model'; ui.state.form.name = 'Invalid model'; ui.state.form.applicationId = 'fixture-application'; ui.state.step = 2
  await settle(); await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 1, 'An incompatible native model returns to the resource choice without saving')
  assert.match(ui.state.error, /账号支持的模型/); assert.equal(ui.state.fieldErrors.accountId, ui.state.error)
  assert.equal(ui.saved.length, 0)
})

test('wizard prefers a managed link over reusable matches and old snapshots still enable a new key exactly once', async t => {
  const f = fixture(t)
  let provider = f.store.read().providers![0]
  mutateProvider(f.store, { action: 'addKey', id: provider.id, revision: provider.revision, name: 'New key', apiKey: 'fixture-unlinked-new' })
  const ui = mount(f.store); t.after(ui.unmount)
  selectSupplier(ui)
  const newest = ui.manager.data.providers![0].keys.at(-1)!
  delete newest.reusableAccountIds
  ui.state.selectSupplier(`${provider.id}:${newest.id}`)
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.writes.length, 1)
  provider = f.store.read().providers![0]
  const linked = f.store.read().accounts.find(account => account.providerKeyId === newest.id)!
  assert.equal(linked.providerId, provider.id)
  // A legacy duplicate with a different protocol is never preferred over the
  // real managed link. No duplicate state is persisted by this fixture.
  ui.manager.data.accounts.unshift({ ...ui.manager.data.accounts.find(account => account.id === f.account.id)!, id: 'legacy-duplicate' })
  const key = ui.manager.data.providers![0].keys.find(key => key.id === newest.id)!
  key.reusableAccountIds = ['legacy-duplicate', linked.id]
  ui.state.selectSupplier(`${provider.id}:${key.id}`)
  assert.equal(ui.state.form.accountId, linked.id)
  assert.equal(await ui.state.ensureResource(), true); assert.equal(ui.writes.length, 1)
})

function changeKeyCatalog(store: Store, models: string[]) {
  const provider = store.read().providers![0], key = provider.keys[0]
  mutateProvider(store, { action: 'editKey', id: provider.id, revision: provider.revision, keyId: key.id, models })
}

test('choosing a key with changed models requires an explicit link before it can replace a standalone connection', async t => {
  const f = fixture(t)
  changeKeyCatalog(f.store, ['key-model', 'other-key-model'])
  const before = f.store.read(), oldAccount = before.accounts[0], ui = mount(f.store); t.after(ui.unmount)
  selectSupplier(ui); await settle()
  assert.equal(ui.state.selectedSupplier.requiresKeyLink, true)
  assert.equal(ui.state.selectedSupplier.disabled, true)
  assert.deepEqual(Array.from(ui.state.modelChoices), ['key-model', 'other-key-model'])
  assert.equal(ui.state.form.model, 'key-model')
  assert.equal(ui.state.form.accountId, '')
  assert.equal(await ui.state.ensureResource(), false)
  await ui.state.nextStep()
  assert.equal(ui.state.step, 1)
  assert.match(ui.state.error, /关联并使用密钥配置/)
  assert.equal(ui.writes.length, 0)
  assert.deepEqual(f.store.read(), before)

  const supplier = ui.state.supplierSelection
  ui.state.selectSupplier(`account:${oldAccount.id}`)
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.state.form.model, 'connection-model', 'the explicit standalone option retains its original catalogue')
  assert.equal(ui.writes.length, 0)
  ui.state.selectSupplier(supplier)
  await ui.state.linkSelectedSupplier(); await settle()
  assert.equal(ui.writes.length, 1)
  assert.equal((ui.writes[0] as any).action, 'linkAccount')
  assert.equal((ui.writes[0] as any).revision, before.providers![0].revision)
  assert.equal((ui.writes[0] as any).accountRevision, oldAccount.revision ?? 0)
  assert.equal(ui.state.selectedSupplier.requiresKeyLink, false)
  assert.equal(ui.state.form.accountId, oldAccount.id)
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.state.form.model, 'key-model')
  const after = f.store.read().accounts[0]
  assert.deepEqual(after.models, ['key-model', 'other-key-model'])
  assert.equal(after.providerKeyId, before.providers![0].keys[0].id)
  for (const field of ['name', 'note', 'tags', 'modelContextWindows', 'defaultTier', 'proxy', 'credentials'] as const) assert.deepEqual(after[field], oldAccount[field], `preserve unrelated ${field}`)
  assert.equal(f.store.read().accounts.length, before.accounts.length)
})

test('editing an existing standalone instance keeps its own configuration when a matching key catalogue differs', async t => {
  const f = fixture(t)
  changeKeyCatalog(f.store, ['key-model'])
  const ui = mount(f.store); t.after(ui.unmount)
  ui.state.edit({ id: 'existing-instance', revision: 0, clientType: 'codex', launchMode: 'desktop', connectionMode: 'local_api', accountId: f.account.id, applicationId: 'fixture-app', name: 'Existing instance', model: 'connection-model', extraArgs: [], defaultTier: 'inherit' })
  assert.equal(ui.state.supplierSelection, `account:${f.account.id}`)
  assert.equal(ui.state.form.model, 'connection-model')
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.writes.length, 0)
})

test('explicit key linking rejects in-use or stale connections without replacing their models', async t => {
  const f = fixture(t)
  changeKeyCatalog(f.store, ['key-model'])
  let inUse = true
  const ui = mount(f.store, { inUse: id => inUse && id === f.account.id }); t.after(ui.unmount)
  selectSupplier(ui)
  assert.equal(await ui.state.ensureResource(), false)
  let before = f.store.read()
  await ui.state.linkSelectedSupplier()
  assert.match(ui.manager.error, /先停止/)
  assert.equal(ui.state.error, '', 'the earlier confirmation hint must not hide the actual in-use rejection')
  assert.deepEqual(f.store.read(), before)
  assert.equal(ui.state.selectedSupplier.requiresKeyLink, true)
  assert.equal(ui.state.form.accountId, '')
  inUse = false
  changeKeyCatalog(f.store, ['newer-key-model'])
  before = f.store.read()
  await ui.state.linkSelectedSupplier()
  assert.match(ui.manager.error, /供应商已被修改/)
  assert.deepEqual(f.store.read(), before)
  ui.manager.data = f.store.snapshot()
  f.store.transaction(state => { state.accounts[0].revision = (state.accounts[0].revision ?? 0) + 1 })
  before = f.store.read()
  await ui.state.linkSelectedSupplier()
  assert.match(ui.manager.error, /账号已被修改/)
  assert.deepEqual(f.store.read(), before)
  assert.equal(ui.state.form.accountId, '')
})
