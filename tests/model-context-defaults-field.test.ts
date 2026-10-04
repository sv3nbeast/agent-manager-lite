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
function mount(read: (models: string[]) => Promise<windows.ModelContextDefault[]>) {
  const props=vue.reactive({models:['constructor','toString','normal'],modelValue:{normal:333333} as Record<string,number>,active:true})
  const exports={},context={module:{exports},exports,window:{manager:{readModelContextDefaults:read}},
    require:(id:string)=>id==='vue'?vue:id.endsWith('/modelContextWindows')?windows:(()=>{throw new Error(`Unexpected module ${id}`)})()}
  vm.runInNewContext(javascript,context)
  const component=(context.module.exports as {default:vue.Component}).default as vue.Component&{render?:()=>null};component.render=()=>null
  let child!:vue.VNode
  const parent=vue.defineComponent({setup:()=>()=>child=vue.h(component,props)})
  const renderer=vue.createRenderer<object,{children:object[]}>({patchProp(){},insert(node,parent){parent.children.push(node)},remove(){},createElement:()=>({children:[]}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  const container={children:[] as object[]};renderer.render(vue.h(parent),container)
  return {props,state:child.component!.setupState as Record<string,any>,unmount:()=>renderer.render(null,container)}
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
