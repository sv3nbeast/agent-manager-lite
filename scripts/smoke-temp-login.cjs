const {app,safeStorage,dialog,shell,clipboard}=require('electron')
const fs=require('node:fs'),{join,resolve,sep,basename}=require('node:path'),{tmpdir}=require('node:os'),{randomUUID,createHash}=require('node:crypto'),assert=require('node:assert/strict')
const childProcess=require('node:child_process'),directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory,'state.vault')),false)
const stats=require('./test-vault.cjs').installTestVault(safeStorage)
const canonical=fs.realpathSync(directory),application=join(canonical,'登录测试 Fixture.app'),executable=join(application,'Contents','MacOS','Codex')
fs.mkdirSync(join(application,'Contents','MacOS'),{recursive:true})
fs.writeFileSync(join(application,'Contents','Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.cml.login.${randomUUID()}</string><key>CFBundleName</key><string>CML Login Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
childProcess.execFileSync('go',['build','-o',executable,'tests/fixtures/desktop-client.go'],{cwd:resolve('.'),timeout:30000,stdio:'pipe'})
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[application]})
const opened=[],copied=[];let browserFails=false;shell.openExternal=async url=>{if(browserFails)throw new Error('fixture browser error '+url);opened.push(url)};clipboard.writeText=text=>copied.push(text)
const {promisify}=require('node:util'),originalExec=childProcess.execFile,originalPromiseExec=promisify(originalExec)
const systemEntries=new Map(),systemCalls=[],ownedHomes=new Map()
const entryKey=home=>'cli|'+createHash('sha256').update(home).digest('hex').slice(0,16)
const unrelatedKey=entryKey('/fixture-unrelated-home');systemEntries.set(unrelatedKey,{raw:'unrelated-fixture'})
const simulateSecurity=(args,options)=>{
  assert.equal(args[1],'-s');assert.equal(args[2],'Codex Auth');assert.equal(args[3],'-a')
  const key=args[4]
  if(!ownedHomes.has(key)){
    const sessions=join(canonical,'temp-login','sessions')
    const id=fs.readdirSync(sessions).find(id=>entryKey(join(sessions,id,'home'))===key)
    assert.ok(id,'A probe must refer to a home created by this isolated test')
    const folder=join(sessions,id,'home');assert.equal(fs.realpathSync(folder),folder)
    ownedHomes.set(key,{pid:0})
  }
  const owned=ownedHomes.get(key)
  assert.ok(owned,'System commands must address only a registered temporary fixture home')
  const action=args[0]==='delete-generic-password'?'delete':args.includes('-w')?'read':'probe'
  assert.deepEqual(args,[action==='delete'?'delete-generic-password':'find-generic-password','-s','Codex Auth','-a',key,...(action==='read'?['-w']:[])])
  assert.ok(options.signal);assert.equal(options.timeout,action==='probe'?5000:20000)
  systemCalls.push({key,action})
  const entry=systemEntries.get(key)
  if(action==='read'){
    assert.throws(()=>process.kill(owned.pid,0),error=>error.code==='ESRCH','Read credentials only after the fixture client exits')
    if(owned.denyRead)throw Object.assign(new Error('fixture access denied'),{code:1})
  }
  if(action==='delete'&&owned.denyDelete)throw Object.assign(new Error('fixture delete denied'),{code:1})
  if(!entry)throw Object.assign(new Error('fixture item missing'),{code:44})
  if(action==='delete')systemEntries.delete(key)
  return {stdout:action==='read'?entry.raw:'',stderr:''}
}
const wrappedExec=function(file,args,options,callback){
  if(file!=='/usr/bin/security')return originalExec.apply(this,arguments)
  // Never invoke the OS command: native credential behavior is simulated here.
  setImmediate(()=>{try{const result=simulateSecurity(args,options);callback(null,result.stdout,result.stderr)}catch(error){callback(error,'','')}})
}
wrappedExec[promisify.custom]=function(file,...args){return file==='/usr/bin/security'?Promise.resolve().then(()=>simulateSecurity(...args)):originalPromiseExec(file,...args)}
childProcess.execFile=wrappedExec
const auth=generation=>{const token='fixture.'+Buffer.from(JSON.stringify({email:'temporary@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'fixture-temporary',chatgpt_user_id:'fixture-user',chatgpt_plan_type:'plus'}})).toString('base64url')+'.signature';return JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:token,access_token:token,refresh_token:'fixture-secret-'+generation,account_id:'fixture-temporary'}})}
const output=resolve('.local/smoke-evidence');fs.mkdirSync(output,{recursive:true})
console.log('Temporary login UI: isolated AES-GCM, native fixture client, fake credentials, no keychain or provider calls')
const timer=setTimeout(()=>{console.error('Temporary login UI timed out');app.exit(1)},65000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=expression=>window.webContents.executeJavaScript(`(async()=>(${expression}))()`)
    const wait=async expression=>{const end=Date.now()+12000;while(!await run(expression)){if(Date.now()>end)throw new Error('Temp login UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,50))}}
    const click=async(selector,text)=>{const expression=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`!!(${expression})`);await run(`(${expression}).click()`)}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const home=id=>join(canonical,'temp-login','sessions',id,'home')
    try{
      await run('window.manager.saveSettings({theme:"light",defaultTier:"follow",port:16321,refreshMinutes:0,launchAtLogin:false})')
      assert.equal(await run('window.manager.startTempLogin({applicationId:"invalid",interceptAuthUrl:true}).then(()=>false,()=>true)'),true)
      await click('.page-heading button','添加 ChatGPT 账号');await wait('!!document.querySelector(".temp-login-panel")')
      await click('.temp-login-panel button','选择 Codex.app')
      await wait('document.querySelector(".temp-login-select").textContent.includes("登录测试 Fixture")')
      await click('.temp-login-panel button','启动临时登录')
      await wait('(await window.manager.load()).tempLogin.phase==="waiting-login"')
      let snapshot=await run('window.manager.load()'),id=snapshot.tempLogin.id
      const folder=home(id),evidence=JSON.parse(fs.readFileSync(join(folder,'fixture-desktop.json'),'utf8'))
      assert.equal(evidence.home,folder);assert.equal(evidence.desktop,join(canonical,'temp-login','sessions',id,'desktop'));assert.ok(evidence.nodeOptions.includes('auth-hook.cjs'));assert.equal(evidence.authCapture,join(folder,'auth-capture.jsonl'));assert.equal(evidence.inheritedKey,'')
      assert.match(fs.readFileSync(join(folder,'config.toml'),'utf8'),/cli_auth_credentials_store = "file"/)
      const url='https://auth.openai.com/oauth/authorize?state=fixture-local-ui'
      fs.writeFileSync(join(folder,'auth-capture.jsonl'),'{"kind":"armed"}\n'+JSON.stringify({kind:'url',url})+'\n')
      await wait('document.querySelector(".temp-login-panel textarea")?.value.includes("fixture-local-ui")')
      assert.equal(await run('window.manager.startLogin("browser").then(()=>false,()=>true)'),true)
      assert.equal(await run(`window.manager.openTempLoginURL(${JSON.stringify(randomUUID())}).then(()=>false,()=>true)`),true)
      await click('.temp-login-panel button','复制授权链接');await click('.temp-login-panel button','打开授权页面')
      assert.deepEqual(copied,[url]);assert.deepEqual(opened,[url]);await capture('temp-login-authorize.png')
      browserFails=true;const openFailure=await run(`window.manager.openTempLoginURL(${JSON.stringify(id)}).then(()=>'',error=>String(error))`);assert.ok(openFailure.includes('无法打开浏览器'));assert.equal(openFailure.includes(url),false);browserFails=false
      fs.writeFileSync(join(folder,'fixture-rotate-auth.json'),auth('final'));fs.writeFileSync(join(folder,'auth.json'),auth('first'))
      await wait('(await window.manager.load()).tempLogin.phase==="completed"')
      await wait('document.querySelector(".temp-login-panel").textContent.includes("账号已保存")')
      snapshot=await run('window.manager.load()');assert.equal(snapshot.accounts.length,1);assert.equal(snapshot.accounts[0].email,'temporary@example.invalid');assert.equal(JSON.stringify(snapshot).includes('fixture-secret'),false)
      assert.equal(fs.existsSync(folder),false);assert.deepEqual(fs.readdirSync(join(canonical,'temp-login','markers')),[]);await capture('temp-login-completed.png')
      // Export through the real main-process writer to prove the closing token
      // was retained; the export remains in a temporary directory outside vault.
      const exportRoot=fs.mkdtempSync(join(tmpdir(),'cml-temp-login-export-')),exportPath=join(exportRoot,'accounts.json')
      try{dialog.showSaveDialog=async()=>({canceled:false,filePath:exportPath});await run(`window.manager.exportAccounts(${JSON.stringify([snapshot.accounts[0].id])})`);assert.ok(fs.readFileSync(exportPath,'utf8').includes('fixture-secret-final'));assert.equal(fs.statSync(exportPath).mode&0o777,0o600)}finally{fs.rmSync(exportRoot,{recursive:true,force:true})}
      await run('document.querySelector(".temp-login-panel input[type=checkbox]").click()');await click('.temp-login-panel button','启动临时登录');await wait('(await window.manager.load()).tempLogin.phase==="waiting-login"')
      id=(await run('window.manager.load()')).tempLogin.id
      const native=JSON.parse(fs.readFileSync(join(home(id),'fixture-desktop.json'),'utf8'));assert.equal(native.nodeOptions,'');assert.equal(native.authCapture,'')
      // Closing the login modal cancels its owned client rather than orphaning it.
      await run('Array.from(document.querySelectorAll(".ant-modal-close")).find(el=>el.getClientRects().length).click()')
      await wait('(await window.manager.load()).tempLogin.phase==="cancelled"');assert.equal(fs.existsSync(home(id)),false);assert.equal((await run('window.manager.load()')).accounts.length,1)
      await click('.page-heading button','添加 ChatGPT 账号');await click('.temp-login-panel button','重试清理临时文件')
      assert.equal((await run('window.manager.load()')).tempLoginCleanup.failed.length,0);assert.ok(stats().encryptions>0)
      assert.equal(systemCalls.length,0,'File login must never access the system credential adapter')
      const selectStorage=async label=>{
        await wait('!!document.querySelector(".temp-login-storage .ant-select-selector")')
        await run('document.querySelector(".temp-login-storage .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
        await click('.ant-select-item-option',label)
      }
      const beginSystem=async mode=>{
        await click('.temp-login-panel button','启动临时登录');await wait('(await window.manager.load()).tempLogin.phase==="waiting-login"')
        const current=(await run('window.manager.load()')).tempLogin,folder=home(current.id),key=entryKey(folder)
        assert.equal(current.credentialStore,mode)
        assert.match(fs.readFileSync(join(folder,'config.toml'),'utf8'),new RegExp('cli_auth_credentials_store = "'+mode+'"'))
        ownedHomes.set(key,{pid:JSON.parse(fs.readFileSync(join(folder,'fixture-desktop.json'),'utf8')).pid})
        return {id:current.id,folder,key}
      }
      await selectStorage('系统钥匙串')
      let system=await beginSystem('keyring')
      fs.writeFileSync(join(system.folder,'auth.json'),auth('stale-file'))
      systemEntries.set(system.key,{raw:auth('system-final')})
      await wait('(await window.manager.load()).tempLogin.phase==="completed"')
      snapshot=await run('window.manager.load()');assert.equal(snapshot.accounts.length,1);assert.equal(snapshot.tempLogin.updated,true);assert.equal(snapshot.tempLogin.credentialSource,'keyring')
      assert.equal(systemCalls.filter(call=>call.key===system.key&&call.action==='read').length,1)
      assert.equal(systemEntries.has(system.key),false);assert.equal(systemEntries.has(unrelatedKey),true)
      assert.equal(JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault')))).accounts[0].credentials.refreshToken,'fixture-secret-system-final')
      assert.equal(fs.existsSync(system.folder),false)
      await wait('document.querySelector(".temp-login-panel").textContent.includes("已有账号的凭据已更新")')
      await capture('temp-login-system-completed.png')
      await selectStorage('自动（系统优先）');system=await beginSystem('auto')
      fs.writeFileSync(join(system.folder,'auth.json'),auth('auto-file-fallback'))
      await wait('(await window.manager.load()).tempLogin.phase==="completed"')
      assert.equal((await run('window.manager.load()')).tempLogin.credentialSource,'file')
      assert.equal(systemCalls.filter(call=>call.key===system.key&&call.action==='read').length,1)
      system=await beginSystem('auto');ownedHomes.get(system.key).denyRead=true
      fs.writeFileSync(join(system.folder,'auth.json'),auth('must-not-import'));systemEntries.set(system.key,{raw:auth('denied')})
      await wait('(await window.manager.load()).tempLogin.phase==="failed"')
      await wait('document.querySelector(".temp-login-panel").textContent.includes("未获授权")');await capture('temp-login-system-denied.png')
      for(let i=0;i<3;i++)await run('window.manager.load()')
      assert.equal(systemCalls.filter(call=>call.key===system.key&&call.action==='read').length,1)
      assert.equal(JSON.parse(safeStorage.decryptString(fs.readFileSync(join(directory,'state.vault')))).accounts[0].credentials.refreshToken,'fixture-secret-auto-file-fallback')
      assert.equal(systemEntries.has(system.key),false)
      await selectStorage('系统钥匙串');system=await beginSystem('keyring');ownedHomes.get(system.key).denyDelete=true
      await click('.temp-login-panel button','取消并清理');await wait('(await window.manager.load()).tempLogin.phase==="cancelled"')
      assert.equal(systemCalls.filter(call=>call.key===system.key&&call.action==='read').length,0)
      assert.equal(fs.existsSync(system.folder),true);assert.equal(fs.existsSync(join(canonical,'temp-login','markers',system.id+'.json')),true)
      await wait('document.querySelector(".temp-login-panel").textContent.includes("尚未清理完成")');await capture('temp-login-system-cleanup.png')
      ownedHomes.get(system.key).denyDelete=false;await click('.temp-login-panel button','重试清理临时文件')
      await wait(`(await window.manager.load()).tempLoginCleanup.removed.includes(${JSON.stringify(system.id)})`)
      assert.equal(fs.existsSync(system.folder),false);assert.equal((await run('window.manager.load()')).tempLoginCleanup.failed.length,0)
      assert.deepEqual([...systemEntries.keys()],[unrelatedKey]);assert.deepEqual(fs.readdirSync(join(canonical,'temp-login','markers')),[])
      console.log('Temporary login UI passed: file/native login and final rotation; system/auto dropdown and IPC; metadata polls, one post-exit read, system priority, missing-only file fallback, refused read does not loop, cancellation and failed-delete retry. AES-GCM and system commands are test substitutes; no OS keychain or real account.')
      clearTimeout(timer);app.quit()
    }catch(error){console.error(error);await capture('temp-login-failure.png').catch(()=>{});clearTimeout(timer);app.once('will-quit',()=>app.exit(1));app.quit()}
  })
})
require('../out/main/index.js')
