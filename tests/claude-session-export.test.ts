import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { SessionContentPage, SessionRecord } from '../src/shared/sessions'

const targetId = '00000000-0000-4000-8000-000000000001'
const record: SessionRecord = { id: 'claude:fixture', sourceSessionId: 'fixture-native-id', title: 'Title * with ticks', cwd: '/fixture/project', clientType: 'claude_code', launchMode: 'cli', kind: 'conversation', locations: [{ targetId, name: 'Fixture', directory: '/fixture', running: false, archived: false, ambiguous: false }] }
const page = (messages: SessionContentPage['messages']): SessionContentPage => ({ snapshotId: 'snapshot', sessionId: record.id, sourceSessionId: record.sourceSessionId!, title: record.title, cwd: record.cwd, sourceName: 'Fixture', clientType: 'claude_code', page: 2, pageSize: 40, total: 41, messages, warnings: [] })

function mount(content: SessionContentPage) {
  const writes: string[] = [], downloads: { href: string; download: string }[] = [], blobs = new Map<string, Blob>()
  let nextUrl = 0
  const document = { createElement: () => ({ href: '', download: '', click() { downloads.push({ href: this.href, download: this.download }) }, remove() {} }), body: { appendChild() {} } }
  const URLApi = { createObjectURL(blob: Blob) { const url = 'blob:fixture-' + (++nextUrl); blobs.set(url, blob); return url }, revokeObjectURL() {} }
  const path = new URL('../src/renderer/src/components/SessionContentPanel.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
  const script = compileScript(descriptor, { id: 'claude-session-export-test' }).content.replace('__expose();', '').replace('return __returned__', '__expose(__returned__); return __returned__')
  const javascript = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}, context = { module: { exports }, exports, console, URL: URLApi, Blob, document, navigator: { clipboard: { writeText: async (value: string) => { writes.push(value) } } }, window: { manager: { sessionContent: async () => content } }, setTimeout: (callback: () => void) => callback(), require: (id: string) => id === 'vue' ? vue : (() => { throw new Error('Unexpected module: ' + id) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }; component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const state = vue.shallowRef<any>()
  const app = renderer.createApp({ setup: () => () => vue.h(component, { snapshotId: 'snapshot', record, targetId, ref: state }) })
  app.mount({ children: [] })
  return { state: state.value as Record<string, any>, writes, downloads, blobs, unmount: () => app.unmount() }
}

test('copy and Markdown download are scoped to the current page', async t => {
  const ui = mount(page([
    { index: 40, role: 'user', blocks: [{ type: 'text', text: 'Literal <img src=\"https://fixture.invalid\"> & **plain**' }] },
    { index: 41, role: 'assistant', model: 'fixture-sonnet', blocks: [{ type: 'tool_use', name: 'Read', text: 'file_path=/fixture/file' }, { type: 'tool_result', name: 'Tool result', text: 'line one\nline two' }] },
  ]))
  t.after(ui.unmount); await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick()
  const markdown = ui.state.markdownForCurrentPage() as string
  assert.ok(markdown.includes('当前页：2 / 2（本页 2 条；共 41 条消息）'))
  assert.ok(markdown.includes('此文件仅包含当前显示页'))
  assert.ok(markdown.includes('Literal &lt;img src=\"https://fixture\\.invalid\"&gt; &amp; \\*\\*plain\\*\\*'))
  assert.ok(markdown.includes('工具调用 · Read'))
  assert.ok(markdown.includes('line one\nline two'))
  assert.equal(markdown.includes('Synthetic message 0'), false)
  await ui.state.copyCurrentPage()
  assert.deepEqual(ui.writes, [markdown])
  assert.ok(ui.state.actionFeedback.text.includes('当前页，不含其他页'))
  ui.state.saveCurrentPage()
  assert.equal(ui.downloads.length, 1)
  assert.equal(ui.downloads[0].download, 'Title - with ticks-第2页.md')
  assert.equal(await ui.blobs.get(ui.downloads[0].href)!.text(), markdown)
  assert.ok(ui.state.actionFeedback.text.includes('当前页，不含其他页'))
})

test('a zero-result page remains explicitly scoped and can be saved', async t => {
  const ui = mount({ ...page([]), page: 1, total: 0 })
  t.after(ui.unmount); await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick()
  assert.ok(ui.state.markdownForCurrentPage().includes('本页 0 条；共 0 条消息'))
  ui.state.saveCurrentPage()
  assert.equal(ui.downloads.length, 1)
  assert.ok(ui.downloads[0].download.endsWith('第1页.md'))
})
