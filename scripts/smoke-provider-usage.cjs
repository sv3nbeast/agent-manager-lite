const { app, safeStorage } = require('electron')
const { createServer } = require('node:http')
const fs = require('node:fs'), { join, resolve, sep, basename } = require('node:path'), { tmpdir } = require('node:os'), assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
let upstream, mode = 'ok', pending, count = 0
const requestPaths = []
// Test-only destination rewrite. Product code still chooses official hosts and
// authentication; bytes go through real loopback HTTP, never a paid provider.
const originalFetch=global.fetch
global.fetch=(input,init)=>{
  const url=new URL(input)
  const provider={'api.deepseek.com':'deepseek','api.minimax.io':'minimax','api.z.ai':'zhipu'}[url.hostname]
  if(provider){assert.ok(upstream?.listening);return originalFetch(`http://127.0.0.1:${upstream.address().port}/official/${provider}${url.pathname}`,init)}
  assert.equal(url.hostname,'127.0.0.1','unexpected external request in quota fixture')
  return originalFetch(input,init)
}
app.on('will-quit', () => { upstream?.closeAllConnections(); upstream?.close() })
const timer = setTimeout(() => { console.error('Provider quota UI exceeded 75 seconds'); app.exit(1) }, 75000)
const output = resolve('docs/evidence/compact-cards/provider-usage'); fs.mkdirSync(output, { recursive: true })
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait = async expression => { const end = Date.now() + 12000; while (!await run(expression)) { assert.ok(Date.now() < end, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const click = async (selector, text) => { const expr = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`; await wait(`!!(${expr})`); await run(`(${expr}).click()`) }
    const clickSelector = async selector => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await run(`document.querySelector(${JSON.stringify(selector)}).click()`) }
    const renderFrames = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const cardLayouts = []
    const auditCards = async state => {
      await renderFrames()
      const result = await run(`(()=>({state:${JSON.stringify(state)},viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,cards:Array.from(document.querySelectorAll('.account-card')).map(el=>{const box=el.getBoundingClientRect();return{name:el.querySelector('.account-identity strong')?.textContent,width:box.width,height:box.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,summary:el.querySelector('.account-quota-summary')?.innerText}})}))()`)
      cardLayouts.push(result)
      fs.writeFileSync(join(output, 'api-connection-layouts.json'), JSON.stringify(cardLayouts, null, 2))
      assert.ok(result.documentWidth <= result.viewport + 1, `${state}: API connection page overflows horizontally`)
      assert.ok(result.cards.length > 0, `${state}: API connection cards remain present`)
      for (const card of result.cards) {
        assert.ok(card.width <= 320.1, `${state}: API connection width ${card.width} exceeds 320px`)
        assert.ok(card.scrollWidth <= card.clientWidth + 1, `${state}: API connection ${card.name} overflows horizontally`)
      }
      return result
    }
    const openAccountDetails = async index => {
      await run(`document.querySelectorAll('.account-card')[${index - 1}].querySelector('footer button.account-details').click()`)
      await wait('!!document.querySelector(".ant-drawer-open .account-quota-details")')
    }
    const closeAccountDetails = async () => {
      await run('document.querySelector(".ant-drawer-open .ant-drawer-close").click()')
      await wait('!document.querySelector(".ant-drawer-open")')
      await wait('!document.querySelector(".account-quota-details")')
    }
    const capture = async name => {
      // Vue/Ant can schedule a transition on the next frame after the content
      // exists. Flush those frames before collecting finite animations.
      await renderFrames()
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await renderFrames()
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
    try {
      // Account suites explicitly enter the shared account workspace; the
      // product now opens on instances by default.
      await wait(`Array.from(document.querySelectorAll('.ant-menu-item')).some(el=>el.textContent.includes('账号管理'))`)
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('账号管理')).click()`)
      upstream = createServer((req, res) => {
        count++
        requestPaths.push(req.url)
        if(req.url==='/official/zhipu/api/monitor/usage/quota/limit'){
          assert.equal(req.headers.authorization,'fixture-zhipu-secret')
          json(res,{success:true,data:{level:'Fixture Pro',limits:[{type:'TOKENS_LIMIT',usage:100,currentValue:25,nextResetTime:1791600000000},{type:'TOKENS_LIMIT',percentage:50,nextResetTime:1791000000000}]}});return
        }
        assert.match(req.headers.authorization, /^Bearer fixture-/)
        if(req.url==='/official/deepseek/user/balance'){
          assert.equal(req.headers.authorization,'Bearer fixture-deepseek-secret')
          if(mode==='empty-deepseek'){json(res,{is_available:false,balance_infos:[{currency:'CNY',total_balance:'0'}]});return}
          json(res,{is_available:true,balance_infos:[{currency:'USD',total_balance:'5'},{currency:'CNY',total_balance:'12.5',granted_balance:'2.5',topped_up_balance:'10'}]});return
        }
        if(req.url==='/official/minimax/v1/token_plan/remains'){
          assert.equal(req.headers.authorization,'Bearer fixture-minimax-secret')
          json(res,{base_resp:{status_code:0},model_remains:[{model_name:'MiniMax-M-fixture',current_interval_total_count:200,current_interval_usage_count:150,current_weekly_total_count:1000,current_weekly_usage_count:0,end_time:1791000000000,weekly_end_time:1791600000000}]});return
        }
        if (req.url === '/sub/v1/usage') {
          if (mode === 'hold') { pending = res; return }
          if (mode === 'error') { res.writeHead(429).end('fixture-sub-secret'); return }
          if (mode === 'unlimited-sub') { json(res, { quota: { unlimited: true } }); return }
          json(res, { remaining: 16.5, unit: 'USD', quota: { used: 3.5, limit: 20 }, usage: { today: { requests: 7, total_tokens: 1200, cost: 0 }, total: { requests: 100, total_tokens: 120000, cost: 3.5 } } }); return
        }
        if (req.url === '/new/v1/dashboard/billing/subscription') { json(res, { hard_limit_usd: 100, access_until: 1790000000 }); return }
        if (req.url === '/new/v1/dashboard/billing/usage') { json(res, { total_usage: 250 }); return }
        if (req.url === '/new/v1/api/usage/token/') { json(res, { data: { expires_at: 1791000000 } }); return }
        res.writeHead(404).end()
      })
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${upstream.address().port}`
      for (const [name, path, apiKey] of [['Sub2API 测试账号', '/sub/v1', 'fixture-sub-secret'], ['New API 测试账号', '/new/v1', 'fixture-new-secret'], ['未支持的服务商', '/unknown', 'fixture-unknown-secret']]) {
        await run(`window.manager.addAccount(${JSON.stringify({ name, baseUrl: base + path, apiKey, models: ['fixture-model'] })})`)
      }
      await click('button[aria-label="重新加载账号"]', '')
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await wait(`!!document.querySelector('.provider-library')`)
      await run('document.getElementById("api-connections-tab").click()')
      await wait('document.querySelectorAll(".account-card .account-quota-summary").length===3')
      assert.equal(count, 0, 'rendering new API accounts must not probe automatically')
      assert.equal(await run('document.querySelectorAll(".account-card")[0].textContent.includes("尚未查询")'), true)
      await auditCards('unqueried-light')
      await click('.toolbar button', '刷新全部用量')
      await wait('document.querySelectorAll(".account-quota-summary")[0].textContent.includes("16.5 USD")')
      await wait('document.querySelectorAll(".account-quota-summary")[1].textContent.includes("97.5")')
      await wait('document.querySelectorAll(".account-quota-summary")[2].textContent.includes("未知")')
      await auditCards('currency-and-unknown-light')
      await capture('api-connections-light.png')
      const snapshot = await run('window.manager.load()')
      assert.equal(JSON.stringify(snapshot).includes('fixture-sub-secret'), false)
      assert.equal(snapshot.quotaRefresh.total, 3); assert.equal(snapshot.quotaRefresh.failed, 1)
      assert.equal(snapshot.accounts.some(account => account.quota), false)
      assert.equal(snapshot.accounts[1].providerUsage.summary.expiresAt, 1791000000000)
      assert.equal(snapshot.accounts[1].providerUsage.summary.accessUntil, 1790000000000)
      const vaultBytes = fs.readFileSync(join(directory, 'state.vault'))
      assert.equal(vaultBytes.includes(Buffer.from('fixture-sub-secret')), false)
      assert.equal(JSON.parse(safeStorage.decryptString(vaultBytes)).accounts[0].providerUsage.summary.remaining, 16.5)
      assert.equal(await run('document.querySelectorAll(".account-card .provider-usage-details").length'), 0, 'full provider data belongs in account details')
      await openAccountDetails(1)
      assert.equal(await run('Array.from(document.querySelectorAll(".account-quota-details .provider-usage-details")).every(el=>!el.open)'), true)
      await click('.account-quota-details .provider-usage-details summary', '用量详情')
      const details = await run('document.querySelector(".provider-usage-details").innerText')
      assert.match(details, /今日费用\s*0 USD/); assert.match(details, /累计请求\s*100/)
      assert.match(details, /累计 Token\s*120,000/); assert.match(details, /累计费用\s*3.5 USD/)
      await capture('provider-usage-details.png')
      await closeAccountDetails()
      await openAccountDetails(2)
      await click('.account-quota-details .provider-usage-details summary', '用量详情')
      const expiry = await run('document.querySelector(".account-quota-details .provider-usage-details").innerText')
      assert.match(await run('document.querySelector(".account-quota-details .provider-usage").innerText'), /97.5 （单位未知）/)
      assert.equal(expiry.includes(await run('new Date(1791000000000).toLocaleString()')), true)
      assert.equal(expiry.includes(await run('new Date(1790000000000).toLocaleString()')), true)
      await closeAccountDetails()
      mode = 'unlimited-sub'; await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('document.querySelector(".account-card .account-quota-summary").textContent.includes("不限量")')
      assert.equal(await run('document.querySelector(".account-card .account-quota-summary").textContent.includes("0 USD")'), false, 'unlimited quota is not shown as zero currency balance')
      await auditCards('unlimited-light')
      mode = 'ok'; await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('document.querySelector(".account-card .account-quota-summary").textContent.includes("16.5 USD")')
      mode = 'error'; await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('document.querySelector(".account-card").textContent.includes("上次成功结果")')
      assert.equal(await run('document.querySelector(".account-card").textContent.includes("16.5 USD")'), true)
      await openAccountDetails(1)
      assert.equal(await run('document.querySelector(".provider-usage").textContent.includes("HTTP 429")'), true)
      assert.equal(await run('document.body.textContent.includes("fixture-sub-secret")'), false)
      await closeAccountDetails()
      mode = 'ok'; await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('!document.querySelector(".account-card:first-child .quota-query-error")')
      const prior = (await run('window.manager.load()')).accounts[0].providerUsage
      mode = 'hold'; await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('document.querySelector(".error-banner")?.textContent.includes("正在刷新用量")')
      await click('.error-banner button', '取消刷新')
      await wait('!(await window.manager.load()).quotaRefresh.running')
      assert.deepEqual((await run('window.manager.load()')).accounts[0].providerUsage, prior)
      pending?.end(); mode = 'ok'
      await run('document.querySelector(".account-card:first-child .ant-checkbox-input").click()')
      await click('.toolbar button', '刷新所选用量')
      await wait('!(await window.manager.load()).quotaRefresh.running')
      assert.equal((await run('window.manager.load()')).quotaRefresh.total, 1)
      await run('document.querySelector(".account-card:first-child .ant-checkbox-input").click()')
      for(const [name,baseUrl,apiKey] of [['DeepSeek 余额','https://api.deepseek.com/v1','fixture-deepseek-secret'],['MiniMax 周额度用尽','https://api.minimax.io/v1','fixture-minimax-secret'],['智谱多个窗口','https://api.z.ai/api/coding/paas/v4','fixture-zhipu-secret']]){
        await run(`window.manager.addAccount(${JSON.stringify({name,baseUrl,apiKey,models:['fixture-model']})})`)
      }
      await click('button[aria-label="重新加载账号"]','');await wait('document.querySelectorAll(".account-card").length===6')
      await click('.toolbar button','刷新全部用量');await wait('!(await window.manager.load()).quotaRefresh.running')
      const official=(await run('window.manager.load()')).accounts.slice(3)
      assert.deepEqual(official.map(a=>a.providerUsage.summary.source),['deepseek','minimax','zhipu'])
      assert.equal(official.some(a=>a.quota),false)
      const card=index=>`.account-card:nth-child(${index})`
      await wait('document.querySelector(".account-card:nth-child(4)").textContent.includes("12.5 CNY")')
      await openAccountDetails(4)
      await click('.account-quota-details .provider-usage-details summary','用量详情')
      const ds=await run('document.querySelector(".account-quota-details").innerText')
      assert.match(ds,/赠送余额\s*2.5 CNY/);assert.match(ds,/充值余额\s*10 CNY/)
      await closeAccountDetails()
      await openAccountDetails(5)
      const mm=await run('document.querySelector(".account-quota-details").innerText')
      assert.match(mm,/最低窗口剩余\s*0 %/);assert.match(mm,/周期额度\s*已用 25%/);assert.match(mm,/周额度\s*已用 100%/);assert.match(mm,/用量窗口已用尽/)
      await closeAccountDetails()
      await openAccountDetails(6)
      const zp=await run('document.querySelector(".account-quota-details").innerText')
      assert.match(zp,/额度窗口 1\s*已用 50%/);assert.match(zp,/额度窗口 2\s*已用 25%/);assert.equal(zp.includes('周额度'),false)
      assert.equal(await run('document.body.innerText.includes("fixture-deepseek-secret") || document.body.innerText.includes("fixture-zhipu-secret")'),false)
      await closeAccountDetails()
      await auditCards('official-plans-light')
      await run('document.querySelector(".account-card:nth-child(4)").scrollIntoView({block:"start"})');await capture('provider-plans-light.png')
      const settings=(await run('window.manager.load()')).settings
      await run(`window.manager.saveSettings(${JSON.stringify({...settings,theme:'dark'})})`);await click('button[aria-label="重新加载账号"]','')
      await wait('!!document.querySelector(".app-shell.dark")')
      await auditCards('official-plans-dark')
      await run('document.querySelector(".account-card:nth-child(4)").scrollIntoView({block:"start"})');await capture('provider-plans-dark.png')
      const stored=JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
      assert.equal(stored.accounts[4].providerUsage.summary.windows[1].remainingPercent,0)
      mode='empty-deepseek';await clickSelector(card(4)+' footer button.account-refresh')
      await wait('document.querySelector(".account-card:nth-child(4)").textContent.includes("服务商报告余额不足")')
      assert.equal(await run('document.querySelector(".account-card:nth-child(4)").textContent.includes("此密钥不可用")'),false)
      await auditCards('zero-balance-dark')
      // Exercise actual editors and query paths, including the linked provider's
      // setting. The automatic official-provider checks above remain unchanged.
      const chooseIntegration = async (label, value) => {
        await run(`document.querySelector('[aria-label=${JSON.stringify(label)}]').scrollIntoView({block:'center'})`)
        await run(`document.querySelector('[aria-label=${JSON.stringify(label)}]').closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
        await click('.ant-select-item-option',value)
      }
      const input = async (label, value) => run(`(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await run('document.querySelector(".account-card:first-child").scrollIntoView({block:"start"})')
      await clickSelector('.account-card:first-child footer button.account-edit')
      await wait('!!document.querySelector("[aria-label=账号额度查询方式]")')
      await chooseIntegration('账号额度查询方式','Sub2API')
      await capture('integration-type-account.png')
      await click('.ant-drawer-open button','保存账号');await wait('!document.querySelector(".ant-drawer-open")')
      assert.equal((await run('window.manager.load()')).accounts[0].integrationType,'sub2api')
      assert.equal((await run('window.manager.load()')).accounts[0].providerUsage,undefined)
      requestPaths.length=0
      await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('!(await window.manager.load()).quotaRefresh.running')
      assert.deepEqual(requestPaths,['/sub/v1/usage'])
      await run('document.getElementById("provider-library-tab").click()');await click('.provider-library button','添加供应商')
      await wait('!!document.querySelector("[aria-label=供应商名称]")')
      await input('供应商名称','指定额度接口');await input('供应商地址',base+'/sub/v1')
      await run(`(()=>{const el=document.querySelector('[aria-label=供应商模型] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'fixture-model');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await run(`document.querySelector('[aria-label=供应商模型] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))`)
      await wait(`document.querySelector('.model-discovery').textContent.includes('已选 1 / 500')`)
      await click('.provider-advanced-settings .ant-collapse-header','高级设置 · 协议、额度与模型能力')
      await wait('!!document.querySelector("[aria-label=供应商额度查询方式]")')
      await chooseIntegration('供应商额度查询方式','New API')
      await capture('integration-type-provider.png')
      await click('.ant-drawer-open button','保存供应商');await wait('!document.querySelector(".ant-drawer-open")')
      let current=await run('window.manager.load()'),provider=current.providers[0],linked=current.accounts[0]
      assert.equal(provider.integrationType,'new_api')
      await run(`window.manager.mutateProvider(${JSON.stringify({action:'linkAccount',id:provider.id,revision:provider.revision,keyId:provider.keys[0].id,accountId:linked.id,accountRevision:linked.revision})})`)
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await wait(`!!document.querySelector('.provider-library')`)
      await run('document.getElementById("api-connections-tab").click()')
      await click('button[aria-label="重新加载账号"]','')
      await clickSelector('.account-card:first-child footer button.account-edit');await wait('!!document.querySelector(".connection-shared-config")')
      assert.equal(await run('!!document.querySelector("[aria-label=账号额度查询方式]")'),false)
      await click('.ant-drawer-open button','取消');await wait('!document.querySelector(".ant-drawer-open")')
      requestPaths.length=0;await clickSelector('.account-card:first-child footer button.account-refresh')
      await wait('!(await window.manager.load()).quotaRefresh.running')
      assert.deepEqual(requestPaths,['/sub/v1/dashboard/billing/subscription'])
      assert.equal((await run('window.manager.load()')).accounts[0].providerUsage.unavailable,true)
      await run('document.getElementById("provider-library-tab").click()');await click('.provider-detail button','编辑供应商')
      await click('.provider-advanced-settings .ant-collapse-header','高级设置 · 协议、额度与模型能力')
      await wait('!!document.querySelector("[aria-label=供应商额度查询方式]")');await chooseIntegration('供应商额度查询方式','Sub2API')
      await click('.ant-drawer-open button','保存供应商');await wait('!document.querySelector(".ant-drawer-open")')
      current=await run('window.manager.load()');assert.equal(current.accounts[0].integrationType,'sub2api');assert.equal(current.accounts[0].providerUsage,undefined)
      const saved=JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
      assert.equal(saved.providers[0].integrationType,'sub2api');assert.equal(saved.accounts[0].integrationType,'sub2api')
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await wait(`!!document.querySelector('.provider-library')`)
      await run('document.getElementById("api-connections-tab").click()')
      await click('button[aria-label="重新加载账号"]','')
      await clickSelector('.account-card:first-child footer button.account-edit');await wait('!!document.querySelector(".connection-shared-config")')
      await click('.ant-drawer-open button','解除关联');await wait('!document.querySelector(".ant-drawer-open")')
      await clickSelector('.account-card:first-child footer button.account-edit');await wait('!!document.querySelector("[aria-label=账号额度查询方式]")')
      assert.equal(await run('document.querySelector("[aria-label=账号额度查询方式]").closest(".ant-select").classList.contains("ant-select-disabled")'),false)
      assert.equal((await run('window.manager.load()')).accounts[0].integrationType,'sub2api')
      await click('.ant-drawer-open button','取消')
      current=await run('window.manager.load()');const accountCount=current.accounts.length
      for(let i=0;i<12;i++){
        provider=(await run('window.manager.load()')).providers[0]
        await run(`window.manager.mutateProvider(${JSON.stringify({action:'addKey',id:provider.id,revision:provider.revision,name:`独立密钥 ${i+1}`,apiKey:`fixture-library-secret-${i}`})})`)
      }
      await run('document.getElementById("provider-library-tab").click()')
      await wait('document.querySelectorAll(".provider-key-table tbody tr[data-row-key]").length===10')
      assert.equal((await run('window.manager.load()')).accounts.length,accountCount)
      mode='ok';requestPaths.length=0
      await click('.provider-detail button','刷新全部密钥额度')
      await wait('(await window.manager.load()).providers[0].keys.every(key=>key.usage?.summary) && !(await window.manager.load()).providerUsageRefresh.running')
      current=await run('window.manager.load()');assert.equal(current.providerUsageRefresh.total,13);assert.equal(requestPaths.length,13)
      assert.ok(requestPaths.every(path=>path==='/sub/v1/usage'))
      assert.equal(JSON.stringify(current).includes('fixture-library-secret'),false)
      await wait('document.querySelectorAll(".provider-key-usage")[1]?.textContent.includes("16.5 USD")')
      await capture('provider-library-usage.png')
      const independentRow=`.provider-key-table tbody tr[data-row-key="${current.providers[0].keys[1].id}"]`
      await click(independentRow+' button','详情')
      await wait('document.querySelector(".ant-modal .provider-usage")?.textContent.includes("16.5 USD")')
      await click('.ant-modal .provider-usage-details summary','用量详情')
      assert.match(await run('document.querySelector(".ant-modal .provider-usage").textContent'),/累计请求\s*100/)
      await wait('Array.from(document.querySelectorAll(".ant-modal")).some(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return box.width>=500&&box.height>=200&&style.opacity==="1"&&style.transform==="none"&&!el.className.includes("zoom-enter")})')
      await capture('provider-library-usage-details.png')
      await run('document.querySelector(".ant-modal-close").click()');await wait('!Array.from(document.querySelectorAll(".ant-modal-wrap")).some(el=>el.getClientRects().length)')
      mode='error';await click(independentRow+' button','查询额度')
      await wait('(await window.manager.load()).providers[0].keys[1].usage?.error?.includes("HTTP 429")')
      assert.equal((await run('window.manager.load()')).providers[0].keys[1].usage.summary.remaining,16.5)
      const beforeCancel=(await run('window.manager.load()')).providers[0].keys.map(key=>key.usage)
      mode='hold';requestPaths.length=0;await click('.provider-detail button','刷新全部密钥额度')
      await wait('(await window.manager.load()).providerUsageRefresh.activeKeyIds.length===3')
      await click('.provider-usage-progress button','取消额度查询')
      await wait('!(await window.manager.load()).providerUsageRefresh.running')
      assert.ok(requestPaths.length<=3)
      assert.deepEqual((await run('window.manager.load()')).providers[0].keys.map(key=>key.usage),beforeCancel)
      pending?.end();mode='ok'
      const finalVault=JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
      assert.equal(finalVault.providers[0].keys[12].usage.summary.remaining,16.5)
      assert.equal(finalVault.accounts.length,accountCount)
      assert.equal(fs.readFileSync(join(directory,'state.vault')).includes(Buffer.from('fixture-library-secret')),false)
      console.log('Provider quota UI passed: automatic and manual protocols, actual account/provider editors, linked/disabled setting, no cross-protocol fallback, selection change invalidation, detachment and vault persistence; official provider windows, cancellation and prior Sub2API/New API checks. Temporary AES-GCM; no real keychain/accounts.')
      console.log('Provider library quota passed: independent keys, 13 keys across pages, selected-key details, bulk progress and cancellation, failure retains prior balance, encrypted persistence, no account creation or credential disclosure.')
      clearTimeout(timer); app.quit()
    } catch (error) { console.error(error); await capture('provider-usage-failure.png').catch(() => {}); clearTimeout(timer); app.once('will-quit', () => app.exit(1)); app.quit() }
  })
})
require('../out/main/index.js')
