// Login and local migration exercise using the shipped IPC, synthetic local
// files and an isolated AES-GCM vault. No real provider or keychain is used.
const { app, safeStorage, dialog, shell, ipcMain } = require('electron')
const fs = require('node:fs'), { join, resolve, basename, sep } = require('node:path')
const { tmpdir } = require('node:os'), { createHash } = require('node:crypto')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
const stats = require('./test-vault.cjs').installTestVault(safeStorage)
const sourceRoot = fs.mkdtempSync(join(tmpdir(), 'cml-local-onboarding-source-'))
const library = join(sourceRoot, '兼容账号库'), accountFolder = join(library, 'codex_accounts')
fs.mkdirSync(accountFolder, { recursive: true })
const writeJSON = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const token = name => Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ email: name + '@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: name, chatgpt_plan_type: 'plus' } })).toString('base64url') + '.fixture'
const auth = name => ({ account_name: name, auth_mode: 'oauth', tokens: { access_token: token(name), id_token: token(name), refresh_token: 'fixture-refresh-' + name, account_id: name } })
const authFile = join(sourceRoot, 'auth.json')
writeJSON(authFile, auth('json-file'))
writeJSON(join(library, 'codex_accounts.json'), { version: '1.0', detail_schema_version: 2, accounts: [
  { id: 'oauth-one', email: 'migration@example.invalid', plan_type: 'plus', created_at: 1760000000, last_used: 1760000001 },
  { id: 'api-one', email: 'api@example.invalid', plan_type: 'custom', created_at: 1760000000, last_used: 1760000001 }
], current_account_id: 'oauth-one' })
writeJSON(join(accountFolder, 'oauth-one.json'), { id: 'oauth-one', email: 'migration@example.invalid', auth_mode: 'oauth', account_name: '迁移 ChatGPT', account_note: '保留迁移备注', tags: ['工作'], app_speed: 'fast', account_id: 'migration-workspace', plan_type: 'plus', created_at: 1760000000, tokens: { access_token: token('migration'), id_token: token('migration'), refresh_token: 'fixture-migration-refresh' } })
writeJSON(join(accountFolder, 'api-one.json'), { id: 'api-one', email: 'api@example.invalid', auth_mode: 'apikey', account_name: '迁移主连接', tags: ['工作'], app_speed: 'standard', created_at: 1760000000, openai_api_key: 'fixture-migration-api-one', api_base_url: 'https://provider.example.invalid/v1', api_provider_id: 'cmp-one', api_model_catalog: ['custom-model'], api_wire_api: 'responses', tokens: { access_token: '', id_token: '' } })
writeJSON(join(library, 'codex_model_providers.json'), [{ id: 'cmp-one', name: '迁移供应商', baseUrl: 'https://provider.example.invalid/v1', modelCatalog: ['custom-model'], wireApi: 'responses', supportsWebsockets: false, supportsVision: false, createdAt: 1760000000000, updatedAt: 1760000001000, apiKeys: [
  { id: 'cmk-one', name: '主密钥', apiKey: 'fixture-migration-api-one', createdAt: 1760000000000, updatedAt: 1760000001000 },
  { id: 'cmk-two', name: '备用密钥', apiKey: 'fixture-migration-api-two', createdAt: 1760000000000, updatedAt: 1760000001000 }
] }])
writeJSON(join(library, 'codex_account_groups.json'), [{ id: 'cgrp-one', name: '工作', sortOrder: 0, accountIds: ['oauth-one', 'api-one'], createdAt: 1760000000000, quotaAutoRefreshMinutes: -1 }])
const hash = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex')
const treeHashes = root => {
  const files = []
  const walk = path => { for (const entry of fs.readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else files.push([file.slice(root.length + 1), hash(file)]) } }
  walk(root); return files.sort(([a], [b]) => a.localeCompare(b))
}
const originals = treeHashes(sourceRoot)
let holdAccountFile = false, releaseAccountFile, markFileSelectionStarted, markFileSelectionCancelled
const accountFileGate = new Promise(resolve => { releaseAccountFile = resolve })
const accountFileStarted = new Promise(resolve => { markFileSelectionStarted = resolve })
const accountFileCancelled = new Promise(resolve => { markFileSelectionCancelled = resolve })
dialog.showOpenDialog = async (_window, options) => {
  if (!options.properties.includes('openDirectory') && holdAccountFile) { markFileSelectionStarted(); await accountFileGate }
  return { canceled: false, filePaths: [options.properties.includes('openDirectory') ? library : authFile] }
}
const opened = []
shell.openExternal = async url => { opened.push(url) }
// Browser authorization only creates a local callback listener in this test.
// Use an ephemeral port so an existing user client on 1455 stays untouched.
const net = require('node:net'), originalListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  if (args[0] === 1455 && args[1] === '127.0.0.1') args[0] = 0
  return originalListen.apply(this, args)
}
// Delay one *response* after the real stage so closing/reopening the modal
// proves that an old result only discards its own opaque ticket.
const originalHandle = ipcMain.handle.bind(ipcMain)
let lateTicket, releaseLatePreview, markLateStage, markLateDiscard
const latePreviewGate = new Promise(resolve => { releaseLatePreview = resolve })
const latePreviewStaged = new Promise(resolve => { markLateStage = resolve })
const lateTicketDiscarded = new Promise(resolve => { markLateDiscard = resolve })
let legacyTicket, releaseLegacyPreview, markLegacyStage, markLegacyDiscard
const legacyPreviewGate = new Promise(resolve => { releaseLegacyPreview = resolve })
const legacyPreviewStaged = new Promise(resolve => { markLegacyStage = resolve })
const legacyTicketDiscarded = new Promise(resolve => { markLegacyDiscard = resolve })
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  const result = await listener(...args)
  if (channel === 'manager:invoke' && args[1] === 'stageImport' && typeof args[2] === 'string' && args[2].includes('late-preview')) {
    lateTicket = result.ticket
    markLateStage()
    await latePreviewGate
  }
  if (channel === 'manager:invoke' && args[1] === 'discardImport' && args[2] === lateTicket) markLateDiscard()
  if (channel === 'manager:invoke' && args[1] === 'stageImport' && typeof args[2] === 'string' && args[2].includes('late-legacy-preview')) {
    legacyTicket = result.ticket
    markLegacyStage()
    await legacyPreviewGate
  }
  if (channel === 'manager:invoke' && args[1] === 'discardImport' && args[2] === legacyTicket) markLegacyDiscard()
  if (channel === 'manager:invoke' && args[1] === 'cancelImportFileSelection') markFileSelectionCancelled()
  return result
})
const output = resolve('docs/evidence'); fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Local onboarding smoke timed out'); app.exit(1) }, 65_000)
app.once('will-quit', () => fs.rmSync(sourceRoot, { recursive: true, force: true }))
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript(code)
    const wait = async code => { const end = Date.now() + 8000; while (!await run(code)) { if (Date.now() > end) throw new Error('Onboarding UI timeout: ' + code); await new Promise(resolve => setTimeout(resolve, 30)) } }
    const click = async (selector, text) => {
      const code = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getClientRects().length&&!e.disabled&&e.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${code})`); await run(`(${code}).click()`)
    }
    const fillRaw = (value, selector = '.credential-import-panel textarea') => run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const capture = async name => {
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const openLogin = async () => { await click('.page-heading button', '添加 ChatGPT 账号'); await wait('!!document.querySelector(".temp-login-panel")') }
    const closeModal = () => click('.ant-modal-wrap button.ant-modal-close', '')
    const hidden = () => wait('Array.from(document.querySelectorAll(".ant-modal-wrap")).every(e=>!e.getClientRects().length)')
    const migration = async () => {
      await openLogin(); await click('.login-methods .ant-tabs-tab', '扫描本机'); await click('.local-import-panel button', '扫描本机登录数据')
      await wait('!!document.querySelector(".local-data-dialog") && document.querySelector(".local-data-dialog").getClientRects().length>0')
      await click('.local-data-dialog button', '选择兼容数据目录')
      await wait('document.querySelectorAll(".local-data-source").length>0')
      await click('.local-data-actions button', '预览迁移')
      await wait('!!document.querySelector(".local-data-summary")')
    }
    const assertNoSecrets = async () => {
      const snapshot = await run('window.manager.load()')
      for (const secret of ['fixture-migration-api-one', 'fixture-migration-api-two', 'fixture-migration-refresh', 'fixture-refresh-json-file']) {
        assert.equal(JSON.stringify(snapshot).includes(secret), false)
        assert.equal(await run(`document.body.innerText.includes(${JSON.stringify(secret)})`), false)
      }
    }
    try {
      await run('window.manager.saveSettings({theme:"light",defaultTier:"follow",port:16321,refreshMinutes:0,launchAtLogin:false})')
      await openLogin()
      assert.deepEqual(await run('Array.from(document.querySelectorAll(".login-methods .ant-tabs-tab")).map(e=>e.textContent.trim())'), ['官方客户端', '浏览器授权', 'Token', 'JSON / 文件', '扫描本机'])
      for (const application of (await run('window.manager.load()')).instanceApplications ?? []) {
        if (!application.supportsTempLogin) assert.equal(await run(`document.querySelector(".temp-login-panel").innerText.includes(${JSON.stringify(application.path)})`), false)
      }
      await capture('onboarding-login-methods.png')
      await click('.login-methods .ant-tabs-tab', '浏览器授权')
      assert.equal(await run('document.querySelector(".oauth-panel").innerText.includes("设备码登录")'), true)
      await capture('onboarding-oauth-options.png')
      await click('.oauth-choice button', '浏览器登录')
      await wait('document.querySelector(".oauth-panel").innerText.includes("重新打开授权页面")')
      assert.equal((await run('window.manager.load()')).login.method, 'browser')
      assert.equal(await run('document.querySelector(".manual-callback").innerText.includes("浏览器未自动回到应用")'), true)
      await closeModal(); await hidden()
      await wait('(async()=>((await window.manager.load()).login.status==="cancelled"))()')
      await openLogin()
      await click('.login-methods .ant-tabs-tab', 'Token')
      const invalid = 'this is not a valid token'
      await fillRaw(invalid); await click('.credential-actions button', '预览粘贴内容')
      await wait('document.querySelector(".credential-import-panel .ant-alert-error")!==null')
      assert.equal(await run('document.querySelector(".credential-import-panel textarea").value'), invalid)
      const tokenLines = token('token-line') + '\nfixture-refresh-secondary'
      await fillRaw(tokenLines); await click('.credential-actions button', '预览粘贴内容')
      await wait('document.querySelector(".credential-preview")?.textContent.includes("识别到 2 个账号")')
      assert.equal(await run('document.querySelector(".credential-preview").innerText.includes("fixture-refresh-secondary")'), false)
      await capture('onboarding-token-preview.png')
      await click('.credential-actions button', '确认导入'); await hidden()
      assert.equal((await run('window.manager.load()')).accounts.length, 2)

      await openLogin(); await click('.login-methods .ant-tabs-tab', 'JSON / 文件')
      await click('.credential-import-panel button', '选择账号文件')
      await wait('document.querySelector(".credential-preview")?.textContent.includes("json-file")')
      assert.equal(await run('document.querySelector(".credential-import-panel").innerText.includes("fixture-refresh-json-file")'), false)
      await click('.credential-actions button', '确认导入'); await hidden()
      assert.equal((await run('window.manager.load()')).accounts.length, 3)

      const vaultBeforeFileCancel = hash(join(directory, 'state.vault'))
      await openLogin(); await click('.login-methods .ant-tabs-tab', 'JSON / 文件')
      holdAccountFile = true
      await click('.credential-import-panel button', '选择账号文件'); await accountFileStarted
      await closeModal(); await hidden(); await accountFileCancelled
      holdAccountFile = false; releaseAccountFile()
      assert.equal(hash(join(directory, 'state.vault')), vaultBeforeFileCancel)

      await openLogin(); await click('.login-methods .ant-tabs-tab', 'Token')
      await fillRaw(JSON.stringify(auth('late-preview'))); await click('.credential-actions button', '预览粘贴内容')
      await latePreviewStaged
      await closeModal(); await hidden()
      await openLogin(); await click('.login-methods .ant-tabs-tab', 'JSON / 文件')
      assert.equal(await run('document.querySelector(".credential-import-panel textarea").value'), '')
      await fillRaw(JSON.stringify(auth('new-preview'))); await click('.credential-actions button', '预览粘贴内容')
      await wait('document.querySelector(".credential-preview")?.textContent.includes("new-preview")')
      releaseLatePreview(); await lateTicketDiscarded
      await click('.credential-actions button', '确认导入'); await hidden()
      let snapshot = await run('window.manager.load()')
      assert.equal(snapshot.accounts.length, 4); assert.equal(snapshot.accounts.some(account => account.name === 'late-preview'), false)
      assert.equal(snapshot.accounts.some(account => account.name === 'new-preview'), true)
      const first = await run(`window.manager.stageImport(${JSON.stringify(JSON.stringify(auth('discard-old')))})`)
      const second = await run(`window.manager.stageImport(${JSON.stringify(JSON.stringify(auth('discard-new')))})`)
      await run(`window.manager.discardImport(${JSON.stringify(first.ticket)})`)
      const scoped = await run(`window.manager.commitImport(${JSON.stringify(second.ticket)})`)
      assert.equal(scoped.added, 1)
      await click('button[aria-label="重新加载账号"]', '')
      await wait('document.querySelectorAll(".account-card").length===5')

      // The original file-import entry shares the stage slot with the new
      // login dialog. Its late cleanup must also preserve the newer ticket.
      await click('.page-heading button', '导入')
      await wait('!!document.querySelector(".account-import-modal textarea")')
      await fillRaw(JSON.stringify(auth('late-legacy-preview')), '.account-import-modal textarea')
      await click('.account-import-modal .modal-actions button', '预览粘贴内容'); await legacyPreviewStaged
      await closeModal(); await hidden()
      await openLogin(); await click('.login-methods .ant-tabs-tab', 'Token')
      await fillRaw(JSON.stringify(auth('legacy-new-preview'))); await click('.credential-actions button', '预览粘贴内容')
      await wait('document.querySelector(".credential-preview")?.textContent.includes("legacy-new-preview")')
      releaseLegacyPreview(); await legacyTicketDiscarded
      await click('.credential-actions button', '确认导入'); await hidden()
      snapshot = await run('window.manager.load()')
      assert.equal(snapshot.accounts.length, 6)
      assert.equal(snapshot.accounts.some(account => account.name === 'late-legacy-preview'), false)
      assert.equal(snapshot.accounts.some(account => account.name === 'legacy-new-preview'), true)

      const vaultBeforeCancel = hash(join(directory, 'state.vault'))
      await migration(); await capture('onboarding-migration-preview.png'); await assertNoSecrets()
      await run('(()=>{const body=document.querySelector(".local-data-dialog");body.scrollTop=body.scrollHeight})()')
      await capture('onboarding-migration-preview-actions.png')
      assert.equal(await run('document.querySelector(".local-data-dialog").innerText.includes("Cockpit")'), false)
      await click('.local-data-actions button', '取消'); await hidden()
      assert.equal(hash(join(directory, 'state.vault')), vaultBeforeCancel)
      assert.deepEqual(treeHashes(sourceRoot), originals)

      await migration(); await click('.local-data-actions button', '确认迁移'); await hidden()
      snapshot = await run('window.manager.load()')
      const imported = snapshot.accounts.find(account => account.name === '迁移 ChatGPT')
      assert.ok(imported); assert.equal(imported.defaultTier, 'fast'); assert.deepEqual(imported.tags, ['工作']); assert.equal(imported.note, '保留迁移备注')
      const provider = snapshot.providers.find(provider => provider.name === '迁移供应商')
      assert.ok(provider); assert.equal(provider.keys.length, 2); assert.deepEqual(provider.models, ['custom-model']); assert.equal(provider.wireApi, 'responses')
      const api = snapshot.accounts.find(account => account.name === '迁移主连接')
      assert.ok(api); assert.equal(api.providerId, provider.id); assert.ok(api.providerKeyId)
      const group = snapshot.groups.find(group => group.name === '工作')
      assert.ok(group); assert.ok(group.accountIds.includes(imported.id)); assert.ok(group.accountIds.includes(api.id))
      await assertNoSecrets(); assert.deepEqual(treeHashes(sourceRoot), originals)
      const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault'))))
      assert.equal(stored.accounts.find(account => account.id === imported.id).credentials.refreshToken, 'fixture-migration-refresh')
      const counts = [snapshot.accounts.length, snapshot.providers.length, snapshot.providers.reduce((n, item) => n + item.keys.length, 0), snapshot.groups.length]
      await capture('onboarding-migration-completed.png')
      await run('Array.from(document.querySelectorAll(".account-card")).find(card=>card.textContent.includes("迁移 ChatGPT")).scrollIntoView({block:"center"})')
      await capture('onboarding-migration-account.png')
      await migration(); await wait('document.querySelector(".local-data-dialog").innerText.includes("无需重复导入")')
      assert.equal(await run('Array.from(document.querySelectorAll(".local-data-actions button")).find(e=>e.getClientRects().length&&e.textContent.replace(/\\s/g,"")==="确认迁移").disabled'), true)
      await click('.local-data-actions button', '取消'); await hidden()
      snapshot = await run('window.manager.load()')
      assert.deepEqual([snapshot.accounts.length, snapshot.providers.length, snapshot.providers.reduce((n, item) => n + item.keys.length, 0), snapshot.groups.length], counts)
      assert.deepEqual(treeHashes(sourceRoot), originals); assert.ok(stats().encryptions > 0)
      assert.equal(opened.length, 1); assert.equal(new URL(opened[0]).pathname, '/oauth/authorize')
      console.log('Local onboarding passed: five login methods; local-only browser setup/close cancellation; Token/JSON preview and commit; failed-draft retention, close clearing, late-result and scoped-ticket protection; source selection, migration preview, cancelled-vault/source immutability, OAuth/API+multi-key provider+Fast+group preservation and repeated-import idempotency. Synthetic local files, mocked browser opening and isolated AES-GCM only.')
      clearTimeout(timer); window.destroy(); app.quit()
    } catch (error) {
      console.error(error); await capture('onboarding-failure.png').catch(() => {}); clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit()
    }
  })
})
require('../out/main/index.js')
