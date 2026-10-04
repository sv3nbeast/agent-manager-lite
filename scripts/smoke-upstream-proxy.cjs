// Real Manager renderer/IPC + source-built HTTP helper, ephemeral AES-GCM vault,
// loopback HTTP proxy and loopback targets. No official client or public IP API.
const { app, safeStorage, ipcMain } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID, generateKeyPairSync } = require('node:crypto')
const { createServer } = require('node:http')
const childProcess = require('node:child_process')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)

const output = resolve('docs/evidence'), reports = resolve('.local/agent-manager-adaptation')
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(reports, { recursive: true })
const secrets = ['fixture-default-proxy-secret', 'fixture-provider-model-key', 'fixture-oauth-access']
const requests = [], commands = [], servers = []
let targetURL, proxyURL, authenticatedProxy, rejectProxy = false, holdProbe = false, heldResponses = []
let directHits = 0, proxyHits = 0, cancelledConnections = 0, helperRequests = 0
let delayReplyCommand, releaseReply, delayedReplyReady = false, delayedReplyDelivered = false
const resourceId = randomUUID()
const accountIds = Object.fromEntries(['oauth', 'agent_identity', 'api_key', 'legacy', 'invalid'].map(kind => [kind, randomUUID()]))

// Delay a completed, real IPC probe reply to exercise renderer cancellation and
// reopen isolation. Transport and service validation run before this barrier.
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
  if (channel === 'manager:invoke') commands.push({ command: args[0], hasURL: typeof args[1]?.url === 'string', mode: args[1]?.mode, accountId: args[1]?.accountId })
  const result = await listener(event, ...args)
  if (channel === 'manager:invoke' && args[0] === delayReplyCommand) {
    delayReplyCommand = undefined; delayedReplyReady = true
    await new Promise(resolve => { releaseReply = resolve })
    delayedReplyDelivered = true
  }
  return result
})

