import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,renameSync,symlinkSync,readdirSync,appendFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog,classifySession} from '../src/main/sessions'
import {openSessionFile,reverseSessionLines,sessionContains,sessionTokens,sessionDigest} from '../src/main/sessionFiles'

const when='2026-10-01T08:00:00.000Z'
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-sessions-'))),store=new Store(join(root,'manager'),{encrypt:text=>Buffer.from(text),decrypt:raw=>raw.toString()}),configs=new ClientConfigs(store),catalog=new SessionCatalog(store)
  const source=(name:string)=>{const home=join(root,name);mkdirSync(home);const target=configs.register(home);return {home,target}}
  const scan=(extra:Record<string,unknown>={})=>catalog.scan({runId:randomUUID(),titleQuery:'',contentQuery:'',kind:'all',...extra})
  t.after(()=>{catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,configs,catalog,source,scan}
}
function rollout(home:string,id:string,extra:Record<string,unknown>[]=[] ,folder='sessions',suffix=id){
  const dir=join(home,folder,'2026','10','01');mkdirSync(dir,{recursive:true})
  const path=join(dir,`rollout-${suffix}.jsonl`)
  writeFileSync(path,[{type:'session_meta',timestamp:when,payload:{id,cwd:'/fixture/project/src'}},...extra].map(value=>JSON.stringify(value)).join('\n')+'\n')
  return path
}
const usage=(input=100,output=25)=>({type:'event_msg',timestamp:when,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output}}}})
function hashes(root:string):Record<string,string>{const result:Record<string,string>={};for(const entry of readdirSync(root,{withFileTypes:true})){const file=join(root,entry.name);if(entry.isDirectory())Object.assign(result,hashes(file));else if(entry.isFile())result[file]=createHash('sha256').update(readFileSync(file)).digest('hex')}return result}

test('catalog merges duplicate sessions, preserves archived locations and applies real display/title/project precedence without changing source files',async t=>{
  const f=fixture(t),a=f.source('a'),b=f.source('b'),id=randomUUID(),indexId=randomUUID(),previewId=randomUUID()
  const file=rollout(a.home,id,[usage(),{type:'response_item',payload:{type:'message',content:[{text:'private-body-never-in-snapshot'}]}}])
  rollout(b.home,id,[],'archived_sessions');rollout(a.home,indexId);rollout(a.home,previewId)
  writeFileSync(join(a.home,'session_index.jsonl'),[JSON.stringify({id,thread_name:'Index title',updated_at:when}),JSON.stringify({id:indexId,thread_name:'Latest index title'})].join('\n'))
  const db=new DatabaseSync(join(a.home,'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, preview TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots (project_id TEXT,path TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run(id,'State title','Preview title')
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run(previewId,'','空白   折叠\n'+ '中'.repeat(80))
  db.prepare('INSERT INTO projects VALUES(?,?)').run('p','Root project');db.prepare('INSERT INTO project_roots VALUES(?,?)').run('p','/fixture/project')
  db.prepare('INSERT INTO projects VALUES(?,?)').run('s','Named child');db.prepare('INSERT INTO project_roots VALUES(?,?)').run('s','/fixture/project/src');db.close()
  mkdirSync(join(a.home,'sqlite'));const ui=new DatabaseSync(join(a.home,'sqlite','catalog.db'))
  ui.exec('CREATE TABLE local_thread_catalog(thread_id TEXT,display_title TEXT,host_id TEXT)')
  ui.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run(id,'Local catalog title','local');ui.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run(id,'Remote must not win','remote');ui.close()
  const before=hashes(a.home),page=await f.scan();assert.equal(page.total,3);assert.deepEqual(page.warnings,[])
  const record=page.items.find(value=>value.id===id)!
  assert.equal(record.title,'Local catalog title');assert.equal(record.projectName,'Named child');assert.equal(record.locations.length,2)
  assert.equal(record.locations[1].archived,true);assert.equal(record.locations[0].ambiguous,false)
  assert.equal(page.items.find(value=>value.id===indexId)!.title,'Latest index title')
  assert.equal(Array.from(page.items.find(value=>value.id===previewId)!.title).length,60)
  assert.ok(page.items.find(value=>value.id===previewId)!.title.endsWith('…'));assert.equal(JSON.stringify(page).includes('private-body-never-in-snapshot'),false)
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),file)
  assert.deepEqual(await f.catalog.tokenStats({snapshotId:page.snapshotId,sessionIds:[id,indexId]}),[{id,tokens:{input:100,output:25,total:125},targetId:a.target.id},{id:indexId}])
  assert.deepEqual(hashes(a.home),before)
})

