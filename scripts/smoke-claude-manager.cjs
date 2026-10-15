// Real Electron renderer/IPC with a process-local test vault and synthetic
// Claude accounts/transcripts. Preview only: no Terminal or model turn starts.
const { app, safeStorage, dialog, ipcMain, shell, clipboard, session } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename, isAbsolute } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const assert = require('node:assert/strict')

const configuredDirectory = process.env.CML_TEST_DATA_DIR
assert.ok(configuredDirectory && fs.realpathSync(configuredDirectory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(configuredDirectory).startsWith('codex-manager-ui-'))
const directory = fs.realpathSync(configuredDirectory)
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
const evidence = process.env.CML_CLAUDE_EVIDENCE_DIR
assert.ok(evidence && isAbsolute(evidence), 'Set CML_CLAUDE_EVIDENCE_DIR to an absolute private evidence directory')
assert.equal(resolve(evidence).includes(sep + 'docs' + sep + 'evidence'), false)
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
fs.rmSync(join(evidence, 'validation.json'), { force: true })
fs.rmSync(join(evidence, 'claude-ui-failure.png'), { force: true })
fs.rmSync(join(evidence, 'claude-ui-failure.json'), { force: true })
require('./test-vault.cjs').installTestVault(safeStorage)
const subscriptionAccountId = randomUUID()
const subscriptionAccount = {
  id: subscriptionAccountId,
  kind: 'oauth',
  identityService: 'anthropic',
  credentialKind: 'claude_ai_oauth',
  protocol: 'anthropic_messages',
  name: 'Synthetic Claude 订阅',
  email: 'synthetic-claude@example.invalid',
  plan: 'synthetic',
  baseUrl: 'https://api.anthropic.com',
  models: ['claude-subscription-fixture'],
  wireApi: 'chat_completions',
  defaultTier: 'inherit',
  note: 'Synthetic UI smoke account; never reaches the network',
  tags: ['synthetic'],
  createdAt: Date.now(),
  generation: randomUUID(),
  credentials: {
    accessToken: 'synthetic-claude-access-token',
    refreshToken: 'synthetic-claude-refresh-token',
    accountId: 'synthetic-claude-account',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
    scope: 'user:profile user:inference',
  },
  claudeSubscription: { accountId: 'synthetic-claude-account', organizationId: 'synthetic-claude-org', scopes: ['user:profile', 'user:inference'] },
}
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({
  version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], accounts: [subscriptionAccount],
})), { mode: 0o600 })

// The preview validates a real native executable header, but the fixture must
// never run. A copied OS no-op keeps this smoke independent of a Claude install.
const executable = join(directory, 'fixture-claude')
fs.copyFileSync(fs.realpathSync('/usr/bin/true'), executable)
fs.chmodSync(executable, 0o700)
// An installed bundle may be registered read-only for the same preview test.
// startInstance is always rejected below; its real profile is never opened.
const installedDesktop = process.env.CML_CLAUDE_DESKTOP_APPLICATION
const desktopApplication = installedDesktop ? fs.realpathSync(installedDesktop) : join(directory, 'Fixture Claude.app')
if (!installedDesktop) {
  fs.mkdirSync(join(desktopApplication, 'Contents', 'MacOS'), { recursive: true })
  fs.copyFileSync(fs.realpathSync('/usr/bin/true'), join(desktopApplication, 'Contents', 'MacOS', 'Claude'))
  fs.chmodSync(join(desktopApplication, 'Contents', 'MacOS', 'Claude'), 0o700)
  fs.writeFileSync(join(desktopApplication, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>Claude</string><key>CFBundleShortVersionString</key><string>2.31226.1</string></dict></plist>', { mode: 0o600 })
  const desktopArchiveSource = join(directory, 'desktop-archive-source')
  fs.mkdirSync(desktopArchiveSource)
  fs.mkdirSync(join(desktopApplication, 'Contents', 'Resources'))
  fs.writeFileSync(join(desktopArchiveSource, 'package.json'), JSON.stringify({ name: '@ant/desktop', version: '0.0.0', main: 'main.js' }))
  const gatewayKeys = ['inferenceProvider', 'inferenceCredentialKind', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey', 'inferenceGatewayAuthScheme', 'inferenceModels', 'modelDiscoveryEnabled', 'disableDeploymentModeChooser']
  const gatewayEntries = gatewayKeys.map(key => `{flatKey:${JSON.stringify(key)},appBehaviorOnly:false,support:{enabled:{scopes:["1p","3p"]}}}`).join(',')
  fs.writeFileSync(join(desktopArchiveSource, 'main.js'), `module.exports=[${gatewayEntries}];\n// Native contract markers: configLibrary _meta.json appliedId deploymentMode claude_desktop_config.json -3p\n`)
  require('node:child_process').execFileSync(process.execPath, [require.resolve('@electron/asar/bin/asar.js'), 'pack', desktopArchiveSource, join(desktopApplication, 'Contents', 'Resources', 'app.asar')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, stdio: 'pipe' })
}
let cancelNextPicker = false
dialog.showOpenDialog = async (_window, options) => {
  assert.match(options.title, /Claude (?:CLI|Desktop)/)
  if (cancelNextPicker) { cancelNextPicker = false; return { canceled: true, filePaths: [] } }
  return { canceled: false, filePaths: [options.title.includes('Desktop') ? desktopApplication : executable] }
}
dialog.showErrorBox = (title) => { console.error('Unexpected native error dialog:', title); app.exit(1) }
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })

const networkAttempts = []
const denyNetwork = kind => { networkAttempts.push(kind); throw new Error('Claude smoke forbids network requests') }
globalThis.fetch = async () => denyNetwork('fetch')
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol)
  transport.request = () => denyNetwork(protocol + '.request')
  transport.get = () => denyNetwork(protocol + '.get')
}
const { MockAgent, setGlobalDispatcher } = require('undici')
const networkGuard = new MockAgent()
networkGuard.disableNetConnect()
setGlobalDispatcher(networkGuard)
require('node:diagnostics_channel').channel('undici:request:create').subscribe(() => { networkAttempts.push('undici') })
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    networkAttempts.push('renderer-http'); callback({ cancel: true })
  })
})
const opened = [], pickerOutcomes = []
let copiedId = '', lastPage, lastPreview
const stagedImports = { started: 0, completed: 0, failed: 0 }
const modelSelections = []
shell.openPath = async path => { opened.push({ action: 'file', path }); return '' }
shell.showItemInFolder = path => { opened.push({ action: 'location', path }) }
clipboard.writeText = value => { copiedId = value }
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
  if (channel === 'manager:invoke') {
    assert.notEqual(args[0], 'startInstance', 'UI smoke must never launch a real CLI or Terminal')
    if (args[0] === 'stageImport') stagedImports.started++
    let value
    try {
      value = await listener(event, ...args)
      if (args[0] === 'stageImport') stagedImports.completed++
    } catch (error) {
      if (args[0] === 'stageImport') stagedImports.failed++
      throw error
    }
    if (args[0] === 'scanSessions') lastPage = value
    if (args[0] === 'previewInstanceLaunch') lastPreview = value
    if (args[0] === 'chooseInstanceCli' || args[0] === 'chooseInstanceApplication') pickerOutcomes.push(value)
    return value
  }
  return listener(event, ...args)
})

