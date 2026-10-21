import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,renameSync,symlinkSync,readdirSync,appendFileSync,existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog,classifySession} from '../src/main/sessions'
import {openSessionFile,reverseSessionLines,sessionContains,sessionTokens,sessionDigest} from '../src/main/sessionFiles'
import {instanceInputSchema} from '../src/shared/instances'

const when='2026-10-01T08:00:00.000Z'
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-sessions-'))),store=new Store(join(root,'manager'),{encrypt:text=>Buffer.from(text),decrypt:raw=>raw.toString()}),configs=new ClientConfigs(store),catalog=new SessionCatalog(store,undefined,{defaultClaudeDirectory:null})
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
  assert.equal(f.catalog.originalSessionId({snapshotId:page.snapshotId,sessionId:id,targetId:a.target.id}),id,'Codex copies keep their existing native session ID')
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

function claudeSource(f:ReturnType<typeof fixture>,name:string,sessionId:string){
  const id=randomUUID(),profile={...instanceInputSchema.parse({clientType:'claude_code',name,applicationId:'fixture-claude-cli',accountId:randomUUID(),connectionMode:'native',model:'claude-sonnet-4-5'}),id,revision:0,createdAt:Date.now()}
  f.store.transaction(state=>{state.instances=[...(state.instances??[]),profile]})
  const home=join(f.store.directory,'instances',id,'home'),project=join(home,'projects','fixture-project'),cwd=join(f.root,'claude-workspace')
  mkdirSync(project,{recursive:true});mkdirSync(cwd,{recursive:true})
  const path=join(project,sessionId+'.jsonl')
  writeFileSync(path,[
    {type:'user',sessionId,cwd,timestamp:when,message:{role:'user',content:'ACCOUNT_CONVERSATION_BODY_NOT_RETURNED'}},
    {type:'custom-title',sessionId,customTitle:name+' history'},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n')
  return {id,home,path,project,cwd,profile}
}

test('unified catalog isolates identical Claude session IDs by instance and never merges them with Codex',async t=>{
  const f=fixture(t),codex=f.source('codex-source'),id=randomUUID(),a=claudeSource(f,'first-account',id),b=claudeSource(f,'second-account',id)
  rollout(codex.home,id,[usage()])
  const before=hashes(f.root),page=await f.scan()
  assert.equal(page.total,3)
  const rows=page.items.filter(row=>row.clientType==='claude_code')
  assert.equal(rows.length,2)
  assert.equal(new Set(page.items.map(row=>row.id)).size,3)
  assert.ok(rows.every(row=>row.id!==id&&row.sourceSessionId===id&&row.locations.length===1&&!row.locations[0].ambiguous))
  assert.equal(JSON.stringify(page).includes('ACCOUNT_CONVERSATION_BODY_NOT_RETURNED'),false)
  assert.ok(page.sources?.some(source=>source.id===a.id&&source.readOnly&&source.clientType==='claude_code'))
  assert.equal(page.sourceCounts?.[a.id],1);assert.equal(page.sourceCounts?.[b.id],1)
  assert.ok(!f.configs.targets().some(target=>target.id===a.id),'Codex config targets cannot expose Claude homes')
  for(const source of [a,b]){
    const row=rows.find(row=>row.locations[0].targetId===source.id)!,selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:source.id}
    assert.equal(await f.catalog.location(selection),source.path)
    assert.equal(f.catalog.originalSessionId(selection),id)
    assert.throws(()=>f.catalog.originalSessionId({...selection,sessionId:randomUUID()}),/不属于/,'copy lookup rejects IDs absent from the current snapshot')
    await assert.rejects(f.catalog.location({...selection,targetId:codex.target.id}),/不属于/)
  }
  const staleRow=rows[0],staleSelection={snapshotId:page.snapshotId,sessionId:staleRow.id,targetId:staleRow.locations[0].targetId}
  await f.scan()
  assert.throws(()=>f.catalog.originalSessionId(staleSelection),/已更新/,'copy lookup rejects expired snapshots')
  assert.deepEqual(hashes(f.root),before,'Indexing and opening metadata cannot mutate credentials or transcripts')
})

test('Claude rows retain each conflicting project source while all Codex mutation methods reject them',async t=>{
  const f=fixture(t),id=randomUUID(),a=claudeSource(f,'claude',id),other=join(a.home,'projects','second-project')
  mkdirSync(other);const copy=join(other,id+'.jsonl');writeFileSync(copy,readFileSync(a.path))
  const page=await f.scan({targetId:a.id})
  assert.equal(page.total,2)
  assert.ok(page.items.every(row=>row.locations[0].ambiguous))
  const opened=await Promise.all(page.items.map(row=>f.catalog.location({snapshotId:page.snapshotId,sessionId:row.id,targetId:a.id})))
  assert.deepEqual(new Set(opened),new Set([a.path,copy]))
  for(const row of page.items){
    assert.equal(row.capabilities?.transfer,false)
    assert.equal(row.capabilities?.trash,false)
    assert.equal(row.capabilities?.visibilityRepair,false)
    assert.throws(()=>f.catalog.selectedRecords(page.snapshotId,[row.id]),/Claude Code.*只读/)
    await assert.rejects(f.catalog.transferSources(page.snapshotId,[row.id]),/Claude Code.*只读/)
  }
  await assert.rejects(f.catalog.syncSources(page.snapshotId,new AbortController().signal),/Claude Code.*只读/)
  const tokens=await f.catalog.tokenStats({snapshotId:page.snapshotId,sessionIds:page.items.map(row=>row.id)})
  assert.ok(tokens.every(value=>!value.tokens&&value.error?.includes('尚未接入')))
})

test('Claude title and body filters preserve source counts and search native content',async t=>{
  const f=fixture(t),id=randomUUID(),a=claudeSource(f,'claude-search',id)
  let page=await f.scan({targetId:a.id,titleQuery:'CLAUDE-SEARCH'})
  assert.equal(page.total,1)
  page=await f.scan({targetId:a.id,titleQuery:id.toUpperCase()})
  assert.equal(page.total,1)
  page=await f.scan({targetId:a.id,titleQuery:'not-present'})
  assert.equal(page.total,0);assert.equal(page.sourceCounts?.[a.id],1)
  page=await f.scan({targetId:a.id,contentQuery:'ACCOUNT_CONVERSATION'})
  assert.equal(page.total,1)
  assert.equal(page.items[0].capabilities?.contentSearch,true)
  assert.deepEqual(page.warnings,[])
  page=await f.scan({targetId:a.id,contentQuery:'not-present'})
  assert.equal(page.total,0);assert.equal(page.sourceCounts?.[a.id],1)
})

test('Claude opening rechecks the instance account binding, revision and safe managed directory',async t=>{
  const f=fixture(t),id=randomUUID(),a=claudeSource(f,'claude-boundary',id)
  const page=await f.scan({targetId:a.id}),selection={snapshotId:page.snapshotId,sessionId:page.items[0].id,targetId:a.id}
  f.store.transaction(state=>{state.instances![0].accountId=randomUUID();state.instances![0].revision++})
  await assert.rejects(f.catalog.location(selection),/实例已变化/)
  f.store.transaction(state=>{state.instances=[a.profile]})
  renameSync(join(f.store.directory,'instances',a.id),join(f.root,'moved-instance'))
  symlinkSync(join(f.root,'moved-instance'),join(f.store.directory,'instances',a.id))
  await assert.rejects(f.catalog.location(selection),/链接|目录|替换/)
  const changed=await f.scan({targetId:a.id})
  assert.equal(changed.total,0)
  assert.ok(changed.warnings.some(warning=>warning.includes('安全读取')))
})

test('cancelled Claude scans never publish a partial catalog',async t=>{
  const f=fixture(t),a=claudeSource(f,'claude-cancel',randomUUID()),before=await f.scan({targetId:a.id})
  const runId=randomUUID(),pending=f.scan({runId,targetId:a.id})
  f.catalog.cancel(runId)
  await assert.rejects(pending,/已取消/)
  assert.throws(()=>f.catalog.page({snapshotId:before.snapshotId,page:1}),/已更新/)
})

test('unified client and project filters include only requested sources and retain full source counts',async t=>{
  const f=fixture(t),codex=f.source('filtered-codex'),a=claudeSource(f,'filtered-claude',randomUUID())
  rollout(codex.home,randomUUID())
  let page=await f.scan({clientType:'claude_code',projectQuery:'CLAUDE-WORKSPACE'})
  assert.equal(page.total,1);assert.equal(page.items[0].locations[0].targetId,a.id)
  assert.equal(page.sourceCounts?.[a.id],1)
  page=await f.scan({clientType:'codex',projectQuery:'/fixture/project'})
  assert.equal(page.total,1);assert.equal(page.items[0].clientType,'codex')
  page=await f.scan({clientType:'claude_code',projectQuery:'not-present'})
  assert.equal(page.total,0);assert.equal(page.sourceCounts?.[a.id],1)
  page=await f.scan({clientType:'codex',targetId:a.id})
  assert.equal(page.total,0)
})

test('Claude body reading is scoped to a selected snapshot and retains all existing files',async t=>{
  const f=fixture(t),id=randomUUID(),a=claudeSource(f,'reader-a',id),b=claudeSource(f,'reader-b',id),before=hashes(f.root)
  const page=await f.scan(),row=page.items.find(record=>record.locations[0].targetId===a.id)!,selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:a.id}
  const content=await f.catalog.content({...selection,pageSize:1})
  assert.equal(content.sourceSessionId,id);assert.equal(content.title,'reader-a history')
  assert.equal(content.total,1);assert.equal(content.messages[0].blocks[0].text,'ACCOUNT_CONVERSATION_BODY_NOT_RETURNED')
  assert.equal(content.sourceName,page.sources?.find(source=>source.id===a.id)?.name)
  await assert.rejects(f.catalog.content({...selection,targetId:b.id}),/不属于/)
  assert.deepEqual(hashes(f.root),before)
  f.store.transaction(state=>{state.instances!.find(profile=>profile.id===a.id)!.revision++})
  await assert.rejects(f.catalog.content(selection),/实例已变化/)
  f.store.transaction(state=>{state.instances=[a.profile,b.profile]})
  appendFileSync(a.path,JSON.stringify({type:'user',sessionId:id,cwd:a.cwd,message:{content:'next message'}})+'\n')
  await assert.rejects(f.catalog.content(selection),/来源已变化/)
  await f.scan()
  await assert.rejects(f.catalog.content(selection),/列表已更新/)
})

