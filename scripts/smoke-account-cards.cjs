// Actual Manager renderer, ephemeral encrypted vault and synthetic helper only.
// This suite never opens the official Codex GUI or contacts an upstream service.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const childProcess = require('node:child_process')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)

const now = Date.now()
const day = 86_400_000
const windows = (short, weekly) => [
  { id: 'main.primary_window', name: '短周期', durationSeconds: 18_000, usedPercent: short, resetsAt: now + 2 * 3_600_000, allowed: true, limitReached: short === 100 },
  { id: 'main.secondary_window', name: '周周期', durationSeconds: 604_800, usedPercent: weekly, resetsAt: now + 5 * day, allowed: true, limitReached: weekly === 100 }
]
const account = (name, quota, overrides = {}) => ({
  id: randomUUID(), generation: randomUUID(), name, email: name, kind: 'oauth', plan: 'plus',
  baseUrl: 'https://fixture.invalid', models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit',
  note: '', tags: [], createdAt: now - 3 * day, proxy: { mode: 'direct' },
  credentials: { accessToken: 'fixture-account-cards-secret', accountId: 'fixture-workspace' },
  subscriptionActiveUntil: now + 30 * day,
  ...(quota ? { quota: { updatedAt: now - 60_000, windows: [], ...quota } } : {}), ...overrides
})
const longEmail = 'very.long.account.name.for.layout.verification.and.visual.ellipsis@example.invalid'
const accounts = [
  account('alex@example.invalid', { windows: windows(0, 3), allowed: true, limitReached: false }),
  account('studio@example.invalid', { windows: windows(84, 24), allowed: true, limitReached: false,
    credits: { balance: 42, remaining: 42 }, spendLimit: { limit: 25_000, used: 8_000, remaining: 17_000, remainingPercent: 68, resetsAt: now + 20 * day },
    resetCreditsAvailable: 2, resetCreditsNextExpiresAt: now + 15 * day }, { plan: 'pro', tags: ['工作'], note: '日常开发账号' }),
  account('team@example.invalid', { windows: windows(100, 100), allowed: true, limitReached: true, hasUsableCredits: true, credits: { remaining: 12 } }),
  account('unknown@example.invalid', { windows: windows(undefined, undefined) }),
  account('not-yet-queried@example.invalid', undefined, { subscriptionActiveUntil: undefined, plan: undefined }),
  account(longEmail, { windows: [...windows(31, 68), { id: 'review.primary_window', name: '代码审查 · 短周期', durationSeconds: 18_000, usedPercent: 17, resetsAt: now + day }] },
    { error: '查询失败：HTTP 429', errorAt: now, subscriptionQueryLastError: '订阅查询暂时失败' })
]
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({
  version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], accounts
})), { mode: 0o600 })

