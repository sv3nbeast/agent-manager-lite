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

const path = new URL('../src/renderer/src/components/InstancesView.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'instance-history-choice-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const history: instances.InstanceHistorySummary = { sessions: 5, archived: 1, projects: [{ path: '/fixture/project', name: 'Project', exists: true, sessions: 4 }], unassigned: 1, issues: [] }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function settle() { for (let n = 0; n < 5; n++) await vue.nextTick() }
function mount() {
  const accountId = randomUUID(), applicationId = randomUUID(), sourceId = randomUUID()
  const source: instances.InstanceView = { id: sourceId, revision: 2, clientType: 'codex', name: 'Existing instance', applicationId, accountId,
    connectionMode: 'local_api', defaultTier: 'inherit', model: 'source-model', extraArgs: [], createdAt: 1,
    status: 'stopped', directory: '/fixture/source', desktopDirectory: '/fixture/source-desktop', launchMode: 'desktop' }
  const calls: { method: string; input?: any }[] = []
  const manager = vue.reactive({ data: { accounts: [{ id: accountId, kind: 'api_key', name: 'Connection', baseUrl: 'https://fixture.invalid/v1', models: ['connection-model'], wireApi: 'responses', tags: [], createdAt: 1 }],
    providers: [], instances: [source], instanceApplications: [{ id: applicationId, clientType: 'codex', kind: 'desktop', name: 'Codex', path: '/fixture/Codex.app' }], instanceCopy: undefined as instances.InstanceCopyView | undefined },
    loading: false, error: '', async execute(action: () => Promise<any>) { this.loading = true; try { this.data = await action(); return true } catch (cause) { this.error = String(cause); return false } finally { this.loading = false } } })
  const targetId = randomUUID(), jobId = randomUUID()
  const api: Record<string, (...args: any[]) => Promise<any>> = {
    listInstanceWorkingDirectories: async () => [], readModelContextDefaults: async () => [],
    discoverExternalInstanceSources: async () => ({sources:[],issues:[]}),
    selectExternalInstanceSource: async () => ({ticket:randomUUID(),name:'External',directory:'/fixture/external',history:structuredClone(history)}),
    previewInstanceHistory: async input => { calls.push({ method: 'history', input }); return structuredClone(history) },
    chooseInstanceCopySource: async () => ({ ticket: randomUUID(), name: 'External', directory: '/fixture/external', history: structuredClone(history) }),
    chooseExistingInstanceDirectory: async () => ({ ticket: randomUUID(), name: 'External', directory: '/fixture/external', history: structuredClone(history) }),
    copyInstance: async input => { calls.push({ method: 'copy', input }); manager.data.instanceCopy = { id: jobId, sourceId: input.id, sourceName: source.name, name: input.details.name, status: 'copying', files: 0, bytes: 0, totalFiles: 10, totalBytes: 100, skipped: 0 }; return manager.data },
    copyExternalInstance: async input => { calls.push({ method: 'external', input }); manager.data.instanceCopy = { id: jobId, sourceId: randomUUID(), sourceDirectory: '/fixture/external', sourceName: 'External', name: input.details.name, external: true, status: 'copying', files: 0, bytes: 0, totalFiles: 10, totalBytes: 100, skipped: 0 }; return manager.data },
    attachExistingInstance: async input => { calls.push({ method: 'attach', input }); return manager.data },
    saveInstance: async input => { calls.push({ method: 'save', input }); if (!input.id) manager.data.instances.push({ ...source, ...input.details, id: targetId, revision: 0, directory: '/fixture/target' }); return manager.data },
    previewInstanceLaunch: async input => { calls.push({ method: 'preview', input }); return { ticket: randomUUID(), instanceId: input.id, name: 'Preview', history: structuredClone(history) } },
    startInstance: async input => { calls.push({ method: 'start', input }); return manager.data },
    cancelInstanceCopy: async input => { calls.push({ method: 'cancel', input }); manager.data.instanceCopy!.status = 'cancelled'; return manager.data }
  }
  const exports = {}, context = { module: { exports }, exports, document: { querySelector: () => null }, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { Modal: {}, message: { success() {} } } : id === '@ant-design/icons-vue' ? {}
      : id.endsWith('/agentClients') ? clients : id.endsWith('/instances') ? instances : id.endsWith('/modelContextWindows') ? windows
      : id === '../formFeedback' ? { validationErrors, useFormFeedback: () => () => {} }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }; component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }, vnode = vue.h(component)
  renderer.render(vnode, container)
  const state = vnode.component!.setupState as Record<string, any>
  function draft() { state.edit(); state.form.name = 'Chosen history'; state.step = 2 }
  async function selectCopy() { draft(); state.historyMode = 'copy'; await state.chooseHistoryInstance(sourceId) }
  function complete(id = jobId) { manager.data.instanceCopy = { ...manager.data.instanceCopy!, id, status: 'completed', targetId }; manager.data.instances.push({ ...source, id: targetId, revision: 0, directory: '/fixture/target' }) }
  return { state, manager, calls, api, source, sourceId, targetId, jobId, draft, selectCopy, complete, unmount: () => renderer.render(null, container) }
}

