import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const script = compileScript(descriptor, { id: 'instances-context-labels-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function mount() {
  const account: Account = { id: 'fixture-account', kind: 'api_key', name: 'API connection', providerId: 'fixture-provider', baseUrl: 'https://fixture.invalid/v1', models: ['normal', 'constructor'], modelContextWindows: { normal: 512000 }, wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: 1 }
  const manager = vue.reactive({ data: { accounts: [account], providers: [{ id: 'fixture-provider', modelContextWindows: { normal: 400000 }, keys: [] }], instances: [], instanceApplications: [] }, error: '', loading: false })
  const exports = {}, context = { module: { exports }, exports, window: { manager: { listInstanceWorkingDirectories: async () => [] } },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { Modal: {}, message: {} } : id === '@ant-design/icons-vue' ? {}
      : id.endsWith('/agentClients') ? clients : id.endsWith('/instances') ? instances : id.endsWith('/modelContextWindows') ? windows
      : id === '../formFeedback' ? { validationErrors, useFormFeedback: () => () => {} }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }; component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }, vnode = vue.h(component)
  renderer.render(vnode, container)
  return { manager, state: vnode.component!.setupState as Record<string, any>, unmount: () => renderer.render(null, container) }
}

test('instance context summary and launch preview name connection overrides correctly', async t => {
  const ui = mount(); t.after(ui.unmount)
  ui.state.form.accountId = 'fixture-account'; ui.state.form.model = 'normal'
  await vue.nextTick()
  assert.equal(ui.state.contextLabel, '512K · API 连接设置')
  assert.equal(ui.state.contextSourceName('connection'), 'API 连接设置')
  ui.manager.data.accounts[0].modelContextWindows = undefined
  await vue.nextTick()
  assert.equal(ui.state.contextLabel, '400K · 供应商设置')
  ui.state.form.model = 'constructor'
  await vue.nextTick()
  ui.state.contextDefault = { modelId: 'constructor', contextWindow: 272000, source: 'template' }
  await vue.nextTick()
  assert.equal(ui.state.contextLabel, '272K · 模板默认值', 'Object prototype properties must never appear as windows')
  assert.equal(ui.state.contextSourceName('provider'), '供应商设置')
  assert.equal(ui.state.contextSourceName('config'), '实例配置')
  assert.equal(ui.state.contextSourceName('catalog'), '模型目录')
})
