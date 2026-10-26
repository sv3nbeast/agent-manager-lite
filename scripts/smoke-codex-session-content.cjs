// Isolated Electron acceptance for discovering and reading a paginated Codex
// transcript. Fixtures are synthetic and temporary; no client is launched.
const fs = require('node:fs')
const { join, resolve, sep, basename, relative } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')

// Keep the same isolated-parent/temporary-home model as run-desktop-smoke,
// while leaving the shared smoke dispatcher untouched for this focused test.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const dataDirectory = fs.mkdtempSync(join(tmpdir(), 'codex-manager-ui-'))
  const codexHome = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-manager-codex-content-')))
  const environment = { ...process.env, CML_TEST_DATA_DIR: dataDirectory, CML_TEST_DEFAULT_CODEX_DIRECTORY: codexHome, CML_TEST_SYSTEM_KEYCHAIN: '0' }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: resolve(__dirname, '..'), env: environment, stdio: 'inherit', detached: process.platform !== 'win32' })
  const timer = setTimeout(() => {
    console.error('Codex session content desktop smoke exceeded 90 seconds; stopping its isolated Electron process.')
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 90_000)
  const cleanup = () => { clearTimeout(timer); fs.rmSync(dataDirectory, { recursive: true, force: true }); fs.rmSync(codexHome, { recursive: true, force: true }) }
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1 })
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { try { child.kill('SIGTERM') } catch {}; cleanup(); process.exit(1) })
} else {
const { app, safeStorage, shell } = require('electron')
const { DatabaseSync } = require('node:sqlite')

const dataDirectory = process.env.CML_TEST_DATA_DIR
assert.ok(dataDirectory && fs.realpathSync(dataDirectory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(dataDirectory).startsWith('codex-manager-ui-'))
const root = fs.realpathSync(dataDirectory)
assert.equal(fs.existsSync(join(root, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)

const realSourceHome = process.env.CML_TEST_CODEX_SESSION_SOURCE_HOME
const realSessionId = process.env.CML_TEST_CODEX_SESSION_ID
const realCurrentRelative = process.env.CML_TEST_CODEX_SESSION_CURRENT
const realSessionTitle = process.env.CML_TEST_CODEX_SESSION_TITLE || 'Real five-rollout Codex transcript'
const realSessionQuery = process.env.CML_TEST_CODEX_SESSION_QUERY || 'SYNTHETIC_FOLLOWUP_NEEDLE'
const instanceId = randomUUID(), accountId = randomUUID(), sessionId = realSessionId || randomUUID(), parentId = randomUUID(), currentRolloutId = randomUUID(), now = Date.now()
const instanceDirectory = join(root, 'instances', instanceId), home = join(instanceDirectory, 'home')
for (const folder of ['home', 'desktop', 'workspace']) fs.mkdirSync(join(instanceDirectory, folder), { recursive: true, mode: 0o700 })
const account = { id: accountId, revision: 0, generation: randomUUID(), kind: 'api_key', name: 'Synthetic Codex connection',
  baseUrl: 'https://codex-session-fixture.invalid/v1', wireApi: 'responses', models: ['fixture-model'], tags: [], note: '', defaultTier: 'inherit',
  createdAt: now, credentials: { apiKey: 'synthetic-not-a-real-key' } }
const instance = { id: instanceId, clientType: 'codex', revision: 0, createdAt: now, name: 'Synthetic Codex transcript',
  applicationId: 'fixture-codex-never-launched', accountId, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] }
fs.writeFileSync(join(root, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1,
  settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [], accounts: [account], instances: [instance], instanceApplications: []
})), { mode: 0o600 })

let parentRollout, rollout
const rolloutDirectory = join(home, 'sessions', '2026', '10', '24')
fs.mkdirSync(rolloutDirectory, { recursive: true, mode: 0o700 })
if (realSourceHome) {
  assert.ok(realSessionId && realCurrentRelative, 'real snapshot mode requires an explicit session ID and selected rollout')
  const source = fs.realpathSync(realSourceHome)
  const sourceSessions = join(source, 'sessions')
  assert.ok(fs.lstatSync(sourceSessions).isDirectory() && !fs.lstatSync(sourceSessions).isSymbolicLink())
  fs.cpSync(sourceSessions, join(home, 'sessions'), { recursive: true, errorOnExist: true, force: false })
  const currentPath = join(home, realCurrentRelative)
  assert.ok(currentPath.startsWith(join(home, 'sessions') + sep) && fs.lstatSync(currentPath).isFile())
  fs.writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: sessionId, thread_name: realSessionTitle, updated_at: new Date().toISOString() }) + '\n', { mode: 0o600 })
  const state = new DatabaseSync(join(home, 'state_5.sqlite'))
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL)')
  state.prepare('INSERT INTO threads VALUES(?,?,?)').run(sessionId, realCurrentRelative, 'paginated')
  state.close()
} else {
parentRollout = join(rolloutDirectory, 'rollout-2026-10-24T08-00-00-' + sessionId + '_' + parentId + '.jsonl')
const parentLines = [{ type: 'session_meta', ordinal: 0, timestamp: '2026-10-24T08:00:00.000Z', payload: { id: sessionId, cwd: '/fixture/codex-project', history_mode: 'paginated' } }]
for (let ordinal = 1; ordinal <= 39; ordinal++) {
  if (ordinal === 1) parentLines.push({ type: 'event_msg', ordinal, timestamp: '2026-10-24T08:00:01.000Z', payload: { type: 'user_message', message: 'SYNTHETIC_OLDER_TURN: this message is inherited from the parent rollout.' } })
  else if (ordinal === 2) parentLines.push({ type: 'event_msg', ordinal, timestamp: '2026-10-24T08:00:02.000Z', payload: { type: 'agent_message', message: 'Synthetic assistant reply from the parent rollout.' } })
  else if (ordinal === 3) parentLines.push({ type: 'response_item', ordinal, timestamp: '2026-10-24T08:00:03.000Z', payload: { type: 'function_call', name: 'fixture_tool', arguments: { command: 'synthetic' } } })
  else if (ordinal === 4) parentLines.push({ type: 'response_item', ordinal, timestamp: '2026-10-24T08:00:04.000Z', payload: { type: 'function_call_output', output: 'SYNTHETIC_TOOL_OUTPUT' } })
  else parentLines.push({ type: 'event_msg', ordinal, timestamp: '2026-10-24T08:00:05.000Z', payload: { type: ordinal % 2 ? 'user_message' : 'agent_message', message: 'Synthetic historical message ' + ordinal + '.' } })
}
// This record exists in the same physical ancestor rollout but lies beyond
// the byte/ordinal boundary declared by the current rollout. The viewer must
// honor history_base instead of displaying the whole ancestor file.
parentLines.push({ type: 'event_msg', ordinal: 40, timestamp: '2026-10-24T08:00:06.000Z', payload: { type: 'user_message', message: 'SYNTHETIC_AFTER_HISTORY_BASE_MUST_NOT_APPEAR' } })
const parentBytes = Buffer.from(parentLines.map(value => JSON.stringify(value)).join('\n') + '\n')
const endByteOffset = Buffer.byteLength(parentLines.slice(0, -1).map(value => JSON.stringify(value)).join('\n') + '\n')
fs.writeFileSync(parentRollout, parentBytes, { mode: 0o600 })
rollout = join(rolloutDirectory, 'rollout-2026-10-24T08-10-00-' + sessionId + '_' + currentRolloutId + '.jsonl')
fs.writeFileSync(rollout, [
  { type: 'session_meta', ordinal: 40, timestamp: '2026-10-24T08:10:00.000Z', payload: { id: sessionId, cwd: '/fixture/codex-project', history_mode: 'paginated', history_base: { thread_id: parentId, end_ordinal_exclusive: 40, end_byte_offset: endByteOffset } } },
  { type: 'event_msg', ordinal: 41, timestamp: '2026-10-24T08:10:01.000Z', payload: { type: 'user_message', message: 'SYNTHETIC_CURRENT_TURN: this is in the current rollout.' } },
  { type: 'response_item', ordinal: 42, timestamp: '2026-10-24T08:10:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic assistant reply from the current rollout.' }] } },
  { type: 'event_msg', ordinal: 43, timestamp: '2026-10-24T08:10:03.000Z', payload: { type: 'user_message', message: 'SYNTHETIC_FOLLOWUP_NEEDLE: final question in this conversation.' } },
].map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 })
fs.writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: sessionId, thread_name: '可查看的 Codex 长对话', updated_at: '2026-10-24T08:00:00.000Z' }) + '\n', { mode: 0o600 })

