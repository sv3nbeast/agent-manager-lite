import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as windows from '../src/shared/modelContextWindows'

const path = new URL('../src/renderer/src/components/ModelContextWindowsField.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'context-defaults-field-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function mount(read: (models: string[]) => Promise<windows.ModelContextDefault[]>, inheritedWindows?: Record<string, number>) {
  const props=vue.reactive({models:['constructor','toString','normal'],modelValue:{normal:333333} as Record<string,number> | undefined,inheritedWindows,active:true})
  const events: unknown[] = []
  const exports={},context={module:{exports},exports,window:{manager:{readModelContextDefaults:read}},
    require:(id:string)=>id==='vue'?vue:id.endsWith('/modelContextWindows')?windows:(()=>{throw new Error(`Unexpected module ${id}`)})()}
  vm.runInNewContext(javascript,context)
  const component=(context.module.exports as {default:vue.Component}).default as vue.Component&{render?:()=>null};component.render=()=>null
  let child!:vue.VNode
  const parent=vue.defineComponent({setup:()=>()=>child=vue.h(component,{...props,'onUpdate:modelValue':(value:Record<string,number>|undefined)=>{events.push(value);props.modelValue=value}})})
  const renderer=vue.createRenderer<object,{children:object[]}>({patchProp(){},insert(node,parent){parent.children.push(node)},remove(){},createElement:()=>({children:[]}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  const container={children:[] as object[]};renderer.render(vue.h(parent),container)
  return {props,events,state:child.component!.setupState as Record<string,any>,unmount:()=>renderer.render(null,container)}
}
const flush=async()=>{await Promise.resolve();await vue.nextTick()}

test('default field handles provider model names matching object properties and ignores old model-list responses',async t=>{
  const first=deferred<windows.ModelContextDefault[]>(),second=deferred<windows.ModelContextDefault[]>()
  let count=0
  const ui=mount(()=>++count===1?first.promise:second.promise);t.after(ui.unmount)
  assert.equal(ui.state.choice('constructor'),'default')
  assert.doesNotThrow(()=>ui.state.optionsFor('toString'))
  assert.doesNotThrow(()=>ui.state.optionsFor('__proto__'))
  ui.props.models=['gpt-6-luna'];await vue.nextTick()
  second.resolve([{modelId:'gpt-6-luna',contextWindow:256000,source:'catalog'}]);await flush()
  assert.equal(ui.state.optionsFor('gpt-6-luna')[0].label,'未设置 · 使用默认值 256K')
  first.resolve([{modelId:'constructor',contextWindow:272000,source:'template'}]);await flush()
  assert.equal(Object.hasOwn(ui.state.defaults,'constructor'),false)
  assert.equal(ui.state.choice('normal'),'custom','Existing custom windows must survive a model-list refresh')
  ui.props.active=false;await vue.nextTick()
  assert.deepEqual(Object.keys(ui.state.defaults),[])
})

test('connection defaults show exact supplier values and fall back per model to catalogue values', async t => {
  const inherited = JSON.parse('{"normal":400000,"constructor":512000,"__proto__":200000}') as Record<string,number>
  const ui = mount(async models => models.map(modelId => ({ modelId, contextWindow: 256000, source: 'catalog' })), inherited); t.after(ui.unmount)
  await flush()
  assert.equal(ui.state.optionsFor('normal')[0].label, '未设置 · 使用供应商默认值 400K')
  assert.equal(ui.state.optionsFor('constructor')[0].label, '未设置 · 使用供应商默认值 512K')
  assert.equal(ui.state.optionsFor('__proto__')[0].label, '未设置 · 使用供应商默认值 200K')
  assert.equal(ui.state.optionsFor('toString')[0].label, '未设置 · 使用默认值 256K')
  assert.equal(ui.state.choice('normal'), 'custom', 'Inherited defaults do not replace the connection override')
  ui.props.inheritedWindows = { normal: 1000000 }; await vue.nextTick()
  assert.equal(ui.state.optionsFor('normal')[0].label, '未设置 · 使用供应商默认值 1M')
  assert.equal(ui.state.optionsFor('normal').some((value:any)=>value.value === 2000000), false)
})

test('clearing a model override inherits its supplier value and preserves other models', async t => {
  const inherited = { normal: 400000 }, ui = mount(async () => [], inherited); t.after(ui.unmount)
  ui.props.modelValue = { normal: 512000, hidden: 333333 }; await vue.nextTick()
  ui.state.select('normal', 'default'); await vue.nextTick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.props.modelValue)), { hidden: 333333 })
  assert.equal(ui.state.choice('normal'), 'default')
  assert.equal(ui.state.optionsFor('normal')[0].label, '未设置 · 使用供应商默认值 400K')
  assert.deepEqual(inherited, { normal: 400000 })
  ui.state.clearAll(); await vue.nextTick()
  assert.equal(ui.props.modelValue, undefined)
})
