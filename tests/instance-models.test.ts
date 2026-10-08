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
import type { Account } from '../src/shared/types'

const path = new URL('../src/renderer/src/components/InstancesView.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'instance-models-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const defaults: instances.InstanceModelDefaults = { models: ['native-first', 'native-second'], defaultModelId: 'native-first' }
interface OfficialInput { accountId: string; applicationId: string; requestId: string; force?: boolean }
interface OfficialResult { accountId: string; requestId: string; models: string[]; defaultModelId: string | null; source: 'official' | 'cache'; fetchedAt: number }
function official(input: OfficialInput, models = ['official-first', 'official-second'], source: 'official' | 'cache' = 'official'): OfficialResult {
  return { requestId: input.requestId, accountId: input.accountId, models, defaultModelId: models[0] ?? null, source, fetchedAt: 1 }
}
const emptyHistory: instances.InstanceHistorySummary = { sessions: 0, archived: 0, projects: [], unassigned: 0, issues: [] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function settle() { for (let n = 0; n < 16; n++) await vue.nextTick() }
function mount(options: { kind?: Account['kind']; models?: string[]; readDefaults?: (clientType: unknown) => Promise<instances.InstanceModelDefaults>; fetchModels?: (input: OfficialInput) => Promise<OfficialResult>; cancelModels?: (requestId: string) => Promise<void> } = {}) {
  const accountId = randomUUID(), applicationId = randomUUID()
  const account: Account = { id: accountId, kind: options.kind ?? 'oauth', name: 'ChatGPT fixture', baseUrl: 'https://fixture.invalid/v1',
    models: options.models ?? [], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: 1 }
  const source: instances.InstanceView = { id: randomUUID(), revision: 2, clientType: 'codex', name: 'Saved fixture', applicationId, accountId,
    connectionMode: 'local_api', defaultTier: 'inherit', model: 'saved-model', extraArgs: [], createdAt: 1,
    status: 'stopped', directory: '/fixture/source', desktopDirectory: '/fixture/source-desktop', launchMode: 'desktop' }
  const calls: { method: string; input?: any }[] = []
  const manager = vue.reactive({ data: { accounts: [account], providers: [] as any[], instances: [source],
    instanceApplications: [{ id: applicationId, clientType: 'codex', kind: 'desktop', name: 'Codex', path: '/fixture/Codex.app' }] },
    loading: false, error: '', async execute(action: () => Promise<any>) {
      this.loading = true
      try { this.data = await action(); return true } catch (cause) { this.error = String(cause); return false } finally { this.loading = false }
    } })
  const api: Record<string, (...args: any[]) => Promise<any>> = {
    listInstanceWorkingDirectories: async () => [], readModelContextDefaults: async () => [],
    readInstanceModelDefaults: async clientType => { calls.push({ method: 'defaults', input: clientType }); return options.readDefaults ? options.readDefaults(clientType) : structuredClone(defaults) },
    fetchChatGPTModels: async input => { calls.push({ method: 'official', input }); return options.fetchModels ? options.fetchModels(input) : official(input) },
    cancelChatGPTModels: async input => { calls.push({ method: 'cancelModels', input }); await options.cancelModels?.(input) },
    previewInstanceHistory: async input => { calls.push({ method: 'history', input }); return structuredClone(emptyHistory) },
    saveInstance: async input => { calls.push({ method: 'save', input }); return manager.data }
  }
  const exports = {}, context = { module: { exports }, exports, crypto: { randomUUID }, document: { querySelector: () => null }, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { Modal: {}, message: { success() {} } } : id === '@ant-design/icons-vue' ? {}
      : id.endsWith('/agentClients') ? clients : id.endsWith('/instances') ? instances : id.endsWith('/modelContextWindows') ? windows
      : id === '../formFeedback' ? { validationErrors, useFormFeedback: () => () => {} }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }, vnode = vue.h(component)
  renderer.render(vnode, container)
  const state = vnode.component!.setupState as Record<string, any>
  function addSupplier(models = ['supplier-model']): Account {
    const supplier: Account = { ...account, id: randomUUID(), kind: 'api_key', name: 'Supplier fixture', models }
    manager.data.accounts.push(supplier)
    return supplier
  }
  function addIdentity(models: string[] = []): Account {
    const second: Account = { ...account, id: randomUUID(), kind: 'oauth', name: 'Second ChatGPT fixture', models }
    manager.data.accounts.push(second)
    return second
  }
  return { state, manager, calls, account, source, addSupplier, addIdentity, unmount: () => renderer.render(null, container) }
}

test('an empty ChatGPT model list gets its official default and passes the wizard without changing account metadata', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
  assert.deepEqual(ui.manager.data.accounts[0].models, [], 'Directory candidates are not written into the account')
  const request = ui.calls.find(call => call.method === 'official')!.input
  assert.equal(request.accountId, ui.account.id)
  assert.equal(request.applicationId, ui.source.applicationId)
  assert.match(request.requestId, /^[0-9a-f-]{36}$/i)
  ui.state.step = 2; await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 3); assert.equal(ui.state.fieldErrors.model, undefined)
  await ui.state.save()
  const saved = ui.calls.find(call => call.method === 'save')!
  assert.equal(saved.input.details.model, 'official-first')
})

