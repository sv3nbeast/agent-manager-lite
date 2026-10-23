import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, h, nextTick, reactive, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useManager } from '../src/renderer/src/store'
import { settingsSchema, type AppSnapshot, type InstanceApplicationChoice } from '../src/shared/types'

/** Mount real component setup and Vue watchers without a browser or UI library. */
async function component(t: { after(fn: () => void): void }, name: string, initial: Record<string, unknown>, api: Record<string, unknown>, snapshot: AppSnapshot) {
  const filename = resolve('src/renderer/src/components', `${name}.vue`)
  const script = compileScript(parse(readFileSync(filename, 'utf8'), { filename }).descriptor, { id: name }).content
  const output = ts.transpileModule(script.replace('__expose();', '').replace('return __returned__', '__expose(__returned__); return __returned__'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const load = createRequire(filename), target = { exports: {} as { default: any } }
  const loadStub = (id: string) => {
    if (id === 'ant-design-vue') return { message: { success() {}, info() {}, error() {}, destroy() {} }, Modal: { confirm() {} } }
    if (id.endsWith('.vue')) return { default: { render: () => null } }
    if (id === '../formFeedback') return { ...load(id), useFormFeedback: () => () => {}, focusFirstInvalidField: async () => {} }
    return load(id)
  }
  new Function('require', 'module', 'exports', output)(loadStub, target, target.exports)
  target.exports.default.render = () => null
  const globals = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { manager: api } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } })
  const pinia = createPinia(); setActivePinia(pinia)
  const manager = useManager(); manager.data = snapshot
  const renderer = createRenderer<any, any>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setElementText() {}, setText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const props = reactive(initial), state = shallowRef<any>(), events: string[][] = [], created: string[] = []
  const app = renderer.createApp({ setup: () => () => h(target.exports.default, { ...props, ref: state, 'onUpdate:open': (value: boolean) => { props.open = value }, onImported: (ids: string[]) => events.push(ids), onCreated: (id: string) => created.push(id) }) })
  app.use(pinia); app.mount({})
  t.after(() => {
    app.unmount()
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
  })
  await nextTick()
  return { state: state.value, props, manager, events, created }
}

const accounts = [
  { id: 'codex-key', name: 'Codex API', kind: 'api_key', wireApi: 'responses', identityService: 'openai', models: ['gpt-fixture'], baseUrl: 'https://openai.invalid/v1' },
  { id: 'claude-key', name: 'Claude API', kind: 'api_key', wireApi: 'chat_completions', identityService: 'anthropic', credentialKind: 'anthropic_api_key', protocol: 'anthropic_messages', models: ['gateway-model'], baseUrl: 'https://anthropic.invalid' },
  { id: 'claude-oauth', name: 'Claude subscription', kind: 'oauth', wireApi: 'chat_completions', identityService: 'anthropic', credentialKind: 'claude_ai_oauth', protocol: 'anthropic_messages', models: ['subscription-model'], baseUrl: 'https://anthropic.invalid' },
]
function data(): AppSnapshot {
  return { settings: settingsSchema.parse({}), accounts, groups: [], providers: [], instances: [], dataDirectory: '/fixture', instanceApplications: [
    { id: 'codex-app', clientType: 'codex', kind: 'desktop', name: 'Codex', path: '/fixture/Codex.app' },
    { id: 'claude-cli', clientType: 'claude_code', kind: 'cli', name: 'Claude CLI', path: '/fixture/claude' },
    { id: 'claude-desktop', clientType: 'claude_code', kind: 'desktop', name: 'Claude Desktop', path: '/fixture/Claude.app' },
  ] } as unknown as AppSnapshot
}

test('client families share the desktop/CLI choice and switching Claude launchers clears incompatible draft fields', async t => {
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, data())
  f.state.edit(); f.state.selectClient('claude_code'); await nextTick()
  assert.deepEqual(f.state.clientOptions.map((choice: any) => ({ ...choice })), [{ value: 'codex', label: 'Codex' }, { value: 'claude_code', label: 'Claude' }])
  assert.deepEqual(f.state.client.capabilities.launchModes, ['desktop', 'cli'])
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.connectionMode, 'client_login')
  assert.equal(f.state.form.applicationId, 'claude-desktop')
  assert.equal(f.state.form.name, 'Claude Desktop 1')
  f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  assert.equal(f.state.form.launchMode, 'cli')
  assert.equal(f.state.form.connectionMode, 'native')
  assert.equal(f.state.form.accountId, 'claude-key')
  assert.equal(f.state.form.model, 'gateway-model')
  assert.equal(f.state.form.name, 'Claude Code CLI 1')
  f.state.form.name = 'My Claude'; f.state.form.workingDirectoryId = randomUUID(); f.state.args = '--verbose'; f.state.providerOpen = true
  f.state.launchMode = 'desktop'; f.state.changeLaunchMode(); await nextTick()
  assert.equal(f.state.form.name, 'My Claude')
  assert.equal(f.state.form.accountId, '')
  assert.equal(f.state.form.model, '')
  assert.equal(f.state.form.workingDirectoryId, undefined)
  assert.equal(f.state.args, '')
  assert.equal(f.state.providerOpen, false)
  assert.deepEqual(f.state.supplierChoices, [])
  f.state.closeEditor(); f.state.edit()
  assert.equal(f.state.clientSelection, 'claude_code')
  assert.equal(f.state.launchMode, 'desktop')
})

