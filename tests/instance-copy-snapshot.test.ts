import test from 'node:test'
import assert from 'node:assert/strict'
import {appendFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync,renameSync,symlinkSync,existsSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {scanInstanceHome,copyInstanceHome,relocateCopiedProfile} from '../src/main/instanceCopy'
import {scanSessionHome} from '../src/main/instanceSessionCopy'
import {copySavedInstanceHome,normalizeSessionDatabaseCopy} from '../src/main/instanceCopySnapshot'

const supported=process.platform==='darwin'
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-history-snapshot-'))),source=join(root,'source'),target=join(root,'target')
  mkdirSync(source);mkdirSync(join(source,'sessions'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,source,target,signal:new AbortController().signal}
}
const meta=JSON.stringify({type:'session_meta',payload:{id:'thread',model_provider:'original'}})+'\n'
const line=JSON.stringify({type:'response_item',payload:{text:'完整内容 汉字 😀'}})+'\n'

test('session-only inventory ignores large configuration, skills, caches and desktop state',async t=>{
  const f=fixture(t)
  mkdirSync(join(f.source,'skills'));mkdirSync(join(f.source,'cache'));mkdirSync(join(f.source,'desktop-state'))
  writeFileSync(join(f.source,'config.toml'),'model="source"\n[desktop]\nlocaleOverride="en-US"\n')
  writeFileSync(join(f.source,'skills','tool.js'),'x'.repeat(2*1024*1024))
  writeFileSync(join(f.source,'cache','large.bin'),'x'.repeat(3*1024*1024))
  writeFileSync(join(f.source,'desktop-state','window.json'),'x'.repeat(1024))
  writeFileSync(join(f.source,'.codex-global-state.json'),JSON.stringify({'local-projects':{project:{id:'project',name:'中文项目',rootPaths:['/fixture/project']}},unrelated:'drop'}))
  writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),meta+line)
  const manifest=await scanSessionHome(f.source,f.signal)
  assert.equal(manifest.files,2)
  assert.ok(manifest.bytes<1024*1024)
  assert.deepEqual(manifest.entries.filter(entry=>!entry.directory).map(entry=>entry.relative).sort(),['.codex-global-state.json','sessions/rollout-thread.jsonl'])
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.equal(existsSync(join(f.target,'config.toml')),false)
  assert.equal(existsSync(join(f.target,'skills')),false)
  assert.equal(existsSync(join(f.target,'cache')),false)
  assert.equal(readFileSync(join(f.target,'sessions','rollout-thread.jsonl'),'utf8'),meta+line)
  assert.deepEqual(JSON.parse(readFileSync(join(f.target,'.codex-global-state.json'),'utf8')),{'local-projects':{project:{id:'project',name:'中文项目',rootPaths:['/fixture/project']}}})
  assert.equal(saved.files,2)
})

test('session-only inventory refuses a database configured outside the selected home',async t=>{
  const f=fixture(t),outside=join(f.root,'outside-db')
  mkdirSync(outside);writeFileSync(join(f.source,'config.toml'),`sqlite_home = ${JSON.stringify(outside)}\n`)
  await assert.rejects(scanSessionHome(f.source,f.signal),/目录外/)
})

test('session-only snapshot carries the thread history projection with the state index',{skip:!supported},async t=>{
  const f=fixture(t),statePath=join(f.source,'state_5.sqlite'),historyPath=join(f.source,'thread_history_1.sqlite')
  writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),meta+line)
  const state=new DatabaseSync(statePath)
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY)')
  state.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread',join(f.source,'sessions','rollout-thread.jsonl'),'original')
  const history=new DatabaseSync(historyPath)
  history.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,thread_id TEXT,payload TEXT)')
  history.prepare('INSERT INTO items(thread_id,payload) VALUES(?,?)').run('thread','历史投影')
  t.after(()=>{state.close();history.close()})
  const manifest=await scanSessionHome(f.source,f.signal)
  assert.deepEqual(manifest.entries.filter(entry=>!entry.directory).map(entry=>entry.relative).sort(),['sessions/rollout-thread.jsonl','state_5.sqlite','thread_history_1.sqlite'])
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.equal(existsSync(join(f.target,'thread_history_1.sqlite')),true)
  assert.equal(existsSync(join(f.target,'thread_history_1.sqlite-wal')),false)
  const copied=new DatabaseSync(join(f.target,'thread_history_1.sqlite'),{readOnly:true})
  try{
    assert.equal(copied.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok')
    assert.equal(copied.prepare('SELECT count(*) AS total FROM items').get()!.total,1)
  }finally{copied.close()}
  assert.equal(saved.files,3)
})

