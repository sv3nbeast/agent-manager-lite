import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {SessionTrash} from '../src/main/sessionTrash'
import {loadTrashJournal,saveTrashJournal,type TrashRuntime} from '../src/main/sessionTrashFiles'

function rollout(home:string,id:string,parent?:string,title='Fixture'){
  const dir=join(home,'sessions','2026','10','01');mkdirSync(dir,{recursive:true});const file=join(dir,'rollout-2026-10-01T08-00-00-'+id+'.jsonl')
  writeFileSync(file,JSON.stringify({type:'session_meta',timestamp:'2026-10-01T08:00:00Z',payload:{id,cwd:'/fixture/中文项目',parent_thread_id:parent,model_provider:'openai'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-01T08:01:00Z',payload:{type:'user_message',message:'Fixture 中文'}})+'\n')
  appendFileSync(join(home,'session_index.jsonl'),JSON.stringify({id,thread_name:title})+'\n');return file
}
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-trash-service-'))),a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b)
  const store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),targets=[configs.register(a),configs.register(b)],catalog=new SessionCatalog(store),binary=join(root,'codex');writeFileSync(binary,Buffer.from('cffaedfe00000000','hex'),{mode:0o700})
  const apps=[{id:'fixture',name:'Fixture',kind:'cli' as const,path:binary}],runtime:TrashRuntime={plan:async(_p,_h,ids)=>ids.map(id=>({id,descendant:false})),remove:async(_p,_h,ids)=>({deletedIds:ids,failedIds:[]}),verify:async()=>{},rebuild:async()=>{}}
  let trash:SessionTrash,busy=false,now=Date.now();const transfers=new SessionTransfers(store,catalog,()=>apps,id=>trash?.busy(id)??false)
  const create=()=>new SessionTrash(store,catalog,transfers,()=>apps,()=>busy,runtime,()=>now);trash=create()
  const scan=()=>catalog.scan({runId:randomUUID(),targetId:targets[0].id})
  const preview=async(ids:string[])=>trash.previewTrash({snapshotId:(await scan()).snapshotId,sessionIds:ids,applicationId:'fixture',clientsClosed:true})
  const move=async(ids:string[])=>{const view=await preview(ids);trash.start({ticket:view.ticket,confirmed:true});await trash.settled();return trash.state()}
  const act=async(action:'restore'|'purge',ids:string[])=>{const page=trash.list(),view=await trash.previewAction({snapshotId:page.snapshotId,sessionIds:ids,action,applicationId:'fixture',clientsClosed:true});trash.start({ticket:view.ticket,confirmed:true});await trash.settled();return trash.state()}
  t.after(async()=>{await trash.stop();await transfers.stop();catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,a,b,store,configs,targets,catalog,apps,runtime,transfers,trash,create,scan,preview,move,act,setBusy:(value:boolean)=>{busy=value},expire:()=>{now+=300001}}
}

test('filtered selection expands to all registered copies and descendants; subset restore/purge leaves other sessions recoverable',async t=>{
  const f=fixture(t),parent=randomUUID(),child=randomUUID(),other=randomUUID(),files=[rollout(f.a,parent,undefined,'Parent'),rollout(f.b,parent,undefined,'Parent'),rollout(f.a,child,parent,'Child')],unrelated=rollout(f.b,other),before=files.map(file=>readFileSync(file))
  const preview=await f.preview([parent]);assert.equal(preview.requested,1);assert.equal(preview.sessions,2);assert.equal(preview.copies,3);assert.equal(preview.targets.length,2);assert.equal(preview.targets.reduce((n,row)=>n+row.descendants,0),1)
  f.trash.start({ticket:preview.ticket,confirmed:true});await f.trash.settled();assert.equal(f.trash.state().job?.status,'completed',JSON.stringify(f.trash.state()));for(const file of files)assert.equal(existsSync(file),false);assert.ok(existsSync(unrelated))
  let page=f.trash.list();assert.equal(page.total,2);assert.equal(page.items.find(row=>row.id===parent)?.copies,2)
  const restored=await f.act('restore',[child]);assert.equal(restored.job?.status,'completed',JSON.stringify(restored));assert.deepEqual(readFileSync(files[2]),before[2]);assert.equal(existsSync(files[0]),false)
  page=f.trash.list();assert.equal(page.total,1);assert.equal(page.items[0].id,parent)
  assert.equal((await f.act('restore',[parent])).job?.status,'completed');for(const [i,file] of files.entries())assert.deepEqual(readFileSync(file),before[i]);assert.equal(f.trash.list().total,0)
  await f.move([parent]);assert.equal((await f.act('purge',[parent])).job?.status,'completed');assert.equal(f.trash.list().total,1);assert.equal(f.trash.list().items[0].id,child)
  await f.act('restore',[child]);assert.equal(f.trash.list().total,0);assert.deepEqual(readFileSync(files[2]),before[2]);assert.equal(existsSync(files[0]),false);assert.ok(existsSync(unrelated))
})

test('pagination and explicit empty-all cover beyond the visible page without deleting live histories',async t=>{
  const f=fixture(t),ids=Array.from({length:61},()=>randomUUID());for(const id of ids)rollout(f.a,id)
  assert.equal((await f.move(ids)).job?.status,'completed');const page=f.trash.list();assert.equal(page.total,61);assert.equal(page.items.length,25);assert.equal(f.trash.page({snapshotId:page.snapshotId,page:3,pageSize:25}).items.length,11)
  const live=rollout(f.b,randomUUID()),preview=await f.trash.previewAction({snapshotId:page.snapshotId,all:true,action:'purge'});assert.equal(preview.sessions,61)
  f.trash.start({ticket:preview.ticket,confirmed:true});await f.trash.settled();assert.equal(f.trash.state().job?.status,'completed');assert.equal(f.trash.list().total,0);assert.ok(existsSync(live))
})

test('interrupted subset restoration resumes only the chosen session and cleanup markers reclaim only private backups',async t=>{
  const f=fixture(t),parent=randomUUID(),child=randomUUID(),parentFile=rollout(f.a,parent),childFile=rollout(f.a,child,parent),original=readFileSync(childFile)
  await f.move([parent]);f.runtime.rebuild=async()=>{throw new Error('fixture index interrupted')}
  const result=await f.act('restore',[child]);assert.equal(result.job?.status,'failed');assert.equal(result.recoveries.length,1);assert.equal(existsSync(parentFile),false)
  const restarted=f.create();restarted.recover();f.runtime.rebuild=async()=>{}
  await restarted.recoverBatch({id:result.recoveries[0].id,mode:'restore',applicationId:'fixture',clientsClosed:true})
  assert.deepEqual(readFileSync(childFile),original);assert.equal(existsSync(parentFile),false);assert.deepEqual(restarted.list().items.map(row=>row.id),[parent])
  const folder=join(f.store.directory,'session-trash',result.recoveries[0].id),journal=loadTrashJournal(folder)
  // Simulate process exit after the user's permanent-delete decision was
  // recorded but before the final private files were removed.
  journal.removedIds=[...journal.allIds];saveTrashJournal(folder,journal)
  const next=f.create();next.recover();assert.equal(existsSync(folder),false);assert.equal(next.list().total,0);assert.deepEqual(readFileSync(childFile),original);assert.equal(existsSync(parentFile),false)
})

test('conflicting source ancestry and the cross-home descendant limit are rejected before any backup or deletion',async t=>{
  const f=fixture(t),parent=randomUUID(),child=randomUUID(),file=rollout(f.a,child,parent)
  const lines=readFileSync(file,'utf8').trimEnd().split('\n'),first=JSON.parse(lines[0]);first.payload.source={subagent:{thread_spawn:{parent_thread_id:randomUUID()}}};lines[0]=JSON.stringify(first);writeFileSync(file,lines.join('\n')+'\n')
  await assert.rejects(f.preview([child]),/矛盾/);assert.ok(existsSync(file));assert.equal(existsSync(join(f.store.directory,'session-trash')),false)
  delete first.payload.source;lines[0]=JSON.stringify(first);writeFileSync(file,lines.join('\n')+'\n');rollout(f.b,parent)
  const extra=Array.from({length:999},()=>randomUUID());f.runtime.plan=async(_program,home)=>[child,...home===f.a?extra:[randomUUID()]].map(id=>({id,descendant:id!==child}))
  await assert.rejects(f.preview([child]),/超过 1000/);assert.ok(existsSync(file));assert.equal(existsSync(join(f.store.directory,'session-trash')),false)
})

test('stale/foreign lists, expiry, changed registration, content, and confirmation gates prevent mutations',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.a,id)
  await assert.rejects(f.trash.previewTrash({snapshotId:randomUUID(),sessionIds:[id],applicationId:'fixture',clientsClosed:true}),/更新/)
  await assert.rejects(f.preview([randomUUID()]),/列表/)
  let preview=await f.preview([id]);assert.throws(()=>f.trash.start({ticket:preview.ticket,confirmed:false}));f.expire();assert.throws(()=>f.trash.start({ticket:preview.ticket,confirmed:true}),/过期/)
  preview=await f.preview([id]);const extra=join(f.root,'extra');mkdirSync(extra);f.configs.register(extra);assert.throws(()=>f.trash.start({ticket:preview.ticket,confirmed:true}),/登记/)
  preview=await f.preview([id]);appendFileSync(path,'extra\n');f.trash.start({ticket:preview.ticket,confirmed:true});await f.trash.settled();assert.equal(f.trash.state().job?.status,'failed');assert.ok(existsSync(path));assert.equal(f.trash.list().total,0)
  await f.move([id]);const page=f.trash.list();await assert.rejects(f.trash.previewAction({snapshotId:page.snapshotId,all:true,sessionIds:[id],action:'purge'}));await assert.rejects(f.trash.previewAction({snapshotId:page.snapshotId,sessionIds:[id],action:'restore'}),/程序/)
  const next=f.trash.list();assert.throws(()=>f.trash.page({snapshotId:page.snapshotId,page:1}),/更新/);assert.equal(next.total,1)
})

test('locks block copy/config writes throughout deletion; cancellation retains recoverable backup and restart does not resume deletion',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.a,id);let entered!:()=>void;const atDelete=new Promise<void>(resolve=>{entered=resolve})
  f.runtime.remove=async(_p,_h,_ids,signal)=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return {deletedIds:[],failedIds:[]}}
  const config=new ClientConfigs(f.store,Date.now,id=>f.trash.busy(id)),view=config.view(f.targets[0].id),edit=config.preview({id:f.targets[0].id,revision:view.revision,changes:{service_tier:'fast'}})
  const preview=await f.preview([id]);f.trash.start({ticket:preview.ticket,confirmed:true});await atDelete
  assert.equal(f.trash.busy(f.targets[0].id),true);assert.throws(()=>config.apply(edit.ticket),/正在|使用|停止/)
  const page=await f.scan();await assert.rejects(f.transfers.preview({snapshotId:page.snapshotId,sessionIds:[id],targetId:f.targets[1].id,applicationId:'fixture'}),/正在使用/)
  await f.trash.cancel(f.trash.state().job!.id);assert.equal(f.trash.state().job?.status,'cancelled');assert.equal(f.trash.state().recoveries.length,1);assert.ok(existsSync(path))
  const restarted=f.create();restarted.recover();assert.equal(restarted.state().recoveries.length,1);assert.ok(existsSync(path))
  await restarted.recoverBatch({id:restarted.state().recoveries[0].id,mode:'restore',applicationId:'fixture',clientsClosed:true});assert.deepEqual(restarted.state().recoveries,[]);assert.equal(restarted.list().total,0);assert.ok(existsSync(path));await restarted.stop()
})

