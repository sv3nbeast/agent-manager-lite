import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,lstatSync,existsSync,readdirSync,appendFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:net'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {SessionSync} from '../src/main/sessionSync'
import {rolloutFiles} from '../src/main/sessionFiles'
const when='2026-10-01T08:00:00Z'
function rollout(home:string,id:string,time=when,body='test',duplicate=false){const folder=join(home,'sessions','2026','10','01');mkdirSync(folder,{recursive:true});const path=join(folder,`rollout-2026-10-01T08-00-${duplicate?'01':'00'}-${id}.jsonl`);writeFileSync(path,JSON.stringify({type:'session_meta',timestamp:when,payload:{id,cwd:'/fixture/中文项目',model_provider:'openai',extra:'keep'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:time,payload:{type:'user_message',message:body}})+'\n');return path}
function fixture(t:{after(fn:()=>void|Promise<void>):void},rebuild:ConstructorParameters<typeof SessionSync>[4]=async()=>{}){
  const root=realpathSync(mkdtempSync(join(process.platform==='darwin'?'/tmp':tmpdir(),'cml-sync-job-'))),store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),catalog=new SessionCatalog(store),a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b)
  const targets=[configs.register(a),configs.register(b)],program=join(root,'codex');writeFileSync(program,Buffer.from('cffaedfe00000000','hex'),{mode:0o700});const apps=[{id:'fixture',name:'Fixture CLI',kind:'cli' as const,path:program}]
  let sync:SessionSync,externalBusy=false,now=Date.now()
  const transfers=new SessionTransfers(store,catalog,()=>apps,id=>sync?.busy(id)??false,async()=>{}),create=(indexer=rebuild)=>new SessionSync(store,transfers,()=>apps,()=>externalBusy,indexer,()=>now);sync=create()
  const preview=()=>sync.preview({targetIds:targets.map(item=>item.id),applicationId:'fixture'})
  const start=async()=>{const view=await preview();sync.start({ticket:view.ticket,clientsClosed:true});await sync.settled();assert.equal(sync.view().sync?.status,'completed',JSON.stringify(sync.view()));return view}
  t.after(async()=>{await sync.stop();await transfers.stop();catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,configs,catalog,a,b,targets,program,apps,transfers,sync,create,preview,start,advance:()=>{now+=300001},busy:(value:boolean)=>{externalBusy=value}}
}
async function files(home:string){const result:string[]=[];for await(const path of rolloutFiles(home,new AbortController().signal))result.push(path);return result}

test('sync refuses paginated segments before staging or modifying any selected home',async t=>{
  const f=fixture(t),id=randomUUID(),first=rollout(f.a,id,when,'first'),latest=rollout(f.a,id,'2026-10-01T09:00:00Z','latest',true),other=rollout(f.b,randomUUID())
  const lines=readFileSync(latest,'utf8').split('\n'),meta=JSON.parse(lines[0]);meta.payload.history_mode='paginated';meta.payload.history_base={thread_id:randomUUID()};lines[0]=JSON.stringify(meta);writeFileSync(latest,lines.join('\n'))
  const before=new Map([first,latest,other].map(path=>[path,readFileSync(path)]))
  await assert.rejects(f.preview(),/分段历史.*复制实例/)
  assert.equal(f.sync.view().sync?.status,'failed');assert.equal(existsSync(join(f.store.directory,'session-sync-previews')),false);assert.equal(existsSync(join(f.store.directory,'session-sync')),false)
  for(const [path,bytes] of before)assert.deepEqual(readFileSync(path),bytes)
  assert.deepEqual(new Set(await files(f.a)),new Set([first,latest]));assert.deepEqual(await files(f.b),[other])
})

