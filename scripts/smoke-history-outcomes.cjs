// Isolated call-history UI acceptance. Synthetic metadata only; never opens a
// real vault, provider credential, instance or conversation.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os')
if(!process.versions.electron){
 const {spawn}=require('node:child_process')
 const root=fs.mkdtempSync(join(tmpdir(),'codex-manager-ui-'))
 const env={...process.env,CML_TEST_DATA_DIR:root,CML_TEST_SYSTEM_KEYCHAIN:'0'}
 delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(require('electron'),[__filename],{env,stdio:'inherit',detached:true,cwd:resolve(__dirname,'..')})
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}}
 const timer=setTimeout(()=>{console.error('History UI smoke timed out');kill()},90000)
 const cleanup=()=>{clearTimeout(timer);fs.rmSync(root,{recursive:true,force:true})}
 child.once('exit',code=>{cleanup();process.exitCode=code??1})
 child.once('error',error=>{console.error(error);cleanup();process.exitCode=1})
 process.once('SIGTERM',()=>{kill();cleanup();process.exit(1)})
 process.once('SIGINT',()=>{kill();cleanup();process.exit(1)})
}else{
 const {app,safeStorage}=require('electron'),{DatabaseSync}=require('node:sqlite')
 const root=process.env.CML_TEST_DATA_DIR
 assert.ok(root&&fs.realpathSync(root).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(root).startsWith('codex-manager-ui-'))
 assert.equal(fs.existsSync(join(root,'state.vault')),false)
 require('./test-vault.cjs').installTestVault(safeStorage)
 const db=new DatabaseSync(join(root,'history.sqlite'))
 db.exec("CREATE TABLE requests (seq INTEGER PRIMARY KEY,identity TEXT UNIQUE NOT NULL,requestId TEXT NOT NULL,requestedAt INTEGER NOT NULL,model TEXT NOT NULL,upstreamModel TEXT NOT NULL,accountId TEXT NOT NULL,success INTEGER NOT NULL,status INTEGER NOT NULL,latencyMs INTEGER NOT NULL,inputTokens INTEGER NOT NULL,outputTokens INTEGER NOT NULL,cachedTokens INTEGER NOT NULL,inboundTier TEXT,outboundTier TEXT,responseTier TEXT,tierSource TEXT NOT NULL,errorCategory TEXT NOT NULL DEFAULT '')")
 const fixtures=[
  ['completed',1,200,'','成功'],
  ['cancelled',0,200,'client_canceled','客户端取消'],
  ['interrupted',0,200,'stream_interrupted','流中断'],
  ['upstream',0,200,'upstream_response_failed','上游错误'],
  ['legacy',0,200,'','结果未确认'],
  ['http-error',0,502,'','失败']
 ]
 for(const [id,success,status,category] of fixtures)db.prepare('INSERT INTO requests (identity,requestId,requestedAt,model,upstreamModel,accountId,success,status,latencyMs,inputTokens,outputTokens,cachedTokens,inboundTier,outboundTier,responseTier,tierSource,errorCategory) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture:'+id,id,Date.now(),'fixture-model','fixture-model','',success,status,100,10,3,5,'','default','default','instance',category)
 db.close()
 const evidence=resolve(process.env.CML_HISTORY_EVIDENCE_DIR||'.local/history-outcome-evidence');fs.mkdirSync(evidence,{recursive:true})
 let handled=false
 const timer=setTimeout(()=>{console.error('History renderer timeout');app.exit(1)},75000)
 app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
   if(handled)return;handled=true
   const evaluate=code=>window.webContents.executeJavaScript(code)
   const wait=async code=>{const end=Date.now()+12000;while(!await evaluate(code)){if(Date.now()>end)throw Error('DOM condition timeout: '+code);await new Promise(resolve=>setTimeout(resolve,60))}}
   try{
    window.setSize(1440,1000)
    await wait('!!window.manager&&Array.from(document.querySelectorAll(".ant-menu-item")).some(el=>el.textContent.includes("调用记录"))')
    await evaluate('Array.from(document.querySelectorAll(".ant-menu-item")).find(el=>el.textContent.includes("调用记录")).click()')
    await wait('document.querySelectorAll(".history-table tbody tr[data-row-key]").length===6')
    const rows=await evaluate('Array.from(document.querySelectorAll(".history-table tbody tr[data-row-key]")).map(el=>({id:el.querySelector(".history-id").textContent.trim(),label:el.querySelector(".ant-tag").textContent.trim(),text:el.innerText}))')
    for(const [id,,status,,label] of fixtures){const row=rows.find(row=>row.id===id);assert.equal(row?.label,label);assert.ok(row.text.includes('HTTP '+status))}
    assert.equal(await evaluate('document.body.innerText.includes("失败 200")'),false)
    for(const [label,count] of [['客户端取消',1],['流中断 / 未完成',1],['上游错误',1],['全部结果',6]]){
     await evaluate('document.querySelector(".history-filters .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
     await wait('Array.from(document.querySelectorAll(".ant-select-item-option")).some(el=>el.getClientRects().length&&el.textContent.trim()==='+JSON.stringify(label)+')')
     await evaluate('Array.from(document.querySelectorAll(".ant-select-item-option")).find(el=>el.getClientRects().length&&el.textContent.trim()==='+JSON.stringify(label)+').click()')
     await wait('document.querySelectorAll(".history-table tbody tr[data-row-key]").length==='+count)
    }
    const legacy=await evaluate('window.manager.queryHistory({filter:{search:"legacy",outcome:"all"},page:1,pageSize:25})')
    assert.equal(legacy.entries[0].success,false);assert.equal(legacy.entries[0].errorCategory,'')
    await evaluate('document.querySelector("h1").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));document.querySelector("h1").click();document.querySelector(".history-filters").scrollIntoView({block:"start"})')
    await evaluate('document.fonts.ready')
    await new Promise(resolve=>setTimeout(resolve,400))
    fs.writeFileSync(join(evidence,'history-outcomes.png'),(await window.webContents.capturePage()).toPNG())
    console.log('History UI smoke passed: distinct outcome labels, HTTP status, filters and unchanged legacy failed-200 record.')
    clearTimeout(timer);app.exit(0)
   }catch(error){console.error(error);try{fs.writeFileSync(join(evidence,'history-failure.png'),(await window.webContents.capturePage()).toPNG())}catch{};clearTimeout(timer);app.exit(1)}
  })
 })
 require('../out/main/index.js')
}