test('legacy Claude Desktop records without launchMode keep the Desktop label', async t => {
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, data())
  assert.equal(f.state.clientName('claude_code', undefined, 'client_login'), 'Claude Desktop')
  assert.equal(f.state.clientName('claude_code', undefined, 'native'), 'Claude Code CLI')
  assert.equal(f.state.clientName('claude_code', 'desktop', 'native'), 'Claude Desktop')
})

test('instance suppliers follow each key protocol and model list without assuming GPT model names', async t => {
  const snapshot = data()
  snapshot.accounts = []
  const provider = { id: randomUUID(), revision: 0, name: 'Mixed provider', baseUrl: 'https://mixed.invalid/v1', wireApi: 'responses', models: ['legacy-default'], defaultTier: 'inherit', createdAt: 1, updatedAt: 1, keys: [
    { id: randomUUID(), name: 'OpenAI key', protocol: 'openai_responses', models: ['gpt-fixture', 'claude-through-responses'], accountIds: [], createdAt: 1, updatedAt: 1 },
    { id: randomUUID(), name: 'Messages key', protocol: 'anthropic_messages', credentialKind: 'anthropic_bearer', models: ['claude-team-model', 'team-alias'], accountIds: [], createdAt: 1, updatedAt: 1 },
    { id: randomUUID(), name: 'Other OpenAI key', protocol: 'openai_chat_completions', models: ['gemini-fixture'], accountIds: [], createdAt: 1, updatedAt: 1 },
  ] }
  snapshot.providers = [provider] as AppSnapshot['providers']
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit(); f.state.resourceKind = 'provider'; f.state.resetResource(); await nextTick()
  assert.deepEqual(f.state.supplierChoices.map((choice: any) => choice.key.name), ['OpenAI key', 'Other OpenAI key'])
  assert.deepEqual(f.state.modelChoices, ['gpt-fixture', 'claude-through-responses'])
  f.state.selectSupplier(`${provider.id}:${provider.keys[2].id}`)
  assert.deepEqual(f.state.modelChoices, ['gemini-fixture'])
  assert.equal(f.state.form.model, 'gemini-fixture')
  f.manager.data!.providers![0].keys[2].models = []
  f.state.selectSupplier(`${provider.id}:${provider.keys[2].id}`)
  assert.deepEqual(f.state.modelChoices, [], 'a deliberately cleared key must not recover the supplier legacy model list')
  assert.equal(f.state.form.model, '')
  f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  assert.deepEqual(f.state.supplierChoices.map((choice: any) => choice.key.name), ['Messages key'])
  assert.equal(f.state.selectedSupplier.disabled, false)
  assert.deepEqual(f.state.modelChoices, ['claude-team-model', 'team-alias'])
  assert.equal(f.state.form.model, 'claude-team-model')
  assert.equal(f.state.form.accountId, '', 'unenabled keys stay unbound until the user continues')
})

test('inline Claude connection saves models and authentication on the key and reuses an existing endpoint', async t => {
  const snapshot = data(); snapshot.accounts = []; snapshot.providers = []
  const writes: any[] = []
  const f = await component(t, 'InstanceProviderDialog', { open: false, clientType: 'claude_code' }, {
    mutateProvider: async (input: any) => {
      writes.push(input)
      const providerId = input.action === 'create' ? randomUUID() : input.id, keyId = randomUUID(), accountId = randomUUID()
      const config = input.action === 'create' ? input.initialKey : input
      if (input.action === 'create') snapshot.providers!.push({ ...input.details, id: providerId, revision: 1, createdAt: 1, updatedAt: 1, keys: [] })
      snapshot.providers!.find(provider => provider.id === providerId)!.keys.push({ id: keyId, name: config.name, accountIds: [accountId], models: config.models, protocol: config.protocol, credentialKind: config.credentialKind, createdAt: 1, updatedAt: 1 })
      snapshot.accounts.push({ ...accounts[1], id: accountId, providerId, providerKeyId: keyId, models: config.models } as any)
      return structuredClone(snapshot)
    },
  }, snapshot)
  f.props.open = true; await nextTick()
  assert.equal(f.state.protocol, 'anthropic_messages')
  assert.equal(f.state.credentialKind, 'anthropic_api_key')
  f.state.name = 'One supplier'; f.state.baseUrl = 'https://gateway.invalid/v1/'; f.state.apiKey = 'fixture-api-key'
  await f.state.save()
  assert.equal(writes.length, 0)
  assert.match(f.state.fieldErrors.models, /至少一个模型/)
  f.state.models = ['custom-model-a']; await f.state.save(); await nextTick()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].action, 'create')
  assert.deepEqual(writes[0].details.models, [])
  assert.deepEqual(writes[0].initialKey.models, ['custom-model-a'])
  assert.equal(writes[0].initialKey.protocol, 'anthropic_messages')
  assert.equal(f.created.length, 1)
  f.props.open = true; await nextTick()
  f.state.name = 'Second key'; f.state.baseUrl = 'https://GATEWAY.invalid:443/v1'; f.state.apiKey = 'fixture-bearer'; f.state.credentialKind = 'anthropic_bearer'; f.state.models = ['custom-model-b']
  assert.equal(f.state.existingProvider?.id, snapshot.providers![0].id)
  await f.state.save(); await nextTick()
  assert.equal(writes[1].action, 'addKey')
  assert.deepEqual(writes[1].models, ['custom-model-b'])
  assert.equal(writes[1].credentialKind, 'anthropic_bearer')
  assert.equal(writes[1].createConnection, true)
  assert.equal(snapshot.providers!.length, 1)
  assert.deepEqual(snapshot.providers![0].keys.map(key => key.models), [['custom-model-a'], ['custom-model-b']])
  assert.equal(f.created.length, 2)
})