test('discovered running external instances can copy saved history without registering or closing the source',async t=>{
  const ui=mount();t.after(ui.unmount);ui.manager.data.instances=[];ui.draft()
  const id=randomUUID(),ticket=randomUUID()
  ui.api.discoverExternalInstanceSources=async()=>({sources:[{id,name:'Other workspace',directory:'/fixture/external',sourceName:'兼容工具',clientType:'codex',launchMode:'desktop',runtimeState:'running'}],issues:[]})
  ui.api.selectExternalInstanceSource=async input=>{assert.equal(input.id,id);assert.deepEqual(Object.keys(input),['id']);return {ticket,name:'External',directory:'/fixture/external',history:structuredClone(history)}}
  await ui.state.selectHistoryChoice('instance')
  assert.equal(ui.manager.data.instances.length,0);assert.equal(ui.state.discoveredSources[0].runtimeState,'running')
  assert.equal(ui.state.instanceSourceOptions[0].options[0].disabled,undefined,'Discovery remains available while the source runs')
  await ui.state.chooseInstanceSource('external:'+id)
  assert.equal(ui.state.externalSource.name,'Other workspace');assert.equal(ui.state.chosenHistory.sessions,5)
  await ui.state.nextStep();assert.equal(ui.state.step,3);assert.equal(ui.calls.length,0);await ui.state.save()
  assert.equal(ui.calls[0].method,'external');assert.equal(ui.calls[0].input.ticket,ticket);assert.equal('sourceClosed' in ui.calls[0].input,false)
  assert.equal('directory' in ui.calls[0].input,false);assert.equal(ui.calls.some(call=>call.method==='start'),false)
})

test('external rescan invalidates its selected copy ticket and ignores responses from a closed draft',async t=>{
  const ui=mount();t.after(ui.unmount);ui.manager.data.instances=[];ui.draft()
  const id=randomUUID(),source={id,name:'Other workspace',directory:'/fixture/external',sourceName:'兼容工具',clientType:'codex',launchMode:'desktop',runtimeState:'not_detected'}
  ui.api.discoverExternalInstanceSources=async()=>({sources:[source],issues:[]})
  await ui.state.selectHistoryChoice('instance');await ui.state.chooseInstanceSource('external:'+id);ui.state.sourceClosed=true
  await ui.state.refreshExternalSources();assert.equal(ui.state.externalSource,undefined);assert.equal(ui.state.sourceClosed,false)
  const pending=deferred<any>();ui.api.discoverExternalInstanceSources=()=>pending.promise
  const scan=ui.state.refreshExternalSources();ui.state.closeEditor();ui.draft()
  pending.resolve({sources:[source],issues:[]});await scan
  assert.equal(ui.state.discoveredSources.length,0);assert.equal(ui.state.historyMode,'empty');assert.equal(ui.state.externalSource,undefined)
})

test('a blank draft stays a four-step wizard and creates independent history without any copy IPC', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft()
  assert.equal(ui.state.historyMode, 'empty'); assert.equal(ui.state.chosenHistory.sessions, 0)
  await ui.state.nextStep(); assert.equal(ui.state.step, 3)
  await ui.state.save(true); await settle()
  assert.deepEqual(ui.calls.map(call => call.method), ['save', 'preview'])
  assert.equal(ui.calls[1].input.id, ui.targetId)
  assert.equal(ui.state.preview.history.projects[0].name, 'Project')
  assert.equal(ui.calls.some(call => call.method === 'start'), false, 'Preview never launches or sends a paid message')
})

