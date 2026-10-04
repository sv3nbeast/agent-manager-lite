const {app,safeStorage,dialog}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{createServer}=require('node:http')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
const archives=fs.mkdtempSync(join(tmpdir(),'cml-backup-ui-')),file=join(archives,'portable.cmlbackup'),password='fixture backup password 中文'
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
let cancelChoice=false,holdSave,releaseSave,failSave=false,relaunched=false,passed=false
const encrypt=safeStorage.encryptString
safeStorage.encryptString=value=>{if(failSave)throw new Error('fixture vault failure');return encrypt(value)}
dialog.showSaveDialog=async()=>{if(holdSave)return new Promise(resolve=>{releaseSave=resolve});return {canceled:cancelChoice,filePath:cancelChoice?undefined:file}}
dialog.showOpenDialog=async()=>({canceled:cancelChoice,filePaths:cancelChoice?[]:[file]})
app.relaunch=()=>{relaunched=true}
app.on('will-quit',()=>{fs.rmSync(archives,{recursive:true,force:true});if(passed)assert.equal(relaunched,true)})
const timer=setTimeout(()=>{console.error('Data backup UI exceeded 75 seconds');app.exit(1)},75000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(`(async()=>(${code}))()`)
    const wait=async expression=>{const end=Date.now()+10000;while(!await run(expression)){assert.ok(Date.now()<end,'UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,25))}}
    const click=async(selector,text)=>{const expr=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expr})`);await run(`(${expr}).click()`)}
    const fill=async(selector,value)=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const invoke=(method,input)=>run(`window.manager.${method}(${input===undefined?'':JSON.stringify(input)})`)
    const vault=()=>JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault'))))
    const close=async()=>{await click('.ant-modal-close','');await wait('!document.querySelector(".data-backup-dialog")')}
    const preview=async()=>{await click('.data-backup-panel button','从备份恢复');await fill('.backup-password input',password);await click('.data-backup-dialog button','选择文件并预览');await wait('!!document.querySelector(".backup-counts")')}
    const confirm=async()=>{await run('document.querySelector(".backup-confirm input").click()');await click('.data-backup-dialog button','确认恢复')}
    try{
      await wait('!!window.manager && !!document.querySelector("h1")')
      const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
      const initial=(await invoke('load')).settings
      await invoke('saveSettings',{...initial,refreshMinutes:0,defaultTier:'fast',port})
      const details={name:'备份账号',apiKey:'fixture-backup-account-secret',baseUrl:'http://127.0.0.1:9/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'inherit'}
      const account=(await invoke('addAccount',details)).accounts[0]
      await click('.sidebar-bottom button','设置')
      await click('.data-backup-panel button','导出加密备份');await fill('.backup-password input',password);await fill('.backup-repeat input','different')
      assert.equal(await run('document.querySelector(".data-backup-dialog .ant-btn-primary").disabled'),true)
      await fill('.backup-repeat input',password);await click('.data-backup-dialog button','选择位置并导出');await wait('document.querySelector(".data-backup-dialog")?.textContent.includes("加密备份已导出")')
      assert.ok(fs.existsSync(file));assert.equal(fs.readFileSync(file).includes(details.apiKey),false);assert.equal(fs.statSync(file).mode&0o777,0o600);await close()
      cancelChoice=true;assert.equal(await invoke('previewDataBackup',{requestId:randomUUID(),password}),undefined);cancelChoice=false
      await assert.rejects(invoke('previewDataBackup',{requestId:randomUUID(),password,path:file}),/参数格式/)
      await assert.rejects(invoke('restartAfterBackup'),/没有等待重启/)
      const cancelled=randomUUID();await invoke('cancelDataBackup',cancelled);await assert.rejects(invoke('previewDataBackup',{requestId:cancelled,password}),/取消/)
      await invoke('addAccount',{...details,name:'稍后新增',apiKey:'fixture-later-secret'})
      await invoke('saveSettings',{...initial,refreshMinutes:0,defaultTier:'standard',port})
      await click('.data-backup-panel button','从备份恢复');await fill('.backup-password input','wrong password');await click('.data-backup-dialog button','选择文件并预览')
      await wait('document.querySelector(".backup-error")?.textContent.includes("密码")');assert.equal(vault().accounts.length,2);assert.equal(await run('document.querySelector(".backup-password input").value'), '');await close()
      await preview();assert.deepEqual(await run('Array.from(document.querySelectorAll(".backup-counts tbody tr:first-child td")).map(e=>e.textContent)'),['账号','2','1'])
      await capture('data-backup-preview.png');await close();assert.equal(vault().accounts.length,2)
      // A pending native file dialog is still an active IPC operation. Restoring
      // must not race a dialog that will later resume an old mutation/export.
      const p=await invoke('previewDataBackup',{requestId:randomUUID(),password});holdSave=true
      const pending=invoke('exportDataBackup',{requestId:randomUUID(),password})
      while(!releaseSave)await new Promise(resolve=>setTimeout(resolve,10))
      await assert.rejects(invoke('restoreDataBackup',{ticket:p.ticket,requestId:randomUUID(),confirmed:true}),/其他操作/)
      releaseSave({canceled:true});await pending;holdSave=false
      await invoke('startGateway',account.id);await preview();await confirm();await wait('document.querySelector(".backup-error")?.textContent.includes("停止本地 API")')
      assert.equal(vault().accounts.length,2);await close();await invoke('stopGateway')
      failSave=true;await preview();await confirm();await wait('document.querySelector(".backup-error")?.textContent.includes("fixture vault failure")')
      assert.equal(vault().settings.defaultTier,'standard');assert.equal(vault().accounts.length,2);failSave=false;await close()
      await preview();await confirm();await wait('document.querySelector(".data-backup-dialog")?.textContent.includes("配置已恢复，重启后生效")')
      assert.equal(vault().settings.defaultTier,'fast');assert.equal(vault().accounts.length,1);assert.equal(vault().accounts[0].credentials.apiKey,details.apiKey)
      const current=await invoke('load');assert.equal(current.backupRestartRequired,true);assert.equal(JSON.stringify(current).includes(details.apiKey),false)
      await assert.rejects(invoke('saveSettings',{...initial}),/等待重启/)
      assert.equal(fs.existsSync(await run('document.querySelector(".backup-path").textContent')),true)
      await capture('data-backup-restored.png')
      console.log('Data backup Electron UI passed: password confirmation, encrypted export, native dialog cancellation, strict IPC, wrong password, preview/cancel, pending-dialog exclusion, running-service guard, vault failure rollback, atomic restore, persisted Fast and credentials, restart gate. Temporary AES-GCM; relaunch intercepted, no real keychain/accounts.')
      passed=true;clearTimeout(timer);await click('.data-backup-dialog button','立即重启')
    }catch(error){console.error(error);await capture('data-backup-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
  })
})
require('../out/main/index.js')
