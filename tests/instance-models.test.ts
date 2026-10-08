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
const emptyHistory: instances.InstanceHistorySummary = { sessions: 0, archived: 0, projects: [], unassigned: 0, issues: [] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function settle() { for (let n = 0; n < 5; n++) await vue.nextTick() }
function mount(options: { kind?: Account['kind']; models?: string[]; readDefaults?: (clientType: unknown) => Promise<instances.InstanceModelDefaults> } = {}) {
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
    previewInstanceHistory: async input => { calls.push({ method: 'history', input }); return structuredClone(emptyHistory) },
    saveInstance: async input => { calls.push({ method: 'save', input }); return manager.data }
  }
  const exports = {}, context = { module: { exports }, exports, document: { querySelector: () => null }, window: { manager: api },
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
  return { state, manager, calls, account, source, addSupplier, unmount: () => renderer.render(null, container) }
}

test('an empty ChatGPT model list gets a native default and can pass the wizard without changing the account', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'native-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), defaults.models)
  assert.deepEqual(ui.manager.data.accounts[0].models, [], 'Directory candidates are not written into the account')
  assert.equal(ui.calls[0].method, 'defaults'); assert.equal(ui.calls[0].input, 'codex')
  ui.state.step = 2; await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 3); assert.equal(ui.state.fieldErrors.model, undefined)
  await ui.state.save()
  assert.equal(ui.calls.at(-1)!.method, 'save'); assert.equal(ui.calls.at(-1)!.input.details.model, 'native-first')
})

test('an explicit account model list takes precedence over native directory candidates', async t => {
  const ui = mount({ models: ['account-model', 'account-other'] }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'account-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['account-model', 'account-other'])
  assert.equal(ui.state.usesNativeModels, false)
})

test('a late native model directory does not replace a model typed by the user', async t => {
  const pending = deferred<instances.InstanceModelDefaults>()
  const ui = mount({ readDefaults: () => pending.promise }); t.after(ui.unmount)
  ui.state.edit(); assert.equal(ui.state.form.model, '')
  ui.state.form.model = 'custom-model'
  pending.resolve(structuredClone(defaults)); await settle()
  assert.equal(ui.state.form.model, 'custom-model')
  assert.deepEqual(Array.from(ui.state.modelChoices), defaults.models)
  ui.state.step = 2; await ui.state.nextStep()
  assert.equal(ui.state.step, 3, 'A manually supplied model remains valid')
})

test('switching to a supplier while native candidates load keeps supplier models and default', async t => {
  const pending = deferred<instances.InstanceModelDefaults>()
  const ui = mount({ readDefaults: () => pending.promise }); t.after(ui.unmount)
  const supplier = ui.addSupplier(['supplier-first', 'supplier-second'])
  ui.state.edit(); ui.state.resourceKind = 'provider'; ui.state.resetResource()
  assert.equal(ui.state.form.accountId, supplier.id); assert.equal(ui.state.form.model, 'supplier-first')
  pending.resolve(structuredClone(defaults)); await settle()
  assert.equal(ui.state.form.model, 'supplier-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), supplier.models)
  assert.equal(ui.state.usesNativeModels, false)
})

test('a supplier with no created API connection exposes its own provider list', async t => {
  const ui = mount(); t.after(ui.unmount)
  const providerId = randomUUID(), keyId = randomUUID()
  ui.manager.data.providers.push({ id: providerId, name: 'Unconnected supplier', wireApi: 'responses', models: ['provider-first', 'provider-second'],
    keys: [{ id: keyId, name: 'Main', accountIds: [] }] })
  ui.state.edit(); ui.state.resourceKind = 'provider'; ui.state.selectSupplier(providerId + ':' + keyId)
  await settle()
  assert.equal(ui.state.form.accountId, ''); assert.equal(ui.state.form.model, 'provider-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), ['provider-first', 'provider-second'])
  assert.equal(ui.state.usesNativeModels, false)
})

test('an API account with an empty model list stays empty instead of inheriting ChatGPT candidates', async t => {
  const ui = mount({ kind: 'api_key' }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, ''); assert.deepEqual(Array.from(ui.state.modelChoices), [])
  assert.equal(ui.state.usesNativeModels, false)
  ui.state.form.model = 'manual-api-model'; ui.state.step = 2; await ui.state.nextStep()
  assert.equal(ui.state.step, 3, 'The existing local API custom-model capability is preserved')
})

test('closing a draft prevents a late directory response from filling the closed dialog', async t => {
  const pending = deferred<instances.InstanceModelDefaults>()
  const ui = mount({ readDefaults: () => pending.promise }); t.after(ui.unmount)
  ui.state.edit(); ui.state.closeEditor()
  pending.resolve(structuredClone(defaults)); await settle()
  assert.equal(ui.state.open, false); assert.equal(ui.state.form.model, '')
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, 'native-first', 'The next open draft receives the cached generic directory')
})

test('a delayed generic directory fills the reopened draft without reviving the previous draft', async t => {
  const pending = deferred<instances.InstanceModelDefaults>()
  const ui = mount({ readDefaults: () => pending.promise }); t.after(ui.unmount)
  ui.state.edit(); ui.state.form.name = 'Old draft'; ui.state.closeEditor()
  ui.state.edit(); ui.state.form.name = 'New draft'
  pending.resolve(structuredClone(defaults)); await settle()
  assert.equal(ui.state.open, true); assert.equal(ui.state.form.name, 'New draft'); assert.equal(ui.state.form.model, 'native-first')
})

test('a delayed directory preserves the existing model while editing and duplicating a saved instance', async t => {
  const pending = deferred<instances.InstanceModelDefaults>()
  const ui = mount({ readDefaults: () => pending.promise }); t.after(ui.unmount)
  ui.state.edit(ui.source); assert.equal(ui.state.form.model, 'saved-model')
  await ui.state.duplicate(ui.source)
  assert.equal(ui.state.editing, undefined); assert.equal(ui.state.form.model, 'saved-model')
  pending.resolve(structuredClone(defaults)); await settle()
  assert.equal(ui.state.form.model, 'saved-model'); assert.equal(ui.state.wizard, false)
  assert.deepEqual(Array.from(ui.state.modelChoices), defaults.models)
  ui.state.edit(ui.source); await settle(); await ui.state.save()
  assert.equal(ui.calls.at(-1)!.input.id, ui.source.id); assert.equal(ui.calls.at(-1)!.input.details.model, 'saved-model')
})

test('directory lookup failure leaves manual model entry usable', async t => {
  const ui = mount({ readDefaults: async () => { throw new Error('fixture catalog failure') } }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.model, ''); assert.deepEqual(Array.from(ui.state.modelChoices), [])
  assert.match(ui.state.nativeModelsError, /可手动填写/)
  ui.state.form.model = 'manual-fallback'; ui.state.step = 2; await ui.state.nextStep(); await ui.state.save()
  assert.equal(ui.state.step, 3); assert.equal(ui.calls.at(-1)!.input.details.model, 'manual-fallback')
})

test('empty Agent Identity models share the Codex native candidates in local API mode', async t => {
  const ui = mount({ kind: 'agent_identity' }); t.after(ui.unmount)
  ui.state.edit(); await settle()
  assert.equal(ui.state.form.connectionMode, 'local_api'); assert.equal(ui.state.form.model, 'native-first')
  assert.deepEqual(Array.from(ui.state.modelChoices), defaults.models)
  assert.deepEqual(ui.manager.data.accounts[0].models, [])
})
