import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,lstatSync,readdirSync,existsSync,renameSync,symlinkSync,appendFileSync} from 'node:fs'
import {join,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {copySessionRollout,encodeSessionJournal,fileIdentity,sessionJournalSchema,stagePath,textHash,publishSessionTransfer,rollbackSessionTransfer} from '../src/main/sessionTransferFiles'
import type {SessionJournal} from '../src/main/sessionTransferFiles'
import {Instances} from '../src/main/instances'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'

const when='2026-10-01T08:00:00Z',signal=()=>new AbortController().signal
function rollout(home:string,id:string,folder='sessions',name=id,tail='中文消息\n工具输出'){const dir=join(home,folder,'2026','10','01');mkdirSync(dir,{recursive:true});const path=join(dir,'rollout-'+name+'.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',timestamp:when,payload:{id,cwd:'/fixture/中文项目',model_provider:'old-provider',extra:'keep'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:when,payload:{type:'user_message',message:tail}})+'\n');return path}
function fixture(t:{after(fn:()=>void|Promise<void>):void},rebuild:ConstructorParameters<typeof SessionTransfers>[4]=async()=>{},inUse=(id:string)=>false){
  const root=realpathSync(mkdtempSync(join(process.platform==='darwin'?'/tmp':tmpdir(),'cml-transfer-'))),store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),catalog=new SessionCatalog(store)
  const source=join(root,'source'),target=join(root,'target');mkdirSync(source);mkdirSync(target)
  const a=configs.register(source),b=configs.register(target),program=join(root,'codex');writeFileSync(program,Buffer.from('cffaedfe00000000','hex'),{mode:0o700})
  const apps=[{id:'fixture-program',name:'Fixture CLI',kind:'cli' as const,path:program}]
  let now=Date.now()
  const create=(indexer=rebuild)=>new SessionTransfers(store,catalog,()=>apps,inUse,indexer,()=>now)
  const transfers=create(),scan=()=>catalog.scan({runId:randomUUID(),targetId:a.id})
  const preview=async(ids:string[],targetId=b.id)=>transfers.preview({snapshotId:(await scan()).snapshotId,sessionIds:ids,targetId,applicationId:apps[0].id})
  const copy=async(ids:string[],targetId=b.id)=>{const view=await preview(ids,targetId);transfers.start({ticket:view.ticket,clientsClosed:true});await transfers.settled();return transfers.view().transfer!}
  t.after(async()=>{await transfers.stop();catalog.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,configs,catalog,source,target,a,b,program,apps,transfers,create,scan,preview,copy,advance:()=>{now+=300001}}
}
function journal(f:ReturnType<typeof fixture>):SessionJournal{const id=f.transfers.view().transfer!.id;return sessionJournalSchema.parse(JSON.parse(readFileSync(join(f.store.directory,'session-transfers',id,'journal.json'),'utf8')))}

