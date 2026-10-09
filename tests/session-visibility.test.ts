import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,realpathSync} from 'node:fs'
import {createServer} from 'node:net'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionVisibilityRepair} from '../src/main/sessionVisibility'

function fixture(running=(..._:string[])=>false,plannedProvider:(id:string)=>string|undefined=()=>undefined,temporaryBase=tmpdir()){
  const root=realpathSync(mkdtempSync(join(temporaryBase,'cml-session-visibility-'))),store=new Store(join(root,'manager'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store)
  const home=join(root,'codex-home');mkdirSync(home);writeFileSync(join(home,'config.toml'),'model_provider = "relay"\n')
  const target=configs.register(home),repair=new SessionVisibilityRepair(configs,running,plannedProvider)
  return {root,home,target,repair,cleanup:()=>rmSync(root,{recursive:true,force:true})}
}

test('visibility repair follows the next instance connection instead of restored dormant configuration',async t=>{
  let provider='cml_instance'
  const f=fixture(()=>false,()=>provider);t.after(f.cleanup)
  const id=randomUUID(),path=join(f.home,'sessions/rollout.jsonl');mkdirSync(join(f.home,'sessions'))
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai'}})+'\n');makeDatabase(f.home,id,path)
  assert.equal((await f.repair.instances()).instances.find(value=>value.id===f.target.id)?.currentProvider,'cml_instance')
  const preview=await f.repair.preview({targetIds:[f.target.id]})
  assert.equal(preview.items[0].targetProvider,'cml_instance')
  provider='openai'
  await assert.rejects(f.repair.apply({ticket:preview.ticket,confirmed:true}),/变化/)
  assert.equal(JSON.parse(readFileSync(path,'utf8')).payload.model_provider,'openai')
  const next=await f.repair.preview({targetIds:[f.target.id]})
  assert.equal(next.items[0].targetProvider,'openai')
  await f.repair.apply({ticket:next.ticket,confirmed:true})
  const db=new DatabaseSync(join(f.home,'state_5.sqlite'))
  assert.equal((db.prepare('SELECT model_provider FROM threads WHERE id=?').get(id) as {model_provider:string}).model_provider,'openai');db.close()
})
function makeDatabase(home:string,id:string,rollout:string){
  const db=new DatabaseSync(join(home,'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, has_user_event INTEGER, first_user_message TEXT, thread_source TEXT, preview TEXT, archived INTEGER, rollout_path TEXT)')
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id,'openai',0,'hello','','',0,rollout)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),'relay',1,'ok','user','ok',0,rollout)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),'openai',0,'archived','','',1,rollout)
  db.close()
}

test('quick visibility repair previews, backs up and fixes provider metadata and referenced rollout',async t=>{
  const f=fixture();t.after(f.cleanup);const id=randomUUID(),relativePath='sessions/2026/10/02/rollout-test.jsonl',path=join(f.home,relativePath);mkdirSync(join(f.home,'sessions/2026/10/02'),{recursive:true});writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai',cwd:'/tmp'}})+'\n'+JSON.stringify({type:'event_msg',payload:{text:'keep'}})+'\n');makeDatabase(f.home,id,relativePath)
  const preview=await f.repair.preview({targetIds:[f.target.id]});assert.equal(preview.mode,'quick');assert.equal(preview.updatedSqliteRowCount,1);assert.equal(preview.changedRolloutFileCount,1);assert.equal(preview.items[0].targetProvider,'relay')
  const result=await f.repair.apply({ticket:preview.ticket,confirmed:true});assert.equal(result.updatedSqliteRowCount,1);assert.equal(result.changedRolloutFileCount,1);assert.equal(result.backupDirs.length,1);assert.ok(existsSync(join(result.backupDirs[0],'manifest.json')))
  const db=new DatabaseSync(join(f.home,'state_5.sqlite'));const row=db.prepare('SELECT model_provider,has_user_event,thread_source,preview FROM threads WHERE id=?').get(id) as Record<string,unknown>;db.close();assert.deepEqual({...row},{model_provider:'relay',has_user_event:1,thread_source:'user',preview:'hello'})
  const updated=JSON.parse(readFileSync(path,'utf8').split('\n')[0]) as {payload:{model_provider:string}};assert.equal(updated.payload.model_provider,'relay')
})