test('identical same-directory copies are de-duplicated while different bodies remain ambiguous and cross-directory copies stay selectable',async t=>{
  const f=fixture(t),a=f.source('a'),b=f.source('b'),id=randomUUID()
  const active=rollout(a.home,id,[usage()])
  // Copying a profile preserves both trees.  The archived copy has the same
  // bytes and therefore represents one logical session, not an ambiguity.
  const archived=rollout(a.home,id,[usage()],'archived_sessions','same')
  const cross=rollout(b.home,id,[usage()])
  let page=await f.scan(),record=page.items.find(value=>value.id===id)!
  assert.equal(record.locations.length,2)
  assert.ok(record.locations.every(value=>value.ambiguous===false))
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),active)
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:b.target.id}),cross)
  const sources=await f.catalog.transferSources(page.snapshotId,[id])
  assert.equal(sources.length,1)
  assert.equal(sources[0].path,active)
  assert.notEqual(sources[0].path,archived)

  // A same-ID file with a different body is still unsafe to open implicitly.
  rmSync(archived)
  rollout(a.home,id,[{type:'event_msg',timestamp:when,payload:{type:'user_message',message:'different body'}}],'archived_sessions','different')
  page=await f.scan({targetId:a.target.id});record=page.items.find(value=>value.id===id)!
  assert.equal(record.locations.find(value=>value.targetId===a.target.id)?.ambiguous,true)
  await assert.rejects(f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),/多个同 ID/)
  await assert.rejects(f.catalog.transferSources(page.snapshotId,[id]),/冲突/)
})

function paginatedRollout(home:string,id:string,input:number,suffix:string){
  const path=rollout(home,id,[usage(input,25)],'sessions',suffix),lines=readFileSync(path,'utf8').split('\n'),meta=JSON.parse(lines[0])
  meta.payload.history_mode='paginated';meta.payload.history_base={thread_id:randomUUID(),end_ordinal_exclusive:12,end_byte_offset:1024}
  lines[0]=JSON.stringify(meta);writeFileSync(path,lines.join('\n'));return path
}
function rolloutIndex(path:string,entries:{id:string;path:string}[]){
  const db=new DatabaseSync(path);db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)')
  for(const entry of entries)db.prepare('INSERT INTO threads VALUES(?,?)').run(entry.id,entry.path)
  db.close()
}

test('active state index resolves native paginated segments while retaining every physical rollout',async t=>{
  const f=fixture(t),a=f.source('paginated'),id=randomUUID(),paths:string[]=[]
  for(let i=0;i<8;i++)paths.push(paginatedRollout(a.home,id,100+i,'segment-'+i))
  const current=paths[3];rolloutIndex(join(a.home,'state_5.sqlite'),[{id,path:current.slice(a.home.length+1)}])
  const before=hashes(a.home),page=await f.scan(),record=page.items[0]
  assert.deepEqual(page.warnings,[]);assert.equal(page.total,1);assert.equal(record.historyMode,'paginated')
  assert.equal(record.locations[0].historyMode,'paginated');assert.equal(record.locations[0].ambiguous,false);assert.equal(record.locations[0].historicalCopies,7)
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),current)
  assert.equal((await f.catalog.transferSources(page.snapshotId,[id]))[0].path,current)
  assert.equal((await f.catalog.transferSources(page.snapshotId,[id]))[0].record.historyMode,'paginated')
  assert.deepEqual(await f.catalog.tokenStats({snapshotId:page.snapshotId,sessionIds:[id]}),[{id,tokens:{input:103,output:25,total:128},targetId:a.target.id}])
  const all=await f.catalog.syncSources(page.snapshotId,new AbortController().signal)
  assert.equal(all.length,8);assert.deepEqual(new Set(all.map(source=>source.path)),new Set(paths));assert.ok(all.every(source=>source.record.historyMode==='paginated'))
  assert.deepEqual(hashes(a.home),before)
})

