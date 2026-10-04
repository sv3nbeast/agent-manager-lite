const {app,safeStorage}=require('electron')
const {createServer}=require('node:http')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
let failSave=false
const encrypt=safeStorage.encryptString
safeStorage.encryptString=value=>{if(failSave)throw new Error('fixture-settings-write-failed');return encrypt(value)}
let upstream
app.on('will-quit',()=>{upstream?.closeAllConnections();upstream?.close()})
const timer=setTimeout(()=>{console.error('Fast settings UI exceeded 75 seconds');app.exit(1)},75000)
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
app.on('browser-window-created',(_event,window)=>{
 window.webContents.setBackgroundThrottling(false)
 window.webContents.once('did-finish-load',async()=>{
  const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
  const wait=async expression=>{const end=Date.now()+10000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
  const click=async(selector,text)=>{const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
  const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
  const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
  const vault=()=>JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))


  const chooseTier=async(selector,label)=>{await click(selector+' .ant-segmented-item-label',label)}
  const savedTier=async()=>run('(await window.manager.load()).settings.defaultTier')
  const selectedTier=()=>run('document.querySelector(".tier-strip input:checked")?.closest("label")?.textContent')
  try{
   await wait('!!document.querySelector(".tier-strip .ant-segmented-item-selected")')
   await chooseTier('.tier-strip','Standard');await wait('(await window.manager.load()).settings.defaultTier==="standard"');assert.equal(await selectedTier(),'Standard')
   assert.equal(await run('!!document.querySelector(".account-filters .proxy-resources-trigger, .account-filters .proxy-assignment-trigger")'),false)
   await capture('accounts-core.png')
   failSave=true;await chooseTier('.tier-strip','Fast');await wait('document.querySelector(".error-banner")?.textContent.includes("fixture-settings-write-failed")')
   assert.equal(await savedTier(),'standard');assert.equal(await selectedTier(),'Standard','failed Fast save must restore the persisted selection')
   failSave=false
   const originalPort=(await run('window.manager.load()')).settings.port
   const settingsPage=async()=>{await click('.sidebar-bottom button','设置');await wait('!!document.querySelector(".settings-draft")')}
   const accountPage=async()=>{await click('.ant-menu-item','账号管理 0');await wait('!!document.querySelector(".tier-strip")')}
   await settingsPage();await chooseTier('.settings-draft .ant-form-item:nth-child(2)','Fast');await fill('.settings-draft .ant-input-number-input',String(originalPort+1))
   await wait('!!document.querySelector(".settings-unsaved")');await accountPage();assert.equal(await selectedTier(),'Standard','unsaved settings must not change the global shortcut')
   await chooseTier('.tier-strip','跟随请求');await wait('(await window.manager.load()).settings.defaultTier==="follow"');assert.equal((await run('window.manager.load()')).settings.port,originalPort,'quick Fast control must not save another settings draft field')
   await settingsPage();assert.equal(await run('document.querySelector(".settings-draft .ant-input-number-input").value'),String(originalPort+1),'unrelated draft survives saved snapshot update')
   assert.equal(await run('document.querySelector(".settings-draft .ant-form-item:nth-child(2) input:checked").closest("label").textContent'),'Fast')
   await click('.settings-actions button','放弃更改');await wait('!document.querySelector(".settings-unsaved")');assert.equal(await run('document.querySelector(".settings-draft .ant-input-number-input").value'),String(originalPort))
   await chooseTier('.settings-draft .ant-form-item:nth-child(2)','Fast');failSave=true;await click('.settings-actions button','保存设置')
   await wait('document.querySelector(".error-banner")?.textContent.includes("fixture-settings-write-failed")');assert.equal(await savedTier(),'follow');assert.equal(await run('!!document.querySelector(".settings-unsaved")'),true)
   failSave=false;await click('.settings-actions button','保存设置');await wait('(await window.manager.load()).settings.defaultTier==="fast"');await wait('!document.querySelector(".settings-unsaved")');assert.equal(vault().settings.defaultTier,'fast')
   assert.deepEqual(await run('Array.from(document.querySelectorAll(".stream-timeouts input")).map(el=>el.value)'),['60','120','60','180'])
   await fill('.stream-timeouts .ant-form-item:nth-child(1) input','0')
   await wait('document.querySelector(".settings-actions .ant-btn-primary").disabled')
   for(let i=0;i<4;i++)await fill(`.stream-timeouts .ant-form-item:nth-child(${i+1}) input`,String(i+1))
   await click('.settings-actions button','保存设置');await wait('!document.querySelector(".settings-unsaved")')
   assert.equal(vault().settings.streamOpenTimeoutSeconds,1);assert.equal(vault().settings.streamIdleTimeoutSeconds,2)
   assert.equal(vault().settings.imageStreamOpenTimeoutSeconds,3);assert.equal(vault().settings.imageStreamIdleTimeoutSeconds,4)
   await run('document.querySelector(".stream-timeouts").scrollIntoView({block:"center"})');await capture('stream-timeouts.png')
   await accountPage();await wait('document.querySelector(".tier-strip input:checked")?.closest("label")?.textContent==="Fast"')
   // Real local service and a synthetic HTTP upstream verify persisted vs running
   // defaults, restart application and explicit tier preservation.
   const seen=[]
   upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);seen.push(body.service_tier);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'resp-settings',object:'response',status:'completed',service_tier:'default',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}))})
   await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
   const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
   const initial=(await run('window.manager.load()')).settings
   await run(`window.manager.saveSettings(${JSON.stringify({...initial,port,defaultTier:'standard',refreshMinutes:0})})`)
   const added=await run(`window.manager.addAccount(${JSON.stringify({name:'Fast verification',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'fixture-upstream-key',models:['fixture-model'],wireApi:'responses',defaultTier:'inherit'})})`)
   const account=added.accounts[0],start=()=>run(`window.manager.startGateway(${JSON.stringify(account.id)})`)
   await start();await click('button[aria-label="重新加载账号"]','');await wait('document.querySelector(".tier-strip input:checked")?.closest("label")?.textContent==="Standard"')
   const projected=JSON.parse(fs.readFileSync(join(directory,'runtime',fs.readdirSync(join(directory,'runtime'))[0],'config.json'),'utf8'))
   assert.deepEqual(projected.streaming,{'stream-open-timeout-ms':1000,'stream-idle-timeout-ms':2000,'image-stream-open-timeout-ms':3000,'image-stream-idle-timeout-ms':4000,'stream-open-max-attempts':1})
   const request=async tier=>{const key=vault().accounts[0].credentials.localAPIKey,res=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'synthetic check',...tier?{service_tier:tier}:{}})});assert.equal(res.status,200);assert.equal((await res.json()).service_tier,'default')}
   await request();assert.equal(seen.at(-1),'default')
   await chooseTier('.tier-strip','Fast');await wait('(await window.manager.load()).settings.defaultTier==="fast"');await wait('!!document.querySelector(".tier-runtime-notice")');await request();assert.equal(seen.at(-1),'default','active process must match the restart notice')
   await wait('!document.querySelector(".ant-message-notice")');await capture('fast-settings-running.png')
   await run('window.manager.stopGateway()');await start();await request();assert.equal(seen.at(-1),'priority')
   for(const tier of ['default','flex','auto']){await request(tier);assert.equal(seen.at(-1),tier)}
   await run('window.manager.stopGateway()');assert.equal(vault().settings.defaultTier,'fast')
   console.log('Fast settings regression passed: failed quick-save rollback, settings draft isolation/discard/failure/retry, saved Fast, live restart notice, real HTTP priority after restart and explicit default/flex/auto preservation; temporary AES-GCM, no real keychain.')
   clearTimeout(timer);app.quit()
  }catch(error){console.error(error);await capture('fast-settings-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
 })
})
console.log('Fast settings UI: temporary AES-GCM and deliberate vault-write failure; no real keychain/accounts')
require('../out/main/index.js')
