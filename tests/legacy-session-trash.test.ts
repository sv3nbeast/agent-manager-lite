import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,appendFileSync,symlinkSync,linkSync,truncateSync} from 'node:fs'
import {join,dirname,win32} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {setImmediate} from 'node:timers/promises'
import {spawn} from 'node:child_process'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {SessionTrash} from '../src/main/sessionTrash'
import {scanLegacyTrash,verifyLegacyTrash} from '../src/main/legacySessionTrash'
import {loadTrashJournal,deleteTrashOriginals,type TrashRuntime} from '../src/main/sessionTrashFiles'
import {sessionProgram} from '../src/main/officialSessions'
import {textHash} from '../src/main/sessionTransferFiles'

function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-legacy-trash-'))),primary=join(root,'cockpit-data','cockpit-tools-codex-session-trash'),legacy=join(root,'.Trash','cockpit-tools-codex-session-trash');mkdirSync(primary,{recursive:true});mkdirSync(legacy,{recursive:true})
  const store=new Store(join(root,'manager'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),a=join(root,'target-a'),b=join(root,'target-b');mkdirSync(a);mkdirSync(b)
  const targets=[configs.register(a),configs.register(b)],catalog=new SessionCatalog(store),binary=join(root,'codex');writeFileSync(binary,Buffer.from('cffaedfe00000000','hex'),{mode:0o700})
  const apps=[{id:'fixture',name:'Fixture',kind:'cli' as const,path:binary}]
  let calls=0,now=Date.now(),busy=false
  const runtime:TrashRuntime={plan:async()=>{calls++;return []},remove:async()=>{calls++;return{deletedIds:[],failedIds:[]}},verify:async()=>{calls++},rebuild:async()=>{calls++}}
  let trash:SessionTrash;const transfers=new SessionTransfers(store,catalog,()=>apps,id=>trash?.busy(id)??false),create=()=>new SessionTrash(store,catalog,transfers,()=>apps,()=>busy,runtime,()=>now);trash=create()
  let sequence=0
  function backup(options:{base?:string;id?:string;origin?:string;archived?:boolean;title?:string;deletedAt?:string|null;body?:string}={}){
    const id=options.id??randomUUID(),origin=options.origin??join(root,'old-home'),flavor=win32.isAbsolute(origin)&&!origin.startsWith('/')?win32:undefined
    const rel=(options.archived?'archived_sessions/':'sessions/2026/10/01/')+'rollout-2026-10-01T08-00-00-'+id+'.jsonl'
    const folder=join(options.base??primary,'20261001-080000',String(sequence++).padStart(4,'0')+'--'+id),file=join(folder,'files',rel),manifestPath=join(folder,'manifest.json')
    mkdirSync(dirname(file),{recursive:true})
    const raw=JSON.stringify({type:'session_meta',timestamp:'2026-10-01T08:00:00Z',payload:{id,cwd:'/fixture/中文',originator:'codex_cli_rs',cli_version:'0.153.2',timestamp:'2026-10-01T08:00:00Z',model_provider:'openai',source:'cli'}})+'\r\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-01T08:01:00Z',payload:{type:'user_message',message:options.body??'合成旧会话 🌈',images:[],local_images:[],text_elements:[]}})+'\n'
    writeFileSync(file,raw)
    const manifest={sessionId:id,title:options.title??'历史会话',cwd:'/fixture/中文',instanceId:'old',instanceName:flavor?'Windows source':'Old home',instanceRoot:origin,originalRolloutPath:flavor?flavor.join(origin,...rel.split('/')):join(origin,rel),relativeRolloutPath:flavor?rel.replaceAll('/','\\'):rel,sessionIndexEntry:{id,thread_name:options.title??'历史会话',unknown:{keep:'原索引'}},deletedAt:options.deletedAt===undefined?'2026-10-01T09:00:00Z':options.deletedAt}
    writeFileSync(manifestPath,JSON.stringify(manifest)+'\n');return {id,file,folder,manifestPath,manifest,raw,rel}
  }
  const preview=async(path=primary,selected?:string[],service=trash)=>{const page=await service.selectLegacy(path),ids=selected??page.items.map(row=>row.id);return service.previewLegacy({snapshotId:page.snapshotId,sessionIds:ids,mappings:page.groups.map((group,i)=>({sourceId:group.id,targetId:targets[i%targets.length].id}))})}
  const start=async(view:{ticket:string},service=trash)=>{service.start({ticket:view.ticket,confirmed:true});await service.settled();return service.state()}
  t.after(async()=>{await trash.stop();await transfers.stop();catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,primary,legacy,a,b,targets,store,configs,trash,transfers,runtime,apps,create,backup,preview,start,calls:()=>calls,expire:()=>{now+=300001},busy:(value:boolean)=>{busy=value}}
}

