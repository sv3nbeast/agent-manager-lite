const {app,safeStorage}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
const timer=setTimeout(()=>{console.error('Strategy UI exceeded 75 seconds');app.exit(1)},75000)
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

  const choose=async(name,source)=>{const expr=`Array.from(document.querySelectorAll('.strategy-candidates tr.ant-table-row')).find(r=>r.children[1].textContent===${JSON.stringify(name)}&&r.children[2].textContent===${JSON.stringify(source)})`;await wait(`!!(${expr})`);await run(`(${expr}).querySelector('input[type="checkbox"]').click()`)}
  const memberButton=async(name,label)=>{const expr=`Array.from(document.querySelectorAll('.strategy-members tr.ant-table-row')).find(r=>r.children[0].textContent.startsWith(${JSON.stringify(name)}))`;await wait(`!!(${expr})`);await run(`Array.from((${expr}).querySelectorAll('button')).find(b=>b.textContent.replaceAll(' ','')===${JSON.stringify(label)}).click()`)}
  const select=async(selector,label)=>{await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);await click('.ant-select-item-option',label)}
  const add=async(name,nodes)=>{const p=await run(`window.manager.previewProxyCatalog(${JSON.stringify({action:'import',name,input:JSON.stringify({proxies:nodes})})})`);await run(`window.manager.applyProxyCatalog(${JSON.stringify({ticket:p.ticket,confirmed:true})})`)}
  const node=(name,server='node.invalid')=>({name,type:'http',server,port:8080,password:'fixture-strategy-ui-secret'})
  const policy=()=>vault().proxyCatalogs.find(s=>s.kind==='strategy')
  try{
   await wait('!!document.querySelector(".account-filters")')
   await add('Origin A',Array.from({length:56},(_,i)=>node('N'+String(i).padStart(2,'0'))));await add('Origin B',[node('N00','other.invalid'),node('Extra')])
   await click('.proxy-resources-trigger','代理资源与统一出口');await click('.proxy-catalog-trigger','来源目录');await click('.proxy-catalog-panel button','新建策略')
   await wait('document.querySelectorAll(".strategy-candidates tr.ant-table-row").length===25');await fill('.strategy-name','My Policy');await choose('N00','Origin A')
   await click('.strategy-candidates .ant-pagination-item-3 a','3');await wait('document.querySelector(".strategy-candidates").textContent.includes("N55")');await choose('N55','Origin A');await choose('N00','Origin B')
   await memberButton('N55','上移');await fill('.strategy-url','https://user:secret@health.invalid/');await wait('Array.from(document.querySelectorAll(".strategy-footer button")).find(b=>b.textContent.includes("预览")).disabled')
   await fill('.strategy-url','http://probe.invalid/status');await fill('.strategy-interval input','180');await fill('.strategy-timeout input','7')
   await capture('proxy-strategy-editor.png');await click('.strategy-footer button','预览策略');await wait('document.querySelector(".catalog-confirm").textContent.includes("N00")')
   assert.equal(await run('document.querySelector(".catalog-confirm").textContent.includes("fixture-strategy-ui-secret")'),false)
   await confirm();assert.deepEqual(policy().catalog.groups[0].members,['N55','N00']);assert.equal(policy().strategyMembers[1].sourceName,'Origin A');assert.equal(policy().catalog.groups[0].native.timeout,7000)
   const identity=policy().catalog.groups[0].id;await click('.proxy-catalog-panel button','My Policy');await click('.proxy-catalog-panel button','编辑策略')
   await wait('document.querySelector(".strategy-interval input").value==="180"');assert.equal(await run('document.querySelector(".strategy-timeout input").value'),'7')
   await fill('.strategy-name','Cancelled name');await click('.strategy-footer button','取消');await wait('!document.querySelector(".proxy-strategy-editor")');assert.equal(policy().name,'My Policy')
   await click('.proxy-catalog-panel button','编辑策略');await wait('document.querySelectorAll(".strategy-members tr.ant-table-row").length===2');await memberButton('N00','移除')
   await select('.strategy-kind .ant-select-selector','自动测速选择');await fill('.strategy-tolerance input','75');await click('.strategy-footer button','预览策略');await confirm()
   assert.equal(policy().catalog.groups[0].id,identity);assert.deepEqual(policy().catalog.groups[0].members,['N55']);assert.equal(policy().catalog.groups[0].native.tolerance,75)
   await click('.catalog-current button','分组 1');await click('.catalog-items button','选择');await wait('!!document.querySelector(".catalog-binding")');await fill('.catalog-binding input.ant-input','Strategy resource');await click('.catalog-binding button','预览保存资源');await confirm()
   assert.equal(vault().proxyResources[0].catalog.sourceId,policy().id)
   await click('.catalog-current button','返回来源列表');await click('.proxy-catalog-panel button','Origin A');await click('.proxy-catalog-panel button','删除来源');await wait('document.querySelector(".catalog-confirm").textContent.includes("My Policy")');await confirm()
   await click('.proxy-catalog-panel button','My Policy');await click('.proxy-catalog-panel button','编辑策略');await wait('document.querySelector(".strategy-members").textContent.includes("原来源已删除")')
   await fill('.strategy-name','Retained Policy');await capture('proxy-strategy-retained.png');await click('.strategy-footer button','预览策略');await confirm();assert.equal(policy().name,'Retained Policy');assert.deepEqual(policy().catalog.groups[0].members,['N55'])
   await click('.proxy-catalog-panel button','删除来源');await wait('document.querySelector(".catalog-confirm").textContent.includes("1 个已保存资源")');await click('.catalog-confirm button','取消预览');assert.ok(policy())
   await click('.proxy-catalog-panel button','删除来源');await confirm();assert.equal(policy(),undefined);assert.equal(vault().proxyResources.length,0)
   assert.equal(fs.readFileSync(join(directory,'state.vault')).includes('fixture-strategy-ui-secret'),false)
   console.log('Strategy UI passed: cross-page multi-source selection/order, duplicate-name preview, field validation/seconds roundtrip, four-kind picker, edit/cancel, stable group binding, deleted-origin retained copy and dependency deletion; temporary AES-GCM and synthetic nodes only, no OS keychain.')
   clearTimeout(timer);app.quit()
  }catch(error){console.error(error);await capture('proxy-strategy-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
 })
})
console.log('Strategy UI: ephemeral AES-GCM; no real accounts/keychain or external provider requests')
require('../out/main/index.js')
