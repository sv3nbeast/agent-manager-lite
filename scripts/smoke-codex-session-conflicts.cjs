// Isolated desktop acceptance for choosing and viewing conflicting Codex rollouts.
// Uses only a generated temporary ~/.codex fixture; no real user home is read.
const { app, safeStorage, shell } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const dataDirectory = process.env.CML_TEST_DATA_DIR, home = process.env.CML_TEST_DEFAULT_CODEX_DIRECTORY
assert.ok(dataDirectory && fs.realpathSync(dataDirectory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(dataDirectory).startsWith('codex-manager-ui-'))
assert.ok(home && fs.realpathSync(home).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(home).startsWith('codex-manager-codex-conflicts-'))
assert.equal(fs.existsSync(join(dataDirectory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const id = '00000000-0000-4000-8000-000000000051', cwd = '/fixture/project', directory = join(home, 'sessions', '2026', '10', '23')
fs.mkdirSync(directory, { recursive: true })
fs.mkdirSync(join(home, 'archived_sessions'), { recursive: true })
const live = join(directory, 'rollout-live.jsonl'), archived = join(home, 'archived_sessions', 'rollout-archived.jsonl')
const make = (body, timestamp) => [
  { type: 'session_meta', timestamp, payload: { id, cwd } },
  { type: 'event_msg', timestamp, payload: { type: 'user_message', message: body + ' user request' } },
  { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: body + ' assistant answer' } },
].map(value => JSON.stringify(value)).join('\n') + '\n'
fs.writeFileSync(live, make('SYNTHETIC_LIVE_ROLLOUT', '2026-10-23T01:00:00Z'))
fs.writeFileSync(archived, make('SYNTHETIC_ARCHIVED_ROLLOUT', '2026-10-22T01:00:00Z'))
const originalLive = fs.readFileSync(live), originalArchived = fs.readFileSync(archived), opened = []
shell.showItemInFolder = path => opened.push({ action: 'location', path })
shell.openPath = async path => { opened.push({ action: 'file', path }); return '' }
globalThis.fetch = async () => { throw new Error('Codex conflict smoke forbids external requests') }
const output = resolve('.local/codex-session-conflicts'); fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Codex conflict desktop smoke exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1440, 1000)
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript('(async()=>{try{return {value:await (' + code + ')};}catch(error){return {error:String(error.stack??error)};}})()')
    const evaluate = async code => { const result = await run(code); if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code); return result.value }
    const wait = async code => { const until = Date.now() + 12_000; while (!await evaluate(code)) { assert.ok(Date.now() < until, 'UI timeout: ' + code); await new Promise(resolve => setTimeout(resolve, 30)) } }
    const click = async (selector, label) => {
      const query = 'Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).find(el=>el.getClientRects().length&&el.textContent.replaceAll(\' \',\'\')===' + JSON.stringify(label.replace(/\s/g, '')) + ')'
      await wait('!!(' + query + ')&&!(' + query + ').disabled'); await evaluate('(' + query + ').click()')
    }
    try {
      await click('.ant-menu-item', '会话管理')
      const row = 'Array.from(document.querySelectorAll(\'.sessions-table tr[data-row-key]\')).find(el=>el.dataset.rowKey===' + JSON.stringify(id) + ')'
      await wait('!!(' + row + ')&&(' + row + ').textContent.includes(\'2 个文件版本\')')
      assert.equal(await evaluate('(' + row + ').textContent.includes(\'SYNTHETIC_LIVE_ROLLOUT\')'), false, 'transcript body must not leak into the row')
      await wait('!!(' + row + ')')
      await evaluate('Array.from((' + row + ').querySelectorAll(\'button\')).find(el=>el.textContent.replace(/\\s/g,\'\')===\'查看对话\')?.click()')
      await wait('document.querySelectorAll(\'.ant-modal .ant-radio-wrapper\').length>=3')
      assert.equal(await evaluate('document.querySelector(\'.ant-modal\').textContent.includes(\'sessions/2026/10/23/rollout-live.jsonl\')&&document.querySelector(\'.ant-modal\').textContent.includes(\'archived_sessions/rollout-archived.jsonl\')'), true, 'both physical versions must be selectable by relative path')
      await evaluate('Array.from(document.querySelectorAll(\'.ant-modal .ant-radio-wrapper\')).find(el=>el.textContent.includes(\'sessions/2026/10/23/rollout-live.jsonl\'))?.click()')
      await evaluate('Array.from(document.querySelectorAll(\'.ant-modal .ant-btn\')).find(el=>el.textContent.replaceAll(\' \',\'\').includes(\'继续\'))?.click()')
      await wait('document.querySelector(\'.session-reader-body\')?.textContent.includes(\'SYNTHETIC_LIVE_ROLLOUT assistant answer\')')
      assert.equal(await evaluate('document.querySelector(\'.session-reader-body\').textContent.includes(\'SYNTHETIC_ARCHIVED_ROLLOUT\')'), false, 'viewer must contain only the explicitly selected file')
      await evaluate('document.querySelector(\'.session-content-modal .ant-modal-close\')?.click()')
      await wait('!document.querySelector(\'.session-content-modal\')')
      await evaluate('Array.from((' + row + ').querySelectorAll(\'button\')).find(el=>el.textContent.replace(/\\s/g,\'\')===\'打开会话文件\')?.click()')
      await wait('document.querySelector(\'.ant-modal\')?.textContent.includes(\'archived_sessions/rollout-archived.jsonl\')')
      await evaluate('Array.from(document.querySelectorAll(\'.ant-modal .ant-radio-wrapper\')).find(el=>el.textContent.includes(\'archived_sessions/rollout-archived.jsonl\'))?.click()')
      await evaluate('Array.from(document.querySelectorAll(\'.ant-modal .ant-btn\')).find(el=>el.textContent.replaceAll(\' \',\'\').includes(\'继续\'))?.click()')
      const until = Date.now() + 5_000; while (opened.length < 1 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
      assert.deepEqual(opened, [{ action: 'file', path: archived }], 'file opener must receive the explicitly selected rollout')
      await evaluate('Array.from((' + row + ').querySelectorAll(\'button\')).find(el=>el.textContent.replace(/\\s/g,\'\')===\'打开位置\')?.click()')
      const locationUntil = Date.now() + 5_000; while (opened.length < 2 && Date.now() < locationUntil) await new Promise(resolve => setTimeout(resolve, 25))
      assert.deepEqual(opened[1], { action: 'location', path: home }, 'opening location must remain available for conflicts')
      assert.deepEqual(fs.readFileSync(live), originalLive); assert.deepEqual(fs.readFileSync(archived), originalArchived)
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, fixture: 'temporary Codex home', versions: 2, selectedConversation: live, selectedFile: archived, openedLocation: home, sourceUnchanged: true, noClientLaunch: true, noNetwork: true }, null, 2))
      console.log('Codex conflict smoke passed: both file versions listed, explicit conversation/file selection works, location remains openable, sources unchanged.')
      clearTimeout(timer); window.destroy(); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1) }
  })
})
require('../out/main/index.js')