// The fixed public-IP URL is redirected only inside this test process. All
// other helper targets must already be loopback; real transport/auth/abort run.
const nativeSpawn = childProcess.spawn
childProcess.spawn = function (file, args, options) {
  assert.notEqual(file, '/usr/bin/security', 'No real keychain access')
  const child = nativeSpawn.apply(this, arguments)
  if (args?.includes('-egress-http')) {
    assert.equal(resolve(file), resolve('resources/bin/codex-proxy'))
    const end = child.stdin.end.bind(child.stdin)
    child.stdin.end = function (raw) {
      const request = JSON.parse(raw)
      if (request.url === 'https://api64.ipify.org?format=json') {
        assert.equal(request.headers.authorization, undefined, 'IP checks contain no account token')
        request.url = targetURL + 'ip'
      }
      assert.equal(new URL(request.url).hostname, '127.0.0.1', 'Helper refuses external target')
      if (request.proxy !== 'direct') assert.equal(new URL(request.proxy).hostname, '127.0.0.1', 'Helper refuses external proxy')
      helperRequests++
      return end(JSON.stringify(request))
    }
  }
  return child
}
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input).hostname, '127.0.0.1', 'Direct fetch refuses external targets')
  return nativeFetch(input, init)
}
const listen = async handler => {
  const server = createServer(handler); servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}/`
}
const vault = () => JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory, 'state.vault'))))
const timer = setTimeout(() => { console.error('Upstream proxy UI exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('will-quit', () => { releaseReply?.(); for (const server of servers) { server.closeAllConnections(); server.close() } })

app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1440, 1040)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => { try { return await window.webContents.executeJavaScript(`(async()=>(${code}))()`) } catch (cause) { throw new Error('Proxy renderer expression failed: ' + code, { cause }) } }
    const wait = async expression => { const end = Date.now() + 8_000; while (!await run(expression)) { assert.ok(Date.now() < end, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const waitNative = async (predicate, label) => { const end = Date.now() + 5_000; while (!predicate()) { assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const click = async (selector, text) => {
      const query = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${query})`); await run(`(${query}).click()`)
    }
    const fill = async (selector, value) => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`) }
    const settle = async () => { await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))') }
    const capture = async name => { await settle(); fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG()) }
    const settingsPage = async () => { await run('document.querySelector(".sidebar-bottom button").click()'); await wait('!!document.querySelector(".upstream-proxy-panel")'); await run('document.querySelector(".upstream-proxy-panel").scrollIntoView({block:"start"})') }
    const accountPage = async kind => {
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes(${JSON.stringify(kind === 'api_key' ? '供应商与密钥' : '账号管理')})).click()`)
      if (kind === 'api_key') { await wait('!!document.getElementById("api-connections-tab")'); await run('document.getElementById("api-connections-tab").click()') }
      await wait(`!!document.querySelector('.account-card[data-account-id="${accountIds[kind]}"]')`)
    }
    const openAccount = async kind => {
      await accountPage(kind)
      await run(`document.querySelector('.account-card[data-account-id="${accountIds[kind]}"] .account-proxy').click()`)
      await wait('!!document.querySelector(".account-proxy-dialog")')
      await settle()
    }
    const closeAccount = async () => { await click('.account-proxy-dialog button', '取消'); await wait('!document.querySelector(".account-proxy-dialog")'); await settle() }
    const modeAccount = async label => {
      await run('document.querySelector(".account-proxy-dialog .proxy-mode .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
      await click('.ant-select-item-option', label)
    }
    const modeGlobal = label => click('.upstream-proxy-panel .ant-segmented-item-label', label)
    const load = () => run('window.manager.load()')
    const reloadUI = async () => {
      await accountPage('oauth')
      await run('document.querySelector("button[aria-label=重新加载账号]").click()')
      await wait('!document.querySelector(".ant-spin-spinning")'); await settle()
    }
    const checkNoSecrets = snapshot => { for (const secret of secrets) assert.equal(JSON.stringify(snapshot).includes(secret), false, 'Snapshots omit secrets') }
    const fetchModels = () => run(`window.manager.fetchProviderModels(${JSON.stringify({ requestId: randomUUID(), baseUrl: targetURL + 'v1', apiKey: secrets[1] })})`)
    try {
      await wait('!!document.querySelector(".instances-panel")')
      await settingsPage()
      let snapshot = await load()
      assert.equal(snapshot.upstreamProxy.invalid, true, 'Legacy invalid default is shown honestly')
      assert.equal(await run('document.querySelector(".upstream-proxy-panel").textContent.includes("已保存的代理配置无效")'), true)
      assert.equal(await run('!!document.querySelector(".proxy-resources-panel,.advanced-network,.proxy-engine-panel")'), false, 'Lightweight settings expose no resource/engine tools')
      const initialDirect = directHits, initialProxy = proxyHits
      const invalidDiscovery = await run(`window.manager.fetchProviderModels(${JSON.stringify({ requestId: randomUUID(), baseUrl: targetURL + 'v1', apiKey: secrets[1] })}).then(()=>'',cause=>String(cause))`)
      assert.match(invalidDiscovery, /代理地址无效|默认网络代理配置无效|无法连接接口，请检查地址、网络或代理/)
      assert.equal(directHits, initialDirect); assert.equal(proxyHits, initialProxy)
      await fill('[aria-label="默认网络代理地址"]', 'unsupported://fixture:fixture-default-proxy-secret@localhost:1')
      await click('.upstream-proxy-panel button', '保存代理')
      await wait('document.querySelector(".upstream-proxy-panel .ant-alert-error")?.textContent.includes("代理地址无效")')
      assert.equal((await load()).upstreamProxy.revision, 0, 'Rejected save never advances revision')
      await fill('[aria-label="默认网络代理地址"]', authenticatedProxy)
      await click('.upstream-proxy-panel button', '保存代理')
      await wait('document.querySelector("[aria-label=默认网络代理地址]")?.value===""')
      snapshot = await load(); checkNoSecrets(snapshot)
      assert.equal(snapshot.upstreamProxy.mode, 'custom'); assert.equal(snapshot.upstreamProxy.revision, 1)
      assert.equal(snapshot.upstreamProxy.authenticated, true)
      assert.equal(vault().upstreamProxy.url, authenticatedProxy)
      assert.equal(await run('document.querySelector(".proxy-saved-summary strong").textContent'), `127.0.0.1:${new URL(proxyURL).port}`)
      await capture('upstream-proxy-global-light.png')
      const models = await fetchModels()
      assert.deepEqual(models.models.map(model => model.id), ['fixture-model-a', 'fixture-model-b'])
      assert.equal(directHits, initialDirect, 'Global discovery reaches proxy only')
      assert.equal(requests.at(-1).route, '/v1/models'); assert.equal(requests.at(-1).authorizationPresent, true)
      await click('.upstream-proxy-panel button', '检测出口')
      await wait('document.querySelector(".upstream-proxy-panel").textContent.includes("203.0.113.22")')
      assert.equal(commands.filter(value => value.command === 'probeUpstreamProxy').at(-1).mode, 'saved')
      assert.equal(commands.filter(value => value.command === 'probeUpstreamProxy').at(-1).hasURL, false)
      snapshot = await run(`window.manager.saveUpstreamProxy({revision:${snapshot.upstreamProxy.revision},mode:'custom'})`)
      assert.equal(vault().upstreamProxy.url, authenticatedProxy, 'Blank custom save retains encrypted URL')
      await reloadUI(); await settingsPage()
      // A real competing save while a dirty form is open proves pinned revision
      // conflict handling, rather than injecting a fake validation error.
      await modeGlobal('直连')
      // Keep the original dirty form open while the actual competing mutation
      // runs; refreshing the main snapshot must not change its pinned revision.
      snapshot = await load()
      await run(`window.manager.saveUpstreamProxy({revision:${snapshot.upstreamProxy.revision},mode:'custom'})`)
      await click('.upstream-proxy-panel button', '保存代理')
      await wait('document.querySelector(".upstream-proxy-panel .ant-alert-error")?.textContent.includes("默认网络代理已变化")')
      assert.equal((await load()).upstreamProxy.mode, 'custom', 'Conflicting UI write is not applied')
      await reloadUI(); await settingsPage()
      // Real helper failure and cancellation cannot fall back to a direct exit.
      rejectProxy = true; const failDirect = directHits
      await click('.upstream-proxy-panel button', '检测出口')
      await wait('document.querySelector(".upstream-proxy-panel .ant-alert-error")?.textContent.includes("HTTP 407")')
      assert.equal(directHits, failDirect); rejectProxy = false
      holdProbe = true
      await click('.upstream-proxy-panel button', '检测出口')
      await waitNative(() => heldResponses.length > 0, 'Proxy receives the held probe')
      await click('.upstream-proxy-panel button', '取消测试')
      await waitNative(() => cancelledConnections > 0, 'Cancellation stops the real helper connection')
      for (const response of heldResponses) if (!response.destroyed) response.end('{"ip":"203.0.113.250"}')
      heldResponses = []; holdProbe = false
      assert.equal(await run('document.querySelector(".upstream-proxy-panel").textContent.includes("203.0.113.250")'), false)
      delayReplyCommand = 'probeUpstreamProxy'; delayedReplyReady = false; delayedReplyDelivered = false
      await click('.upstream-proxy-panel button', '检测出口')
      await waitNative(() => delayedReplyReady, 'Completed IPC reply reaches the delay gate')
      await click('.upstream-proxy-panel button', '取消测试')
      await modeGlobal('直连'); releaseReply()
      await waitNative(() => delayedReplyDelivered, 'Old IPC reply is released')
      await settle()
      assert.equal(await run('!!document.querySelector(".upstream-proxy-panel .ant-alert-success")'), false, 'Cancelled late reply never becomes current result')
      await click('.upstream-proxy-panel button', '放弃更改')
      snapshot = await load()
      await run(`window.manager.saveSettings(${JSON.stringify({ ...snapshot.settings, theme: 'dark' })})`)
      await run('window.manager.load()'); await wait('!!document.querySelector(".app-shell.dark")')
      await capture('upstream-proxy-global-dark.png')

      const savedKinds = []
      for (const kind of ['oauth', 'agent_identity', 'api_key']) {
        await openAccount(kind)
        await run('document.querySelector(".account-proxy-dialog .proxy-mode .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
        await wait('document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").length===3')
        assert.deepEqual(await run('Array.from(document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")).map(el=>el.textContent)'), ['默认网络', '直连', '指定代理'])
        await click('.ant-select-item-option', '指定代理')
        await fill('[aria-label="账号网络代理地址"]', authenticatedProxy)
        await click('.account-proxy-dialog button', '保存代理'); await wait('!document.querySelector(".account-proxy-dialog")')
        snapshot = await load(); const account = snapshot.accounts.find(value => value.id === accountIds[kind])
        assert.equal(account.egressProxy.mode, 'custom'); checkNoSecrets(snapshot)
        await openAccount(kind)
        assert.equal(await run('document.querySelector("[aria-label=账号网络代理地址]").value'), '')
        await click('.account-proxy-dialog button', '检测出口')
        await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.22")')
        assert.equal(commands.filter(value => value.command === 'probeAccountProxy').at(-1).mode, 'saved')
        const retained = await run(`window.manager.saveAccountProxy({accountId:${JSON.stringify(account.id)},revision:${account.revision ?? 0},mode:'custom'})`)
        assert.equal(vault().accounts.find(value => value.id === account.id).proxy.url, authenticatedProxy)
        assert.equal(retained.accounts.find(value => value.id === account.id).egressProxy.mode, 'custom')
        await closeAccount(); await reloadUI(); await openAccount(kind); await modeAccount('直连')
        await click('.account-proxy-dialog button', '保存代理'); await wait('!document.querySelector(".account-proxy-dialog")')
        await openAccount(kind); const beforeDirectProxy = proxyHits
        await click('.account-proxy-dialog button', '检测出口')
        await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.21")')
        assert.equal(proxyHits, beforeDirectProxy, 'Account direct overrides global proxy')
        await modeAccount('默认网络')
        await click('.account-proxy-dialog button', '保存代理'); await wait('!document.querySelector(".account-proxy-dialog")')
        snapshot = await load()
        assert.equal(snapshot.accounts.find(value => value.id === accountIds[kind]).egressProxy.mode, 'inherit')
        savedKinds.push(kind)
      }
      // Existing resource bindings remain visible, but the resource manager is
      // not restored and brand-new accounts never get a resource choice.
      await openAccount('legacy')
      assert.equal(await run('document.querySelector(".proxy-resource-choice .ant-select-selection-item").getAttribute("title")'), '旧手动代理')
      assert.equal(await run('document.querySelector(".proxy-mode .ant-select-selection-item").getAttribute("title")'), '已保存代理资源')
      await closeAccount()
      await openAccount('invalid'); const invalidDirect = directHits
      assert.equal(await run('document.querySelector(".account-proxy-dialog").textContent.includes("已保存的代理配置无效")'), true)
      const invalidAccount = (await load()).accounts.find(value => value.id === accountIds.invalid)
      const invalidProbe = await run(`window.manager.probeAccountProxy(${JSON.stringify({ accountId: invalidAccount.id, revision: invalidAccount.revision ?? 0, requestId: randomUUID(), mode: 'saved' })}).then(()=>'',cause=>String(cause))`)
      assert.match(invalidProbe, /代理地址无效|账号代理配置无效/); assert.equal(directHits, invalidDirect)
      await closeAccount()
      await openAccount('oauth'); await modeAccount('指定代理')
      await fill('[aria-label="账号网络代理地址"]', authenticatedProxy)
      const oauthBefore = (await load()).accounts.find(value => value.id === accountIds.oauth)
      await run(`window.manager.editAccount(${JSON.stringify({ id: oauthBefore.id, revision: oauthBefore.revision ?? 0, changes: { note: '真实并发修订' } })})`)
      await run('window.manager.load()'); await click('.account-proxy-dialog button', '保存代理')
      await wait('document.querySelector(".account-proxy-dialog .ant-alert-error")?.textContent.includes("账号已变化")')
      assert.equal((await load()).accounts.find(value => value.id === oauthBefore.id).egressProxy.mode, 'inherit')
      await closeAccount(); await reloadUI(); await openAccount('oauth')
      delayReplyCommand = 'probeAccountProxy'; delayedReplyReady = false; delayedReplyDelivered = false
      await click('.account-proxy-dialog button', '检测出口'); await waitNative(() => delayedReplyReady, 'Account IPC reply reaches delay gate')
      await closeAccount(); await openAccount('agent_identity'); releaseReply()
      await waitNative(() => delayedReplyDelivered, 'Old account reply is released'); await settle()
      assert.equal(await run('!!document.querySelector(".account-proxy-dialog .ant-alert-success")'), false, 'Old account result cannot appear in another account')
      await capture('upstream-proxy-account-dark.png'); await closeAccount()
      snapshot = await load()
      await run(`window.manager.saveSettings(${JSON.stringify({ ...snapshot.settings, theme: 'dark' })})`); await run('window.manager.load()')
      await wait('!!document.querySelector(".app-shell.dark")')
      await openAccount('api_key'); await capture('upstream-proxy-connection-dark.png'); await closeAccount()
      // Explicit global direct preserves per-account configs and reaches the
      // loopback provider directly without touching proxy credentials.
      await settingsPage(); await modeGlobal('直连'); await click('.upstream-proxy-panel button', '保存代理')
      await wait('document.querySelector(".upstream-proxy-panel .proxy-saved-summary strong").textContent==="直连"')
      const proxyBeforeDirect = proxyHits; await fetchModels(); assert.equal(proxyHits, proxyBeforeDirect)
      await modeGlobal('默认网络'); await click('.upstream-proxy-panel button', '保存代理')
      await wait('document.querySelector(".upstream-proxy-panel .proxy-saved-summary strong").textContent==="默认网络"')
      snapshot = await load(); checkNoSecrets(snapshot)
      assert.equal(snapshot.accounts.find(value => value.id === accountIds.legacy).egressProxy.mode, 'resource')
      assert.equal(snapshot.accounts.find(value => value.id === accountIds.invalid).egressProxy.invalid, true)
      fs.writeFileSync(join(reports, 'upstream-proxy-ui-audit.json'), JSON.stringify({ savedKinds, proxyHits, directHits, helperRequests, cancelledConnections, requests, commands,
        screenshots: ['upstream-proxy-global-light.png', 'upstream-proxy-global-dark.png', 'upstream-proxy-account-dark.png', 'upstream-proxy-connection-dark.png'],
        lateGlobalReplyIsolated: true, lateAccountReplyIsolated: true, realPublicIPRequests: 0, realCredentials: false }, null, 2))
      console.log('Upstream proxy UI passed: actual global draft/save/blank preservation, source-built authenticated loopback proxy and model discovery, invalid/refused fail-closed, real revision conflicts, helper cancellation and delayed IPC isolation, all credential kinds with custom/direct/default modes, API connection entry and retained legacy resource, secret-free snapshots, light/dark screenshots. No real ipify, official client, credentials or keychain.')
      clearTimeout(timer); app.quit()
    } catch (cause) {
      console.error(cause); await capture('upstream-proxy-failure.png').catch(() => {})
      clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit()
    }
  })
})

