// Called only by the disposable native-client fixture in smoke-codex-ui.cjs.
const assert=require('node:assert/strict')
const {existsSync,readdirSync,readFileSync,realpathSync}=require('node:fs')
const {join,resolve}=require('node:path')
const {execFileSync}=require('node:child_process')
const {setTimeout:delay}=require('node:timers/promises')

function sessions(directory){
  const result=[]
  const visit=folder=>{if(!existsSync(folder))return;for(const item of readdirSync(folder,{withFileTypes:true})){
    const file=join(folder,item.name)
    if(item.isDirectory())visit(file)
    else if(item.isFile()&&item.name.endsWith('.jsonl')){
      try{const row=JSON.parse(readFileSync(file,'utf8').split('\n')[0]);if(row.type==='session_meta')result.push({file,...row.payload})}catch{/* A native write may still be in progress. */}
    }
  }}
  visit(join(directory,'sessions'));return result
}

module.exports=async({evaluate,capture,click,wait,send,directory,root,diagnostics=[]})=>{
  const baseline=process.env.CML_CODEX_UI_UNMODIFIED==='1'
  let source=sessions(directory).at(-1)
  assert.ok(source,'the fixture must have a durable source thread')
  const modes=process.env.CML_CODEX_FORK_MODE?[process.env.CML_CODEX_FORK_MODE]:['local','worktree']
  for(const mode of modes){
    const before=new Set(sessions(directory).map(s=>s.id))
    await click('Array.from(document.querySelectorAll("button")).filter(b=>/^(More actions|更多操作)$/.test(b.getAttribute("aria-label")||"")).at(-1)')
    const branch='Array.from(document.querySelectorAll("[role=menuitem]")).find(el=>/Branch in new chat|分支到新聊天/.test(el.innerText))'
    await wait(`!!(${branch})`);await click(branch)
    const option=`Array.from(document.querySelectorAll('[role=dialog][data-dialog-height-ready=true] [role=button]')).find(el=>el.getAttribute('aria-disabled')!=='true'&&${mode==='worktree'?'/Create a new worktree|创建新工作树/':'/Use this workspace|使用此工作空间/'}.test(el.innerText))`
    await wait(`!!(${option})`)
    await delay(500);await click(option)
    const deadline=Date.now()+60000
    let created
    while(!created){
      const body=await evaluate('document.body.innerText')
      if(body.includes('execution-config-loading')||JSON.stringify(diagnostics).includes('execution-config-loading')){
        await capture('codex-fork-blocked.png')
        assert.ok(baseline,'fork readiness still failed: '+body)
        console.log(JSON.stringify({stage:'fork-baseline-reproduced',mode,error:'execution-config-loading'}));return
      }
      assert.ok(Date.now()<deadline,'fork did not create a durable thread: '+body)
      created=sessions(directory).find(s=>!before.has(s.id))
      if(!created)await delay(200)
    }
    assert.ok(!baseline,'unmodified baseline unexpectedly succeeded; reevaluate compatibility')
    assert.equal(created.forked_from_id,source.id,'fork must retain native lineage')
    if(mode==='local')assert.equal(created.cwd,source.cwd)
    else{
      assert.notEqual(created.cwd,source.cwd)
      assert.ok(created.cwd.startsWith(root+'/'),'fixture worktree must remain inside its disposable root')
      const common=execFileSync('git',['rev-parse','--git-common-dir'],{cwd:created.cwd,encoding:'utf8'}).trim()
      assert.equal(realpathSync(resolve(created.cwd,common)),realpathSync(join(root,'.git')))
    }
    await wait('document.body.innerText.includes("Compatibility check complete.")&&!/正在创建聊天|Creating chat/.test(document.body.innerText)')
    if(mode==='worktree')await wait(`document.body.innerText.includes(${JSON.stringify(created.cwd)})&&!/正在创建聊天|Creating chat/.test(document.body.innerText)`)
    await delay(2000)
    const prompt=`Continue the ${mode} fork fixture. Reply with one sentence without tools.`
    await send(prompt)
    const transcript=readFileSync(created.file,'utf8')
    assert.ok(transcript.includes(prompt),'continued turn must be saved in the fork')
    await capture(`codex-fork-${mode}-continued.png`)
    console.log(JSON.stringify({stage:'fork-verified',mode,sourceId:source.id,forkId:created.id,cwd:created.cwd,continued:true}))
    source=created
  }
}
