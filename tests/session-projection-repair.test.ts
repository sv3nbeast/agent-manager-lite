import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,existsSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {repairSessionProjection} from '../src/main/sessionProjectionRepair'

const schema=`CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER NOT NULL,next_rollout_ordinal INTEGER NOT NULL);
CREATE TABLE thread_turns(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,status TEXT NOT NULL,error_json TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,first_user_item_id TEXT,final_agent_item_id TEXT,rollout_byte_offset INTEGER,rollout_end_ordinal INTEGER,rollout_end_byte_offset INTEGER,PRIMARY KEY(thread_id,turn_id));
CREATE TABLE thread_items(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,item_json TEXT NOT NULL,item_type TEXT NOT NULL,updated_at_ordinal INTEGER NOT NULL DEFAULT 0,started_at_ms INTEGER,completed_at_ms INTEGER,PRIMARY KEY(thread_id,turn_id,item_id));
CREATE TABLE thread_realtime_items(thread_id TEXT NOT NULL,item_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,item_type TEXT NOT NULL,item_json TEXT NOT NULL,PRIMARY KEY(thread_id,item_id));`
function projection(path:string,ids:string[],itemsPerThread=1){
  const db=new DatabaseSync(path);db.exec(schema)
  const state=db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)'),turn=db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),item=db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)')
  for(const id of ids){state.run(id,0,itemsPerThread);turn.run(id,'turn-'+id,0,'completed',null,1,2,1,'user-'+id,'agent-'+id,0,0,0);for(let i=0;i<itemsPerThread;i++)item.run(id,'turn-'+id,'item-'+id+'-'+i,i,1,'{}','message',i,null,null)}
  db.close()
}
function state(path:string,ids:string[]){const db=new DatabaseSync(path);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY)');const insert=db.prepare('INSERT INTO threads VALUES(?)');for(const id of ids)insert.run(id);db.close()}

function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync('/tmp/aml-projection-')),home=join(root,'home'),trash=join(root,'trash'),archived=join(trash,'archived','home')
  mkdirSync(home,{recursive:true});mkdirSync(archived,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,home,trash,archived,target:join(home,'thread_history_1.sqlite'),source:join(archived,'thread_history_1.sqlite')}
}

test('restores omitted history projection rows from the matching archived instance and preserves a backup',async t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-projection-repair-')),home=join(root,'home'),trash=join(root,'instance-trash'),archived=join(trash,'archived-copy','home');mkdirSync(home,{recursive:true});mkdirSync(archived,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}))
  const ids=['a','b','c','d'],current=join(home,'thread_history_1.sqlite'),source=join(archived,'thread_history_1.sqlite');projection(current,['a']);projection(source,ids,2);state(join(home,'state_5.sqlite'),ids);state(join(archived,'state_5.sqlite'),ids)
  const result=await repairSessionProjection(home,trash)
  assert.ok(result);assert.equal(result.before,1);assert.equal(result.after,4);assert.equal(result.inserted,3)
  const db=new DatabaseSync(current,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS count FROM thread_history_projection_state').get()!.count,4);assert.equal(db.prepare('SELECT count(*) AS count FROM thread_items').get()!.count,8);db.close()
  assert.equal(readFileSync(join(home,'.session-projection-recovery','manifest.json'),'utf8').includes('archived-copy'),true)
  const backup=new DatabaseSync(result.backup,{readOnly:true});assert.equal(backup.prepare('SELECT count(*) AS count FROM thread_history_projection_state').get()!.count,1);backup.close()
})

test('does not merge an unrelated archive when state thread overlap is too small',async t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-projection-noop-')),home=join(root,'home'),trash=join(root,'instance-trash'),archived=join(trash,'unrelated','home');mkdirSync(home,{recursive:true});mkdirSync(archived,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}))
  projection(join(home,'thread_history_1.sqlite'),['a']);projection(join(archived,'thread_history_1.sqlite'),['z','y','x']);state(join(home,'state_5.sqlite'),['a','b','c','d']);state(join(archived,'state_5.sqlite'),['z','y','x']);
  assert.equal(await repairSessionProjection(home,trash),undefined)
})