test('only the active profile sqlite_home resolves segments; inactive/root index paths have no authority',async t=>{
  const f=fixture(t),a=f.source('profiles'),id=randomUUID(),first=paginatedRollout(a.home,id,100,'first'),current=paginatedRollout(a.home,id,200,'current')
  mkdirSync(join(a.home,'sqlite'));mkdirSync(join(a.home,'inactive'))
  rolloutIndex(join(a.home,'state_5.sqlite'),[{id,path:first}]);rolloutIndex(join(a.home,'sqlite','state_5.sqlite'),[{id,path:current}]);rolloutIndex(join(a.home,'inactive','state_5.sqlite'),[{id,path:first}])
  writeFileSync(join(a.home,'config.toml'),'profile="active"\nsqlite_home="inactive"\n[profiles.active]\nsqlite_home="sqlite"\n[profiles.inactive]\nsqlite_home="inactive"\n')
  let page=await f.scan();assert.equal(page.items[0].locations[0].ambiguous,false)
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),current)
  writeFileSync(join(a.home,'config.toml'),'[profiles.inactive]\nsqlite_home="sqlite"\n')
  page=await f.scan();assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),first)
})

test('stale, foreign, repeated and linked rollout indexes preserve real ambiguous-file protection',async t=>{
  const f=fixture(t),a=f.source('invalid-index'),b=f.source('foreign'),id=randomUUID(),other=randomUUID(),first=paginatedRollout(a.home,id,100,'first')
  paginatedRollout(a.home,id,200,'current');const wrongId=rollout(a.home,other),outside=paginatedRollout(b.home,id,300,'foreign'),database=join(a.home,'state_5.sqlite')
  for(const entries of [[{id,path:outside}],[{id,path:wrongId}],[{id,path:join(a.home,'sessions','missing.jsonl')}],[{id,path:first},{id,path:first}]]){
    rmSync(database,{force:true});rolloutIndex(database,entries)
    const page=await f.scan({targetId:a.target.id}),record=page.items.find(row=>row.id===id)!
    assert.equal(record.locations[0].ambiguous,true)
    await assert.rejects(f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),/多个同 ID/)
  }
  // A valid-looking alternate DB cannot override an externally configured one.
  rmSync(database);rolloutIndex(database,[{id,path:first}]);writeFileSync(join(a.home,'config.toml'),`sqlite_home=${JSON.stringify(b.home)}\n`)
  let page=await f.scan({targetId:a.target.id});assert.equal(page.items.find(row=>row.id===id)!.locations[0].ambiguous,true)
  rmSync(join(a.home,'config.toml'));mkdirSync(join(a.home,'linked-db'));renameSync(database,join(a.home,'linked-db','state_5.sqlite'));symlinkSync('linked-db',join(a.home,'sqlite-link'),'dir');writeFileSync(join(a.home,'config.toml'),'sqlite_home="sqlite-link"\n')
  page=await f.scan({targetId:a.target.id});assert.equal(page.items.find(row=>row.id===id)!.locations[0].ambiguous,true)
  assert.ok(page.warnings.some(warning=>warning.includes('当前会话索引无法安全读取')))
})

test('read-only rollout selection sees committed WAL rows without altering client tables',async t=>{
  const f=fixture(t),a=f.source('live-index'),id=randomUUID(),first=paginatedRollout(a.home,id,100,'first'),current=paginatedRollout(a.home,id,200,'current')
  const database=join(a.home,'state_5.sqlite'),db=new DatabaseSync(database);t.after(()=>db.close())
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id,first);db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(current,id)
  const before=db.prepare('SELECT * FROM threads').all(),page=await f.scan();assert.deepEqual(page.warnings,[])
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),current)
  assert.deepEqual(db.prepare('SELECT * FROM threads').all(),before)
})

