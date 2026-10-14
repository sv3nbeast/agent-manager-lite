// Run the installed client with synthetic identities, a loopback provider and
// disposable history. Never attach to a user's existing renderer or vault.
const assert=require('node:assert/strict')
const {createServer}=require('node:http')
const {execFileSync,spawn}=require('node:child_process')
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
const {codexBundledCli}=require('../src/main/codexPrograms.ts')

async function main(){
  assert.equal(process.platform,'darwin','native desktop smoke requires macOS')
  const application=process.env.CML_CODEX_APP_PATH??'/Applications/ChatGPT.app',executable=join(application,'Contents/MacOS/ChatGPT')
  const inspection=inspectCodexDesktopUi({application,executable})
  // Capabilities are intentionally discovered from the installed bundle. A
  // newer Codex may expose only a subset (or none) while still being a valid
  // client; the smoke should exercise exactly what was detected instead of
  // turning a missing optional feature into a version-specific failure.
  const features=inspection.features??[]
  const supports=feature=>features.includes(feature)&&inspection.featureSupport?.[feature]?.supported===true
  console.log(JSON.stringify({stage:'capabilities',version:inspection.version,features,featureSupport:inspection.featureSupport,reason:inspection.reason}))
  for(const feature of (process.env.CML_CODEX_UI_REQUIRE??'').split(',').filter(Boolean))assert.ok(supports(feature),`required capability was not detected: ${feature}`)
  const root=mkdtempSync(join(realpathSync(tmpdir()),'cml-native-ui-')),directory=join(root,'home'),desktopDirectory=join(root,'desktop')
  mkdirSync(directory,{mode:0o700});mkdirSync(desktopDirectory,{mode:0o700})
  const runtime=new MacDesktopRuntime(),nonce=randomUUID(),cdpPort=await reserveCodexCdpPort()
  let socket,plan,capture=async()=>{};const requests=[]
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify({object:'list',data:[{id:'gpt-6.1-sol',object:'model',owned_by:'fixture'}]}));return}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const input=JSON.parse(body||'{}')
      // A continued thread carries earlier mode messages in its history. The
      // latest developer mode message determines the active delegation policy.
      const multiAgentMode=(JSON.stringify(input.input)??'').match(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g)?.at(-1)??null
      const lastUserText=(input.input??[]).filter(item=>item.role==='user').at(-1)?.content
      const prompt=typeof lastUserText==='string'?lastUserText:(lastUserText??[]).map(part=>part.text??'').join('\n')
      requests.push({model:input.model,serviceTier:input.service_tier,reasoningEffort:input.reasoning?.effort,multiAgentMode,prompt:prompt.trim()})
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
    let nativeUltra
    if(supports('ultra')){
      const reference=join(root,'native-reference');mkdirSync(reference,{mode:0o700})
      writeFileSync(join(reference,'config.toml'),readFileSync(join(directory,'config.toml')))
      const before=requests.length
      const cli=spawn(codexBundledCli(application),['exec','--json','--ephemeral','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','-c','model_reasoning_effort="ultra"','Reply with one sentence. Do not use tools.'],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',CODEX_HOME:reference},stdio:['ignore','pipe','pipe']})
      let output='';cli.stdout.on('data',chunk=>output+=chunk);cli.stderr.on('data',chunk=>output+=chunk)
      const timeout=setTimeout(()=>cli.kill('SIGKILL'),30000)
      try{
        const code=await new Promise((resolve,reject)=>{cli.once('error',reject);cli.once('close',resolve)})
        assert.equal(code,0,output);assert.equal(requests.length,before+1,'native Ultra reference must send exactly one request')
        nativeUltra=requests[before]
        assert.ok(nativeUltra.multiAgentMode,'native Ultra reference must expose its delegation mode')
        console.log(JSON.stringify({stage:'native-ultra-reference',request:nativeUltra}))
      }finally{clearTimeout(timeout);if(cli.exitCode===null)cli.kill('SIGKILL')}
    }
    const hook=prepareCodexSpeedMenu({inspection,directory,desktopDirectory,executable,nonce})
    if(features.length)assert.ok(hook,inspection.reason)
    else assert.equal(hook,undefined,inspection.reason)
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
    capture=async name=>{
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
    if(hook){
      const state=readCodexSpeedMenuStatus({statusLog:hook.statusLog,nonce,executable,directory,pid:child.pid});assert.equal(state.state,'active',state.reason)
    }else console.log('No optional Codex UI capability was detected; the official UI remains unmodified')
    if(supports('locale'))assert.equal(await wait('document.documentElement.lang.startsWith("zh")&&document.documentElement.lang'),'zh-CN')
    const click=async expression=>{
      const point=await evaluate(`(()=>{const el=${expression};if(!el)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
      assert.ok(point,'native control missing: '+expression)
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
    }
    const key=async key=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key})}
    if(supports('speed')||supports('ultra')){
      const modelButton=await evaluate('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      assert.ok(modelButton,'native model selector is unavailable for detected UI capabilities')
      await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...modelButton});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...modelButton})
      await delay(1000)
      console.log(JSON.stringify({stage:'model-menu',text:await evaluate('document.body.innerText.slice(-2600)'),controls:await evaluate('Array.from(document.querySelectorAll("select,input,[role=menuitem],[role=menuitemradio]")).map(el=>({tag:el.tagName,role:el.getAttribute("role"),text:el.innerText,value:el.value})).slice(-25)')}))
      await capture('codex-model-menu.png')
    }
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
    const send=async(text)=>{
      const before=requests.length
      await click('document.querySelector("[contenteditable=true]")')
      await call('Input.insertText',{text})
      await click('Array.from(document.querySelectorAll("button")).find(b=>{const label=(b.getAttribute("aria-label")||"").trim();return !b.disabled&&/^(发送|Send|Submit)$/i.test(label)})||document.querySelector("button[type=submit]:not([disabled])")')
      const deadline=Date.now()+60000
      let request
      while(!(request=requests.slice(before).find(request=>request.prompt===text))){assert.ok(Date.now()<deadline,'native request was not sent: '+JSON.stringify(requests.slice(before)));await delay(100)}
      await wait('document.body.innerText.includes("Compatibility check complete.")')
      await delay(1500)
      return request
    }
    if(supports('speed')){
      await chooseSpeed(false)
      await key('Escape');await key('Escape')
    }else if(supports('ultra'))await key('Escape')
    const standard=await send('Reply with one sentence for the standard compatibility test.')
    assert.ok(standard.serviceTier==null||standard.serviceTier==='default',JSON.stringify(requests))
    let accelerated
    if(supports('speed')){
      await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
      await chooseSpeed(true)
      await key('Escape');await key('Escape')
      accelerated=await send('Reply with one sentence for the Fast compatibility test.')
      assert.equal(accelerated.serviceTier,'priority',JSON.stringify(requests))
    }else console.log('Fast capability was not detected; only the default request was verified')
    if(supports('ultra')){
      await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
      await evaluate('document.querySelector("[data-reasoning-slider]").focus()')
      // The client can change the number of intensity stops. Select the visible
      // Ultra level instead of advancing a fixed count into a different level.
      for(let step=0;step<12;step++){
        if(await evaluate('document.querySelector("[data-model-picker-view-toggle]")?.innerText.includes("Ultra")'))break
        await key('ArrowRight');await delay(150)
      }
      await wait('document.querySelector("[data-model-picker-view-toggle]")?.innerText.includes("Ultra")')
      await capture('codex-ultra-menu.png')
      await key('Enter');await delay(500)
      await key('Escape')
      const ultra=await send('Reply with one sentence for the Ultra reasoning compatibility test.')
      // Ultra is a native execution preset: current clients use the model's
      // multi_agent_reasoning_effort on the wire and enable proactive delegation.
      // Compare against the unmodified bundled CLI instead of forcing the UI
      // label into the Responses reasoning.effort field.
      assert.equal(ultra.reasoningEffort,nativeUltra.reasoningEffort,JSON.stringify(requests))
      assert.equal(ultra.multiAgentMode,nativeUltra.multiAgentMode)
      assert.notEqual(ultra.multiAgentMode,standard.multiAgentMode)
      assert.equal(ultra.serviceTier,supports('speed')?'priority':standard.serviceTier,JSON.stringify(requests))
      // Recent configurations are recorded on submission in newer clients.
      // Verify the persisted selection after a real turn, then reload the UI
      // and send again without selecting Ultra a second time.
      const saved=JSON.parse(readFileSync(join(directory,'.codex-global-state.json'),'utf8'))
      const recent=saved['electron-persisted-atom-state']['composer-recent-model-configurations-v1']
      assert.equal(recent[0].model,'gpt-6.1-sol')
      assert.equal(recent[0].reasoningEffort,'ultra')
      await call('Page.reload')
      // The desktop router restores the home screen after a page reload.
      // Reopen the same persisted thread before checking its reasoning preset.
      const thread='Array.from(document.querySelectorAll("span")).find(el=>el.children.length===0&&el.textContent==="Reply with one sentence for the standard compatibility test.")'
      await wait(`!!(${thread})`)
      await click(thread)
      await wait('document.body.innerText.includes("Reply with one sentence for the Ultra reasoning compatibility test.")')
      await wait('Array.from(document.querySelectorAll("button")).some(b=>b.innerText.includes("6.1 Sol"))')
      await click('Array.from(document.querySelectorAll("button")).find(b=>b.innerText.includes("6.1 Sol"))')
      await wait('document.querySelector("[data-model-picker-view-toggle]")?.innerText.includes("Ultra")')
      await capture('codex-ultra-restored.png')
      await key('Escape')
      const restored=await send('Reply with one sentence after restoring the Ultra reasoning selection.')
      assert.equal(restored.reasoningEffort,nativeUltra.reasoningEffort,JSON.stringify(requests))
      assert.equal(restored.multiAgentMode,nativeUltra.multiAgentMode)
      assert.equal(restored.serviceTier,ultra.serviceTier,JSON.stringify(requests))
    }else console.log('Ultra capability was not detected; Ultra-specific controls were skipped')
    await capture('codex-verified.png')
    console.log(JSON.stringify({stage:'verified',version:inspection.version,features,language:await evaluate('document.documentElement.lang'),requests}))
    console.log(`Native Codex smoke passed for detected capabilities: ${features.join(', ')||'none (official UI)'}`)
  }catch(error){
    await capture('codex-failure.png').catch(()=>{})
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