test('selecting Claude then CLI lists compatible API and subscription resources', async t => {
  const calls: unknown[] = []
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceCli: async (client?: string) => { calls.push(client); return { application: data().instanceApplications?.find(app => app.id === 'claude-cli'), snapshot: data() } },
    fetchChatGPTModels: () => assert.fail('Claude must not request ChatGPT models'),
  }, data())
  f.state.edit(); await nextTick()
  f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  assert.equal(f.state.launchMode, 'cli')
  assert.equal(f.state.form.applicationId, 'claude-cli')
  assert.equal(f.state.form.connectionMode, 'native')
  assert.equal(f.state.resourceKind, 'provider')
  assert.deepEqual(f.state.availableAccounts.map((account: { id: string }) => account.id), ['claude-key', 'claude-oauth'])
  assert.equal(f.state.form.accountId, 'claude-key')
  assert.equal(f.state.form.model, 'gateway-model')
  assert.deepEqual(f.state.modelChoices, ['gateway-model'])
  assert.equal(f.state.historyMode, 'empty')
  assert.match(f.state.modeName('native', 'claude_code'), /API/)
  await f.state.chooseCli()
  assert.deepEqual(calls, ['claude_code'])
  f.state.historyMode = 'copy'
  assert.equal(f.state.validHistorySource(), false)
  f.state.selectClient('codex'); await nextTick()
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.applicationId, 'codex-app')
  assert.equal(f.state.historyMode, 'empty')
  assert.equal(f.state.availableAccounts.some((account: { id: string }) => account.id === 'claude-key'), false)
})

test('Claude CLI separates subscription OAuth accounts from Anthropic API connections', async t => {
  const snapshot = data()
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()

  // Claude CLI starts on the provider path so an API key can be selected. The
  // account path deliberately contains only subscription identities.
  assert.equal(f.state.resourceKind, 'provider')
  f.state.resourceKind = 'account'; f.state.resetResource(); await nextTick()
  assert.deepEqual(f.state.identityAccounts.map((account: { id: string }) => account.id), ['claude-oauth'])
  assert.equal(f.state.form.accountId, 'claude-oauth')
  assert.equal(f.state.form.model, 'subscription-model')
  assert.equal(f.state.selectedAccount.credentialKind, 'claude_ai_oauth')
  assert.match(f.state.connectionDescription, /Claude CLI 使用所选订阅账号/)
  assert.equal(f.state.modeName('native', 'claude_code', 'oauth'), '订阅账号')
  assert.equal(f.state.connectionProblem, '')
  assert.equal(f.state.supplierChoices.some((choice: { label: string }) => choice.label.includes('Claude subscription')), false)
})

test('Claude Desktop can switch from client login to a selected Anthropic third-party key', async t => {
  const snapshot = data()
  snapshot.accounts = structuredClone(snapshot.accounts)
  const provider = {
    id: randomUUID(), revision: 0, name: 'Claude Desktop gateway', baseUrl: 'https://desktop-gateway.invalid',
    wireApi: 'chat_completions', models: [], defaultTier: 'inherit', createdAt: 1, updatedAt: 1,
    keys: [{ id: randomUUID(), name: 'Desktop bearer', protocol: 'anthropic_messages', credentialKind: 'anthropic_bearer', models: ['desktop-model'], accountIds: ['claude-key'], createdAt: 1, updatedAt: 1 }],
  }
  snapshot.providers = [provider] as AppSnapshot['providers']
  Object.assign(snapshot.accounts.find(account => account.id === 'claude-key')!, { providerId: provider.id, providerKeyId: provider.keys[0].id, models: ['desktop-model'] })
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit(); f.state.selectClient('claude_code'); await nextTick()
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.connectionMode, 'client_login')
  assert.equal(f.state.isClaudeDesktopLogin, true)
  assert.deepEqual(f.state.supplierChoices, [])

  f.state.form.connectionMode = 'native'; f.state.changeDesktopConnectionMode(); await nextTick()
  assert.equal(f.state.form.connectionMode, 'native')
  assert.equal(f.state.isClaudeDesktopLogin, false)
  assert.equal(f.state.resourceKind, 'provider')
  assert.equal(f.state.supplierChoices.length, 1)
  assert.equal(f.state.supplierChoices[0].key.credentialKind, 'anthropic_bearer')
  f.state.selectSupplier(f.state.supplierChoices[0].value); await nextTick()
  assert.equal(f.state.form.accountId, 'claude-key')
  assert.equal(f.state.form.model, 'desktop-model')
  assert.match(f.state.connectionDescription, /Claude Desktop.*第三方/)
  assert.match(f.state.modeName('native', 'claude_code', 'api_key'), /API/)
  assert.equal(f.state.connectionProblem, '')

  // Returning to client login clears the API resource. A Desktop subscription
  // must be performed in the official client and cannot reuse the CLI account.
  f.state.form.connectionMode = 'client_login'; f.state.changeDesktopConnectionMode(); await nextTick()
  assert.equal(f.state.isClaudeDesktopLogin, true)
  assert.equal(f.state.form.accountId, '')
  assert.equal(f.state.form.model, '')
  assert.deepEqual(f.state.supplierChoices, [])
})