test('Claude native and API Desktop list only their isolated local Code transcripts and do not offer CLI resume',async t=>{
  const f=fixture(t),a=claudeSource(f,'desktop-api',randomUUID()),b=claudeSource(f,'desktop-login',randomUUID())
  f.store.transaction(state=>{
    state.instances=state.instances!.map(profile=>({...profile,launchMode:'desktop',...(profile.id===b.id?{connectionMode:'client_login',accountId:'',model:''}:{})}))
  })
  for(const source of [a,b]){
    const remote=join(source.home,'projects','ssh-sessions'),cloud=join(f.store.directory,'instances',source.id,'desktop','local-agent-mode-sessions','account','task','.claude','projects','cloud')
    mkdirSync(remote,{recursive:true});mkdirSync(cloud,{recursive:true})
    writeFileSync(join(remote,randomUUID()+'.jsonl'),'REMOTE_BODY_MUST_NOT_BE_PARSED')
    writeFileSync(join(cloud,randomUUID()+'.jsonl'),'CLOUD_BODY_MUST_NOT_BE_PARSED')
  }
  const page=await f.scan({clientType:'claude_code'})
  assert.equal(page.total,2);assert.deepEqual(page.warnings,[])
  for(const row of page.items){
    assert.equal(row.launchMode,'desktop');assert.equal(row.capabilities?.content,true);assert.equal(row.capabilities?.resume,false)
    assert.match(row.resumeBlockedReason!,/Claude Desktop/)
    const selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:row.locations[0].targetId}
    assert.equal((await f.catalog.content(selection)).total,1)
    await assert.rejects(f.catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}),/Claude Desktop/)
  }
})

