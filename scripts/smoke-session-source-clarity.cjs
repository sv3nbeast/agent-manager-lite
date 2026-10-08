// Real renderer and IPC acceptance with temporary data only. No Agent client
// is launched; shell open actions are observed instead of opening user files.
const { app, safeStorage, shell } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const testDirectory = process.env.CML_TEST_DATA_DIR
assert.ok(testDirectory && fs.realpathSync(testDirectory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(testDirectory).startsWith('codex-manager-ui-'))
// macOS exposes /var as a symlink. Match the canonical paths returned by the
// application's registered homes instead of inventing a /var DB reference.
const directory = fs.realpathSync(testDirectory)
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)

const instanceId = randomUUID(), accountId = randomUUID(), paginatedId = randomUUID(), conflictId = randomUUID(), defaultId = randomUUID()
const home = join(directory, 'instances', instanceId, 'home'), defaultHome = join(directory, 'clients', 'default')
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(defaultHome, { recursive: true })
for (const name of ['desktop', 'workspace']) fs.mkdirSync(join(directory, 'instances', instanceId, name), { recursive: true })
const now = Date.now()
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1,
  settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [],
  accounts: [{ id: accountId, revision: 0, generation: randomUUID(), name: '隔离验证连接', kind: 'api_key',
    baseUrl: 'https://session-source-fixture.invalid/v1', wireApi: 'responses', tags: [], note: '', defaultTier: 'inherit',
    models: ['fixture-model'], createdAt: now, credentials: { apiKey: 'fixture-source-only' } }],
  instances: [{ id: instanceId, clientType: 'codex', revision: 0, createdAt: now, name: '分段记录示例',
    applicationId: 'not-launched-fixture', accountId, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] }]
})), { mode: 0o600 })

function writeRollout(root, id, suffix, text, paginated = false) {
  const folder = join(root, 'sessions', '2026', '10', '08'); fs.mkdirSync(folder, { recursive: true })
  const file = join(folder, 'rollout-' + suffix + '.jsonl')
  const metadata = { type: 'session_meta', timestamp: '2026-10-08T08:00:00.000Z', payload: {
    id, cwd: '/fixture/project', source: 'cli', model_provider: 'openai',
    ...(paginated ? { history_mode: 'paginated', history_base: { thread_id: id, end_ordinal_exclusive: 12, end_byte_offset: 1024 } } : {})
  } }
  fs.writeFileSync(file, [metadata, { type: 'event_msg', timestamp: '2026-10-08T08:01:00.000Z', payload: { type: 'user_message', message: text } }].map(value => JSON.stringify(value)).join('\n') + '\n')
  return file
}
// The indexed current segment is deliberately in the middle. The latest
// filename and most recently written segment are both different from it.
const segments = Array.from({ length: 3 }, (_, index) => writeRollout(home, paginatedId, 'segment-' + index, 'Synthetic segment ' + index, true))
const currentFile = segments[1]
const conflicts = [writeRollout(home, conflictId, 'conflict-a', 'Unindexed branch A'), writeRollout(home, conflictId, 'conflict-b', 'Unindexed branch B')]
const db = new DatabaseSync(join(home, 'state_5.sqlite'))
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, rollout_path TEXT)')
db.prepare('INSERT INTO threads VALUES (?,?,?)').run(paginatedId, '有索引的长对话', currentFile)
db.close()
fs.writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: conflictId, thread_name: '无索引的多个版本' }) + '\n')
const originalFiles = Object.fromEntries([...segments, ...conflicts, join(home, 'state_5.sqlite'), join(home, 'session_index.jsonl')].map(file => [file, fs.readFileSync(file)]))
const opened = []
shell.openPath = async file => { opened.push({ action: 'file', file }); return '' }
shell.showItemInFolder = file => { opened.push({ action: 'location', file }) }
globalThis.fetch = async () => { throw new Error('Session source smoke forbids external requests') }
const output = resolve('.local/session-source-ui'); fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Session source clarity smoke exceeded 75 seconds'); app.exit(1) }, 75_000)