test('a client index change during rollout selection never publishes a guessed primary segment',async t=>{
  const f=fixture(t),a=f.source('changing-index'),id=randomUUID(),first=paginatedRollout(a.home,id,100,'first'),current=paginatedRollout(a.home,id,200,'current')
  const db=new DatabaseSync(join(a.home,'state_5.sqlite'));t.after(()=>db.close())
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id,first)
  const original=DatabaseSync.prototype.prepare;let changed=false
  const mock=t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    const statement=original.call(this,sql)
    if(sql.startsWith('SELECT id,rollout_path FROM threads ')){
      const iterate=statement.iterate
      t.mock.method(statement,'iterate',function*(this:typeof statement){
        yield* iterate.call(this)
        if(!changed){changed=true;db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(current,id)}
      })
    }
    return statement
  })
  let page=await f.scan();mock.mock.restore();assert.equal(changed,true)
  assert.equal(page.items[0].locations[0].ambiguous,true);assert.ok(page.warnings.some(warning=>warning.includes('当前会话索引无法安全读取')))
  page=await f.scan();assert.equal(page.items[0].locations[0].ambiguous,false)
  assert.equal(await f.catalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),current)
})

test('filters combine title and raw content in one location, retain every copy and correct stale activity timestamps',async t=>{
  const f=fixture(t),a=f.source('a'),b=f.source('b'),id=randomUUID(),other=randomUUID()
  rollout(a.home,id,[{type:'event_msg',timestamp:when,payload:{text:'MixedCASE 中文检索'}}]);rollout(b.home,id)
  rollout(a.home,other,[{type:'event_msg',timestamp:'2026-10-01T09:00:00Z',payload:{text:'nothing'}}])
  writeFileSync(join(a.home,'session_index.jsonl'),[{id,title:'Wanted title',updated_at:'2035-01-01T00:00:00Z'},{id:other,title:'subagent worker'}].map(value=>JSON.stringify(value)).join('\n'))
  let page=await f.scan({titleQuery:'WANTED',contentQuery:'mixedcase'})
  assert.equal(page.total,1);assert.equal(page.items[0].locations.length,2);assert.equal(page.items[0].updatedAt,Date.parse(when))
  page=await f.scan({contentQuery:'中文检索'});assert.equal(page.total,1)
  page=await f.scan({kind:'subagent'});assert.equal(page.total,1);assert.equal(page.items[0].id,other)
  page=await f.scan({targetId:b.target.id,titleQuery:'Wanted'});assert.equal(page.total,0)
  assert.equal(classifySession('external transfer','/project'),'external');assert.equal(classifySession('','/project'),'conversation')
})

test('stream readers handle UTF-8 split across chunks, giant lines, partial final events and latest cumulative usage without inventing zero values',async t=>{
  const f=fixture(t),a=f.source('a'),id=randomUUID(),file=rollout(a.home,id)
  const initial=readFileSync(file),padding=Buffer.alloc(65535-initial.length,32)
  writeFileSync(file,Buffer.concat([initial,padding,Buffer.from('中文边界\n'),Buffer.from(JSON.stringify(usage())+'\n'),Buffer.alloc(5*1024*1024,120),Buffer.from('\n'+JSON.stringify(usage(200,50))+'\n{"type":"event_msg"')]))
  const opened=await openSessionFile(a.home,file),signal=new AbortController().signal
  try{
    assert.equal(await sessionContains(opened.file,opened.stat.size,'中文边界',signal),true)
    assert.deepEqual(await sessionTokens(opened.file,opened.stat.size,signal),{input:200,output:50,total:250})
    const lines:Buffer[]=[];for await(const line of reverseSessionLines(opened.file,opened.stat.size,signal))lines.push(line)
    assert.ok(lines.every(line=>line.length<=4*1024*1024));assert.ok(lines.some(line=>line.includes('session_meta')))
  }finally{await opened.file.close()}
  const missing=rollout(a.home,randomUUID(),[{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:30}}}}])
  const second=await openSessionFile(a.home,missing);try{assert.equal(await sessionTokens(second.file,second.stat.size,signal),undefined)}finally{await second.file.close()}
})

test('duplicate-content digest refuses a rollout that changes while it is being read',async t=>{
  const f=fixture(t),a=f.source('changing'),id=randomUUID(),path=rollout(a.home,id)
  appendFileSync(path,Buffer.alloc(256*1024,120))
  const opened=await openSessionFile(a.home,path)
  try{
    const prototype=Object.getPrototypeOf(opened.file),original=prototype.read
    let reads=0
    const mock=t.mock.method(prototype,'read',async function(this:unknown,...args:unknown[]){
      const result=await original.apply(this,args as never)
      if(++reads===1)appendFileSync(path,'changed while hashing')
      return result
    })
    await assert.rejects(sessionDigest(opened.file,opened.stat.size,new AbortController().signal),/变化/)
    mock.mock.restore()
  }finally{await opened.file.close()}
})

