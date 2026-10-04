import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,lstatSync,existsSync,rmSync,readdirSync,appendFileSync,symlinkSync,renameSync} from 'node:fs'
import {join,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {prepareTrashBatch,deleteTrashOriginals,restoreTrashBatch,loadTrashJournal,purgeTrashBatch,removeTrashIndexEntries,restoreTrashIndexEntries,saveTrashJournal,type TrashRuntime,type TrashJournal} from '../src/main/sessionTrashFiles'
import {textHash} from '../src/main/sessionTransferFiles'

const signal=()=>new AbortController().signal
const executable=realpathSync(process.execPath),stat=lstatSync(executable),program={path:executable,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs}
const when='2026-10-01T08:00:00Z'
function rollout(root:string,id:string,archive=false,suffix=''){const folder=archive?join(root,'archived_sessions'):join(root,'sessions','2026','10','01');mkdirSync(folder,{recursive:true});const file=join(folder,`rollout-2026-10-01T08-00-00-${id}${suffix}.jsonl`);writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:'/fixture/中文项目',model_provider:'keep-provider',unknown:{keep:true}},timestamp:when})+'\r\n'+JSON.stringify({type:'event_msg',timestamp:when,payload:{type:'user_message',message:'中文 🧪 special \\ literal\nnewline'}})+'\n');return file}
async function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-trash-'))),home=join(root,'home'),trash=join(root,'trash');mkdirSync(home);mkdirSync(trash)
  const store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),config=new ClientConfigs(store),target=config.register(home),catalog=new SessionCatalog(store)
  t.after(()=>{catalog.stop();rmSync(root,{recursive:true,force:true})})
  const parent=randomUUID(),child=randomUUID(),other=randomUUID(),first=rollout(home,parent),duplicate=rollout(home,parent,false,'_duplicate'),descendant=rollout(home,child,true),unrelated=rollout(home,other)
  const before=new Map([first,duplicate,descendant,unrelated].map(path=>[path,readFileSync(path)])),index='malformed unrelated\r\n'+JSON.stringify({id:parent,thread_name:'父会话',unknown:{preserve:true}})+'\n'+JSON.stringify({id:child,thread_name:'派生会话',extra:2})+'\n'+JSON.stringify({id:other,thread_name:'其他'})+'\n'
  writeFileSync(join(home,'session_index.jsonl'),index)
  const closure=[{id:parent,path:first,descendant:false},{id:child,path:descendant,parentId:parent,descendant:true}]
  const runtime:TrashRuntime={plan:async()=>closure,remove:async(_p,_h,ids)=>({deletedIds:ids,failedIds:[]}),verify:async()=>{},rebuild:async()=>{}}
  async function prepare(progress?:(bytes:number)=>void,controller=new AbortController()){
    const page=await catalog.scan({runId:randomUUID(),targetId:target.id}),sources=(await catalog.syncSources(page.snapshotId,signal())).filter(source=>source.record.id!==other)
    return prepareTrashBatch(trash,{targetId:target.id,targetName:'Fixture',root:home,sources,selectedIds:[parent],closure,configHash:textHash(null)},controller.signal,progress)
  }
  return {root,home,trash,store,target,catalog,parent,child,other,first,duplicate,descendant,unrelated,before,index,closure,runtime,prepare}
}

