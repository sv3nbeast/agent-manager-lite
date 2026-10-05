import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

function mount(name: string, overrides: Record<string, (...args: any[]) => Promise<any>> = {}, props: Record<string, unknown> = {}) {
  const path = new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url)
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
  const javascript = ts.transpileModule(compileScript(descriptor, { id: `feedback-${name}` }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const writes: Record<string, any>[] = []
  const manager = vue.reactive({ data: { accounts: [], sshServers: { servers: [] } }, loading: false, error: '',
    async refresh() {},
    async execute(action: () => Promise<any>) {
      this.loading = true; this.error = ''
      try { await action(); return true } catch (cause) { this.error = (cause as Error).message; return false }
      finally { this.loading = false }
    } })
  const api = { wakeupSave: async (input: Record<string, any>) => { writes.push(input); return manager.data },
    saveSshServer: async (input: Record<string, any>) => { writes.push(input); return manager.data }, ...overrides }
  const exports = {}
  const context = { module: { exports }, exports, console, JSON, structuredClone, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { message: { success() {}, warning() {} }, Modal: { confirm() {} } }
      : id === '../store' ? { useManager: () => manager } : id === '../formFeedback' ? { useFormFeedback: () => {} }
      : id === '@ant-design/icons-vue' ? {} : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module: ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({
    patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  })
  const container = { children: [] as object[] }, vnode = vue.h(component, props)
  renderer.render(vnode, container)
  return { state: vnode.component!.setupState as Record<string, any>, manager, writes, unmount: () => renderer.render(null, container) }
}

test('wakeup dialog saves the actual reactive draft and can reopen a reactive stored task', async t => {
  const ui = mount('WakeupPanel', {}, { accounts: [{ id: 'account-1' }] }); t.after(ui.unmount)
  ui.state.reset()
  assert.equal(vue.isReactive(ui.state.draft), true)
  ui.state.draft.name = '开发检查'; ui.state.draft.schedule.intervalHours = 8
  await ui.state.save()
  assert.equal(ui.writes.length, 1)
  assert.equal(vue.isReactive(ui.writes[0]), false)
  assert.equal(ui.writes[0].name, '开发检查')
  assert.deepEqual(ui.writes[0].accountIds, ['account-1'])
  assert.equal(ui.writes[0].schedule.intervalHours, 8)
  assert.equal(ui.state.open, false)
  const saved = vue.reactive({ ...ui.writes[0], id: 'task-1', revision: 4 })
  ui.state.reset(saved)
  ui.state.draft.schedule.intervalHours = 12
  assert.equal(saved.schedule.intervalHours, 8)
  await ui.state.save()
  assert.equal(ui.writes[1].id, 'task-1')
  assert.equal(ui.writes[1].revision, 4)
  assert.equal(ui.writes[1].schedule.intervalHours, 12)
})

test('wakeup validation and rejected saves keep the dialog open with an explicit error', async t => {
  const ui = mount('WakeupPanel', { wakeupSave: async () => { throw new Error('配置已经变化，请重新读取') } }, { accounts: [] }); t.after(ui.unmount)
  ui.state.reset(); await ui.state.save()
  assert.equal(ui.state.error, '至少选择一个账号')
  assert.equal(ui.writes.length, 0)
  ui.state.draft.accountIds = ['account-1']; await ui.state.save()
  assert.equal(ui.state.saveError, '配置已经变化，请重新读取')
  assert.equal(ui.state.open, true)
})

test('SSH editor copies reactive saved settings without changing the stored server', async t => {
  const ui = mount('SshServersPanel'); t.after(ui.unmount)
  const server = vue.reactive({ id: 'server-1', name: '开发机', host: 'dev.invalid', port: 22, username: 'dev', codexHome: '~/.codex', auth: { kind: 'private_key_file', path: '~/.ssh/old' }, syncOnCodexSwitch: false })
  ui.state.reset(server)
  ui.state.form.auth.path = '~/.ssh/new'
  assert.equal(server.auth.path, '~/.ssh/old')
  await ui.state.save()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0].id, 'server-1')
  assert.equal(ui.writes[0].auth.path, '~/.ssh/new')
  assert.equal(ui.state.open, false)
})

test('SSH editor keeps backend failures visible inside its still-open dialog', async t => {
  const ui = mount('SshServersPanel', { saveSshServer: async () => { throw new Error('请填写主机') } }); t.after(ui.unmount)
  ui.state.reset(); await ui.state.save()
  assert.equal(ui.state.open, true)
  assert.equal(ui.state.saveError, '请填写主机')
  assert.equal(ui.manager.error, '请填写主机')
})
