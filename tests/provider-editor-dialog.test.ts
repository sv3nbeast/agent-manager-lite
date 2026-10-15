import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { randomUUID } from 'node:crypto'
import * as library from '../src/shared/providerLibrary'
import type { ProviderSummary } from '../src/shared/providerLibrary'
import type { ManagerAPI } from '../src/shared/types'
import * as presets from '../src/shared/providerPresets'
import * as feedback from '../src/renderer/src/formFeedback'

const path = new URL('../src/renderer/src/components/ProviderLibraryView.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'provider-editor-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function provider(name:string, baseUrl:string):ProviderSummary {
  return {id:randomUUID(),revision:2,name,baseUrl,models:['fixture-model'],wireApi:'responses',defaultTier:'inherit',createdAt:1,updatedAt:1,
    keys:[{id:randomUUID(),name:'Primary',createdAt:1,updatedAt:1,accountIds:[]}]}
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function mount(overrides:Partial<ManagerAPI>={}) {
  const providers=[provider('First','https://first.invalid/v1'),provider('Second','https://second.invalid/v1')]
  const writes:unknown[]=[]
  const manager=vue.reactive({data:{providers,accounts:[] as any[]},error:'',loading:false,
    async execute(action:()=>Promise<any>){await action();return true}})
  const api:Partial<ManagerAPI>={readProviderKey:async input=>`fixture-${input.id}`,mutateProvider:async input=>{writes.push(structuredClone(input));return manager.data as any},...overrides}
  const exports={}
  const context={module:{exports},exports,window:{manager:api},console,
    require:(id:string)=>id==='vue'?vue:id==='ant-design-vue'?{message:{success(){},info(){},error(){}},Modal:{confirm(){}}}:id==='../store'?{useManager:()=>manager}:id==='../formFeedback'?feedback:id.endsWith('/providerLibrary')?library:id.endsWith('/providerPresets')?presets:id.endsWith('/providerUsage')?{integrationTypeOptions:[]}:id==='@ant-design/icons-vue'?{}:id.endsWith('.vue')?{default:{}}:(()=>{throw new Error(`Unexpected module ${id}`)})()}
  vm.runInNewContext(javascript,context)
  const component=(context.module.exports as {default:vue.Component}).default as vue.Component&{render?:()=>null};component.render=()=>null
  const renderer=vue.createRenderer<object,{children:object[]}>({patchProp(){},insert(node,parent){parent.children.push(node)},remove(){},createElement:()=>({children:[]}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  const container={children:[] as object[]},vnode=vue.h(component)
  renderer.render(vnode,container)
  return {state:vnode.component!.setupState as Record<string,any>,providers,manager,writes,unmount:()=>renderer.render(null,container)}
}
const flush=async()=>{await Promise.resolve();await vue.nextTick()}

test('supplier drafts validate address and name without requiring a supplier model catalogue',async t=>{
  const ui=mount();t.after(ui.unmount);ui.state.openEditor()
  await ui.state.saveProvider()
  assert.equal(ui.writes.length,0)
  assert.equal(ui.state.editorError,'请填写供应商名称')
  assert.equal(ui.state.editorFieldErrors.models,undefined)
  ui.state.details.name='Supplier';assert.equal(ui.state.editorError,'')
  ui.state.details.baseUrl='https://supplier.invalid/v1'
  await ui.state.saveProvider()
  const saved=ui.writes[0] as any
  assert.deepEqual(saved.details.models,[])
  assert.equal(saved.initialKey,undefined)
})

test('supplier metadata editing never reads or overwrites any key catalogue or protocol',async t=>{
  let reads=0
  const ui=mount({readProviderKey:async()=>{reads++;return 'must-not-read'}});t.after(ui.unmount)
  ui.providers[0].keys[0].models=['model-for-first-key']
  ui.providers[0].keys.push({...ui.providers[0].keys[0],id:randomUUID(),models:['claude-custom'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer'})
  ui.providers[0].modelContextWindows={'model-for-first-key':333333,unselected:262144}
  ui.state.openEditor(ui.providers[0]);await flush()
  assert.equal(reads,0)
  assert.equal(ui.state.draftKey,'')
  assert.deepEqual(Array.from(ui.state.contextModels),['model-for-first-key','claude-custom'])
  ui.state.details.name='Edited'
  ui.state.details.baseUrl='https://new-address.invalid/v1'
  await ui.state.saveProvider()
  const saved=ui.writes[0] as any
  assert.equal(saved.action,'update')
  assert.equal(saved.keyChange,undefined)
  assert.equal(saved.changes.models,undefined)
  assert.equal(saved.changes.wireApi,undefined)
  assert.deepEqual(saved.changes.modelContextWindows,{'model-for-first-key':333333,unselected:262144})
  ui.state.openEditor(ui.providers[0]);ui.state.details.modelContextWindows=undefined
  await ui.state.saveProvider()
  assert.equal((ui.writes[1] as any).clearModelContextWindows,true)
})

test('first key owns fetched models and protocol; presets fill only the endpoint',async t=>{
  const ui=mount();t.after(ui.unmount);ui.state.openEditor()
  ui.state.details.name='Mixed supplier';ui.state.applyPreset('openrouter')
  assert.deepEqual(Array.from(ui.state.modelValues),[],'Offline presets must not assume a key has particular models')
  ui.state.draftKey='fixture-first-key';ui.state.initialKeyName='Claude key';ui.state.initialProtocol='anthropic_messages'
  assert.equal(ui.state.initialCredentialKind,'anthropic_api_key')
  ui.state.initialCredentialKind='anthropic_bearer';ui.state.modelValues=['custom-claude','other-model']
  await ui.state.saveProvider()
  const saved=ui.writes[0] as any
  assert.deepEqual(saved.details.models,[])
  assert.deepEqual(saved.initialKey,{name:'Claude key',apiKey:'fixture-first-key',createConnection:true,models:['custom-claude','other-model'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer'})
})

test('new keys start with empty models and can be saved without enabling a connection',async t=>{
  const ui=mount();t.after(ui.unmount)
  await ui.state.openOperation('addKey',ui.providers[0])
  assert.deepEqual(Array.from(ui.state.keyForm.models),[])
  ui.state.keyForm.apiKey='fixture-empty-catalog'
  await ui.state.saveOperation();assert.equal(ui.writes.length,0);assert.match(ui.state.operationError,/至少一个模型/)
  ui.state.keyForm.createConnection=false
  await ui.state.saveOperation()
  assert.deepEqual((ui.writes[0] as any).models,[])
  assert.equal((ui.writes[0] as any).createConnection,false)
})

test('key editing keeps catalogues independent and saves an intentional empty catalogue',async t=>{
  const ui=mount();t.after(ui.unmount)
  const first=ui.providers[0].keys[0]
  first.models=['first-model'];first.protocol='anthropic_messages';first.credentialKind='anthropic_bearer'
  await ui.state.openOperation('editKey',ui.providers[0],first)
  assert.deepEqual(Array.from(ui.state.keyForm.models),['first-model'])
  assert.equal(ui.state.keyForm.protocol,'anthropic_messages')
  assert.equal(ui.state.keyForm.credentialKind,'anthropic_bearer')
  ui.state.keyForm.models=[]
  await ui.state.saveOperation()
  const saved=ui.writes[0] as any
  assert.equal(saved.action,'editKey');assert.equal(saved.keyId,first.id);assert.deepEqual(saved.models,[])
  assert.equal(saved.protocol,'anthropic_messages');assert.equal(saved.credentialKind,'anthropic_bearer')
  assert.deepEqual(first.models,['first-model'],'The draft does not mutate the live summary before IPC succeeds')
})

test('editing key cancellation and subsequent supplier edits ignore late secrets and redact read failures',async t=>{
  const late=deferred<string>(),ui=mount({readProviderKey:()=>late.promise});t.after(ui.unmount)
  const request=ui.state.openOperation('editKey',ui.providers[0],ui.providers[0].keys[0]);ui.state.closeOperation()
  ui.state.openEditor(ui.providers[1])
  late.resolve('fixture-late-secret');await request
  assert.equal(ui.state.keyForm.apiKey,'');assert.equal(ui.state.draftKey,'');assert.equal(ui.writes.length,0)
  const failure=mount({readProviderKey:async()=>{throw new Error('fixture-do-not-display-secret')}});t.after(failure.unmount)
  await failure.state.openOperation('editKey',failure.providers[0],failure.providers[0].keys[0])
  assert.ok(failure.state.operationKeyError);assert.ok(!failure.state.operationKeyError.includes('fixture-do-not-display-secret'))
  await failure.state.saveOperation();assert.equal(failure.writes.length,0)
})

test('managed connection shortcut edits its own key without opening a supplier-wide model editor',async t=>{
  const ui=mount();t.after(ui.unmount)
  const provider=ui.providers[0],target=provider.keys[0]
  assert.equal(ui.state.editProvider(provider.id,target.id),true)
  await flush()
  assert.equal(ui.state.operation,'editKey');assert.equal(ui.state.key.id,target.id)
  assert.equal(ui.state.editorOpen,false)
  assert.equal(ui.state.editProvider(provider.id,randomUUID()),false)
})