const state = new DatabaseSync(join(home, 'state_5.sqlite'))
state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL)')
state.prepare('INSERT INTO threads VALUES(?,?,?)').run(sessionId, relative(home, rollout), 'paginated')
state.close()
}
const currentFile = realSourceHome ? join(home, realCurrentRelative) : rollout
const original = [...new Set([...(realSourceHome ? [currentFile] : [parentRollout, rollout]), join(home, 'session_index.jsonl'), join(home, 'state_5.sqlite')])].map(path => [path, fs.readFileSync(path)])
const opened = []
shell.openPath = async path => { opened.push(path); return '' }
shell.showItemInFolder = path => { opened.push(path) }
globalThis.fetch = async () => { throw new Error('Codex session content smoke forbids external requests') }
const output = resolve('.local/codex-session-content'); fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Codex session content desktop smoke exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1440, 1000)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      const result = await window.webContents.executeJavaScript('(async()=>{try{return {value:await (' + code + ')};}catch(error){return {error:String(error.stack??error)};}})()')
      if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code)
      return result.value
    }
    const wait = async code => { const until = Date.now() + 10_000; while (!await run(code)) { assert.ok(Date.now() < until, 'UI timeout: ' + code); await new Promise(resolve => setTimeout(resolve, 30)) } }
    const click = async (selector, label) => {
      const query = 'Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).find(el=>el.getClientRects().length&&el.textContent.replace(/\\s/g,"")===' + JSON.stringify(label.replace(/\s/g, '')) + ')'
      await wait('!!(' + query + ')&&!(' + query + ').disabled'); await run('(' + query + ').click()')
    }
    const row = 'Array.from(document.querySelectorAll(".sessions-table tr[data-row-key]")).find(el=>el.dataset.rowKey===' + JSON.stringify(sessionId) + ')'
    const fill = async (selector, value) => run('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))})()')
    try {
      await click('.ant-menu-item', '会话管理')
      await wait('!!(' + row + ')&&(' + row + ').textContent.includes(' + JSON.stringify(realSourceHome ? realSessionTitle : '可查看的 Codex 长对话') + ')')
      assert.equal(await run('(' + row + ').textContent.includes(' + JSON.stringify('分段记录 · ' + (realSourceHome ? '5' : '2')) + ')'), true, 'the paginated session is discoverable with all physical rollouts')
      await run('Array.from((' + row + ').querySelectorAll("button")).find(el=>el.textContent.replace(/\\s/g,"")==="查看对话")?.click()')
      if (realSourceHome) {
        await wait('document.querySelector(".session-reader-body .session-message")&&document.querySelector(".session-reader-search [role=status]")?.textContent.includes("条消息")')
        const count = await run('Number((document.querySelector(".session-reader-search [role=status]").textContent.match(/[0-9,]+/)||["0"])[0].replace(/,/g,""))')
        assert.ok(count > 1000, 'real five-rollout Codex history should display the complete paginated transcript')
        assert.equal(await run('document.querySelector(".session-reader-export").textContent.includes("复制和下载只包含当前窗口")'), true)
        await fill('[aria-label="当前会话内容搜索"]', realSessionQuery)
      } else {
        await wait('document.querySelector(".session-reader-body")?.textContent.includes("SYNTHETIC_FOLLOWUP_NEEDLE")')
        assert.equal(await run('document.querySelector(".session-reader-search [role=status]").textContent.includes("共 42 条消息")'), true, 'parent rollout and current rollout messages are combined')
        assert.equal(await run('document.querySelector(".session-reader-body").textContent.includes("SYNTHETIC_AFTER_HISTORY_BASE_MUST_NOT_APPEAR")'), false, 'ancestor content beyond history_base is excluded')
        assert.equal(await run('document.querySelector(".session-reader-body").textContent.includes("SYNTHETIC_CURRENT_TURN")'), true, 'the first page includes the current rollout tail')
        for (let index = 0; index < 4; index++) { await click('.session-reader-footer button', '更早 10 条'); await new Promise(resolve => setTimeout(resolve, 60)) }
        await wait('document.querySelector(".session-reader-body")?.textContent.includes("SYNTHETIC_OLDER_TURN")')
        assert.equal(await run('document.querySelector(".session-reader-export").textContent.includes("第 1–2 条 / 共 42 条记录")'), true)
        assert.equal(await run('document.querySelector(".session-reader-body").textContent.includes("SYNTHETIC_CURRENT_TURN")'), false, 'older window does not retain the latest transcript tail')
        await click('.session-reader-footer button', '更新 10 条'); await wait('document.querySelector(".session-reader-body")?.textContent.includes("SYNTHETIC_TOOL_OUTPUT")')
        assert.equal(await run('document.querySelector(".session-reader-body").textContent.includes("SYNTHETIC_CURRENT_TURN")'), false, 'the middle window remains before the latest tail')
        await fill('[aria-label="当前会话内容搜索"]', 'SYNTHETIC_FOLLOWUP_NEEDLE')
      }
      await click('.session-reader-search button', '查找')
      if (realSourceHome) {
        await wait('document.querySelector(".session-reader-search [role=status]")?.textContent.includes("匹配")')
        const matches = await run('Number((document.querySelector(".session-reader-search [role=status]").textContent.match(/[0-9,]+/)||["0"])[0].replace(/,/g,""))')
        assert.ok(matches > 0, 'body search finds the requested content in the real transcript')
      } else {
        await wait('document.querySelector(".session-reader-body")?.textContent.includes("SYNTHETIC_FOLLOWUP_NEEDLE")&&document.querySelectorAll(".session-reader-body .session-message").length===1')
        assert.equal(await run('document.querySelector(".session-reader-search [role=status]").textContent.includes("匹配 1 条消息")'), true)
      }
      await run('document.querySelector(".session-content-modal .ant-modal-close")?.click()')
      await wait('!document.querySelector(".session-content-modal")')
      for (const [path, bytes] of original) assert.deepEqual(fs.readFileSync(path), bytes, 'transcript browsing must not change source files or databases')
      assert.deepEqual(opened, [], 'viewing a transcript does not open files or launch a client')
      assert.equal(fs.existsSync(join(instanceDirectory, 'launch.json')), false)
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, fixture: realSourceHome ? 'private read-only snapshot of a real five-rollout Codex transcript' : 'synthetic managed Codex paginated session', sessionDiscoverable: true, transcriptOpens: true, earlierHistoryVisible: true, toolOutputVisible: !realSourceHome, pagination: true, textSearch: true, sourceFilesUnchanged: true, noClientLaunch: true, noExternalNetwork: true }, null, 2))
      console.log('Codex transcript UI smoke passed: session discoverable, full paginated history opens in the reader, search works, snapshot sources unchanged, no client launch or network.')
      clearTimeout(timer); window.destroy(); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1) }
  })
})
require('../out/main/index.js')
}