test('failed index is visible per directory and a new official program can complete the recovery',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.a,id);rollout(f.b,id);f.runtime.verify=async()=>{throw new Error('fixture index unavailable')}
  const result=await f.move([id]);assert.equal(result.job?.status,'completed');assert.equal(result.job?.completedTargets.length,2);assert.equal(result.recoveries.length,2);assert.equal(f.trash.list().total,0)
  f.runtime.verify=async()=>{}
  let plans=0,deletions=0
  f.runtime.plan=async()=>{plans++;return []}
  f.runtime.remove=async()=>{deletions++;return {deletedIds:[],failedIds:[]}}
  for(const record of result.recoveries)await f.trash.recoverBatch({id:record.id,mode:'resume',applicationId:'fixture',clientsClosed:true})
  assert.equal(plans,0);assert.equal(deletions,0)
  assert.equal(f.trash.state().recoveries.length,0);assert.equal(f.trash.list().total,1);assert.equal(f.trash.list().items[0].copies,2)
})

test('restoration uses the explicitly previewed current safe config and rejects subsequent config edits',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.a,id);await f.move([id]);writeFileSync(join(f.a,'config.toml'),'model_provider="changed"\n')
  assert.equal((await f.act('restore',[id])).job?.status,'completed');assert.ok(existsSync(path));assert.equal(readFileSync(join(f.a,'config.toml'),'utf8'),'model_provider="changed"\n')
  await f.move([id]);const page=f.trash.list(),preview=await f.trash.previewAction({snapshotId:page.snapshotId,sessionIds:[id],action:'restore',applicationId:'fixture',clientsClosed:true})
  writeFileSync(join(f.a,'config.toml'),'model_provider="changed-again"\n');f.trash.start({ticket:preview.ticket,confirmed:true});await f.trash.settled();assert.equal(f.trash.state().job?.status,'failed');assert.equal(existsSync(path),false);assert.equal(f.trash.list().total,1)
})

test('corrupt journals lock all directories and exposing a backup never accepts arbitrary paths',async t=>{
  const f=fixture(t),id=randomUUID(),folder=join(f.store.directory,'session-trash',id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'journal.json'),'{broken fixture-secret')
  f.trash.recover();assert.equal(f.trash.state().recoveries.length,1);assert.equal(f.trash.busy(f.targets[0].id),true);assert.equal(f.trash.state().recoveries[0].message.includes('fixture-secret'),false)
  assert.equal(f.trash.backupLocation(id),folder);assert.throws(()=>f.trash.backupLocation('../outside'));assert.equal(f.trash.list().total,0)
})