test('session-only copy selects the active database and normalizes legacy sqlite_home to the root',async t=>{
  const f=fixture(t),nested=join(f.source,'sqlite'),dbPath=join(nested,'state_5.sqlite')
  mkdirSync(nested);writeFileSync(join(f.source,'config.toml'),'profile="work"\n[profiles.work]\nsqlite_home="sqlite"\n')
  writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),meta+line)
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES(?,?)').run('thread',join(f.source,'sessions','rollout-thread.jsonl'));db.close()
  const history=new DatabaseSync(join(nested,'thread_history_1.sqlite'));history.exec('CREATE TABLE history(thread_id TEXT PRIMARY KEY)');history.prepare('INSERT INTO history VALUES(?)').run('thread');history.close()
  const manifest=await scanSessionHome(f.source,f.signal)
  assert.deepEqual(manifest.entries.filter(entry=>!entry.directory).map(entry=>entry.relative),['sessions/rollout-thread.jsonl','sqlite/state_5.sqlite','sqlite/thread_history_1.sqlite'])
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  await normalizeSessionDatabaseCopy(f.target,f.signal)
  assert.equal(existsSync(join(f.target,'state_5.sqlite')),true)
  assert.equal(existsSync(join(f.target,'sqlite','state_5.sqlite')),false)
  assert.equal(existsSync(join(f.target,'thread_history_1.sqlite')),true)
  assert.equal(existsSync(join(f.target,'sqlite')),false)
  const normalized=await scanInstanceHome(f.target,f.signal)
  assert.ok(normalized.entries.some(entry=>entry.relative==='state_5.sqlite'))
  assert.equal(saved.root,f.source)
})

test('normalization refuses to pair databases from different internal directories',async t=>{
  const f=fixture(t),first=join(f.source,'first'),second=join(f.source,'second')
  mkdirSync(first);mkdirSync(second)
  writeFileSync(join(first,'state_5.sqlite'),'fixture state');writeFileSync(join(second,'thread_history_1.sqlite'),'fixture history')
  await assert.rejects(normalizeSessionDatabaseCopy(f.source,f.signal),/多个内部副本/)
  assert.equal(existsSync(join(first,'state_5.sqlite')),true)
  assert.equal(existsSync(join(second,'thread_history_1.sqlite')),true)
})

test('session-only inventory does not carry an unused sqlite fallback beside the canonical database',async t=>{
  const f=fixture(t),nested=join(f.source,'sqlite')
  mkdirSync(nested);writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),meta+line)
  writeFileSync(join(f.source,'state_5.sqlite'),'root database');writeFileSync(join(nested,'state_5.sqlite'),'legacy database')
  const manifest=await scanSessionHome(f.source,f.signal)
  assert.deepEqual(manifest.entries.filter(entry=>!entry.directory).map(entry=>entry.relative),['sessions/rollout-thread.jsonl','state_5.sqlite'])
})

test('snapshot copies an appended active rollout that the old frozen metadata copier rejects, without sharing writes',{skip:!supported},async t=>{
  const f=fixture(t),file=join(f.source,'sessions','rollout-thread.jsonl')
  writeFileSync(file,meta+line)
  const manifest=await scanInstanceHome(f.source,f.signal,true)
  appendFileSync(file,line)
  await assert.rejects(copyInstanceHome(manifest,join(f.root,'old-copy'),f.signal,()=>{}),/改变/)
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,files=>{if(files===1)appendFileSync(file,line)})
  const copy=join(f.target,'sessions','rollout-thread.jsonl')
  assert.equal(readFileSync(copy,'utf8'),meta+line+line)
  assert.equal(readFileSync(file,'utf8'),meta+line+line+line)
  assert.notEqual(statSync(copy).ino,statSync(file).ino)
  writeFileSync(copy,meta+'copy-only\n');assert.equal(readFileSync(file,'utf8'),meta+line+line+line)
  assert.equal(saved.root,f.source);assert.equal(saved.files,1)
})