;(async () => {
  targetURL = await listen((req, res) => {
    directHits++; assert.equal(req.headers['proxy-authorization'], undefined)
    if (req.url === '/ip') { assert.equal(req.headers.authorization, undefined); res.end('{"ip":"203.0.113.21"}') }
    else { assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer ' + secrets[1]); res.end('{"data":[{"id":"fixture-model-a"},{"id":"fixture-model-b"}]}') }
  })
  proxyURL = await listen((req, res) => {
    proxyHits++
    const url = new URL(req.url); assert.equal(url.origin, new URL(targetURL).origin)
    assert.equal(req.headers['proxy-authorization'], 'Basic ' + Buffer.from('fixture:' + secrets[0]).toString('base64'))
    requests.push({ route: url.pathname, authorizationPresent: !!req.headers.authorization, authenticatedProxy: true })
    if (url.pathname === '/ip') {
      assert.equal(req.headers.authorization, undefined)
      if (holdProbe) { heldResponses.push(res); res.on('close', () => { if (!res.writableEnded) cancelledConnections++ }); return }
      if (rejectProxy) { res.statusCode = 407; res.end(secrets[0]); return }
      res.end('{"ip":"203.0.113.22"}')
    } else { assert.equal(url.pathname, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer ' + secrets[1]); res.end('{"data":[{"id":"fixture-model-a"},{"id":"fixture-model-b"}]}') }
  })
  authenticatedProxy = proxyURL.replace('://', '://fixture:' + secrets[0] + '@')
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const base = (id, name, kind, credentials, proxy) => ({ id, generation: randomUUID(), revision: 0, name, kind, credentials, ...(proxy ? { proxy } : {}), baseUrl: targetURL + 'v1', models: ['fixture-model-a'], wireApi: 'responses', defaultTier: 'inherit', tags: [], note: '', createdAt: Date.now() })
  const accounts = [
    base(accountIds.oauth, '登录账号', 'oauth', { accessToken: secrets[2] }),
    base(accountIds.agent_identity, '签名身份', 'agent_identity', { agentIdentity: { agent_runtime_id: 'fixture-runtime', agent_private_key: privateKey, account_id: 'fixture-org', chatgpt_user_id: 'fixture-user' } }),
    base(accountIds.api_key, 'API 连接', 'api_key', { apiKey: secrets[1] }),
    base(accountIds.legacy, '已有资源账号', 'oauth', { accessToken: secrets[2] + '-legacy' }, { mode: 'resource', resourceId }),
    base(accountIds.invalid, '无效代理账号', 'oauth', { accessToken: secrets[2] + '-invalid' }, { mode: 'custom', url: 'invalid-proxy-config' })
  ]
  fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { theme: 'light', refreshMinutes: 0 }, groups: [], accounts,
    upstreamProxy: { revision: 0, mode: 'custom', url: 'invalid-default-proxy-config' }, proxyResources: [{ id: resourceId, revision: 0, name: '旧手动代理', url: authenticatedProxy }] })), { mode: 0o600 })
  require('../out/main/index.js')
})().catch(cause => { console.error(cause); clearTimeout(timer); app.exit(1) })