test('Cockpit primary/legacy roots, timestamp batches and single entries share validated metadata and exact bytes',async t=>{
  const f=fixture(t),a=f.backup(),b=f.backup({base:f.legacy,archived:true,origin:'C:\\Users\\fixture\\.codex',deletedAt:null})
  for(const path of [f.primary,dirname(a.folder),a.folder,f.legacy]){
    const result=await scanLegacyTrash(path,new AbortController().signal);assert.equal(result.entries.length,1);assert.equal(result.entries[0].sha256,createHash('sha256').update(path===f.legacy?b.raw:a.raw).digest('hex'));await verifyLegacyTrash(result,new AbortController().signal)
  }
  const windows=await scanLegacyTrash(f.legacy,new AbortController().signal);assert.equal(windows.entries[0].relative,b.rel);assert.equal(windows.entries[0].deletedAt,0);assert.equal(existsSync(a.manifest.instanceRoot),false)
})

test('mapped import preserves old sources, never runs a CLI, and restores archived content and unknown index fields',async t=>{
  const f=fixture(t),a=f.backup(),b=f.backup({id:a.id,origin:join(f.root,'old-second'),archived:true}),before=[readFileSync(a.manifestPath),readFileSync(b.manifestPath)]
  const view=await f.preview();assert.equal(view.sessions,1);assert.equal(view.copies,2);assert.equal(view.targets.length,2)
  const done=await f.start(view);assert.equal(done.job?.status,'completed',JSON.stringify(done));assert.equal(done.job?.importedCopies,2);assert.equal(f.calls(),0);assert.deepEqual(readdirSync(f.a),[]);assert.deepEqual(readdirSync(f.b),[])
  const trash=f.trash.list();assert.equal(trash.total,1);assert.equal(trash.items[0].copies,2)
  const restore=await f.trash.previewAction({snapshotId:trash.snapshotId,sessionIds:[a.id],action:'restore',applicationId:'fixture',clientsClosed:true});await f.start(restore)
  assert.equal(readFileSync(join(f.a,a.rel),'utf8'),a.raw);assert.equal(readFileSync(join(f.b,b.rel),'utf8'),b.raw);assert.deepEqual(JSON.parse(readFileSync(join(f.a,'session_index.jsonl'),'utf8')).unknown,{keep:'原索引'})
  assert.equal(f.trash.list().total,0);for(const [i,entry] of [a,b].entries()){assert.equal(readFileSync(entry.file,'utf8'),entry.raw);assert.deepEqual(readFileSync(entry.manifestPath),before[i])}
})

test('reimport skips identical private backups across restart, while different revisions remain recoverable',async t=>{
  const f=fixture(t),a=f.backup();await f.start(await f.preview())
  const next=f.create();next.recover();const duplicate=await f.preview(f.primary,undefined,next);assert.equal(duplicate.copies,0);assert.equal(duplicate.skippedCopies,1);await f.start(duplicate,next);assert.equal(next.list().items[0].copies,1)
  f.backup({id:a.id,deletedAt:'2026-10-01T09:01:00Z',body:'另一个历史版本'});const changed=await f.preview();assert.equal(changed.copies,1);assert.equal(changed.skippedCopies,1);await f.start(changed);assert.equal(f.trash.list().items[0].copies,2)
  const list=f.trash.list(),restore=await f.trash.previewAction({snapshotId:list.snapshotId,sessionIds:[a.id],action:'restore',applicationId:'fixture',clientsClosed:true});const result=await f.start(restore);assert.equal(result.job?.status,'failed');assert.equal(f.trash.list().total,1);assert.ok(existsSync(a.file));assert.ok(existsSync(join(f.a,a.rel)))
})