test('snapshot retains complete JSONL records and UTF-8 bytes while omitting only an incomplete trailing write',{skip:!supported},async t=>{
  const f=fixture(t),file=join(f.source,'sessions','rollout-thread.jsonl')
  const partial=Buffer.concat([Buffer.from('{"type":"response_item","payload":{"text":"'),Buffer.from('😀').subarray(0,2)])
  writeFileSync(file,Buffer.concat([Buffer.from(meta+line),partial]))
  const before=readFileSync(file),manifest=await scanInstanceHome(f.source,f.signal,true)
  await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.deepEqual(readFileSync(join(f.target,'sessions','rollout-thread.jsonl')),Buffer.from(meta+line))
  assert.deepEqual(readFileSync(file),before)
  const complete=join(f.source,'sessions','last-record.jsonl');writeFileSync(complete,'{"text":"汉字 😀"}')
  const next=await scanInstanceHome(f.source,f.signal,true)
  await copySavedInstanceHome(next,join(f.root,'next'),f.signal,()=>{})
  assert.equal(readFileSync(join(f.root,'next','sessions','last-record.jsonl'),'utf8'),'{"text":"汉字 😀"}')
})

test('SQLite snapshot includes committed WAL data, excludes uncommitted writes and remains coherent while the writer continues',{skip:!supported},async t=>{
  const f=fixture(t),session=join(f.source,'sessions','rollout-thread.jsonl'),path=join(f.source,'state_5.sqlite')
  writeFileSync(session,meta+line)
  const live=new DatabaseSync(path);t.after(()=>live.close())
  live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT,PRIMARY KEY(project_id,position))')
  live.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread',session,'original')
  live.prepare('INSERT INTO projects VALUES(?,?)').run('project','中文项目')
  live.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('project',0,'/external/project')
  live.exec("BEGIN; INSERT INTO projects VALUES('uncommitted','not saved')")
  const manifest=await scanInstanceHome(f.source,f.signal,true)
  assert.ok(manifest.skipped>=2);assert.equal(manifest.entries.some(entry=>/\.sqlite-(wal|shm)$/.test(entry.relative)),false)
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,files=>{
    if(files===1){live.exec("COMMIT; INSERT INTO projects VALUES('later','after index snapshot')");appendFileSync(session,line)}
  })
  await relocateCopiedProfile(saved,f.target,join(f.root,'final'),f.signal,'cml_instance')
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  try{
    assert.equal(copied.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok')
    assert.deepEqual(copied.prepare('SELECT id,name FROM projects').all().map(row=>({...row})),[{id:'project',name:'中文项目'}])
    assert.equal(copied.prepare('SELECT rollout_path FROM threads').get()!.rollout_path,join(f.root,'final','sessions','rollout-thread.jsonl'))
    assert.equal(copied.prepare('SELECT model_provider FROM threads').get()!.model_provider,'cml_instance')
    assert.equal(copied.prepare('SELECT path FROM project_roots').get()!.path,'/external/project')
  }finally{copied.close()}
  assert.equal(live.prepare('SELECT count(*) AS total FROM projects').get()!.total,3)
  assert.equal(live.prepare('SELECT model_provider FROM threads').get()!.model_provider,'original')
  assert.equal(readFileSync(session,'utf8'),meta+line+line)
})

test('snapshot rejects substituted history files and directories, and configuration rewrites still cannot publish',{skip:!supported},async t=>{
  for(const replacement of ['file','directory','config']){
    const f=fixture(t),file=join(f.source,'sessions','rollout-thread.jsonl')
    writeFileSync(file,meta+line);writeFileSync(join(f.source,'config.toml'),'model="before"\n')
    const manifest=await scanInstanceHome(f.source,f.signal,true)
    if(replacement==='file'){renameSync(file,file+'.saved');symlinkSync(file+'.saved',file)}
    if(replacement==='directory'){renameSync(join(f.source,'sessions'),join(f.source,'moved'));symlinkSync(join(f.source,'moved'),join(f.source,'sessions'))}
    if(replacement==='config')writeFileSync(join(f.source,'config.toml'),'model="changed"\n')
    await assert.rejects(copySavedInstanceHome(manifest,f.target,f.signal,()=>{}))
  }
})

test('snapshot cancellation releases source resources and prevents further copied files',{skip:!supported},async t=>{
  const f=fixture(t),controller=new AbortController()
  writeFileSync(join(f.source,'sessions','rollout-one.jsonl'),meta+line)
  writeFileSync(join(f.source,'sessions','rollout-two.jsonl'),meta+line)
  const manifest=await scanInstanceHome(f.source,controller.signal,true)
  await assert.rejects(copySavedInstanceHome(manifest,f.target,controller.signal,()=>controller.abort()),/abort/i)
  assert.equal(existsSync(join(f.target,'sessions','rollout-two.jsonl')),false)
  assert.equal(readFileSync(join(f.source,'sessions','rollout-one.jsonl'),'utf8'),meta+line)
})