test('selected copy keeps source bytes, archived layout, Unicode and unknown metadata; only changes rollout provider and relocates index paths',async t=>{
  const indexed:{home:string;ids:string[]}[]=[],f=fixture(t,async(_program,home,ids)=>{indexed.push({home,ids})}),id=randomUUID(),archived=randomUUID(),existing=randomUUID()
  const path=rollout(f.source,id),archivedPath=rollout(f.source,archived,'archived_sessions'),skip=rollout(f.source,existing),existingPath=rollout(f.target,existing)
  const before=readFileSync(path),archivedBefore=readFileSync(archivedPath),skipBefore=readFileSync(existingPath)
  writeFileSync(join(f.source,'session_index.jsonl'),JSON.stringify({id,thread_name:'中文会话',unknown:{keep:true},rollout_path:path,path:relative(f.source,path)})+'\n')
  writeFileSync(join(f.target,'config.toml'),'model_provider="target-provider"\n')
  writeFileSync(join(f.target,'session_index.jsonl'),'malformed unrelated line\n'+JSON.stringify({id:existing,unknown:42})+'\n')
  writeFileSync(join(f.target,'.codex-global-state.json'),JSON.stringify({'project-order':['/previous'],extra:{keep:true}}))
  const preview=await f.preview([id,archived,existing]);assert.equal(preview.items.filter(item=>item.status==='existing').length,1)
  f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled()
  assert.equal(f.transfers.view().transfer!.status,'completed',JSON.stringify(f.transfers.view()));assert.equal(f.transfers.view().transfer!.skipped,1)
  assert.deepEqual(indexed,[{home:f.target,ids:[id,archived]}]);assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(archivedPath),archivedBefore);assert.deepEqual(readFileSync(existingPath),skipBefore);assert.ok(existsSync(skip))
  const record=journal(f);assert.equal(record.phase,'done');assert.equal(existsSync(stagePath(record)),false)
  for(const [i,entry] of record.files.entries()){const installed=join(f.target,entry.relative),text=readFileSync(installed,'utf8'),original=readFileSync(i===0?path:archivedPath,'utf8');assert.equal(text.slice(text.indexOf('\n')),original.slice(original.indexOf('\n')));assert.equal(JSON.parse(text.split('\n')[0]).payload.model_provider,'target-provider');assert.equal(lstatSync(installed).nlink,1)}
  assert.ok(record.files.some(file=>file.relative.startsWith('archived_sessions/')))
  const index=readFileSync(join(f.target,'session_index.jsonl'),'utf8');assert.ok(index.startsWith('malformed unrelated line\n'));const row=JSON.parse(index.split('\n').find(line=>line.includes('中文会话'))!)
  assert.deepEqual(row.unknown,{keep:true});assert.equal(row.rollout_path,join(f.target,record.files[0].relative));assert.equal(row.path,record.files[0].relative)
  assert.deepEqual(JSON.parse(readFileSync(join(f.target,'.codex-global-state.json'),'utf8')),{'project-order':['/previous','/fixture/中文项目'],extra:{keep:true},'electron-saved-workspace-roots':['/fixture/中文项目']})
})

test('same filename with another ID never overwrites target; absent managed home is created only after confirmation',async t=>{
  const f=fixture(t),id=randomUUID(),name='2026-10-01T08-00-00-'+id;rollout(f.source,id,'sessions',name);const other=rollout(f.target,randomUUID(),'sessions',name),before=readFileSync(other)
  assert.equal((await f.copy([id])).status,'completed');assert.deepEqual(readFileSync(other),before);assert.match(journal(f).files[0].relative,/sessions\/2026\/10\/01\/rollout-2026-10-01T08-00-01-/)
  const managed=f.configs.targets().find(item=>item.managed)!,view=await f.preview([id],managed.id);assert.equal(existsSync(managed.directory),false)
  f.transfers.start({ticket:view.ticket,clientsClosed:true});await f.transfers.settled();assert.equal(journal(f).phase,'done');assert.ok(existsSync(managed.directory))
})

test('expired/discarded tickets, source mutations, program replacement and changed config refuse writes',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id)
  let preview=await f.preview([id]);assert.throws(()=>f.transfers.start({ticket:preview.ticket,clientsClosed:false}));f.advance();assert.throws(()=>f.transfers.start({ticket:preview.ticket,clientsClosed:true}),/过期/)
  preview=await f.preview([id]);f.transfers.discard();assert.throws(()=>f.transfers.start({ticket:preview.ticket,clientsClosed:true}),/过期/)
  preview=await f.preview([id]);appendFileSync(path,'\n');f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled();assert.equal(f.transfers.view().transfer?.status,'failed');assert.match(f.transfers.view().transfer?.error!,/变化/)
  preview=await f.preview([id]);writeFileSync(join(f.target,'config.toml'),'model_provider="changed"');f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled();assert.match(f.transfers.view().transfer?.error!,/配置/)
  preview=await f.preview([id]);renameSync(f.program,f.program+'.old');writeFileSync(f.program,readFileSync(f.program+'.old'),{mode:0o700});f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled();assert.match(f.transfers.view().transfer?.error!,/程序/)
  assert.equal(existsSync(join(f.target,'sessions')),false)
})