test('CLI picker selects its exact result across detection order, cancellation and selecting a registered program again', async t => {
  const selected = { id: 'chosen-claude', clientType: 'claude_code' as const, kind: 'cli' as const, name: 'Chosen Claude CLI', path: '/fixture/chosen-claude' }
  const snapshot = data(); snapshot.instanceApplications!.splice(1, 0, selected)
  let choice: InstanceApplicationChoice = { application: selected, snapshot }
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceCli: async () => choice,
  }, data())
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  await f.state.chooseCli()
  assert.equal(f.state.form.applicationId, 'chosen-claude', 'explicit selection precedes the automatically detected program')
  choice = { snapshot }
  await f.state.chooseCli()
  assert.equal(f.state.form.applicationId, 'chosen-claude', 'cancel does not jump to the final detected program')
  f.state.form.applicationId = 'claude-cli'
  choice = { application: selected, snapshot }
  await f.state.chooseCli()
  assert.equal(f.state.form.applicationId, 'chosen-claude', 'an already registered program can be selected again')
})

test('a CLI picker result cannot change a draft after its client or launch mode changes', async t => {
  let resolveChoice!: (value: InstanceApplicationChoice) => void
  const pendingChoice = new Promise<InstanceApplicationChoice>(resolve => { resolveChoice = resolve })
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceCli: () => pendingChoice,
  }, data())
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  const pending = f.state.chooseCli()
  f.state.selectClient('codex'); await nextTick()
  resolveChoice({ application: data().instanceApplications?.find(app => app.id === 'claude-cli'), snapshot: data() })
  await pending
  assert.equal(f.state.form.applicationId, 'codex-app')
  assert.equal(f.state.launchMode, 'desktop')
})

test('desktop picker also retains cancellation and selects the exact previously registered application', async t => {
  const selected = { id: 'chosen-desktop', clientType: 'codex' as const, kind: 'desktop' as const, name: 'Chosen Codex', path: '/fixture/Chosen.app' }
  const snapshot = data(); snapshot.instanceApplications!.unshift(selected)
  let choice: InstanceApplicationChoice = { application: selected, snapshot }
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceApplication: async () => choice,
  }, data())
  f.state.edit(); await nextTick()
  await f.state.chooseApplication()
  assert.equal(f.state.form.applicationId, 'chosen-desktop')
  choice = { snapshot }
  await f.state.chooseApplication()
  assert.equal(f.state.form.applicationId, 'chosen-desktop')
  f.state.form.applicationId = 'codex-app'
  choice = { application: selected, snapshot }
  await f.state.chooseApplication()
  assert.equal(f.state.form.applicationId, 'chosen-desktop')
})

test('Claude Desktop wizard creates and previews a client-login instance without a managed account or model', async t => {
  const snapshot = data(), saved: any[] = [], previews: any[] = []
  snapshot.accounts = []
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    saveInstance: async (input: any) => {
      saved.push(input)
      snapshot.instances!.push({ ...input.details, id: randomUUID(), revision: 0, createdAt: 1, status: 'stopped', directory: '/fixture/claude-config', desktopDirectory: '/fixture/desktop', identityStatus: 'client_login' })
      return snapshot
    },
    previewInstanceLaunch: async (input: any) => { previews.push(input); return { ...snapshot.instances![0], instanceId: input.id, ticket: randomUUID(), identityStatus: 'client_login' } },
    fetchChatGPTModels: () => assert.fail('Desktop login must not fetch managed account models'),
    mutateProvider: () => assert.fail('Desktop login must not create a provider account'),
  }, snapshot)
  f.state.edit()
  assert.deepEqual(f.state.clientOptions.map((choice: any) => choice.label), ['Codex', 'Claude'])
  f.state.selectClient('claude_code'); f.state.launchMode = 'desktop'; f.state.changeLaunchMode(); await nextTick()
  assert.equal(f.state.clientSelection, 'claude_code')
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.applicationId, 'claude-desktop')
  assert.equal(f.state.form.name, 'Claude Desktop 1')
  assert.equal(f.state.form.connectionMode, 'client_login')
  assert.equal(f.state.form.accountId, '')
  assert.equal(f.state.form.model, '')
  assert.deepEqual(f.state.availableAccounts, [])
  assert.equal(f.state.previewNetworkLabel({ mode: 'inherit', source: 'settings' }), '管理器设置 · 继承系统网络')
  assert.equal(f.state.previewNetworkLabel({ mode: 'direct', source: 'settings' }), '管理器设置 · 直连')
  assert.equal(f.state.previewNetworkLabel({ mode: 'proxy', source: 'settings', proxy: { protocol: 'SOCKS5', server: 'proxy.invalid', port: 1080, authenticated: true, password: 'must-not-display' } }), '管理器设置 · SOCKS5 · proxy.invalid:1080 · 已配置认证')
  await f.state.nextStep(); assert.equal(f.state.step, 1)
  await f.state.nextStep(); assert.equal(f.state.step, 2)
  f.state.args = '--no-sandbox'
  await f.state.nextStep(); assert.equal(f.state.step, 2)
  assert.match(f.state.fieldErrors.extraArgs, /--disable-gpu/)
  f.state.args = '--disable-gpu'
  await f.state.nextStep(); assert.equal(f.state.step, 3)
  await f.state.save(true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].details.launchMode, 'desktop')
  assert.equal(saved[0].details.connectionMode, 'client_login')
  assert.equal(saved[0].details.accountId, '')
  assert.equal(saved[0].details.model, '')
  assert.equal(saved[0].details.workingDirectoryId, undefined)
  assert.equal(previews.length, 1)
  assert.equal(f.state.preview.identityStatus, 'client_login')
  assert.equal(f.state.identityStatusLabel(snapshot.instances![0]), '在客户端内登录')
  assert.equal(f.state.instanceAccountLabel(snapshot.instances![0]), '由 Claude Desktop 管理')
  assert.equal(snapshot.accounts.length, 0)
  f.state.edit()
  assert.equal(f.state.clientSelection, 'claude_code', 'a new draft remembers the actual launcher')
  assert.equal(f.state.form.name, 'Claude Desktop 2')
})

