import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,lstatSync,readdirSync,appendFileSync,symlinkSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {pipeline} from 'node:stream/promises'
import {createWriteStream} from 'node:fs'
import * as yazl from 'yazl'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {SessionArchives} from '../src/main/sessionArchives'
import {SessionZip,archiveMaxBytes,writeSessionZip,type SessionManifest} from '../src/main/sessionZip'

const signal=()=>new AbortController().signal,hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex')
function fixture(t:{after(fn:()=>void|Promise<void>):void},indexer:ConstructorParameters<typeof SessionTransfers>[4]=async()=>{}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-archives-'))),store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),catalog=new SessionCatalog(store)
  const source=join(root,'source'),target=join(root,'target');mkdirSync(source);mkdirSync(target)
  const a=configs.register(source),b=configs.register(target),program=join(root,'codex');writeFileSync(program,Buffer.from('cffaedfe00000000','hex'),{mode:0o700})
  const apps=[{id:'fixture-cli',name:'Fixture CLI',kind:'cli' as const,path:program}];let now=Date.now(),archives:SessionArchives
  const transfers=new SessionTransfers(store,catalog,()=>apps,id=>archives?.busy(id)??false,indexer,()=>now);archives=new SessionArchives(store,catalog,transfers,()=>now)
  const scan=()=>catalog.scan({runId:randomUUID(),targetId:a.id})
  const exportPreview=async(ids:string[])=>archives.previewExport({snapshotId:(await scan()).snapshotId,sessionIds:ids})
  const zipPath=join(root,'export.zip'),exportZip=async(ids:string[])=>{const p=await exportPreview(ids);archives.startExport(p.ticket,zipPath);await archives.settled();assert.equal(archives.view()?.status,'completed',JSON.stringify(archives.view()));return zipPath}
  const prepare=async(path:string,ids?:string[])=>{const p=await archives.openPackage(path);return archives.previewImport({ticket:p.ticket,targetId:b.id,applicationId:apps[0].id,sessionIds:ids??p.items.map(item=>item.id)})}
  t.after(async()=>{await archives.stop();await transfers.stop();catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,configs,catalog,source,target,a,b,apps,program,archives,transfers,scan,exportPreview,exportZip,prepare,zipPath,advance:()=>{now+=300001}}
}
function rollout(home:string,id:string,archived=false,tail='中文 🧪\n特殊工具输出\\n'){const folder=join(home,archived?'archived_sessions':'sessions');mkdirSync(folder,{recursive:true});const path=join(folder,'rollout-'+id+'.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',timestamp:'2026-10-01T08:00:00Z',payload:{id,cwd:'/fixture/项目',model_provider:'original',unknown:'保留'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-01T08:00:01Z',payload:{type:'user_message',message:tail}})+'\n');return path}
async function customZip(path:string,manifest:unknown,files:{name:string;data:Buffer;mode?:number}[],zip64=false){const zip=new yazl.ZipFile(),task=pipeline(zip.outputStream,createWriteStream(path));zip.addBuffer(Buffer.from(JSON.stringify(manifest)),'manifest.json');for(const file of files)zip.addBuffer(file.data,file.name,{mode:file.mode??0o100600});zip.end({forceZip64Format:zip64,comment:''});await task}
function manifestFor(path:string,id:string):SessionManifest{const data=readFileSync(path);return {kind:'codex-session-export',packageVersion:1,exportedAt:'2026-10-01T08:00:00Z',sessions:[{sessionId:id,title:'来自 Cockpit',cwd:'/fixture/项目',updatedAt:1790841600,relativeRolloutPath:'sessions/imported/2026/10/01/rollout-'+id+'.jsonl',fileEntry:'files/0001-'+id+'/rollout.jsonl',sizeBytes:data.length,sha256:hash(data),sessionIndexEntry:{id,thread_name:'来源标题',custom:{keep:true}},sourceInstance:{id:'default',name:'默认实例'}}]}}

test('ZIP round trip preserves original rollout bytes, SHA256, source/unknown metadata and archives; imported files use the recoverable official index path',{timeout:15000},async t=>{
  const indexed:string[][]=[],f=fixture(t,async(_program,_home,ids)=>{indexed.push(ids)}),id=randomUUID(),archived=randomUUID(),file=rollout(f.source,id),old=rollout(f.source,archived,true),before=readFileSync(file)
  writeFileSync(join(f.source,'session_index.jsonl'),JSON.stringify({id,thread_name:'ZIP 中文会话',unknown:{keep:1},rollout_path:file})+'\n')
  writeFileSync(join(f.source,'auth.json'),'private fixture credentials');writeFileSync(join(f.source,'config.toml'),'model="fixture"')
  const path=await f.exportZip([id,archived]),archive=await SessionZip.read(path,signal())
  try{assert.equal(archive.manifest.kind,'codex-session-export');assert.equal(archive.entries.size,3);assert.deepEqual(archive.manifest.sessions[0].sessionIndexEntry,{id,thread_name:'ZIP 中文会话',unknown:{keep:1},rollout_path:file});assert.equal(archive.manifest.sessions[0].sha256,hash(before));const extracted=join(f.root,'raw');await archive.extract(archive.manifest.sessions[0],extracted,signal(),()=>{});assert.deepEqual(readFileSync(extracted),before)}finally{await archive.close()}
  assert.equal(lstatSync(path).mode&0o777,0o600)
  const preview=await f.prepare(path);assert.equal(preview.items.length,2);assert.deepEqual(preview.existing,{})
  assert.throws(()=>f.transfers.start({ticket:preview.ticket,clientsClosed:true}),/不属于/)
  assert.equal(existsSync(join(f.target,'sessions')),false)
  f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled()
  assert.equal(f.archives.view()?.status,'completed',JSON.stringify(f.archives.view()));assert.equal(indexed.length,1);assert.deepEqual(new Set(indexed[0]),new Set([id,archived]))
  const targetCatalog=new SessionCatalog(f.store),page=await targetCatalog.scan({runId:randomUUID(),targetId:f.b.id});assert.equal(page.total,2);assert.ok(page.items.find(row=>row.id===archived)?.locations[0].archived)
  const imported=await targetCatalog.location({snapshotId:page.snapshotId,sessionId:id,targetId:f.b.id}),data=readFileSync(imported,'utf8')
  assert.equal(data.slice(data.indexOf('\n')),before.toString().slice(before.toString().indexOf('\n')));assert.equal(JSON.parse(data.split('\n')[0]).payload.model_provider,'openai')
  assert.equal(existsSync(join(f.target,'auth.json')),false);assert.equal(existsSync(join(f.target,'config.toml')),false);assert.deepEqual(readFileSync(file),before);assert.ok(existsSync(old))
  const index=JSON.parse(readFileSync(join(f.target,'session_index.jsonl'),'utf8').split('\n')[0]);assert.deepEqual(index.unknown,{keep:1});assert.equal(index.rollout_path,imported)
  assert.deepEqual(readdirSync(join(f.store.directory,'session-archive-staging')),[])
})

test('import preview distinguishes identical/conflicting IDs, supports a selected subset and never replaces existing conversations',async t=>{
  const f=fixture(t),same=randomUUID(),conflict=randomUUID(),fresh=randomUUID(),omit=randomUUID()
  for(const id of [same,conflict,fresh,omit]){const path=rollout(f.source,id);if(id===same||id===conflict){const target=rollout(f.target,id);writeFileSync(target,readFileSync(path));if(id===conflict)appendFileSync(target,'different content\n')}}
  const targetBefore=readdirSync(join(f.target,'sessions')).map(name=>[name,readFileSync(join(f.target,'sessions',name))] as const)
  const path=await f.exportZip([same,conflict,fresh,omit]),preview=await f.prepare(path,[same,conflict,fresh])
  assert.equal(preview.existing[same],'duplicate');assert.equal(preview.existing[conflict],'conflict');assert.equal(preview.items.length,3)
  f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled();assert.equal(f.transfers.view().transfer?.skipped,2)
  for(const [name,data] of targetBefore)assert.deepEqual(readFileSync(join(f.target,'sessions',name)),data)
  const page=await f.catalog.scan({runId:randomUUID(),targetId:f.b.id});assert.equal(page.total,3);assert.ok(!page.items.some(item=>item.id===omit))
})

test('Cockpit v1 ZIP64 input with uppercase hash, null index and nonstandard rollout path remains importable',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id),manifest=manifestFor(path,id);manifest.sessions[0].sha256=manifest.sessions[0].sha256.toUpperCase();manifest.sessions[0].sessionIndexEntry=null;manifest.sessions[0].relativeRolloutPath='../../config.toml'
  await customZip(f.zipPath,manifest,[{name:manifest.sessions[0].fileEntry,data:readFileSync(path)}],true)
  const preview=await f.prepare(f.zipPath);f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled();assert.equal(f.archives.view()?.status,'completed');assert.equal(existsSync(join(f.root,'config.toml')),false)
})

test('bad hashes and mismatching session IDs fail before touching target files and clean extracted scratch',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id),base=manifestFor(path,id)
  for(const kind of ['hash','id']){
    const manifest=structuredClone(base);if(kind==='hash')manifest.sessions[0].sha256='0'.repeat(64);else manifest.sessions[0].sessionId=randomUUID()
    await customZip(f.zipPath,manifest,[{name:manifest.sessions[0].fileEntry,data:readFileSync(path)}]);await assert.rejects(f.prepare(f.zipPath),kind==='hash'?/SHA256/:/ID/)
    assert.deepEqual(readdirSync(f.target),[]);assert.deepEqual(readdirSync(join(f.store.directory,'session-archive-staging')),[])
  }
})