test('restores only threads already in the target index, preserves newer rows and is idempotent',async t=>{
  const f=fixture(t),ids=['a','b','c'],sourceIds=[...ids,'unrelated-1','unrelated-2']
  projection(f.target,['a']);projection(f.source,sourceIds,2)
  state(join(f.home,'state_5.sqlite'),ids);state(join(f.archived,'state_5.sqlite'),sourceIds)
  const existing=new DatabaseSync(f.target);existing.prepare('UPDATE thread_items SET item_json=? WHERE thread_id=?').run('{"text":"newer target data"}','a');existing.close()
  const result=await repairSessionProjection(f.home,f.trash);assert.ok(result);assert.equal(result.inserted,2);assert.equal(result.after,3)
  const repaired=new DatabaseSync(f.target,{readOnly:true})
  try{
    assert.deepEqual(repaired.prepare('SELECT thread_id FROM thread_history_projection_state ORDER BY thread_id').all().map(row=>row.thread_id),ids)
    assert.equal(repaired.prepare('SELECT count(*) AS count FROM thread_items').get()!.count,6)
    assert.equal(repaired.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND item_id=?').get('a','item-a-0')!.item_json,'{"text":"newer target data"}')
    assert.equal(repaired.prepare('SELECT count(*) AS count FROM thread_turns WHERE thread_id LIKE ?').get('unrelated-%')!.count,0)
  }finally{repaired.close()}
  assert.equal(await repairSessionProjection(f.home,f.trash),undefined)
  assert.equal(readdirSync(join(f.home,'.session-projection-recovery')).filter(name=>name.endsWith('.sqlite')).length,1)
})

test('a schema mismatch rolls back all earlier inserts and retains the original backup',async t=>{
  const f=fixture(t),ids=['a','b','c','d']
  projection(f.target,['a']);projection(f.source,ids)
  state(join(f.home,'state_5.sqlite'),ids);state(join(f.archived,'state_5.sqlite'),ids)
  const incompatible=new DatabaseSync(f.source);incompatible.exec('ALTER TABLE thread_items ADD COLUMN future_schema TEXT');incompatible.close()
  await assert.rejects(repairSessionProjection(f.home,f.trash),/表结构不一致/)
  const current=new DatabaseSync(f.target,{readOnly:true})
  try{for(const table of ['thread_history_projection_state','thread_turns','thread_items'])assert.equal(current.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,1)}finally{current.close()}
  const backupFile=readdirSync(join(f.home,'.session-projection-recovery')).find(name=>name.endsWith('.sqlite'));assert.ok(backupFile)
  const backup=new DatabaseSync(join(f.home,'.session-projection-recovery',backupFile),{readOnly:true})
  try{assert.equal(backup.prepare('SELECT count(*) AS count FROM thread_history_projection_state').get()!.count,1)}finally{backup.close()}
})

test('a live or uninspectable client prevents projection recovery without writing a backup',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
  for(const live of [true,false]){
    const f=fixture(t),ids=['a','b','c','d'];projection(f.target,['a']);projection(f.source,ids)
    state(join(f.home,'state_5.sqlite'),ids);state(join(f.archived,'state_5.sqlite'),ids)
    const ipc=join(f.home,'ipc');mkdirSync(ipc);const path=join(ipc,'ipc.sock')
    if(live){
      const server=createServer(socket=>socket.destroy())
      t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)})
    }else writeFileSync(path,'invalid socket')
    const before=readFileSync(f.target)
    assert.equal(await repairSessionProjection(f.home,f.trash),undefined)
    assert.equal(existsSync(join(f.home,'.session-projection-recovery')),false)
    assert.deepEqual(readFileSync(f.target),before)
  }
})