test('Claude Desktop needs an installed desktop application and editing cannot switch launchers', async t => {
  const snapshot = data()
  snapshot.instanceApplications = snapshot.instanceApplications!.filter(app => app.id !== 'claude-desktop')
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'desktop'; f.state.changeLaunchMode(); await nextTick()
  assert.equal(f.state.form.applicationId, '')
  await f.state.nextStep()
  assert.equal(f.state.step, 0)
  assert.match(f.state.fieldErrors.applicationId, /已安装/)
  const instance = { id: randomUUID(), revision: 0, clientType: 'claude_code', launchMode: 'desktop', connectionMode: 'client_login', accountId: '', model: '', name: 'Existing desktop', applicationId: 'claude-desktop', extraArgs: [], defaultTier: 'inherit', status: 'stopped' }
  f.state.edit(instance)
  f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode()
  assert.equal(f.state.clientSelection, 'claude_code')
  f.state.launchMode = 'cli'; f.state.changeLaunchMode()
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.launchMode, 'desktop')
  assert.equal(f.state.form.connectionMode, 'client_login')
  assert.equal(await f.state.ensureResource(), true)
})

test('editing a Codex instance preserves its existing desktop to CLI switch', async t => {
  const snapshot = data()
  snapshot.instanceApplications!.push({ id: 'codex-cli', clientType: 'codex', kind: 'cli', name: 'Codex CLI', path: '/fixture/codex' })
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit({ id: randomUUID(), revision: 0, clientType: 'codex', launchMode: 'desktop', connectionMode: 'local_api', accountId: 'codex-key', model: 'gpt-fixture', name: 'Codex existing', applicationId: 'codex-app', extraArgs: [], defaultTier: 'inherit', status: 'stopped' })
  f.state.launchMode = 'cli'; f.state.changeLaunchMode()
  assert.equal(f.state.form.applicationId, 'codex-cli')
  assert.equal(f.state.form.launchMode, 'cli')
  assert.equal(f.state.form.accountId, 'codex-key')
  assert.equal(f.state.form.model, 'gpt-fixture')
})

test('legacy Claude instances retain the saved login boundary without an installed application', async t => {
  const snapshot = data(); snapshot.instanceApplications = []
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
  }, snapshot)
  f.state.edit({ id: randomUUID(), revision: 0, clientType: 'claude_code', connectionMode: 'native', accountId: 'claude-key', model: 'gateway-model', name: 'Legacy CLI', applicationId: 'removed-cli', extraArgs: [], defaultTier: 'inherit', status: 'stopped' })
  assert.equal(f.state.launchMode, 'cli')
  assert.equal(f.state.form.connectionMode, 'native')
  f.state.launchMode = 'desktop'; f.state.changeLaunchMode()
  assert.equal(f.state.launchMode, 'cli')
  assert.equal(f.state.form.launchMode, 'cli')
  assert.equal(f.state.form.accountId, 'claude-key')
  f.state.edit({ id: randomUUID(), revision: 0, clientType: 'claude_code', connectionMode: 'client_login', accountId: '', model: '', name: 'Desktop login', applicationId: 'removed-desktop', extraArgs: [], defaultTier: 'inherit', status: 'stopped' })
  assert.equal(f.state.launchMode, 'desktop')
  f.state.launchMode = 'cli'; f.state.changeLaunchMode()
  assert.equal(f.state.launchMode, 'desktop')
  assert.equal(f.state.form.launchMode, 'desktop')
  assert.equal(f.state.form.accountId, '')
})

test('Claude Desktop picker passes its client and a late result cannot replace a CLI draft', async t => {
  const calls: string[] = []
  let resolveChoice!: (choice: InstanceApplicationChoice) => void
  const selected = { id: 'picked-claude-desktop', clientType: 'claude_code' as const, kind: 'desktop' as const, name: 'Picked Claude Desktop', path: '/fixture/Picked Claude.app' }
  const snapshot = data(); snapshot.instanceApplications!.push(selected)
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceApplication: (client: string) => { calls.push(client); return new Promise(resolve => { resolveChoice = resolve }) },
  }, data())
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'desktop'; f.state.changeLaunchMode()
  const pending = f.state.chooseApplication()
  f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode(); await nextTick()
  resolveChoice({ application: selected, snapshot }); await pending
  assert.deepEqual(calls, ['claude_code'])
  assert.equal(f.state.form.applicationId, 'claude-cli')
  assert.equal(f.state.form.connectionMode, 'native')
  assert.equal(f.state.form.accountId, 'claude-key')
  const selectedAgain = f.state.chooseApplication()
  f.state.closeEditor(); f.state.edit(); await nextTick()
  resolveChoice({ application: selected, snapshot }); await selectedAgain
  assert.equal(f.state.form.applicationId, 'claude-cli', 'closing and reopening also expires a picker request')
})

test('a late CLI project-directory picker cannot bind a directory to a Desktop draft', async t => {
  let choose!: (value: any) => void
  const target = { id: randomUUID(), path: '/fixture/project', device: 1, inode: 2 }
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [target], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    chooseInstanceWorkingDirectory: () => new Promise(resolve => { choose = resolve }),
  }, data())
  f.state.edit(); f.state.selectClient('claude_code'); f.state.launchMode = 'cli'; f.state.changeLaunchMode()
  const pending = f.state.chooseWorkingDirectory()
  f.state.selectClient('claude_code'); f.state.launchMode = 'desktop'; f.state.changeLaunchMode(); choose(target); await pending
  assert.equal(f.state.form.workingDirectoryId, undefined)
  assert.equal(f.state.clientSelection, 'claude_code')
})