test('foreign targets, nested homes, substituted directories and sqlite symlink ancestors are rejected',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id)
  const page=await f.scan();await assert.rejects(f.transfers.preview({snapshotId:page.snapshotId,sessionIds:[id],targetId:randomUUID(),applicationId:f.apps[0].id}),/不存在/)
  const nested=join(f.source,'nested');mkdirSync(nested);const registered=f.configs.register(nested);await assert.rejects(f.preview([id],registered.id),/相互包含/)
  symlinkSync(f.source,join(f.target,'link'));writeFileSync(join(f.target,'config.toml'),'sqlite_home="link/not-yet-created"');await assert.rejects(f.preview([id]),/链接/)
  rmSync(join(f.target,'config.toml'));const preview=await f.preview([id]);renameSync(f.target,f.target+'.old');mkdirSync(f.target);f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled();assert.equal(f.transfers.view().transfer?.status,'failed');assert.deepEqual(readdirSync(f.target),[])
})

test('registered running instances, a live daemon and newly appearing target ID prevent copying',async t=>{
  let busy=false;const f=fixture(t,async()=>{},()=>busy),id=randomUUID();rollout(f.source,id)
  busy=true;await assert.rejects(f.preview([id]),/正在使用/);busy=false
  const preview=await f.preview([id]);rollout(f.target,id);f.transfers.start({ticket:preview.ticket,clientsClosed:true});await f.transfers.settled();assert.match(f.transfers.view().transfer?.error!,/同 ID/)
  rmSync(join(f.target,'sessions'),{recursive:true});const control=join(f.source,'app-server-control');mkdirSync(control);const socket=createServer(client=>client.end());await new Promise<void>(resolve=>socket.listen(join(control,'app-server-control.sock'),resolve));t.after(()=>new Promise<void>(resolve=>socket.close(()=>resolve())))
  assert.equal((await f.copy([id])).status,'failed');assert.match(f.transfers.view().transfer?.error!,/后台进程/);assert.equal(existsSync(join(f.target,'sessions')),false)
})

test('large rollout copy is chunked/cancellable and preserves bytes after the metadata including giant lines',async t=>{
  const f=fixture(t),id=randomUUID(),path=rollout(f.source,id),controller=new AbortController();appendFileSync(path,Buffer.alloc(8*1024*1024,120))
  const page=await f.scan(),[source]=await f.catalog.transferSources(page.snapshotId,[id]),output=join(f.root,'cancelled'),progress:number[]=[]
  await assert.rejects(copySessionRollout(source,output,'new',controller.signal,bytes=>{progress.push(bytes);if(bytes>512*1024)controller.abort()}),/abort/i)
  assert.ok(lstatSync(output).size<1024*1024);assert.ok(progress.length>=3)
  const complete=join(f.root,'complete');await copySessionRollout(source,complete,'new',signal(),()=>{});const original=readFileSync(path),copied=readFileSync(complete);assert.deepEqual(copied.subarray(copied.indexOf(10)),original.subarray(original.indexOf(10)))
})

test('cancelling a transfer releases busy locks and removes staged files without changing target metadata',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id);const preview=await f.preview([id]);f.transfers.start({ticket:preview.ticket,clientsClosed:true});assert.equal(f.transfers.busy(f.b.id),true)
  await f.transfers.cancel(f.transfers.view().transfer!.id);assert.equal(f.transfers.view().transfer?.status,'cancelled');assert.equal(f.transfers.busy(f.b.id),false);assert.deepEqual(readdirSync(f.target),[])
})

