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

const path=new URL('../src/renderer/src/components/ProviderProbePanel.vue',import.meta.url)
const {descriptor}=parse(readFileSync(path,'utf8'),{filename:path.pathname})
const script=compileScript(descriptor,{id:'provider-probe-panel-test'})
const javascript=ts.transpileModule(script.content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function mount() {
  const provider:ProviderSummary={id:randomUUID(),revision:4,name:'Mixed supplier',baseUrl:'https://mixed.invalid/v1',models:['legacy-model-must-not-appear'],wireApi:'responses',defaultTier:'inherit',createdAt:1,updatedAt:1,keys:[
    {id:randomUUID(),name:'OpenAI key',models:['vendor-text','another-model'],protocol:'openai_chat_completions',credentialKind:'openai_api_key',accountIds:[],createdAt:1,updatedAt:1},
    {id:randomUUID(),name:'Anthropic key',models:['claude-custom'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer',accountIds:[],createdAt:1,updatedAt:1},
    {id:randomUUID(),name:'Empty key',models:[],protocol:'openai_responses',credentialKind:'openai_api_key',accountIds:[],createdAt:1,updatedAt:1}
  ]}
  const probes:any[]=[],writes:any[]=[]
  const manager=vue.reactive({data:{providers:[provider],providerProbe:{running:false}},error:'',loading:false,async execute(action:()=>Promise<unknown>){await action();return true}})
  const exports={},context={module:{exports},exports,console,window:{manager:{startProviderProbe:async(input:unknown)=>{probes.push(structuredClone(input))},mutateProvider:async(input:unknown)=>{writes.push(structuredClone(input))}}},
    require:(id:string)=>id==='vue'?vue:id==='ant-design-vue'?{message:{success(){},info(){}}}:id==='../store'?{useManager:()=>manager}:id.endsWith('/providerLibrary')?library:(()=>{throw new Error(`Unexpected module ${id}`)})()}
  vm.runInNewContext(javascript,context)
  const component=(context.module.exports as {default:vue.Component}).default as vue.Component&{render?:()=>null};component.render=()=>null
  const renderer=vue.createRenderer<object,{children:object[]}>({patchProp(){},insert(node,parent){parent.children.push(node)},remove(){},createElement:()=>({children:[]}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  const container={children:[] as object[]},vnode=vue.h(component,{open:false});renderer.render(vnode,container)
  return {state:vnode.component!.setupState as Record<string,any>,provider,manager,probes,writes,unmount:()=>renderer.render(null,container)}
}

test('chat test picks and sends a separate configured model for each selected key',async t=>{
  const ui=mount();t.after(ui.unmount)
  const values=ui.provider.keys.slice(0,2).map(key=>`${ui.provider.id}/${key.id}`)
  ui.state.selection=values;ui.state.mode='chat';await vue.nextTick()
  assert.deepEqual(Array.from(ui.state.selectedTargets,(target:any)=>Array.from(target.models)),[['vendor-text','another-model'],['claude-custom']])
  ui.state.testModels[values[0]]='another-model'
  await ui.state.start()
  assert.equal(ui.probes.length,1)
  assert.deepEqual(ui.probes[0].targets.map((target:any)=>target.model),['another-model','claude-custom'])
  assert.equal(ui.probes[0].model,undefined)
})

test('empty catalogues require model configuration and never use a supplier or hardcoded model',async t=>{
  const ui=mount();t.after(ui.unmount)
  ui.state.selection=[`${ui.provider.id}/${ui.provider.keys[2].id}`];ui.state.mode='chat';await vue.nextTick()
  await ui.state.start()
  assert.equal(ui.probes.length,0);assert.match(ui.state.error,/Empty key.*已配置的测试模型/)
  ui.state.mode='models';await ui.state.start();assert.equal(ui.probes.length,1)
})

test('Anthropic-only probes do not send OpenAI service tiers',async t=>{
  const ui=mount();t.after(ui.unmount)
  ui.state.selection=[`${ui.provider.id}/${ui.provider.keys[1].id}`];ui.state.mode='chat';ui.state.serviceTier='priority';await vue.nextTick()
  assert.equal(ui.state.hasOpenAiTarget,false)
  await ui.state.start()
  assert.equal(ui.probes[0].serviceTier,undefined)
  assert.equal(ui.probes[0].targets[0].model,'claude-custom')
})

test('discovered models replace only the tested key and clearing keeps its fetched results',async t=>{
  const ui=mount();t.after(ui.unmount)
  const target=ui.provider.keys[1]
  const record={providerId:ui.provider.id,providerRevision:ui.provider.revision,providerName:ui.provider.name,keyId:target.id,keyName:target.name,models:[{id:'fresh-a'},{id:'fresh-b'}]}
  ui.state.chooseModels(record)
  assert.deepEqual(Array.from(ui.state.modelSelection),['claude-custom'])
  assert.deepEqual(Array.from(ui.state.catalogOptions,(option:any)=>option.value),['claude-custom','fresh-a','fresh-b'])
  ui.state.modelSelection=[]
  assert.equal(ui.state.modelRecord.models.length,2)
  ui.state.addFetchedModels();await ui.state.saveModels()
  assert.deepEqual(ui.writes[0],{action:'editKey',id:ui.provider.id,revision:ui.provider.revision,keyId:target.id,models:['fresh-a','fresh-b']})
  ui.state.chooseModels(record);ui.state.modelSelection=[];await ui.state.saveModels()
  assert.deepEqual(ui.writes[1].models,[])
  assert.deepEqual(ui.provider.keys[0].models,['vendor-text','another-model'])
})
