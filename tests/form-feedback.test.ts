import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as pinia from 'pinia'
import { z } from 'zod'
import { accountInputSchema } from '../src/shared/types'
import { providerURLSchema } from '../src/shared/providerConfig'
import type * as Feedback from '../src/renderer/src/formFeedback'

function fixture() {
  const notices: { key: string; content: string; duration: number }[] = [], destroyed: string[] = []
  const document = { querySelector: (_selector:string): any => null }
  const modules: Record<string, unknown> = {
    vue, pinia, 'ant-design-vue': { message: { error: (value: typeof notices[number]) => { notices.push(value) }, destroy: (key: string) => { destroyed.push(key) } } }
  }
  function load(path: string) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports = {}, context = { exports, module: { exports }, Error, document, require: (id: string) => modules[id] }
    vm.runInNewContext(javascript, context)
    return context.module.exports as any
  }
  const feedback = load('../src/renderer/src/formFeedback.ts') as typeof Feedback
  modules['./formFeedback'] = feedback
  return { feedback, notices, destroyed, document, load }
}

test('offscreen form errors notify immediately, reuse their key, and clear when corrected or closed', () => {
  const f = fixture(), scope = vue.effectScope(), error = vue.ref(''), open = vue.ref(true)
  scope.run(() => f.feedback.useFormFeedback(error, { active: open }))
  error.value = '请填写实例名称'
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0].content, '请填写实例名称')
  error.value = '请选择项目目录'
  assert.equal(f.notices[1].key, f.notices[0].key)
  error.value = ''
  assert.equal(f.destroyed.at(-1), f.notices[0].key)
  error.value = '请选择账号'
  open.value = false
  assert.equal(f.destroyed.at(-1), f.notices[0].key)
  error.value = '关闭的表单错误'
  assert.equal(f.notices.length, 3)
  scope.stop()
})

test('independent form errors do not destroy or replace another form notification', () => {
  const f = fixture(), scope = vue.effectScope(), first = vue.ref(''), second = vue.ref('')
  scope.run(() => { f.feedback.useFormFeedback(first); f.feedback.useFormFeedback(second) })
  first.value = '第一处错误'; second.value = '第二处错误'
  assert.notEqual(f.notices[0].key, f.notices[1].key)
  first.value = ''
  assert.equal(f.destroyed.at(-1), f.notices[0].key)
  scope.stop()
})

test('validation reveals the first invalid field in its own form and focuses its editor', async () => {
  const f=fixture(),calls:string[]=[]
  f.document.querySelector=selector=>{
    assert.equal(selector,'.account-editor-form')
    return {querySelector:(fieldSelector:string)=>{
      assert.equal(fieldSelector,'.ant-form-item-has-error')
      return {scrollIntoView:()=>calls.push('scroll'),querySelector:()=>({focus:()=>calls.push('focus')})}
    }}
  }
  await f.feedback.focusFirstInvalidField('.account-editor-form')
  assert.deepEqual(calls,['scroll','focus'])
  f.document.querySelector=()=>null
  await f.feedback.focusFirstInvalidField('.missing-form')
  assert.deepEqual(calls,['scroll','focus'])
})

test('manager IPC failures notify once centrally and retry clears the previous notice', async () => {
  const f = fixture(), { useManager } = f.load('../src/renderer/src/store.ts')
  const instance = pinia.createPinia(), manager = useManager(instance)
  assert.equal(await manager.execute(async () => { throw new Error("Error invoking remote method 'save': Error: 地址不可用") }), false)
  assert.equal(manager.error, '地址不可用')
  assert.equal(f.notices.length, 1)
  const key = f.notices[0].key
  assert.equal(await manager.execute(async () => ({ accounts: [] })), true)
  assert.equal(manager.error, '')
  assert.equal(f.destroyed.at(-1), key)
  pinia.disposePinia(instance)
})

test('schema validation gives named, readable feedback for required fields and invalid addresses', () => {
  const f = fixture(), result = accountInputSchema.safeParse({ name: '', apiKey: '', baseUrl: 'bad-url', models: [], wireApi: 'responses' })
  assert.equal(result.success, false)
  if (result.success) return
  const errors = f.feedback.validationErrors(result.error.issues, { name: '账号名称', apiKey: 'API Key', baseUrl: 'API 地址', models: '模型' })
  assert.equal(errors.name, '请填写账号名称')
  assert.equal(errors.apiKey, '请填写API Key')
  assert.equal(errors.models, '请至少添加一个模型')
  assert.equal(errors.baseUrl, '请检查API 地址的格式')
  assert.equal(providerURLSchema.safeParse('bad-url').success, false)
})

test('numeric settings feedback describes bounds and integer format without character units', () => {
  const f=fixture(),schema=z.object({minimum:z.number().min(1),maximum:z.number().max(10),integer:z.number().int(),number:z.number()})
  const result=schema.safeParse({minimum:0,maximum:11,integer:2.5,number:'bad'})
  assert.equal(result.success,false)
  if(result.success)return
  const errors=f.feedback.validationErrors(result.error.issues,{minimum:'间隔',maximum:'并发',integer:'重试次数',number:'超时'})
  assert.equal(errors.minimum,'间隔不能小于 1');assert.equal(errors.maximum,'并发不能大于 10')
  assert.equal(errors.integer,'重试次数必须为整数');assert.equal(errors.number,'超时必须为数字')
})
