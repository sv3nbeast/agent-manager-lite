// Isolated Electron/IPC acceptance for the read-only native ~/.codex source.
// No client process is launched and no real home directory is inspected.
const {app,safeStorage,shell}=require('electron')
const fs=require('node:fs')
const {join,resolve,sep,basename}=require('node:path')
const {tmpdir}=require('node:os')
const {randomUUID}=require('node:crypto')
const assert=require('node:assert/strict')
const dataDirectory=process.env.CML_TEST_DATA_DIR,home=process.env.CML_TEST_DEFAULT_CODEX_DIRECTORY
assert.ok(dataDirectory&&fs.realpathSync(dataDirectory).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(dataDirectory).startsWith('codex-manager-ui-'))
assert.ok(home&&fs.realpathSync(home).startsWith(fs.realpathSync(tmpdir())+sep)&&basename(home).startsWith('codex-manager-default-codex-'))
assert.equal(fs.existsSync(join(dataDirectory,'state.vault')),false)
const stats=require('./test-vault.cjs').installTestVault(safeStorage)
const id=randomUUID(),file=join(home,'sessions','2026','10','20','rollout-'+id+'.jsonl')
fs.mkdirSync(join(home,'sessions','2026','10','20'),{recursive:true})
const phrase='已跳过该临时文件并继续',cwd='/fixture/other-project'
fs.writeFileSync(file,[
  {type:'session_meta',timestamp:'2026-10-20T15:30:37.000Z',payload:{id,cwd,originator:'codex_cli_rs',cli_version:'0.162.0',source:'cli',model_provider:'openai'}},
  {type:'event_msg',timestamp:'2026-10-20T15:31:00.000Z',payload:{type:'user_message',message:'迁移遇到临时文件冲突，用户确认忽略后继续。'}},
  {type:'event_msg',timestamp:'2026-10-20T15:31:30.000Z',payload:{type:'user_message',message:phrase}},
].map(value=>JSON.stringify(value)).join('\n')+'\n')
const original=fs.readFileSync(file),opened=[]
shell.showItemInFolder=path=>opened.push({action:'location',path})
shell.openPath=async path=>{opened.push({action:'file',path});return ''}
globalThis.fetch=async()=>{throw new Error('Default Codex session smoke forbids external requests')}
const output=resolve('.local/default-codex-sessions');fs.mkdirSync(output,{recursive:true})
const timer=setTimeout(()=>{console.error('Default Codex session smoke exceeded 60 seconds');app.exit(1)},60_000)
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false);window.setContentSize(1440,1000)
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript('(async()=>{try{return {value:await ('+code+')};}catch(error){return {error:String(error.stack??error)};}})()')
    const evalValue=async code=>{const result=await run(code);if(result.error)throw new Error(result.error+'\nRenderer expression: '+code);return result.value}
    const wait=async code=>{const until=Date.now()+10_000;while(!await evalValue(code)){assert.ok(Date.now()<until,'UI timeout: '+code);await new Promise(resolve=>setTimeout(resolve,30))}}
    const click=async(selector,label)=>{const query='Array.from(document.querySelectorAll('+JSON.stringify(selector)+')).find(el=>el.getClientRects().length&&el.textContent.replace(/\\s/g,\'\')==='+JSON.stringify(label.replace(/\s/g,''))+')';await wait('!!('+query+')&&!('+query+').disabled');await evalValue('('+query+').click()')}
    try{
      await click('.ant-menu-item','会话管理')
      await wait('document.querySelector(\'.sessions-table\')?.textContent.includes('+JSON.stringify(cwd)+')')
      const row='Array.from(document.querySelectorAll(\'.sessions-table tr[data-row-key]\')).find(el=>el.textContent.includes('+JSON.stringify(id)+'))'
      assert.equal(await evalValue('!!('+row+')'),true)
      assert.equal(await evalValue('('+row+').textContent.includes(\'本机默认 Codex 会话目录\')'),true)
      await evalValue('(()=>{const select=document.querySelector(\'[aria-label="会话来源"]\');select.closest(\'.ant-select\').querySelector(\'.ant-select-selector\').dispatchEvent(new MouseEvent(\'mousedown\',{bubbles:true}));return true})()')
      await wait('Array.from(document.querySelectorAll(\'.ant-select-item-option\')).some(el=>el.getClientRects().length&&el.textContent.includes(\'本机默认 Codex 会话目录\'))')
      assert.equal(await evalValue('Array.from(document.querySelectorAll(\'.ant-select-item-option\')).some(el=>el.getClientRects().length&&el.textContent.includes(\'本机默认 Codex 会话目录\')&&el.textContent.includes(\'1 个会话\'))'),true)
      await evalValue('Array.from(document.querySelectorAll(\'.ant-select-item-option\')).find(el=>el.getClientRects().length&&el.textContent.includes(\'本机默认 Codex 会话目录\')).click()')
      await evalValue('(()=>{const el=document.querySelector(\'[aria-label="会话内容搜索"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(phrase)+');el.dispatchEvent(new Event("input",{bubbles:true}));return true})()')
      await click('.session-filters button','应用筛选')
      await wait('!!('+row+')&&document.querySelector(\'.sessions-panel .toolbar\')?.textContent.includes(\'1 个会话\')')
      assert.equal(await evalValue('document.querySelector(\'[aria-label="会话内容搜索"]\').value'),phrase)
      assert.equal(await evalValue('!!('+row+')'),true,'the conversation must remain visible when filtering by its supplied text')
      await click('.sessions-table button','打开会话文件')
      const openedUntil=Date.now()+5000
      while(!opened.length&&Date.now()<openedUntil)await new Promise(resolve=>setTimeout(resolve,25))
      assert.equal(opened.length,1,'opening a default session calls the OS file opener')
      assert.deepEqual(opened,[{action:'file',path:file}])
      assert.equal(await evalValue('('+row+').querySelector(\'input[type="checkbox"]\').disabled'),true,'read-only source cannot be selected for bulk mutation')
      assert.deepEqual(fs.readFileSync(file),original)
      fs.writeFileSync(join(output,'validation.json'),JSON.stringify({passed:true,source:'temporary ~/.codex fixture',sessionFound:true,contentSearch:true,opened:file,sourceUnchanged:true,noClientLaunch:true},null,2))
      console.log('Default Codex session UI smoke passed: injected temporary home, source filter, exact text search, read-only open, unchanged rollout, no client launch or user data.')
      clearTimeout(timer);window.destroy();app.exit(0)
    }catch(error){console.error(error);clearTimeout(timer);app.exit(1)}
  })
})
require('../out/main/index.js')
