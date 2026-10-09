// Real Electron renderer/IPC regression for instance model defaults. Every
// credential, application and config directory is synthetic and temporary.
const { app, safeStorage, dialog, ipcMain } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')

const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const now = Date.now()
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 7200, email: 'fixture-native@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-native-workspace', chatgpt_user_id: 'fixture-native-user' } })).toString('base64url') + '.signature'
const common = { generation: randomUUID(), revision: 0, defaultTier: 'inherit', wireApi: 'responses', note: '', tags: [], createdAt: now }
const identity = { ...common, id: randomUUID(), kind: 'oauth', name: '示例 ChatGPT 账号', email: 'fixture-native@example.invalid', baseUrl: 'https://fixture-native.invalid', models: [], credentials: { accessToken: jwt, refreshToken: 'fixture-native-refresh', idToken: jwt, accountId: 'fixture-native-workspace' } }
const secondIdentity = { ...identity, id: randomUUID(), name: '第二个 ChatGPT 账号', email: 'fixture-second@example.invalid', models: ['fixture-obsolete-account-model'], credentials: { accessToken: jwt, refreshToken: 'fixture-second-refresh', idToken: jwt, accountId: 'fixture-second-workspace' } }
const connection = { ...common, id: randomUUID(), kind: 'api_key', name: '示例供应商连接', baseUrl: 'https://fixture-provider.invalid/v1', models: ['fixture-provider-model'], credentials: { apiKey: 'fixture-provider-secret' } }
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [], accounts: [identity, secondIdentity, connection] })), { mode: 0o600 })