app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1440, 1000)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      const result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:String(error.stack??error)}}})()`)
      if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code)
      return result.value
    }
    const wait = async expression => {
      const until = Date.now() + 10_000
      while (!await run(expression)) { assert.ok(Date.now() < until, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const click = async (selector, text) => {
      const expression = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const row = id => `document.querySelector('.sessions-table tr[data-row-key="${id}"]')`
    const rowClick = async (id, text) => {
      const expression = `Array.from(${row(id)}.querySelectorAll('button')).find(el=>el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const waitOpened = async count => {
      const until = Date.now() + 10_000
      while (opened.length < count) { assert.ok(Date.now() < until, 'Open action timed out'); await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const showSources = async () => {
      const controls = await run(`(()=>{const select=document.querySelector('[aria-label="会话来源"]').closest('.ant-select');select.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return select.querySelector('input').getAttribute('aria-controls')})()`)
      const options = `Array.from(document.getElementById(${JSON.stringify(controls)})?.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option')??[]).filter(el=>el.getClientRects().length)`
      await wait(`${options}.length>0`)
      return { options, text: await run(`${options}.map(el=>el.textContent)`), close: async () => { await run(`document.querySelector('.sessions-panel h1').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`); await wait(`!${visible('.ant-select-dropdown')}.length`) } }
    }
    const capture = async name => {
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const checks = []
    try {
      await click('.ant-menu-item', '会话管理')
      await wait(`${row(paginatedId)}?.textContent.includes('有索引的长对话')`)
      await wait(`document.querySelector('.sessions-panel .toolbar')?.textContent.includes('2 个会话')`)
      assert.equal(await run(`${row(paginatedId)}.textContent.includes('分段记录 · 3')`), true)
      assert.equal(await run(`${row(paginatedId)}.textContent.includes('多个版本待核对')`), false)
      assert.equal(await run(`${row(paginatedId)}.textContent.includes('运行中')`), false, 'The isolated source profile is stopped')
      assert.equal(await run('document.querySelector(".sessions-panel").textContent.includes("受管客户端")'), false)
      const emptySources = await showSources()
      assert.equal(emptySources.text.some(text => text.includes('默认 Codex 目录')), false, 'Confirmed empty default home is hidden')
      assert.equal(emptySources.text.some(text => text.includes('实例 · 分段记录示例') && text.includes('2 个会话')), true)
      await capture('empty-default-source.png'); await emptySources.close()
      checks.push('空默认目录不出现；独立实例按逻辑会话计数')

      const segmentTag = `Array.from(${row(paginatedId)}.querySelectorAll('.session-location .ant-tag')).find(el=>el.textContent.includes('分段记录'))`
      await run(`(${segmentTag}).dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))`)
      await wait(`${visible('.ant-tooltip')}.some(el=>el.textContent.includes('按客户端索引打开当前分段'))`)
      await capture('paginated-explanation.png')
      await run(`(${segmentTag}).dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}))`)
      await rowClick(paginatedId, '打开会话文件'); await waitOpened(1); await wait(`!${visible('.session-location-picker')}.length`)
      assert.deepEqual(opened, [{ action: 'file', file: currentFile }], 'Open uses the sole state DB path, rather than a guessed segment')
      await rowClick(paginatedId, '打开位置'); await waitOpened(2)
      assert.deepEqual(opened.at(-1), { action: 'location', file: currentFile })
      checks.push('分段显示 3 段及说明；文件和位置动作打开索引指定的中间段')

      assert.equal(await run(`${row(conflictId)}.textContent.includes('多个版本待核对')`), true)
      await rowClick(conflictId, '打开会话文件')
      await wait(`!!${visible('.session-location-picker')}.length`)
      assert.equal(await run(`${visible('.session-location-picker')}[0].textContent.includes('客户端索引未能明确当前文件')`), true)
      assert.equal(await run(`${visible('.session-location-picker')}[0].querySelector('input[type="radio"]').disabled`), true)
      assert.equal(await run(`${visible('.ant-modal-footer button')}.find(el=>el.textContent.replace(/\\s/g,'')==='继续').disabled`), true)
      await capture('unindexed-conflict-protection.png')
      await click('.ant-modal-footer button', '取消'); await wait(`!${visible('.session-location-picker')}.length`)
      assert.equal(opened.length, 2, 'Unresolved versions do not silently open any physical file')
      checks.push('无索引真实多版本保留保护、说明与禁用操作')

      writeRollout(defaultHome, defaultId, 'default', 'Default directory fixture')
      fs.writeFileSync(join(defaultHome, 'session_index.jsonl'), JSON.stringify({ id: defaultId, thread_name: '默认目录的已有会话' }) + '\n')
      await click('.sessions-panel .page-heading button', '刷新会话')
      await wait(`document.querySelector('.sessions-panel .toolbar')?.textContent.includes('3 个会话')`)
      let sources = await showSources()
      assert.equal(sources.text.some(text => text.includes('默认 Codex 目录') && text.includes('1 个会话') && text.includes('与实例的独立目录分开')), true)
      const defaultOption = `${sources.options}.find(el=>el.textContent.includes('默认 Codex 目录'))`
      await run(`(${defaultOption}).click()`)
      await click('.session-filters button', '应用筛选')
      await wait(`${row(defaultId)}?.textContent.includes('默认目录的已有会话')`)
      assert.equal(await run('document.querySelectorAll(".sessions-table tr[data-row-key]").length'), 1)
      await run(`document.querySelector('[aria-label="会话来源"]').closest('.ant-select').querySelector('.ant-select-clear').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
      await run(`(()=>{const el=document.querySelector('[aria-label="会话标题搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'有索引的长对话');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await click('.session-filters button', '应用筛选')
      await wait(`document.querySelector('.sessions-panel .toolbar')?.textContent.includes('1 个会话')&&!!${row(paginatedId)}`)
      sources = await showSources()
      assert.equal(sources.text.some(text => text.includes('默认 Codex 目录') && text.includes('1 个会话')), true, 'Title filtering must not hide a populated default directory')
      assert.equal(sources.text.some(text => text.includes('实例 · 分段记录示例') && text.includes('2 个会话')), true, 'Source counts stay unfiltered')
      await capture('populated-source-title-filter.png'); await sources.close()
      checks.push('默认目录有会话后可选；标题筛选不改变全目录数量或隐藏来源')

      for (const [file, bytes] of Object.entries(originalFiles)) assert.deepEqual(fs.readFileSync(file), bytes, 'Reading/opening preserves every source segment and DB')
      assert.equal(fs.existsSync(join(directory, 'instances', instanceId, 'launch.json')), false, 'No actual client was launched')
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, checks, segments: segments.length, openedCurrentSegment: opened.every(value => value.file === currentFile), sourcesUnchanged: true, noClientLaunch: true }, null, 2))
      console.log('Session source clarity UI smoke passed: empty/default populated dropdowns, unfiltered source counts, paginated current file/tooltip, unresolved-version protection, unchanged files; isolated Electron and IPC, no client launch or user data.')
      clearTimeout(timer); window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error); await capture('failure.png').catch(() => {}); clearTimeout(timer); app.exit(1)
    }
  })
})
require('../out/main/index.js')
