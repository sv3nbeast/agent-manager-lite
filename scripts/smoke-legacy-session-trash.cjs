const {app,safeStorage,dialog}=require('electron')
const assert=require('node:assert/strict')
const {mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync}=require('node:fs')
const {join,dirname,resolve,basename,sep}=require('node:path')
const {tmpdir}=require('node:os')
const {randomUUID}=require('node:crypto')
const directory=process.env.CML_TEST_DATA_DIR,binary=process.env.CML_TEST_CODEX_BINARY
assert.ok(directory&&realpathSync(directory).startsWith(realpathSync(tmpdir())+sep)&&basename(directory).startsWith('codex-manager-ui-'))
assert.ok(binary&&existsSync(binary),'Set CML_TEST_CODEX_BINARY for legacy trash restoration')
assert.equal(existsSync(join(directory,'state.vault')),false)
require('./test-vault.cjs').installTestVault(safeStorage)
console.log('legacy trash UI: ephemeral test codec (no OS keychain access)')
const owned=join(directory,'clients','default'),external=join(directory,'external'),root=join(directory,'cockpit-tools-codex-session-trash'),legacy=join(directory,'.Trash','cockpit-tools-codex-session-trash'),id=randomUUID(),legacyId=randomUUID(),fixtures=[]
mkdirSync(external,{recursive:true})
function backup(base,session,source,name,archive=false,deleted='2026-10-01T09:00:00Z'){
  const rel=(archive?'archived_sessions/':'sessions/2026/10/01/')+'rollout-2026-10-01T08-00-00-'+session+'.jsonl',folder=join(base,'20261001-090000',String(fixtures.length).padStart(4,'0')+'--'+session),path=join(folder,'files',rel),manifestPath=join(folder,'manifest.json'),when='2026-10-01T08:00:00Z'
  mkdirSync(dirname(path),{recursive:true})
  const raw=[{type:'session_meta',timestamp:when,payload:{id:session,timestamp:when,cwd:'/fixture/中文项目',source:'cli',model_provider:'openai',originator:'codex_cli_rs',cli_version:'0.153.2'}},{type:'event_msg',timestamp:when,payload:{type:'user_message',message:'Imported legacy fixture '+session,images:[],local_images:[],text_elements:[]}}].map(row=>JSON.stringify(row)+'\n').join('')
  const manifest={sessionId:session,title:session===id?'跨目录旧会话':session===legacyId?'旧版废纸篓会话':'历史备份 '+fixtures.length,cwd:'/fixture/中文项目',instanceId:name,instanceName:name,instanceRoot:source,originalRolloutPath:join(source,rel),relativeRolloutPath:rel,sessionIndexEntry:{id:session,thread_name:session===id?'跨目录旧会话':'历史备份 '+fixtures.length,unknown_field:'保留'},deletedAt:deleted}
  writeFileSync(path,raw);writeFileSync(manifestPath,JSON.stringify(manifest)+'\n');const record={path,raw,manifestPath,manifestRaw:readFileSync(manifestPath),rel};fixtures.push(record);return record
}
const first=backup(root,id,owned,'原受管目录',false,'2026-10-01T09:01:00Z'),second=backup(root,id,join(directory,'old-missing-home'),'已迁走目录',true,'2026-10-01T09:01:00Z')
for(let i=0;i<26;i++)backup(root,randomUUID(),owned,'原受管目录')
const old=backup(legacy,legacyId,join(directory,'old-legacy-home'),'旧版目录',true)
let picker=external
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[picker]})
const output=resolve('.local/smoke-evidence');mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Legacy trash UI timed out');app.exit(1)},85000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load',async()=>{
    const run=expression=>window.webContents.executeJavaScript(expression)
    const wait=async(expression,timeout=16000)=>{const end=Date.now()+timeout;while(!await run(expression)){if(Date.now()>end)throw new Error('UI condition timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,30))}}
    const click=async(selector,text)=>{const expression=`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))})`;await wait(`(()=>{const el=${expression};return el&&!el.disabled})()`);await run(expression+'.click()')}
    const capture=async name=>{await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await new Promise(resolve=>setTimeout(resolve,120));writeFileSync(join(output,name),(await window.webContents.capturePage()).toPNG())}
    const checkbox=async selector=>{await wait(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return el?.getClientRects().length&&!el.disabled})()`);await run(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(`document.querySelector(${JSON.stringify(selector)}).checked`)}
    const selectTarget=async(name,targetName='已选择的客户端')=>{
      const selector=`[aria-label="旧备份目标 ${name}"]`
      await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
      await run(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
      const listId=await run(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('input').getAttribute('aria-controls')`)
      const options=`Array.from(document.getElementById(${JSON.stringify(listId)})?.closest('.ant-select-dropdown').querySelectorAll('.ant-select-item-option')??[])`
      await wait(`${options}.some(el=>el.getClientRects().length&&el.textContent.includes(${JSON.stringify(targetName)}))`)
      await run(`${options}.find(el=>el.getClientRects().length&&el.textContent.includes(${JSON.stringify(targetName)})).click()`)
      await wait(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('.ant-select-selection-item')?.textContent.includes(${JSON.stringify(targetName)})`)
    }
    const beginImport=async(base,rows,name)=>{
      await click('.trash-toolbar button','导入旧废纸篓');picker=base;await click('.legacy-trash-editor button','选择旧废纸篓目录')
      await wait(`document.querySelector('.legacy-trash-editor')?.textContent.includes(${JSON.stringify(rows+' 个会话')})`)
      await checkbox('.legacy-trash-items .ant-table-thead input')
      if(rows>25){await run(`document.querySelector('.legacy-trash-editor .ant-pagination-item-2').click()`);await wait(`document.querySelectorAll('.legacy-trash-items tr[data-row-key]').length===${rows-25}`);await checkbox('.legacy-trash-items .ant-table-thead input')}
      assert.equal(await run(`Array.from(document.querySelectorAll('.ant-modal-footer button')).find(el=>el.getClientRects().length&&el.textContent==='预览导入').disabled`),true)
      if(rows>1)await selectTarget('原受管目录','默认 Codex 目录')
      await selectTarget(name);await click('.ant-modal-footer button','预览导入');await wait(`!!document.querySelector('.legacy-trash-preview')`);await run(`document.querySelector('.legacy-trash-preview').scrollIntoView({block:'end'})`)
    }
    const confirmImport=async()=>{await checkbox('.legacy-confirm input');await click('.ant-modal-footer button','确认导入备份');await wait(`!document.querySelector('.legacy-trash-editor')?.getClientRects().length`);await wait(`document.querySelector('.trash-progress')?.textContent.includes('已完成')`)}
    const closeModal=()=>run(`Array.from(document.querySelectorAll('.ant-modal-close')).find(el=>el.getClientRects().length).click()`)
    const verifySources=()=>{for(const file of fixtures){assert.equal(readFileSync(file.path,'utf8'),file.raw);assert.deepEqual(readFileSync(file.manifestPath),file.manifestRaw)}}
    try{
      await click('.ant-menu-item','会话管理');await click('.sessions-panel .page-heading button','选择会话目录')
      await beginImport(root,27,'已迁走目录');assert.equal(await run(`document.querySelector('.legacy-trash-preview').textContent.includes('28 份备份将导入')`),true);await capture('legacy-trash-preview.png');await confirmImport()
      let state=await run('window.manager.sessionTrashState()');assert.equal(state.job.importedCopies,28);assert.equal(state.recoveries.length,0);assert.equal(existsSync(join(owned,first.rel)),false);assert.equal(existsSync(join(external,second.rel)),false);verifySources()
      await beginImport(root,27,'已迁走目录');assert.equal(await run(`document.querySelector('.legacy-trash-preview').textContent.includes('0 份备份将导入 · 28 份已有备份跳过')`),true);await capture('legacy-trash-duplicates.png');await confirmImport()
      await click('.trash-toolbar button','打开废纸篓');await wait(`document.querySelector('.trash-list')?.textContent.includes('27 个会话')`);await capture('legacy-trash-imported.png')
      await checkbox(`.trash-table tr[data-row-key="${id}"] input`);await click('.trash-list button','恢复所选');picker=binary;await click('.trash-editor button','选择 CLI 程序');await checkbox('.trash-closed input');await click('.trash-actions button','预览范围');await wait(`!!document.querySelector('.trash-confirm')`);await checkbox('.trash-confirm input');await click('.trash-actions button','确认恢复');await wait(`document.querySelector('.trash-list')?.textContent.includes('26 个会话')`)
      assert.equal(readFileSync(join(owned,first.rel),'utf8'),first.raw);assert.equal(readFileSync(join(external,second.rel),'utf8'),second.raw);assert.equal(JSON.parse(readFileSync(join(owned,'session_index.jsonl'),'utf8')).unknown_field,'保留')
      await click('.trash-list button','清空废纸篓');await click('.trash-actions button','预览范围');await wait(`!!document.querySelector('.trash-confirm')`);await checkbox('.trash-confirm input');await click('.trash-actions button','确认永久删除');await wait(`document.querySelector('.trash-list')?.textContent.includes('0 个会话')`);await closeModal()
      await beginImport(legacy,1,'旧版目录');await confirmImport();await click('.trash-toolbar button','打开废纸篓');await wait(`document.querySelector('.trash-list')?.textContent.includes('1 个会话')`);assert.equal((await run('window.manager.listSessionTrash()')).items[0].id,legacyId);verifySources();assert.equal(existsSync(join(external,old.rel)),false)
      console.log('Legacy trash UI passed: 27 sessions/28 copies across pages, explicit remapping, repeated-import deduplication, original and archive restoration via actual CLI, preserved index fields, private purge and legacy .Trash import; old sources and unrelated restored files unchanged. No system keychain or model turn.')
      clearTimeout(timer);window.destroy();app.exit(0)
    }catch(error){console.error(error);await capture('legacy-trash-failure.png').catch(()=>{});clearTimeout(timer);app.exit(1)}
  })
})
require('../out/main/index.js')
