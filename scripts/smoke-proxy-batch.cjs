const {app,safeStorage,dialog}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),{createServer}=require('node:http'),{randomUUID}=require('node:crypto')
const childProcess=require('node:child_process'),directory=process.env.CML_TEST_DATA_DIR
const nodeMode=process.env.CML_TEST_NODE_TUNNELS==='1',archive=process.env.CML_TEST_ENGINE_ARCHIVE,nodeFixture=nodeMode?require('./test-node-server.cjs'):undefined
if(nodeMode)assert.ok(archive&&fs.existsSync(archive),'Set CML_TEST_ENGINE_ARCHIVE to the pinned official package')
let closeNodeSockets
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
let targetURL,proxyURL,hits=0,directHits=0
const servers=[]
async function listen(handler){const server=createServer(handler);servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/'}
const originalSpawn=childProcess.spawn
childProcess.spawn=function(file,args,options){
  assert.notEqual(file,'/usr/bin/security','No keychain access in ordinary regression')
  const child=originalSpawn.call(this,file,args,options)
  if(args?.includes('-egress-http')){assert.equal(file,resolve('resources/bin/codex-proxy'));const end=child.stdin.end.bind(child.stdin);child.stdin.end=function(raw){const value=JSON.parse(raw);assert.equal(value.url,'https://api64.ipify.org?format=json');assert.equal(value.headers.authorization,undefined);value.url=targetURL;return end(JSON.stringify(value))}}
  return child
}
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Proxy batch UI timed out');app.exit(1)},75000)
app.on('will-quit',()=>{closeNodeSockets?.();for(const server of servers){server.closeAllConnections();server.close()}})
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait=async expression=>{const end=Date.now()+8000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
    const click=async(selector,text)=>{if(await require('./desktop-network-entry.cjs').clickEntry(run,wait,selector))return;const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
    const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
    const select=async(selector,label)=>{await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);await click('.ant-select-item-option',label)}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,nodeMode?name.replace('proxy-batch','proxy-nodes'):name),(await window.webContents.capturePage()).toPNG())}
    const close=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-modal-content').querySelector('.ant-modal-close').click()`);await wait(`!document.querySelector(${JSON.stringify(selector)})`)}
    const vault=()=>JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
    try{
      await wait('document.querySelectorAll(".account-card").length===24')
      const initial=vault().accounts
      await click('.proxy-resources-trigger','代理资源与统一出口')
      if(nodeMode){
        dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]})
        await click('.proxy-engine-trigger','代理引擎');await click('.engine-actions button','导入官方安装包')
        const end=Date.now()+35000;while((await run('window.manager.proxyEngineStatus()')).phase!=='completed'){assert.ok(Date.now()<end,'engine install timeout');await new Promise(resolve=>setTimeout(resolve,50))}
        await close('.proxy-engine-panel');proxyURL=await nodeFixture.start(directory,proxyURL)
      }
      await click('.proxy-resource-toolbar button','批量导入')
      const input=[proxyURL+'#Batch%20One',proxyURL+'#Duplicate','host:123@user:456','invalid:input',...Array.from({length:5},(_,i)=>`http://p${i}.invalid:8080#Batch%20${i+2}`)].join('\n')
      await fill('.proxy-import-dialog textarea',input);await click('.proxy-import-dialog button','预览导入')
      await wait('!!document.querySelector(".proxy-import-summary")');assert.equal(await run('document.querySelector(".proxy-import-summary").textContent.includes("重复 1 · 无效 2")'),true)
      assert.equal(await run('Array.from(document.querySelectorAll(".proxy-import-dialog button")).find(el=>el.textContent==="确认导入").disabled'),true)
      assert.equal(await run('document.querySelector(".proxy-import-dialog").textContent.includes("batch-password")'),false)
      await capture('proxy-batch-import-blocked.png');await click('.proxy-import-dialog button','返回修改')
      await click('.proxy-import-dialog .ant-checkbox-wrapper','跳过无效或歧义行');await click('.proxy-import-dialog button','预览导入')
      await wait('!!document.querySelector(".proxy-import-summary")');await run('document.querySelector(".proxy-import-dialog .ant-pagination-item-2").click()')
      await capture('proxy-batch-import-preview.png');await click('.proxy-import-dialog button','确认导入');await wait('!document.querySelector(".proxy-import-dialog")')
      assert.equal(vault().proxyResources.length,6);assert.deepEqual(vault().accounts,initial)
      assert.equal(await run('document.querySelectorAll(".proxy-resources-panel .ant-table-row").length'),5)
      await close('.proxy-resources-panel')
      await run('document.querySelector(".account-card .ant-checkbox-input").click()')
      await run('document.querySelector(".pagination .ant-pagination-item-2").click()');await wait('document.querySelectorAll(".account-card").length===4');await click('.account-filters button','选择本页')
      await click('.proxy-assignment-trigger','批量代理');await select('.proxy-assignment-resource .ant-select-selector','Batch One');await click('.proxy-assignment-dialog button','预览分配')
      await wait('!!document.querySelector(".proxy-assignment-summary")');assert.equal(await run('document.querySelector(".proxy-assignment-summary").textContent.includes("将修改 4 · 覆盖独立设置 1 · 相同 0 · 不适用 1")'),true)
      // A metadata refresh must not dismiss a selection whose ids have not changed.
      await run(`document.querySelector('button[aria-label="重新加载账号"]').click()`)
      await run('new Promise(resolve=>setTimeout(resolve,150))');await wait('!document.querySelector(".ant-spin-spinning")')
      assert.equal(await run('!!document.querySelector(".proxy-assignment-summary")'),true)
      await capture('proxy-batch-assignment.png');await click('.proxy-assignment-dialog button','取消');await wait('!document.querySelector(".proxy-assignment-dialog")')
      assert.deepEqual(vault().accounts,initial)
      await click('.proxy-assignment-trigger','批量代理');await select('.proxy-assignment-resource .ant-select-selector','Batch One');await click('.proxy-assignment-dialog button','预览分配');await click('.proxy-assignment-dialog button','确认分配');await wait('!document.querySelector(".proxy-assignment-dialog")')
      const saved=vault(),selected=[0,24,25,26],resource=saved.proxyResources.find(r=>r.name==='Batch One')
      for(let i=0;i<28;i++)if(selected.includes(i))assert.equal(saved.accounts[i].proxy.resourceId,resource.id);else assert.deepEqual(saved.accounts[i],initial[i])
      const snapshot=await run('window.manager.load()');assert.equal(JSON.stringify(snapshot).includes('batch-password'),false)
      await run(`window.manager.probeAccountProxy(${JSON.stringify({accountId:saved.accounts[24].id,revision:saved.accounts[24].revision,requestId:randomUUID(),mode:'saved'})})`);assert.equal(hits,1);assert.equal(directHits,0)
      if(nodeMode){
        const running=await run(`window.manager.startGateway(${JSON.stringify(saved.accounts[24].id)})`);assert.equal(running.gateway.running,true)
        await run(`document.querySelector('button[aria-label="重新加载账号"]').click()`);await wait('!document.querySelector(".ant-spin-spinning")');await capture('proxy-nodes-running.png')
        const stopped=await run('window.manager.stopGateway()');assert.equal(stopped.gateway.running,false)
      }
      await click('.proxy-assignment-trigger','批量代理');await select('.proxy-assignment-resource .ant-select-selector','Batch One');await click('.proxy-assignment-dialog button','预览分配')
      await wait('document.querySelector(".proxy-assignment-summary")?.textContent.includes("相同 4")');assert.equal(await run('Array.from(document.querySelectorAll(".proxy-assignment-dialog button")).find(el=>el.textContent==="确认分配").disabled'),true)
      await click('.proxy-assignment-dialog button','返回修改');await select('.proxy-assignment-mode .ant-select-selector','直连（不使用代理）');await click('.proxy-assignment-dialog button','预览分配');await click('.proxy-assignment-dialog button','确认分配');await wait('!document.querySelector(".proxy-assignment-dialog")')
      for(const index of selected)assert.equal(vault().accounts[index].proxy.mode,'direct')
      console.log('Proxy batch UI passed: masked invalid/duplicate preview, explicit skip-invalid, resource pagination, cross-page explicit account selection, overwrite/API exclusion/same skips, cancellation preserves accounts, atomic assignment and direct reset, actual authenticated helper egress. Temporary AES-GCM; no real keychain or upstream.')
      if(nodeMode)console.log('Node UI additionally passed: official engine install, VLESS URI preview/save/batch assignment, actual Mihomo egress, local API launch/stop; only the IP probe destination is replaced with a loopback fixture.')
      await nodeFixture?.stop();clearTimeout(timer);app.quit()
    }catch(error){console.error(error);await capture('proxy-batch-failure.png').catch(()=>{});await nodeFixture?.stop();clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
  })
})
;(async()=>{
  targetURL=await listen((_req,res)=>{directHits++;res.end('{"ip":"203.0.113.10"}')})
  proxyURL=(await listen((req,res)=>{assert.equal(req.url,targetURL);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:batch-password').toString('base64'));hits++;res.end('{"ip":"203.0.113.20"}')})).replace('://','://fixture:batch-password@')
  if(nodeMode)closeNodeSockets=nodeFixture.connectFixture(servers.at(-1),targetURL,()=>hits++)
  const accounts=Array.from({length:28},(_,i)=>({id:randomUUID(),revision:0,generation:randomUUID(),name:'批量账号 '+String(i+1).padStart(2,'0'),kind:i===27?'api_key':'oauth',baseUrl:i===27?'https://fixture.invalid':'https://chatgpt.com',wireApi:'responses',models:[],tags:[],note:'',defaultTier:'inherit',createdAt:Date.now(),credentials:i===27?{apiKey:'fixture-api'}:{accessToken:'fixture-at-'+i},...(i===0?{proxy:{mode:'direct'}}:{})}))
  fs.writeFileSync(join(directory,'state.vault'),safeStorage.encryptString(JSON.stringify({version:1,settings:{theme:'light',defaultTier:'follow',port:16321,refreshMinutes:0,launchAtLogin:false},accounts,groups:[]})),{mode:0o600})
  console.log('Proxy batch UI: temporary AES-GCM, source-built helper, loopback proxy, synthetic accounts')
  require('../out/main/index.js')
})().catch(error=>{console.error(error);app.exit(1)})
