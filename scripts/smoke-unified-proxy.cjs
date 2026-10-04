const {app,safeStorage}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),{createServer}=require('node:http'),{randomUUID}=require('node:crypto')
const childProcess=require('node:child_process'),directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
let targetURL,sharedURL,ownURL,hits=0,directHits=0
const servers=[]
async function listen(handler){const server=createServer(handler);servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/'}
const originalSpawn=childProcess.spawn
childProcess.spawn=function(file,args,options){
  assert.notEqual(file,'/usr/bin/security','No OS keychain access in ordinary regression')
  const child=originalSpawn.call(this,file,args,options)
  if(args?.includes('-egress-http')){
    assert.equal(file,resolve('resources/bin/codex-proxy'));const end=child.stdin.end.bind(child.stdin)
    child.stdin.end=function(raw){const value=JSON.parse(raw);assert.equal(value.url,'https://api64.ipify.org?format=json');assert.equal(value.headers.authorization,undefined);value.url=targetURL;return end(JSON.stringify(value))}
  }
  return child
}
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
const watchdog=setTimeout(()=>{console.error('Unified proxy UI timed out');app.exit(1)},75000)
app.on('will-quit',()=>{for(const server of servers){server.closeAllConnections();server.close()}})
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=expression=>window.webContents.executeJavaScript(`(async()=>(${expression}))()`)
    const wait=async expression=>{const end=Date.now()+8000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
    const click=async(selector,text)=>{if(await require('./desktop-network-entry.cjs').clickEntry(run,wait,selector))return;const el=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${el})`);await run(`(${el}).click()`)}
    const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const openResources=()=>click('.proxy-resources-trigger','代理资源与统一出口')
    const closeResources=async()=>{await run('document.querySelector(".proxy-resources-panel").closest(".ant-modal-content").querySelector(".ant-modal-close").click()');await wait('!document.querySelector(".proxy-resources-panel")')}
    const confirm=async()=>{await click('.proxy-change-preview button','确认应用');await wait('!document.querySelector(".proxy-change-preview")')}
    const select=async(selector,label)=>{await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);await click('.ant-select-item-option',label)}
    const card=async(name,button)=>{const el=`Array.from(document.querySelectorAll('.account-card')).find(el=>el.querySelector('.account-identity strong').textContent===${JSON.stringify(name)})`;await wait(`!!(${el})`);await run(`Array.from((${el}).querySelectorAll('button')).find(el=>el.textContent===${JSON.stringify(button)}).click()`)}
    try{
      await wait('!!document.querySelector(".account-card")')
      const initial=await run('window.manager.load()');assert.equal(initial.accounts.length,3)
      await openResources();await click('.proxy-resource-toolbar button','添加手动代理')
      await fill('.proxy-resource-editor input[type=text]','共享出口');await fill('.proxy-resource-editor input[type=password]',sharedURL)
      await click('.proxy-resource-editor button','预览变更');await wait('!!document.querySelector(".proxy-change-preview")')
      assert.equal(await run('document.querySelector(".proxy-change-preview").textContent.includes("fixture-secret")'),false)
      await confirm();await click('.proxy-resources-panel .ant-table-row button','设为统一')
      await wait('document.querySelector(".proxy-change-preview").textContent.includes("改变 1 个账号")')
      await capture('unified-proxy-preview.png');await confirm()
      let snapshot=await run('window.manager.load()');assert.equal(snapshot.proxyResources.unified.mode,'all_accounts');assert.equal(snapshot.proxyResources.inherited,1);assert.equal(snapshot.proxyResources.independent,1);assert.equal(snapshot.proxyResources.direct,1)
      assert.equal(snapshot.accounts.find(a=>a.name==='跟随账号').egressProxy.source,'unified')
      assert.equal(JSON.stringify(snapshot).includes('fixture-secret'),false)
      await capture('unified-proxy-enabled.png');await closeResources()
      await card('跟随账号','统一代理');await click('.account-proxy-dialog button','检测出口')
      await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.20")');assert.equal(hits,1);assert.equal(directHits,0)
      await click('.account-proxy-dialog button','关闭');await wait('!document.querySelector(".account-proxy-dialog")')
      await openResources();await click('.proxy-unified-status button','关闭统一代理');await confirm()
      snapshot=await run('window.manager.load()');assert.equal(snapshot.accounts.find(a=>a.name==='独立账号').egressProxy.mode,'custom');assert.equal(snapshot.accounts.find(a=>a.name==='直连账号').egressProxy.mode,'direct')
      await click('.proxy-resources-panel .ant-table-row button','设为统一');await confirm()
      await click('.proxy-resources-panel .ant-table-row button','编辑');assert.equal(await run('document.querySelector(".proxy-resource-editor input[type=password]").value'),'')
      await fill('.proxy-resource-editor input[type=text]','共享出口已改名');await click('.proxy-resource-editor button','预览变更');await confirm()
      snapshot=await run('window.manager.load()');assert.equal(snapshot.proxyResources.unified.name,'共享出口已改名')
      const vault=JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))));assert.equal(vault.proxyResources[0].url,sharedURL);assert.equal(vault.accounts.find(a=>a.name==='独立账号').proxy.url,ownURL)
      await closeResources();await card('直连账号','直连');await select('.proxy-mode .ant-select-selector','使用代理资源');await select('.proxy-resource-choice .ant-select-selector','共享出口已改名')
      await click('.account-proxy-dialog button','检测出口');await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.20")')
      await click('.account-proxy-dialog button','保存代理');await wait('!document.querySelector(".account-proxy-dialog")')
      snapshot=await run('window.manager.load()');assert.equal(snapshot.accounts.find(a=>a.name==='直连账号').egressProxy.mode,'resource')
      await openResources();await click('.proxy-resources-panel .ant-table-row button','删除')
      await wait('document.querySelector(".proxy-change-preview").textContent.includes("改变 2 个账号")')
      assert.equal(await run('document.querySelector(".proxy-change-preview").textContent.includes("移除 1 个资源绑定")'),true)
      await capture('unified-proxy-removal.png');await confirm()
      snapshot=await run('window.manager.load()');assert.equal(snapshot.proxyResources.resources.length,0);assert.equal(snapshot.proxyResources.unified.mode,'off');assert.equal(snapshot.accounts.find(a=>a.name==='独立账号').egressProxy.mode,'custom')
      assert.equal(snapshot.accounts.find(a=>a.name==='直连账号').egressProxy.mode,'inherit')
      console.log('Unified proxy UI passed: resource create/preview/apply, safe summary, inherited real egress, independent/direct precedence, disable preservation, rename retains secret, account resource binding, deletion impact and atomic clear. Temporary AES-GCM; no OS keychain or external upstream.')
      clearTimeout(watchdog);app.quit()
    }catch(error){console.error(error);await capture('unified-proxy-failure.png').catch(()=>{});clearTimeout(watchdog);app.once('will-quit',()=>app.exit(1));app.quit()}
  })
})
;(async()=>{
  targetURL=await listen((_req,res)=>{directHits++;res.end('{"ip":"203.0.113.10"}')})
  sharedURL=(await listen((req,res)=>{assert.equal(req.url,targetURL);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:fixture-secret').toString('base64'));hits++;res.end('{"ip":"203.0.113.20"}')})).replace('://','://fixture:fixture-secret@')
  ownURL=await listen((_req,res)=>{res.end('{"ip":"203.0.113.30"}')})
  const accounts=['跟随账号','独立账号','直连账号'].map((name,index)=>({id:randomUUID(),revision:0,name,kind:'oauth',baseUrl:'https://chatgpt.com',wireApi:'responses',models:[],tags:[],note:'',defaultTier:'inherit',createdAt:Date.now(),credentials:{accessToken:'at-unified-'+index},...(index===1?{proxy:{mode:'custom',url:ownURL}}:index===2?{proxy:{mode:'direct'}}:{})}))
  fs.writeFileSync(join(directory,'state.vault'),safeStorage.encryptString(JSON.stringify({version:1,settings:{theme:'light',defaultTier:'follow',port:16321,refreshMinutes:0,launchAtLogin:false},accounts,groups:[]})),{mode:0o600})
  console.log('Unified proxy UI: temporary AES-GCM, source-built helper, loopback proxies, synthetic accounts')
  require('../out/main/index.js')
})().catch(error=>{console.error(error);app.exit(1)})