test('Claude resume plans bind instance revision, original project and source before every launch',async t=>{
  const f=fixture(t),a=claudeSource(f,'resume-a',randomUUID()),b=claudeSource(f,'resume-b',randomUUID())
  const page=await f.scan(),row=page.items.find(record=>record.locations[0].targetId===a.id)!,selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:a.id,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}
  assert.equal(row.capabilities?.resume,true)
  const preview=await f.catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]})
  assert.equal(preview.instanceId,a.id);assert.equal(preview.instanceRevision,a.profile.revision);assert.equal(preview.cwd,a.cwd)
  assert.equal(preview.profileFingerprint.length,64);assert.equal(preview.sourceId.length,64)
  assert.deepEqual(preview.args,['--resume',row.sourceSessionId])
  await assert.rejects(f.catalog.claudeResume({...selection,targetId:b.id}),/不属于/)
  f.store.transaction(state=>{state.instances!.find(profile=>profile.id===a.id)!.accountId=randomUUID()})
  await assert.rejects(f.catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}),/实例已变化/)
  f.store.transaction(state=>{state.instances=[a.profile,b.profile]})
  const duplicate=join(a.home,'projects','new-copy');mkdirSync(duplicate);writeFileSync(join(duplicate,row.sourceSessionId+'.jsonl'),readFileSync(a.path))
  await assert.rejects(f.catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}),/冲突/)
})