test('new drafts receive available client names, restore an empty name and preserve a custom name', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(); assert.equal(ui.state.form.name, 'Codex 1')
  ui.manager.data.instances.push({ ...ui.source, id: randomUUID(), name: ' Codex 1 ' }, { ...ui.source, id: randomUUID(), name: 'cOdEx 2' })
  ui.state.edit(); assert.equal(ui.state.form.name, 'Codex 3', 'Existing names are trimmed and compared without case')
  ui.state.form.name = ' '; ui.state.step = 2; await settle(); await ui.state.nextStep()
  assert.equal(ui.state.form.name, 'Codex 3'); assert.equal(ui.state.step, 3)
  ui.state.form.name = 'My coding workspace'; ui.state.step = 2; await settle(); await ui.state.nextStep()
  assert.equal(ui.state.form.name, 'My coding workspace'); assert.equal(ui.state.step, 3)
  assert.equal(ui.calls.length, 0, 'Preparing and validating names does not register an instance')
})

test('an automatic name resolves a new collision while a custom duplicate is rejected without being rewritten', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(); ui.state.step = 2
  ui.manager.data.instances.push({ ...ui.source, id: randomUUID(), name: 'Codex 1' })
  await settle(); await ui.state.nextStep()
  assert.equal(ui.state.form.name, 'Codex 2'); assert.equal(ui.state.step, 3)
  ui.state.form.name = ' existing INSTANCE '; ui.state.step = 2; await settle(); await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 2); assert.equal(ui.state.form.name, ' existing INSTANCE ')
  assert.match(ui.state.error, /实例名称已存在/); assert.equal(ui.state.fieldErrors.name, ui.state.error)
  assert.equal(ui.calls.length, 0)
})

test('missing model feedback blocks next and save, identifies the field and clears when it is fixed', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft(); ui.state.form.model = ''; await settle()
  await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 2); assert.equal(ui.state.error, '请填写默认模型'); assert.equal(ui.state.fieldErrors.model, '请填写默认模型')
  await ui.state.save(true); await settle()
  assert.equal(ui.calls.length, 0, 'An invalid model never reaches a mutation or a launch preview')
  assert.equal(ui.state.step, 2); assert.equal(ui.state.error, '请填写默认模型')
  ui.state.form.model = 'connection-model'; await settle()
  assert.equal(ui.state.fieldErrors.model, undefined); assert.equal(ui.state.error, '')
  await ui.state.nextStep(); assert.equal(ui.state.step, 3)
  await ui.state.save(true); await settle()
  assert.deepEqual(ui.calls.map(call => call.method), ['save', 'preview'])
})

test('editing a saved instance requires its name instead of generating a different identity', async t => {
  const ui = mount(); t.after(ui.unmount); ui.state.edit(ui.source)
  ui.state.form.name = ' '; await settle(); await ui.state.save(); await settle()
  assert.equal(ui.state.form.name, ' '); assert.equal(ui.state.fieldErrors.name, '请填写实例名称')
  assert.equal(ui.calls.length, 0); assert.equal(ui.manager.data.instances[0].name, 'Existing instance')
})

test('copy selection preserves the draft and wizard; only its successful job target is previewed once', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy()
  assert.equal(ui.state.wizard, true); assert.equal(ui.state.form.model, 'connection-model')
  assert.equal(ui.state.form.name, 'Chosen history'); assert.equal(ui.state.chosenHistory.projects[0].sessions, 4)
  await ui.state.nextStep(); assert.equal(ui.state.step, 3)
  await ui.state.save(true); await settle()
  assert.deepEqual(ui.calls.map(call => call.method), ['history', 'copy'])
  const ownJob = { ...ui.manager.data.instanceCopy! }
  ui.complete(randomUUID()); await settle()
  assert.equal(ui.calls.some(call => call.method === 'preview'), false, 'An unrelated job never opens a preview')
  ui.manager.data.instances.splice(1)
  ui.manager.data.instanceCopy = { ...ownJob, status: 'completed', targetId: ui.targetId }; await settle()
  assert.equal(ui.calls.some(call => call.method === 'preview'), false, 'Wait for the registered successful target')
  ui.manager.data.instances.push({ ...ui.source, id: ui.targetId, revision: 0 }); await settle()
  assert.equal(ui.calls.filter(call => call.method === 'preview').length, 1)
  assert.equal(ui.calls.at(-1)!.input.id, ui.targetId)
  ui.manager.data.instances[1].revision++; await settle()
  assert.equal(ui.calls.filter(call => call.method === 'preview').length, 1)
  assert.equal(ui.calls.some(call => call.method === 'start'), false)
})