test('Desktop login callback input clears on success or close and stale errors do not contaminate another instance', async t => {
  const calls: any[] = []
  let rejectCallback: ((reason: Error) => void) | undefined
  const f = await component(t, 'InstancesView', {}, {
    listInstanceWorkingDirectories: async () => [], readInstanceModelDefaults: async () => ({ models: [], defaultModelId: null }),
    completeClaudeDesktopLogin: async (input: any) => { calls.push(input); if (calls.length > 1) return new Promise((_resolve, reject) => { rejectCallback = reject }) },
  }, data())
  const first = { id: randomUUID(), clientType: 'claude_code', connectionMode: 'client_login', status: 'running' }
  const second = { ...first, id: randomUUID() }
  f.state.openDesktopLogin({ ...first, status: 'stopped' })
  assert.equal(f.state.desktopLoginTarget, undefined)
  f.state.openDesktopLogin(first)
  await f.state.completeDesktopLogin()
  assert.equal(calls.length, 0)
  assert.match(f.state.desktopLoginError, /粘贴/)
  f.state.desktopLoginUrl = 'claude://login?code=synthetic-private-code'
  await f.state.completeDesktopLogin()
  assert.equal(calls[0].id, first.id)
  assert.equal(f.state.desktopLoginTarget, undefined)
  assert.equal(f.state.desktopLoginUrl, '')
  f.state.openDesktopLogin(first); f.state.desktopLoginUrl = 'claude://login?code=synthetic-private-code'
  const pending = f.state.completeDesktopLogin()
  f.state.closeDesktopLogin(); f.state.openDesktopLogin(second)
  rejectCallback!(new Error('must not show synthetic-private-code')); await pending
  assert.equal(f.state.desktopLoginTarget, second.id)
  assert.equal(f.state.desktopLoginUrl, '')
  assert.equal(f.state.desktopLoginError, '')
  assert.equal(f.state.desktopLoginBusy, false)
  f.state.desktopLoginUrl = 'claude://login?code=synthetic-private-code'
  const failed = f.state.completeDesktopLogin()
  rejectCallback!(new Error('must not show synthetic-private-code')); await failed
  assert.match(f.state.desktopLoginError, /无法将登录回调/)
  assert.equal(f.state.desktopLoginError.includes('synthetic-private-code'), false)
  f.state.closeDesktopLogin()
  assert.equal(f.state.desktopLoginUrl, '')
})

test('copying a Claude session ID calls the direct API without opening a location picker', async t => {
  const internalId = 'claude:fixture-internal-id', targetId = randomUUID()
  const row = { id: internalId, clientType: 'claude_code', sourceSessionId: 'native-claude-session-id', title: 'Claude fixture', cwd: '/fixture/project', kind: 'conversation', locations: [{ targetId, name: 'Claude fixture', directory: '/fixture/claude', running: false, archived: false, ambiguous: true }] }
  const page = { snapshotId: randomUUID(), scannedAt: 1, total: 1, page: 1, pageSize: 25, items: [row], warnings: [], sources: [{ id: targetId, name: 'Claude fixture', directory: '/fixture/claude', role: 'instance', clientType: 'claude_code', readOnly: true }] }
  const copies: unknown[] = [], opens: unknown[] = []
  const f = await component(t, 'SessionsView', {}, {
    listClientConfigs: async () => [], scanSessions: async () => page,
    cancelSessionScan: async () => {}, cancelSessionTokens: async () => {},
    copySessionId: async (input: unknown) => { copies.push(input) }, openSession: async (input: unknown) => { opens.push(input) },
  }, data())
  await f.state.reload()
  await f.state.copyId(row)
  assert.deepEqual(copies, [{ snapshotId: page.snapshotId, sessionId: internalId, targetId }])
  assert.deepEqual(opens, [])
  assert.equal(f.state.choosing, undefined, 'copy must not briefly open the directory picker')
})

test('Codex session conflict UI selects a physical rollout before content and file actions', async t => {
  const targetId = randomUUID(), id = randomUUID(), versionId = 'b'.repeat(32)
  const location = { targetId, name: 'Codex copy', directory: '/fixture/codex', running: false, archived: false, ambiguous: true, versions: [
    { id: versionId, label: 'sessions/2026/rollout-one.jsonl', archived: false, updatedAt: 1 },
    { id: 'c'.repeat(32), label: 'archived_sessions/2026/rollout-two.jsonl', archived: true, updatedAt: 2 },
  ] }
  const row = { id, clientType: 'codex', title: 'A conflicted session', cwd: '/fixture/project', kind: 'conversation', locations: [location], capabilities: { content: true } }
  const page = { snapshotId: randomUUID(), scannedAt: 1, total: 1, page: 1, pageSize: 25, items: [row], warnings: [], sources: [{ id: targetId, name: 'Codex copy', directory: location.directory, role: 'instance', clientType: 'codex' }] }
  const opens: any[] = []
  const f = await component(t, 'SessionsView', {}, {
    listClientConfigs: async () => [], scanSessions: async () => page, cancelSessionScan: async () => {}, cancelSessionTokens: async () => {},
    openSession: async (input: any) => { opens.push(input) },
  }, data())
  await f.state.reload()
  f.state.open(row, 'content')
  assert.equal(f.state.choosing.action, 'content')
  f.state.selectedVersion = versionId
  await f.state.confirmOpen(); await nextTick()
  assert.equal(f.state.reader.versionId, versionId)
  assert.equal(f.state.reader.targetId, targetId)
  f.state.reader = undefined; f.state.open(row, 'file')
  f.state.selectedVersion = versionId
  await f.state.confirmOpen(); await nextTick()
  assert.deepEqual(opens.at(-1), { snapshotId: page.snapshotId, sessionId: id, targetId, action: 'file', versionId })
  f.state.open(row, 'location'); await f.state.confirmOpen(); await nextTick()
  assert.deepEqual(opens.at(-1), { snapshotId: page.snapshotId, sessionId: id, targetId, action: 'location', versionId: undefined })
  f.state.selectRows([id]);assert.deepEqual(f.state.selectedIds,[id],'conflict sessions remain selectable as sync sources; destructive bulk operations filter them separately')
})