test('atomic desktop project-state replacement can be snapshotted while symlink replacement remains rejected',{skip:!supported},async t=>{
  const f=fixture(t),state=join(f.source,'.codex-global-state.json'),next=join(f.source,'state-next')
  writeFileSync(state,JSON.stringify({'project-order':['before']}))
  const manifest=await scanInstanceHome(f.source,f.signal,true)
  writeFileSync(next,JSON.stringify({'project-order':['after'],'auth':'excluded'}));renameSync(next,state)
  await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.deepEqual(JSON.parse(readFileSync(join(f.target,'.codex-global-state.json'),'utf8')),{'project-order':['after']})
  const again=await scanInstanceHome(f.source,f.signal,true)
  renameSync(state,state+'.saved');symlinkSync(state+'.saved',state)
  await assert.rejects(copySavedInstanceHome(again,join(f.root,'rejected'),f.signal,()=>{}))
})

test('desktop backup rotation and disappearing write temporaries cannot interrupt a history copy or replace project grouping',{skip:!supported},async t=>{
  for(const disappearTemporaries of [false,true]){
    const f=fixture(t),state=join(f.source,'.codex-global-state.json')
    const project={'local-projects':{project:{id:'project',name:'中文项目',rootPaths:['/external/project']}},'project-order':['project']}
    writeFileSync(state,JSON.stringify({...project,'source-login-state':'fixture-excluded'}))
    writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),meta+line)
    const artifacts=['.codex-global-state.json.bak','.codex-global-state.json.bak.bak','..codex-global-state.json.tmp-123-fixture','..codex-global-state.json.bak.tmp-123-fixture']
    for(const name of artifacts)writeFileSync(join(f.source,name),'original backup or unfinished write')
    mkdirSync(join(f.source,'attachments'))
    writeFileSync(join(f.source,'attachments','.codex-global-state.json.bak'),'user attachment retained')
    const manifest=await scanInstanceHome(f.source,f.signal,true)
    writeFileSync(join(f.source,artifacts[0]),'rotated while copying')
    if(disappearTemporaries)for(const name of artifacts.slice(1))rmSync(join(f.source,name))
    const saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
    await relocateCopiedProfile(saved,f.target,join(f.root,'final'),f.signal,'cml_instance')
    assert.deepEqual(JSON.parse(readFileSync(join(f.target,'.codex-global-state.json'),'utf8')),project)
    assert.equal(readFileSync(join(f.target,'sessions','rollout-thread.jsonl'),'utf8').includes('完整内容 汉字 😀'),true)
    assert.equal(readFileSync(join(f.target,'attachments','.codex-global-state.json.bak'),'utf8'),'user attachment retained')
    for(const name of artifacts)assert.equal(existsSync(join(f.target,name)),false)
    assert.equal(readFileSync(join(f.source,artifacts[0]),'utf8'),'rotated while copying')
    assert.equal(JSON.parse(readFileSync(state,'utf8'))['source-login-state'],'fixture-excluded')
  }
})

test('a valid desktop backup cannot mask an incomplete primary project state',{skip:!supported},async t=>{
  const f=fixture(t)
  writeFileSync(join(f.source,'.codex-global-state.json'),'{"project-order":[')
  writeFileSync(join(f.source,'.codex-global-state.json.bak'),JSON.stringify({'project-order':['old']}))
  const manifest=await scanInstanceHome(f.source,f.signal,true)
  await assert.rejects(copySavedInstanceHome(manifest,f.target,f.signal,()=>{}),/项目分组状态格式不兼容/)
})

test('snapshot refuses unsafe SQLite companions and never writes through a source link',{skip:!supported},async t=>{
  const f=fixture(t),path=join(f.source,'state_5.sqlite'),db=new DatabaseSync(path)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');db.close()
  const outside=join(f.root,'outside');writeFileSync(outside,'unchanged');symlinkSync(outside,path+'-wal')
  const manifest=await scanInstanceHome(f.source,f.signal,true)
  await assert.rejects(copySavedInstanceHome(manifest,f.target,f.signal,()=>{}),/附属文件/)
  assert.equal(readFileSync(outside,'utf8'),'unchanged')
})

