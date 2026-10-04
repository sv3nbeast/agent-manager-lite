const {app,safeStorage,dialog,shell}=require('electron')
const {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,readdirSync}=require('node:fs')
const {join,resolve,sep,basename}=require('node:path')
const {tmpdir}=require('node:os')
const {randomUUID}=require('node:crypto')
const assert=require('node:assert/strict')
const directory=process.env.CML_TEST_DATA_DIR,codexBinary=process.env.CML_TEST_CODEX_BINARY
assert.ok(directory&&realpathSync(directory).startsWith(realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.ok(codexBinary&&existsSync(codexBinary),'Set CML_TEST_CODEX_BINARY for the real trash UI acceptance')
assert.equal(existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
console.log('trash UI: ephemeral test codec (no OS keychain access)')
const owned=join(directory,'clients','default'),external=join(directory,'external'),parent=randomUUID(),child=randomUUID(),grandchild=randomUUID(),other=randomUUID(),batchIds=Array.from({length:35},()=>randomUUID()),opened=[]
let pickerPath=external
function rollout(home,id,title,parentId,archive=false){
  const folder=archive?join(home,'archived_sessions'):join(home,'sessions','2026','10','01');mkdirSync(folder,{recursive:true})
  const path=join(folder,`rollout-2026-10-01T08-00-00-${id}.jsonl`),when='2026-10-01T08:00:00Z'
  const meta={type:'session_meta',timestamp:when,payload:{id,session_id:parentId?parent:id,parent_thread_id:parentId??null,timestamp:when,cwd:'/fixture/中文项目',originator:'codex_cli_rs',cli_version:'0.153.2',model_provider:'openai',source:parentId?{subagent:{thread_spawn:{parent_thread_id:parentId,depth:parentId===parent?1:2}}}:'cli'}}
  writeFileSync(path,[meta,{type:'event_msg',timestamp:when,payload:{type:'user_message',message:'Fixture '+title,images:[],local_images:[],text_elements:[]}},{type:'response_item',timestamp:when,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Fixture '+title}]}}].map(row=>JSON.stringify(row)+'\n').join(''))
  require('node:fs').appendFileSync(join(home,'session_index.jsonl'),JSON.stringify({id,thread_name:title,updated_at:when})+'\n');return path
}
const treeFiles=[rollout(owned,parent,'父会话 · 删除范围'),rollout(external,parent,'父会话 · 删除范围'),rollout(owned,child,'子会话 · 保留恢复',parent),rollout(external,child,'子会话 · 保留恢复',parent),rollout(owned,grandchild,'归档派生会话',child,true)],treeBefore=treeFiles.map(path=>readFileSync(path)),unrelated=rollout(external,other,'不相关会话'),unrelatedBefore=readFileSync(unrelated)
for(const [i,id] of batchIds.entries())rollout(external,id,'Batch '+String(i).padStart(2,'0'))
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pickerPath]});shell.showItemInFolder=path=>opened.push(path)
const output=resolve('.local/smoke-evidence');mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Trash UI smoke timed out');app.exit(1)},85000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=expression=>window.webContents.executeJavaScript(expression)
    const wait=async(expression,timeout=16000)=>{const end=Date.now()+timeout;while(!await run(expression)){if(Date.now()>end)throw new Error('UI condition timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,30))}}
    const click=async(selector,text)=>{const expression=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`(()=>{const el=${expression};return el&&!el.disabled})()`);await run(expression+'.click()')}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await new Promise(resolve=>setTimeout(resolve,120));writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const select=async(table,id)=>{await wait(`!!document.querySelector(${JSON.stringify(table+' tr[data-row-key="'+id+'"] input[type="checkbox"]')})`);await run(`document.querySelector(${JSON.stringify(table+' tr[data-row-key="'+id+'"] input[type="checkbox"]')}).click()`)}
    const chooseProgram=async(binary=codexBinary)=>{pickerPath=binary;await click('.trash-editor button','选择 CLI 程序');await wait(`document.querySelector('[aria-label="废纸篓索引程序"]').closest('.ant-select').textContent.includes(${JSON.stringify(basename(binary))})`)}
    const closeConfirmed=async()=>{await run(`document.querySelector('.trash-closed input').click()`);await click('.trash-actions button','预览范围');await wait(`!!document.querySelector('.trash-preview-table')`)}
    // The preview can render before the polling response changes preparing to
    // ready. Wait for an enabled, visible control as a user would have to.
    const confirm=async(text)=>{await wait(`(()=>{const el=document.querySelector('.trash-confirm input');return el?.getClientRects().length&&!el.disabled})()`);await run(`document.querySelector('.trash-confirm input').click()`);await wait(`document.querySelector('.trash-confirm input')?.checked`);await click('.trash-actions button',text);await wait(`!document.querySelector('.trash-editor')?.getClientRects().length`);await wait(`document.querySelector('.trash-progress')?.textContent.includes('已完成')||document.querySelector('.trash-progress')?.textContent.includes('未完成')`)}
    try{
      await click('.ant-menu-item','会话管理');await wait(`document.querySelector('.sessions-table')?.textContent.includes('父会话')`)
      await click('.sessions-panel .page-heading button','选择会话目录');await wait(`document.querySelector('.sessions-panel .toolbar')?.textContent.includes('38 个会话')`)
      // Restrict the visible list to the parent in one source; the destructive
      // preview must nevertheless find both homes and all descendant files.
      await run(`(()=>{const el=document.querySelector('[aria-label="会话标题搜索"]');el.value='父会话';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);await click('.session-filters button','应用筛选');await wait(`document.querySelectorAll('.sessions-table tr[data-row-key]').length===1`)
      await select('.sessions-table',parent);await click('.trash-toolbar button','移到废纸篓');await chooseProgram()
      assert.equal(await run(`Array.from(document.querySelectorAll('.trash-actions button')).find(el=>el.textContent==='预览范围').disabled`),true)
      await closeConfirmed();assert.equal(await run(`document.querySelector('.trash-preview').textContent.includes('3 个会话 · 5 份副本')`),true)
      await capture('sessions-trash-preview.png');await confirm('确认移到废纸篓')
      let state=await run('window.manager.sessionTrashState()');assert.equal(state.job.status,'completed',JSON.stringify(state));assert.equal(state.recoveries.length,0);for(const file of treeFiles)assert.equal(existsSync(file),false)
      await click('.trash-toolbar button','打开废纸篓');await wait(`document.querySelector('.trash-list')?.textContent.includes('3 个会话')`);await capture('sessions-trash-list.png')
      await select('.trash-table',child);await click('.trash-list button','恢复所选');await chooseProgram();await closeConfirmed();await confirm('确认恢复')
      await wait(`document.querySelector('.trash-list')?.textContent.includes('2 个会话')`);assert.deepEqual(readFileSync(treeFiles[2]),treeBefore[2]);assert.deepEqual(readFileSync(treeFiles[3]),treeBefore[3]);assert.equal(existsSync(treeFiles[0]),false);assert.equal(existsSync(treeFiles[4]),false)
      await capture('sessions-trash-restored-subset.png')
      await select('.trash-table',parent);await click('.trash-list button','永久删除所选');await click('.trash-actions button','预览范围');await wait(`!!document.querySelector('.trash-confirm')`);await confirm('确认永久删除');await wait(`document.querySelector('.trash-list')?.textContent.includes('1 个会话')`)
      await click('.trash-list button','清空废纸篓');await click('.trash-actions button','预览范围');await wait(`!!document.querySelector('.trash-confirm')`);await confirm('确认永久删除');await wait(`document.querySelector('.trash-list')?.textContent.includes('0 个会话')`)
      await run(`Array.from(document.querySelectorAll('.ant-modal-close')).find(el=>el.getClientRects().length).click()`)
      assert.deepEqual(readFileSync(unrelated),unrelatedBefore);assert.deepEqual(readFileSync(treeFiles[2]),treeBefore[2]);assert.equal(existsSync(treeFiles[0]),false)
      console.log('Trash UI: one filtered parent expands to five copies across two homes; real official cascade, subset restoration of both child copies, selective purge and empty preserve unrelated/restored files.')
      await run(`(()=>{const el=document.querySelector('[aria-label="会话标题搜索"]');el.value='Batch';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);await click('.session-filters button','应用筛选');await wait(`document.querySelector('.sessions-panel .toolbar')?.textContent.includes('35 个会话')`)
      await run(`document.querySelector('.sessions-table .ant-table-thead input[type="checkbox"]').click()`);await run(`document.querySelector('.sessions-panel .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.sessions-table tr[data-row-key]').length===10`);await run(`document.querySelector('.sessions-table .ant-table-thead input[type="checkbox"]').click()`)
      await click('.trash-toolbar button','移到废纸篓');await chooseProgram(realpathSync('/usr/bin/false'));await closeConfirmed();assert.equal(await run(`document.querySelector('.trash-preview').textContent.includes('35 个会话 · 35 份副本')`),true);await confirm('确认移到废纸篓')
      await wait(`document.querySelectorAll('.trash-recovery').length===1`);await capture('sessions-trash-recovery.png');await click('.trash-recovery button','打开备份位置');assert.ok(opened.at(-1).includes('session-trash'))
      await click('.trash-recovery button','继续删除或索引');await chooseProgram();await run(`document.querySelector('.trash-closed input').click()`);await click('.trash-actions button','开始处理');await wait(`!document.querySelector('.trash-editor')?.getClientRects().length`);await wait(`document.querySelectorAll('.trash-recovery').length===0`)
      await click('.trash-toolbar button','打开废纸篓');await wait(`document.querySelector('.trash-list')?.textContent.includes('35 个会话')`);assert.equal(await run(`document.querySelectorAll('.trash-table tr[data-row-key]').length`),25)
      await run(`document.querySelector('.trash-list .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.trash-table tr[data-row-key]').length===10`)
      await click('.trash-list button','清空废纸篓');await click('.trash-actions button','预览范围');await wait(`document.querySelector('.trash-preview')?.textContent.includes('35 个会话')`);await capture('sessions-trash-empty-confirm.png');await confirm('确认永久删除');await wait(`document.querySelector('.trash-list')?.textContent.includes('0 个会话')`)
      assert.deepEqual(readFileSync(unrelated),unrelatedBefore);assert.deepEqual(readFileSync(treeFiles[2]),treeBefore[2]);assert.equal(readdirSync(join(directory,'session-trash')).length,0)
      assert.equal(await run(`window.manager.previewSessionTrash({snapshotId:'invalid',sessionIds:[],applicationId:'invalid',clientsClosed:false}).then(()=>false,()=>true)`),true)
      assert.equal(await run(`window.manager.openSessionTrashBackup('../outside').then(()=>false,()=>true)`),true)
      console.log('Trash UI: 35 selected sessions across pages, actual failing CLI preserves backups/recovery, visible retry selects official CLI, pagination and explicit empty-all remove every backup; no model turn or keychain access.')
      clearTimeout(timer);window.destroy();app.exit(0)
    }catch(error){console.error(error);await capture('sessions-trash-failure.png').catch(()=>{});clearTimeout(timer);app.exit(1)}
  })
})
require('../out/main/index.js')