// The actual IPC and AccountNetwork spawn path execute, but a temporary Node
// helper answers a fixed allowlist from stdin. No request leaves this process.
const helper = join(directory, 'account-cards-helper.cjs')
const callsFile = join(directory, 'account-cards-calls.jsonl')
const fixtures = {
  '/backend-api/wham/usage': { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 9, limit_window_seconds: 18_000, reset_after_seconds: 7200 },
    secondary_window: { used_percent: 23, limit_window_seconds: 604_800, reset_after_seconds: 432_000 } }, rate_limit_reset_credits: { available_count: 2 } },
  '/backend-api/accounts/check/v4-2023-04-27': { accounts: [{ account: { id: 'fixture-workspace' }, entitlement: { subscription_plan: 'Plus', expires_at: new Date(now + 35 * day).toISOString() } }] },
  '/backend-api/wham/rate-limit-reset-credits': { available_count: 2, credits: [
    { id: 'fixture-credit-1', status: 'available', type: 'five_hour', expires_at: new Date(now + 15 * day).toISOString() },
    { id: 'fixture-credit-2', status: 'available', type: 'five_hour', expires_at: new Date(now + 20 * day).toISOString() }
  ] }
}
fs.writeFileSync(helper, `const fs=require('node:fs'),assert=require('node:assert/strict');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>{try{const request=JSON.parse(raw),url=new URL(request.url),fixtures=${JSON.stringify(fixtures)};assert.equal(url.origin,'https://chatgpt.com');assert.equal(request.proxy,'direct');assert.equal(request.method,'GET');assert.equal(request.headers.authorization,'Bearer fixture-account-cards-secret');assert.ok(Object.hasOwn(fixtures,url.pathname),'unexpected helper route');fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({path:url.pathname,method:request.method})+'\\n');process.stdout.write(JSON.stringify({status:200,body:Buffer.from(JSON.stringify(fixtures[url.pathname])).toString('base64')}))}catch(error){console.error(error.message);process.exitCode=1}})`, { mode: 0o600 })
const originalSpawn = childProcess.spawn
childProcess.spawn = function (file, args, options) {
  assert.notEqual(file, '/usr/bin/security', 'No system keychain in account-card acceptance')
  if (args?.includes('-egress-http')) {
    assert.equal(resolve(file), resolve('resources/bin/codex-proxy'))
    return originalSpawn.call(this, process.execPath, [helper], { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } })
  }
  return originalSpawn.apply(this, arguments)
}
globalThis.fetch = async () => { throw new Error('Account-card fixture refuses all direct network requests') }
const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
function luminance(color) {
  const rgb = color.match(/^rgba?\(([^)]+)\)$/)
  assert.ok(rgb, 'expected an opaque computed RGB color: ' + color)
  const channels = rgb[1].split(/[\s,\/]+/).slice(0, 3).map(value => value.endsWith('%') ? Number.parseFloat(value) / 100 : Number(value) / 255)
  assert.equal(channels.length, 3)
  assert.ok(channels.every(value => Number.isFinite(value) && value >= 0 && value <= 1))
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}
const output = resolve('docs/evidence/compact-cards')
const reports = output
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(reports, { recursive: true })
const timer = setTimeout(() => { console.error('Account-card UI exceeded 75 seconds'); app.exit(1) }, 75_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  // Only this ephemeral test window may shrink below the production minimum.
  window.setMinimumSize(720, 640)
  window.setContentSize(1440, 1040)
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait = async expression => {
      const end = Date.now() + 10_000
      while (!await run(expression)) { assert.ok(Date.now() < end, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const click = async (selector, text) => {
      const expr = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expr})`); await run(`(${expr}).click()`)
    }
    const clickSelector = async selector => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await run(`document.querySelector(${JSON.stringify(selector)}).click()`) }
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    }
    const settle = async () => {
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const waitForVisibleDrawer = async () => {
      await settle()
      await wait(`(()=>{const details=document.querySelector('.ant-drawer-open .account-quota-details'),wrapper=details?.closest('.ant-drawer-content-wrapper');if(!details||!wrapper)return false;const box=wrapper.getBoundingClientRect(),style=getComputedStyle(wrapper);if(box.width<300||box.height<200||box.left<0||box.right>innerWidth+1||box.bottom<=0||box.top>=innerHeight||style.visibility==='hidden'||Number(style.opacity)!==1)return false;if(style.transform==='none')return true;const matrix=new DOMMatrixReadOnly(style.transform);return Math.abs(matrix.m41)<.1&&Math.abs(matrix.m42)<.1})()`)
    }
    const capture = async name => {
      await settle()
      if (name.includes('details-')) await waitForVisibleDrawer()
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const captureAccountGrid = async name => {
      await settle()
      const rect = await run(`(()=>{const grid=document.querySelector('.account-grid'),boxes=Array.from(grid.children).filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect()),bounds=grid.getBoundingClientRect();const x=Math.max(0,Math.floor(bounds.left-6)),y=Math.max(0,Math.floor(bounds.top-6)),right=Math.min(innerWidth,Math.ceil(Math.max(...boxes.map(box=>box.right))+6)),bottom=Math.min(innerHeight,Math.ceil(Math.max(...boxes.map(box=>box.bottom))+6));return{x,y,width:right-x,height:bottom-y}})()`)
      assert.ok(rect.width > 0 && rect.height > 0, 'real account grid has a visible capture rectangle')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage(rect)).toPNG())
      fs.writeFileSync(join(reports, name.replace(/\.png$/, '-rect.json')), JSON.stringify(rect, null, 2))
    }
    const tooltipVisible = label => `Array.from(document.querySelectorAll('.ant-tooltip')).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&Number(getComputedStyle(el).opacity)>0&&el.querySelector('.ant-tooltip-inner')?.innerText===${JSON.stringify(label)})`
    const tooltipInteractions = []
    let focusVerificationTarget
    const dismissTooltip = async () => {
      const point = await run('(()=>{const box=document.querySelector(".toolbar .search input").getBoundingClientRect();return{x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()')
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      window.webContents.sendInputEvent({ type: 'mouseLeave', ...point })
      if (focusVerificationTarget) {
        await run(`document.querySelector(${JSON.stringify(focusVerificationTarget)})?.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`)
        focusVerificationTarget = undefined
      }
      await run(`document.querySelector('.toolbar .search input')?.focus()`)
      await wait(`!Array.from(document.querySelectorAll('.ant-tooltip')).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&Number(getComputedStyle(el).opacity)>0)`)
    }
    const showTooltip = async (selector, label, inputMode) => {
      await dismissTooltip()
      await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
      await settle()
      const interaction = {label,inputMode,realTabReached:false,focusEventVerified:false,nativeFocusUnavailable:false}
      if (inputMode === 'hover') {
        const point = await run(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()`)
        window.webContents.sendInputEvent({ type: 'mouseEnter', ...point })
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      } else {
        // Real Tab still verifies reachability; a background macOS fixture may
        // change activeElement without delivering a native focus event.
        await run(`document.querySelector(${JSON.stringify(selector)}).closest('.account-card').querySelector('.ant-checkbox-input').focus()`)
        let reached = false
        for (let step = 0; step < 12 && !reached; step++) {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          await run('new Promise(resolve=>requestAnimationFrame(resolve))')
          reached = await run(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)
        }
        assert.equal(reached, true, `keyboard Tab reaches ${label} action`)
        interaction.realTabReached = true
        interaction.nativeFocusUnavailable = !await run('document.hasFocus()')
        if (interaction.nativeFocusUnavailable) {
          await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('focusin',{bubbles:true}))`)
          interaction.focusEventVerified = true
          focusVerificationTarget = selector
        }
      }
      try {
        await wait(tooltipVisible(label))
        await settle()
        if (inputMode === 'focus' && !await run(tooltipVisible(label)) && !await run('document.hasFocus()')) {
          interaction.nativeFocusUnavailable = true
          await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('focusin',{bubbles:true}))`)
          interaction.focusEventVerified = true
          focusVerificationTarget = selector
          await wait(tooltipVisible(label))
          await settle()
        }
        assert.equal(await run(tooltipVisible(label)), true, `${inputMode} shows ${label} tooltip`)
        tooltipInteractions.push(interaction)
      } catch (error) {
        const diagnostic = await run(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),box=target.getBoundingClientRect(),at=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return {inputMode:${JSON.stringify(inputMode)},label:${JSON.stringify(label)},disabled:target.disabled,focused:document.hasFocus(),activeElement:document.activeElement?.outerHTML,target:target.outerHTML,parent:target.parentElement?.outerHTML,box:{x:box.x,y:box.y,width:box.width,height:box.height},pointElement:at?.outerHTML,tooltips:Array.from(document.querySelectorAll('.ant-tooltip')).map(el=>({html:el.outerHTML,text:el.innerText,visibility:getComputedStyle(el).visibility,opacity:getComputedStyle(el).opacity,rects:el.getClientRects().length}))}})()`)
        fs.writeFileSync(join(reports, `kiro-card-tooltip-${inputMode}-failure.json`), JSON.stringify({...diagnostic,interaction}, null, 2))
        throw error
      }
    }
    const card = index => `.account-card[data-account-id="${accounts[index].id}"]`
    const action = (index, prefix) => `${card(index)} button[aria-label=${JSON.stringify(`${prefix} · ${accounts[index].name}`)}]`
    const cardText = index => run(`document.querySelector(${JSON.stringify(card(index))}).innerText`)
    const closeDrawer = async () => {
      await clickSelector('.ant-drawer-open .ant-drawer-close')
      await wait('!document.querySelector(".ant-drawer-open")')
      await wait('!document.querySelector(".account-quota-details")')
      await settle()
    }
    let multiNormalCard
    const auditLayout = async mode => {
      await settle()
      const result = await run(`(()=>{const tile=document.querySelector('.account-add-card'),box=tile?.getBoundingClientRect();return {mode:${JSON.stringify(mode)},viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,addTile:box?{width:box.width,height:box.height,scrollWidth:tile.scrollWidth,clientWidth:tile.clientWidth}:undefined,cards:Array.from(document.querySelectorAll('.account-card')).map(el=>({id:el.dataset.accountId,height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,identityTitle:el.querySelector('.account-identity strong')?.getAttribute('title')}))}})()`)
      result.statusContrast = await run(`['success','warning','error'].flatMap(tone=>{const el=document.querySelector('.account-card .status-'+tone);return el?[{tone,label:el.textContent,color:getComputedStyle(el).color,background:getComputedStyle(el.closest('.account-card')).backgroundColor}]:[]})`)
      if (result.cards.length === 6) assert.equal(result.statusContrast.length, 3, 'full fixture keeps success/warning/error contrast checks')
      for (const status of result.statusContrast) {
        const foreground = luminance(status.color), background = luminance(status.background)
        status.ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      }
      // Keep the measured layout even when the acceptance assertion fails.
      fs.writeFileSync(join(reports, `kiro-card-layout-${mode}.json`), JSON.stringify(result, null, 2))
      for (const status of result.statusContrast) assert.ok(status.ratio >= 4.5, `${mode}: ${status.tone} text contrast ${status.ratio.toFixed(2)} is below 4.5`)
      assert.ok(result.documentWidth <= result.viewport + 1, `${mode}: page overflows horizontally`)
      for (const value of result.cards) {
        assert.ok(value.scrollWidth <= value.clientWidth + 1, `${mode}: account ${value.id} overflows`)
        assert.ok(value.width <= 320.1, `${mode}: account width ${value.width} exceeds 320px`)
      }
      assert.ok(result.addTile, `${mode}: add-account tile stays present`)
      assert.ok(result.addTile.width <= 320.1, `${mode}: add-account tile width ${result.addTile.width} exceeds 320px`)
      assert.ok(result.addTile.height <= 190, `${mode}: add-account tile height ${result.addTile.height} exceeds compact target`)
      assert.ok(result.addTile.scrollWidth <= result.addTile.clientWidth + 1, `${mode}: add-account tile overflows`)
      const normal = result.cards.find(value => value.id === accounts[0].id)
      if (normal) assert.ok(normal.height <= 330, `${mode}: typical normal card height ${normal.height} exceeds 330px`)
      if (mode === 'light') multiNormalCard = normal
      if (mode === 'single-normal') {
        assert.ok(multiNormalCard, 'multi-card baseline was measured first')
        assert.ok(Math.abs(normal.width - multiNormalCard.width) <= 1, 'one account does not expand into spare grid space')
        assert.ok(Math.abs(normal.height - multiNormalCard.height) <= 1, 'one account keeps its content height instead of stretching')
      }
      return result
    }
    try {
      // Account suites explicitly enter the shared account workspace; the
      // product now opens on instances by default.
      await wait(`Array.from(document.querySelectorAll('.ant-menu-item')).some(el=>el.textContent.includes('账号管理'))`)
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('账号管理')).click()`)
      await wait('document.querySelectorAll(".account-card").length===6')
      assert.equal(calls().length, 0, 'launch must not auto-query seeded accounts')
      assert.equal(await run('document.querySelectorAll(".account-quota-details").length'), 0, 'details start collapsed')
      assert.equal(await run('document.querySelectorAll(".account-add-card").length'), 1, 'one dedicated add-account tile')
      assert.equal(await run('document.querySelector(".account-add-card").matches(".account-card")'), false, 'add tile is not counted as an account')
      assert.match(await cardText(0), /已用\s*0%/)
      assert.match(await cardText(1), /已用\s*84%/)
      assert.match(await cardText(2), /100%/)
      assert.equal(await run(`document.querySelector(${JSON.stringify(card(2))}).querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`), '100')
      assert.match(await cardText(2), /已耗尽/)
      assert.match(await cardText(2), /附加额度仍可用/)
      for (const index of [3, 4]) {
        assert.doesNotMatch(await cardText(index), /已用\s*0%/)
        assert.equal(await run(`document.querySelector(${JSON.stringify(card(index))}).querySelectorAll('[role="progressbar"]').length`), 0, 'unknown must have no 0-percent progress')
      }
      assert.match(await cardText(5), /上次成功|历史结果/)
      assert.match(await cardText(5), /查询失败|刷新失败/)
      assert.match(await cardText(5), /另 1 个用量窗口/)
      for (const entry of accounts) {
        const identity = await run(`document.querySelector(${JSON.stringify(`.account-card[data-account-id="${entry.id}"] .account-header`)}).innerText`)
        assert.equal(identity.split(entry.email).length - 1, 1, 'same name/email is shown once')
      }
      assert.equal(await run(`document.querySelector(${JSON.stringify(card(5))}).querySelector('.account-identity strong').getAttribute('title')`), longEmail)
      assert.equal(await run('document.body.innerText.includes("fixture-account-cards-secret")'), false)
      assert.equal(await run('Array.from(document.querySelectorAll(".account-card footer button")).every(el=>!!el.getAttribute("aria-label"))'), true, 'every footer action has an accessible label')
      const footerButtons = await run(`Array.from(document.querySelectorAll('.account-card footer button')).map(el=>({label:el.getAttribute('aria-label'),text:el.innerText.trim(),icon:!!el.querySelector('svg'),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))`)
      assert.equal(footerButtons.length, 24, 'four actual actions per card')
      for (const button of footerButtons) {
        assert.equal(button.text, '', 'icon button has no visible text')
        assert.equal(button.icon, true, 'icon action contains a real svg')
        assert.ok(button.width >= 32 && button.height >= 32, 'icon action has at least a 32px hit target')
      }
      assert.equal(await run(`Array.from(document.querySelectorAll('.account-card .quota-progress[role="progressbar"]')).every(el=>getComputedStyle(el).maskImage.includes('repeating-linear-gradient'))`), true, 'default usage bars are visibly segmented')
      assert.equal(await run(`document.querySelector(${JSON.stringify(card(0))}).querySelectorAll('.quota-main-panel').length`), 1, 'two primary windows share one quiet usage panel')
      assert.equal(await run(`document.querySelector(${JSON.stringify(card(0))}).querySelectorAll('.compact-quota-window').length`), 2, 'both actual primary windows remain visible')

      await clickSelector(`${card(1)} .ant-checkbox-input`)
      await wait(`document.querySelector(${JSON.stringify(card(1))}).classList.contains('selected')`)
      assert.match(await run('document.querySelector(".account-filters").innerText'), /导出所选|取消选择/)
      const layouts = [await auditLayout('light')]
      await capture('kiro-card-light.png')
      await run(`document.querySelector(${JSON.stringify(card(3))}).scrollIntoView({block:'start'})`)
      await capture('kiro-card-unknown-light.png')
      await run('document.querySelector(".content").scrollTop=0')
      await clickSelector(action(5, '查看详情'))
      await wait('!!document.querySelector(".account-quota-details")')
      assert.match(await run('document.querySelector(".account-quota-details").innerText'), /HTTP 429/)
      assert.match(await run('document.querySelector(".account-quota-details").innerText'), /代码审查/)
      assert.equal(await run('document.querySelectorAll(".account-quota-details .quota-detail-window").length'), 3, 'all upstream quota windows remain in details')
      await closeDrawer()

      // Single-account layouts must match the real one-account product state;
      // aggregate six-card heights cannot stand in for this visual acceptance.
      await fill('.toolbar .search input', accounts[0].name)
      await wait('document.querySelectorAll(".account-card").length===1')
      layouts.push(await auditLayout('single-normal'))
      await capture('kiro-card-single-normal.png')
      await captureAccountGrid('compact-single-normal-closeup.png')
      await clickSelector('.account-add-card')
      await wait('document.querySelector(".ant-modal-title")?.textContent.includes("添加")')
      await clickSelector('.ant-modal:not([style*=none]) .ant-modal-close')
      await wait('!Array.from(document.querySelectorAll(".ant-modal")).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden")')
      await settle()
      assert.equal(calls().length, 0, 'opening the add tile does not start authorization')
      for (const [className, label] of [['account-refresh','刷新用量'], ['account-edit','编辑账号'], ['account-proxy','网络代理'], ['account-details','查看详情']]) {
        const selector = `${card(0)} .${className}`
        await showTooltip(selector, label, 'hover')
        if (className === 'account-edit') await capture('kiro-card-footer-hover.png')
        if (className === 'account-proxy') await capture('kiro-card-proxy-hover.png')
        await showTooltip(selector, label, 'focus')
        if (className === 'account-details') await capture('kiro-card-footer-focus.png')
      }
      await dismissTooltip()
      await fill('.toolbar .search input', longEmail)
      await wait('document.querySelectorAll(".account-card").length===1')
      assert.match(await cardText(5), /查询失败|刷新失败/)
      assert.match(await cardText(5), /上次成功|历史结果/)
      layouts.push(await auditLayout('single-failure-history'))
      await capture('kiro-card-single-failure-history.png')
      await captureAccountGrid('compact-single-failure-closeup.png')
      await clickSelector(action(5, '查看详情'))
      await wait('!!document.querySelector(".account-quota-details")')
      assert.match(await run('document.querySelector(".account-quota-details").innerText'), /HTTP 429/)
      assert.equal(await run('document.querySelectorAll(".account-quota-details .quota-detail-window").length'), 3)
      await capture('kiro-card-failure-details.png')
      await closeDrawer()
      await fill('.toolbar .search input', '')
      await wait('document.querySelectorAll(".account-card").length===6')

      // The existing search and bulk selection must continue to act on cards.
      await fill('.toolbar .search input', 'studio@example.invalid')
      await wait('document.querySelectorAll(".account-card").length===1')
      await fill('.toolbar .search input', '')
      await wait('document.querySelectorAll(".account-card").length===6')
      await click('.account-filters button', '选择本页')
      assert.equal(await run('document.querySelectorAll(".account-card.selected").length'), 6)
      await click('.account-filters button', '取消选择')
      assert.equal(await run('document.querySelectorAll(".account-card.selected").length'), 0)
      await run(`document.querySelector(${JSON.stringify(`${card(0)} .ant-checkbox-input`)}).focus()`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      await wait(`document.querySelector(${JSON.stringify(card(0))}).classList.contains('selected')`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      await wait(`!document.querySelector(${JSON.stringify(card(0))}).classList.contains('selected')`)

      await clickSelector(action(1, '编辑账号'))
      await wait('document.querySelector(".ant-drawer-open .ant-drawer-title")?.textContent==="编辑账号"')
      assert.equal(await run('document.querySelector(".ant-drawer-open .ant-form-item input").value'), accounts[1].name)
      await click('.ant-drawer-open button', '取消')
      await wait('!document.querySelector(".ant-drawer-open")')

      await clickSelector(action(1, '查看详情'))
      await wait('!!document.querySelector(".ant-drawer-open .account-quota-details")')
      let details = await run('document.querySelector(".account-quota-details").innerText')
      assert.match(details, /月度 Credits\s*剩余\s*17,000/)
      assert.match(details, /附加 Credits\s*剩余\s*42/)
      assert.match(details, /重置次数|可重置次数/)
      assert.match(details, /fixture-model/)
      assert.equal(await run('Array.from(document.querySelectorAll(".account-quota-details .credit-quota details")).every(el=>!el.open)'), true)
      await run('Array.from(document.querySelectorAll(".account-quota-details .credit-quota summary")).forEach(el=>el.click())')
      details = await run('document.querySelector(".account-quota-details").innerText')
      assert.match(details, /额度上限\s*25,000/)
      assert.match(details, /已用额度\s*8,000/)
      await capture('kiro-card-details-light.png')

      await click('.account-quota-details button', '刷新订阅')
      await wait(`(await window.manager.load()).accounts.find(a=>a.id===${JSON.stringify(accounts[1].id)}).subscriptionActiveUntil===${now + 35 * day}`)
      assert.equal(calls().filter(call => call.path === '/backend-api/accounts/check/v4-2023-04-27').length, 1)
      await click('.account-quota-details button', '查询重置明细')
      await wait(`(await window.manager.load()).accounts.find(a=>a.id===${JSON.stringify(accounts[1].id)}).quota.resetCredits?.length===2`)
      assert.equal(calls().filter(call => call.path === '/backend-api/wham/rate-limit-reset-credits').length, 1)
      await click('.account-quota-details button', '使用一次重置')
      await wait('!!document.querySelector(".ant-popconfirm")')
      assert.match(await run('document.querySelector(".ant-popconfirm").innerText'), /消耗上游额度/)
      await click('.ant-popconfirm button', '取消')
      await wait('!Array.from(document.querySelectorAll(".ant-popconfirm")).some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden")')
      assert.equal(calls().some(call => call.method === 'POST'), false, 'cancel must not consume a reset credit')
      assert.equal((await run('window.manager.load()')).accounts.find(value => value.id === accounts[1].id).quota.resetCreditsAvailable, 2)
      await closeDrawer()

      await clickSelector(action(0, '刷新用量'))
      await wait(`(await window.manager.load()).accounts.find(a=>a.id===${JSON.stringify(accounts[0].id)}).quota.windows[0].usedPercent===9`)
      await wait(`document.querySelector(${JSON.stringify(card(0))}).innerText.includes('9%')`)
      assert.equal(calls().filter(call => call.path === '/backend-api/wham/usage').length, 1)
      const snapshot = await run('window.manager.load()')
      await run(`window.manager.saveSettings(${JSON.stringify({ ...snapshot.settings, theme: 'dark' })})`)
      await clickSelector('button[aria-label="重新加载账号"]')
      await wait('!!document.querySelector(".app-shell.dark")')
      await clickSelector(`${card(1)} .ant-checkbox-input`)
      layouts.push(await auditLayout('dark'))
      await capture('kiro-card-dark.png')
      await run(`document.querySelector(${JSON.stringify(card(3))}).scrollIntoView({block:'start'})`)
      await capture('kiro-card-unknown-dark.png')
      await run('document.querySelector(".content").scrollTop=0')
      await clickSelector(action(1, '查看详情'))
      await wait('!!document.querySelector(".ant-drawer-open .account-quota-details")')
      await waitForVisibleDrawer()
      await capture('kiro-card-details-dark.png')
      await closeDrawer()
      // browser-window-created fires inside the constructor; native window
      // options can reapply its 940px minimum after that event. Set it here,
      // after load, before the intentionally narrower fixture measurement.
      window.setMinimumSize(720, 640)
      window.setContentSize(820, 1040)
      await wait('innerWidth===820')
      layouts.push(await auditLayout('narrow'))
      await capture('kiro-card-narrow.png')
      fs.writeFileSync(join(reports, 'kiro-card-ui-audit.json'), JSON.stringify({ layouts, footerButtons, tooltipInteractions, singleAccountStates: ['normal','failure-history'], requests: calls(), accounts: 6, resetConsumed: false, realUpstreamRequests: 0 }, null, 2))
      assert.equal((await run('window.manager.load()')).quotaRefresh.running, false)
      console.log('Account cards UI passed: six quota/error/long-email states plus single normal/error-history layouts; segmented two-window usage panel; four icon-only 32px action targets with four real pointer-hover tooltips and real Tab reachability; focus Tooltip events verified with separately recorded native-focus availability; compact light/dark/narrow layouts; selection/filter/bulk controls; editing and full detail drawer; real IPC refresh/subscription/reset query via synthetic local helper; reset confirmation cancelled without consumption. Ephemeral AES-GCM vault; no real accounts, keychain, official Codex GUI or upstream network.')
      clearTimeout(timer); app.quit()
    } catch (error) {
      console.error(error); await capture('kiro-card-failure.png').catch(() => {})
      clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit()
    }
  })
})
require('../out/main/index.js')