test('a fresh managed home stays absent during preview and is created only on confirmed import, before later restoration',async t=>{
  const f=fixture(t),entry=f.backup(),owned=f.configs.targets().find(target=>target.managed)!
  const page=await f.trash.selectLegacy(f.primary),view=await f.trash.previewLegacy({snapshotId:page.snapshotId,sessionIds:[entry.id],mappings:[{sourceId:page.groups[0].id,targetId:owned.id}]})
  assert.equal(existsSync(owned.directory),false);assert.equal(existsSync(join(f.store.directory,'session-trash')),false)
  assert.throws(()=>f.trash.start({ticket:view.ticket,confirmed:false}));assert.equal(existsSync(owned.directory),false)
  const done=await f.start(view);assert.equal(done.job?.status,'completed',JSON.stringify(done));assert.equal(done.job?.importedCopies,1);assert.deepEqual(readdirSync(owned.directory),[]);assert.equal(f.calls(),0)
  const list=f.trash.list(),restore=await f.trash.previewAction({snapshotId:list.snapshotId,sessionIds:[entry.id],action:'restore',applicationId:'fixture',clientsClosed:true})
  assert.equal((await f.start(restore)).job?.status,'completed');assert.equal(readFileSync(join(owned.directory,entry.rel),'utf8'),entry.raw);assert.equal(readFileSync(entry.file,'utf8'),entry.raw)
})

test('newly created managed homes and missing external homes invalidate an import without writing backups',async t=>{
  const f=fixture(t),entry=f.backup(),owned=f.configs.targets().find(target=>target.managed)!
  const page=await f.trash.selectLegacy(f.primary),input={snapshotId:page.snapshotId,sessionIds:[entry.id],mappings:[{sourceId:page.groups[0].id,targetId:owned.id}]}
  const preview=await f.trash.previewLegacy(input);mkdirSync(owned.directory,{recursive:true});writeFileSync(join(owned.directory,'keep'),'other process')
  const failed=await f.start(preview);assert.equal(failed.job?.status,'failed');assert.match(failed.job?.error??'',/预览后/);assert.equal(f.trash.list().total,0);assert.equal(readFileSync(join(owned.directory,'keep'),'utf8'),'other process')
  rmSync(f.a,{recursive:true})
  await assert.rejects(f.trash.previewLegacy({...input,mappings:[{sourceId:page.groups[0].id,targetId:f.targets[0].id}]}));assert.equal(existsSync(f.a),false);assert.equal(f.trash.list().total,0)
})

test('source/target changes, stale tickets and unregistered mappings cannot silently change the import scope',async t=>{
  const f=fixture(t),a=f.backup();let view=await f.preview();appendFileSync(a.file,'new bytes');assert.equal((await f.start(view)).job?.status,'failed');assert.equal(f.trash.list().total,0)
  view=await f.preview();writeFileSync(join(f.a,'config.toml'),'model="changed"\n');assert.equal((await f.start(view)).job?.status,'failed');assert.equal(f.trash.list().total,0)
  const page=await f.trash.selectLegacy(f.primary)
  await assert.rejects(f.trash.previewLegacy({snapshotId:page.snapshotId,sessionIds:[randomUUID()],mappings:[{sourceId:page.groups[0].id,targetId:f.targets[0].id}]}),/列表/)
  await assert.rejects(f.trash.previewLegacy({snapshotId:page.snapshotId,sessionIds:[a.id],mappings:[{sourceId:page.groups[0].id,targetId:randomUUID()}]}),/目录/)
  f.expire();assert.throws(()=>f.trash.legacyPage({snapshotId:page.snapshotId,page:1}),/过期/)
  view=await f.preview();f.busy(true);assert.throws(()=>f.trash.start({ticket:view.ticket,confirmed:true}),/正在使用/);f.busy(false)
})

