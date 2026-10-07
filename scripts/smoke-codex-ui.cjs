// Run the installed client with synthetic identities, a loopback provider and
// disposable history. Never attach to a user's existing renderer or vault.
const assert=require('node:assert/strict')
const {createServer}=require('node:http')
const {execFileSync}=require('node:child_process')
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,readdirSync,statSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join}=require('node:path')
const {randomUUID}=require('node:crypto')
const {setTimeout:delay}=require('node:timers/promises')
require('tsx/cjs')
const {inspectCodexDesktopUi,prepareCodexSpeedMenu,readCodexSpeedMenuStatus}=require('../src/main/codexSpeedMenu.ts')
const {MacDesktopRuntime}=require('../src/main/instanceRuntime.ts')
const {reserveCodexCdpPort}=require('../src/main/codexInstanceAdapter.ts')
const {builtInCatalog,buildModelCatalog}=require('../src/main/modelCatalog.ts')

async function main(){
  assert.equal(process.platform,'darwin','native desktop smoke requires macOS')
  const application=process.env.CML_CODEX_APP_PATH??'/Applications/ChatGPT.app',executable=join(application,'Contents/MacOS/ChatGPT')
  const inspection=inspectCodexDesktopUi({application,executable})
  assert.deepEqual(inspection.features,['locale','speed','ultra'],inspection.reason)
  const root=mkdtempSync(join(realpathSync(tmpdir()),'cml-native-ui-')),directory=join(root,'home'),desktopDirectory=join(root,'desktop')
  mkdirSync(directory,{mode:0o700});mkdirSync(desktopDirectory,{mode:0o700})
  const runtime=new MacDesktopRuntime(),nonce=randomUUID(),cdpPort=await reserveCodexCdpPort()
  let socket,plan;const requests=[]
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify({object:'list',data:[{id:'gpt-6.1-sol',object:'model',owned_by:'fixture'}]}));return}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const input=JSON.parse(body||'{}');requests.push({model:input.model,serviceTier:input.service_tier,reasoningEffort:input.reasoning?.effort})
      const id='resp_'+randomUUID(),item={id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Compatibility check complete.',annotations:[]}]}
      const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:input.model,output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}
      if(!input.stream){res.end(JSON.stringify(response));return}
      res.setHeader('content-type','text/event-stream')
      const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'Compatibility check complete.'},{type:'response.output_text.done',output_index:0,content_index:0,item_id:item.id,text:'Compatibility check complete.'},{type:'response.content_part.done',output_index:0,content_index:0,item_id:item.id,part:item.content[0]},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}]
      for(const [sequence_number,event] of events.entries())res.write(`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`)
      res.end()
    })
  })
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const catalog=buildModelCatalog([{modelId:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',reasoningEfforts:null,contextWindow:null,autoCompactTokenLimit:null,supportsVision:null}],builtInCatalog,null,'gpt-6.1-sol')
    writeFileSync(join(directory,'catalog.json'),JSON.stringify(catalog))
    writeFileSync(join(directory,'.codex-global-state.json'),JSON.stringify({'electron-saved-workspace-roots':[root],'electron-active-workspace-roots':[root],'electron-persisted-atom-state':{'electron:onboarding-override':'app','electron:onboarding-projectless-completed':true}}))
    writeFileSync(join(directory,'config.toml'),`model="gpt-6.1-sol"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(join(directory,'catalog.json'))}\nservice_tier="default"\n[model_providers.fixture]\nname="Compatibility Fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nexperimental_bearer_token="fixture-only-key"\n`)
    const hook=prepareCodexSpeedMenu({inspection,directory,desktopDirectory,executable,nonce});assert.ok(hook)
    plan={application,executable,directory,desktopDirectory,workingDirectory:root,args:['--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-background-timer-throttling'],nonce,mode:'desktop',speedMenuHook:hook,cdpPort}
    const child=await runtime.launch(plan,new AbortController().signal)
    let target
    for(let i=0;i<150&&!target;i++){
      const targets=await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      target=targets.find(t=>t.type==='page'&&(t.url.startsWith('app://-/')||t.url==='about:blank'||t.url===''))
      if(!target)await delay(100)
    }
    assert.ok(target,'isolated client page target was not created');socket=new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
    let id=0;const pending=new Map(),diagnostics=[]
    socket.addEventListener('message',e=>{const v=JSON.parse(String(e.data));if(v.id&&pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id)}else if(['Runtime.exceptionThrown','Log.entryAdded'].includes(v.method))diagnostics.push(v)})
    const call=async(method,params={})=>{const messageId=++id;const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(messageId);reject(new Error('native CDP command timeout'))},10000);pending.set(messageId,v=>{clearTimeout(timer);resolve(v)});socket.send(JSON.stringify({id:messageId,method,params}))});if(result.error)throw new Error(result.error.message);return result.result}
    const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value
    const wait=async expression=>{const deadline=Date.now()+60000;let value;while(!(value=await evaluate(expression))){assert.ok(Date.now()<deadline,'native UI timeout: '+expression);await delay(100)}return value}
    const capture=async name=>{
      const evidence=process.env.CML_CODEX_UI_EVIDENCE
      if(evidence){mkdirSync(evidence,{recursive:true});const result=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,name),Buffer.from(result.data,'base64'))}
    }
    await call('Runtime.enable');await call('Log.enable')
    await delay(5000)
    console.log(JSON.stringify({stage:'ready',url:await evaluate('location.href'),language:await evaluate('document.documentElement.lang'),text:await evaluate('document.body.innerText.slice(0,1800)'),targets:(await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).map(t=>({id:t.id,type:t.type,url:t.url,title:t.title})),diagnostics}))
    await capture('codex-ready.png')
    await wait('document.body.innerText.length>20')
    await delay(1000)
    await capture('codex-home.png')
    console.log(JSON.stringify({stage:'initial',version:inspection.version,pid:child.pid,language:await evaluate('document.documentElement.lang'),text:await evaluate('document.body.innerText.slice(0,1800)'),buttons:await evaluate('Array.from(document.querySelectorAll("button")).map(b=>({text:b.innerText,label:b.getAttribute("aria-label")})).slice(-22)')}))
    const state=readCodexSpeedMenuStatus({statusLog:hook.statusLog,nonce,executable,directory,pid:child.pid});assert.equal(state.state,'active',state.reason)
    assert.equal(await wait('document.documentElement.lang.startsWith("zh")&&document.documentElement.lang'),'zh-CN')
    const modelButton=await evaluate('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"));const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...modelButton});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...modelButton})
    await delay(1000)
    console.log(JSON.stringify({stage:'model-menu',text:await evaluate('document.body.innerText.slice(-2600)'),controls:await evaluate('Array.from(document.querySelectorAll("select,input,[role=menuitem],[role=menuitemradio]")).map(el=>({tag:el.tagName,role:el.getAttribute("role"),text:el.innerText,value:el.value})).slice(-25)')}))
    await capture('codex-model-menu.png')
    const click=async expression=>{
      const point=await evaluate(`(()=>{const el=${expression};if(!el)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
      assert.ok(point,'native control missing: '+expression)
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
    }
    const key=async key=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key})}
    const chooseSpeed=async fast=>{
      await wait('!!document.querySelector("[data-fast-mode-enabled]")')
      const direct=await evaluate('!!document.querySelector("[data-fast-mode-enabled][role=menuitemcheckbox]")')
      if(direct){
        const enabled=await evaluate('document.querySelector("[data-fast-mode-enabled][role=menuitemcheckbox]").getAttribute("aria-checked")==="true"')
        if(enabled!==fast)await click('document.querySelector("[data-fast-mode-enabled][role=menuitemcheckbox]")')
        await wait(`document.querySelector("[data-fast-mode-enabled][role=menuitemcheckbox]")?.getAttribute("aria-checked")===${JSON.stringify(String(fast))}`)
        console.log(JSON.stringify({stage:'speed-toggle',fast,label:await evaluate('document.querySelector("[data-fast-mode-enabled][role=menuitemcheckbox]").getAttribute("aria-label")')}))
      }else{
        await click('document.querySelector("[data-fast-mode-enabled]").closest("[role=menuitem]")')
        await wait('Array.from(document.querySelectorAll("[role=menuitemradio],[role=menuitem]")).some(el=>el.innerText.startsWith("Fast"))')
        const option=fast?'el.innerText.startsWith("Fast")':'/^(标准|普通|Standard)(\\s|$)/.test(el.innerText)'
        await click(`Array.from(document.querySelectorAll("[role=menuitemradio],[role=menuitem]")).find(el=>${option})`)
      }
      await capture(fast?'codex-fast-menu.png':'codex-standard-menu.png')
    }
    await chooseSpeed(false)
    await key('Escape');await key('Escape')
    const send=async(text)=>{
      const before=requests.length
      await click('document.querySelector("[contenteditable=true]")')
      await call('Input.insertText',{text})
      await click('document.querySelector("button[aria-label=发送]")')
      const deadline=Date.now()+60000
      while(requests.length===before){assert.ok(Date.now()<deadline,'native request was not sent');await delay(100)}
      await wait('document.body.innerText.includes("Compatibility check complete.")')
      await delay(1500)
      return requests[before]
    }
    const standard=await send('Reply with one sentence for the standard compatibility test.')
    assert.ok(standard.serviceTier==null||standard.serviceTier==='default',JSON.stringify(requests))
    await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
    await chooseSpeed(true)
    await key('Escape');await key('Escape')
    await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
    await evaluate('document.querySelector("[data-reasoning-slider]").focus()')
    for(let step=0;step<6;step++){await key('ArrowRight');await delay(150)}
    await wait('document.querySelector("[data-model-picker-view-toggle]")?.innerText.includes("Ultra")')
    await key('Enter');await delay(500)
    await capture('codex-ultra-menu.png')
    await key('Escape')
    const fast=await send('Reply with one sentence for the Fast and Ultra compatibility test.')
    assert.equal(fast.serviceTier,'priority',JSON.stringify(requests))
    // Verify the native selection independently from the client's wire effort.
    // The installed CLI maps Ultra to its own execution behavior; this UI
    // adapter does not rewrite that request or promise upstream Ultra support.
    const saved=JSON.parse(readFileSync(join(directory,'.codex-global-state.json'),'utf8'))
    const recent=saved['electron-persisted-atom-state']['composer-recent-model-configurations-v1']
    assert.equal(recent[0].model,'gpt-6.1-sol')
    assert.equal(recent[0].reasoningEffort,'ultra')
    await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
    await wait('document.querySelector("[data-model-picker-view-toggle]")?.innerText.includes("Ultra")')
    await key('Escape')
    await capture('codex-verified.png')
    console.log(JSON.stringify({stage:'verified',version:inspection.version,language:await evaluate('document.documentElement.lang'),savedReasoning:recent[0].reasoningEffort,requests}))
    console.log('Native Codex language, Standard/Fast requests and Ultra persistence passed')
  }catch(error){
    const evidence=process.env.CML_CODEX_UI_EVIDENCE
    if(evidence){
      mkdirSync(evidence,{recursive:true});const logs=[]
      const visit=folder=>{for(const entry of readdirSync(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isDirectory()&&!['Cache','Code Cache','GPUCache','blob_storage'].includes(entry.name))visit(file);else if(entry.isFile()&&/\.(log|jsonl)$|^stderr\.txt$/i.test(entry.name)&&statSync(file).size<2*1024*1024)logs.push({file:file.slice(root.length+1),body:readFileSync(file,'utf8').slice(-18000)})}}
      visit(root);writeFileSync(join(evidence,'native-failure-logs.json'),JSON.stringify(logs,null,2))
    }
    throw error
  }finally{
    socket?.close();if(plan)await runtime.stop(plan).catch(()=>{})
    // LaunchServices helpers do not share the test runner's process group.
    // Match the exact disposable CODEX_HOME before stopping orphaned helpers.
    try{
      const owned=execFileSync('/bin/ps',['eww','-axo','pid=,command='],{encoding:'utf8',maxBuffer:8*1024*1024})
      for(const row of owned.split('\n')){
        if(!row.split(/\s+/).includes('CODEX_HOME='+directory))continue
        const pid=Number(row.trim().split(/\s+/)[0])
        if(Number.isInteger(pid)&&pid>1&&pid!==process.pid)try{process.kill(pid,'SIGTERM')}catch{}
      }
    }catch{/* Helpers may already have exited. */}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await delay(200)
    rmSync(root,{recursive:true,force:true})
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