test('Claude session cwd choices remain bound to source snapshot and reject replacement before preview',async t=>{
  const f=fixture(t),a=claudeSource(f,'multi-cwd',randomUUID()),alternate=join(f.root,'alternate-cwd')
  mkdirSync(alternate)
  appendFileSync(a.path,JSON.stringify({type:'assistant',sessionId:JSON.parse(readFileSync(a.path,'utf8').split('\n')[0]).sessionId,cwd:alternate,message:{content:'second recorded project'}})+'\n')
  const page=await f.scan({targetId:a.id}),row=page.items[0]!
  assert.deepEqual(row.cwdCandidates,[a.cwd,alternate]);assert.deepEqual(row.cwdAvailableCandidates,[a.cwd,alternate])
  const selected={snapshotId:page.snapshotId,sessionId:row.id,targetId:a.id,sourceId:row.resumeSourceId!,cwd:alternate}
  renameSync(alternate,alternate+'-old');mkdirSync(alternate)
  await assert.rejects(f.catalog.claudeResume(selected),/项目目录身份已变化|项目目录已变化|来源已变化/)
})

test('Claude resume is disabled while running or when the original workspace has disappeared',async t=>{
  const f=fixture(t),a=claudeSource(f,'resume-state',randomUUID())
  let running=true
  const catalog=new SessionCatalog(f.store,id=>id===a.id&&running,{defaultClaudeDirectory:null})
  t.after(()=>catalog.stop())
  let page=await catalog.scan({runId:randomUUID(),targetId:a.id}),selection={snapshotId:page.snapshotId,sessionId:page.items[0].id,targetId:a.id,sourceId:page.items[0].resumeSourceId!,cwd:page.items[0].cwdCandidates![0]}
  assert.equal(page.items[0].capabilities?.resume,false)
  await assert.rejects(catalog.claudeResume(selection),/正在运行/)
  running=false
  assert.equal((await catalog.claudeResume(selection)).instanceId,a.id)
  rmSync(a.cwd,{recursive:true})
  page=await catalog.scan({runId:randomUUID(),targetId:a.id});selection={snapshotId:page.snapshotId,sessionId:page.items[0].id,targetId:a.id,sourceId:page.items[0].resumeSourceId!,cwd:page.items[0].cwdCandidates![0]}
  assert.equal(page.items[0].capabilities?.resume,false);assert.match(page.items[0].resumeBlockedReason!,/项目目录不可用/)
  await assert.rejects(catalog.claudeResume({...selection,sourceId:page.items[0].resumeSourceId!,cwd:page.items[0].cwdCandidates![0]}),/项目目录不可用/)
})

test('default Claude source is discovered only for an existing safe native projects directory',async t=>{
  const f=fixture(t),directory=join(f.root,'default-claude'),catalog=new SessionCatalog(f.store,undefined,{defaultClaudeDirectory:directory})
  t.after(()=>catalog.stop())
  let page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  assert.ok(!page.sources?.some(source=>source.clientType==='claude_code'))
  mkdirSync(directory)
  page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  assert.ok(!page.sources?.some(source=>source.clientType==='claude_code'))
  const external=join(f.root,'outside-projects');mkdirSync(external);symlinkSync(external,join(directory,'projects'))
  page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  assert.ok(!page.sources?.some(source=>source.clientType==='claude_code'))
  rmSync(join(directory,'projects'));mkdirSync(join(directory,'projects'))
  page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  const source=page.sources?.find(source=>source.clientType==='claude_code')
  assert.equal(source?.role,'default');assert.equal(source?.directory,directory)
  assert.equal(source?.managed,false);assert.equal(source?.readOnly,true)
  assert.equal(page.sourceCounts?.[source!.id],0)
})