test('trash backs up every same-ID copy and spawned archive before deletion, preserves bytes, mtime, index and provider on restore',async t=>{
  const f=await fixture(t),{folder,journal}=await f.prepare();assert.equal(journal.phase,'backed_up');assert.equal(journal.files.length,3)
  for(const file of journal.files){assert.deepEqual(readFileSync(join(folder,file.backup)),f.before.get(join(f.home,file.relative)));assert.ok(Math.abs(lstatSync(join(folder,file.backup)).mtimeMs-file.source.mtime)<1)}
  let removed=0,indexed=0
  f.runtime.remove=async(_p,home,ids)=>{assert.equal(home,f.home);assert.deepEqual(ids,[f.parent]);for(const file of journal.files)assert.ok(existsSync(join(folder,file.backup)));rmSync(f.first);rmSync(f.descendant);removed++;return {deletedIds:ids,failedIds:[]}}
  f.runtime.verify=async(_p,home,ids)=>{assert.deepEqual(ids,[f.parent,f.child]);for(const path of [f.first,f.duplicate,f.descendant])assert.equal(existsSync(path),false);assert.equal(home,f.home)}
  f.runtime.rebuild=async(_p,home,ids)=>{assert.equal(home,f.home);assert.deepEqual(new Set(ids),new Set([f.parent,f.child]));for(const path of [f.first,f.duplicate,f.descendant])assert.equal(lstatSync(path).nlink,1);indexed++}
  const deleted=await deleteTrashOriginals(folder,program,signal(),f.runtime);assert.equal(deleted.phase,'trashed');assert.equal(deleted.indexPending,false);assert.equal(removed,1);assert.deepEqual(readFileSync(f.unrelated),f.before.get(f.unrelated))
  const remaining=readFileSync(join(f.home,'session_index.jsonl'),'utf8');assert.equal(remaining,'malformed unrelated\r\n'+JSON.stringify({id:f.other,thread_name:'其他'})+'\n')
  const restored=await restoreTrashBatch(folder,program,signal(),f.runtime);assert.equal(restored.phase,'restored');assert.equal(indexed,1)
  for(const [path,before] of f.before)assert.deepEqual(readFileSync(path),before)
  const index=readFileSync(join(f.home,'session_index.jsonl'),'utf8');assert.ok(index.includes('malformed unrelated\r\n'));assert.deepEqual(JSON.parse(index.split('\n').find(line=>line.includes(f.parent))!).unknown,{preserve:true});assert.equal(existsSync(join(f.home,'.cml-trash-restore-'+journal.id)),false)
  purgeTrashBatch(folder);assert.equal(existsSync(folder),false);for(const path of f.before.keys())assert.ok(existsSync(path))
})

test('changed source, new duplicate, new descendant and tampered backup refuse official destruction',async t=>{
  for(const mode of ['source','duplicate','descendant','backup','config','index'] as const){
    const f=await fixture(t),{folder}=await f.prepare();let removed=false;f.runtime.remove=async()=>{removed=true;return {deletedIds:[],failedIds:[]}}
    if(mode==='source')appendFileSync(f.first,'new text')
    if(mode==='duplicate')rollout(f.home,f.parent,false,'_new')
    if(mode==='descendant')f.runtime.plan=async()=>[...f.closure,{id:randomUUID(),descendant:true}]
    if(mode==='backup')appendFileSync(join(folder,'0.jsonl'),'tamper')
    if(mode==='config')writeFileSync(join(f.home,'config.toml'),'model="changed"')
    if(mode==='index')appendFileSync(join(f.home,'session_index.jsonl'),'user index update\n')
    await assert.rejects(deleteTrashOriginals(folder,program,signal(),f.runtime),/变化|备份/);assert.equal(removed,false);assert.equal(loadTrashJournal(folder).phase,'backed_up');assert.ok(existsSync(f.descendant))
  }
})

test('partial official failure falls back to verified physical files, and index failure leaves a retryable batch',async t=>{
  const f=await fixture(t),{folder}=await f.prepare()
  f.runtime.remove=async()=>{rmSync(f.first);throw new Error('fixture official unavailable')}
  f.runtime.verify=async()=>{throw new Error('fixture index failure')}
  await assert.rejects(deleteTrashOriginals(folder,program,signal(),f.runtime),/已移入废纸篓.*索引/)
  let saved=loadTrashJournal(folder);assert.equal(saved.phase,'trashed');assert.equal(saved.officialFallback,true);assert.equal(saved.indexPending,true);assert.throws(()=>purgeTrashBatch(folder),/索引/)
  f.runtime.remove=async(_p,_h,ids)=>({deletedIds:ids,failedIds:[]});f.runtime.verify=async()=>{}
  saved=await deleteTrashOriginals(folder,program,signal(),f.runtime);assert.equal(saved.indexPending,false)
  purgeTrashBatch(folder);assert.equal(existsSync(folder),false);assert.ok(existsSync(f.unrelated))
})