test('file operations reject replaced homes/files, symlinks, foreign targets, stale snapshots and ambiguous IDs',async t=>{
  const f=fixture(t),a=f.source('a'),b=f.source('b'),id=randomUUID(),file=rollout(a.home,id,[usage()])
  let page=await f.scan(),selection={snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}
  await assert.rejects(f.catalog.location({...selection,targetId:b.target.id}),/不属于/)
  renameSync(file,file+'.old');writeFileSync(file,readFileSync(file+'.old'))
  await assert.rejects(f.catalog.location(selection),/替换/)
  rmSync(file);symlinkSync(file+'.old',file);page=await f.scan();assert.equal(page.total,0)
  rmSync(file);renameSync(file+'.old',file);rollout(a.home,id,[],'archived_sessions','duplicate')
  page=await f.scan();assert.equal(page.total,1);assert.equal(page.items[0].locations[0].ambiguous,true)
  await assert.rejects(f.catalog.location({...selection,snapshotId:page.snapshotId}),/多个同 ID/)
  const old=page.snapshotId;page=await f.scan();assert.throws(()=>f.catalog.page({snapshotId:old,page:1}),/已更新/)
  rmSync(join(a.home,'archived_sessions'),{recursive:true});page=await f.scan()
  renameSync(a.home,a.home+'-old');mkdirSync(a.home)
  await assert.rejects(f.catalog.location({...selection,snapshotId:page.snapshotId}),/替换|变化/)
  page=await f.scan();assert.ok(page.warnings.some(value=>value.includes('目录已变化')));assert.equal(page.total,0)
  await assert.rejects(f.scan({targetId:randomUUID()}),/不存在/)
  await assert.rejects(f.catalog.location({...selection,path:'/etc/passwd'}))
})

test('ten thousand session files paginate in the main process and cancellation never publishes a partial result',async t=>{
  const f=fixture(t),a=f.source('large'),entries:{id:string;thread_name:string}[]=[]
  for(let i=0;i<10001;i++){const id=randomUUID();entries.push({id,thread_name:'会话 '+i});rollout(a.home,id)}
  writeFileSync(join(a.home,'session_index.jsonl'),entries.map(value=>JSON.stringify(value)).join('\n'))
  const page=await f.scan();assert.equal(page.total,10001);assert.equal(page.items.length,25)
  const last=f.catalog.page({snapshotId:page.snapshotId,page:401,pageSize:25});assert.equal(last.items.length,1)
  assert.equal(new Set([...page.items,...last.items].map(value=>value.id)).size,26)
  const batch=await f.catalog.tokenStats({snapshotId:page.snapshotId,sessionIds:entries.slice(0,1000).map(value=>value.id)})
  assert.equal(batch.length,1000);assert.ok(batch.every(value=>value.tokens===undefined))
  await assert.rejects(f.catalog.tokenStats({snapshotId:page.snapshotId,sessionIds:[...entries.slice(0,1000),entries[1000]].map(value=>value.id)}),/1000/)
  assert.throws(()=>f.catalog.page({snapshotId:page.snapshotId,page:1,pageSize:10000}))
  const runId=randomUUID(),pending=f.scan({runId});f.catalog.cancel(runId)
  await assert.rejects(pending,/已取消/);assert.throws(()=>f.catalog.page({snapshotId:page.snapshotId,page:1}),/已更新/)
  const first=f.scan(),second=f.scan({titleQuery:'会话 10000'});await assert.rejects(first,/已取消/);assert.equal((await second).total,1)
})