const timer = setTimeout(() => { console.error('Claude Manager UI smoke exceeded 80 seconds'); app.exit(1) }, 80_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.setContentSize(1440, 1040)
  window.webContents.once('did-finish-load', async () => {
    let waitingFor = ''
    const run = code => window.webContents.executeJavaScript('(async()=>(' + code + '))()')
    const visible = selector => 'Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden")'
    const wait = async (expression, rejectIf = 'false') => {
      waitingFor = expression
      const deadline = Date.now() + 10_000
      for (;;) {
        const state = await run('({ready:!!(' + expression + '),rejected:!!(' + rejectIf + ')})')
        assert.equal(state.rejected, false, 'UI validation rejected: ' + expression)
        if (state.ready) return
        assert.ok(Date.now() < deadline, 'UI timeout: ' + expression)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const click = async (selector, text) => {
      const expression = visible(selector) + '.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,"")===' + JSON.stringify(text.replace(/\s/g, '')) + ')'
      await wait('!!(' + expression + ')')
      await run('(' + expression + ').click()')
    }
    const clickElement = async selector => {
      await wait(visible(selector) + '.length>0')
      await run('(' + visible(selector) + ')[0].click()')
    }
    const fill = async (selector, value) => {
      await wait('!!document.querySelector(' + JSON.stringify(selector) + ')')
      await run('(()=>{let el=document.querySelector(' + JSON.stringify(selector) + ');if(!(el instanceof HTMLInputElement)&&!(el instanceof HTMLTextAreaElement))el=el.querySelector("input");const prototype=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));el.focus()})()')
    }
    const options = async label => {
      const controls = await run('(()=>{const el=document.querySelector(' + JSON.stringify('[aria-label="' + label + '"]') + ').closest(".ant-select");el.querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return el.querySelector("input").getAttribute("aria-controls")})()')
      const expression = 'Array.from(document.getElementById(' + JSON.stringify(controls) + ')?.closest(".ant-select-dropdown")?.querySelectorAll(".ant-select-item-option")??[]).filter(el=>el.getClientRects().length)'
      await wait(expression + '.length>0')
      return expression
    }
    const select = async (label, text, contains = false) => {
      const choices = await options(label)
      const expression = choices + '.find(el=>el.textContent' + (contains ? '.includes(' + JSON.stringify(text) + ')' : '.replace(/\\s/g,"")===' + JSON.stringify(text.replace(/\s/g, ''))) + ')'
      await wait('!!(' + expression + ')'); await run('(' + expression + ').click()')
    }
    const addTag = async (label, value) => {
      const selector = '[aria-label="' + label + '"]'
      const root = 'document.querySelector(' + JSON.stringify(selector) + ').closest(".ant-select")'
      await fill(selector, value)
      const controls = await run(root + '.querySelector("input").getAttribute("aria-controls")')
      // The hidden search-width mirror contains the typed text before a tag is
      // selected. Check the committed tag and cleared search, not parent text.
      const committed = 'Array.from(' + root + '.querySelectorAll(".ant-select-selection-item-content")).some(el=>el.textContent===' + JSON.stringify(value) + ')&&' + root + '.querySelector("input").value===""'
      const option = 'Array.from(document.getElementById(' + JSON.stringify(controls) + ')?.closest(".ant-select-dropdown")?.querySelectorAll(".ant-select-item-option-active")??[]).find(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden"&&el.querySelector(".ant-select-item-option-content")?.textContent===' + JSON.stringify(value) + ')'
      await wait('(' + committed + ')||!!(' + option + ')')
      const commitWithEnter = (label, value) => {
        const select = document.querySelector('[aria-label="' + label + '"]').closest('.ant-select')
        const input = select.querySelector('input')
        const before = { search: input.value, tags: Array.from(select.querySelectorAll('.ant-select-selection-item-content')).map(el => el.textContent), documentHasFocus: document.hasFocus() }
        let action = 'await-blur-commit'
        // Blur submits tags before its dropdown finishes closing. Clicking or
        // pressing Enter on that now-selected option would toggle it off.
        // Check and dispatch in one renderer task, without activating a window.
        if (before.tags.includes(value)) action = 'already-committed'
        else if (before.search === value) {
          for (const type of ['keydown', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
          action = 'enter'
        }
        return { label, value, action, before }
      }
      modelSelections.push(await run('(' + commitWithEnter.toString() + ')(' + JSON.stringify(label) + ',' + JSON.stringify(value) + ')'))
      await wait(committed)
      await run(root + '.querySelector("input").blur()')
      await wait(committed + '&&!' + root + '.contains(document.activeElement)')
    }
    const capture = async name => {
      if (name !== 'claude-ui-failure.png') await wait(visible('.ant-message-notice') + '.length===0')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      fs.writeFileSync(join(evidence, name), (await window.webContents.capturePage()).toPNG(), { mode: 0o600 })
    }
    const captureFailure = async () => {
      // Whitelist form state from this isolated synthetic vault. Never collect
      // raw DOM, IPC arguments, credential values or account/vault contents.
      const readFormState = () => {
        const form = document.querySelector('.claude-api-connection')
        const modelSelect = form?.querySelector('[aria-label="Claude 连接模型"]')?.closest('.ant-select')
        const active = document.activeElement
        return {
          documentHasFocus: document.hasFocus(),
          activeElement: { tag: active?.tagName, label: active?.getAttribute('aria-label') ?? active?.closest('[aria-label]')?.getAttribute('aria-label') },
          form: form ? {
            name: form.querySelector('[aria-label="Claude 连接名称"]')?.value,
            baseUrl: form.querySelector('[aria-label="Claude API 地址"]')?.value,
            secretPresent: !!form.querySelector('[aria-label="Claude API 凭据"]')?.value,
            selectedModels: Array.from(modelSelect?.querySelectorAll('.ant-select-selection-item-content') ?? []).map(el => el.textContent),
            modelInput: modelSelect?.querySelector('input')?.value,
          } : null,
          errors: Array.from(document.querySelectorAll('.credential-import-panel .ant-form-item-explain-error,.credential-import-panel .ant-alert-error .ant-alert-message')).map(el => el.textContent),
          previewPresent: !!document.querySelector('.credential-preview'),
        }
      }
      const diagnostic = { syntheticDataOnly: true, waitingFor, stagedImports, modelSelections, ...await run('(' + readFormState.toString() + ')()') }
      fs.writeFileSync(join(evidence, 'claude-ui-failure.json'), JSON.stringify(diagnostic, null, 2), { mode: 0o600 })
      console.error('Claude UI failure diagnostic:', JSON.stringify(diagnostic))
    }
    const vault = () => JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault'))))
    const step = async index => wait(visible('.instance-step[data-step="' + index + '"]') + '.length===1')
    const next = async index => { await click('.ant-modal-footer button', '下一步'); await step(index) }
    const model = 'claude-fixture-model'
    const create = async (name, kind) => {
      const connectionModel = kind === 'bearer' ? 'claude-bearer-fixture' : model
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      const clients = await options('实例客户端')
      assert.deepEqual(await run(clients + '.map(el=>el.textContent)'), ['Codex', 'Claude'])
      await run(clients + '.find(el=>el.textContent==="Claude").click()')
      await click('[aria-label=实例运行方式] .ant-segmented-item', 'CLI 终端')
      await wait('document.querySelector("[aria-label=实例运行方式] .ant-segmented-item-selected")?.textContent==="CLI 终端"')
      assert.equal(await run('document.querySelector("[aria-label=实例运行方式] .ant-segmented-item-selected").textContent'), 'CLI 终端')
      const choicesBeforePick = pickerOutcomes.length, chooseDeadline = Date.now() + 5000
      await click('.instance-step[data-step="0"] button', '选择 CLI 程序')
      while (pickerOutcomes.length === choicesBeforePick) { assert.ok(Date.now() < chooseDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      await wait('document.querySelector(".instance-step[data-step=\\"0\\"]").textContent.includes("fixture-claude")')
      assert.equal(pickerOutcomes.at(-1)?.application?.path, executable)
      const chosenId = pickerOutcomes.at(-1).application.id
      assert.equal(pickerOutcomes.at(-1).snapshot.instanceApplications.find(app => app.id === chosenId).path, executable)
      if (kind === 'api_key') {
        const previousPickerCount = pickerOutcomes.length, pickerDeadline = Date.now() + 5000
        cancelNextPicker = true
        await click('.instance-step[data-step="0"] button', '选择 CLI 程序')
        while (pickerOutcomes.length === previousPickerCount) { assert.ok(Date.now() < pickerDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
        assert.equal(pickerOutcomes.at(-1).application, undefined)
        await wait('document.querySelector(".instance-step[data-step=\\"0\\"]").textContent.includes("fixture-claude")')
      }
      await next(1)
      assert.equal(await run('!!document.querySelector("[aria-label=资源类型]")'), true)
      assert.equal(await run('document.querySelector("[aria-label=资源类型]").textContent.includes("供应商密钥")'), true)
      // A previously created Claude subscription is a valid default for a
      // fresh CLI wizard. Select the provider resource explicitly for these
      // API/Bearer cases so this smoke covers both resource branches instead
      // of depending on whichever account was created first.
      if (kind !== 'subscription') {
        await click('[aria-label="资源类型"] .ant-radio-wrapper', '供应商密钥')
        await wait('document.querySelector("[aria-label=资源类型]").textContent.includes("供应商密钥") && document.querySelector(".instance-add-provider")')
      }
      console.log('Claude smoke resource step', name, await run('({resource:document.querySelector("[aria-label=资源类型]")?.textContent,providerButton:!!document.querySelector(".instance-add-provider"),body:document.querySelector(".instance-step[data-step=\\"1\\"]")?.textContent.slice(0,500)})'))
      await clickElement('.instance-add-provider')
      await wait(visible('.instance-provider-dialog') + '.length===1')
      await fill('[aria-label="供应商名称"]', name + '连接')
      await fill('[aria-label="供应商地址"]', 'https://claude-fixture.invalid')
      assert.equal(await run('document.querySelector("[aria-label=密钥协议]").closest(".ant-select").textContent'), 'Anthropic Messages')
      if (kind === 'bearer') await select('密钥认证方式', 'Bearer Token')
      const secret = 'fixture-' + kind + '-not-a-real-secret'
      await fill('[aria-label="供应商密钥"]', secret)
      await addTag('密钥模型', connectionModel)
      await capture('claude-' + kind + '-connection.png')
      await run('document.querySelector(".instance-provider-dialog").closest(".ant-modal-content").querySelector(".ant-modal-footer .ant-btn-primary").click()')
      await wait(visible('.instance-provider-dialog') + '.length===0', visible('.instance-provider-dialog .ant-form-item-explain-error,.instance-provider-dialog .form-feedback-error') + '.length>0'); await step(1)
      await wait('document.querySelector("[aria-label=实例供应商密钥]").closest(".ant-select").textContent.includes(' + JSON.stringify(name + '连接') + ')')
      assert.equal(await run('document.querySelector("[aria-label=实例接入方式]").closest(".ant-select").textContent.includes("直接 API")'), true)
      await next(2)
      await fill('[aria-label="实例名称"]', name)
      assert.equal(await run('document.querySelector("[aria-label=实例模型]").value'), connectionModel)
      assert.equal(await run('!!document.querySelector("[aria-label=刷新官方模型列表]")'), false)
      assert.equal(await run('!!document.querySelector("[aria-label=实例服务等级]")'), false)
      assert.equal(await run('!!document.querySelector(".instance-history-options")'), false)
      await next(3)
      await click('.ant-modal-footer button', '创建并预览')
      await wait(visible('.instance-launch-preview') + '.length===1')
      assert.equal(lastPreview?.clientType, 'claude_code')
      assert.equal(lastPreview?.launchMode, 'cli')
      assert.equal(lastPreview?.identityStatus, 'api_configured')
      assert.equal(JSON.stringify(lastPreview).includes(secret), false)
      assert.equal(await run('document.querySelector(".instance-launch-preview").textContent.includes("API 连接已配置")'), true)
      assert.equal(await run('document.querySelector(".instance-launch-preview").textContent.includes("Fast")'), false)
      const previewText = await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").textContent')
      assert.equal(previewText.includes('从实例复制'), false)
      assert.equal(previewText.includes('停止后恢复本次启动的配置'), false)
      assert.ok(previewText.includes('停止后保留实例配置、会话和工作文件'))
      assert.ok(previewText.includes('首次启动会初始化欢迎流程'))
      assert.equal(previewText.includes('其中已归档'), false)
      await capture('claude-' + kind + '-launch-preview.png')
      await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(visible('.instance-launch-preview') + '.length===0')
      const snapshot = await run('window.manager.load()')
      const instance = snapshot.instances.find(value => value.name === name), account = snapshot.accounts.find(value => value.id === instance?.accountId)
      assert.ok(instance && account)
      assert.equal(account.identityService, 'anthropic'); assert.equal(account.protocol, 'anthropic_messages')
      assert.equal(account.credentialKind, kind === 'bearer' ? 'anthropic_bearer' : 'anthropic_api_key')
      assert.deepEqual(account.models, [connectionModel])
      assert.equal(snapshot.providers.length, 1, 'one endpoint owns both keys without duplicating the provider')
      const key = snapshot.providers[0].keys.find(item => item.id === account.providerKeyId)
      assert.ok(key && key.accountIds.includes(account.id))
      assert.deepEqual(key.models, [connectionModel])
      assert.equal(key.protocol, 'anthropic_messages')
      if (kind === 'bearer') {
        assert.equal(snapshot.providers[0].keys.length, 2)
        assert.deepEqual(snapshot.providers[0].keys.map(item => item.models), [[model], [connectionModel]])
      }
      assert.equal(instance.clientType, 'claude_code'); assert.equal(instance.connectionMode, 'native')
      assert.equal(snapshot.instanceApplications.find(value => value.id === instance.applicationId).path, executable)
      return instance
    }
    const createSubscription = async () => {
      const name = 'Claude CLI 订阅示例'
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      const clients = await options('实例客户端')
      assert.deepEqual(await run(clients + '.map(el=>el.textContent)'), ['Codex', 'Claude'])
      await run(clients + '.find(el=>el.textContent==="Claude").click()')
      await click('[aria-label=实例运行方式] .ant-segmented-item', 'CLI 终端')
      await wait('document.querySelector("[aria-label=实例运行方式] .ant-segmented-item-selected")?.textContent==="CLI 终端"')
      const beforePicker = pickerOutcomes.length, pickerDeadline = Date.now() + 5000
      await click('.instance-step[data-step="0"] button', '选择 CLI 程序')
      while (pickerOutcomes.length === beforePicker) { assert.ok(Date.now() < pickerDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      assert.equal(pickerOutcomes.at(-1)?.application?.path, executable)
      await next(1)
      await click('[aria-label="资源类型"] .ant-radio-wrapper', '订阅账号')
      await wait('document.querySelector("[aria-label=实例账号]")')
      await select('实例账号', 'Synthetic Claude 订阅', true)
      assert.equal(await run('document.querySelector("[aria-label=实例接入方式]").closest(".ant-select").textContent.includes("订阅账号")'), true)
      await next(2)
      await fill('[aria-label="实例名称"]', name)
      assert.equal(await run('document.querySelector("[aria-label=实例模型]").value'), 'claude-subscription-fixture')
      await next(3)
      await click('.ant-modal-footer button', '创建并预览')
      await wait(visible('.instance-launch-preview') + '.length===1')
      assert.equal(lastPreview?.clientType, 'claude_code')
      assert.equal(lastPreview?.launchMode, 'cli')
      assert.equal(lastPreview?.connectionMode, 'native')
      assert.equal(lastPreview?.identityStatus, 'subscription_configured')
      assert.equal(lastPreview?.accountName, 'Synthetic Claude 订阅')
      assert.equal(lastPreview?.model, 'claude-subscription-fixture')
      assert.equal(JSON.stringify(lastPreview).includes('synthetic-claude-access-token'), false)
      const previewText = await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").textContent')
      assert.ok(previewText.includes('订阅账号'))
      assert.ok(previewText.includes('Claude CLI 使用所选订阅账号'))
      await capture('claude-subscription-launch-preview.png')
      await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(visible('.instance-launch-preview') + '.length===0')
      const snapshot = await run('window.manager.load()')
      const instance = snapshot.instances.find(value => value.name === name)
      assert.ok(instance)
      assert.equal(instance.accountId, subscriptionAccountId)
      assert.equal(instance.model, 'claude-subscription-fixture')
      assert.equal(instance.connectionMode, 'native')
      return instance
    }
    const createDesktop = async () => {
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      const clients = await options('实例客户端')
      assert.deepEqual(await run(clients + '.map(el=>el.textContent)'), ['Codex', 'Claude'])
      await run(clients + '.find(el=>el.textContent==="Claude").click()')
      await click('[aria-label=实例运行方式] .ant-segmented-item', '桌面应用')
      assert.equal(await run('document.querySelector("[aria-label=实例运行方式] .ant-segmented-item-selected").textContent'), '桌面应用')
      const beforePicker = pickerOutcomes.length, pickerDeadline = Date.now() + 5000
      await click('.instance-step[data-step="0"] button', '选择应用文件')
      while (pickerOutcomes.length === beforePicker) { assert.ok(Date.now() < pickerDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      await wait('document.querySelector("[aria-label=实例应用]").closest(".ant-select").textContent.includes(' + JSON.stringify(basename(desktopApplication)) + ')')
      assert.equal(pickerOutcomes.at(-1)?.application?.path, desktopApplication)
      assert.equal(pickerOutcomes.at(-1)?.application?.clientType, 'claude_code')
      assert.equal(pickerOutcomes.at(-1)?.application?.kind, 'desktop')
      await capture('claude-desktop-client-step.png')
      await next(1)
      assert.equal(await run('!!document.querySelector("[aria-label=实例账号],[aria-label=实例供应商密钥],[aria-label=实例接入方式]")'), false)
      assert.equal(await run('document.querySelector(".instance-client-login").textContent.includes("在 Claude Desktop 中登录")'), true)
      assert.equal(await run('document.querySelector(".instance-client-login").textContent.includes("订阅登录在客户端内完成")'), true)
      await capture('claude-desktop-login-step.png')
      await next(2)
      await fill('[aria-label="实例名称"]', 'Claude Desktop 示例')
      assert.equal(await run('!!document.querySelector("[aria-label=实例模型],[aria-label=实例工作目录],[aria-label=实例服务等级]")'), false)
      assert.equal(await run('document.querySelector(".instance-history-retained").textContent.includes("暂不展示 Desktop")'), true)
      await next(3)
      await click('.ant-modal-footer button', '创建并预览')
      await wait(visible('.instance-launch-preview') + '.length===1')
      assert.equal(lastPreview?.clientType, 'claude_code')
      assert.equal(lastPreview?.launchMode, 'desktop')
      assert.equal(lastPreview?.connectionMode, 'client_login')
      assert.equal(lastPreview?.identityStatus, 'client_login')
      assert.equal(lastPreview?.model, '')
      assert.equal(lastPreview?.history, undefined)
      const previewText = await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").textContent')
      assert.ok(previewText.includes('在客户端内登录'))
      assert.ok(previewText.includes('云端历史仍由 Claude 同步'))
      assert.equal(previewText.includes('API 连接已配置'), false)
      assert.equal(previewText.includes('Codex'), false)
      assert.equal(previewText.includes('原生身份已验证'), false)
      await capture('claude-desktop-launch-preview.png')
      await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(visible('.instance-launch-preview') + '.length===0')
      const snapshot = await run('window.manager.load()')
      const instance = snapshot.instances.find(item => item.name === 'Claude Desktop 示例')
      assert.ok(instance)
      assert.equal(instance.accountId, '')
      assert.equal(instance.model, '')
      assert.equal(instance.launchMode, 'desktop')
      assert.equal(instance.connectionMode, 'client_login')
      assert.equal(snapshot.accounts.length, 1)
      assert.equal(snapshot.accounts[0].id, subscriptionAccountId)
      await click('[data-instance-id="' + instance.id + '"] button', '编辑')
      await wait(visible('.instance-editor-dialog') + '.length===1')
      assert.equal(await run('document.querySelector("[aria-label=实例客户端]").closest(".ant-select").classList.contains("ant-select-disabled")'), true)
      assert.equal(await run('document.querySelector("[aria-label=实例运行方式]").classList.contains("ant-segmented-disabled")'), true)
      await click('.instance-editor-dialog .ant-modal-footer button', '取消')
      await wait(visible('.instance-editor-dialog') + '.length===0')
      return instance
    }
    const createDesktopApi = async (apiAccount) => {
      const name = 'Claude Desktop API 示例'
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      const clients = await options('实例客户端')
      assert.deepEqual(await run(clients + '.map(el=>el.textContent)'), ['Codex', 'Claude'])
      await run(clients + '.find(el=>el.textContent==="Claude").click()')
      await click('[aria-label=实例运行方式] .ant-segmented-item', '桌面应用')
      const beforePicker = pickerOutcomes.length, pickerDeadline = Date.now() + 5000
      await click('.instance-step[data-step="0"] button', '选择应用文件')
      while (pickerOutcomes.length === beforePicker) { assert.ok(Date.now() < pickerDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      assert.equal(pickerOutcomes.at(-1)?.application?.path, desktopApplication)
      await next(1)
      await click('[aria-label="Claude Desktop 连接方式"] .ant-radio-wrapper', 'API / 第三方连接')
      await wait('document.querySelector("[aria-label=实例供应商密钥]")')
      await select('实例供应商密钥', 'Claude API 示例连接', true)
      await wait('document.querySelector("[aria-label=实例供应商密钥]").closest(".ant-select").textContent.includes("Claude API 示例连接")')
      await next(2)
      await fill('[aria-label="实例名称"]', name)
      assert.equal(await run('document.querySelector("[aria-label=实例模型]").value'), model)
      assert.equal(await run('!!document.querySelector(".instance-history-options")'), false)
      await next(3)
      await click('.ant-modal-footer button', '创建并预览')
      await wait(visible('.instance-launch-preview') + '.length===1')
      assert.equal(lastPreview?.clientType, 'claude_code')
      assert.equal(lastPreview?.launchMode, 'desktop')
      assert.equal(lastPreview?.connectionMode, 'native')
      assert.equal(lastPreview?.identityStatus, 'api_configured')
      assert.equal(lastPreview?.accountName, vault().accounts.find(account => account.id === apiAccount.accountId)?.name)
      assert.equal(lastPreview?.model, model)
      assert.ok(lastPreview?.desktopDirectory.endsWith('-3p'))
      assert.equal(lastPreview?.network?.source, 'account')
      const previewText = await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").textContent')
      assert.ok(previewText.includes('第三方 Code / Cowork'))
      assert.equal(previewText.includes('在客户端内登录'), false)
      await capture('claude-desktop-api-launch-preview.png')
      await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(visible('.instance-launch-preview') + '.length===0')
      const snapshot = await run('window.manager.load()')
      const instance = snapshot.instances.find(value => value.name === name)
      assert.ok(instance)
      assert.equal(instance.accountId, apiAccount.accountId)
      assert.equal(instance.model, model)
      assert.equal(instance.launchMode, 'desktop')
      assert.equal(instance.connectionMode, 'native')
      return instance
    }
    try {
      await wait(visible('.instances-panel') + '.length===1')
      const desktop = await createDesktop()
      const api = await create('Claude API 示例', 'api_key')
      const desktopApi = await createDesktopApi(api)
      const subscription = await createSubscription()
      const bearer = await create('Claude Bearer 示例', 'bearer')
      const sessionId = randomUUID(), transcripts = []
      for (const instance of [api, bearer, subscription]) {
        assert.ok(instance.directory.startsWith(directory + sep))
        const project = join(instance.directory, 'projects', 'fixture-project')
        fs.mkdirSync(project, { recursive: true })
        const path = join(project, sessionId + '.jsonl')
        fs.writeFileSync(path, [
          { type: 'user', sessionId, cwd: join(directory, 'workspace'), timestamp: '2026-10-13T01:00:00.000Z', message: { content: 'SYNTHETIC_PRIVATE_BODY' } },
          { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: 'SYNTHETIC_ASSISTANT_BODY' }] } },
          { type: 'custom-title', sessionId, customTitle: instance.name + '历史' },
        ].map(value => JSON.stringify(value)).join('\n') + '\n')
        transcripts.push({ path, sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex') })
      }
      await click('.ant-menu-item', '会话管理')
      await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===3')
      assert.equal(lastPage.items.length, 3)
      assert.equal(new Set(lastPage.items.map(row => row.id)).size, 3)
      assert.ok(lastPage.items.every(row => row.clientType === 'claude_code' && row.sourceSessionId === sessionId && !row.capabilities.transfer && !row.capabilities.trash))
      assert.equal(await run('document.querySelector(".sessions-panel").textContent.includes("SYNTHETIC_PRIVATE_BODY")'), false)
      assert.equal(await run('Array.from(document.querySelectorAll(".sessions-table tbody input[type=checkbox]")).every(el=>el.disabled)'), true)
      assert.equal(await run('document.querySelector(".session-transfers .transfer-toolbar button").disabled'), true)
      await capture('claude-separated-history.png')
      const rowId = lastPage.items.find(row => row.locations[0].targetId === api.id).id
      const rowSelector = '.sessions-table tr[data-row-key="' + rowId + '"]'
      const previousOpenedCount = opened.length
      await click(rowSelector + ' button', '打开会话文件')
      await wait(visible('.session-location-picker') + '.length===0')
      const openDeadline = Date.now() + 5000
      while (opened.length === previousOpenedCount) { assert.ok(Date.now() < openDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      assert.deepEqual(opened.at(-1), { action: 'file', path: transcripts[0].path })
      await click(rowSelector + ' button', '复制 ID')
      const copyDeadline = Date.now() + 5000
      while (!copiedId) { assert.ok(Date.now() < copyDeadline); await new Promise(resolve => setTimeout(resolve, 25)) }
      assert.equal(copiedId, sessionId, 'Clipboard receives Claude native ID rather than the catalog namespace')
      await select('会话来源', '实例 · ' + api.name + ' · Claude Code', true)
      await click('.session-filters button', '应用筛选')
      await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===1')
      assert.equal(await run('!!document.querySelector(".session-transfers,.session-archives,.session-sync,.session-trash")'), false)
      assert.equal(await run('Array.from(document.querySelectorAll(".sessions-panel .page-heading button")).some(el=>el.textContent.includes("修复可见性"))'), false)
      assert.equal(await run('document.querySelector("[aria-label=会话内容搜索]").disabled'), true)
      assert.equal(await run('!!document.querySelector(".session-note")'), false)
      await capture('claude-history-readonly.png')
      await click('.ant-menu-item', '供应商与密钥2')
      await clickElement('#api-connections-tab')
      await wait('document.querySelectorAll("#api-connections-panel .account-card").length===2')
      assert.equal(await run('document.querySelector("#api-connections-tab span").textContent'), '2')
      assert.deepEqual(await run('Array.from(document.querySelectorAll("#api-connections-panel .account-status")).map(el=>el.textContent)'), ['API 连接已配置', 'API 连接已配置'])
      const resourceText = await run('document.querySelector("#api-connections-panel").textContent')
      assert.ok(resourceText.includes('尚未查询'))
      assert.equal(resourceText.includes('Anthropic 额度查询尚未接入'), false)
      assert.equal(resourceText.includes('待适配器验证'), false)
      assert.equal(resourceText.includes('等待 Anthropic 适配器验证'), false)
      await capture('claude-resource-connections.png')
      const editedAccounts = []
      for (const instance of [api, bearer]) {
        const card = '[data-account-id="' + instance.accountId + '"]'
        let original = vault().accounts.find(account => account.id === instance.accountId)
        await clickElement(card + ' .account-details')
        await wait(visible('.account-quota-details') + '.length===1')
        assert.equal(await run('document.querySelector(".account-quota-details").textContent.includes("Anthropic Messages")'), true)
        assert.equal(await run('document.querySelector(".account-quota-details").textContent.includes("API 连接已配置")'), true)
        assert.equal(await run('document.querySelector(".account-quota-details").textContent.includes("默认速度")'), false)
        assert.equal(await run('document.querySelector(".account-quota-details").textContent.includes("待适配器验证")'), false)
        await clickElement('.ant-drawer-content-wrapper .ant-drawer-close')
        await wait(visible('.account-quota-details') + '.length===0')
        await clickElement(card + ' .account-edit')
        await wait(visible('[aria-label="供应商共享配置"]') + '.length===1')
        assert.equal(await run('document.querySelector("[aria-label=供应商共享配置]").textContent.includes("Anthropic Messages")'), true)
        assert.equal(await run('document.querySelector("[aria-label=供应商共享配置]").textContent.includes(' + JSON.stringify(original.models[0]) + ')'), true)
        assert.equal(await run('!!document.querySelector("[aria-label=\\"Claude API 地址\\"]")'), false)
        await click('[aria-label="供应商共享配置"] button', '解除关联')
        await wait(visible('.account-editor-form') + '.length===0')
        const unlinked = vault().accounts.find(account => account.id === instance.accountId)
        assert.equal(unlinked.providerId, undefined)
        assert.deepEqual(unlinked.models, original.models)
        assert.equal(unlinked.protocol, original.protocol)
        original = unlinked
        const priorRevision = original.revision ?? 0, name = original.name + '已编辑'
        await clickElement(card + ' .account-edit')
        await wait(visible('[aria-label="Claude API 地址"]') + '.length===1')
        await fill('.ant-drawer-content input[maxlength="120"]', name)
        await fill('.ant-drawer-content form > .ant-form-item:last-child textarea', 'Fixture metadata only; no real account')
        const keySelector = '[aria-label="Claude API 凭据"]', nextUrl = 'https://edited-' + (instance.id === api.id ? 'key' : 'bearer') + '.invalid'
        await wait('document.querySelector(' + JSON.stringify(keySelector) + ').value.length>0')
        await fill('[aria-label="Claude API 地址"]', nextUrl)
        await wait('document.querySelector(' + JSON.stringify(keySelector) + ').value===""')
        const changedSecret = 'fixture-edited-' + original.credentialKind
        await fill(keySelector, changedSecret)
        await fill('[aria-label="Claude 模型列表"]', model + ',claude-second-fixture')
        assert.equal(await run('document.querySelector(".ant-drawer-content").textContent.includes("Fast")'), false)
        await capture('claude-' + original.credentialKind + '-edit.png')
        await click('.ant-drawer-footer button', '保存账号')
        await wait(visible('[aria-label="Claude API 地址"]') + '.length===0')
        const updated = vault().accounts.find(account => account.id === instance.accountId)
        assert.equal(updated.name, name); assert.equal(updated.baseUrl, nextUrl)
        assert.equal(updated.note, 'Fixture metadata only; no real account')
        assert.deepEqual(updated.models, [model, 'claude-second-fixture'])
        assert.equal(updated.revision, priorRevision + 1)
        assert.equal(updated.identityService, original.identityService); assert.equal(updated.protocol, original.protocol); assert.equal(updated.credentialKind, original.credentialKind)
        assert.ok(Object.values(updated.credentials).includes(changedSecret))
        await clickElement(card + ' .account-proxy')
        await wait(visible('.account-proxy-dialog') + '.length===1')
        assert.equal(await run('document.querySelector(".account-proxy-dialog").textContent.includes("Claude")'), true)
        assert.equal(await run('document.querySelector(".account-proxy-dialog").textContent.includes("原生模式目前请通过本地 API 接入")'), false)
        await select('账号网络代理连接方式', '指定代理')
        await fill('[aria-label="账号网络代理地址"]', 'socks5h://fixture-proxy-user:fixture-proxy-secret@127.0.0.1:9443')
        await click('.account-proxy-dialog button', '保存代理')
        await wait(visible('.account-proxy-dialog') + '.length===0')
        const proxyAccount = vault().accounts.find(account => account.id === instance.accountId)
        assert.equal(proxyAccount.proxy.mode, 'custom')
        assert.equal(proxyAccount.proxy.url, 'socks5h://fixture-proxy-user:fixture-proxy-secret@127.0.0.1:9443')
        const publicSnapshot = await run('window.manager.load()')
        assert.equal(publicSnapshot.accounts.find(account => account.id === instance.accountId).egressProxy.mode, 'custom')
        assert.equal(JSON.stringify(publicSnapshot).includes(changedSecret), false)
        assert.equal(JSON.stringify(publicSnapshot).includes('fixture-proxy-secret'), false)
        await clickElement(card + ' .account-proxy')
        await wait(visible('.account-proxy-dialog') + '.length===1')
        assert.equal(await run('document.querySelector("[aria-label=账号网络代理地址]").value'), '')
        await click('.account-proxy-dialog button', '取消')
        await wait(visible('.account-proxy-dialog') + '.length===0')
        editedAccounts.push({ id: instance.accountId, credentialKind: original.credentialKind })
      }
      await capture('claude-edited-connections.png')
      for (const account of editedAccounts) await clickElement('[data-account-id="' + account.id + '"] input[type="checkbox"]')
      await click('#api-connections-panel .toolbar button', '移入回收站2项')
      await click('.ant-modal-confirm-btns button', '移入回收站')
      await wait('document.querySelectorAll("#api-connections-panel .account-card").length===0')
      assert.ok(editedAccounts.every(account => !vault().accounts.some(item => item.id === account.id)))
      assert.ok(editedAccounts.every(account => vault().accountRecycle.some(item => item.account.id === account.id)))
      for (const item of transcripts) assert.equal(createHash('sha256').update(fs.readFileSync(item.path)).digest('hex'), item.sha256)
      for (const instance of [desktop, desktopApi, api, subscription, bearer]) assert.equal(fs.existsSync(join(directory, 'instances', instance.id, 'launch.json')), false)
      assert.deepEqual(networkAttempts, [], 'API configuration and previews must not call login/model/token services')
      fs.writeFileSync(join(evidence, 'validation.json'), JSON.stringify({
        passed: true, clients: ['Codex', 'Claude'], claudeModes: ['cli', 'desktop'], connections: ['anthropic_api_key', 'anthropic_bearer', 'claude_ai_oauth'],
        modelSelections,
        identityStatus: ['api_configured', 'subscription_configured', 'client_login'], isolatedInstances: 5, desktopIndependentLogin: true, desktopManagedAccountsCreated: 0, desktopModelNotRequired: true, desktopThirdPartyApi: true, desktopApplication: installedDesktop ? 'installed-official-bundle-read-only-preview' : 'synthetic-bundle', sameNativeIdSeparateRows: true, readOnlyHistory: true,
        nativeIdClipboard: true, sourceTranscriptsUnchanged: true, networkRequests: 0, launchedInstances: 0,
        resourceManagement: { apiConnectionsTab: true, configuredStatus: true, quotaUnavailableLabel: true, details: true, metadata: true, perKeyModels: true, sharedProvider: true, unlinkPreservesKeySettings: true, endpointModelsCredentials: true, accountProxy: true, recycle: true },
        limitation: 'Preview only. Synthetic CLI executable, credentials and transcripts; Desktop bundle is identified above. No real Claude login, client launch or model response.',
      }, null, 2), { mode: 0o600 })
      console.log('Claude Manager UI smoke passed: Desktop client-login and third-party API previews, CLI API/Bearer/subscription creation, exact launcher selection, isolated read-only history, connection editing, encrypted proxy settings and recycling; no network or client launch.')
      clearTimeout(timer); window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error)
      await captureFailure().catch(() => {})
      await capture('claude-ui-failure.png').catch(() => {})
      clearTimeout(timer); app.exit(1)
    }
  })
})
require('../out/main/index.js')
