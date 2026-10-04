import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { webcrypto } from 'node:crypto'
import type { ManagerAPI } from '../src/shared/types'
import type { ProviderModelsResult } from '../src/shared/providerModels'

const path = new URL('../src/renderer/src/components/ProviderModelsField.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'provider-models-field-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function mount(overrides:Partial<ManagerAPI>={}) {
  const requests:unknown[]=[],cancelled:string[]=[]
  const api:Partial<ManagerAPI>={fetchProviderModels:async input=>{requests.push(structuredClone(input));return {requestId:input.requestId,models:[{id:'fixture-model'}],modelsTruncated:false}},cancelProviderModels:async id=>{cancelled.push(id)},...overrides}
  const exports={}
  const context={module:{exports},exports,window:{manager:api},console,crypto:webcrypto,require:(id:string)=>id==='vue'?vue:(()=>{throw new Error(`Unexpected module ${id}`)})()}
  vm.runInNewContext(javascript,context)
  const component=(context.module.exports as {default:vue.Component}).default as vue.Component&{render?:()=>null};component.render=()=>null
  const renderer=vue.createRenderer<object,{children:object[]}>({patchProp(){},insert(node,parent){parent.children.push(node)},remove(){},createElement:()=>({children:[]}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  const container={children:[] as object[]}
  let props:Record<string,unknown>={modelValue:[],baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-secret',active:true,keyManaged:true}
  let vnode=vue.h(component,props);renderer.render(vnode,container)
  const state=vnode.component!.setupState as Record<string,any>
  const update=(changes:Record<string,unknown>)=>{props={...props,...changes};vnode=vue.h(component,props);renderer.render(vnode,container)}
  return {state,requests,cancelled,update,unmount:()=>renderer.render(null,container)}
}

test('changing target during cancellation keeps retries disabled until main-process cleanup and ignores late results',async t=>{
  const first=deferred<ProviderModelsResult>(),cancellation=deferred<void>(),requests:any[]=[]
  const ui=mount({fetchProviderModels:input=>{requests.push(input);return requests.length===1?first.promise:Promise.resolve({requestId:input.requestId,models:[{id:'new-model'}],modelsTruncated:false})},cancelProviderModels:()=>cancellation.promise});t.after(ui.unmount)
  const operation=ui.state.fetchModels();assert.equal(ui.state.busy,true)
  const cancel=ui.state.cancel()
  ui.update({baseUrl:'https://changed.invalid/v1',apiKey:'fixture-new-secret'});await vue.nextTick()
  assert.equal(ui.state.busy,true,'A second target-change cancellation must not re-enable retry before cleanup')
  await ui.state.fetchModels();assert.equal(requests.length,1)
  first.resolve({requestId:requests[0].requestId,models:[{id:'stale-model'}],modelsTruncated:false});await operation
  assert.equal(ui.state.fetched.length,0)
  cancellation.resolve();await cancel;await vue.nextTick()
  assert.equal(ui.state.busy,false)
  await ui.state.fetchModels()
  assert.equal(requests.length,2);assert.equal(ui.state.fetched[0].id,'new-model')
  assert.equal(requests[1].apiKey,'fixture-new-secret')
})

test('an externally managed empty key never falls back to the provider default after address changes',async t=>{
  const ui=mount();t.after(ui.unmount)
  ui.update({apiKey:'',provider:{id:'provider',revision:1,keys:[{id:'saved-key',name:'old'}]}});await vue.nextTick()
  await ui.state.fetchModels()
  assert.equal(ui.requests.length,1)
  assert.equal((ui.requests[0] as any).apiKey,undefined)
  assert.equal((ui.requests[0] as any).savedKey,undefined)
})
