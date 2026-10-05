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

test('saving incomplete supplier drafts gives field errors instead of silently disabling the action',async t=>{
  const ui=mount();t.after(ui.unmount);ui.state.openEditor()
  await ui.state.saveProvider()
  assert.equal(ui.writes.length,0)
  assert.equal(ui.state.editorError,'请填写供应商名称')
  assert.equal(ui.state.editorFieldErrors.models,'请至少添加一个模型')
  ui.state.details.name='Supplier';assert.equal(ui.state.editorError,'')
  await ui.state.saveProvider();assert.equal(ui.state.editorError,'请至少添加一个模型')
  ui.state.models='fixture-model';ui.state.details.baseUrl='bad-url'
  await ui.state.saveProvider();assert.ok(ui.state.editorFieldErrors.baseUrl);assert.equal(ui.writes.length,0)
})

test('supplier editing reads selected saved keys; cancelling and late responses cannot fill another supplier',async t=>{
  const first=deferred<string>(),second=deferred<string>();let reads=0
  const ui=mount({readProviderKey:()=>++reads===1?first.promise:second.promise});t.after(ui.unmount)
  ui.state.openEditor(ui.providers[0]);assert.equal(ui.state.editorKeyLoading,true)
  ui.state.editorOpen=false;ui.state.openEditor(ui.providers[1])
  second.resolve('fixture-second-secret');await flush()
  assert.equal(ui.state.draftKey,'fixture-second-secret')
  first.resolve('fixture-first-secret');await flush()
  assert.equal(ui.state.draftKey,'fixture-second-secret')
  ui.state.editorOpen=false;await flush()
  assert.equal(ui.state.draftKey,'');assert.equal(ui.writes.length,0)
})

test('changing destination removes the old key immediately, including in-flight reads and returning to the original address',async t=>{
  const late=deferred<string>(),ui=mount({readProviderKey:()=>late.promise});t.after(ui.unmount)
  ui.state.openEditor(ui.providers[0]);ui.state.details.baseUrl='https://new.invalid/v1'
  assert.equal(ui.state.editorKeyId,undefined);assert.equal(ui.state.draftKey,'')
  ui.state.draftKey='fixture-explicit-new-secret'
  late.resolve('fixture-old-secret');await flush()
  assert.equal(ui.state.draftKey,'fixture-explicit-new-secret')
  ui.state.details.baseUrl=ui.providers[0].baseUrl;await flush()
  assert.equal(ui.state.editorKeyId,undefined,'Returning to the old address must not reattach its key')
  assert.equal(ui.state.draftKey,'','A destination change clears even a temporary key for the other endpoint')
})

test('editing key cancellation ignores late reads and failures never show returned secret error text',async t=>{
  const late=deferred<string>(),ui=mount({readProviderKey:()=>late.promise});t.after(ui.unmount)
  const request=ui.state.openOperation('editKey',ui.providers[0],ui.providers[0].keys[0]);ui.state.closeOperation()
  late.resolve('fixture-late-secret');await request
  assert.equal(ui.state.keyForm.apiKey,'');assert.equal(ui.writes.length,0)
  const failure=mount({readProviderKey:async()=>{throw new Error('fixture-do-not-display-secret')}});t.after(failure.unmount)
  await failure.state.openOperation('editKey',failure.providers[0],failure.providers[0].keys[0])
  assert.ok(failure.state.operationKeyError);assert.ok(!failure.state.operationKeyError.includes('fixture-do-not-display-secret'))
  await failure.state.saveOperation();assert.equal(failure.writes.length,0)
})

test('supplier drafts preserve arbitrary and unselected context values; saving a changed key is one atomic mutation',async t=>{
  const ui=mount({readProviderKey:async()=> 'fixture-original'});t.after(ui.unmount)
  ui.providers[0].modelContextWindows={'fixture-model':333333,unselected:262144}
  ui.state.openEditor(ui.providers[0]);await flush()
  assert.equal(ui.state.draftKey,'fixture-original')
  ui.state.draftKey='fixture-rotated';ui.state.details.name='Edited'
  await ui.state.saveProvider()
  assert.equal(ui.writes.length,1)
  const saved=ui.writes[0] as any
  assert.deepEqual(JSON.parse(JSON.stringify(saved.keyChange)),{keyId:ui.providers[0].keys[0].id,apiKey:'fixture-rotated'})
  assert.deepEqual(JSON.parse(JSON.stringify(saved.changes.modelContextWindows)),{'fixture-model':333333,unselected:262144})
  ui.state.openEditor(ui.providers[0]);await flush();ui.state.details.modelContextWindows=undefined
  await ui.state.saveProvider()
  assert.equal((ui.writes[1] as any).clearModelContextWindows,true)
})