test('sync unions all conversations, merges forks, projects providers, preserves unknown metadata and retains all original backups',async t=>{
  const indexed:string[]=[],f=fixture(t,async(_program,home)=>{indexed.push(home)}),id=randomUUID(),other=randomUUID(),oldA=rollout(f.a,id,when,'甲'),oldB=rollout(f.b,id,'2026-10-01T09:00:00Z','乙'),originalA=readFileSync(oldA),originalB=readFileSync(oldB);rollout(f.a,other)
  writeFileSync(join(f.a,'config.toml'),'model_provider="provider-a"');writeFileSync(join(f.b,'config.toml'),'model_provider="provider-b"')
  writeFileSync(join(f.a,'session_index.jsonl'),JSON.stringify({id,thread_name:'旧标题',updated_at:when,oldOnly:true})+'\n')
  writeFileSync(join(f.b,'session_index.jsonl'),JSON.stringify({id,thread_name:'较新标题',updated_at:'2026-10-01T09:00:00Z',newOnly:{keep:true},rollout_path:oldB})+'\n')
  writeFileSync(join(f.b,'.codex-global-state.json'),JSON.stringify({custom:true,'project-order':['/prior']}))
  const preview=await f.preview();assert.equal(preview.sessionCount,2);assert.equal(preview.targets[0].updated,2);assert.equal(preview.targets[1].added,1);assert.equal(preview.targets[1].repairsWorkspace,true);assert.equal(readFileSync(oldA).equals(originalA),true)
  f.sync.start({ticket:preview.ticket,clientsClosed:true});assert.equal(f.sync.busy(f.targets[0].id),true);await f.sync.settled();assert.equal(f.sync.view().sync?.status,'completed',JSON.stringify(f.sync.view()));assert.deepEqual(indexed,[f.a,f.b]);assert.equal(f.sync.view().recoveries.length,0)
  for(const [i,home] of [f.a,f.b].entries()){
    const paths=await files(home);assert.equal(paths.length,2);const path=paths.find(path=>path.includes(id))!,lines=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines[0].payload.model_provider,i?'provider-b':'provider-a');assert.deepEqual(lines.slice(1).map(row=>row.payload.message),['甲','乙']);assert.equal(lines[0].payload.extra,'keep')
    const entry=readFileSync(join(home,'session_index.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.id===id);assert.equal(entry.thread_name,'较新标题');assert.deepEqual(entry.newOnly,{keep:true});assert.equal(entry.rollout_path,path)
    const backup=f.sync.view().sync!.backups.find(row=>row.targetId===f.targets[i].id)!;assert.ok(readdirSync(f.sync.backupLocation(backup.id)).filter(name=>name.startsWith('old-')).some(name=>readFileSync(join(f.sync.backupLocation(backup.id),name)).equals(i?originalB:originalA)))
    assert.equal(lstatSync(path).nlink,1)
  }
  const global=JSON.parse(readFileSync(join(f.b,'.codex-global-state.json'),'utf8'));assert.equal(global.custom,true);assert.deepEqual(global['project-order'],['/prior','/fixture/中文项目'])
  const again=await f.preview();assert.ok(again.targets.every(row=>row.added===0&&row.updated===0&&row.unchanged===2));f.sync.start({ticket:again.ticket,clientsClosed:true});await f.sync.settled();assert.equal(f.sync.view().sync?.status,'completed');assert.equal(f.sync.view().sync?.backups.length,0);assert.deepEqual(indexed,[f.a,f.b])
})

test('same-home duplicate branches are merged into one rollout and each original is backed up',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.a,id,when,'first');rollout(f.a,id,'2026-10-01T09:00:00Z','second',true)
  const preview=await f.start();assert.equal(preview.targets[0].duplicates,1);assert.equal((await files(f.a)).length,1);assert.equal((await files(f.b)).length,1)
  const backup=f.sync.view().sync!.backups[0];assert.equal(readdirSync(f.sync.backupLocation(backup.id)).filter(name=>name.startsWith('old-')).length,2)
})

test('unchanged rollouts still repair missing workspace roots without replacing their files',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.a,id);await f.start();const aFile=(await files(f.a))[0],inode=lstatSync(aFile).ino;rmSync(join(f.a,'.codex-global-state.json'))
  const preview=await f.start();assert.equal(preview.targets[0].updated,0);assert.equal(preview.targets[0].repairsWorkspace,true);assert.equal(lstatSync(aFile).ino,inode);assert.ok(JSON.parse(readFileSync(join(f.a,'.codex-global-state.json'),'utf8'))['project-order'].includes('/fixture/中文项目'))
})

test('uncreated managed home is created only after confirmation and receives all sessions',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.a,id);const managed=f.configs.targets().find(target=>target.managed)!
  const preview=await f.sync.preview({targetIds:[f.targets[0].id,managed.id],applicationId:'fixture'});assert.equal(existsSync(managed.directory),false)
  f.sync.start({ticket:preview.ticket,clientsClosed:true});await f.sync.settled();assert.equal(f.sync.view().sync?.status,'completed',JSON.stringify(f.sync.view()));assert.equal((await files(managed.directory)).length,1)
})

test('expired tickets, missing confirmation, config/source/inventory/program changes refuse writes',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.a,id)
  let preview=await f.preview();assert.throws(()=>f.sync.start({ticket:preview.ticket,clientsClosed:false}));f.advance();assert.throws(()=>f.sync.start({ticket:preview.ticket,clientsClosed:true}),/过期/)
  for(const change of ['source','config','inventory','program']){
    preview=await f.preview()
    if(change==='source')appendFileSync(path,'\n')
    if(change==='config')writeFileSync(join(f.b,'config.toml'),'model_provider="changed"')
    if(change==='inventory')rollout(f.b,randomUUID())
    if(change==='program'){renameSync(f.program,f.program+'.old');writeFileSync(f.program,readFileSync(f.program+'.old'),{mode:0o700})}
    f.sync.start({ticket:preview.ticket,clientsClosed:true});await f.sync.settled();assert.equal(f.sync.view().sync?.status,'failed',JSON.stringify(f.sync.view()));assert.equal(f.sync.view().sync?.backups.length,0)
  }
})

