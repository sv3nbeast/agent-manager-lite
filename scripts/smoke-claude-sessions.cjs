// Isolated real renderer + session catalog IPC. All transcripts and credentials
// are synthetic. Start confirmation is observed before dispatch, so this UI
// acceptance never opens a Terminal or starts an Agent/model conversation.
const { app, safeStorage, ipcMain, shell, session } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const testDirectory = process.env.CML_TEST_DATA_DIR
assert.ok(testDirectory && fs.realpathSync(testDirectory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(testDirectory).startsWith('codex-manager-ui-'))
const directory = fs.realpathSync(testDirectory)
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const output = resolve(process.env.CML_CLAUDE_SESSIONS_EVIDENCE_DIR || '.local/claude-sessions-ui')
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
fs.rmSync(join(output, 'validation.json'), { force: true })

const cliId = randomUUID(), otherCliId = randomUUID(), desktopId = randomUUID(), codexId = randomUUID(), accountId = randomUUID()
const sessionId = randomUUID(), desktopSessionId = randomUUID(), codexSessionId = randomUUID()
const primaryProject = join(directory, 'projects', 'alpha'), otherProject = join(directory, 'projects', 'beta')
fs.mkdirSync(primaryProject, { recursive: true }); fs.mkdirSync(otherProject, { recursive: true })
const executable = join(directory, 'synthetic-claude')
execFileSync('go', ['build', '-o', executable, 'tests/fixtures/claude-client.go'], { timeout: 30_000, stdio: 'pipe' })
const now = Date.now(), instances = [
  { id: cliId, clientType: 'claude_code', launchMode: 'cli', name: 'Claude Alpha', applicationId: 'fixture-cli', accountId, connectionMode: 'native', model: 'fixture-sonnet' },
  { id: otherCliId, clientType: 'claude_code', launchMode: 'cli', name: 'Claude Beta', applicationId: 'fixture-cli', accountId, connectionMode: 'native', model: 'fixture-sonnet' },
  { id: desktopId, clientType: 'claude_code', launchMode: 'desktop', name: 'Claude Desktop local Code', applicationId: 'fixture-desktop-not-launched', accountId: '', connectionMode: 'client_login', model: '' },
  { id: codexId, clientType: 'codex', name: 'Codex reference', applicationId: 'fixture-codex-not-launched', accountId, connectionMode: 'local_api', model: 'fixture-sonnet' },
].map(value => ({ ...value, revision: 0, createdAt: now, defaultTier: 'inherit', extraArgs: [] }))
for (const instance of instances) for (const folder of ['home', 'desktop', 'workspace']) fs.mkdirSync(join(directory, 'instances', instance.id, folder), { recursive: true })
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1,
  settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [], instances,
  instanceApplications: [{ id: 'fixture-cli', clientType: 'claude_code', kind: 'cli', name: 'Synthetic Claude CLI', path: executable }],
  accounts: [{ id: accountId, revision: 0, generation: randomUUID(), kind: 'api_key', identityService: 'anthropic', credentialKind: 'anthropic_api_key', protocol: 'anthropic_messages', name: 'Synthetic Claude connection',
    baseUrl: 'https://claude-session-fixture.invalid', wireApi: 'chat_completions', models: ['fixture-sonnet'], tags: [], note: '', defaultTier: 'inherit', createdAt: now, credentials: { apiKey: 'synthetic-not-a-real-key' } }],
})), { mode: 0o600 })