test('snapshot resolves profile aliases, removes only stale copied indexes and preserves project grouping and source rows',{skip:!supported},async t=>{
  const f=fixture(t),alias=join(f.root,'profile-alias'),session=join(f.source,'sessions','rollout-thread.jsonl')
  symlinkSync(f.source,alias);writeFileSync(session,meta+line)
  const path=join(f.source,'state_5.sqlite'),live=new DatabaseSync(path)
  live.exec('PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,project_id TEXT REFERENCES projects(id)); CREATE TABLE thread_dynamic_tools(thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,name TEXT)')
  live.exec("INSERT INTO projects VALUES('project')")
  const insert=live.prepare('INSERT INTO threads VALUES(?,?,?,?)')
  insert.run('thread',join(alias,'sessions','rollout-thread.jsonl'),'original','project')
  insert.run('missing',join(f.source,'sessions','rollout-missing.jsonl'),'original','project')
  live.exec("INSERT INTO thread_dynamic_tools VALUES('thread','keep'); INSERT INTO thread_dynamic_tools VALUES('missing','stale')")
  live.close();const before=readFileSync(path)
  const manifest=await scanInstanceHome(f.source,f.signal,true),saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.equal(saved.omittedSessions,1)
  await relocateCopiedProfile(saved,f.target,join(f.root,'final'),f.signal,'cml_instance')
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  try{
    assert.deepEqual(copied.prepare('SELECT * FROM threads').all().map(row=>({...row})),[{id:'thread',rollout_path:join(f.root,'final','sessions','rollout-thread.jsonl'),model_provider:'cml_instance',project_id:'project'}])
    assert.equal(copied.prepare('SELECT count(*) AS total FROM projects').get()!.total,1)
    assert.deepEqual(copied.prepare('SELECT * FROM thread_dynamic_tools').all().map(row=>({...row})),[{thread_id:'thread',name:'keep'}])
    assert.deepEqual(copied.prepare('PRAGMA foreign_key_check').all(),[])
  }finally{copied.close()}
  assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(session,'utf8'),meta+line)
})

test('snapshot captures a new indexed rollout committed after the inventory, without following outside references',{skip:!supported},async t=>{
  const f=fixture(t),path=join(f.source,'state_5.sqlite'),live=new DatabaseSync(path)
  live.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT)')
  const manifest=await scanInstanceHome(f.source,f.signal,true),session=join(f.source,'sessions','new-date','rollout-thread.jsonl')
  mkdirSync(join(f.source,'sessions','new-date'));writeFileSync(session,meta+line)
  live.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread',session,'original');live.close()
  const saved=await copySavedInstanceHome(manifest,f.target,f.signal,()=>{})
  assert.equal(saved.omittedSessions,0);assert.equal(readFileSync(join(f.target,'sessions','new-date','rollout-thread.jsonl'),'utf8'),meta+line)
  await relocateCopiedProfile(saved,f.target,join(f.root,'final'),f.signal,'cml_instance')
  const outside=join(f.root,'outside','rollout-private.jsonl');mkdirSync(join(f.root,'outside'));writeFileSync(outside,meta+line)
  const db=new DatabaseSync(path);db.prepare('UPDATE threads SET rollout_path=?').run(outside);db.close()
  const next=await scanInstanceHome(f.source,f.signal,true)
  await assert.rejects(copySavedInstanceHome(next,join(f.root,'rejected'),f.signal,()=>{}),/目录外/)
  assert.equal(readFileSync(outside,'utf8'),meta+line)
})

test('cancellation during a large SQLite backup rejects promptly and releases the read transaction',{skip:!supported},async t=>{
  const f=fixture(t),path=join(f.source,'large.sqlite'),live=new DatabaseSync(path),controller=new AbortController()
  live.exec('PRAGMA journal_mode=WAL; CREATE TABLE data(payload BLOB); BEGIN')
  const insert=live.prepare('INSERT INTO data VALUES(zeroblob(65536))');for(let i=0;i<512;i++)insert.run()
  live.exec('COMMIT');t.after(()=>live.close())
  const manifest=await scanInstanceHome(f.source,controller.signal,true);let transferred=0
  await assert.rejects(copySavedInstanceHome(manifest,f.target,controller.signal,(files,bytes)=>{
    if(files===0&&bytes>0){transferred=bytes;controller.abort()}
  }),/abort/i)
  assert.ok(transferred>0&&transferred<32*1024*1024,'Cancel interrupts backup steps, not merely the next file')
  assert.equal(live.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy,0,'Backup releases its source read transaction')
  assert.equal(live.prepare('SELECT count(*) AS total FROM data').get()!.total,512)
})
