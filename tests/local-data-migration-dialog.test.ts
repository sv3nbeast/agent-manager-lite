import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { ManagerAPI } from '../src/shared/types'
import type { LocalDataPreview, LocalDataScan } from '../src/shared/localDataMigration'

const path = new URL('../src/renderer/src/components/LocalDataMigrationDialog.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'migration-dialog-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const source: LocalDataScan = { scanId: 'scan', sources: [{ id: 'source', name: '兼容账号库', path: '/fixture/library', format: 'account_library', accounts: 1, providers: 0, groups: 0, issues: [] }] }
const preview = (ticket: string): LocalDataPreview => ({ ticket, expiresAt: Date.now() + 60_000, sources: source.sources, counts: { addedAccounts: 1, duplicateAccounts: 0, addedProviders: 0, mergedProviders: 0, addedKeys: 0, addedGroups: 0, mergedGroups: 0 }, accounts: [{ name: 'fixture account', kind: 'oauth', action: 'add' }], providers: [], warnings: [], errors: [], preservedFiles: 1, newArchive: true })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function mount(overrides: Partial<ManagerAPI> = {}) {
  const discarded: string[] = [], cancelled: string[] = [], events: { name: string; value?: unknown }[] = []
  const api: Partial<ManagerAPI> = {
    scanLocalData: async () => structuredClone(source), chooseLocalData: async () => structuredClone(source),
    previewLocalData: async () => preview('default-ticket'),
    discardLocalData: async ticket => { discarded.push(ticket) }, cancelLocalData: async id => { cancelled.push(id) },
    applyLocalData: async () => { throw new Error('unexpected automatic apply') }, ...overrides
  }
  const exports = {}
  const context = { module: { exports }, exports, require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { message: { success: () => {} } }
    : id === '../formFeedback' ? { useFormFeedback: () => {} } : id.endsWith('.vue') ? { default: {} }
    : (() => { throw new Error(`Unexpected module: ${id}`) })(), window: { manager: api }, crypto: webcrypto, setInterval, clearInterval, Date, console }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({
    patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  })
  const container = { children: [] as object[] }
  const vnode = vue.h(component, { open: true, onClose: () => events.push({ name: 'close' }), onChanged: (value: unknown) => events.push({ name: 'changed', value }) })
  renderer.render(vnode, container)
  const state = vnode.component!.setupState as Record<string, any>
  return { state, api, discarded, cancelled, events, unmount: () => renderer.render(null, container) }
}

test('scanning and previewing never apply automatically; cancel keeps late results out of the dialog', async t => {
  const late = deferred<LocalDataScan>()
  const ui = mount({ scanLocalData: () => late.promise }); t.after(ui.unmount)
  const operation = ui.state.inspect(false)
  assert.equal(ui.state.phase, 'scan')
  ui.state.cancelOperation()
  assert.equal(ui.state.phase, '')
  assert.equal(ui.cancelled.length, 1)
  late.resolve(source); await operation
  assert.equal(ui.state.scan, undefined)
  assert.equal(ui.state.preview, undefined)
  assert.equal(ui.events.length, 0)
})

test('a cancelled preview discards only its own late ticket and cannot replace a new preview', async t => {
  const late = deferred<LocalDataPreview>()
  let calls = 0
  const ui = mount({ previewLocalData: () => ++calls === 1 ? late.promise : Promise.resolve(preview('new-ticket')) }); t.after(ui.unmount)
  await ui.state.inspect(false)
  const first = ui.state.prepare()
  ui.state.cancelOperation()
  assert.equal(ui.state.scan, undefined)
  await ui.state.inspect(false); await ui.state.prepare()
  assert.equal(ui.state.preview.ticket, 'new-ticket')
  late.resolve(preview('old-ticket')); await first
  assert.equal(ui.state.preview.ticket, 'new-ticket')
  assert.ok(ui.discarded.includes('old-ticket'))
  assert.ok(!ui.discarded.includes('new-ticket'))
})

test('preview retains the originating scan request until the dialog closes', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.inspect(false); await ui.state.prepare()
  assert.equal(ui.cancelled.length, 0)
  assert.equal(ui.state.canApply, true)
  ui.state.close()
  assert.equal(ui.cancelled.length, 1)
  assert.deepEqual(ui.discarded, ['default-ticket'])
  assert.deepEqual(ui.events, [{ name: 'close' }])
})

test('errors, expired tickets and all-duplicate previews prevent confirmation', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.inspect(false); await ui.state.prepare()
  ui.state.preview = { ...preview('broken'), errors: ['无法读取来源文件'] }
  assert.equal(ui.state.canApply, false)
  await ui.state.apply()
  ui.state.preview = { ...preview('expired'), expiresAt: 0 }; ui.state.now = Date.now()
  assert.equal(ui.state.canApply, false)
  await ui.state.apply()
  ui.state.preview = { ...preview('duplicate'), newArchive: false, counts: { addedAccounts: 0, duplicateAccounts: 1, addedProviders: 0, mergedProviders: 0, addedKeys: 0, addedGroups: 0, mergedGroups: 0 } }
  assert.equal(ui.state.canApply, false)
  await ui.state.apply()
  assert.equal(ui.events.length, 0)
})

test('existing accounts remain migratable when source metadata needs a new archive or a group gains members', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.inspect(false); await ui.state.prepare()
  const duplicated = { ...preview('duplicate'), newArchive: false, counts: { addedAccounts: 0, duplicateAccounts: 1, addedProviders: 0, mergedProviders: 0, addedKeys: 0, addedGroups: 0, mergedGroups: 0 } }
  ui.state.preview = duplicated
  assert.equal(ui.state.canApply, false)
  ui.state.preview = { ...duplicated, newArchive: true }
  assert.equal(ui.state.canApply, true)
  ui.state.preview = { ...duplicated, counts: { ...duplicated.counts, mergedGroups: 1 } }
  assert.equal(ui.state.canApply, true)
})

test('confirm submits the preview ticket once, keeps atomic apply open and publishes the returned snapshot', async t => {
  const result = deferred<any>()
  const requests: unknown[] = []
  const ui = mount({ applyLocalData: input => { requests.push(input); return result.promise } }); t.after(ui.unmount)
  await ui.state.inspect(false); await ui.state.prepare()
  const operation = ui.state.apply()
  await ui.state.apply(); ui.state.close()
  assert.equal(ui.state.phase, 'apply')
  assert.equal(ui.events.length, 0)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ ticket: 'default-ticket', confirmed: true }])
  const snapshot = { accounts: [], groups: [], settings: {}, dataDirectory: '/fixture/target' }
  result.resolve({ ...preview('default-ticket').counts, snapshot }); await operation
  assert.deepEqual(ui.events, [{ name: 'changed', value: snapshot }, { name: 'close' }])
  assert.equal(ui.state.phase, '')
})
