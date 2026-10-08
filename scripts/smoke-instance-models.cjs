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
const connection = { ...common, id: randomUUID(), kind: 'api_key', name: '示例供应商连接', baseUrl: 'https://fixture-provider.invalid/v1', models: ['fixture-provider-model'], credentials: { apiKey: 'fixture-provider-secret' } }
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [], accounts: [identity, connection] })), { mode: 0o600 })

const application = join(fs.realpathSync(directory), 'Fixture.app')
fs.mkdirSync(join(application, 'Contents', 'MacOS'), { recursive: true })
fs.writeFileSync(join(application, 'Contents', 'MacOS', 'Codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
fs.writeFileSync(join(application, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.aml.fixture.${randomUUID()}</string><key>CFBundleName</key><string>AML Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
globalThis.fetch = async () => { throw new Error('Instance model smoke forbids upstream requests') }

// Hold the actual first catalog request across user input. This catches a
// delayed result replacing a custom model, using the production IPC handler.
let releaseDefaults, defaultsCompleted = false, delayDefaults = true
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
  if (channel === 'manager:invoke' && args[0] === 'readInstanceModelDefaults' && delayDefaults) {
    delayDefaults = false
    await new Promise(resolve => { releaseDefaults = resolve })
    try { return await listener(event, ...args) } finally { defaultsCompleted = true }
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
    const modelValue = () => run('document.querySelector("[aria-label=实例模型]").value')
    const modelOptions = async () => {
      await fill('[aria-label="实例模型"]', '')
      await run('(()=>{const input=document.querySelector("[aria-label=实例模型]");input.focus();input.closest(".ant-select").querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))})()')
      await wait(`(${visible('.ant-select-dropdown .ant-select-item-option')}).length>0`)
      return run(`(${visible('.ant-select-dropdown .ant-select-item-option')}).map(el=>el.getAttribute('title')??el.textContent.trim())`)
    }

    try {
      await wait('!!document.querySelector(".instances-panel")')
      const deadline = Date.now() + 10_000
      while (!releaseDefaults) { assert.ok(Date.now() < deadline, 'Initial native catalog request was not received'); await new Promise(resolve => setTimeout(resolve, 25)) }

      await openWizard()
      await next(1)
      assert.match(await run('document.querySelector("[aria-label=实例账号]").closest(".ant-select").innerText'), /示例 ChatGPT 账号/)
      await next(2)
      assert.equal(await modelValue(), '', 'Delayed native catalog has not arrived')
      await fill('[aria-label="实例模型"]', 'fixture-custom-while-loading')
      releaseDefaults()
      const completionDeadline = Date.now() + 10_000
      while (!defaultsCompleted) { assert.ok(Date.now() < completionDeadline, 'Delayed native catalog did not complete'); await new Promise(resolve => setTimeout(resolve, 25)) }
      await settle()
      assert.equal(await modelValue(), 'fixture-custom-while-loading', 'Late native defaults must preserve user input')
      await next(3)
      await close()

      const defaults = await run('window.manager.readInstanceModelDefaults("codex")')
      assert.ok(defaults.models.length > 0 && defaults.defaultModelId)
      assert.equal(defaults.defaultModelId, defaults.models[0])
      assert.equal(defaults.models.includes('gpt-reserve'), false, 'Native choices exclude the routing placeholder')
      assert.equal(defaults.models.includes('fixture-provider-model'), false)

      await openWizard(); await next(1); await next(2)
      assert.equal(await modelValue(), defaults.defaultModelId, 'OAuth accounts with models:[] receive the native default automatically')
      await next(3)
      assert.equal(await run(`document.querySelector('.instance-step[data-step="3"]').innerText.includes(${JSON.stringify(defaults.defaultModelId)})`), true, 'Automatically filled model advances to confirmation without typing')
      await click('.ant-modal-footer button', '返回'); await step(2)
      const nativeOptions = await modelOptions()
      assert.ok(nativeOptions.length > 0)
      assert.ok(nativeOptions.every(model => defaults.models.includes(model)), 'OAuth dropdown comes only from the native client catalog')
      assert.ok(nativeOptions.includes(defaults.defaultModelId))
      await fill('[aria-label="实例模型"]', defaults.defaultModelId)
      await capture('oauth-default-model.png')
      await next(3)
      assert.equal(await run(`document.querySelector('.instance-step[data-step="3"]').innerText.includes(${JSON.stringify(defaults.defaultModelId)})`), true)
      await click('.ant-modal-footer button', '仅创建')
      await wait(`!(${visible('.instance-editor')}).length`)
      let snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances.length, 1)
      assert.equal(snapshot.instances[0].model, defaults.defaultModelId)
      assert.equal(snapshot.instances[0].accountId, identity.id)
      assert.equal(snapshot.instanceApplications.find(item => item.id === snapshot.instances[0].applicationId).path, application)
      assert.deepEqual(snapshot.accounts.find(item => item.id === identity.id).models, [], 'Selecting a default must not rewrite the OAuth account catalog')

      await click('.instance-card button', '编辑')
      await wait(`(${visible('.instance-editor')}).length>0`)
      assert.equal(await modelValue(), defaults.defaultModelId)
      await fill('[aria-label="实例模型"]', 'fixture-saved-custom-model')
      await click('.ant-modal-footer button', '保存')
      await wait(`!(${visible('.instance-editor')}).length`)
      await click('.instance-card button', '编辑')
      await wait(`(${visible('.instance-editor')}).length>0`); await settle()
      assert.equal(await modelValue(), 'fixture-saved-custom-model', 'Editing preserves the saved instance model')
      await capture('oauth-edit-preserves-model.png')
      await close()
      await click('.instance-card button', '复制实例')
      await wait(`(${visible('.instance-editor')}).length>0`); await settle()
      assert.equal(await modelValue(), 'fixture-saved-custom-model', 'Copying preserves the source instance model')
      await close()
      assert.equal((await run('window.manager.load()')).instances.length, 1, 'Cancelling copy does not create another instance')

      await openWizard(); await next(1)
      await click('.instance-step[data-step="1"] .ant-radio-wrapper', '供应商密钥')
      await select('实例供应商密钥', '示例供应商连接 · 独立连接')
      await next(2)
      assert.equal(await modelValue(), 'fixture-provider-model', 'API connections retain their own first model')
      const providerOptions = await modelOptions()
      assert.deepEqual(providerOptions, ['fixture-provider-model'], 'API dropdown does not inherit native ChatGPT models')
      await fill('[aria-label="实例模型"]', 'fixture-provider-custom-model')
      await settle()
      assert.equal(await modelValue(), 'fixture-provider-custom-model')
      await next(3); await capture('provider-model-boundary.png'); await close()

      await openWizard(); await next(1); await next(2)
      assert.equal(await modelValue(), defaults.defaultModelId, 'A reopened draft has fresh identity defaults')
      await next(3); await close()
      snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances[0].model, 'fixture-saved-custom-model')
      assert.deepEqual(snapshot.accounts.find(item => item.id === identity.id).models, [])
      assert.deepEqual(snapshot.accounts.find(item => item.id === connection.id).models, ['fixture-provider-model'])
      const validation = { oauthEmptyCatalog: true, automaticNativeDefault: defaults.defaultModelId, nativeDropdown: nativeOptions, noManualInputRequired: true, delayedCatalogPreservesTyping: true, providerDropdown: providerOptions, providerModelsIsolated: true, editingPreservesModel: true, copyingPreservesModel: true, reopenedDraftUsesDefaults: true, accountCatalogsUnchanged: true, actualClientLaunched: false, upstreamRequests: false }
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify(validation, null, 2))
      console.log('Instance model UI passed: empty OAuth catalogs receive native defaults and options; next succeeds without typing; delayed IPC preserves manual input; API catalogs stay isolated; edit/copy preserve saved models; cancel/reopen resets the draft. Temporary encrypted vault and fixture app; no upstream request or actual client launch.')
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
