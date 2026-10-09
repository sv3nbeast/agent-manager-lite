import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as clients from '../src/shared/agentClients'
import * as instances from '../src/shared/instances'
import * as windows from '../src/shared/modelContextWindows'
import { validationErrors } from '../src/renderer/src/formFeedback'
import { accountProxyView } from '../src/main/proxyPolicy'
import type { StoredAccount } from '../src/main/store'
import type { Account } from '../src/shared/types'

const path = new URL('../src/renderer/src/components/InstancesView.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'instance-connection-mode-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const account = (kind: Account['kind'] = 'oauth', extra: Partial<Account> = {}): Account => ({ id: randomUUID(), name: kind, kind, baseUrl: 'https://fixture.invalid', models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', tags: [], note: '', createdAt: 1, ...extra })
async function settle() { for (let n = 0; n < 8; n++) await vue.nextTick() }
function mount(values: Account[] = [account(), account('oauth'), account('agent_identity'), account('api_key')]) {
  const source: instances.InstanceView = { id: randomUUID(), revision: 0, clientType: 'codex', name: 'Existing', applicationId: randomUUID(), accountId: values[0].id, connectionMode: 'local_api', model: 'saved-custom-model', defaultTier: 'inherit', extraArgs: [], createdAt: 1, status: 'stopped', directory: '/fixture/source', desktopDirectory: '/fixture/desktop' }
  const saved: instances.InstanceInput[] = [], props = vue.reactive<{ loginResult?: { requestId: string; accountId: string; clientType: 'codex' } }>({}), emitted: { requestId: string }[] = []
  const manager = vue.reactive({ data: { accounts: values, providers: [] as any[], instances: [source], instanceApplications: [{ id: source.applicationId, clientType: 'codex', kind: 'desktop', name: 'Codex', path: '/fixture/Codex.app' }] }, error: '', loading: false,
    async execute(action: () => Promise<any>) { await action(); return true } })
  const api = {
    listInstanceWorkingDirectories: async () => [], readModelContextDefaults: async () => [],
    readInstanceModelDefaults: async () => ({ models: ['fixture-default'], defaultModelId: 'fixture-default' }),
    fetchChatGPTModels: async (input: { accountId: string; requestId: string }) => ({ ...input, models: ['fixture-official'], defaultModelId: 'fixture-official', source: 'official', fetchedAt: 1 }),
    cancelChatGPTModels: async () => {},
    previewInstanceHistory: async () => ({ sessions: 0, archived: 0, projects: [], unassigned: 0, issues: [] }),
    saveInstance: async (input: { details: instances.InstanceInput }) => { saved.push(input.details); return manager.data }
  }
  const exports = {}, context = { module: { exports }, exports, crypto: { randomUUID }, document: { querySelector: () => null }, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { Modal: {}, message: { success() {} } } : id === '@ant-design/icons-vue' ? {}
      : id.endsWith('/agentClients') ? clients : id.endsWith('/instances') ? instances : id.endsWith('/modelContextWindows') ? windows
      : id === '../formFeedback' ? { validationErrors, useFormFeedback: () => () => {} }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }; component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }
  let vnode: vue.VNode
  const render = () => { vnode = vue.h(component, { ...props, 'onAdd-account': (input: { requestId: string }) => emitted.push(input) }); renderer.render(vnode, container) }
  render()
  return { manager, source, saved, props, emitted, render, state: vnode!.component!.setupState as Record<string, any>, unmount: () => renderer.render(null, container) }
}

test('native recommendation reflects effective inherited proxies and explicit direct overrides', () => {
  const stored = { ...account(), credentials: { accessToken: 'fixture' } } as StoredAccount
  const scenarios = [
    { state: {}, proxy: undefined, expected: 'native' },
    { state: { upstreamProxy: { mode: 'direct' as const, revision: 0 } }, proxy: undefined, expected: 'native' },
    { state: { upstreamProxy: { mode: 'custom' as const, revision: 0, url: 'http://proxy.invalid:8888' } }, proxy: undefined, expected: 'local_api' },
    { state: { upstreamProxy: { mode: 'custom' as const, revision: 0, url: 'http://proxy.invalid:8888' } }, proxy: { mode: 'direct' as const }, expected: 'native' },
    { state: {}, proxy: { mode: 'custom' as const, url: 'socks5h://proxy.invalid:1080' }, expected: 'local_api' },
    { state: {}, proxy: { mode: 'resource' as const, resourceId: 'missing' }, expected: 'local_api' }
  ]
  for (const scenario of scenarios) {
    const egressProxy = accountProxyView({ ...stored, proxy: scenario.proxy }, scenario.state)
    assert.equal(clients.recommendedInstanceConnectionMode('codex', { kind: 'oauth', egressProxy }), scenario.expected)
  }
  const resourceId = randomUUID(), egressProxy = accountProxyView(stored, { unifiedProxy: { mode: 'all_accounts', resourceId }, proxyResources: [{ id: resourceId, revision: 0, name: 'Fixture', url: 'http://proxy.invalid:8888' }] })
  assert.equal(egressProxy?.source, 'unified')
  assert.equal(clients.recommendedInstanceConnectionMode('codex', { kind: 'oauth', egressProxy }), 'local_api')
  for (const kind of ['api_key', 'agent_identity'] as const) assert.equal(clients.recommendedInstanceConnectionMode('codex', { kind }), 'local_api')
  assert.equal(instances.instanceInputSchema.parse({ name: 'Legacy', applicationId: randomUUID(), accountId: randomUUID(), model: 'fixture' }).connectionMode, 'local_api', 'The persisted legacy default remains unchanged')
})

test('new drafts follow selected resource recommendations until the user explicitly chooses a mode', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.connectionMode, 'native')
  ui.state.form.accountId = ui.manager.data.accounts[2].id; ui.state.selectAccount()
  assert.equal(ui.state.form.connectionMode, 'local_api', 'Agent Identity remains available after an OAuth native recommendation')
  ui.state.form.accountId = ui.manager.data.accounts[1].id; ui.state.selectAccount(); await settle()
  assert.equal(ui.state.form.connectionMode, 'native')
  ui.state.form.model = 'typed-model'
  ui.state.form.connectionMode = 'local_api'; ui.state.changeConnectionMode(); await settle()
  assert.equal(ui.state.form.accountId, ui.manager.data.accounts[1].id)
  assert.equal(ui.state.form.model, 'typed-model')
  ui.state.form.accountId = ui.manager.data.accounts[0].id; ui.state.selectAccount()
  assert.equal(ui.state.form.connectionMode, 'local_api', 'An explicit local API choice survives account changes')
  ui.state.form.model = 'typed-model'; ui.state.useNativeLogin(); await settle()
  assert.equal(ui.state.form.model, 'typed-model')
  assert.equal(ui.state.form.accountId, ui.manager.data.accounts[0].id)
  assert.equal(await ui.state.ensureResource(), true)
})

