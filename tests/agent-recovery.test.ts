import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/main/store'
import { AgentIdentityService } from '../src/main/agentIdentity'
import { recoverAgentTasks, writeAgentRecovery } from '../src/main/agentRecovery'
import { parseAccountImport, importParsedAccounts } from '../src/main/accounts'

function fixture(t: {after(fn: () => void):void}) {
  const root = mkdtempSync(join(tmpdir(),'cml-recovery-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  let fail = false
  const codec = {encrypt:(value:string) => {if(fail)throw new Error('fixture vault unavailable');return Buffer.from(value)},decrypt:(value:Buffer)=>value.toString()}
  const store = new Store(join(root,'vault'),codec)
  const account = parseAccountImport(JSON.stringify({agent_identity:{
    agent_runtime_id:'fixture-runtime',agent_private_key:generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),
    task_id:'task-old',account_id:'fixture-org',chatgpt_user_id:'fixture-user',chatgpt_account_is_fedramp:false
  }})).accounts[0]
  importParsedAccounts(store,[account])
  const runtime = join(root,'runtime'), directory = join(runtime,'gateway-fixture')
  mkdirSync(join(directory,'auth'),{recursive:true,mode:0o700})
  const path = join(directory,'auth',`${account.id}.json`)
  const writeTask = (task:string) => writeFileSync(path,JSON.stringify({auth_mode:'agentIdentity',...account.credentials.agentIdentity,task_id:task}),{mode:0o600})
  writeTask('task-recovered')
  writeAgentRecovery(directory,account.id,account.credentials.agentIdentity!,12345)
  const service = new AgentIdentityService(store,async()=>{throw new Error('must not decrypt')})
  return {root,runtime,directory,path,store,codec,account,service,writeTask,setFailure:(value:boolean)=>{fail=value}}
}

test('restart recovery adopts a task from a dead owned runtime before removing credentials', t => {
  const f = fixture(t)
  const reopened = new Store(f.store.directory,f.codec)
  const service = new AgentIdentityService(reopened,async()=>{throw new Error('offline recovery')})
  assert.deepEqual(recoverAgentTasks(f.runtime,reopened,service,{isAlive:()=>false}),{recovered:1,retained:0})
  assert.equal(new Store(f.store.directory,f.codec).read().accounts[0].credentials.agentIdentity!.task_id,'task-recovered')
  assert.equal(existsSync(f.directory),false)
  assert.deepEqual(recoverAgentTasks(f.runtime,reopened,service),{recovered:0,retained:0})
})

test('a shared pool recovers each Agent Identity and retains the whole directory until all markers are valid',t=>{
  const f=fixture(t),second=structuredClone(f.account)
  second.id=randomUUID();second.credentials.agentIdentity!.agent_runtime_id='second-runtime'
  f.store.transaction(s=>{s.accounts.push(second)})
  rmSync(join(f.directory,'agent-recovery.json'))
  writeAgentRecovery(f.directory,f.account.id,f.account.credentials.agentIdentity!,12345,true)
  writeAgentRecovery(f.directory,second.id,second.credentials.agentIdentity!,12345,true)
  const secondPath=join(f.directory,'auth',`${second.id}.json`)
  writeFileSync(secondPath,JSON.stringify({auth_mode:'agentIdentity',...second.credentials.agentIdentity,task_id:'second-recovered'}))
  const damaged=join(f.directory,`agent-recovery-${second.id}.json`),original=readFileSync(damaged)
  writeFileSync(damaged,'corrupt')
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:1,retained:1})
  assert.equal(existsSync(f.directory),true)
  assert.equal(f.store.read().accounts.find(a=>a.id===f.account.id)!.credentials.agentIdentity!.task_id,'task-recovered')
  writeFileSync(damaged,original)
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:1,retained:0})
  assert.equal(f.store.read().accounts.find(a=>a.id===second.id)!.credentials.agentIdentity!.task_id,'second-recovered')
  assert.equal(existsSync(f.directory),false)
})

test('restart recovery retains live/unknown/corrupt files and retries a failed vault commit', t => {
  const f=fixture(t)
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>true}),{recovered:0,retained:1})
  assert.equal(f.store.read().accounts[0].credentials.agentIdentity!.task_id,'task-old')
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{activeDirectory:f.directory}),{recovered:0,retained:0})
  f.setFailure(true)
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:0,retained:1})
  assert.equal(existsSync(f.path),true)
  f.setFailure(false)
  const marker=join(f.directory,'agent-recovery.json'),original=readFileSync(marker,'utf8')
  writeFileSync(marker,original.replace('fixture', 'tampered')+'trailing')
  assert.equal(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}).retained,1)
  writeFileSync(marker,original)
  assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:1,retained:0})
})