function writeClaude(instanceId, id, cwd, title, entries) {
  const folder = join(directory, 'instances', instanceId, 'home', 'projects', 'fixture-project'); fs.mkdirSync(folder, { recursive: true })
  const file = join(folder, id + '.jsonl')
  fs.writeFileSync(file, [...entries.map((entry, index) => ({ sessionId: id, cwd, uuid: randomUUID(), timestamp: new Date(now + index * 1000).toISOString(), ...entry })), { type: 'custom-title', sessionId: id, customTitle: title }].map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 })
  return file
}
const entries = Array.from({ length: 46 }, (_, index) => ({ type: index % 2 ? 'assistant' : 'user', message: { ...(index % 2 ? { model: 'fixture-sonnet' } : {}), content: [{ type: 'text', text: 'Synthetic message ' + index }] } }))
entries[0].message.content = [{ type: 'text', text: 'A literal <img src="https://blocked-image.invalid/pixel" onerror="window.untrustedExecuted=true"> and [link](https://blocked-image.invalid). BROWSER_TEXT_NEEDLE' }]
entries[1].message.content = [{ type: 'text', text: 'I will inspect the synthetic project.' }, { type: 'thinking', thinking: 'Synthetic reasoning, no model request.' }, { type: 'tool_use', id: 'synthetic-tool', name: 'Read', input: { file_path: '/fixture/only.txt' } }]
entries[2].message.content = [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: [{ type: 'text', text: 'Synthetic tool result' }] }, { type: 'image', source: { type: 'url', url: 'https://blocked-image.invalid/attachment' } }]
const files = [writeClaude(cliId, sessionId, primaryProject, 'Alpha conversation', entries), writeClaude(otherCliId, sessionId, otherProject, 'Beta conversation with same native ID', [{ type: 'user', message: { content: 'Beta private body' } }]), writeClaude(desktopId, desktopSessionId, primaryProject, 'Desktop Code conversation', [{ type: 'user', message: { content: 'Desktop local Code body' } }])]
const codexHome = join(directory, 'instances', codexId, 'home'), codexFile = join(codexHome, 'sessions', 'rollout-fixture.jsonl')
fs.mkdirSync(join(codexHome, 'sessions'))
fs.writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: primaryProject } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Codex reference body' } }) + '\n')
fs.writeFileSync(join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: codexSessionId, thread_name: 'Codex reference conversation' }) + '\n')
files.push(codexFile, join(codexHome, 'session_index.jsonl'))
const original = new Map(files.map(file => [file, fs.readFileSync(file)])), opened = [], networkAttempts = [], starts = [], previews = [], discarded = []
shell.openPath = async path => { opened.push(path); return '' }
shell.showItemInFolder = path => { opened.push(path) }
const denyNetwork = kind => { networkAttempts.push(kind); throw new Error('Claude sessions UI smoke forbids network requests') }
globalThis.fetch = async () => denyNetwork('fetch')
for (const name of ['node:http', 'node:https']) { const transport = require(name); transport.request = () => denyNetwork(name); transport.get = () => denyNetwork(name) }
const { MockAgent, setGlobalDispatcher } = require('undici'), guard = new MockAgent(); guard.disableNetConnect(); setGlobalDispatcher(guard)
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { networkAttempts.push('renderer'); callback({ cancel: true }) }))
let lastPage, launchState
const handle = ipcMain.handle.bind(ipcMain)
function withLaunchState(snapshot) {
  if (launchState) for (const instance of snapshot.instances || []) if (instance.id === cliId) { instance.status = launchState; if (launchState === 'error') instance.error = 'Synthetic preparation failure shown in the session page' }
  return snapshot
}
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (channel !== 'manager:invoke') return listener(event, ...args)
  if (args[0] === 'startInstance') {
    assert.equal(args[1], previews.at(-1).ticket); starts.push(args[1]); launchState = 'preparing'
    await listener(event, 'discardClaudeSessionResume', args[1])
    return withLaunchState(await listener(event, 'load'))
  }
  const value = await listener(event, ...args)
  if (args[0] === 'scanSessions') lastPage = value
  if (args[0] === 'previewClaudeSessionResume') previews.push(value)
  if (args[0] === 'discardClaudeSessionResume') discarded.push(args[1])
  return args[0] === 'load' ? withLaunchState(value) : value
})
const timer = setTimeout(() => { console.error('Claude sessions UI smoke exceeded 80 seconds'); app.exit(1) }, 80_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1440, 1040)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      const result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:String(error.stack??error)}}})()`)
      if (result.error) throw new Error(result.error); return result.value
    }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const wait = async expression => { const deadline = Date.now() + 10_000; while (!await run(expression)) { assert.ok(Date.now() < deadline, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const click = async (selector, text) => { const candidate = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`; await wait(`!!(${candidate})`); await run(`(${candidate}).click()`) }
    const fill = async (label, value) => { await run(`(()=>{const el=document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await run('new Promise(resolve=>requestAnimationFrame(resolve))') }
    const select = async (label, text) => {
      const controls = await run(`(()=>{const el=document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')}).closest('.ant-select');el.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return el.querySelector('input').getAttribute('aria-controls')})()`)
      const candidate = `Array.from(document.getElementById(${JSON.stringify(controls)})?.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option')??[]).find(el=>el.getClientRects().length&&el.textContent.includes(${JSON.stringify(text)}))`
      await wait(`!!(${candidate})`); await run(`(${candidate}).click()`)
    }
    const row = id => `.sessions-table tr[data-row-key="${id}"]`
    const capture = async name => { await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG()) }
    const closeReader = async () => { await run(`${visible('.session-content-modal .ant-modal-close')}[0].click()`); await wait(`!${visible('.session-reader')}.length`) }
    try {
      await click('.ant-menu-item', '会话管理'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===4')
      const alpha = lastPage.items.find(item => item.locations[0].targetId === cliId), beta = lastPage.items.find(item => item.locations[0].targetId === otherCliId), desktop = lastPage.items.find(item => item.locations[0].targetId === desktopId)
      assert.notEqual(alpha.id, beta.id); assert.equal(alpha.sourceSessionId, beta.sourceSessionId)
      assert.equal(await run('document.querySelector(".sessions-panel").textContent.includes("BROWSER_TEXT_NEEDLE")'), false)
      assert.equal(await run(`document.querySelector(${JSON.stringify(row(alpha.id))}).querySelector('input[type=checkbox]').disabled`), true)
      assert.equal(await run(`document.querySelector(${JSON.stringify(row(codexSessionId))}).querySelector('input[type=checkbox]').disabled`), false)
      await select('会话客户端', 'Claude'); await click('.session-filters button', '应用筛选'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===3')
      assert.equal(await run('!!document.querySelector(".session-transfers,.session-archives,.session-sync,.session-trash")'), false)
      assert.equal(await run('Array.from(document.querySelectorAll(".sessions-panel button")).some(el=>el.textContent.includes("修复可见性"))'), false)
      assert.equal(await run('document.querySelector("[aria-label=会话内容搜索]").disabled'), false)
      await capture('claude-sources.png')

      await click(row(alpha.id) + ' button', '查看对话'); await wait('document.querySelector(".session-reader-body")?.textContent.includes("BROWSER_TEXT_NEEDLE")')
      assert.equal(await run('document.querySelectorAll(".session-reader img,.session-reader iframe,.session-reader script").length'), 0)
      assert.equal(await run('window.untrustedExecuted===true'), false)
      assert.equal(await run('document.querySelector(".session-reader").textContent.includes("<img src=")'), true)
      await run('document.querySelector(".session-reader .session-block-tool_use summary").click()')
      await wait('document.querySelector(".session-block-tool_use[open]")?.textContent.includes("/fixture/only.txt")')
      await capture('claude-transcript-tools.png')
      await run('document.querySelector(".session-reader .ant-pagination-next button").click()'); await wait('document.querySelector(".session-reader-body")?.textContent.includes("Synthetic message 44")')
      await fill('当前会话内容搜索', 'BROWSER_TEXT_NEEDLE'); await click('.session-reader-search button', '查找')
      await wait('document.querySelectorAll(".session-reader mark").length===1')
      assert.equal(await run('document.querySelectorAll(".session-message").length'), 1)
      await capture('claude-transcript-search.png'); await closeReader()

      await fill('会话项目搜索', 'beta'); await click('.session-filters button', '应用筛选'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===1&&document.querySelector(".sessions-table").textContent.includes("Beta conversation")')
      await fill('会话项目搜索', ''); await fill('会话内容搜索', 'BROWSER_TEXT_NEEDLE'); await click('.session-filters button', '应用筛选')
      await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===1&&document.querySelector(".sessions-table").textContent.includes("Alpha conversation")')
      await fill('会话内容搜索', ''); await fill('会话标题搜索', sessionId); await click('.session-filters button', '应用筛选'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===2')
      await fill('会话标题搜索', ''); await select('会话来源', 'Claude Desktop local Code'); await click('.session-filters button', '应用筛选'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===1')
      assert.equal(await run('document.querySelector(".sessions-table").textContent.includes("Claude Desktop · Code")'), true)
      assert.equal(await run('Array.from(document.querySelectorAll(".sessions-table button")).some(el=>el.textContent==="恢复会话")'), false)
      await click(row(desktop.id) + ' button', '查看对话'); await wait('document.querySelector(".session-reader-body")?.textContent.includes("Desktop local Code body")')
      assert.equal(await run('Array.from(document.querySelectorAll(".session-reader button")).some(el=>el.textContent==="恢复此会话")'), false)
      await capture('desktop-local-code-boundary.png'); await closeReader()

      await select('会话来源', 'Claude Alpha'); await click('.session-filters button', '应用筛选'); await wait('document.querySelectorAll(".sessions-table tr[data-row-key]").length===1')
      await click(row(alpha.id) + ' button', '恢复会话'); await wait('document.querySelector(".session-resume-preview .ant-descriptions")?.textContent.includes("Synthetic Claude connection")')
      assert.equal(previews.at(-1).sessionId, sessionId); assert.equal(previews.at(-1).workingDirectory, primaryProject)
      assert.equal(await run('document.querySelector(".session-resume-preview").textContent.includes("synthetic-not-a-real-key")'), false)
      const cancelledTicket = previews.at(-1).ticket
      await capture('claude-resume-preview.png'); await click('.ant-modal-footer button', '取消'); await wait(`!${visible('.session-resume-preview')}.length`)
      assert.ok(discarded.includes(cancelledTicket)); assert.equal(starts.length, 0)
      await click(row(alpha.id) + ' button', '恢复会话'); await wait('document.querySelector(".session-resume-preview .ant-descriptions")?.textContent.includes("Synthetic Claude connection")')
      await click('.ant-modal-footer button', '在原实例恢复'); await wait('document.querySelector(".session-resume-status")?.textContent.includes("正在准备会话实例")')
      assert.equal(starts.length, 1)
      launchState = 'error'; await wait('document.querySelector(".session-resume-status")?.textContent.includes("Synthetic preparation failure")')
      await capture('claude-resume-error-feedback.png'); await click('.session-resume-status button', '查看实例'); await wait('!!document.querySelector(".instances-panel")')
      assert.equal(await run('document.querySelector(".instances-panel").textContent.includes("Synthetic preparation failure")'), true)

      for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(file), bytes, 'Session browsing and preview preserve original transcript bytes')
      assert.deepEqual(networkAttempts, [])
      assert.equal(fs.existsSync(join(directory, 'instances', cliId, 'launch.json')), false)
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, realRendererAndCatalog: true, clientProjectSourceFilters: true, sameIdSourcesSeparated: true, transcriptPaginationAndSearch: true, untrustedMarkupRenderedAsText: true,
        desktopCodeReadOnly: true, resumePreviewCancelled: true, resumeConfirmationObservedWithoutLaunch: starts.length, preparationFailureVisible: true, sourcesUnchanged: true, externalNetworkRequests: networkAttempts.length }, null, 2))
      console.log('Claude sessions UI passed: unified client/project/source/ID/content filters; text-safe paged transcript and tools; separate Desktop Code source; original-instance resume preview/cancel/confirmation/status; unchanged source files and no network or Agent launch.')
      clearTimeout(timer); window.destroy(); app.exit(0)
    } catch (error) { console.error(error); await capture('failure.png').catch(() => {}); clearTimeout(timer); app.exit(1) }
  })
})
require('../out/main/index.js')
