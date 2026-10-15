const {app,safeStorage}=require('electron')
const {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,realpathSync}=require('node:fs')
const {resolve,join,sep,basename}=require('node:path')
const {tmpdir}=require('node:os')
const {createServer}=require('node:http')
const assert=require('node:assert/strict')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory && realpathSync(directory).startsWith(realpathSync(tmpdir())+sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(existsSync(join(directory,'state.vault')),false)
const stats=require('./test-vault.cjs').installTestVault(safeStorage)
console.log('probe smoke: ephemeral test codec (no OS keychain access)')
const output=resolve('.local/smoke-evidence');mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Probe UI smoke timed out');app.exit(1)},55_000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    let upstream
    const run=async expression=>{try{return await window.webContents.executeJavaScript(expression)}catch(error){throw new Error(`Renderer operation failed: ${expression}`,{cause:error})}}
    const wait=async expression=>{const end=Date.now()+5000;while(!await run(expression)){if(Date.now()>end)throw new Error('Probe UI condition timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,40))}}
    const click=(selector,text)=>run(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length && el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))}).click()`)
    const select=async(selector,option)=>{
      const control=await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select');e.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return e.querySelector('input').getAttribute('aria-controls')})()`)
      const dropdown=`document.getElementById(${JSON.stringify(control)})?.closest('.ant-select-dropdown')`
      await wait(`Array.from(${dropdown}?.querySelectorAll('.ant-select-item-option')??[]).some(e=>e.getClientRects().length&&e.textContent===${JSON.stringify(option)})`)
      await run(`Array.from(${dropdown}.querySelectorAll('.ant-select-item-option')).find(e=>e.getClientRects().length&&e.textContent===${JSON.stringify(option)}).click()`)
    }
    const capture=async name=>{
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await new Promise(resolve=>setTimeout(resolve,150))
      writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())
    }
    try {
      const observed=[]
      let stall=false,wanted='priority'
      upstream=createServer(async(req,res)=>{
        try {
          if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'custom-primary'},{id:'custom-secondary'}]}));return}
          if(req.method!=='POST' || !['/v1/responses','/v1/messages'].includes(req.url)){res.statusCode=404;res.end('{}');return}
          let raw='';for await(const chunk of req)raw+=chunk
          const body=JSON.parse(raw)
          observed.push({path:req.url,model:body.model,tier:body.service_tier})
          if(req.url==='/v1/messages') {
            assert.equal(req.headers.authorization,'Bearer fixture-claude-probe-secret')
            assert.equal(req.headers['x-api-key'],undefined)
            assert.equal(req.headers['anthropic-version'],'2023-06-01')
            assert.equal(body.model,'claude-exclusive')
            assert.equal(body.service_tier,undefined)
            assert.equal(body.max_tokens,256)
            res.setHeader('Content-Type','application/json')
            res.end(JSON.stringify({id:'fixture-message',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Claude 密钥独立模型正常'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}}));return
          }
          assert.equal(req.url,'/v1/responses')
          assert.equal(req.headers.authorization,'Bearer fixture-probe-ui-secret')
          assert.equal(body.model,'custom-secondary','An explicitly selected vendor model must be sent without a GPT fallback')
          assert.equal(body.service_tier,wanted)
          if(stall)return
          res.setHeader('Content-Type','application/json')
          res.end(JSON.stringify({id:'fixture-probe-ui',object:'response',status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'模型对话正常 🧪'}]}],usage:{input_tokens:3,output_tokens:2}}))
        } catch(error) {console.error(error);res.statusCode=500;res.end(JSON.stringify({error:{message:'Fixture request validation failed'}}))}
      })
      await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
      await run(`window.manager.saveSettings({theme:'light',defaultTier:'standard',port:16321,refreshMinutes:0,launchAtLogin:false})`)
      let data=await run(`window.manager.mutateProvider(${JSON.stringify({action:'create',details:{name:'本机测试接口',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,models:[],wireApi:'responses',defaultTier:'fast'},initialKey:{name:'自定义模型密钥',apiKey:'fixture-probe-ui-secret',models:['obsolete-model'],protocol:'openai_responses',credentialKind:'openai_api_key',createConnection:false}})})`)
      const id=data.providers[0].id,keyId=data.providers[0].keys[0].id
      data=await run(`window.manager.mutateProvider(${JSON.stringify({action:'addKey',id,revision:data.providers[0].revision,name:'Claude 密钥',apiKey:'fixture-claude-probe-secret',models:['claude-exclusive'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer',createConnection:false})})`)
      const claudeKeyId=data.providers[0].keys[1].id
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await wait(`!!document.querySelector('.provider-key-table')`)
      await click('.provider-library-toolbar button','接口测试')
      await wait(`!!document.querySelector('.provider-probe-panel')`)
      await click('.provider-probe-panel button','开始测试')
      await wait(`document.querySelector('.provider-probe-results')?.textContent.includes('通过')`)
      data=await run('window.manager.load()');assert.equal(data.providerProbe.succeeded,1)
      await click('.provider-probe-results button','选择模型')
      await wait(`!!document.querySelector('[aria-label="获取后的模型目录"]')`)
      await click('.catalog-bulk-actions button','全部清除')
      await click('.catalog-bulk-actions button','全部加入')
      await click('.ant-modal-footer button','保存模型')
      await wait(`!document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`)
      data=await run('window.manager.load()')
      assert.deepEqual(data.providers[0].models,[])
      assert.deepEqual(data.providers[0].keys.find(key=>key.id===keyId).models,['custom-primary','custom-secondary'])
      assert.deepEqual(data.providers[0].keys.find(key=>key.id===claudeKeyId).models,['claude-exclusive'])
      assert.equal(data.providerProbe.records[0].models.length,2)
      await run(`document.querySelector('.provider-probe-results .ant-table-row-expand-icon').click()`)
      await capture('provider-probe-models.png')
      await click('.provider-probe-panel .ant-radio-wrapper','对话回复')
      await select('.probe-target-models .ant-select','custom-secondary')
      await click('.provider-probe-panel button','开始测试')
      await wait(`document.querySelector('.provider-probe-results')?.textContent.includes('custom-secondary') && document.querySelector('.provider-probe-results')?.textContent.includes('通过')`)
      data=await run('window.manager.load()')
      assert.equal(data.providerProbe.records[0].outboundTier,'priority')
      assert.equal(data.providerProbe.records[0].responseTier,'default')
      assert.equal(data.providerProbe.records[0].reply,'模型对话正常 🧪')
      const expanded=await run(`!!document.querySelector('.provider-probe-results .ant-table-row-expand-icon-expanded')`)
      if(!expanded)await run(`document.querySelector('.provider-probe-results .ant-table-row-expand-icon').click()`)
      await capture('provider-probe-chat.png')
      await run(`Array.from(document.querySelectorAll('.provider-probe-panel .ant-form-item')).find(el=>el.querySelector('label')?.textContent==='请求服务等级').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
      await click('.ant-select-item-option','Standard');wanted='default'
      await click('.provider-probe-panel button','开始测试')
      await wait(`document.querySelector('.provider-probe-results')?.textContent.includes('通过')`)
      data=await run('window.manager.load()');assert.equal(data.providerProbe.records[0].outboundTier,'default')
      await select('[aria-label="测试目标"]','本机测试接口 · Claude 密钥')
      await run(`document.querySelector('.provider-probe-panel h3')?.click();document.activeElement?.blur()`)
      await wait(`document.querySelectorAll('.probe-target-models .ant-select').length===2`)
      const modelTitles=await run(`Array.from(document.querySelectorAll('.probe-target-models .ant-select-selection-item')).map(el=>el.title)`)
      assert.deepEqual(modelTitles,['custom-secondary','claude-exclusive'])
      await click('.provider-probe-panel button','开始测试')
      await wait(`window.manager.load().then(data=>data.providerProbe.completed===2)`)
      data=await run('window.manager.load()');assert.equal(data.providerProbe.succeeded,2)
      assert.equal(data.providerProbe.records[1].protocol,'anthropic_messages')
      assert.equal(data.providerProbe.records[1].reply,'Claude 密钥独立模型正常')
      assert.deepEqual(observed.map(value=>value.model),['custom-secondary','custom-secondary','custom-secondary','claude-exclusive'])
      await capture('provider-probe-mixed-protocols.png')
      stall=true
      await click('.provider-probe-panel button','开始测试')
      await wait(`document.querySelector('.provider-probe-results')?.textContent.includes('等待对话回复')`)
      await click('.provider-probe-panel button','取消测试')
      await wait(`document.querySelector('.provider-probe-results')?.textContent.includes('已取消')`)
      data=await run('window.manager.load()')
      assert.equal(data.providerProbe.running,false);assert.equal(data.providerProbe.cancelled,true)
      assert.equal(JSON.stringify(data).includes('fixture-probe-ui-secret'),false)
      assert.equal(JSON.stringify(data).includes('fixture-claude-probe-secret'),false)
      if(existsSync(join(directory,'provider-probes')))assert.deepEqual(readdirSync(join(directory,'provider-probes')),[])
      assert.ok(stats().encryptions>0)
      assert.equal(readFileSync(join(directory,'state.vault')).includes('fixture-probe-ui-secret'),false)
      await capture('provider-probe-cancelled.png')
      console.log('Probe UI smoke passed: per-key discovery/clear/add, non-GPT model selection, independent mixed-protocol model requests/auth, service tiers, cancellation and encrypted fixtures; no OS keychain access')
      clearTimeout(timer);upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));window.destroy();app.exit(0)
    } catch(error) {
      console.error(error);await capture('provider-probe-failure.png').catch(()=>{});clearTimeout(timer);upstream?.closeAllConnections();upstream?.close();app.exit(1)
    }
  })
})
require('../out/main/index.js')
