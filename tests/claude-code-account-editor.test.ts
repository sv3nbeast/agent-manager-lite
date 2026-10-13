import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as library from '../src/shared/providerLibrary'
import * as accountTypes from '../src/shared/types'
import type { Account, AccountEdit, ManagerAPI } from '../src/shared/types'
import * as feedback from '../src/renderer/src/formFeedback'
import { createAPIAccount, editAccount, readAccountKey } from '../src/main/accounts'
import { Store } from '../src/main/store'

const path = new URL('../src/renderer/src/components/AccountEditor.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
const script = compileScript(descriptor, { id: 'claude-account-editor-test' })
const javascript = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const flush = async () => { await Promise.resolve(); await vue.nextTick(); await Promise.resolve() }
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

function mount(t: { after(fn: () => void): void }, credentialKind: 'anthropic_api_key' | 'anthropic_bearer' | 'claude_ai_oauth' | 'anthropic_profile' = 'anthropic_api_key', overrides: Partial<ManagerAPI> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-editor-'))
  const store = new Store(root, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const account = createAPIAccount({ name: 'Claude fixture', baseUrl: 'https://gateway.invalid/anthropic', apiKey: 'synthetic-saved-secret',
    models: ['model-a'], wireApi: 'chat_completions', protocol: 'anthropic_messages', identityService: 'anthropic', credentialKind,
    defaultTier: 'inherit', note: '', tags: [] })
  if (credentialKind === 'claude_ai_oauth') { account.kind = 'oauth'; account.credentials = { accessToken: 'synthetic-oauth' } }
  store.transaction(state => { state.accounts.push(account) })
  const writes: AccountEdit[] = [], reads: unknown[] = []
  const manager = vue.reactive({ data: store.snapshot(), error: '', loading: false,
    async execute(action: () => Promise<any>) {
      this.loading = true
      try { this.data = await action(); return true }
      catch (error) { this.error = error instanceof Error ? error.message : 'unexpected failure'; return false }
      finally { this.loading = false }
    } })
  const props = vue.reactive({ open: true, account: manager.data.accounts[0] as Account })
  let busy = false
  const api: Partial<ManagerAPI> = {
    readAccountKey: async input => { reads.push(input); return readAccountKey(store, input) },
    editAccount: async input => { writes.push(structuredClone(input)); editAccount(store, input, () => busy); return store.snapshot() },
    fetchChatGPTModels: () => assert.fail('Claude editing must not fetch ChatGPT models'),
    fetchProviderModels: () => assert.fail('Claude editing must not probe an OpenAI model endpoint'),
    readModelContextDefaults: () => assert.fail('Claude editing must not fetch Codex context defaults'),
    ...overrides,
  }
  const exports = {}, context = { module: { exports }, exports, window: { manager: api }, console,
    require: (id: string) => id === 'vue' ? vue : id === 'ant-design-vue' ? { message: { success() {} } }
      : id === '../store' ? { useManager: () => manager } : id.endsWith('/providerLibrary') ? library
      : id === '../formFeedback' ? feedback : id.endsWith('/shared/types') ? accountTypes
      : id.endsWith('/providerUsage') ? { integrationTypeOptions: [] } : id.endsWith('.vue') ? { default: {} }
      : (() => { throw new Error(`Unexpected module ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {}, createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let vnode: vue.VNode
  const host = vue.defineComponent({ setup: () => () => {
    vnode = vue.h(component, { open: props.open, account: props.account, 'onUpdate:open': (value: boolean) => { props.open = value } })
    return vnode
  } })
  const container = { children: [] as object[] }
  renderer.render(vue.h(host), container)
  t.after(() => { renderer.render(null, container); rmSync(root, { recursive: true, force: true }) })
  return { state: vnode!.component!.setupState as Record<string, any>, props, store, manager, account, writes, reads, setBusy: (value: boolean) => { busy = value } }
}

test('Claude API and Bearer editor saves real connection changes without changing auth types or OpenAI settings', async t => {
  for (const kind of ['anthropic_api_key', 'anthropic_bearer'] as const) {
    const ui = mount(t, kind); await flush()
    assert.equal(ui.state.editableAnthropic, true)
    assert.equal(ui.state.secretLabel, kind === 'anthropic_bearer' ? 'Bearer Token' : 'API Key')
    assert.equal(ui.state.form.apiKey, 'synthetic-saved-secret')
    ui.state.form.name = 'Renamed Claude'; ui.state.form.note = 'Updated note'; ui.state.form.tags = ['work']
    ui.state.models = 'model-b,model-c'; ui.state.form.apiKey = 'synthetic-replacement'
    // Non-applicable controls are not submitted, including stale draft values.
    ui.state.form.wireApi = 'responses'; ui.state.form.integrationType = 'auto'; ui.state.form.defaultTier = 'fast'; ui.state.form.modelContextWindows = { 'model-b': 200000 }
    await ui.state.save()
    assert.deepEqual(plain(ui.writes[0].changes), { name: 'Renamed Claude', note: 'Updated note', tags: ['work'], models: ['model-b', 'model-c'], apiKey: 'synthetic-replacement' })
    const saved = ui.store.read().accounts[0]
    assert.equal(saved.credentialKind, kind)
    assert.equal(saved.protocol, 'anthropic_messages')
    assert.equal(saved.identityService, 'anthropic')
    assert.equal(saved.wireApi, 'chat_completions')
    assert.equal(saved.defaultTier, 'inherit')
    assert.equal(ui.props.open, false)
    assert.equal(ui.state.form.apiKey, '')
  }
})

test('Claude destination changes clear the saved secret and require reentry before a real backend save', async t => {
  const ui = mount(t, 'anthropic_bearer'); await flush()
  ui.state.form.baseUrl = 'https://destination.invalid/anthropic'
  assert.equal(ui.state.form.apiKey, '')
  assert.equal(ui.state.keyNeedsEntry, true)
  await ui.state.save()
  assert.equal(ui.writes.length, 0)
  assert.match(ui.state.fieldErrors.apiKey, /Bearer Token/)
  ui.state.form.apiKey = 'synthetic-saved-secret'
  await ui.state.save()
  assert.deepEqual(plain(ui.writes[0].changes), { baseUrl: 'https://destination.invalid/anthropic', apiKey: 'synthetic-saved-secret' })
  assert.equal(ui.store.read().accounts[0].baseUrl, 'https://destination.invalid/anthropic')
})

test('Claude metadata-only saves retain the existing credential and endpoint without resubmitting the key', async t => {
  const ui = mount(t); await flush()
  ui.state.form.note = 'Only a note'
  await ui.state.save()
  assert.deepEqual(plain(ui.writes[0].changes), { note: 'Only a note' })
  assert.equal(ui.store.read().accounts[0].credentials.apiKey, 'synthetic-saved-secret')
  assert.equal(ui.store.read().accounts[0].baseUrl, ui.account.baseUrl)
})

test('running and stale Claude saves retain their draft, show the backend reason and do not mutate the account', async t => {
  const running = mount(t); await flush()
  running.setBusy(true); running.state.models = 'new-model'
  await running.state.save()
  assert.equal(running.props.open, true)
  assert.match(running.manager.error, /请先停止.*实例/)
  assert.deepEqual(running.store.read().accounts[0].models, ['model-a'])
  const stale = mount(t); await flush()
  editAccount(stale.store, { id: stale.account.id, revision: 0, changes: { note: 'A concurrent edit' } })
  stale.state.form.apiKey = 'synthetic-stale'
  await stale.state.save()
  assert.equal(stale.props.open, true)
  assert.match(stale.manager.error, /已被修改/)
  assert.equal(stale.store.read().accounts[0].credentials.apiKey, 'synthetic-saved-secret')
  assert.equal(stale.store.read().accounts[0].note, 'A concurrent edit')
})

test('Claude subscription and profile drafts keep only metadata changes and never read credentials', async t => {
  for (const kind of ['claude_ai_oauth', 'anthropic_profile'] as const) {
    const ui = mount(t, kind); await flush()
    assert.equal(ui.state.editableAnthropic, false)
    assert.equal(ui.reads.length, 0)
    ui.state.form.baseUrl = 'https://must-not-save.invalid'; ui.state.form.apiKey = 'synthetic-must-not-save'; ui.state.models = 'must-not-save'
    ui.state.form.note = 'Retained for later'
    await ui.state.save()
    assert.deepEqual(plain(ui.writes[0].changes), { note: 'Retained for later' })
    assert.equal(ui.store.read().accounts[0].baseUrl, ui.account.baseUrl)
    assert.deepEqual(ui.store.read().accounts[0].credentials, ui.account.credentials)
  }
})

test('late Claude credential reads cannot refill a retargeted or closed draft', async t => {
  let resolve!: (value: string) => void
  const read = new Promise<string>(yes => { resolve = yes })
  const ui = mount(t, 'anthropic_bearer', { readAccountKey: () => read })
  ui.state.form.baseUrl = 'https://destination.invalid'
  ui.state.form.apiKey = 'synthetic-destination'
  resolve('synthetic-old-secret'); await flush()
  assert.equal(ui.state.form.apiKey, 'synthetic-destination')
  ui.state.close(); await flush()
  assert.equal(ui.state.form.apiKey, '')
  assert.equal(ui.writes.length, 0)
})
