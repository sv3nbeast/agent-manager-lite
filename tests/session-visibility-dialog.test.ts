import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { ManagerAPI } from '../src/shared/types'
import type { SessionVisibilityRepairInput, SessionVisibilityRepairPreview } from '../src/shared/sessionVisibility'

const path = new URL('../src/renderer/src/components/SessionVisibilityRepairPanel.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const javascript = ts.transpileModule(compileScript(descriptor, { id: 'visibility-dialog-test' }).content,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const targetId = '14703596-5a04-48ab-bb09-22fdb1a57fa5'
const secondTargetId = 'ca2e9d4c-2476-413a-bcfb-b9958fc1c442'
const sessionId = '018edca1-44cc-7fbc-b2ef-c3aa528c80a1'
const ticket = 'bed1eec9-9417-4627-8cb1-5a11745cf0fd'
const fixturePreview = (): SessionVisibilityRepairPreview => ({ ticket, mode: 'quick', createdAt: 1, instanceCount: 1,
  changedRolloutFileCount: 1, updatedSqliteRowCount: 1, skippedSqliteFileCount: 0, runningInstanceCount: 0,
  items: [], warnings: [], message: 'fixture preview' })

function mount(overrides: Partial<ManagerAPI> = {}) {
  const requests: SessionVisibilityRepairInput[] = [], discards: string[] = [], events: string[] = []
  const sessionIds = vue.reactive([sessionId])
  const api: Partial<ManagerAPI> = {
    listSessionVisibilityRepairInstances: async () => ({ defaultInstanceId: targetId, instances: [targetId, secondTargetId].map(id =>
      ({ id, name: 'fixture instance', directory: '/fixture/home', currentProvider: 'relay', running: false, isDefault: id === targetId })) }),
    listSessionVisibilityRepairProviders: async () => ({ defaultProvider: 'relay', providers: [{ id: 'relay', sources: ['config'], isDefault: true }] }),
    // Electron invokes structured clone after receiving a renderer request.
    // Keeping that boundary here catches Vue proxies without an Electron stub
    // silently accepting data that the real application cannot send.
    previewSessionVisibilityRepair: async input => { requests.push(structuredClone(input)); return fixturePreview() },
    discardSessionVisibilityRepair: async value => { discards.push(value) },
    ...overrides
  }
  const exports = {}, context = { module: { exports }, exports, console, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { message: { success() {} } }
      : id === '../formFeedback' ? { useFormFeedback: () => {} }
      : (() => { throw new Error(`Unexpected module: ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const container = { children: [] as object[] }, vnode = vue.h(component, { open: true, sessionIds,
    'onUpdate:open': () => events.push('close'), onCompleted: () => events.push('completed') })
  renderer.render(vnode, container)
  return { state: vnode.component!.setupState as Record<string, any>, sessionIds, requests, discards, events, unmount: () => renderer.render(null, container) }
}

test('visibility preview sends plain snapshots of selected reactive targets and session IDs through IPC', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.load(); ui.state.selectedInstances = [targetId]
  assert.equal(vue.isReactive(ui.state.selectedInstances), true)
  assert.equal(vue.isReactive(ui.sessionIds), true)
  await ui.state.makePreview()
  assert.equal(ui.state.error, '')
  assert.equal(ui.state.preview.ticket, ticket)
  assert.deepEqual(ui.requests, [{ targetIds: [targetId], sessionIds: [sessionId] }])
  assert.equal(vue.isReactive(ui.requests[0].targetIds), false)
  assert.equal(vue.isReactive(ui.requests[0].sessionIds), false)
  ui.state.selectedInstances.push(secondTargetId); ui.sessionIds.length = 0
  assert.deepEqual(ui.requests[0].targetIds, [targetId])
  assert.deepEqual(ui.requests[0].sessionIds, [sessionId])
})

test('visibility preview includes all registered directories when none are explicitly selected', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.load(); ui.sessionIds.length = 0
  await ui.state.makePreview()
  assert.equal(ui.state.error, '')
  assert.deepEqual(ui.requests, [{ targetIds: [targetId, secondTargetId], sessionIds: [] }])
  await ui.state.close()
  assert.deepEqual(ui.discards, [ticket])
  assert.deepEqual(ui.events, ['close'])
})


test('an explicit provider overrides automatic matching only for that draft and changing it discards the old preview', async t => {
  const ui = mount(); t.after(ui.unmount)
  await ui.state.load()
  assert.equal(ui.state.provider, '', 'A global default provider must not override each instance connection')
  ui.state.provider = 'relay'
  await ui.state.makePreview()
  assert.equal(ui.requests[0].targetProvider, 'relay')
  ui.state.provider = ''
  assert.equal(ui.state.preview, undefined, 'An old explicit-provider preview cannot be applied after selecting automatic matching')
  assert.deepEqual(ui.discards, [ticket])
  await ui.state.makePreview()
  assert.equal(Object.hasOwn(ui.requests[1], 'targetProvider'), false)
  ui.state.provider = 'relay'; ui.state.reset(); await ui.state.load()
  assert.equal(ui.state.provider, '', 'Reopening a repair starts with automatic matching')
})

test('a slow preview is discarded when the target connection changes during preparation', async t => {
  let resolve!: (value: SessionVisibilityRepairPreview) => void
  const ui = mount({ previewSessionVisibilityRepair: () => new Promise(value => { resolve = value }) }); t.after(ui.unmount)
  await ui.state.load()
  const pending = ui.state.makePreview()
  await vue.nextTick()
  ui.state.provider = 'relay'
  resolve(fixturePreview()); await pending
  assert.equal(ui.state.preview, undefined)
  assert.deepEqual(ui.discards, [ticket])
})
