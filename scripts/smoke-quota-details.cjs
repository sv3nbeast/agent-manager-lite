// UI-only OAuth fixture; parser/service persistence is covered by quota-details.test.ts.
const { app, safeStorage } = require('electron')
const fs = require('node:fs'), { join, resolve, sep, basename } = require('node:path'), { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto'), assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const now = Date.now()
const account = (name, quota, error) => ({ id: randomUUID(), generation: randomUUID(), name, kind: 'oauth', plan: 'business', baseUrl: 'https://fixture.invalid', models: ['fixture'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: now, credentials: { accessToken: 'fixture-quota-secret' }, quota: { updatedAt: now, windows: [], ...quota }, error })
const accounts = [
  account('月度与附加额度', { hasUsableCredits: true, limitReached: true, windows: [{ id: 'main.primary', name: '短周期', durationSeconds: 18000, usedPercent: 100, resetsAt: now + 60000, limitReached: true }], spendLimit: { limit: 25000, used: 8000, remaining: 17000, remainingPercent: 68, resetsAt: now + 3600000 }, credits: { balance: 42, remaining: 42 }, resetCreditsAvailable: 0 }, '查询失败：HTTP 429'),
  account('零余额与未知', { credits: { balance: 0, remaining: 0, unlimited: false }, spendLimit: { limit: 100 } }),
  account('不限量', { credits: { unlimited: true, balance: 0, remaining: 0 } })
]
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0 }, groups: [], accounts })), { mode: 0o600 })
const output = resolve('.local/agent-manager-adaptation/quota-details'); fs.mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Quota detail UI exceeded 60 seconds'); app.exit(1) }, 60000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait = async expression => { const end = Date.now() + 10000; while (!await run(expression)) { assert.ok(Date.now() < end, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const openDetails = async index => {
      await run(`document.querySelectorAll('.account-card')[${index - 1}].querySelector('footer button.account-details').click()`)
      await wait('!!document.querySelector(".ant-drawer-open .account-quota-details")')
    }
    const closeDetails = async () => {
      await run('document.querySelector(".ant-drawer-open .ant-drawer-close").click()')
      await wait('!document.querySelector(".ant-drawer-open")')
      await wait('!document.querySelector(".account-quota-details")')
    }
    const capture = async name => {
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    try {
      // Account suites explicitly enter the shared account workspace; the
      // product now opens on instances by default.
      await wait(`Array.from(document.querySelectorAll('.ant-menu-item')).some(el=>el.textContent.includes('账号管理'))`)
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('账号管理')).click()`)
      await wait('document.querySelectorAll(".account-card").length===3')
      assert.equal(await run('document.querySelectorAll(".account-quota-details").length'), 0)
      assert.equal(await run('Array.from(document.querySelectorAll(".account-card")).every(card=>!card.innerText.includes("刷新订阅"))'), true, 'subscription actions belong in details')
      assert.match(await run('document.querySelector(".account-card").innerText'), /套餐用量.*已.*尽，附加额度仍可用/)
      assert.match(await run('document.querySelector(".account-card").innerText'), /上次成功|历史结果/)
      await capture('quota-credits-collapsed.png')
      await openDetails(1)
      const first = await run('document.querySelector(".account-quota-details").innerText')
      assert.match(first, /刷新订阅/)
      assert.match(first, /月度 Credits\s*剩余 17,000/)
      assert.match(first, /附加 Credits\s*剩余 42/)
      assert.match(first, /可重置次数\s*0/)
      assert.match(first, /上次成功结果/)
      assert.match(first, /已耗尽/)
      assert.equal(await run('Array.from(document.querySelectorAll(".account-quota-details .credit-quota details")).every(el=>!el.open)'), true)
      await closeDetails()
      await openDetails(2)
      const second = await run('document.querySelector(".account-quota-details").innerText')
      assert.match(second, /月度 Credits\s*剩余 未知/)
      assert.match(second, /附加 Credits\s*剩余 0/)
      await closeDetails()
      await openDetails(3)
      assert.match(await run('document.querySelector(".account-quota-details").innerText'), /附加 Credits\s*不限量/)
      assert.equal(await run('document.body.innerText.includes("fixture-quota-secret")'), false)
      await closeDetails()
      await openDetails(1)
      await run('Array.from(document.querySelectorAll(".account-quota-details .credit-quota summary")).forEach(el=>el.click())')
      const expanded = await run('document.querySelector(".account-quota-details").innerText')
      assert.match(expanded, /额度上限\s*25,000/)
      assert.match(expanded, /已用额度\s*8,000/)
      assert.match(expanded, /剩余比例\s*68%/)
      assert.match(expanded, /余额\s*42/)
      assert.equal(expanded.includes(await run(`new Date(${now + 3600000}).toLocaleString()`)), true)
      await capture('quota-credits-expanded.png')
      await closeDetails()
      const snapshot = await run('window.manager.load()')
      await run(`window.manager.saveSettings(${JSON.stringify({ ...snapshot.settings, theme: 'dark' })})`)
      await run(`document.querySelector('button[aria-label="重新加载账号"]').click()`)
      await wait('!!document.querySelector(".app-shell.dark")')
      await openDetails(1)
      await capture('quota-credits-dark.png')
      assert.equal((await run('window.manager.load()')).quotaRefresh.running, false)
      console.log('Quota detail UI passed: monthly/additional credits, zero/unknown/unlimited, reset count/time, per-window state, stale-cache label, collapsed details, light/dark. Isolated seeded OAuth data; no upstream request or system keychain.')
      clearTimeout(timer); app.quit()
    } catch (error) { console.error(error); await capture('quota-credits-failure.png').catch(() => {}); clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit() }
  })
})
require('../out/main/index.js')