const application = join(fs.realpathSync(directory), 'Fixture.app')
fs.mkdirSync(join(application, 'Contents', 'MacOS'), { recursive: true })
fs.writeFileSync(join(application, 'Contents', 'MacOS', 'Codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
fs.writeFileSync(join(application, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.aml.fixture.${randomUUID()}</string><key>CFBundleName</key><string>AML Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
globalThis.fetch = async () => { throw new Error('Instance model smoke forbids upstream requests') }

// The actual renderer/preload contract receives synthetic official catalogs.
// HTTP/authentication behavior is covered separately by the service tests.
// Builtin-default IPC still runs its production handler; no real token is used.
const officialModels = ['fixture-official-first', 'fixture-official-second']
const secondOfficialModels = ['fixture-second-official-first', 'fixture-second-official-other']
const requests = [], cancelled = [], pending = [], cachedScopes = new Set()
let delayNextOfficial = true, failNextOfficial = false
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
  if (channel === 'manager:invoke' && args[0] === 'fetchChatGPTModels') {
    const input = args[1]
    assert.ok(input && [identity.id, secondIdentity.id].includes(input.accountId), 'Only the selected fixture ChatGPT account can request its official catalog')
    assert.match(input.requestId, /^[0-9a-f-]{36}$/i)
    assert.equal(typeof input.applicationId, 'string')
    requests.push({ ...input })
    const fixtureSelected = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault')))).instanceApplications?.some(item => item.id === input.applicationId && item.path === application)
    if (failNextOfficial && fixtureSelected) { failNextOfficial = false; throw new Error('fixture official models unavailable') }
    let delayed
    if (delayNextOfficial && fixtureSelected) {
      delayNextOfficial = false
      delayed = { input: { ...input }, completed: false }
      pending.push(delayed)
      await new Promise(resolve => { delayed.release = resolve })
    }
    const models = input.accountId === identity.id ? officialModels : secondOfficialModels
    const scope = input.accountId + ':' + input.applicationId
    const result = { requestId: input.requestId, accountId: input.accountId, models, defaultModelId: models[0], source: cachedScopes.has(scope) && !input.force ? 'cache' : 'official', fetchedAt: Date.now() }
    cachedScopes.add(scope)
    if (delayed) delayed.completed = true
    return result
  }
  if (channel === 'manager:invoke' && args[0] === 'cancelChatGPTModels') {
    cancelled.push(args[1])
    // Deliberately allow an already-in-flight response to arrive after cancel,
    // exercising the renderer's generation/account check as well as cancel IPC.
    return
  }
  return listener(event, ...args)
})

const output = resolve('.local/instance-models-ui')
fs.mkdirSync(output, { recursive: true })
for (const name of ['validation.json', 'failure.txt', 'failure.png']) fs.rmSync(join(output, name), { force: true })
const timer = setTimeout(() => { console.error('Instance model UI exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.setContentSize(1280, 900)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      let result
      try { result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:String(error.stack??error)}}})()`) }
      catch (error) { throw new Error('Renderer expression failed: ' + code, { cause: error }) }
      if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code)
      return result.value
    }
    const wait = async expression => {
      const until = Date.now() + 10_000
      while (!await run(expression)) { assert.ok(Date.now() < until, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) }
    }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const click = async (selector, text) => {
      const expression = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    }
    const settle = async () => {
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const capture = async name => { await settle(); fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG()) }
    const step = async index => { await wait(`(()=>{const el=document.querySelector('.instance-step[data-step="${index}"]');return !!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0})()`); await settle() }
    const next = async index => { await click('.ant-modal-footer button', '下一步'); await step(index) }
    const close = async () => { await click('.ant-modal-footer button', '取消'); await wait(`!(${visible('.instance-editor')}).length`); await settle() }
    const openWizard = async () => {
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      await click('.instance-step[data-step="0"] button', '选择应用文件')
      await wait(`document.querySelector('.instance-step[data-step="0"]').textContent.includes('Fixture.app')`)
    }
    const select = async (label, text) => {
      await run(`document.querySelector('[aria-label=${JSON.stringify(label)}]').closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
      await click('.ant-select-dropdown .ant-select-item-option', text)
    }
    const modeValue = () => run('document.querySelector("[aria-label=实例接入方式]").closest(".ant-select").innerText')
    const modelValue = () => run('document.querySelector("[aria-label=实例模型]").value')
    const modelSource = () => run('document.querySelector(".instance-model-source")?.textContent??""')
    const waitPending = async index => {
      const until = Date.now() + 10_000
      while (!pending[index]?.release) { assert.ok(Date.now() < until, 'Delayed official catalog request was not received'); await new Promise(resolve => setTimeout(resolve, 25)) }
      return pending[index]
    }
    const release = async delayed => {
      delayed.release()
      const until = Date.now() + 10_000
      while (!delayed.completed) { assert.ok(Date.now() < until, 'Delayed official catalog did not complete'); await new Promise(resolve => setTimeout(resolve, 25)) }
      await settle()
    }
    const modelOptions = async () => {
      await fill('[aria-label="实例模型"]', '')
      await run('(()=>{const input=document.querySelector("[aria-label=实例模型]");input.focus();input.closest(".ant-select").querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))})()')
      await wait(`(${visible('.ant-select-dropdown .ant-select-item-option')}).length>0`)
      await settle()
      const layout = await run(`(()=>{const input=document.querySelector('[aria-label="实例模型"]'),select=input.closest('.ant-select'),popup=(${visible('.ant-select-dropdown')})[0],options=Array.from(popup.querySelectorAll('.ant-select-item-option'));return {input:input.getBoundingClientRect().width,select:select.getBoundingClientRect().width,popup:popup.getBoundingClientRect().width,popupOffset:popup.offsetWidth,popupStyle:popup.getAttribute('style'),options:options.map(el=>el.getBoundingClientRect().width),text:options.map(el=>el.querySelector('.ant-select-item-option-content')?.getBoundingClientRect().width??0)}})()`)
      fs.writeFileSync(join(output, 'dropdown-layout.json'), JSON.stringify(layout, null, 2))
      assert.ok(layout.popup >= layout.input - 2, 'Model dropdown must match the input width: ' + JSON.stringify(layout))
      assert.ok(layout.text.every(width => width >= Math.min(160, layout.input * 0.7)), 'Model option text must have readable width: ' + JSON.stringify(layout))
      return run(`(${visible('.ant-select-dropdown .ant-select-item-option')}).map(el=>el.getAttribute('title')??el.textContent.trim())`)
    }

    try {
      await wait('!!document.querySelector(".instances-panel")')
      await openWizard()
      await next(1)
      assert.match(await modeValue(), /原生账号登录/, 'OAuth native login is visible before continuing')
      assert.match(await run('document.querySelector(".instance-connection-description").innerText'), /直接登录.*ChatGPT/)
      assert.match(await run('document.querySelector("[aria-label=实例账号]").closest(".ant-select").innerText'), /示例 ChatGPT 账号/)
      await next(2)
      const firstPending = await waitPending(0)
      assert.equal(firstPending.input.accountId, identity.id)
      assert.match(await modelSource(), /正在获取.*官方/, 'The selected fixture application still awaits its account catalog')
      await fill('[aria-label="实例模型"]', 'fixture-custom-while-loading')
      await release(firstPending)
      assert.equal(await modelValue(), 'fixture-custom-while-loading', 'Late official defaults must preserve user input')
      await next(3)
      await close()

      const defaults = await run('window.manager.readInstanceModelDefaults("codex")')
      assert.ok(defaults.models.length > 0 && defaults.defaultModelId)
      assert.equal(defaults.defaultModelId, defaults.models[0])
      assert.equal(defaults.models.includes('gpt-reserve'), false, 'Native choices exclude the routing placeholder')
      assert.equal(defaults.models.includes('fixture-provider-model'), false)

      await openWizard(); await next(1); await next(2)
      await wait(`document.querySelector('[aria-label="实例模型"]').value===${JSON.stringify(officialModels[0])}`)
      assert.equal(await modelValue(), officialModels[0], 'OAuth accounts receive the official account default ahead of builtin candidates')
      assert.match(await modelSource(), /官方|缓存/)
      await click('[aria-label="刷新官方模型列表"]', '刷新')
      await wait(`document.querySelector('.instance-model-source').textContent.includes('官方模型列表')&&!document.querySelector('[aria-label="刷新官方模型列表"]').classList.contains('ant-btn-loading')`)
      assert.equal(requests.at(-1).force, true, 'The visible refresh action requests fresh official models')
      await next(3)
      assert.equal(await run(`document.querySelector('.instance-step[data-step="3"]').innerText.includes(${JSON.stringify(officialModels[0])})`), true, 'Official default advances to confirmation without typing')
      await click('.ant-modal-footer button', '返回'); await step(2)
      const nativeOptions = await modelOptions()
      assert.ok(nativeOptions.length > 0)
      assert.deepEqual(nativeOptions, officialModels, 'OAuth dropdown comes from the official account catalog')
      assert.equal(nativeOptions.some(model => defaults.models.includes(model)), false)
      await fill('[aria-label="实例模型"]', officialModels[0])
      await capture('oauth-default-model.png')
      await next(3)
      assert.equal(await run(`document.querySelector('.instance-step[data-step="3"]').innerText.includes(${JSON.stringify(officialModels[0])})`), true)
      await click('.ant-modal-footer button', '仅创建')
      await wait(`!(${visible('.instance-editor')}).length`)
      let snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances.length, 1)
      assert.equal(snapshot.instances[0].model, officialModels[0])
      assert.equal(snapshot.instances[0].accountId, identity.id)
      assert.equal(snapshot.instances[0].connectionMode, 'native', 'New OAuth instance uses native identity by default')
      assert.equal(snapshot.instanceApplications.find(item => item.id === snapshot.instances[0].applicationId).path, application)
      assert.deepEqual(snapshot.accounts.find(item => item.id === identity.id).models, [], 'Selecting a default must not rewrite the OAuth account catalog')

      await click('.instance-card button', '编辑')
      await wait(`(${visible('.instance-editor')}).length>0`)
      assert.equal(await modelValue(), officialModels[0])
      await fill('[aria-label="实例模型"]', 'fixture-saved-custom-model')
      await select('实例接入方式', '本地 API')
      assert.equal(await modelValue(), 'fixture-saved-custom-model', 'Mode changes preserve the selected model')
      assert.match(await run('document.querySelector(".instance-connection-description").innerText'), /不会获得原生 ChatGPT 登录菜单/)
      await click('.ant-modal-footer button', '保存')
      await wait(`!(${visible('.instance-editor')}).length`)
      await click('.instance-card button', '编辑')
      await wait(`(${visible('.instance-editor')}).length>0`); await settle()
      assert.equal(await modelValue(), 'fixture-saved-custom-model', 'Editing preserves the saved instance model')
      assert.match(await modeValue(), /本地 API/, 'Existing OAuth mode is not silently migrated')
      await click('.instance-use-native', '切换为原生账号登录')
      assert.match(await modeValue(), /原生账号登录/)
      assert.match(await run('document.querySelector(".instance-mode-history-note").innerText'), /修复可见性.*自动匹配/)
      assert.equal(await modelValue(), 'fixture-saved-custom-model')
      await select('实例接入方式', '本地 API')
      await capture('oauth-edit-preserves-model.png')
      await close()
      await click('.instance-card button', '复制实例')
      await wait(`(${visible('.instance-editor')}).length>0`); await settle()
      assert.equal(await modelValue(), 'fixture-saved-custom-model', 'Copying preserves the source instance model')
      assert.match(await modeValue(), /本地 API/, 'Copy retains its source connection mode')
      await close()
      assert.equal((await run('window.manager.load()')).instances.length, 1, 'Cancelling copy does not create another instance')

      await openWizard(); await next(1)
      await click('.instance-step[data-step="1"] .ant-radio-wrapper', '供应商密钥')
      await select('实例供应商密钥', '示例供应商连接 · 独立连接')
      assert.match(await modeValue(), /本地 API/, 'Provider selection automatically uses local API in a new draft')
      await settle()
      const beforeProvider = requests.length
      await next(2)
      assert.equal(await modelValue(), 'fixture-provider-model', 'API connections retain their own first model')
      const providerOptions = await modelOptions()
      assert.deepEqual(providerOptions, ['fixture-provider-model'], 'API dropdown does not inherit native ChatGPT models')
      await fill('[aria-label="实例模型"]', 'fixture-provider-custom-model')
      await settle()
      assert.equal(await modelValue(), 'fixture-provider-custom-model')
      assert.equal(requests.length, beforeProvider, 'Provider selection must not request an official ChatGPT catalog')
      await next(3); await capture('provider-model-boundary.png'); await close()

      // Account B resolves first; A's delayed response is still delivered even
      // after cancellation and must not contaminate B's model list or default.
      delayNextOfficial = true
      await openWizard(); await next(1)
      const slowFirst = await waitPending(1)
      await select('实例账号', secondIdentity.name)
      await next(2)
      await wait(`document.querySelector('[aria-label="实例模型"]').value===${JSON.stringify(secondOfficialModels[0])}`)
      assert.match(await modelSource(), /官方|缓存/)
      await release(slowFirst)
      assert.equal(await modelValue(), secondOfficialModels[0], 'A slow old account response must not replace the new account default')
      const secondOptions = await modelOptions()
      assert.deepEqual(secondOptions, secondOfficialModels)
      assert.ok(cancelled.includes(slowFirst.input.requestId), 'Switching identities cancels the old catalog request')
      await fill('[aria-label="实例模型"]', secondOfficialModels[0])
      await click('.ant-modal-footer button', '返回'); await step(1)
      await select('实例接入方式', '本地 API')
      assert.match(await run('document.querySelector("[aria-label=实例账号]").closest(".ant-select").innerText'), /第二个 ChatGPT 账号/, 'Mode change preserves the selected identity')
      await next(2)
      assert.equal(await modelValue(), secondOfficialModels[0], 'Mode change preserves the selected model')
      await capture('official-account-switch.png')
      await next(3); await close()

      // A failed official lookup exposes the fallback source instead of
      // representing bundled models as verified account availability.
      failNextOfficial = true
      await openWizard(); await next(1); await next(2)
      await wait('!!document.querySelector(".instance-model-source")?.textContent.match(/备用|回退/)')
      assert.match(await modelSource(), /官方/)
      assert.equal(await modelValue(), defaults.defaultModelId)
      const backupOptions = await modelOptions()
      assert.ok(backupOptions.every(model => defaults.models.includes(model)))
      assert.equal(backupOptions.some(model => officialModels.includes(model)), false)
      await fill('[aria-label="实例模型"]', defaults.defaultModelId)
      await capture('official-failure-builtin-backup.png')
      await next(3); await close()

      await openWizard(); await next(1); await next(2)
      await wait(`document.querySelector('[aria-label="实例模型"]').value===${JSON.stringify(officialModels[0])}`)
      assert.equal(await modelValue(), officialModels[0], 'A reopened draft loads its account official catalog')
      await next(3); await close()
      snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances[0].model, 'fixture-saved-custom-model')
      assert.deepEqual(snapshot.accounts.find(item => item.id === identity.id).models, [])
      assert.deepEqual(snapshot.accounts.find(item => item.id === secondIdentity.id).models, ['fixture-obsolete-account-model'])
      assert.deepEqual(snapshot.accounts.find(item => item.id === connection.id).models, ['fixture-provider-model'])
      assert.equal(requests.some(request => request.accountId === connection.id), false)
      const validation = { oauthNativeByDefault: true, modeChoiceVisible: true, modeSwitchPreservesAccountAndModel: true, existingAndCopiedModesPreserved: true, proxyDefaultsUnitTested: true, oauthEmptyCatalog: true, officialDefault: officialModels[0], officialDropdown: nativeOptions, officialOverridesBuiltin: true, forceRefreshRequestsFreshCatalog: true, noManualInputRequired: true, delayedCatalogPreservesTyping: true, secondAccountDropdown: secondOptions, slowAccountResponseIsolated: true, cancelledRequests: cancelled.length, officialFailureLabelsBuiltinBackup: true, backupDropdown: backupOptions, providerDropdown: providerOptions, providerModelsIsolated: true, apiOfficialRequests: 0, editingPreservesModel: true, copyingPreservesModel: true, reopenedDraftUsesDefaults: true, accountCatalogsUnchanged: true, actualClientLaunched: false, upstreamRequests: false }
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify(validation, null, 2))
      console.log('Instance model UI passed: official account catalogs override builtin and stale account candidates; next succeeds without typing; delayed IPC preserves manual input; slow account A cannot overwrite account B; failure explicitly labels builtin backup; API catalogs stay isolated; edit/copy preserve saved models. Temporary encrypted vault, fixture official IPC and app; no upstream request or actual client launch.')
      clearTimeout(timer); app.quit()
    } catch (error) {
      console.error(error)
      fs.writeFileSync(join(output, 'failure.txt'), String(error.stack ?? error))
      await capture('failure.png').catch(() => {})
      clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit()
    }
  })
})
require('../out/main/index.js')