test('malformed archives reject duplicate entries/IDs, symlinks, extra files, oversized manifests/entries and traversal paths',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id),data=readFileSync(path),base=manifestFor(path,id),entry=base.sessions[0].fileEntry
  for(const kind of ['duplicate-entry','duplicate-id','symlink','extra','size','manifest','traversal','unsupported']){
    const manifest=structuredClone(base),files=[{name:entry,data,mode:0o100600}]
    if(kind==='duplicate-entry')files.push({...files[0]})
    if(kind==='duplicate-id')manifest.sessions.push({...manifest.sessions[0]})
    if(kind==='symlink')files[0].mode=0o120777
    if(kind==='extra')files.push({name:'auth.json',data:Buffer.from('not allowed'),mode:0o100600})
    if(kind==='size')manifest.sessions[0].sizeBytes=archiveMaxBytes+1
    if(kind==='manifest')manifest.sessions[0].sessionIndexEntry={huge:'x'.repeat(8*1024**2)}
    if(kind==='unsupported')(manifest as any).packageVersion=2
    await customZip(f.zipPath,manifest,files)
    if(kind==='traversal'){const raw=readFileSync(f.zipPath);for(let start=0;(start=raw.indexOf(Buffer.from('files/'),start))>=0;start+=6)Buffer.from('../xx/').copy(raw,start);writeFileSync(f.zipPath,raw)}
    await assert.rejects(f.archives.openPackage(f.zipPath),undefined,kind);assert.deepEqual(readdirSync(f.target),[])
  }
})