test('the official account catalog takes precedence over stale imported models and builtin candidates', async t => {
  const ui = mount({ models: ['account-model', 'account-other'] }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
  assert.deepEqual(ui.manager.data.accounts[0].models, ['account-model', 'account-other'])
  assert.ok(ui.calls.some(call => call.method === 'official'))
})

test('a late official account catalog does not replace a model typed by the user', async t => {
  const pending = deferred<string[]>()
  const ui = mount({ fetchModels: async input => official(input, await pending.promise) }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  ui.state.form.model = 'custom-model'
  pending.resolve(['official-first', 'official-second']); await settle()
  assert.equal(ui.state.form.model, 'custom-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
  ui.state.step = 2; await ui.state.nextStep()
  assert.equal(ui.state.step, 3, 'A manually supplied model remains valid')
})

test('switching to a supplier while official candidates load keeps supplier models and cancels the account request', async t => {
  const pending = deferred<string[]>()
  const ui = mount({ fetchModels: async input => official(input, await pending.promise) }); t.after(ui.unmount)
  const supplier = ui.addSupplier(['supplier-first', 'supplier-second'])
  ui.state.edit(); await settle()
  const request = ui.calls.find(call => call.method === 'official')!.input
  ui.state.resourceKind = 'provider'; ui.state.resetResource(); await settle()
  assert.equal(ui.state.form.accountId, supplier.id); assert.equal(ui.state.form.model, 'supplier-first')
  pending.resolve(['late-official-model']); await settle()
  assert.equal(ui.state.form.model, 'supplier-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), supplier.models)
  assert.ok(ui.calls.some(call => call.method === 'cancelModels' && call.input === request.requestId))
  assert.equal(ui.calls.filter(call => call.method === 'official').length, 1)
})

test('a supplier with no created API connection exposes its own provider list', async t => {
  const ui = mount({ kind: 'api_key', models: ['api-model'] }); t.after(ui.unmount)
  const providerId = randomUUID(), keyId = randomUUID()
  ui.manager.data.providers.push({ id: providerId, name: 'Unconnected supplier', wireApi: 'responses', models: ['provider-first', 'provider-second'],
    keys: [{ id: keyId, name: 'Main', accountIds: [] }] })
  ui.state.edit(); ui.state.resourceKind = 'provider'; ui.state.selectSupplier(providerId + ':' + keyId)
  await settle()
  assert.equal(ui.state.form.accountId, ''); assert.equal(ui.state.form.model, 'provider-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['provider-first', 'provider-second'])
  assert.equal(ui.calls.some(call => call.method === 'official'), false)
})

test('an API account with an empty model list stays empty instead of inheriting ChatGPT candidates', async t => {
  const ui = mount({ kind: 'api_key' }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, ''); assert.deepEqual(Array.from(ui.state.modelChoices), [])
  assert.equal(ui.calls.some(call => call.method === 'official'), false)
  ui.state.form.model = 'manual-api-model'; ui.state.step = 2; await ui.state.nextStep()
  assert.equal(ui.state.step, 3, 'The existing local API custom-model capability is preserved')
})

test('closing a draft cancels its request and prevents a late account response from filling it', async t => {
  const pending = deferred<string[]>()
  const ui = mount({ fetchModels: async input => official(input, await pending.promise) }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  const initialModel = ui.state.form.model, request = ui.calls.find(call => call.method === 'official')!.input
  ui.state.closeEditor(); await settle()
  pending.resolve(['official-first']); await settle()
  assert.equal(ui.state.open, false); assert.equal(ui.state.form.model, initialModel)
  assert.ok(ui.calls.some(call => call.method === 'cancelModels' && call.input === request.requestId))
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'official-first', 'The next open draft independently loads its account directory')
})

test('a delayed old request cannot override a reopened draft with a newer account catalog', async t => {
  const pending = deferred<string[]>(); let requests = 0
  const ui = mount({ fetchModels: async input => official(input, ++requests === 1 ? await pending.promise : ['new-official-model']) }); t.after(ui.unmount)
  ui.state.edit(); await settle(); ui.state.form.name = 'Old draft'; ui.state.closeEditor(); await settle()
  ui.state.edit(); ui.state.form.name = 'New draft'; await settle()
  assert.equal(ui.state.form.model, 'new-official-model')
  pending.resolve(['obsolete-official-model']); await settle()
  assert.equal(ui.state.open, true); assert.equal(ui.state.form.name, 'New draft'); assert.equal(ui.state.form.model, 'new-official-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['new-official-model'])
})

test('a delayed official catalog preserves existing models while editing and duplicating saved instances', async t => {
  const pending = deferred<string[]>()
  const ui = mount({ fetchModels: async input => official(input, await pending.promise) }); t.after(ui.unmount)
  ui.state.edit(ui.source); assert.equal(ui.state.form.model, 'saved-model')
  await ui.state.duplicate(ui.source)
  assert.equal(ui.state.editing, undefined); assert.equal(ui.state.form.model, 'saved-model')
  pending.resolve(['official-first', 'official-second']); await settle()
  assert.equal(ui.state.form.model, 'saved-model'); assert.equal(ui.state.wizard, false)
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
  ui.state.edit(ui.source); await settle(); await ui.state.save()
  const saved = ui.calls.find(call => call.method === 'save')!
  assert.equal(saved.input.id, ui.source.id); assert.equal(saved.input.details.model, 'saved-model')
})

test('official lookup failure explicitly marks builtin backup candidates and permits manual models', async t => {
  const ui = mount({ fetchModels: async () => { throw new Error('fixture official catalog failure') } }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'native-first'); assert.deepEqual(Array.from(ui.state.modelChoices), defaults.models)
  assert.match(ui.state.modelSourceLabel, /官方.*备用/)
  ui.state.form.model = 'manual-fallback'; ui.state.step = 2; await ui.state.nextStep(); await ui.state.save()
  const saved = ui.calls.find(call => call.method === 'save')!
  assert.equal(ui.state.step, 3); assert.equal(saved.input.details.model, 'manual-fallback')
})

test('empty Agent Identity models use the official identity catalog in local API mode', async t => {
  const ui = mount({ kind: 'agent_identity' }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.connectionMode, 'local_api'); assert.equal(ui.state.form.model, 'official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
  assert.deepEqual(ui.manager.data.accounts[0].models, [])
  assert.equal(ui.calls.find(call => call.method === 'official')!.input.accountId, ui.account.id)
})

test('switching between ChatGPT accounts isolates slow responses and changes the automatically selected default', async t => {
  const first = deferred<string[]>(), second = deferred<string[]>()
  let firstAccountId = ''
  const ui = mount({ fetchModels: async input => official(input, await (input.accountId === firstAccountId ? first.promise : second.promise)) }); t.after(ui.unmount)
  firstAccountId = ui.account.id
  const another = ui.addIdentity(['obsolete-imported-model'])
  ui.state.edit(); await settle()
  ui.state.form.accountId = another.id; ui.state.selectAccount(); await settle()
  second.resolve(['second-official-first', 'second-official-other']); await settle()
  assert.equal(ui.state.form.model, 'second-official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['second-official-first', 'second-official-other'])
  first.resolve(['first-late-model']); await settle()
  assert.equal(ui.state.form.accountId, another.id); assert.equal(ui.state.form.model, 'second-official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['second-official-first', 'second-official-other'])
  assert.deepEqual(ui.calls.filter(call => call.method === 'official').map(call => call.input.accountId), [ui.account.id, another.id])
})

test('an official cache hit remains preferred over builtin candidates', async t => {
  const ui = mount({ fetchModels: async input => official(input, ['cached-official-model'], 'cache') }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'cached-official-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['cached-official-model'])
})

test('a builtin lookup failure does not hide a successful official account catalog', async t => {
  const ui = mount({ readDefaults: async () => { throw new Error('fixture builtin lookup failure') } }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'official-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['official-first', 'official-second'])
})

test('force-refresh updates an automatically selected official default and bypasses cache', async t => {
  const ui = mount({ fetchModels: async input => official(input, input.force ? ['refreshed-official-default'] : ['cached-official-default'], input.force ? 'official' : 'cache') }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'cached-official-default')
  assert.match(ui.state.modelSourceLabel, /缓存/)
  await ui.state.refreshChatGPTModels(true); await settle()
  assert.equal(ui.state.form.model, 'refreshed-official-default')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['refreshed-official-default'])
  assert.equal(ui.calls.filter(call => call.method === 'official').at(-1)!.input.force, true)
})

test('force-refresh changes official choices while preserving a manually selected model', async t => {
  const ui = mount({ fetchModels: async input => official(input, input.force ? ['refreshed-model'] : ['initial-model']) }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  ui.state.form.model = 'manually-selected-model'; ui.state.modelEdited()
  await ui.state.refreshChatGPTModels(true); await settle()
  assert.equal(ui.state.form.model, 'manually-selected-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['refreshed-model'])
})

test('failed refresh retains the last official list and identifies it instead of claiming builtin availability', async t => {
  const ui = mount({ fetchModels: async input => { if (input.force) throw new Error('fixture refresh failed'); return official(input, ['last-official-model']) } }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  await ui.state.refreshChatGPTModels(true); await settle()
  assert.equal(ui.state.form.model, 'last-official-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['last-official-model'])
  assert.match(ui.state.modelSourceLabel, /官方.*刷新失败.*上次/)
})

test('switching client applications clears the old automatic model until the new application catalog arrives', async t => {
  const pending = deferred<string[]>()
  let originalApplication = ''
  const ui = mount({ fetchModels: async input => official(input, input.applicationId === originalApplication ? ['old-client-default'] : await pending.promise) }); t.after(ui.unmount)
  originalApplication = ui.source.applicationId
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'old-client-default')
  const otherApplication = { ...ui.manager.data.instanceApplications[0], id: randomUUID(), name: 'Updated Codex', path: '/fixture/Updated Codex.app' }
  ui.manager.data.instanceApplications.push(otherApplication)
  ui.state.form.applicationId = otherApplication.id; await settle()
  assert.equal(ui.state.form.model, '', 'An automatic default from the previous client cannot be saved for this client')
  assert.deepEqual(Array.from(ui.state.modelChoices), [])
  assert.equal(ui.state.officialModelsLoading, true)
  ui.state.step = 2; await ui.state.nextStep()
  assert.equal(ui.state.step, 2, 'Next waits for the new default while the model remains empty')
  pending.resolve(['new-client-default']); await settle()
  assert.equal(ui.state.form.model, 'new-client-default')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['new-client-default'])
  await ui.state.nextStep(); assert.equal(ui.state.step, 3)
  ui.state.form.model = 'manual-client-model'; ui.state.modelEdited()
  ui.state.form.applicationId = originalApplication; await settle()
  assert.equal(ui.state.form.model, 'manual-client-model', 'Explicit model input survives application changes')
})

test('a replacement account request waits for delayed cancellation to complete before invoking the service', async t => {
  const pending = deferred<string[]>(), cancelled = deferred<void>()
  let firstAccountId = ''
  const ui = mount({ fetchModels: async input => official(input, input.accountId === firstAccountId ? await pending.promise : ['replacement-account-model']), cancelModels: () => cancelled.promise }); t.after(ui.unmount)
  firstAccountId = ui.account.id
  const second = ui.addIdentity()
  ui.state.edit(); await settle()
  const firstRequest = ui.calls.find(call => call.method === 'official')!.input
  ui.state.form.accountId = second.id; ui.state.selectAccount(); await settle()
  assert.ok(ui.calls.some(call => call.method === 'cancelModels' && call.input === firstRequest.requestId))
  assert.equal(ui.calls.filter(call => call.method === 'official').length, 1, 'Do not invoke the replacement while the service still owns the old request')
  cancelled.resolve(undefined); await settle()
  assert.deepEqual(ui.calls.filter(call => call.method === 'official').map(call => call.input.accountId), [firstAccountId, second.id])
  assert.equal(ui.state.form.model, 'replacement-account-model')
  pending.resolve(['old-cancelled-model']); await settle()
  assert.equal(ui.state.form.model, 'replacement-account-model')
})