test('failed official indexing retains copies and recovery, survives restart and retries without duplicating files',async t=>{
  const f=fixture(t,async()=>{throw new Error('fixture index failure')}),id=randomUUID();rollout(f.source,id)
  const view=await f.copy([id]);assert.equal(view.status,'completed');assert.match(view.indexError!,/fixture/);assert.equal(journal(f).phase,'committed');assert.equal(f.transfers.busy(f.b.id),true)
  const restarted=f.create(async(_program,home,ids)=>{assert.equal(home,f.target);assert.deepEqual(ids,[id])});await restarted.recover();assert.equal(restarted.view().recoveries.length,1)
  await restarted.retry({id:view.id,applicationId:f.apps[0].id,clientsClosed:true});assert.deepEqual(restarted.view().recoveries,[]);assert.equal(restarted.view().transfer?.status,'completed');assert.equal(journal(f).phase,'done')
})

test('oversized escaped journals are rejected before publication and leave a readable rolled-back journal',async t=>{
  const f=fixture(t),id=randomUUID();rollout(f.source,id)
  // A legal UTF-8 file with malformed lines is preserved verbatim. JSON escapes
  // expand it sixfold; the record would otherwise be too large to recover.
  const before='\u0000'.repeat(4*1024*1024);writeFileSync(join(f.target,'session_index.jsonl'),before)
  const view=await f.copy([id]);assert.equal(view.status,'failed');assert.match(view.error!,/40 MiB/);assert.equal(journal(f).phase,'rolled_back');assert.equal(readFileSync(join(f.target,'session_index.jsonl'),'utf8'),before);assert.equal(existsSync(join(f.target,'sessions')),false);assert.equal(f.transfers.view().recoveries.length,0)
})

async function prepared(f:ReturnType<typeof fixture>){
  const id=randomUUID();rollout(f.source,id);const page=await f.scan(),[source]=await f.catalog.transferSources(page.snapshotId,[id]),jobId=randomUUID(),stage=join(f.target,'.cml-session-transfer-'+jobId);mkdirSync(stage)
  const copied=await copySessionRollout(source,join(stage,'0.jsonl'),'openai',signal(),()=>{}),stat=lstatSync(f.program)
  const record:SessionJournal={version:1,id:jobId,targetId:f.b.id,targetName:f.b.name,root:f.target,rootIdentity:fileIdentity(lstatSync(f.target)),stageIdentity:fileIdentity(lstatSync(stage)),configHash:textHash(null),phase:'prepared',program:{path:f.program,...fileIdentity(stat),size:stat.size,mtime:stat.mtimeMs},sessionIds:[id],files:[{stage:'0.jsonl',relative:relative(f.source,source.path),...copied}],metadata:[{name:'session_index.jsonl',before:null,after:JSON.stringify({id})+'\n',beforeHash:textHash(null),afterHash:textHash(JSON.stringify({id})+'\n')}],createdAt:Date.now()}
  const backup=join(f.store.directory,'session-transfers',jobId);mkdirSync(backup,{recursive:true});writeFileSync(join(backup,'journal.json'),encodeSessionJournal(record));return record
}

test('prepared partial publication is reversible, but changed user content is never overwritten during recovery',async t=>{
  const f=fixture(t),record=await prepared(f);publishSessionTransfer(record);assert.equal(lstatSync(join(f.target,record.files[0].relative)).nlink,2)
  await f.transfers.recover();assert.equal(existsSync(join(f.target,record.files[0].relative)),false);assert.equal(existsSync(join(f.target,'session_index.jsonl')),false);assert.equal(existsSync(stagePath(record)),false);assert.deepEqual(f.transfers.view().recoveries,[])
  const second=await prepared(f);publishSessionTransfer(second);writeFileSync(join(f.target,'session_index.jsonl'),'user update')
  await f.transfers.recover();assert.equal(readFileSync(join(f.target,'session_index.jsonl'),'utf8'),'user update');assert.equal(existsSync(join(f.target,second.files[0].relative)),true);assert.match(f.transfers.view().recoveries[0].message,/其他进程/)
  await assert.rejects(rollbackSessionTransfer(second),/其他进程/)
})