test('tickets expire or cancel; changed packages and symlink inputs are rejected without consuming arbitrary paths',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id);await f.exportZip([id])
  let p=await f.archives.openPackage(f.zipPath);appendFileSync(f.zipPath,'changed');await assert.rejects(f.archives.previewImport({ticket:p.ticket,targetId:f.b.id,applicationId:f.apps[0].id,sessionIds:[id]}),/变化/)
  await f.exportZip([id]);p=await f.archives.openPackage(f.zipPath);f.advance();await assert.rejects(f.archives.previewImport({ticket:p.ticket,targetId:f.b.id,applicationId:f.apps[0].id,sessionIds:[id]}),/过期/)
  const preview=await f.prepare(f.zipPath);await f.archives.discard();assert.throws(()=>f.archives.startImport({ticket:preview.ticket,clientsClosed:true}),/过期/)
  const linked=join(f.root,'link.zip');symlinkSync(f.zipPath,linked);await assert.rejects(f.archives.openPackage(linked));assert.deepEqual(readdirSync(f.target),[])
})

test('export protects existing output against source changes/cancellation and denies application/client destinations',async t=>{
  const f=fixture(t),id=randomUUID(),file=rollout(f.source,id,false,'x'.repeat(24*1024**2))
  let preview=await f.exportPreview([id]);writeFileSync(f.zipPath,'previous archive');appendFileSync(file,'changed')
  f.archives.startExport(preview.ticket,f.zipPath);await f.archives.settled();assert.equal(f.archives.view()?.status,'failed');assert.equal(readFileSync(f.zipPath,'utf8'),'previous archive')
  preview=await f.exportPreview([id]);assert.throws(()=>f.archives.startExport(preview.ticket,join(f.target,'bad.zip')),/以外/)
  const started=f.archives.startExport(preview.ticket,f.zipPath);assert.equal(f.archives.busy(f.a.id),true)
  await f.archives.cancel(started.id);assert.equal(f.archives.view()?.status,'cancelled');assert.equal(f.archives.busy(f.a.id),false);assert.equal(readFileSync(f.zipPath,'utf8'),'previous archive')
  assert.ok(!readdirSync(f.root).some(name=>name.endsWith('.tmp')))
})