test('Codex and Claude session rows expose the same transcript viewer entry point', async t => {
  const codexId=randomUUID(),claudeId='claude:'+randomUUID(),codexTarget=randomUUID(),claudeTarget=randomUUID(),snapshotId=randomUUID()
  const page={snapshotId,scannedAt:1,total:2,page:1,pageSize:25,items:[
    {id:codexId,clientType:'codex',title:'Codex fixture',cwd:'/fixture/codex',kind:'conversation',locations:[{targetId:codexTarget,name:'Codex fixture',directory:'/fixture/codex',running:false,archived:false,ambiguous:false}],capabilities:{content:true}},
    {id:claudeId,clientType:'claude_code',title:'Claude fixture',cwd:'/fixture/claude',kind:'conversation',locations:[{targetId:claudeTarget,name:'Claude fixture',directory:'/fixture/claude',running:false,archived:false,ambiguous:false}],capabilities:{content:true}},
  ],warnings:[],sources:[
    {id:codexTarget,name:'Codex fixture',directory:'/fixture/codex',role:'instance',clientType:'codex'},
    {id:claudeTarget,name:'Claude fixture',directory:'/fixture/claude',role:'instance',clientType:'claude_code',readOnly:true},
  ]}
  const f=await component(t,'SessionsView',{}, {listClientConfigs:async()=>[],scanSessions:async()=>page,cancelSessionScan:async()=>{},cancelSessionTokens:async()=>{}},data())
  await f.state.reload()
  assert.equal(f.state.knownRecords[codexId].capabilities.content,true)
  assert.equal(f.state.knownRecords[claudeId].capabilities.content,true)
  f.state.open(f.state.knownRecords[codexId],'content');assert.equal(f.state.reader.record.id,codexId);assert.equal(f.state.reader.targetId,codexTarget)
  f.state.reader=undefined;f.state.open(f.state.knownRecords[claudeId],'content');assert.equal(f.state.reader.record.id,claudeId);assert.equal(f.state.reader.targetId,claudeTarget)
})

test('Claude session source capabilities remain visible while refreshing and after a failed refresh', async t => {
  const page = { snapshotId: 'fixture-snapshot', scannedAt: 1, total: 0, page: 1, pageSize: 25, items: [], warnings: [], sources: [
    { id: 'claude-source', name: 'Claude fixture', directory: '/fixture/claude', role: 'instance', clientType: 'claude_code', readOnly: true },
  ] }
  let fail = false, rejectScan!: (error: Error) => void
  const pendingScan = new Promise((_resolve, reject) => { rejectScan = reject })
  const f = await component(t, 'SessionsView', {}, {
    listClientConfigs: async () => [], scanSessions: async () => fail ? pendingScan : page,
    cancelSessionScan: async () => {}, cancelSessionTokens: async () => {},
  }, data())
  await f.state.reload()
  f.state.targetId = 'claude-source'; await nextTick()
  assert.equal(f.state.claudeOnly, true)
  fail = true
  const pending = f.state.reload()
  assert.equal(f.state.result, undefined)
  assert.equal(f.state.claudeOnly, true, 'clearing the result must not expose Codex mutation controls')
  rejectScan(new Error('fixture refresh failure'))
  await pending
  assert.equal(f.state.claudeOnly, true)
  assert.match(f.state.error, /fixture refresh failure/)
})

for (const name of ['SessionTransferPanel', 'SessionArchivePanel', 'SessionSyncPanel', 'SessionTrashPanel']) {
  test(`${name} keeps Codex application selection exact and preserves a preview when the picker is cancelled`, async t => {
    const cli = { id: 'chosen-codex-cli', kind: 'cli' as const, name: 'Codex CLI', path: '/fixture/codex' }
    const snapshot = data(); snapshot.instanceApplications!.unshift(cli)
    let choice: InstanceApplicationChoice = { application: cli, snapshot }
    const f = await component(t, name, { targets: [], snapshotId: 'fixture', selectedIds: [], reading: false }, {
      load: async () => snapshot, chooseInstanceCli: async () => choice,
      sessionTransferState: async () => ({ recoveries: [] }), discardSessionCopy: async () => {},
      sessionSyncState: async () => ({ recoveries: [] }), discardSessionSync: async () => {},
      sessionTrashState: async () => ({ recoveries: [] }), discardSessionTrash: async () => {},
      sessionArchiveState: async () => undefined, discardSessionArchive: async () => {},
    }, snapshot)
    if (name === 'SessionSyncPanel') await f.state.begin()
    if (name === 'SessionTrashPanel') await f.state.begin('trash')
    await nextTick()
    assert.equal(f.state.applications.some((app: { clientType?: string }) => app.clientType === 'claude_code'), false)
    await f.state.choose('cli')
    assert.equal(f.state.applicationId, cli.id)
    assert.equal(f.state.applications.some((app: { clientType?: string }) => app.clientType === 'claude_code'), false)
    const previewProperty = name === 'SessionArchivePanel' ? 'importPreview' : 'preview'
    f.state[previewProperty] = { ticket: 'keep-this-preview' }
    choice = { snapshot }
    await f.state.choose('cli')
    assert.equal(f.state.applicationId, cli.id)
    assert.equal(f.state[previewProperty].ticket, 'keep-this-preview')
  })
}