test('default Claude conversations remain separate from managed instances and cannot inherit credentials or resume',async t=>{
  const f=fixture(t),sessionId=randomUUID(),instance=claudeSource(f,'managed',sessionId),directory=join(f.root,'default-claude'),project=join(directory,'projects','default-project')
  mkdirSync(project,{recursive:true})
  const path=join(project,sessionId+'.jsonl')
  writeFileSync(path,JSON.stringify({type:'user',sessionId,cwd:f.root,message:{content:'Default local conversation'}})+'\n')
  writeFileSync(join(directory,'.credentials.json'),JSON.stringify({accessToken:'DEFAULT_CREDENTIAL_MUST_NOT_ENTER_CATALOG'}))
  const before=hashes(f.root),state=f.store.read(),catalog=new SessionCatalog(f.store,undefined,{defaultClaudeDirectory:directory})
  t.after(()=>catalog.stop())
  const page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  assert.equal(page.total,2)
  const source=page.sources!.find(source=>source.clientType==='claude_code'&&source.role==='default')!,row=page.items.find(record=>record.locations[0].targetId===source.id)!
  assert.notEqual(row.id,page.items.find(record=>record.locations[0].targetId===instance.id)!.id)
  assert.equal(row.sourceSessionId,sessionId);assert.equal(row.capabilities?.resume,true);assert.equal(row.resumeMode,'default_fork')
  const selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:source.id}
  assert.equal(await catalog.location(selection),path)
  assert.equal((await catalog.content(selection)).messages[0].blocks[0].text,'Default local conversation')
  const defaultResume=await catalog.defaultClaudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]})
  assert.equal(defaultResume.sessionId,sessionId);assert.equal(defaultResume.location.cwd,f.root);assert.equal(defaultResume.homeDirectory,dirname(directory))
  await assert.rejects(catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}),/未绑定管理器实例/)
  assert.deepEqual(f.store.read(),state);assert.deepEqual(hashes(f.root),before)
  assert.ok(!JSON.stringify(page).includes('DEFAULT_CREDENTIAL'))
  const moved=directory+'-old';renameSync(directory,moved);mkdirSync(project,{recursive:true});writeFileSync(path,readFileSync(join(moved,'projects','default-project',sessionId+'.jsonl')))
  await assert.rejects(catalog.content(selection),/已被替换|已变化/)
})

test('default Claude fork is blocked for conflicts, mixed IDs, incomplete scans, Desktop records and vanished projects',async t=>{
  const f=fixture(t),directory=join(f.root,'default-claude'),project=join(directory,'projects','one'),projectTwo=join(directory,'projects','two'),sessionId=randomUUID()
  mkdirSync(project,{recursive:true})
  const transcript=join(project,sessionId+'.jsonl')
  writeFileSync(transcript,JSON.stringify({type:'user',sessionId,cwd:f.root,message:{content:'Fixture'}})+'\n')
  const catalog=new SessionCatalog(f.store,undefined,{defaultClaudeDirectory:directory});t.after(()=>catalog.stop())
  let page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'}),row=page.items.find(value=>value.sourceSessionId===sessionId)!,selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:row.locations[0].targetId,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}
  assert.equal((await catalog.defaultClaudeResume(selection)).sessionId,sessionId)
  mkdirSync(projectTwo);writeFileSync(join(projectTwo,sessionId+'.jsonl'),readFileSync(transcript))
  await assert.rejects(catalog.defaultClaudeResume(selection),/多个会话文件|冲突/)
  rmSync(projectTwo,{recursive:true})
  const otherId=randomUUID();appendFileSync(transcript,JSON.stringify({type:'user',sessionId:otherId,cwd:f.root,message:{content:'second'}})+'\n')
  page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'});row=page.items.find(value=>value.sourceSessionId===sessionId)!;selection={snapshotId:page.snapshotId,sessionId:row.id,targetId:row.locations[0].targetId,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]}
  assert.equal(row.capabilities?.resume,false);await assert.rejects(catalog.defaultClaudeResume(selection),/多个会话 ID|不能安全/)
  rmSync(f.root,{recursive:true,force:true});await assert.rejects(catalog.defaultClaudeResume(selection))
})

test('default Claude duplicate IDs retain independent files and stale or linked roots cannot be read',async t=>{
  const f=fixture(t),directory=join(f.root,'default-claude'),project=join(directory,'projects','one'),other=join(directory,'projects','two'),sessionId=randomUUID()
  mkdirSync(project,{recursive:true});mkdirSync(other)
  const body=JSON.stringify({type:'user',sessionId,cwd:f.root,message:{content:'Default history'}})+'\n'
  for(const parent of [project,other])writeFileSync(join(parent,sessionId+'.jsonl'),body)
  const catalog=new SessionCatalog(f.store,undefined,{defaultClaudeDirectory:directory});t.after(()=>catalog.stop())
  const page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'})
  assert.equal(page.total,2);assert.ok(page.items.every(row=>row.locations[0].ambiguous))
  const selection={snapshotId:page.snapshotId,sessionId:page.items[0].id,targetId:page.items[0].locations[0].targetId}
  assert.equal((await catalog.content(selection)).total,1)
  renameSync(directory,directory+'-moved');symlinkSync(directory+'-moved',directory)
  await assert.rejects(catalog.content(selection),/目录已变化/)
})