test('streamed extraction cancels within a large highly compressed rollout without publishing files',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id,false,'x'.repeat(32*1024**2)),manifest=manifestFor(path,id);await customZip(f.zipPath,manifest,[{name:manifest.sessions[0].fileEntry,data:readFileSync(path)}])
  const pkg=await f.archives.openPackage(f.zipPath),task=f.archives.previewImport({ticket:pkg.ticket,targetId:f.b.id,applicationId:f.apps[0].id,sessionIds:[id]});const rejected=assert.rejects(task,/取消/)
  while(!f.archives.view()?.bytes)await delay(1)
  await f.archives.cancel(f.archives.view()!.id);await rejected;assert.equal(f.archives.view()?.status,'cancelled');assert.deepEqual(readdirSync(f.target),[]);assert.deepEqual(readdirSync(join(f.store.directory,'session-archive-staging')),[])
})

test('ZIP import retains recoverable files when official indexing fails; original archive and scratch are not needed to retry',async t=>{
  let fail=true;const f=fixture(t,async()=>{if(fail)throw new Error('fixture index failure')}),id=randomUUID();rollout(f.source,id);const preview=await f.prepare(await f.exportZip([id]))
  f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled();assert.equal(f.archives.view()?.status,'completed');assert.ok(f.archives.view()?.error);assert.equal(f.transfers.view().recoveries.length,1)
  rmSync(f.zipPath);assert.deepEqual(readdirSync(join(f.store.directory,'session-archive-staging')),[]);fail=false
  await f.transfers.retry({id:f.transfers.view().recoveries[0].id,applicationId:f.apps[0].id,clientsClosed:true});assert.deepEqual(f.transfers.view().recoveries,[])
  assert.equal((await f.catalog.scan({runId:randomUUID(),targetId:f.b.id})).total,1)
})