test('repair selection is bounded and running daemon protection blocks writes',async t=>{
  const f=fixture(id=>id===f.target.id);t.after(f.cleanup);const id=randomUUID(),relativePath='sessions/rollout.jsonl',path=join(f.home,relativePath);mkdirSync(join(f.home,'sessions'));writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai'}})+'\n');makeDatabase(f.home,id,relativePath)
  const preview=await f.repair.preview({targetIds:[f.target.id],sessionIds:[id]});assert.equal(preview.runningInstanceCount,1);assert.equal(preview.updatedSqliteRowCount,1);await assert.rejects(f.repair.apply({ticket:preview.ticket,confirmed:true}),/正在运行/)
  const db=new DatabaseSync(join(f.home,'state_5.sqlite'));assert.equal((db.prepare('SELECT model_provider FROM threads WHERE id=?').get(id) as {model_provider:string}).model_provider,'openai');db.close();f.repair.discard(preview.ticket)
})

test('a daemon started after preview blocks repair without changing its session files',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
  const f=fixture(()=>false,()=>undefined,'/tmp');t.after(f.cleanup)
  const id=randomUUID(),path=join(f.home,'sessions/rollout.jsonl')
  mkdirSync(join(f.home,'sessions'));writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai'}})+'\n');makeDatabase(f.home,id,path)
  const preview=await f.repair.preview({targetIds:[f.target.id]})
  assert.equal(preview.runningInstanceCount,0)
  const before=readFileSync(path),database=readFileSync(join(f.home,'state_5.sqlite'))
  mkdirSync(join(f.home,'ipc'));const server=createServer(socket=>socket.end())
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(f.home,'ipc/ipc.sock'),resolve)})
  await assert.rejects(f.repair.apply({ticket:preview.ticket,confirmed:true}),/正在运行/)
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(join(f.home,'state_5.sqlite')),database)
  assert.equal(readdirSync(f.home).some(value=>value.endsWith('-session-visibility-repair')),false)
  assert.equal(server.listening,true)
})

test('provider or managed runtime changes during backup block writes and keep the backup',async t=>{
  for(const change of ['provider','running']){
    const backedUp=()=>readdirSync(f.home).some(value=>value.endsWith('-session-visibility-repair')&&existsSync(join(f.home,value,'manifest.json')))
    const f=fixture(()=>change==='running'&&backedUp(),()=>change==='provider'&&backedUp()?'changed-provider':'relay');t.after(f.cleanup)
    const id=randomUUID(),path=join(f.home,'sessions/rollout.jsonl')
    mkdirSync(join(f.home,'sessions'));writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai'}})+'\n');makeDatabase(f.home,id,path)
    const preview=await f.repair.preview({targetIds:[f.target.id]})
    const before=readFileSync(path),database=readFileSync(join(f.home,'state_5.sqlite'))
    await assert.rejects(f.repair.apply({ticket:preview.ticket,confirmed:true}),change==='provider'?/变化/:/正在运行/)
    assert.equal(backedUp(),true)
    assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(join(f.home,'state_5.sqlite')),database)
  }
})

test('an external edit during backup is preserved when the final revision check rejects repair',async t=>{
  let edited=false,path=''
  const external='external edit after backup\n'
  const f=fixture(()=>false,()=>{
    if(!edited&&readdirSync(f.home).some(value=>value.endsWith('-session-visibility-repair')&&existsSync(join(f.home,value,'manifest.json')))){
      writeFileSync(path,external);edited=true
    }
    return 'relay'
  });t.after(f.cleanup)
  const id=randomUUID();path=join(f.home,'sessions/rollout.jsonl')
  mkdirSync(join(f.home,'sessions'));writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,model_provider:'openai'}})+'\n');makeDatabase(f.home,id,path)
  const preview=await f.repair.preview({targetIds:[f.target.id]})
  const database=readFileSync(join(f.home,'state_5.sqlite'))
  await assert.rejects(f.repair.apply({ticket:preview.ticket,confirmed:true}),/文件已变化/)
  assert.equal(edited,true);assert.equal(readFileSync(path,'utf8'),external)
  assert.deepEqual(readFileSync(join(f.home,'state_5.sqlite')),database)
})

test('malformed official state database is reported and never written',async t=>{
  const f=fixture();t.after(f.cleanup);writeFileSync(join(f.home,'state_5.sqlite'),'not sqlite');const preview=await f.repair.preview({targetIds:[f.target.id]});assert.equal(preview.updatedSqliteRowCount,0);assert.equal(preview.skippedSqliteFileCount,1);assert.ok(preview.warnings.some(value=>value.includes('SQLite')));f.repair.cancel(preview.ticket);assert.equal(readdirSync(f.home).some(value=>value.endsWith('-session-visibility-repair')),false)
})
