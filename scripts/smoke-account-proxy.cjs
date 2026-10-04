const {app,safeStorage}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),{createServer}=require('node:http')
const childProcess=require('node:child_process'),directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
let targetURL,proxyURL,hold=false,rejectProxy=false,waiting=false,disconnected=false,proxyRequests=0
const target=createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);res.end('{"ip":"203.0.113.11"}')})
const proxy=createServer((req,res)=>{
  assert.equal(req.url,targetURL);assert.equal(req.headers.authorization,undefined)
  assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:proxy-secret').toString('base64'));proxyRequests++
  if(hold){waiting=true;req.on('close',()=>{disconnected=true});return}
  res.statusCode=rejectProxy?407:200;res.end(rejectProxy?'fixture-proxy-secret':'{"ip":"203.0.113.12"}')
})
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port+'/')))
// Redirect only the fixed public-IP target in this test harness. All transport,
// authentication and cancellation still execute in the source-built helper.
const originalSpawn=childProcess.spawn
childProcess.spawn=function(file,args,options){
  assert.notEqual(file,'/usr/bin/security','No OS keychain access in ordinary regression')
  const child=originalSpawn.call(this,file,args,options)
  if(args?.includes('-egress-http')){
    assert.equal(file,resolve('resources/bin/codex-proxy'));const end=child.stdin.end.bind(child.stdin)
    child.stdin.end=function(raw){const request=JSON.parse(raw);assert.equal(request.url,'https://api64.ipify.org?format=json');assert.equal(request.headers.authorization,undefined);request.url=targetURL;return end(JSON.stringify(request))}
  }
  return child
}
const output=resolve('.local/agent-manager-adaptation/account-proxy');fs.mkdirSync(output,{recursive:true})
console.log('Account proxy UI: temporary AES-GCM, real source-built helper, loopback target/proxy, no OS keychain or real credentials')
const watchdog=setTimeout(()=>{console.error('Account proxy UI timed out');app.exit(1)},65000)
app.on('will-quit',()=>{target.closeAllConnections();target.close();proxy.closeAllConnections();proxy.close()})
app.on('browser-window-created',(_event,window)=>{
 window.webContents.setBackgroundThrottling(false)
 window.webContents.once('did-finish-load',async()=>{
  const run=expression=>window.webContents.executeJavaScript(`(async()=>(${expression}))()`)
  const wait=async expression=>{const end=Date.now()+8000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
  const click=async(selector,text)=>{const el=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${el})`);await run(`(${el}).click()`)}
  const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
  const select=async label=>{await wait('!!document.querySelector(".account-proxy-dialog .ant-select-selector")');await run('document.querySelector(".account-proxy-dialog .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');await click('.ant-select-item-option',label)}
  const fill=async value=>{await wait('!!document.querySelector(".account-proxy-dialog input[type=password]")');await run(`(()=>{const input=document.querySelector('.account-proxy-dialog input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
  try{
   targetURL=await listen(target);proxyURL=await listen(proxy)
   await run('window.manager.saveSettings({theme:"light",defaultTier:"follow",port:16321,refreshMinutes:0,launchAtLogin:false})')
   await run('window.manager.importAccounts("at-fixture-account-proxy")');await run('window.manager.load()')
   await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('账号管理')).click()`)
   await wait('!!document.querySelector(".account-card .account-proxy")')
   await run('document.querySelector(".account-card .account-proxy").click()');await select('指定代理');await fill(proxyURL.replace('://','://fixture:proxy-secret@'))
   await click('.account-proxy-dialog button','检测出口');await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.12")');assert.equal(proxyRequests,1)
   await capture('account-proxy-tested.png');await click('.account-proxy-dialog button','保存代理')
   await wait('!document.querySelector(".account-proxy-dialog")');await run('document.querySelector(".account-card .account-proxy").click()')
   await wait('!!document.querySelector(".account-proxy-dialog input[type=password]")');assert.equal(await run('document.querySelector(".account-proxy-dialog input[type=password]").value'),'')
   const snapshot=await run('window.manager.load()');assert.equal(snapshot.accounts[0].egressProxy.mode,'custom');assert.equal(JSON.stringify(snapshot).includes('proxy-secret'),false)
   assert.equal(JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault')))).accounts[0].proxy.url,proxyURL.replace('://','://fixture:proxy-secret@'))
   rejectProxy=true;await click('.account-proxy-dialog button','检测出口');await wait('document.querySelector(".account-proxy-dialog").textContent.includes("HTTP 407")')
   assert.equal(await run('document.querySelector(".account-proxy-dialog").textContent.includes("manager:invoke")'),false)
   assert.equal(await run('document.querySelector(".account-proxy-dialog").textContent.includes("fixture-proxy-secret")'),false);rejectProxy=false
   await capture('account-proxy-refused.png')
   hold=true;await click('.account-proxy-dialog button','检测出口')
   const end=Date.now()+5000;while(!waiting){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,25))}
   await click('.account-proxy-dialog button','取消');await wait('!document.querySelector(".account-proxy-dialog")')
   const cancelEnd=Date.now()+5000;while(!disconnected){assert.ok(Date.now()<cancelEnd,'closing the dialog cancels the real helper');await new Promise(resolve=>setTimeout(resolve,25))};hold=false
   await run('document.querySelector(".account-card .account-proxy").click()');await select('直连');const before=proxyRequests
   await click('.account-proxy-dialog button','检测出口');await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.11")');assert.equal(proxyRequests,before)
   await capture('account-proxy-direct.png');await click('.account-proxy-dialog button','保存代理');await wait('!document.querySelector(".account-proxy-dialog")')
   assert.equal((await run('window.manager.load()')).accounts[0].egressProxy.mode,'direct')
   console.log('Account proxy UI passed: actual dropdown/input/probe/save, stored-secret masking, HTTP 407 with no fallback, close cancels real helper connection, direct bypass and persisted mode. No real system credentials or upstream calls.')
   clearTimeout(watchdog);app.quit()
  }catch(error){console.error(error);await capture('account-proxy-failure.png').catch(()=>{});clearTimeout(watchdog);app.once('will-quit',()=>app.exit(1));app.quit()}
 })
})
require('../out/main/index.js')
