// Actual Electron renderer/IPC, isolated test encryption, synthetic accounts.
// Reproduces importing an independent API connection and synchronizing its key.
const { app, safeStorage, dialog } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const now = Date.now(), model = 'fixture-existing-model', secret = 'fixture-reusable-secret'
const account = { id: randomUUID(), generation: randomUUID(), revision: 0, kind: 'api_key', name: '已导入的独立连接',
  baseUrl: 'https://EXAMPLE.invalid:443/Team/v1/', models: [model], wireApi: 'responses', defaultTier: 'standard',
  modelContextWindows: { [model]: 512000 }, proxy: { mode: 'custom', url: 'http://fixture-user:fixture-pass@127.0.0.1:9123' },
  note: 'Preserve independent settings', tags: ['fixture'], createdAt: now, credentials: { apiKey: secret } }
const provider = { id: randomUUID(), revision: 0, name: '共享供应商示例', baseUrl: 'https://example.invalid/Team/v1', models: ['fixture-provider-model'],
  wireApi: 'responses', defaultTier: 'fast', modelContextWindows: { 'fixture-provider-model': 1000000 }, createdAt: now, updatedAt: now,
  excludedKeyHashes: [], keys: [] }
const application = join(fs.realpathSync(directory), 'Fixture.app'), executable = join(application, 'Contents/MacOS/Codex')
fs.mkdirSync(join(application, 'Contents/MacOS'), { recursive: true })
fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [provider], accounts: [account] })), { mode: 0o600 })
globalThis.fetch = async () => { throw new Error('Connection-reuse smoke forbids network requests') }
const output = resolve('.local/provider-connection-reuse')
fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Provider connection reuse UI exceeded 75 seconds'); app.exit(1) }, 75000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1360, 1040)
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
      const expression = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    }
    const step = index => wait(`(()=>{const el=document.querySelector('.instance-step[data-step="${index}"]');return !!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0})()`)
    const next = async index => { await click('.ant-modal-footer button', '下一步'); await step(index) }
    const capture = async name => {
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    try {
      await wait('!!document.querySelector(".instances-panel")')
      let snapshot = await run(`window.manager.mutateProvider({action:'reconcile'})`)
      assert.equal(snapshot.accounts.length, 1)
      assert.deepEqual(snapshot.providers[0].keys[0].accountIds, [])
      assert.deepEqual(snapshot.providers[0].keys[0].reusableAccountIds, [account.id])
      const before = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault')))).accounts[0]
      await click('.instances-panel button', '刷新状态')
      for (let n = 1; n <= 2; n++) {
        await click('.instances-panel .page-heading button', '创建实例'); await step(0)
        await click('.instance-step[data-step="0"] button', '选择应用文件')
        await wait('document.querySelector(".instance-step[data-step=\\"0\\"]").textContent.includes("Fixture.app")')
        await next(1)
        await wait('!!document.querySelector(".instance-reused-connection")')
        assert.match(await run('document.querySelector(".instance-reused-connection").innerText'), /已导入的独立连接.*模型、上下文、服务等级和网络代理/)
        await capture(`reuse-existing-connection-${n}.png`)
        await next(2)
        assert.equal(await run('document.querySelector("[aria-label=实例模型]").value'), model)
        assert.match(await run('document.querySelector(".instance-context-default").innerText'), /512K.*API 连接设置/)
        await fill('[aria-label="实例名称"]', `复用实例 ${n}`)
        await next(3); await click('.ant-modal-footer button', '仅创建')
        await wait(`!${visible('.instance-wizard')}.length`)
        snapshot = await run('window.manager.load()')
        assert.equal(snapshot.accounts.length, 1, 'Reuse must never duplicate an account')
        assert.equal(snapshot.instances.length, n)
        assert.ok(snapshot.instances.every(instance => instance.accountId === account.id))
        const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault'))))
        assert.deepEqual(stored.accounts[0], before, 'Creation preserves all original connection settings and credentials')
        assert.deepEqual(snapshot.providers[0].keys[0].accountIds, [], 'Reuse never establishes supplier-managed ownership')
      }
      assert.equal(new Set(snapshot.instances.map(instance => instance.directory)).size, 2, 'Instances still have separate conversation directories')
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, reconciledStandaloneReused: true, preservedOriginalAccount: true,
        accountCount: 1, instanceCount: 2, sharedAccountId: account.id, distinctInstanceDirectories: true, contextsDisplayed: 512000,
        implicitProviderLink: false, realAccountsTouched: false, externalRequests: 0, officialClientLaunched: false }, null, 2))
      console.log('Provider connection reuse UI passed: actual reconciliation IPC; same standalone key reused by two instances; models/context/tier/proxy preserved; no implicit supplier link or duplicate account; no real accounts or official client launch.')
      clearTimeout(timer); app.exit(0)
    } catch (error) {
      console.error(error)
      fs.writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      fs.writeFileSync(join(output, 'failure.txt'), await run('document.body.innerText'))
      clearTimeout(timer); app.exit(1)
    }
  })
})
require('../out/main/index.js')