test('editing and duplicating existing OAuth instances preserves explicit and legacy modes plus custom models', async t => {
  const ui = mount(); t.after(ui.unmount)
  for (const mode of ['local_api', 'native', undefined]) {
    const saved = { ...ui.source, connectionMode: mode }
    ui.state.edit(saved); await settle()
    assert.equal(ui.state.form.connectionMode, mode ?? 'local_api')
    assert.equal(ui.state.form.model, 'saved-custom-model')
    await ui.state.duplicate(saved); await settle()
    assert.equal(ui.state.form.connectionMode, mode ?? 'local_api')
    assert.equal(ui.state.form.model, 'saved-custom-model')
    ui.state.form.accountId = ui.manager.data.accounts[1].id; ui.state.selectAccount()
    assert.equal(ui.state.form.connectionMode, mode ?? 'local_api')
  }
})

test('new drafts select providers without a native-mode filtering dead end and preserve explicit native choices', async t => {
  const ui = mount(); t.after(ui.unmount)
  const key = ui.manager.data.accounts[3]; key.wireApi = 'chat_completions'
  ui.state.edit(); ui.state.resourceKind = 'provider'; ui.state.resetResource()
  assert.equal(ui.state.form.connectionMode, 'local_api')
  assert.equal(ui.state.form.accountId, key.id)
  assert.equal(await ui.state.ensureResource(), true)
  ui.state.resourceKind = 'account'; ui.state.resetResource()
  assert.equal(ui.state.form.connectionMode, 'native')
  ui.state.changeConnectionMode(); ui.state.resourceKind = 'provider'; ui.state.resetResource()
  assert.equal(ui.state.form.connectionMode, 'native')
  assert.equal(ui.state.form.accountId, key.id, 'Incompatible resource remains selected with a visible mode control')
  assert.equal(await ui.state.ensureResource(), false)
  ui.state.form.connectionMode = 'local_api'; ui.state.changeConnectionMode()
  assert.equal(ui.state.form.accountId, key.id)
  assert.equal(await ui.state.ensureResource(), true)
})

test('proxy defaults fall back to local API and explicit native selection is explained before continuing', async t => {
  const ui = mount([account('oauth', { egressProxy: { mode: 'inherit', source: 'global', protocol: 'HTTPS', server: 'proxy.invalid', port: 443 } })]); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.connectionMode, 'local_api')
  assert.equal(ui.state.usesUpstreamProxy, true)
  ui.state.useNativeLogin()
  assert.equal(await ui.state.ensureResource(), false)
  assert.match(ui.state.error, /原生登录无法应用该代理/)
  assert.equal(ui.state.form.accountId, ui.manager.data.accounts[0].id)
  const direct = account(); ui.manager.data.accounts.push(direct)
  ui.state.form.accountId = direct.id; ui.state.selectAccount(); await settle()
  assert.equal(await ui.state.ensureResource(), true)
  assert.equal(ui.state.fieldErrors.connectionMode, undefined, 'Changing to a compatible account clears obsolete mode feedback')
  assert.equal(ui.state.error, '')
})

test('inline login and provider creation select newly created resources with appropriate mode recommendations', async t => {
  const ui = mount([account('api_key')]); t.after(ui.unmount)
  ui.state.edit(); ui.state.addAccount()
  const oauth = account(); ui.manager.data.accounts.push(oauth)
  ui.props.loginResult = { ...ui.emitted[0], clientType: 'codex', accountId: oauth.id }; ui.render(); await settle()
  assert.equal(ui.state.form.accountId, oauth.id); assert.equal(ui.state.form.connectionMode, 'native')
  const newKey = account('api_key', { wireApi: 'chat_completions' }); ui.manager.data.accounts.push(newKey)
  ui.state.providerCreated(newKey.id)
  assert.equal(ui.state.form.accountId, newKey.id); assert.equal(ui.state.form.connectionMode, 'local_api')
  assert.equal(await ui.state.ensureResource(), true)
  ui.state.form.connectionMode = 'local_api'; ui.state.changeConnectionMode(); ui.state.addAccount()
  ui.props.loginResult = { ...ui.emitted.at(-1)!, clientType: 'codex', accountId: oauth.id }; ui.render(); await settle()
  assert.equal(ui.state.form.accountId, oauth.id); assert.equal(ui.state.form.connectionMode, 'local_api')
})