test('import rechecks target identity/config at confirmation and startup clears only private abandoned extraction workspaces',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id);const preview=await f.prepare(await f.exportZip([id]));writeFileSync(join(f.target,'config.toml'),'model_provider="changed"\n')
  f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled();assert.equal(f.archives.view()?.status,'failed');assert.deepEqual(readdirSync(f.target),['config.toml'])
  const scratch=join(f.store.directory,'session-archive-staging'),stale=join(scratch,randomUUID());mkdirSync(stale);writeFileSync(join(stale,'abandoned'),'test');writeFileSync(join(scratch,'keep.txt'),'unrelated')
  new SessionArchives(f.store,f.catalog,f.transfers);assert.equal(existsSync(stale),false);assert.equal(readFileSync(join(scratch,'keep.txt'),'utf8'),'unrelated')
})

test('export rejects destination replacement and source mutation after ZIP streaming has already begun',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id,false,'x'.repeat(2*1024**2)),manifest=manifestFor(path,id)
  for(const change of ['destination','source','cancel']){
    const page=await f.scan(),sources=await f.catalog.transferSources(page.snapshotId,[id]),controller=new AbortController();writeFileSync(f.zipPath,'old zip');let changed=false
    await assert.rejects(writeSessionZip(f.zipPath,manifest,sources,controller.signal,(_file,bytes)=>{
      if(changed||!bytes)return;changed=true
      if(change==='destination'){renameSync(f.zipPath,join(f.root,'old.zip'));writeFileSync(f.zipPath,'external replacement')}
      else if(change==='source')appendFileSync(path,'new data')
      else controller.abort()
    }))
    assert.ok(changed);assert.equal(readFileSync(f.zipPath,'utf8'),change==='destination'?'external replacement':'old zip');assert.ok(!readdirSync(f.root).some(name=>name.endsWith('.tmp')))
    if(change==='source'){const original=readFileSync(path).subarray(0,manifest.sessions[0].sizeBytes);writeFileSync(path,original)}
  }
})

test('one thousand sessions export with bounded ZIP entries; import can select the last item and ignores unselected content',{timeout:30000},async t=>{
  const f=fixture(t),ids=Array.from({length:1000},()=>randomUUID());for(const id of ids)rollout(f.source,id)
  await f.exportZip(ids);const pkg=await f.archives.openPackage(f.zipPath);assert.equal(pkg.items.length,1000)
  const preview=await f.archives.previewImport({ticket:pkg.ticket,targetId:f.b.id,applicationId:f.apps[0].id,sessionIds:[ids[999]]});assert.equal(preview.items.length,1)
  f.archives.startImport({ticket:preview.ticket,clientsClosed:true});await f.archives.settled();const page=await f.catalog.scan({runId:randomUUID(),targetId:f.b.id});assert.deepEqual(page.items.map(item=>item.id),[ids[999]])
})

test('failed extraction destination closes its input stream so archive cleanup cannot hang',{timeout:5000},async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id),manifest=manifestFor(path,id);await customZip(f.zipPath,manifest,[{name:manifest.sessions[0].fileEntry,data:readFileSync(path)}])
  const archive=await SessionZip.read(f.zipPath,signal());await assert.rejects(archive.extract(archive.manifest.sessions[0],path,signal(),()=>{}),/EEXIST/);await archive.close();assert.ok(existsSync(path))
})

test('cancelling import while target enumeration is active stops the shared preview and prevents publication',{timeout:10000},async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id);await f.exportZip([id]);for(let i=0;i<500;i++)rollout(f.target,randomUUID())
  const pkg=await f.archives.openPackage(f.zipPath),original=f.transfers.previewImported.bind(f.transfers);let reached=false
  f.transfers.previewImported=async(...args)=>{reached=true;return original(...args)}
  const task=f.archives.previewImport({ticket:pkg.ticket,targetId:f.b.id,applicationId:f.apps[0].id,sessionIds:[id]}),rejected=assert.rejects(task,/取消/)
  while(!reached)await delay(1)
  await f.archives.cancel(f.archives.view()!.id);await rejected;assert.equal(f.archives.view()?.status,'cancelled');assert.equal(existsSync(join(f.target,'session_index.jsonl')),false);assert.deepEqual(readdirSync(join(f.store.directory,'session-archive-staging')),[])
})