test('corrupt recovery records lock writes and still expose their backup folder for manual inspection',async t=>{
  const f=fixture(t),id=randomUUID(),folder=join(f.store.directory,'session-transfers',id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'journal.json'),'{broken')
  await f.transfers.recover();assert.equal(f.transfers.view().recoveries.length,1);assert.equal(f.transfers.busy(f.a.id),true);assert.equal(f.transfers.backupLocation(id),folder);assert.throws(()=>f.transfers.backupLocation('../outside'))
})

test('real subprocess SIGKILL before/after publication recovers from the persisted prepared journal',async t=>{
  const f=fixture(t)
  for(const phase of ['prepared','published']){
    const record=await prepared(f),backup=join(f.store.directory,'session-transfers',record.id,'journal.json')
    const child=spawn(process.execPath,['--import','tsx','tests/fixtures/session-transfer-crash.ts',backup,phase],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']})
    let stderr='';child.stderr.on('data',data=>{stderr+=data})
    const closed=new Promise<number|null>(resolve=>child.once('close',resolve))
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('crash fixture timed out: '+stderr))},5000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.stdout.once('data',data=>{clearTimeout(timer);assert.ok(String(data).includes('fixture-ready'));resolve()});child.once('close',code=>{clearTimeout(timer);if(code!==null)reject(new Error('crash fixture exited: '+stderr))})})
    child.kill('SIGKILL');await closed
    const restarted=f.create();await restarted.recover();assert.deepEqual(restarted.view().recoveries,[]);assert.equal(existsSync(stagePath(record)),false);assert.equal(existsSync(join(f.target,record.files[0].relative)),false);assert.equal(JSON.parse(readFileSync(backup,'utf8')).phase,'rolled_back')
  }
})

test('active transfer locks real instance launch/edit/delete and client configuration writes',async t=>{
  let release!:()=>void,indexing!:()=>void;const atIndex=new Promise<void>(resolve=>{indexing=resolve}),f=fixture(t,async()=>{indexing();await new Promise<void>(resolve=>{release=resolve})})
  const instances=new Instances(f.store,()=>assert.fail('Locked instance must not launch a gateway'),undefined,undefined,undefined,Date.now,id=>f.transfers.busy(id))
  const application=instances.registerApplication(f.program,'cli'),account=createAPIAccount({name:'Fixture',apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',models:['fixture'],wireApi:'responses'});importParsedAccounts(f.store,[account])
  const details={name:'Target',applicationId:application.id,accountId:account.id,model:'fixture',connectionMode:'local_api' as const,defaultTier:'inherit' as const,extraArgs:[]}
  instances.save({details});const target=instances.views()[0],id=randomUUID();rollout(f.source,id)
  const configs=new ClientConfigs(f.store,Date.now,id=>instances.inUse(id)),configuration=configs.view(target.id),edit=configs.preview({id:target.id,revision:configuration.revision,changes:{service_tier:'fast'}})
  const preview=await f.preview([id],target.id);f.transfers.start({ticket:preview.ticket,clientsClosed:true});await atIndex
  try{
    assert.equal(instances.inUse(target.id),true);assert.throws(()=>instances.preview({id:target.id,revision:target.revision}),/正在|停止|使用/)
    assert.throws(()=>instances.save({id:target.id,revision:target.revision,details:{...details,name:'Changed'}}),/正在|停止|使用/)
    assert.throws(()=>instances.remove({id:target.id,revision:target.revision}),/正在|停止|使用/)
    assert.throws(()=>configs.apply(edit.ticket),/正在|停止|使用/)
  }finally{release();await f.transfers.settled()}
  assert.equal(instances.inUse(target.id),false);assert.equal(f.transfers.view().transfer?.status,'completed')
})