test('old runtime observations cannot overwrite newer credentials or resurrect a deleted account', t => {
  for(const mode of ['new-task','new-key','deleted']) {
    const f=fixture(t)
    f.store.transaction(state=>{
      if(mode==='deleted')state.accounts=[]
      else if(mode==='new-key')state.accounts[0].credentials.agentIdentity!.agent_runtime_id='new-runtime'
      else state.accounts[0].credentials.agentIdentity!.task_id='task-newer'
    })
    assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:0,retained:0})
    assert.equal(existsSync(f.directory),false)
    if(mode==='deleted')assert.equal(f.store.read().accounts.length,0)
    else assert.equal(f.store.read().accounts[0].credentials.agentIdentity![mode==='new-key'?'agent_runtime_id':'task_id'],mode==='new-key'?'new-runtime':'task-newer')
  }
})

test('recovery refuses changed identities, path traversal, symlinks, and oversized metadata', t => {
  for(const mode of ['identity','traversal','link','large','auth-link']) {
    const f=fixture(t)
    if(mode==='identity')writeFileSync(f.path,JSON.stringify({auth_mode:'agentIdentity',...f.account.credentials.agentIdentity,chatgpt_user_id:'other-user'}))
    if(mode==='traversal') {
      const path=join(f.directory,'agent-recovery.json'), marker=JSON.parse(readFileSync(path,'utf8'))
      marker.accountId='../outside';writeFileSync(path,JSON.stringify(marker))
    }
    if(mode==='link') {const target=join(f.root,'outside.json');writeFileSync(target,readFileSync(f.path));rmSync(f.path);symlinkSync(target,f.path)}
    if(mode==='auth-link'){rmSync(join(f.directory,'auth'),{recursive:true});mkdirSync(join(f.root,'outside'));symlinkSync(join(f.root,'outside'),join(f.directory,'auth'))}
    if(mode==='large')writeFileSync(join(f.directory,'agent-recovery.json'),'x'.repeat(65537))
    assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:0,retained:1})
    assert.equal(existsSync(f.directory),true)
    assert.equal(f.store.read().accounts[0].credentials.agentIdentity!.task_id,'task-old')
  }
})

test('corrupt runtime roots and special recovery files cannot block desktop startup', t => {
  const f=fixture(t)
  const regular=join(f.root,'regular');writeFileSync(regular,'not a directory')
  assert.deepEqual(recoverAgentTasks(regular,f.store,f.service),{recovered:0,retained:1})
  if(process.platform!=='win32') {
    rmSync(f.path);execFileSync('mkfifo',[f.path])
    assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service,{isAlive:()=>false}),{recovered:0,retained:1})
  }
})

test('a real source-built sidecar exits after its parent is killed and its recovered task survives restart', async t => {
  const {spawn} = await import('node:child_process')
  const {createInterface} = await import('node:readline')
  const {setTimeout:delay} = await import('node:timers/promises')
  const {resolve} = await import('node:path')
  const {renameSync} = await import('node:fs')
  const f=fixture(t)
  rmSync(f.directory,{recursive:true,force:true})
  const child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/agent-crash.ts'),f.root],{stdio:['ignore','pipe','ignore']})
  let sidecarPid:number|undefined
  try {
    const directory = await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('fixture startup timeout')),10000)
      const lines=createInterface({input:child.stdout})
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('fixture exited before ready'))})
      lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line).directory)})
    })
    assert.ok(directory.startsWith(join(f.root,'runtime','gateway-')))
    const marker=JSON.parse(readFileSync(join(directory,'agent-recovery.json'),'utf8'))
    sidecarPid=marker.sidecarPid
    assert.equal(marker.ownerPid,child.pid)
    assert.ok(sidecarPid)
    assert.deepEqual(recoverAgentTasks(f.runtime,f.store,f.service),{recovered:0,retained:1})
    const path=join(directory,'auth',`${f.account.id}.json`), payload=JSON.parse(readFileSync(path,'utf8'))
    writeFileSync(path+'.test',JSON.stringify({...payload,task_id:'task-after-crash'}),{mode:0o600});renameSync(path+'.test',path)
    const closed=new Promise(resolve=>child.once('close',resolve))
    child.kill('SIGKILL');await closed
    const end=Date.now()+10000
    while(true) {
      try{process.kill(sidecarPid!,0)}catch{break}
      if(Date.now()>end)throw new Error('sidecar outlived parent monitor')
      await delay(50)
    }
    const reopened=new Store(f.store.directory,f.codec), service=new AgentIdentityService(reopened,async()=>{throw new Error('offline')})
    assert.deepEqual(recoverAgentTasks(f.runtime,reopened,service),{recovered:1,retained:0})
    assert.equal(reopened.read().accounts[0].credentials.agentIdentity!.task_id,'task-after-crash')
    assert.equal(existsSync(directory),false)
  } finally {
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')
    if(sidecarPid){try{process.kill(sidecarPid,'SIGKILL')}catch{}}
  }
})