test('cancellation after official partial deletion preserves the complete backup and can restore without finishing deletion',async t=>{
  const f=await fixture(t),{folder}=await f.prepare(),controller=new AbortController()
  f.runtime.remove=async()=>{rmSync(f.first);controller.abort();throw new Error('aborted')}
  await assert.rejects(deleteTrashOriginals(folder,program,controller.signal,f.runtime),/abort/i)
  assert.equal(loadTrashJournal(folder).phase,'deleting');assert.equal(existsSync(f.first),false);assert.ok(existsSync(f.duplicate));assert.throws(()=>purgeTrashBatch(folder),/恢复/)
  await restoreTrashBatch(folder,program,signal(),f.runtime)
  for(const [path,before] of f.before)assert.deepEqual(readFileSync(path),before)
})

test('large raw backup is cancellable and removes only its incomplete private batch',async t=>{
  const f=await fixture(t);appendFileSync(f.first,Buffer.alloc(12*1024**2,120));const controller=new AbortController();let progress=0
  await assert.rejects(f.prepare(bytes=>{progress=bytes;if(bytes>512*1024)controller.abort()},controller),/abort/i)
  assert.ok(progress<2*1024**2);assert.deepEqual(readdirSync(f.trash),[]);assert.ok(lstatSync(f.first).size>12*1024**2);assert.equal(readFileSync(join(f.home,'session_index.jsonl'),'utf8'),f.index)
})

test('same-ID different body and another session at the original path both conflict; identical existing file is preserved',async t=>{
  const f=await fixture(t),{folder}=await f.prepare();await deleteTrashOriginals(folder,program,signal(),f.runtime)
  writeFileSync(f.first,JSON.stringify({type:'session_meta',payload:{id:f.parent}}));await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/变化/);assert.ok(existsSync(folder));assert.equal(loadTrashJournal(folder).phase,'trashed')
  writeFileSync(f.first,JSON.stringify({type:'session_meta',payload:{id:randomUUID()}}));await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/变化/)
  writeFileSync(f.first,f.before.get(f.first)!);const inode=lstatSync(f.first).ino
  await restoreTrashBatch(folder,program,signal(),f.runtime);assert.equal(lstatSync(f.first).ino,inode)
})

test('restore index failure preserves installed files and resumes without overwriting user edits',async t=>{
  const f=await fixture(t),{folder}=await f.prepare();await deleteTrashOriginals(folder,program,signal(),f.runtime)
  f.runtime.rebuild=async()=>{throw new Error('fixture indexing failed')}
  await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/indexing failed/);assert.equal(loadTrashJournal(folder).phase,'restoring');assert.ok(existsSync(f.first))
  const inode=lstatSync(f.first).ino;appendFileSync(f.first,'user edit');await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/变化/)
  writeFileSync(f.first,f.before.get(f.first)!);f.runtime.rebuild=async()=>{};await restoreTrashBatch(folder,program,signal(),f.runtime);assert.equal(lstatSync(f.first).ino,inode)
})

test('symlink directories, replaced homes, unsafe manifest paths and unknown purge content are rejected',async t=>{
  const f=await fixture(t),{folder}=await f.prepare();await deleteTrashOriginals(folder,program,signal(),f.runtime)
  renameSync(join(f.home,'sessions'),join(f.home,'sessions-old'));symlinkSync(join(f.home,'sessions-old'),join(f.home,'sessions'))
  await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/目录|链接/)
  rmSync(join(f.home,'sessions'));renameSync(join(f.home,'sessions-old'),join(f.home,'sessions'))
  renameSync(f.home,f.home+'-old');mkdirSync(f.home);await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/替换/);rmSync(f.home,{recursive:true});renameSync(f.home+'-old',f.home)
  const raw=readFileSync(join(folder,'journal.json'),'utf8'),invalid=JSON.parse(raw);invalid.files[0].relative='../outside';writeFileSync(join(folder,'journal.json'),JSON.stringify(invalid));assert.throws(()=>loadTrashJournal(folder));writeFileSync(join(folder,'journal.json'),raw)
  writeFileSync(join(folder,'unknown.txt'),'not owned');assert.throws(()=>purgeTrashBatch(folder),/未识别/);assert.ok(existsSync(folder))
})

