const {app,safeStorage,dialog}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),{createServer}=require('node:http'),{randomUUID}=require('node:crypto')
const cp=require('node:child_process'),directory=process.env.CML_TEST_DATA_DIR,archive=process.env.CML_TEST_ENGINE_ARCHIVE
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
assert.ok(archive&&fs.existsSync(archive),'Set CML_TEST_ENGINE_ARCHIVE to the pinned official archive')
require('./test-vault.cjs').installTestVault(safeStorage)
let targetURL,proxyURL,hits=0,directHits=0,closeSockets
const servers=[]
async function listen(handler){const server=createServer(handler);servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/'}
const originalSpawn=cp.spawn
cp.spawn=function(file,args,options){
 assert.notEqual(file,'/usr/bin/security','No real system keychain access')
 const child=originalSpawn.call(this,file,args,options)
 if(args?.includes('-egress-http')){const end=child.stdin.end.bind(child.stdin);child.stdin.end=function(raw){const value=JSON.parse(raw);assert.equal(value.url,'https://api64.ipify.org?format=json');assert.equal(value.headers.authorization,undefined);value.url=targetURL;return end(JSON.stringify(value))}}
 return child
}
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]})
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Catalog UI exceeded 75 seconds');app.exit(1)},75000)
app.on('will-quit',()=>{closeSockets?.();for(const server of servers){server.closeAllConnections();server.close()}})
const accountId=randomUUID()
app.on('browser-window-created',(_event,window)=>{
 window.webContents.setBackgroundThrottling(false)
 window.webContents.once('did-finish-load',async()=>{
  const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
  const wait=async expression=>{const end=Date.now()+10000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
  const click=async(selector,text)=>{if(await require('./desktop-network-entry.cjs').clickEntry(run,wait,selector))return;const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
  const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
  const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
  const close=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-modal-content').querySelector('.ant-modal-close').click()`);await wait(`!document.querySelector(${JSON.stringify(selector)})`)}
  const vault=()=>JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
  const confirm=async()=>{await click('.catalog-confirm button','确认应用');await wait('!document.querySelector(".catalog-confirm")')}
  const chooseRow=async(name,label='选择',selector='.catalog-items')=>{const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector+' tbody tr')})).find(r=>r.textContent.includes(${JSON.stringify(name)}))`;await wait(`!!(${expr})`);await run(`Array.from((${expr}).querySelectorAll('button')).find(b=>b.textContent.replace(/\\s/g,'')===${JSON.stringify(label)}).click()`)}
  try{
   await wait('document.querySelectorAll(".account-card").length===1')
   await run('window.manager.importProxyEngine()');await wait('window.manager.proxyEngineStatus().then(s=>s.phase==="completed")')
   await click('.proxy-resources-trigger','代理资源与统一出口');await click('.proxy-catalog-trigger','来源目录')
   await click('.proxy-catalog-panel button','导入目录')
   const proxy=new URL(proxyURL),nodes=Array.from({length:61},(_,i)=>({name:`Node ${String(i).padStart(2,'0')}`,type:'http',server:'127.0.0.1',port:Number(proxy.port),username:'fixture',password:'batch-password'}))
   const data=JSON.stringify({proxies:[...nodes,{name:'Invalid',type:'unsupported'}],'proxy-groups':[{name:'Manual',type:'select',proxies:['Invalid',...nodes.map(n=>n.name)]},{name:'Auto',type:'fallback',proxies:['Node 00','Node 01']},{name:'Broken auto',type:'url-test',proxies:['Node 00','Invalid']}]})
   await fill('.catalog-editor input', 'Fixture directory');await fill('.catalog-editor textarea',data);await click('.catalog-editor button','预览目录')
   await wait('!!document.querySelector(".catalog-confirm")');assert.equal(await run('document.querySelector(".proxy-catalog-panel").textContent.includes("batch-password")'),false)
   await click('.catalog-confirm button','查看节点');await click('.catalog-items .ant-pagination-item-3','3');await wait('document.querySelector(".catalog-items").textContent.includes("Node 60")')
   assert.equal(await run('document.querySelector(".catalog-items").textContent.includes("Invalid")'),true)
   await capture('proxy-catalog-import.png');await confirm();assert.equal(vault().proxyCatalogs.length,1)
   await click('.proxy-catalog-panel button','Fixture directory');await chooseRow('Manual')
   await wait('!!document.querySelector(".catalog-choices")');assert.equal(await run('Array.from(document.querySelectorAll(".catalog-choices tbody tr")).find(r=>r.textContent.includes("Invalid")).querySelector("button").disabled'),true)
   await click('.catalog-choices .ant-pagination-item-3','3');await chooseRow('Node 60','选用','.catalog-choices')
   await wait('!!document.querySelector(".catalog-binding")');await click('.catalog-binding button','保存为来源默认项');await confirm()
   await click('.catalog-current button','选用默认项');await wait('!!document.querySelector(".catalog-binding")')
   assert.equal(await run('document.querySelector(".catalog-selection").textContent.includes("Node 60")'),true)
   await fill('.catalog-binding input.ant-input','目录出口');await click('.catalog-binding button','预览保存资源');await confirm()
   assert.equal(vault().proxyResources.length,1);const resourceId=vault().proxyResources[0].id
   await close('.proxy-catalog-panel');await wait('document.querySelector(".proxy-resources-panel").textContent.includes("目录出口")')
   assert.equal(await run('document.querySelector(".proxy-resources-panel").textContent.includes("undefined")'),false)
   await click('.proxy-resources-panel button','设为统一');await click('.proxy-change-preview button','确认应用');await wait('!document.querySelector(".proxy-change-preview")')
   await close('.proxy-resources-panel');await click('.account-card footer button','统一代理');await click('.account-proxy-dialog button','检测出口')
   await wait('document.querySelector(".account-proxy-dialog").textContent.includes("203.0.113.20")');assert.ok(hits>0);assert.equal(directHits,0)
   await capture('proxy-catalog-egress.png');await close('.account-proxy-dialog')
   await click('.proxy-resources-trigger','代理资源与统一出口');await click('.proxy-resources-panel button','编辑')
   await wait('document.querySelector(".catalog-current")?.textContent.includes("Fixture directory")');await click('.proxy-catalog-panel button','替换内容')
   await fill('.catalog-editor textarea',JSON.stringify({proxies:[nodes[0]],'proxy-groups':[{name:'Manual',type:'select',proxies:['Node 00']}]}));await click('.catalog-editor button','预览目录')
   await wait('document.querySelector(".catalog-confirm").textContent.includes("1 个已保存资源将失效")');await confirm()
   assert.equal(vault().proxyResources[0].catalog.invalid,true);assert.equal(vault().proxyCatalogs[0].defaultInvalidated,true)
   const beforeHits=hits
   assert.equal(await run(`window.manager.probeAccountProxy({accountId:${JSON.stringify(accountId)},revision:0,requestId:${JSON.stringify(randomUUID())},mode:'saved'}).then(()=>false,()=>true)`),true);assert.equal(hits,beforeHits);assert.equal(directHits,0)
   await click('.catalog-current button','分组 1');await chooseRow('Manual');await chooseRow('Node 00','选用','.catalog-choices')
   await wait('!!document.querySelector(".catalog-binding")');await click('.catalog-binding button','预览保存资源');await confirm()
   assert.equal(vault().proxyResources.length,1);assert.equal(vault().proxyResources[0].id,resourceId);assert.equal(vault().proxyResources[0].catalog.invalid,undefined)
   await click('.catalog-current button','分组 1');await capture('proxy-catalog-ready.png')
   await click('.proxy-catalog-panel button','删除来源');await wait('document.querySelector(".catalog-confirm").textContent.includes("关闭统一代理")');await confirm()
   assert.equal(vault().proxyCatalogs.length,0);assert.equal(vault().proxyResources.length,0);assert.equal(vault().unifiedProxy.mode,'off')
   await click('.proxy-catalog-panel button','导入目录');await fill('.catalog-editor input','Cancelled');await fill('.catalog-editor textarea',data);await click('.catalog-editor button','预览目录');await click('.catalog-confirm button','取消预览')
   assert.equal(vault().proxyCatalogs.length,0)
   assert.equal(await run('window.manager.proxyCatalogPage({sourceId:"invalid",kind:"nodes",page:1}).then(()=>false,()=>true)'),true)
   console.log('Catalog UI passed: bounded/redacted import, 62-node pagination, disabled rejected candidate, explicit third-page selector, saved default, resource/unified binding, actual pinned Mihomo HTTP-group egress, replacement invalidates without direct fallback, exact-resource repair, dependency deletion and cancel. Ephemeral AES-GCM, synthetic account, no system keychain.')
   clearTimeout(timer);app.quit()
  }catch(error){console.error(error);await capture('proxy-catalog-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
 })
})
;(async()=>{
 targetURL=await listen((_req,res)=>{directHits++;res.end('{"ip":"203.0.113.10"}')})
 proxyURL=await listen((_req,res)=>{res.writeHead(502);res.end()})
 closeSockets=require('./test-node-server.cjs').connectFixture(servers[1],targetURL,()=>hits++)
 const accounts=[{id:accountId,revision:0,generation:randomUUID(),name:'Fixture account',kind:'oauth',baseUrl:'https://chatgpt.com',wireApi:'responses',tags:[],note:'',defaultTier:'inherit',models:['gpt-5.5'],createdAt:Date.now(),credentials:{accessToken:'at-catalog-ui-fixture'}}]
 fs.writeFileSync(join(directory,'state.vault'),safeStorage.encryptString(JSON.stringify({version:1,settings:{theme:'light',defaultTier:'follow',port:16321,refreshMinutes:0,launchAtLogin:false},accounts,groups:[]})),{mode:0o600})
 console.log('Catalog UI: temporary AES-GCM, pinned official engine, loopback proxy; no keychain or real user credentials')
 require('../out/main/index.js')
})().catch(error=>{console.error(error);app.exit(1)})
