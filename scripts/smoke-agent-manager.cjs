// Instance-led product acceptance. Actual Manager renderer/IPC; temporary
// encrypted vault, synthetic login and loopback provider. No official client UI.
const { app, safeStorage, dialog, ipcMain } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], accounts: [] })), { mode: 0o600 })
const application = join(fs.realpathSync(directory), 'Fixture.app')
const executable = join(application, 'Contents', 'MacOS', 'Codex')
fs.mkdirSync(join(application, 'Contents', 'MacOS'), { recursive: true })
fs.writeFileSync(join(application, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.aml.fixture.${randomUUID()}</string><key>CFBundleName</key><string>AML Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
execFileSync('go', ['build', '-o', executable, 'tests/fixtures/desktop-client.go'], { cwd: resolve('.'), timeout: 30_000, stdio: 'pipe' })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
const output = resolve('docs/evidence'), reports = resolve('.local/agent-manager-adaptation')
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(reports, { recursive: true })
const exp = Math.floor(Date.now() / 1000) + 7200
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp, email: 'inline-account@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-inline-account', chatgpt_user_id: 'fixture-inline-user' } })).toString('base64url') + '.signature'
const tokenJSON = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, id_token: jwt, refresh_token: 'fixture-inline-refresh', account_id: 'fixture-inline-account' } })
const providerSecret = 'fixture-agent-manager-provider-secret'
// Delay one actual IPC boundary to reproduce cancel/reopen while the resource
// creation promise is outstanding. The original Manager handler still runs.
let delayCreateAccount = false, releaseCreateAccount, delayedCreationComplete = false
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
  if (channel === 'manager:invoke' && args[0] === 'mutateProvider' && args[1]?.action === 'createAccount' && delayCreateAccount) {
    delayCreateAccount = false
    await new Promise(resolve => { releaseCreateAccount = resolve })
    try { return await listener(event, ...args) } finally { delayedCreationComplete = true }
  }
  return listener(event, ...args)
})