test('running clients, nested homes, duplicate directory selections and live daemon block preview',async t=>{
  const f=fixture(t);rollout(f.a,randomUUID());f.busy(true);await assert.rejects(f.preview(),/正在使用/);f.busy(false)
  await assert.rejects(f.sync.preview({targetIds:[f.targets[0].id,f.targets[0].id],applicationId:'fixture'}),/至少两个/)
  const sub=join(f.a,'nested');mkdirSync(sub);const target=f.configs.register(sub);await assert.rejects(f.sync.preview({targetIds:[f.targets[0].id,target.id],applicationId:'fixture'}),/相互包含/)
  const control=join(f.a,'app-server-control');mkdirSync(control);const server=createServer(socket=>socket.end());await new Promise<void>(resolve=>server.listen(join(control,'app-server-control.sock'),resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));await assert.rejects(f.preview(),/后台进程/)
})

test('cancel before commit changes no homes, cancel after first commit retains it and skips later targets',async t=>{
  let release!:()=>void,entered!:()=>void;const atIndex=new Promise<void>(resolve=>{entered=resolve}),f=fixture(t,async(_p,_h,_ids,signal)=>{entered();await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true})});signal.throwIfAborted()});rollout(f.a,randomUUID())
  let preview=await f.preview();f.sync.start({ticket:preview.ticket,clientsClosed:true});await f.sync.cancel(f.sync.view().sync!.id);assert.equal(f.sync.view().sync?.status,'cancelled');assert.equal((await files(f.b)).length,0)
  preview=await f.preview();f.sync.start({ticket:preview.ticket,clientsClosed:true});await atIndex
  await f.sync.cancel(f.sync.view().sync!.id);release();assert.equal(f.sync.view().sync?.status,'cancelled');assert.deepEqual(f.sync.view().sync?.completedTargets,[f.targets[0].id]);assert.equal((await files(f.b)).length,0);assert.equal(f.sync.view().recoveries.length,1)
})

test('indexing failure survives restart and recovery only retries indexing without copying again',async t=>{
  const f=fixture(t,async()=>{throw new Error('Codex fixture index failed')});rollout(f.a,randomUUID());await f.start();assert.equal(f.sync.view().recoveries.length,2)
  const before=await files(f.b),inode=lstatSync(before[0]).ino,restarted=f.create(async()=>{});await restarted.recover();assert.equal(restarted.view().recoveries.length,2)
  for(const recovery of restarted.view().recoveries)await restarted.retry({id:recovery.id,applicationId:'fixture',clientsClosed:true})
  assert.deepEqual(restarted.view().recoveries,[]);assert.equal(restarted.view().sync?.targets.length,1);assert.equal(restarted.view().sync?.completedTargets.length,1);assert.equal(lstatSync(before[0]).ino,inode);assert.deepEqual(await files(f.b),before);await restarted.stop()
})

test('corrupt journals block related writes and expose manager recovery folder without touching homes',async t=>{
  const f=fixture(t),id=randomUUID(),folder=join(f.store.directory,'session-sync',id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'journal.json'),'{bad')
  await f.sync.recover();assert.equal(f.sync.busy(f.targets[0].id),true);assert.equal(f.sync.backupLocation(id),folder);await assert.rejects(f.preview(),/恢复/);assert.throws(()=>f.sync.backupLocation('../outside'))
})

test('sync blocks selected copy and client config writes while official indexing runs',async t=>{
  let release!:()=>void,entered!:()=>void;const atIndex=new Promise<void>(resolve=>{entered=resolve}),f=fixture(t,async()=>{entered();await new Promise<void>(resolve=>{release=resolve})}),id=randomUUID();rollout(f.a,id)
  const config=new ClientConfigs(f.store,Date.now,id=>f.sync.busy(id)),view=config.view(f.targets[0].id),edit=config.preview({id:f.targets[0].id,revision:view.revision,changes:{service_tier:'fast'}})
  const preview=await f.preview();f.sync.start({ticket:preview.ticket,clientsClosed:true});await atIndex
  try{assert.throws(()=>config.apply(edit.ticket),/正在|停止|使用/);const scan=await f.catalog.scan({runId:randomUUID(),targetId:f.targets[0].id});await assert.rejects(f.transfers.preview({snapshotId:scan.snapshotId,sessionIds:[id],targetId:f.targets[1].id,applicationId:'fixture'}),/正在使用/)}
  finally{const stop=f.sync.cancel(f.sync.view().sync!.id);release();await stop}
})

test('sync preserves explicit index title/timestamp aliases while relocating only known file paths',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.a,id),row={id,threadName:'自定义名称',updatedAt:when,unknown:{keep:true},path,customLocation:'/unknown/path'}
  writeFileSync(join(f.a,'session_index.jsonl'),JSON.stringify(row)+'\n');await f.start()
  const copied=JSON.parse(readFileSync(join(f.b,'session_index.jsonl'),'utf8'))
  assert.equal(copied.threadName,row.threadName);assert.equal(copied.thread_name,undefined);assert.equal(copied.updatedAt,when);assert.equal(copied.updated_at,undefined);assert.equal(copied.customLocation,row.customLocation);assert.deepEqual(copied.unknown,row.unknown);assert.ok(copied.path.startsWith(f.b))
})
