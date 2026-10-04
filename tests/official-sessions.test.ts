import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,lstatSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {rebuildSessionMetadata} from '../src/main/officialSessions'

const path=realpathSync(process.execPath),stat=lstatSync(path),program={path,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs}
function fixture(t:{after(fn:()=>void):void}){const home=realpathSync(mkdtempSync(join(tmpdir(),'cml-indexer-')));t.after(()=>rmSync(home,{recursive:true,force:true}));return home}
const prelude=String.raw`const rl=require('node:readline').createInterface({input:process.stdin});const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');let initialized=false;rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){reply(m.id,{serverInfo:{name:'fixture'}});return}if(m.method==='initialized'){initialized=true;return}if(!initialized)process.exit(3);`

test('official indexer initializes stdio, scans every provider/source including archives, paginates and verifies actual IDs',async t=>{
  const home=fixture(t),signal=new AbortController().signal;let pid:number|undefined
  await rebuildSessionMetadata(program,home,['active','archived'],signal,(path,args,options)=>{
    assert.equal(path,program.path);assert.ok(args.includes('cli_auth_credentials_store="file"'));assert.ok(args.includes('log_dir='+JSON.stringify(join(home,'log'))));assert.deepEqual(Object.keys(options.env!).sort(),['CODEX_HOME','LANG','PATH','TMPDIR']);assert.equal(options.env!.CODEX_HOME,home)
    const script=prelude+`if(m.method!=='thread/list'||m.params.useStateDbOnly!==false||m.params.modelProviders.length||!m.params.sourceKinds.includes('appServer'))process.exit(4);if(!m.params.archived)reply(m.id,{data:[{id:'active'}],nextCursor:null});else if(!m.params.cursor)reply(m.id,{data:[],nextCursor:'next'});else reply(m.id,{data:[{id:'archived'}],nextCursor:null});});`
    const child=spawn(process.execPath,['-e',script],{...options,stdio:['pipe','pipe','pipe']});pid=child.pid;return child
  })
  assert.ok(pid);assert.throws(()=>process.kill(pid!,0),/ESRCH/)
})

test('missing IDs, repeated cursors and malformed JSON fail visibly without exposing raw provider data',async t=>{
  const home=fixture(t)
  for(const [body,expected] of [[`reply(m.id,{data:[],nextCursor:null})`,/仍缺少/],[`reply(m.id,{data:Array(101).fill({id:'unselected'}),nextCursor:null})`,/格式无效/],[`reply(m.id,{data:[],nextCursor:'same'})`,/游标/],[String.raw`process.stdout.write('fixture-secret-not-json\n')`,/有效 JSON/],[String.raw`process.stdout.write(JSON.stringify({id:m.id,error:{message:'fixture-secret'}})+'\n')`,/拒绝/]] as const){
    await assert.rejects(rebuildSessionMetadata(program,home,['missing'],new AbortController().signal,(_path,_args,options)=>spawn(process.execPath,['-e',prelude+body+';});'],{...options,stdio:['pipe','pipe','pipe']})),error=>{assert.match(String(error),expected);assert.equal(String(error).includes('fixture-secret'),false);return true})
  }
})

test('cancelled indexer kills only its subprocess group, including a process ignoring TERM; spawn failure settles',async t=>{
  const home=fixture(t),controller=new AbortController();let pid:number|undefined
  const started=Date.now(),task=rebuildSessionMetadata(program,home,['missing'],controller.signal,(_path,_args,options)=>{
    const child=spawn(process.execPath,['-e',String.raw`process.on('SIGTERM',()=>{});process.stdout.write('{}\n');setInterval(()=>{},1000)`],{...options,stdio:['pipe','pipe','pipe']});pid=child.pid
    // Wait until the child installed the handler before requesting cancellation.
    child.stdout.once('data',()=>controller.abort());return child
  })
  await assert.rejects(task,/取消|JSON/);assert.ok(Date.now()-started<4000);assert.ok(pid);assert.throws(()=>process.kill(pid!,0),/ESRCH/)
  await assert.rejects(rebuildSessionMetadata(program,home,[],new AbortController().signal,(_path,_args,options)=>spawn(join(home,'missing-program'),[],{...options,stdio:['pipe','pipe','pipe']})),/启动|退出/)
})