test('temporary Codex login selects a registered application explicitly and cancellation keeps it selected', async t => {
  const selected = { id: 'chosen-login-app', clientType: 'codex' as const, kind: 'desktop' as const, name: 'Codex Login', path: '/fixture/Login.app', supportsTempLogin: true }
  const snapshot = data(); snapshot.instanceApplications!.unshift(selected)
  snapshot.instanceApplications!.find(app => app.id === 'codex-app')!.supportsTempLogin = true
  let choice: InstanceApplicationChoice = { application: selected, snapshot }
  const f = await component(t, 'TempLoginPanel', { disabled: false }, { chooseInstanceApplication: async () => choice }, snapshot)
  f.state.applicationId = 'codex-app'
  await f.state.choose()
  assert.equal(f.state.applicationId, selected.id)
  assert.equal(f.state.applications.some((app: { clientType?: string }) => app.clientType === 'claude_code'), false)
  choice = { snapshot: data() }
  await f.state.choose()
  assert.equal(f.state.applicationId, selected.id)
  assert.equal(f.state.actionError, '')
})

test('Claude API form stages explicit Bearer credentials and commits into the shared account store', async t => {
  const staged: { text: string; client: string }[] = [], commits: string[] = []
  const f = await component(t, 'LoginCredentialsPanel', { active: true, mode: 'api', clientType: 'claude_code' }, {
    stageImport: async (text: string, client: string) => { staged.push({ text, client }); return { ticket: 'fixture-ticket', preview: { entries: [{ index: 0, name: 'Gateway', kind: 'api_key' }], errors: [] } } },
    commitImport: async (ticket: string) => { commits.push(ticket); return { snapshot: data(), added: 1, duplicates: 0, accountIds: ['claude-key'] } }, discardImport: async () => {},
  }, data())
  f.state.apiName = 'Gateway'; f.state.apiBaseUrl = 'https://gateway.invalid'; f.state.apiSecret = 'fixture-bearer'; f.state.apiModels = ['gateway-model']; f.state.apiCredentialKind = 'bearer'
  await f.state.inspect(false)
  assert.equal(staged[0].client, 'claude_code')
  assert.deepEqual(JSON.parse(staged[0].text), { identityService: 'anthropic', name: 'Gateway', baseUrl: 'https://gateway.invalid', models: ['gateway-model'], ANTHROPIC_AUTH_TOKEN: 'fixture-bearer' })
  assert.equal(f.state.canConfirm, true)
  await f.state.confirm()
  assert.deepEqual(commits, ['fixture-ticket'])
  assert.deepEqual(f.events, [['claude-key']])
  assert.equal(f.state.apiSecret, '')
})

test('Claude forms require declared models and block OAuth imports; changing client clears the preview', async t => {
  const discarded: string[] = []
  const f = await component(t, 'LoginCredentialsPanel', { active: true, mode: 'api', clientType: 'claude_code' }, {
    stageImport: async () => ({ ticket: 'oauth-ticket', preview: { entries: [{ index: 0, name: 'Subscription', kind: 'oauth' }], errors: [] } }), discardImport: async (ticket: string) => { discarded.push(ticket) },
  }, data())
  f.state.apiName = 'Gateway'; f.state.apiSecret = 'fixture-key'
  await f.state.inspect(false)
  assert.ok(f.state.fieldErrors.models)
  assert.equal(f.state.staged, undefined)
  f.props.mode = 'json'; await nextTick(); f.state.raw = '{"CLAUDE_CODE_OAUTH_TOKEN":"fixture"}'
  await f.state.inspect(false)
  assert.equal(f.state.unsupportedImport, true)
  assert.equal(f.state.canConfirm, false)
  f.props.clientType = 'codex'; await nextTick()
  assert.deepEqual(discarded, ['oauth-ticket'])
  assert.equal(f.state.staged, undefined)
  assert.equal(f.state.raw, '')
})

test('an import preview arriving after switching clients is discarded', async t => {
  let resolvePreview!: (value: unknown) => void
  const deferred = new Promise(resolve => { resolvePreview = resolve })
  const discarded: string[] = []
  const f = await component(t, 'LoginCredentialsPanel', { active: true, mode: 'json', clientType: 'claude_code' }, {
    stageImport: () => deferred, discardImport: async (ticket: string) => { discarded.push(ticket) },
  }, data())
  f.state.raw = '{"ANTHROPIC_API_KEY":"fixture-key"}'
  const pending = f.state.inspect(false)
  f.props.clientType = 'codex'; await nextTick()
  resolvePreview({ ticket: 'late-claude-ticket', preview: { entries: [{ index: 0, name: 'Claude', kind: 'api_key' }], errors: [] } })
  await pending
  assert.equal(f.state.staged, undefined)
  assert.equal(f.state.canConfirm, false)
  assert.deepEqual(discarded, ['late-claude-ticket'])
})
