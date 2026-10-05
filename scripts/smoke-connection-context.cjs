// Actual renderer and IPC with a synthetic, temporary encrypted account vault.
// No real accounts, upstream calls, or official client launch are used here.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const now = Date.now(), model = 'fixture-context-model', fallbackModel = 'fixture-default-model'
const providerId = randomUUID()
const keys = ['Project A', 'Project B'].map((name, index) => ({ id: randomUUID(), name, apiKey: `fixture-connection-context-${index}`, createdAt: now, updatedAt: now }))
const provider = { id: providerId, revision: 0, name: '共享供应商示例', baseUrl: 'https://fixture-provider.invalid/v1', models: [model, fallbackModel], wireApi: 'responses', defaultTier: 'inherit', modelContextWindows: { [model]: 400000 }, createdAt: now, updatedAt: now, excludedKeyHashes: [], keys }
const accounts = keys.map((key, index) => ({ id: randomUUID(), generation: randomUUID(), revision: 0, kind: 'api_key', name: `项目连接 ${index + 1}`, providerId, providerKeyId: key.id, baseUrl: provider.baseUrl, models: [...provider.models], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: now, credentials: { apiKey: key.apiKey } }))
const independent = { id: randomUUID(), generation: randomUUID(), revision: 0, kind: 'api_key', name: '独立连接示例', baseUrl: 'https://fixture-independent.invalid/v1', models: [fallbackModel], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: now, credentials: { apiKey: 'fixture-independent-context-key' } }
accounts.push(independent)
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [provider], accounts })), { mode: 0o600 })
const originalSpawn = childProcess.spawn
childProcess.spawn = function(file, args) {
  assert.notEqual(file, '/usr/bin/security', 'No system keychain calls in the isolated context smoke')
  assert.equal(args?.includes('-egress-http') ?? false, false, 'No upstream HTTP helper calls')
  return originalSpawn.apply(this, arguments)
}
globalThis.fetch = async () => { throw new Error('Connection-context smoke rejects network requests') }
const output = resolve('docs/evidence/connection-context')
fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Connection-context UI exceeded 75 seconds'); app.exit(1) }, 75000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.setContentSize(1360, 1040)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      const result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:String(error.stack??error)}}})()`)
      if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code)
      return result.value
    }
    const wait = async expression => {
      const until = Date.now() + 8000
      while (!await run(expression)) { assert.ok(Date.now() < until, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const click = async (selector, text) => {
      const expression = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const capture = async name => {
      await settle()
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await settle()
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const snapshot = () => run('window.manager.load()')
    const getAccount = (state, index) => state.accounts.find(account => account.id === accounts[index].id)
    const contextSelect = chosenModel => `.ant-drawer-open [aria-label=${JSON.stringify('上下文窗口 · ' + chosenModel)}]`
    const selectionText = chosenModel => run(`document.querySelector(${JSON.stringify(contextSelect(chosenModel))}).closest('.ant-select').innerText`)
    const select = async (chosenModel, label) => {
      const selector = contextSelect(chosenModel)
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      const control = await run(`(()=>{const select=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select');select.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return select.querySelector('input').getAttribute('aria-controls')})()`)
      const option = `Array.from(document.getElementById(${JSON.stringify(control)})?.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option')??[]).find(el=>el.textContent===${JSON.stringify(label)})`
      await wait(`!!(${option})`)
      await run(`(${option}).click()`)
      await settle()
    }
    const openConnection = async index => {
      await wait(`!!document.querySelector(${JSON.stringify(`.account-card[data-account-id="${accounts[index].id}"] .account-edit`)})`)
      await run(`document.querySelector(${JSON.stringify(`.account-card[data-account-id="${accounts[index].id}"] .account-edit`)}).click()`)
      await wait(`!!document.querySelector(${JSON.stringify(contextSelect(index === 2 ? fallbackModel : model))})`)
    }
    const saveConnection = async (index = 0) => {
      await click('.ant-drawer-open button', index === 2 ? '保存账号' : '保存连接')
      await wait('!document.querySelector(".ant-drawer-open")')
      await settle()
    }
    const enterConnections = async () => {
      await wait(`!!document.getElementById('api-connections-tab')`)
      await run(`document.getElementById('api-connections-tab').click()`)
      await wait('document.querySelectorAll(".account-card").length===3')
    }
    try {
      await wait(`${visible('.ant-menu-item')}.some(el=>el.textContent.includes('供应商与密钥'))`)
      await run(`${visible('.ant-menu-item')}.find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await enterConnections()
      await openConnection(0)
      await wait(`document.querySelector(${JSON.stringify(contextSelect(model))}).closest('.ant-select').innerText.includes('使用供应商默认值 400K')`)
      await wait(`document.querySelector(${JSON.stringify(contextSelect(fallbackModel))}).closest('.ant-select').innerText.includes('使用默认值')`)
      assert.match(await selectionText(fallbackModel), /未设置 · 使用默认值 \d+K/)
      assert.equal(await run(`!!document.querySelector(${JSON.stringify('.ant-drawer-open input[aria-label="账号 API Key"]')})`), false, 'Managed context editing does not expose or change supplier keys')
      await capture('connection-inherited-defaults.png')
      await select(model, '512K · 512,000 tokens')
      await saveConnection()
      let state = await snapshot()
      assert.deepEqual(getAccount(state, 0).modelContextWindows, { [model]: 512000 })
      assert.equal(getAccount(state, 1).modelContextWindows, undefined)
      assert.deepEqual(state.providers[0].modelContextWindows, { [model]: 400000 })
      await openConnection(1)
      assert.match(await selectionText(model), /使用供应商默认值 400K/)
      await select(model, '256K · 256,000 tokens')
      await saveConnection(1)
      await openConnection(0)
      assert.match(await selectionText(model), /512K/)
      await capture('connection-independent-preset.png')
      await click('.ant-drawer-open button', '编辑供应商配置')
      await wait('!!document.querySelector(".provider-details-form")')
      const contextPanel = `${visible('.provider-advanced-settings .ant-collapse-header')}.find(el=>el.textContent.includes('模型上下文窗口'))`
      await run(`(${contextPanel}).click()`)
      await wait(`!!document.querySelector(${JSON.stringify(contextSelect(model))})`)
      await select(model, '1M · 1,000,000 tokens')
      await click('.ant-drawer-open button', '保存供应商')
      await wait('!document.querySelector(".ant-drawer-open")')
      state = await snapshot()
      assert.deepEqual(state.providers[0].modelContextWindows, { [model]: 1000000 })
      assert.deepEqual(getAccount(state, 0).modelContextWindows, { [model]: 512000 })
      assert.deepEqual(getAccount(state, 1).modelContextWindows, { [model]: 256000 })
      await enterConnections()
      await openConnection(0)
      assert.match(await selectionText(model), /512K/)
      await click('.ant-drawer-open button', '清空所有配置')
      await wait(`document.querySelector(${JSON.stringify(contextSelect(model))}).closest('.ant-select').innerText.includes('使用供应商默认值 1M')`)
      await capture('connection-cleared-inherits-supplier.png')
      await saveConnection()
      state = await snapshot()
      assert.equal(getAccount(state, 0).modelContextWindows, undefined)
      assert.deepEqual(getAccount(state, 1).modelContextWindows, { [model]: 256000 })
      await openConnection(1)
      await select(model, '自定义')
      const custom = `.ant-drawer-open [aria-label=${JSON.stringify('自定义上下文窗口 · ' + model)}]`
      await wait(`!!document.querySelector(${JSON.stringify(custom)})`)
      await run(`(()=>{const node=document.querySelector(${JSON.stringify(custom)}),input=node.matches('input')?node:node.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'333333');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur()})()`)
      await capture('connection-custom-window.png')
      await saveConnection(1)
      state = await snapshot()
      assert.deepEqual(getAccount(state, 1).modelContextWindows, { [model]: 333333 })
      await openConnection(1)
      assert.equal(await run(`(()=>{const node=document.querySelector(${JSON.stringify(custom)});return (node.matches('input')?node:node.querySelector('input')).value})()`), '333333')
      await click('.ant-drawer-open button', '取消')
      await wait('!document.querySelector(".ant-drawer-open")')
      await openConnection(2)
      await wait(`document.querySelector(${JSON.stringify('.ant-drawer-open input[aria-label="账号 API Key"]')})?.value==='fixture-independent-context-key'`)
      assert.match(await selectionText(fallbackModel), /未设置 · 使用默认值 \d+K/)
      await select(fallbackModel, '128K · 128,000 tokens')
      await saveConnection(2)
      state = await snapshot()
      assert.deepEqual(getAccount(state, 2).modelContextWindows, { [fallbackModel]: 128000 })
      assert.deepEqual(state.providers[0].modelContextWindows, { [model]: 1000000 })
      const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault'))))
      assert.deepEqual(stored.accounts.find(account => account.id === accounts[1].id).modelContextWindows, { [model]: 333333 })
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, seededConnections: 3, independentConnectionWindows: true, presetSaved: 512000, otherConnectionSaved: 256000, supplierUpdated: 1000000, clearRestoresInheritance: true, customSavedAndReopened: 333333, standaloneSaved: 128000, modelDefaultValueDisplayed: true, persistedInEncryptedVault: true, realUpstreamRequests: 0, realAccountsTouched: false, officialClientLaunched: false }, null, 2))
      console.log('Connection context UI passed: per-connection presets/custom values; supplier defaults displayed; supplier update preserves both overrides; clear restores inheritance; standalone API connection supported; reopen and encrypted-vault persistence verified. Synthetic isolated vault only.')
      clearTimeout(timer); app.exit(0)
    } catch (error) {
      console.error(error)
      fs.writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      fs.writeFileSync(join(output, 'failure.txt'), await run('document.body.innerText'))
      fs.writeFileSync(join(output, 'failure-dom.html'), await run('document.querySelector(".ant-drawer-open")?.outerHTML??document.body.innerHTML'))
      clearTimeout(timer); app.exit(1)
    }
  })
})
require('../out/main/index.js')