test('external snapshot source selection retains configuration and can preview an independent copy while the source stays open', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft(); ui.state.historyMode = 'copy'; ui.state.historySourceKind = 'directory'
  await ui.state.chooseHistoryDirectory()
  assert.equal(ui.state.wizard, true); assert.equal(ui.state.form.name, 'Chosen history'); assert.equal(ui.state.sourceClosed, false)
  await ui.state.nextStep(); await settle()
  assert.equal(ui.state.step, 3); assert.equal(ui.calls.length, 0)
  await ui.state.save(true)
  assert.equal(ui.calls[0].method, 'external'); assert.equal('sourceClosed' in ui.calls[0].input, false)
  ui.complete(); await settle()
  assert.equal(ui.calls.at(-1)!.method, 'preview'); assert.equal(ui.calls.at(-1)!.input.id, ui.targetId)
})

test('blank selection clears a previous source and prevents unintended history reuse', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy()
  ui.state.historyMode = 'empty'; ui.state.changeHistoryMode()
  assert.equal(ui.state.copySource, undefined); assert.equal(ui.state.externalSource, undefined); assert.equal(ui.state.chosenHistory.sessions, 0)
  await ui.state.save(); assert.equal(ui.calls.at(-1)!.method, 'save')
})

test('copying rejects changing, running and unreadable sources before mutation', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy()
  ui.manager.data.instances[0].revision++
  await ui.state.save(); assert.equal(ui.calls.length, 1); assert.match(ui.state.error, /已变化/)
  ui.manager.data.instances[0].status = 'running'; await ui.state.chooseHistoryInstance(ui.sourceId)
  assert.match(ui.state.historyError, /已停止/)
  ui.manager.data.instances[0].status = 'stopped'
  ui.api.previewInstanceHistory = async () => { throw new Error('fixture unreadable index') }
  await ui.state.chooseHistoryInstance(ui.sourceId); await ui.state.save()
  assert.match(ui.state.error, /无法核对/); assert.equal(ui.calls.some(call => call.method === 'copy'), false)
})

test('stale history reads and cancelled directory pickers cannot replace a newer choice or draft', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft(); ui.state.historyMode = 'copy'
  const old = deferred<instances.InstanceHistorySummary>(), fresh = deferred<instances.InstanceHistorySummary>(); let request = 0
  ui.api.previewInstanceHistory = async () => ++request === 1 ? old.promise : fresh.promise
  const first = ui.state.chooseHistoryInstance(ui.sourceId), second = ui.state.chooseHistoryInstance(ui.sourceId)
  fresh.resolve({ ...history, sessions: 7 }); await second
  old.resolve({ ...history, sessions: 99 }); await first
  assert.equal(ui.state.chosenHistory.sessions, 7)
  ui.state.historySourceKind = 'directory'; ui.state.changeHistorySourceKind()
  const picker = deferred<instances.InstanceCopySource | undefined>(); ui.api.chooseInstanceCopySource = async () => picker.promise
  const picking = ui.state.chooseHistoryDirectory(); ui.state.closeEditor(); ui.draft()
  picker.resolve({ ticket: randomUUID(), name: 'Stale', directory: '/fixture/stale', history }); await picking
  assert.equal(ui.state.externalSource, undefined); assert.equal(ui.state.historyMode, 'empty'); assert.equal(ui.state.form.name, 'Chosen history')
})

test('cancelling automatic preview or opening a new draft prevents a completed copy from interrupting', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy(); await ui.state.save(true)
  ui.state.cancelCopyPreview(); ui.complete(); await settle()
  assert.equal(ui.calls.some(call => call.method === 'preview'), false)
  ui.manager.data.instanceCopy = undefined; await ui.selectCopy(); await ui.state.save(true)
  ui.state.edit(); ui.complete(); await settle()
  assert.equal(ui.calls.some(call => call.method === 'preview'), false)
})

test('failed and cancelled copy jobs never preview or launch a client', async t => {
  for (const status of ['failed', 'cancelled'] as const) {
    const ui = mount(); t.after(ui.unmount); await ui.selectCopy(); await ui.state.save(true)
    ui.manager.data.instanceCopy!.status = status; await settle()
    assert.equal(ui.state.pendingCopyPreview, undefined)
    assert.equal(ui.calls.some(call => call.method === 'preview' || call.method === 'start'), false)
  }
})

