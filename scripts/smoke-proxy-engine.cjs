// Real Electron + pinned official version executable; all data is temporary.
// Download transport only is a slow loopback fixture for deterministic cancel.
const {app,safeStorage,dialog}=require('electron')
const fs=require('node:fs'),assert=require('node:assert/strict'),{join,resolve}=require('node:path'),{createHash}=require('node:crypto'),{tmpdir}=require('node:os')
const http=require('node:http'),https=require('node:https'),childProcess=require('node:child_process')
const directory=process.env.CML_TEST_DATA_DIR,archive=process.env.CML_TEST_ENGINE_ARCHIVE
assert.ok(directory&&directory.startsWith(tmpdir())&&!fs.existsSync(join(directory,'state.vault')))
assert.ok(archive&&fs.existsSync(archive),'Set CML_TEST_ENGINE_ARCHIVE to the pinned official archive')
const manifest=require('../src/main/mihomo-assets.json'),target=process.platform==='darwin'?(process.arch==='arm64'?'aarch64':'x86_64')+'-apple-darwin':undefined
assert.ok(target,'This desktop fixture is currently verified on macOS')
const expected=manifest.assets[target],data=fs.readFileSync(archive)
assert.equal(createHash('sha256').update(data).digest('hex'),expected.sha256)
const vaultStats=require('./test-vault.cjs').installTestVault(safeStorage)
let selected=archive,downloads=0,executions=0,server
dialog.showOpenDialog=async()=>selected?({canceled:false,filePaths:[selected]}):({canceled:true,filePaths:[]})
const spawn=childProcess.spawn
childProcess.spawn=function(file,args,options){
  assert.notEqual(file,'/usr/bin/security','No real keychain access')
  if(String(file).endsWith('/mihomo')){assert.deepEqual(args,['-v']);assert.ok(file.startsWith(directory));assert.equal(options.env.HTTPS_PROXY,undefined);executions++}
  return spawn.call(this,file,args,options)
}
https.get=function(url,options,callback){
  assert.equal(String(url),manifest.assetBaseUrl+expected.file);assert.equal(options.headers.Authorization,undefined);downloads++
  return http.get('http://127.0.0.1:'+server.address().port,options,callback)
}
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Engine UI timed out');app.exit(1)},75000)
app.on('will-quit',()=>{server?.closeAllConnections();server?.close()})
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait=async expression=>{const end=Date.now()+40000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,30))}}
    const click=async(selector,text)=>{if(await require('./desktop-network-entry.cjs').clickEntry(run,wait,selector))return;const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
    const capture=async name=>{await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,120));fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const close=()=>run('document.querySelector(".proxy-engine-panel").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
    try{
      await wait('!!document.querySelector(".account-filters")');await click('.proxy-resources-trigger','代理资源与统一出口');await click('.proxy-engine-trigger','代理引擎');await wait('document.querySelector(".engine-summary")?.textContent.includes("尚未安装")')
      assert.equal(downloads,0);assert.equal(executions,0);assert.equal(fs.existsSync(join(directory,'proxy-engine')),false)
      await capture('proxy-engine-empty.png')
      selected=undefined;await click('.engine-actions button','导入官方安装包');await wait('!Array.from(document.querySelectorAll(".engine-actions button")).find(el=>el.textContent.includes("下载并安装")).disabled')
      assert.equal(fs.existsSync(join(directory,'proxy-engine')),false)
      selected=join(directory,'bad-private-secret.gz');fs.writeFileSync(selected,'invalid fixture')
      await click('.engine-actions button','导入官方安装包');await wait('document.querySelector(".proxy-engine-panel .ant-alert")?.textContent.includes("校验不匹配")');assert.equal(executions,0)
      assert.equal(await run('document.querySelector(".proxy-engine-panel").textContent.includes("bad-private-secret")'),false)
      selected=archive;await click('.engine-actions button','导入官方安装包');await wait('document.querySelector(".proxy-engine-panel .ant-alert")?.textContent.includes("安装完成")');assert.equal(executions,1)
      await click('.engine-actions button','检查安装');await wait('document.querySelector(".proxy-engine-panel .ant-alert")?.textContent.includes("检查通过")');assert.equal(executions,2)
      await capture('proxy-engine-installed.png');const pointer=fs.readFileSync(join(directory,'proxy-engine','active.json'))
      await click('.engine-actions button','重新下载安装');await wait('!!document.querySelector(".engine-progress")');await close();await wait('!document.querySelector(".proxy-engine-panel")')
      await click('.proxy-engine-trigger','代理引擎');await wait('!!document.querySelector(".engine-progress")');await capture('proxy-engine-downloading.png')
      await click('.engine-actions button','取消安装');await wait('document.querySelector(".proxy-engine-panel .ant-alert")?.textContent.includes("安装已取消")');assert.deepEqual(fs.readFileSync(join(directory,'proxy-engine','active.json')),pointer)
      assert.equal(downloads,1);assert.equal(executions,2);assert.equal(fs.existsSync(join(directory,'state.vault')),false);assert.deepEqual(vaultStats(),{encryptions:0,decryptions:0})
      await assert.rejects(run('window.manager.cancelProxyEngine("invalid")'))
      console.log('Proxy engine UI passed: side-effect-free status, picker cancel, checksum failure, real pinned import/version/preflight, progress survives closing, download cancel keeps prior release; zero vault/keychain calls.')
      clearTimeout(timer);app.quit()
    }catch(error){console.error(error);await capture('proxy-engine-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
  })
})
server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Length':data.length});const interval=setInterval(()=>res.write(data.subarray(0,1024)),100);res.on('close',()=>clearInterval(interval))})
server.listen(0,'127.0.0.1',()=>{console.log('Proxy engine UI: pinned official binary version only, temporary directory, isolated AES-GCM, loopback download cancellation');require('../out/main/index.js')})