let server
const requests = []
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input)
  assert.equal(url.hostname, '127.0.0.1', 'agent-manager acceptance forbids external requests')
  return nativeFetch(input, init)
}
app.on('will-quit', () => { server?.closeAllConnections(); server?.close() })
const timer = setTimeout(() => { console.error('Agent Manager workflow exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.setContentSize(1440, 1040)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => { try { return await window.webContents.executeJavaScript(`(async()=>(${code}))()`) } catch (error) { throw new Error('Workflow renderer expression failed: ' + code, { cause: error }) } }
    const wait = async expression => { const deadline = Date.now() + 10_000; while (!await run(expression)) { assert.ok(Date.now() < deadline, 'workflow timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const click = async (selector, text) => { const query = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`; await wait(`!!(${query})`); await run(`(${query}).click()`) }
    const fill = async (selector, value) => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`) }
    const select = async (label, text) => {
      const control = await run(`(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]').closest('.ant-select');el.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return el.querySelector('input').getAttribute('aria-controls')})()`)
      const selector = '.ant-select-dropdown .ant-select-item-option'
      await click(selector, text)
    }
    const settle = async () => { await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))'); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
    const capture = async name => { await settle(); fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG()) }
    const step = async index => { await wait(`(()=>{const el=document.querySelector('.instance-step[data-step="${index}"]');return !!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0})()`); await settle() }
    const next = async index => { await click('.ant-modal-footer button', '下一步'); await step(index) }
    const openWizard = async () => {
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      await click('.instance-step[data-step="0"] button', '选择应用文件')
      await wait(`document.querySelector('.instance-step[data-step="0"]').textContent.includes('Fixture.app')`)
    }
    const resourceType = async text => click('.instance-step[data-step="1"] .ant-radio-wrapper', text)
    const configure = async name => { await next(2); await fill('[aria-label="实例名称"]', name); await fill('[aria-label="实例模型"]', 'fixture-model'); await next(3) }
    const finish = async (name, preview = false) => {
      await configure(name)
      assert.match(await run(`document.querySelector(".instance-step[data-step='3']").innerText`), /Codex/)
      await click('.ant-modal-footer button', preview ? '创建并预览' : '仅创建')
      if (preview) {
        await wait('!!document.querySelector(".instance-launch-preview")')
        assert.equal(await run(`document.querySelector('.instance-launch-preview').innerText.includes(${JSON.stringify(providerSecret)})`), false)
        assert.equal(await run(`document.querySelector('.instance-launch-preview').innerText.includes(${JSON.stringify(name.trim())})`), true, 'trimmed instance name resolves the newly saved preview')
        await capture('agent-manager-provider-preview.png')
        await run('document.querySelector(".instance-launch-preview").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      }
      await wait(`!(${visible('.instance-wizard')})`)
      await settle()
    }
    try {
      await wait('!!document.querySelector(".instances-panel")')
      assert.match(await run('document.querySelector("h1").innerText'), /实例/)
      await capture('agent-manager-instance-entry.png')
      assert.equal((await run('window.manager.load()')).instances.length, 0)
      await openWizard()
      const clientControl = await run(`(()=>{const el=document.querySelector('[aria-label="实例客户端"]').closest('.ant-select');el.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return el.querySelector('input').getAttribute('aria-controls')})()`)
      await wait(`!!document.getElementById(${JSON.stringify(clientControl)})?.closest('.ant-select-dropdown')?.querySelector('.ant-select-item-option')`)
      assert.deepEqual(await run(`Array.from(document.getElementById(${JSON.stringify(clientControl)}).closest('.ant-select-dropdown').querySelectorAll('.ant-select-item-option')).map(el=>el.textContent)`), ['Codex'])
      await click('.ant-select-dropdown .ant-select-item-option', 'Codex')
      await capture('agent-manager-client-step.png')
      await next(1); await click('.ant-modal-footer button', '返回'); await step(0)
      assert.equal(await run(`document.querySelector(".instance-step[data-step='0']").innerText.includes("Fixture.app")`), true)
      await next(1); await resourceType('账号')
      await click('.instance-step[data-step="1"] button', '添加账号')
      await wait('!!document.querySelector(".temp-login-panel")')
      assert.equal(await run('!!document.querySelector("[aria-label=账号用途]")'), false, 'inline account already carries the chosen client')
      assert.match(await run('document.querySelector(".temp-login-panel").closest(".ant-modal-content").innerText'), /Codex/)
      await run('document.querySelector(".temp-login-panel").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(`!(${visible('.temp-login-panel')})`)
      await step(1)
      assert.equal((await run('window.manager.load()')).accounts.length, 0)
      await click('.instance-step[data-step="1"] button', '添加账号')
      await wait('!!document.querySelector(".login-methods")')
      await click('.login-methods .ant-tabs-tab', 'Token')
      await fill('.credential-import-panel textarea', tokenJSON)
      await click('.credential-import-panel button', '预览粘贴内容')
      await wait('document.querySelector(".credential-preview")?.innerText.includes("inline-account@example.invalid")')
      await click('.credential-import-panel button', '确认导入')
      await wait(`!(${visible('.credential-import-panel')})`)
      await step(1)
      const imported = (await run('window.manager.load()')).accounts.find(account => account.kind === 'oauth')
      assert.ok(imported)
      assert.equal(await run(`document.querySelector('[aria-label=实例账号]').closest('.ant-select').querySelector('.ant-select-selection-item').textContent.includes(${JSON.stringify(imported.name)})`), true)
      await capture('agent-manager-inline-account.png')
      await next(2)
      await fill('[aria-label="实例名称"]', '账号工作空间')
      await fill('[aria-label="实例模型"]', 'fixture-model')
      await capture('agent-manager-project-step.png')
      await next(3); await capture('agent-manager-confirm-step.png')
      await click('.ant-modal-footer button', '返回'); await step(2)
      assert.equal(await run('document.querySelector("[aria-label=实例名称]").value'), '账号工作空间')
      await next(3); await click('.ant-modal-footer button', '仅创建')
      await wait(`!(${visible('.instance-wizard')})`)
      let snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances.length, 1); assert.equal(snapshot.instances[0].clientType, 'codex')
      assert.equal(snapshot.instances[0].accountId, imported.id)
      assert.equal(snapshot.instanceApplications.find(a => a.id === snapshot.instances[0].applicationId).path, application)
      // Duplicate imports return the exact compatible existing identity to the
      // outstanding instance draft, without adding a second account.
      await openWizard(); await next(1); await resourceType('账号')
      await click('.instance-step[data-step="1"] button', '添加账号')
      await wait(visible('.login-methods')); await click('.login-methods .ant-tabs-tab', 'Token')
      await fill('.credential-import-panel textarea', tokenJSON)
      await click('.credential-import-panel button', '预览粘贴内容')
      await wait('document.querySelector(".credential-preview")?.innerText.includes("inline-account@example.invalid")')
      await click('.credential-import-panel button', '确认导入')
      await wait(`!(${visible('.credential-import-panel')})`); await step(1)
      assert.equal((await run('window.manager.load()')).accounts.length, 1)
      assert.equal(await run(`document.querySelector('[aria-label=实例账号]').closest('.ant-select').querySelector('.ant-select-selection-item').textContent.includes(${JSON.stringify(imported.name)})`), true)
      await capture('agent-manager-duplicate-inline-account.png')
      await click('.ant-modal-footer button', '取消'); await wait(`!(${visible('.instance-wizard')})`)

      await openWizard(); await next(1); await resourceType('供应商密钥')
      await click('.instance-step[data-step="1"] button', '添加供应商')
      await wait('!!document.querySelector(".instance-provider-dialog")')
      await fill('.instance-provider-dialog [aria-label="供应商名称"]', '共享供应商')
      await fill('.instance-provider-dialog [aria-label="供应商地址"]', `http://127.0.0.1:${server.address().port}/v1`)
      await fill('.instance-provider-dialog [aria-label="供应商密钥"]', providerSecret)
      await click('.instance-provider-dialog .model-discovery button', '从 API 获取模型')
      await wait('document.querySelector(".instance-provider-dialog .model-discovery").innerText.includes("已获取 1 个模型")')
      await click('.instance-provider-dialog .model-discovery button', '全部加入')
      await click('.ant-modal-footer button', '添加并使用')
      await wait(`!(${visible('.instance-provider-dialog')})`); await step(1)
      assert.match(await run('document.querySelector("[aria-label=实例供应商密钥]").closest(".ant-select").innerText'), /共享供应商/)
      await capture('agent-manager-inline-provider.png')
      await finish(' 共享供应商实例 1 ', true)
      snapshot = await run('window.manager.load()')
      const provider = snapshot.providers.find(p => p.name === '共享供应商'), first = snapshot.instances.find(i => i.name === '共享供应商实例 1')
      assert.ok(provider && first); assert.equal(provider.keys.length, 1)
      const priorAccountCount = snapshot.accounts.length
      await openWizard(); await next(1); await resourceType('供应商密钥')
      const providerControl = await run(`(()=>{const el=document.querySelector('[aria-label="实例供应商密钥"]').closest('.ant-select');el.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return el.querySelector('input').getAttribute('aria-controls')})()`)
      await wait(`Array.from(document.getElementById(${JSON.stringify(providerControl)})?.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option')??[]).some(el=>el.textContent.includes('共享供应商'))`)
      await run(`Array.from(document.getElementById(${JSON.stringify(providerControl)}).closest('.ant-select-dropdown').querySelectorAll('.ant-select-item-option')).find(el=>el.textContent.includes('共享供应商')).click()`)
      await finish('共享供应商实例 2')
      snapshot = await run('window.manager.load()')
      const second = snapshot.instances.find(i => i.name === '共享供应商实例 2')
      assert.ok(second); assert.equal(second.accountId, first.accountId); assert.notEqual(second.directory, first.directory)
      assert.equal(snapshot.accounts.length, priorAccountCount); assert.equal(snapshot.providers.find(p => p.id === provider.id).keys.length, 1)
      const connection = snapshot.accounts.find(a => a.id === first.accountId)
      assert.equal(connection.providerId, provider.id); assert.equal(connection.providerKeyId, provider.keys[0].id)
      const unsupported = { details: { name: 'Unsupported', clientType: 'claude-desktop', applicationId: first.applicationId, accountId: first.accountId, connectionMode: 'local_api', model: 'fixture-model', defaultTier: 'inherit', extraArgs: [] } }
      assert.equal(await run(`window.manager.saveInstance(${JSON.stringify(unsupported)}).then(()=>false,error=>String(error).includes('clientType'))`), true)
      assert.equal((await run('window.manager.load()')).instances.length, 3)
      await openWizard(); await next(1); await click('.ant-modal-footer button', '取消')
      await wait(`!(${visible('.instance-wizard')})`)
      assert.equal((await run('window.manager.load()')).instances.length, 3)
      await capture('agent-manager-shared-key-instances.png')
      // A cancelled old draft must not advance or save a newly opened draft
      // when delayed shared-connection creation eventually completes.
      const currentProvider = snapshot.providers.find(p => p.id === provider.id)
      await run(`window.manager.mutateProvider(${JSON.stringify({action:'addKey',id:currentProvider.id,revision:currentProvider.revision,name:'延迟密钥',apiKey:'fixture-delayed-key',createConnection:false})})`)
      await run(`document.querySelector('.instances-panel .toolbar button').click()`)
      await openWizard(); await next(1); await resourceType('供应商密钥')
      await select('实例供应商密钥', '共享供应商 · 延迟密钥')
      delayCreateAccount = true
      await click('.ant-modal-footer button', '下一步')
      const pendingDeadline = Date.now() + 10_000
      while (!releaseCreateAccount) { assert.ok(Date.now() < pendingDeadline, 'actual createAccount IPC did not enter delayed boundary'); await new Promise(resolve => setTimeout(resolve, 25)) }
      await run('document.querySelector(".instance-wizard").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      await wait(`!(${visible('.instance-wizard')})`)
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      assert.equal(await run('document.querySelector("[aria-label=实例名称]").value'), '')
      releaseCreateAccount()
      const completionDeadline = Date.now() + 10_000
      while (!delayedCreationComplete) { assert.ok(Date.now() < completionDeadline, 'delayed actual IPC did not complete'); await new Promise(resolve => setTimeout(resolve, 25)) }
      await settle(); await step(0)
      assert.equal(await run('document.querySelector("[aria-label=实例名称]").value'), '', 'late result does not overwrite new draft')
      assert.equal((await run('window.manager.load()')).instances.length, 3, 'cancelled old draft never saves an instance')
      await capture('agent-manager-cancelled-resource-draft.png')
      await click('.ant-modal-footer button', '取消'); await wait(`!(${visible('.instance-wizard')})`)

      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('账号管理')).click()`)
      await wait('document.querySelector("h1")?.textContent==="你的账号"')
      await click('.page-heading button', '添加账号')
      await wait('!!document.querySelector("[aria-label=账号用途]")')
      assert.match(await run('document.querySelector("[aria-label=账号用途]").closest(".ant-select").textContent'), /Codex/)
      await capture('agent-manager-account-purpose.png')
      await run('document.querySelector("[aria-label=账号用途]").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
      const evidence = { clientTypes: ['codex'], unsupportedClientRejected: true, instanceCount: 3, providerId: provider.id, keyId: provider.keys[0].id, sharedConnectionId: first.accountId, reusedBy: [first.id, second.id], distinctDirectories: true, inlineAccountReturned: true, duplicateInlineAccountReturned: true, trimmedNamePreviewed: true, cancelledAsyncDraftDiscarded: true, cancelledDraftSaved: false, requests, realUpstreamRequests: 0, officialClientLaunched: false }
      fs.writeFileSync(join(reports, 'agent-manager-workflow-audit.json'), JSON.stringify(evidence, null, 2))
      console.log('Agent Manager workflow passed: default instance entrance; Codex-only capabilities; wizard back/cancel; inline Token and duplicate import resume the exact selected account; trimmed names preview correctly; cancelled delayed resource creation cannot advance a reopened draft; inline provider discovery; same provider key and connection reused by two isolated instances; unsupported client rejected; standalone account purpose. Temporary encrypted vault, loopback models, no official client launch or external upstream.')
      clearTimeout(timer); app.quit()
    } catch (error) { console.error(error); await capture('agent-manager-workflow-failure.png').catch(() => {}); clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit() }
  })
})
app.whenReady().then(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method })
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer ' + providerSecret)
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
})
require('../out/main/index.js')