test('existing edit preserves history and direct copy/attach entry points remain separate', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.edit(ui.source); assert.equal(ui.state.wizard, false); await ui.state.save()
  assert.equal(ui.calls[0].method, 'save'); assert.equal(ui.calls[0].input.id, ui.sourceId)
  await ui.state.duplicate(ui.source); assert.equal(ui.state.wizard, false); assert.equal(ui.state.chosenHistory.sessions, 5)
  assert.equal(ui.state.form.model, 'source-model'); assert.match(ui.state.form.name, /副本/)
  await ui.state.save(); assert.equal(ui.calls.at(-1)!.method, 'copy')
  ui.manager.data.instanceCopy = undefined
  await ui.state.chooseExternal('attach'); assert.equal(ui.state.attachingForm, true); assert.equal(ui.state.sourceClosed, false)
  await ui.state.save(); assert.notEqual(ui.calls.at(-1)!.method, 'attach')
  ui.state.sourceClosed = true; await ui.state.save(); assert.equal(ui.calls.at(-1)!.method, 'attach')
})

test('missing compatible accounts and repeated save clicks cannot register or duplicate a copy', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy()
  const accounts = [...ui.manager.data.accounts]; ui.manager.data.accounts = []
  await ui.state.save(); assert.equal(ui.calls.some(call => call.method === 'copy'), false); assert.match(ui.state.error, /兼容/)
  ui.manager.data.accounts = accounts
  const gate = deferred<any>(); const original = ui.api.copyInstance
  ui.api.copyInstance = async input => { const result = await original(input); await gate.promise; return result }
  const first = ui.state.save(), second = ui.state.save(); await settle(); gate.resolve(undefined); await Promise.all([first, second])
  assert.equal(ui.calls.filter(call => call.method === 'copy').length, 1)
})


test('source removal while resource validation awaits cannot silently create a blank instance', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.selectCopy()
  const saving = ui.state.save()
  ui.state.clearHistorySource()
  await saving
  assert.match(ui.state.error, /请选择.*会话来源/)
  assert.equal(ui.calls.some(call => call.method === 'copy' || call.method === 'save'), false)
})

test('the three direct history choices reuse one stopped source, preserve repeated selection and clear a different source', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft()
  assert.equal(ui.state.historyChoice, 'empty')
  await ui.state.selectHistoryChoice('instance')
  assert.equal(ui.state.historyChoice, 'instance'); assert.equal(ui.state.copySource.id, ui.sourceId)
  assert.equal(ui.calls.filter(call => call.method === 'history').length, 1)
  await ui.state.selectHistoryChoice('instance')
  assert.equal(ui.calls.filter(call => call.method === 'history').length, 1, 'Selecting the active option keeps its successful preview')
  await ui.state.selectHistoryChoice('directory')
  assert.equal(ui.state.copySource, undefined); assert.equal(ui.state.chosenHistory, undefined)
  assert.equal(ui.state.sourceClosed, false)
  await ui.state.chooseHistoryDirectory(); ui.state.sourceClosed = true
  assert.equal(ui.state.chosenHistory.sessions, 5)
  await ui.state.selectHistoryChoice('empty')
  assert.equal(ui.state.externalSource, undefined); assert.equal(ui.state.copySource, undefined)
  assert.equal(ui.state.sourceClosed, false); assert.equal(ui.state.chosenHistory.sessions, 0)
  assert.equal(ui.state.form.name, 'Chosen history'); assert.equal(ui.state.form.model, 'connection-model')
})

test('a direct source choice never silently chooses a running or ambiguous source and rejects stale history completion', async t => {
  const ui = mount(); t.after(ui.unmount); ui.draft()
  ui.manager.data.instances[0].status = 'running'
  await ui.state.selectHistoryChoice('instance')
  assert.equal(ui.state.copySource, undefined); assert.equal(ui.calls.length, 0)
  await ui.state.selectHistoryChoice('empty'); ui.manager.data.instances[0].status = 'stopped'
  ui.manager.data.instances.push({ ...ui.source, id: randomUUID() })
  await ui.state.selectHistoryChoice('instance')
  assert.equal(ui.state.copySource, undefined); assert.equal(ui.calls.length, 0, 'Multiple sources require an explicit source choice')
  ui.manager.data.instances.pop(); await ui.state.selectHistoryChoice('empty')
  const pending = deferred<instances.InstanceHistorySummary>()
  ui.api.previewInstanceHistory = async () => pending.promise
  const selecting = ui.state.selectHistoryChoice('instance')
  await ui.state.selectHistoryChoice('directory'); pending.resolve({ ...history, sessions: 99 }); await selecting
  assert.equal(ui.state.historyChoice, 'directory'); assert.equal(ui.state.chosenHistory, undefined)
  assert.equal(ui.state.copySource, undefined)
})