test('live WAL state databases provide committed titles without changing logical rows and oversized IDs cannot alias valid sessions',async t=>{
  const f=fixture(t),a=f.source('wal'),id='a'.repeat(256),other=randomUUID()
  rollout(a.home,id,[],'sessions','long-id');rollout(a.home,other)
  const path=join(a.home,'state_7.sqlite'),db=new DatabaseSync(path)
  t.after(()=>db.close())
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT,title TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id+'x','Must not alias a truncated ID')
  db.prepare('INSERT INTO threads VALUES(?,?)').run(other,'Live WAL title')
  db.exec('CREATE TABLE local_thread_catalog(thread_id TEXT,display_title TEXT,host_id TEXT)')
  db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run(id+'x','Catalog must not alias either','local')
  assert.ok(existsSync(path+'-wal'))
  const before=db.prepare('SELECT * FROM threads').all(),page=await f.scan()
  assert.deepEqual(page.warnings,[]);assert.equal(page.total,2)
  assert.equal(page.items.find(row=>row.id===id)!.title,id)
  assert.equal(page.items.find(row=>row.id===other)!.title,'Live WAL title')
  assert.deepEqual(db.prepare('SELECT * FROM threads').all(),before)
})

test('usage cancellation and changes during reading never return stale cumulative tokens',async t=>{
  const f=fixture(t),a=f.source('changing'),id=randomUUID(),path=rollout(a.home,id,[usage()])
  const page=await f.scan(),request={snapshotId:page.snapshotId,sessionIds:[id]}
  const pending=f.catalog.tokenStats(request);f.catalog.cancelTokens(page.snapshotId)
  await assert.rejects(pending,/已取消/)
  const probe=await openSessionFile(a.home,path),prototype=Object.getPrototypeOf(probe.file),original=prototype.read
  await probe.file.close()
  let reads=0
  const mock=t.mock.method(prototype,'read',async function(this:unknown,...args:unknown[]){
    const value=await original.apply(this,args)
    if(++reads===2)appendFileSync(path,JSON.stringify(usage(500,60))+'\n')
    return value
  })
  const results=await f.catalog.tokenStats(request);mock.mock.restore()
  assert.equal(reads,2);assert.equal(results[0].tokens,undefined);assert.match(results[0].error!,/刷新/)
  assert.deepEqual((await f.catalog.tokenStats(request))[0].tokens,{input:500,output:60,total:560})
})

test('corrupt display databases fall back visibly, links outside the home are skipped and no unregistered default directory is traversed',async t=>{
  const f=fixture(t),a=f.source('a'),id=randomUUID();rollout(a.home,id)
  writeFileSync(join(a.home,'state_5.sqlite'),'fixture invalid database');mkdirSync(join(a.home,'sqlite'))
  symlinkSync(f.root,join(a.home,'sessions','outside'),'dir')
  const unregistered=join(f.root,'unregistered');mkdirSync(unregistered);rollout(unregistered,randomUUID())
  const before=hashes(a.home),page=await f.scan()
  assert.equal(page.total,1);assert.equal(page.items[0].title,id);assert.ok(page.warnings.some(value=>value.includes('数据库')))
  assert.deepEqual(hashes(a.home),before)
})

test('source counts describe whole scanned directories and distinguish empty defaults from unreadable sources',async t=>{
  const f=fixture(t),source=f.source('counted'),id=randomUUID()
  rollout(source.home,id)
  const defaultTarget=f.configs.targets().find(value=>value.role==='default')!
  assert.equal(defaultTarget.name,'默认 Codex 目录')
  let page=await f.scan({titleQuery:'no matching title'})
  assert.equal(page.total,0)
  assert.equal(page.sourceCounts?.[source.target.id],1)
  assert.equal(page.sourceCounts?.[defaultTarget.id],0)
  mkdirSync(defaultTarget.directory,{recursive:true})
  rollout(defaultTarget.directory,randomUUID())
  page=await f.scan({titleQuery:'still no matching title'})
  assert.equal(page.total,0)
  assert.equal(page.sourceCounts?.[defaultTarget.id],1)
  assert.equal(f.catalog.page({snapshotId:page.snapshotId,page:1}).sourceCounts?.[source.target.id],1)
  writeFileSync(join(defaultTarget.directory,'state_5.sqlite'),'fixture corrupt database')
  page=await f.scan()
  assert.ok(page.warnings.some(value=>value.includes(defaultTarget.name)))
  assert.equal(page.sourceCounts?.[defaultTarget.id],undefined,'An unreadable source must not be hidden as empty')
})