test('deletion preview includes nested spawned descendants across active/archive pages and validates disk paths',async t=>{
  const {planSessionDeletion}=await import('../src/main/officialSessions'),{randomUUID}=await import('node:crypto'),home=fixture(t)
  const root=randomUUID(),child=randomUUID(),grandchild=randomUUID(),unrelated=randomUUID(),file=(id:string)=>join(home,'sessions','rollout-'+id+'.jsonl')
  const rows=[{id:root,path:file(root),parentThreadId:null},{id:child,path:file(child),parentThreadId:null,source:{subAgent:{thread_spawn:{parent_thread_id:root,depth:1}}}},{id:unrelated,path:file(unrelated),parentThreadId:null}]
  const spawnFixture=(values:unknown[],archives:unknown[]=[])=>((_path:string,_args:string[],options:any)=>spawn(process.execPath,['-e',prelude+`if(m.method!=='thread/list')process.exit(4);reply(m.id,{data:m.params.archived?${JSON.stringify(archives)}:${JSON.stringify(values)},nextCursor:null});});`],{...options,stdio:['pipe','pipe','pipe']}))
  const result=await planSessionDeletion(program,home,[root],new AbortController().signal,spawnFixture(rows,[{id:grandchild,path:join(home,'archived_sessions','rollout-'+grandchild+'.jsonl'),parentThreadId:child}]))
  assert.deepEqual(result.map(row=>row.id),[root,child,grandchild]);assert.deepEqual(result.map(row=>row.descendant),[false,true,true])
  await assert.rejects(planSessionDeletion(program,home,[root],new AbortController().signal,spawnFixture([{...rows[0],path:join(home,'..','outside','rollout-'+root+'.jsonl')}])),/目录之外/)
  await assert.rejects(planSessionDeletion(program,home,[root],new AbortController().signal,spawnFixture(rows,[{...rows[0],parentThreadId:child}])),/冲突/)
})

test('official deletion sends only declared roots, distinguishes RPC failures, and verifies absence in active and archive indexes',async t=>{
  const {deleteSessionThreads,verifyDeletedSessionMetadata}=await import('../src/main/officialSessions'),{randomUUID}=await import('node:crypto'),home=fixture(t),ids=[randomUUID(),randomUUID()]
  const result=await deleteSessionThreads(program,home,[...ids,ids[0]],new AbortController().signal,(_path,_args,options)=>spawn(process.execPath,['-e',prelude+`if(m.method!=='thread/delete'||!${JSON.stringify(ids)}.includes(m.params.threadId))process.exit(4);if(m.params.threadId===${JSON.stringify(ids[0])})reply(m.id,{});else process.stdout.write(JSON.stringify({id:m.id,error:{message:'fixture-secret'}})+'\\n');});`],{...options,stdio:['pipe','pipe','pipe']}))
  assert.deepEqual(result,{deletedIds:[ids[0]],failedIds:[ids[1]]})
  for(const present of [false,true]){
    const operation=verifyDeletedSessionMetadata(program,home,ids,new AbortController().signal,(_path,_args,options)=>spawn(process.execPath,['-e',prelude+`reply(m.id,{data:m.params.archived&&${present}?[{id:${JSON.stringify(ids[0])}}]:[],nextCursor:null});});`],{...options,stdio:['pipe','pipe','pipe']}))
    if(present)await assert.rejects(operation,/仍显示/);else await operation
  }
  let spawned=false;await assert.rejects(deleteSessionThreads(program,home,['bad'],new AbortController().signal,()=>{spawned=true;throw new Error('unexpected')}));assert.equal(spawned,false)
})
