import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionVisibilityRepair} from '../src/main/sessionVisibility'

function fixture(running=(..._:string[])=>false){
  const root=mkdtempSync(join(tmpdir(),'cml-session-visibility-')),store=new Store(join(root,'manager'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store)
  const home=join(root,'codex-home');mkdirSync(home);writeFileSync(join(home,'config.toml'),'model_provider = "relay"\n')
  const target=configs.register(home),repair=new SessionVisibilityRepair(configs,running)
  return {root,home,target,repair,cleanup:()=>rmSync(root,{recursive:true,force:true})}
}
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

test('malformed official state database is reported and never written',async t=>{
  const f=fixture();t.after(f.cleanup);writeFileSync(join(f.home,'state_5.sqlite'),'not sqlite');const preview=await f.repair.preview({targetIds:[f.target.id]});assert.equal(preview.updatedSqliteRowCount,0);assert.equal(preview.skippedSqliteFileCount,1);assert.ok(preview.warnings.some(value=>value.includes('SQLite')));f.repair.cancel(preview.ticket);assert.equal(readdirSync(f.home).some(value=>value.endsWith('-session-visibility-repair')),false)
})