test('index pruning preserves raw unrelated lines and restoration merges unknown fields including literal prototype keys',async t=>{
  const f=await fixture(t),{journal}=await f.prepare()
  const raw=JSON.stringify({id:f.other,extra:'preserve'})+'\r\n'+JSON.stringify({id:f.parent,value:'old'})+'\n'+'broken no newline'
  assert.equal(removeTrashIndexEntries(raw,new Set([f.parent])),JSON.stringify({id:f.other,extra:'preserve'})+'\r\n'+'broken no newline')
  journal.indexBefore='{"id":"'+f.parent+'","__proto__":{"safe":true},"thread_name":"restore"}\n';journal.indexHash=textHash(journal.indexBefore)
  const restored=restoreTrashIndexEntries(raw,journal),entry=JSON.parse(restored.split('\n').find(line=>line.includes(f.parent))!)
  assert.deepEqual(entry.__proto__,{safe:true});assert.equal(entry.value,'old');assert.equal(entry.thread_name,'restore');assert.ok(restored.includes('broken no newline\n'))
})

test('real process SIGKILL during official deletion or post-publication indexing recovers from durable backups',async t=>{
  const {spawn}=await import('node:child_process')
  for(const phase of ['deleting','restoring']){
    const f=await fixture(t),{folder}=await f.prepare()
    if(phase==='restoring')await deleteTrashOriginals(folder,program,signal(),f.runtime)
    const child=spawn(process.execPath,['--import','tsx','tests/fixtures/session-trash-crash.ts',folder,phase],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',data=>{stderr+=String(data)})
    const closed=new Promise(resolve=>child.once('close',resolve))
    try{
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Crash fixture timed out: '+stderr)),5000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.stdout.once('data',data=>{clearTimeout(timer);assert.ok(String(data).includes('fixture-ready'));resolve()});child.once('close',()=>{clearTimeout(timer);reject(new Error('Crash fixture closed: '+stderr))})})
    }finally{child.kill('SIGKILL');await closed}
    assert.equal(loadTrashJournal(folder).phase,phase)
    await restoreTrashBatch(folder,program,signal(),f.runtime)
    for(const [path,before] of f.before)assert.deepEqual(readFileSync(path),before)
    assert.equal(loadTrashJournal(folder).phase,'restored')
  }
})

test('restore preserves external index edits after an interrupted indexing step and handles an empty pre-journal staging directory',async t=>{
  const f=await fixture(t),{folder,journal}=await f.prepare();await deleteTrashOriginals(folder,program,signal(),f.runtime)
  const stage=join(f.home,'.cml-trash-restore-'+journal.id);mkdirSync(stage)
  f.runtime.rebuild=async()=>{throw new Error('fixture index unavailable')}
  await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/index unavailable/)
  const index=join(f.home,'session_index.jsonl');appendFileSync(index,'user addition\n');const changed=readFileSync(index)
  f.runtime.rebuild=async()=>{};await assert.rejects(restoreTrashBatch(folder,program,signal(),f.runtime),/索引已被修改/);assert.deepEqual(readFileSync(index),changed)
  const latest=loadTrashJournal(folder);writeFileSync(index,latest.restoreIndex!.after);await restoreTrashBatch(folder,program,signal(),f.runtime)
  // Simulate crash after the restored marker but before removing an empty stage.
  mkdirSync(stage);const completed=loadTrashJournal(folder),stat=lstatSync(stage);completed.restoreIdentity={device:stat.dev,inode:stat.ino};saveTrashJournal(folder,completed)
  await restoreTrashBatch(folder,program,signal(),f.runtime);assert.equal(existsSync(stage),false)
})

test('unavailable official planning uses only backed-up file paths; selecting parent plus descendant avoids redundant cascading calls',async t=>{
  const f=await fixture(t),{folder}=await f.prepare();let called=false
  f.runtime.plan=async()=>{throw new Error('fixture unavailable')};f.runtime.remove=async()=>{called=true;throw new Error('must not call')}
  const deleted=await deleteTrashOriginals(folder,program,signal(),f.runtime);assert.equal(called,false);assert.equal(deleted.officialFallback,true);assert.equal(existsSync(f.first),false);assert.ok(existsSync(f.unrelated))
  const g=await fixture(t),prepared=await g.prepare(),journal=prepared.journal;journal.selectedIds=[g.child,g.parent];saveTrashJournal(prepared.folder,journal)
  g.runtime.remove=async(_p,_h,ids)=>{assert.deepEqual(ids,[g.parent]);return {deletedIds:ids,failedIds:[]}}
  await deleteTrashOriginals(prepared.folder,program,signal(),g.runtime)
})