test('malicious manifest paths, mismatched IDs, hardlinks and symlinks are rejected without reading original homes',async t=>{
  for(const mode of ['relative','original','id','symlink','hardlink','manifest-link','invalid-json'] as const){
    const f=fixture(t),a=f.backup();let expected=/路径|ID|普通|清单|链接/
    if(mode==='relative')a.manifest.relativeRolloutPath='../../outside.jsonl'
    if(mode==='original')a.manifest.originalRolloutPath=join(f.root,'outside.jsonl')
    if(mode==='id')a.manifest.sessionId=randomUUID()
    writeFileSync(a.manifestPath,JSON.stringify(a.manifest))
    if(mode==='symlink'){rmSync(a.file);symlinkSync(join(f.root,'missing'),a.file)}
    if(mode==='hardlink')linkSync(a.file,join(f.root,'linked'))
    if(mode==='manifest-link'){rmSync(a.manifestPath);symlinkSync(join(f.root,'missing'),a.manifestPath)}
    if(mode==='invalid-json')writeFileSync(a.manifestPath,'{"fake-secret-unparseable"')
    await assert.rejects(f.trash.selectLegacy(f.primary),expected);assert.equal(JSON.stringify(f.trash.state()).includes('fake-secret-unparseable'),false);assert.equal(f.trash.list().total,0);assert.deepEqual(readdirSync(f.a),[])
  }
})

test('pagination exposes every selected copy and refuses oversized files/manifests before allocation',async t=>{
  const f=fixture(t),entries=Array.from({length:61},()=>f.backup()),page=await f.trash.selectLegacy(f.primary);assert.equal(page.total,61);assert.equal(page.items.length,25);assert.equal(f.trash.legacyPage({snapshotId:page.snapshotId,page:3}).items.length,11)
  writeFileSync(entries[0].manifestPath,' '.repeat(1024**2+1));await assert.rejects(f.trash.selectLegacy(f.primary),/1 MiB/)
  writeFileSync(entries[0].manifestPath,JSON.stringify(entries[0].manifest));truncateSync(entries[0].file,101*1024**3);await assert.rejects(f.trash.selectLegacy(entries[0].folder),/100 GiB/);assert.equal(f.trash.list().total,0)
})

test('cancellation after one imported copy retains it and removes only the unfinished private copy',async t=>{
  const f=fixture(t),first=f.backup(),second=f.backup();appendFileSync(second.file,Buffer.alloc(16*1024**2,120));const view=await f.preview();f.trash.start({ticket:view.ticket,confirmed:true})
  const deadline=Date.now()+5000;while(!f.trash.state().job?.importedCopies&&Date.now()<deadline)await setImmediate();assert.equal(f.trash.state().job?.importedCopies,1)
  await f.trash.cancel(f.trash.state().job!.id);assert.equal(f.trash.state().job?.status,'cancelled');assert.equal(f.trash.list().total,1);assert.equal(readFileSync(first.file,'utf8'),first.raw);assert.equal(readFileSync(second.file).length,Buffer.byteLength(second.raw)+16*1024**2);assert.deepEqual(readdirSync(f.a),[])
})

test('a killed import leaves a visible preparation that can be discarded without source or target mutation',async t=>{
  const f=fixture(t),entry=f.backup();appendFileSync(entry.file,Buffer.alloc(2*1024**2,120));const source=await scanLegacyTrash(f.primary,new AbortController().signal),input={id:randomUUID(),targetId:f.targets[0].id,targetName:'Fixture',root:f.a,configHash:textHash(null),file:source.entries[0]},inputFile=join(f.root,'input.json'),trashRoot=join(f.store.directory,'session-trash');mkdirSync(trashRoot);writeFileSync(inputFile,JSON.stringify(input))
  const child=spawn(process.execPath,['--import','tsx','tests/fixtures/legacy-trash-crash.ts',trashRoot,inputFile],{cwd:process.cwd(),stdio:'ignore'})
  const closed=await new Promise<[number|null,NodeJS.Signals|null]>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve([code,signal]))});assert.deepEqual(closed,[null,'SIGKILL'])
  f.trash.recover();const recovery=f.trash.state().recoveries[0];assert.equal(recovery.phase,'preparing');assert.equal(recovery.canResume,false);assert.equal(recovery.canRestore,false)
  const journal=loadTrashJournal(join(trashRoot,input.id));assert.equal(journal.imported?.key,source.entries[0].key)
  await assert.rejects(deleteTrashOriginals(join(trashRoot,input.id),sessionProgram(f.apps[0]),new AbortController().signal,f.runtime),/导入/)
  rmSync(f.a,{recursive:true})
  await f.trash.recoverBatch({id:input.id,mode:'discard',clientsClosed:true});assert.equal(f.trash.state().recoveries.length,0);assert.deepEqual(readdirSync(trashRoot),[]);assert.equal(existsSync(f.a),false);assert.equal(readFileSync(entry.file).length,Buffer.byteLength(entry.raw)+2*1024**2)
})
