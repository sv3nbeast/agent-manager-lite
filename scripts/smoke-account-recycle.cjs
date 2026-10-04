const {app,safeStorage,dialog}=require('electron')
const assert=require('node:assert/strict')
const {mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,statSync}=require('node:fs')
const {join,resolve,basename,sep}=require('node:path')
const {tmpdir}=require('node:os')
const {randomUUID}=require('node:crypto')
const directory=process.env.CML_TEST_DATA_DIR
assert.ok(directory&&realpathSync(directory).startsWith(realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.equal(existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
console.log('account recycle UI: ephemeral test codec (no OS keychain access)')
const accounts=Array.from({length:27},(_,i)=>({id:randomUUID(),kind:'api_key',name:'回收测试 '+String(i+1).padStart(2,'0'),baseUrl:'https://fixture.invalid/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'fast',note:'保留原备注',tags:['测试'],createdAt:1,credentials:{apiKey:'fixture-recycle-secret-'+i}}))
writeFileSync(join(directory,'state.vault'),safeStorage.encryptString(JSON.stringify({version:1,settings:{theme:'light',defaultTier:'follow',port:16321,refreshMinutes:0,launchAtLogin:false},groups:[],accounts})),{mode:0o600})
const output=resolve('.local/smoke-evidence');mkdirSync(output,{recursive:true})
// Exports must be outside the application's data directory, even in a fixture.
const exportRoot=require('node:fs').mkdtempSync(join(tmpdir(),'cml-recycled-export-')),exportPath=join(exportRoot,'accounts.json')
const cleanup=()=>require('node:fs').rmSync(exportRoot,{recursive:true,force:true})
let saveMode='success'
dialog.showSaveDialog=async()=>saveMode==='cancel'?{canceled:true}:({canceled:false,filePath:saveMode==='fail'?join(exportRoot,'missing','accounts.json'):exportPath})
const timer=setTimeout(()=>{console.error('Account recycle UI timed out');cleanup();app.exit(1)},85000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(code)
    const wait=async(expression)=>{const end=Date.now()+10000;while(!await run(expression)){if(Date.now()>end)throw new Error('UI timeout: '+expression);await new Promise(resolve=>setTimeout(resolve,30))}}
    const click=async(selector,text)=>{const expression=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`(()=>{const el=${expression};return el&&!el.disabled})()`);await run(expression+'.click()')}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await new Promise(resolve=>setTimeout(resolve,120));writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const count=number=>wait(`document.querySelector('.account-recycle .recycle-toolbar')?.textContent.includes(${JSON.stringify(number+' 个账号')})`)
    try{
      await run(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
      await wait(`!!document.querySelector('.provider-library')`)
      await run('document.getElementById("api-connections-tab").click()')
      await wait(`document.querySelectorAll('.account-card').length===24`);await click('.account-filters button','选择本页');await run(`document.querySelector('.pagination .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.account-card').length===3`);await click('.account-filters button','选择本页')
      await click('.toolbar button','移入回收站 27 项');await click('.ant-modal-confirm-btns button','移入回收站');await wait(`document.querySelectorAll('.account-card').length===0 && document.body.innerText.includes('还没有 API 连接')`)
      await click('.account-filters button','账号回收站');await count(27);assert.equal(await run(`document.querySelector('.account-recycle').textContent.includes('fixture-recycle-secret')`),false);await capture('account-recycle-list.png')
      await run(`document.querySelector('.account-recycle .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.account-recycle-table tr[data-row-key]').length===2`)
      const restoredId=await run(`document.querySelector('.account-recycle-table tr[data-row-key]').getAttribute('data-row-key')`)
      await click(`.account-recycle-table tr[data-row-key="${restoredId}"] button`,'恢复');await click('.ant-modal-footer button','确认恢复账号');await count(26)
      assert.equal((await run('window.manager.load()')).accounts.length,1)
      const originalId=await run(`document.querySelector('.account-recycle-table tr[data-row-key]').getAttribute('data-row-key')`)
      await click(`.account-recycle-table tr[data-row-key="${originalId}"] button`,'导出');await wait(`document.querySelector('.account-recycle')?.textContent.includes('导出账号完成')`)
      const exported=JSON.parse(readFileSync(exportPath,'utf8'));assert.equal(exported.length,1);assert.equal(exported[0].account_note,'保留原备注');assert.equal(statSync(exportPath).mode&0o777,0o600)
      // A concurrent import is separate from the UI's immutable recycle snapshot.
      await run(`window.manager.importAccounts(${JSON.stringify(JSON.stringify(exported))})`)
      await click(`.account-recycle-table tr[data-row-key="${originalId}"] button`,'恢复');await wait(`document.querySelector('.account-recycle .ant-alert-error')?.textContent.includes('相同账号已存在')`);await count(26)
      await click('.account-recycle .recycle-toolbar button','刷新');await count(26);await run(`document.querySelector('.account-recycle .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.account-recycle-table tr[data-row-key]').length===1`)
      await click('.ant-modal-footer button','清空回收站');await wait(`document.querySelector('.account-recycle-confirm')?.textContent.includes('26 个账号')`);await capture('account-recycle-confirm.png')
      const late=await run(`window.manager.addAccount({name:'确认之后移入',apiKey:'fixture-late-secret',baseUrl:'https://late.invalid/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'standard',note:'',tags:[]}).then(s=>s.accounts.find(a=>a.name==='确认之后移入').id)`)
      await run(`window.manager.deleteAccounts([${JSON.stringify(late)}])`)
      saveMode='cancel';await click('.ant-modal-footer button','导出并删除');await wait(`document.querySelector('.account-recycle')?.textContent.includes('已取消保存')`)
      saveMode='fail';await click('.ant-modal-footer button','导出并删除');await wait(`!!document.querySelector('.account-recycle .ant-alert-error')`)
      saveMode='success';await click('.ant-modal-footer button','导出并删除');await count(1);assert.equal(JSON.parse(readFileSync(exportPath,'utf8')).length,26);assert.equal((await run('window.manager.load()')).accounts.length,2)
      const vault=JSON.parse(safeStorage.decryptString(readFileSync(join(directory,'state.vault'))));assert.equal(vault.accountRecycle.length,1);assert.equal(vault.accountRecycle[0].account.id,late);assert.equal(vault.accounts.filter(a=>a.generation).length,1);await capture('account-recycle-completed.png')
      console.log('Account recycle UI passed: 27 accounts moved across pages, second-page restore, private credential export, reimport conflict, snapshot-bound empty-all from page two, cancelled/failed export preserves backups, successful export removes only the confirmed 26; later entry and live accounts preserved. No system keychain or provider request.')
      clearTimeout(timer);cleanup();window.destroy();app.exit(0)
    }catch(error){console.error(error);await capture('account-recycle-failure.png').catch(()=>{});clearTimeout(timer);cleanup();app.exit(1)}
  })
})
require('../out/main/index.js')
