const {app,safeStorage}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),https=require('node:https'),cp=require('node:child_process')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
const key=join(directory,'key.pem'),cert=join(directory,'cert.pem'),config=join(directory,'openssl.cnf')
fs.writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
cp.execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-config',config],{stdio:'ignore'})
// Trust only this temporary fixture CA inside this process; production HTTPS
// validation, request building, redirects and stream handling remain real.
const undici=require('undici'),OriginalAgent=undici.Agent
undici.Agent=class extends OriginalAgent{constructor(options){super({...options,connect:{...options?.connect,ca:fs.readFileSync(cert)}})}}
let url,variant='initial',closed=0,requests=0
const timers=new Set(),sockets=new Set()
const catalog=(name='Node',server='old.invalid')=>JSON.stringify({proxies:[{name,type:'http',server,port:8080,password:'fixture-proxy-secret'}],'proxy-groups':[{name:'Manual',type:'select',proxies:[name]}]})
const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
 requests++;assert.equal(req.headers['user-agent'],'clash.meta/CodexManagerLite');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined)
 if(variant==='error'){res.writeHead(403);res.end('fixture-url-secret');return}
 if(variant==='slow'){res.write('proxies:');const timer=setInterval(()=>res.write(' '),20);timers.add(timer);res.on('close',()=>{clearInterval(timer);timers.delete(timer);closed++});return}
 res.setHeader('profile-title','Fixture subscription')
 if(variant==='initial')res.setHeader('subscription-userinfo','upload=1024; download=2048; total=0; expire=2000000000')
 res.end(catalog(variant==='missing'?'Other':'Node',variant==='initial'?'old.invalid':'new.invalid'))
})
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))})
const timer=setTimeout(()=>{console.error('Subscription UI exceeded 75 seconds');app.exit(1)},75000)
app.on('will-quit',()=>{for(const t of timers)clearInterval(t);for(const s of sockets)s.destroy();server.closeAllConnections();server.close()})
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
app.on('browser-window-created',(_event,window)=>{
 window.webContents.setBackgroundThrottling(false)
 window.webContents.once('did-finish-load',async()=>{
  const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
  const wait=async expression=>{const end=Date.now()+10000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
  const click=async(selector,text)=>{if(await require('./desktop-network-entry.cjs').clickEntry(run,wait,selector))return;const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
  const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
  const close=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-modal-content').querySelector('.ant-modal-close').click()`);await wait(`!document.querySelector(${JSON.stringify(selector)})`)}
  const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
  const vault=()=>JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
  const confirm=async()=>{await click('.catalog-confirm button','确认应用');await wait('!document.querySelector(".catalog-confirm")')}
  const refreshed=async()=>{await click('.subscription-details button','刷新订阅');await wait('!document.querySelector(".subscription-progress")');await wait('!document.querySelector(".catalog-current button[disabled]")')}
  try{
   await wait('!!document.querySelector(".account-filters")');await click('.proxy-resources-trigger','代理资源与统一出口');await click('.proxy-catalog-trigger','来源目录')
   await click('.proxy-catalog-panel button','添加订阅');await fill('.subscription-url input',url);await click('.catalog-editor button','获取并预览')
   await wait('!!document.querySelector(".catalog-confirm")');assert.equal(fs.existsSync(join(directory,'state.vault')),false)
   assert.equal(await run('document.querySelector(".proxy-catalog-panel").textContent.includes("fixture-url-secret")'),false)
   await capture('proxy-subscription-preview.png');await confirm();assert.equal(vault().proxyCatalogs[0].kind,'subscription');assert.equal(vault().proxyCatalogs[0].url,url)
   await click('.proxy-catalog-panel button','Fixture subscription');await wait('document.querySelector(".subscription-details").textContent.includes("总量未知")')
   await click('.subscription-details button','开启自动更新');await wait('document.querySelector(".catalog-confirm").textContent.includes("每 6 小时")');await confirm();assert.equal(vault().proxyCatalogs[0].autoUpdate,true)
   await click('.subscription-details button','关闭自动更新');await confirm();assert.equal(vault().proxyCatalogs[0].autoUpdate,false)
   await click('.catalog-current button','分组 1');await click('.catalog-items button','选择');await click('.catalog-choices button','选用');await click('.catalog-binding button','保存为来源默认项');await confirm()
   await click('.catalog-current button','选用默认项');await fill('.catalog-binding input.ant-input','Subscription resource');await click('.catalog-binding button','预览保存资源');await confirm()
   const resource=vault().proxyResources[0],original=resource.url
   await close('.proxy-catalog-panel');await click('.proxy-resources-panel button','设为统一');await click('.proxy-change-preview button','确认应用');await wait('!document.querySelector(".proxy-change-preview")')
   await click('.proxy-resources-panel button','编辑');await wait('!!document.querySelector(".subscription-details")');variant='updated';await refreshed()
   assert.equal(vault().proxyCatalogs[0].catalog.nodes[0].native.server,'new.invalid');assert.equal(vault().proxyCatalogs[0].usage.download,2048);assert.equal(vault().proxyResources[0].url,original)
   const graph=JSON.parse(Buffer.from(vault().unifiedProxy.snapshot.url.slice('cml-proxy://'.length),'base64url'));assert.equal(graph.proxies[0].server,'new.invalid')
   variant='missing';await refreshed();assert.equal(vault().proxyCatalogs[0].defaultInvalidated,true);assert.match(vault().unifiedProxy.staleError,/保留/)
   await capture('proxy-subscription-refreshed.png')
   const prior=vault().proxyCatalogs[0].catalog;variant='error';await refreshed();assert.match(vault().proxyCatalogs[0].error,/HTTP 403/);assert.deepEqual(vault().proxyCatalogs[0].catalog,prior)
   assert.equal(JSON.stringify(await run('window.manager.proxySubscriptionJobs()')).includes('fixture-url-secret'),false)
   variant='slow';await click('.subscription-details button','刷新订阅');await wait('!!document.querySelector(".subscription-progress")');await click('.subscription-progress button','取消下载');await wait('!document.querySelector(".subscription-progress")')
   const end=Date.now()+3000;while(closed<1){assert.ok(Date.now()<end,'cancel did not close network');await new Promise(resolve=>setTimeout(resolve,10))}
   assert.deepEqual(vault().proxyCatalogs[0].catalog,prior)
   await click('.subscription-details button','刷新订阅');await wait('!!document.querySelector(".subscription-progress")');await close('.proxy-catalog-panel')
   await click('.proxy-catalog-trigger','来源目录');await click('.proxy-catalog-panel button','Fixture subscription');await wait('!!document.querySelector(".subscription-details")')
   assert.equal(await run('!!document.querySelector(".subscription-progress")'),false)
   await click('.proxy-catalog-panel button','导入目录');await fill('.catalog-editor input','Second source');await fill('.catalog-editor textarea',catalog());await click('.catalog-editor button','预览目录');await confirm()
   await click('.catalog-current button','返回来源列表');await click('.proxy-catalog-panel button','下移');assert.equal(vault().proxyCatalogs[0].name,'Second source')
   const ids=vault().proxyCatalogs.map(s=>s.id);assert.equal(await run(`window.manager.reorderProxyCatalogs(${JSON.stringify([ids[0],ids[0]])}).then(()=>false,()=>true)`),true)
   await click('.proxy-catalog-panel button','Fixture subscription');await click('.proxy-catalog-panel button','删除来源');await confirm();assert.equal(vault().proxyCatalogs.length,1);assert.equal(vault().proxyResources.length,0);assert.equal(vault().unifiedProxy.mode,'off')
   assert.ok(requests>=5)
   console.log('Subscription UI passed: real HTTPS fetch/preview/usage, encrypted URL, opt-in/off, explicit binding/default, refresh preserves independent resource and updates unified snapshot, missing choice retains last exit, failed response retains data, cancellation/close ends download, source reorder/delete and secret-free IPC. Temporary CA/AES-GCM only; no real keychain/accounts.')
   clearTimeout(timer);app.quit()
  }catch(error){console.error(error);await capture('proxy-subscription-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
 })
})
server.listen(0,'127.0.0.1',()=>{url=`https://127.0.0.1:${server.address().port}/feed?token=fixture-url-secret`;require('../out/main/index.js')})
