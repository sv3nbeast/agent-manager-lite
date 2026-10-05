import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { InstanceHistorySummary } from '../src/shared/instances'

const path = new URL('../src/renderer/src/components/InstanceHistoryOverview.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'instance-history-overview-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function mount(history: InstanceHistorySummary) {
  const exports = {}, context = { module: { exports }, exports, require: (id: string) => id === 'vue' ? vue
    : id === 'ant-design-vue' ? { theme: { useToken: () => ({ token: vue.ref({ colorText: '#222', colorTextSecondary: '#777', colorBorderSecondary: '#eee', colorFillAlter: '#fafafa', colorPrimary: '#7c3aed', colorPrimaryBg: '#f8f0ff', colorWarningText: '#a60', colorWarningBg: '#fffbe6', colorFillTertiary: '#f4f4f4' }) }) } }
    : id === '@ant-design/icons-vue' ? {} : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }
  let vnode = vue.h(component, { history })
  renderer.render(vnode, container)
  const state = vnode.component!.setupState as Record<string, any>
  function update(next: InstanceHistorySummary) { vnode = vue.h(component, { history: next }); renderer.render(vnode, container) }
  return { state, update, unmount: () => renderer.render(null, container) }
}
function fixture(): InstanceHistorySummary {
  return { sessions: 105, archived: 32, unassigned: 38, issues: ['部分索引缺少会话文件'], projects: [
    { name: 'Alpha', path: '/projects/client-one', exists: true, sessions: 11 },
    { name: 'Beta', path: '/projects/API-project', exists: false, sessions: 2 },
    { name: '中文项目', path: '/projects/第三个项目', exists: true, sessions: 4 },
    { name: 'Fourth', path: '/projects/four', exists: true, sessions: 50 },
  ] }
}

test('project details search matches name or path without mutating source history or counts', t => {
  const source = fixture(), before = structuredClone(source), ui = mount(source); t.after(ui.unmount)
  ui.state.openDetails()
  ui.state.query = '  ALPHA '
  assert.deepEqual(ui.state.filteredProjects.map((project: { name: string }) => project.name), ['Alpha'])
  ui.state.query = 'api-PROJECT'
  assert.equal(ui.state.filteredProjects[0].name, 'Beta')
  assert.equal(ui.state.filteredProjects[0].exists, false)
  ui.state.query = '第三个'
  assert.equal(ui.state.filteredProjects[0].name, '中文项目')
  ui.state.query = 'not-found'
  assert.equal(ui.state.filteredProjects.length, 0)
  ui.state.query = ''
  assert.equal(ui.state.filteredProjects.length, 4)
  assert.deepEqual(source, before)
})

test('closing details returns focus; reopening starts with the full project list and keeps parent history', async t => {
  const source = fixture(), before = structuredClone(source), ui = mount(source); t.after(ui.unmount)
  let focused = 0
  ui.state.detailsButton = { focus: () => focused++ }
  ui.state.openDetails(); ui.state.query = 'Alpha'
  ui.state.closeDetails(); await vue.nextTick()
  assert.equal(ui.state.detailsOpen, false); assert.equal(focused, 1)
  ui.state.openDetails()
  assert.equal(ui.state.query, ''); assert.equal(ui.state.filteredProjects.length, 4)
  assert.deepEqual(source, before)
})

test('a changed history source closes its details and clears stale searches, including empty history', async t => {
  const ui = mount(fixture()); t.after(ui.unmount)
  ui.state.openDetails(); ui.state.query = 'Alpha'
  const empty: InstanceHistorySummary = { sessions: 0, archived: 0, unassigned: 0, projects: [], issues: [] }
  ui.update(empty); await vue.nextTick()
  assert.equal(ui.state.detailsOpen, false); assert.equal(ui.state.query, '')
  assert.equal(ui.state.filteredProjects.length, 0)
  ui.update(fixture()); await vue.nextTick()
  assert.equal(ui.state.filteredProjects.length, 4); assert.equal(ui.state.detailsOpen, false)
})
