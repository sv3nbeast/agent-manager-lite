import test from 'node:test'
import assert from 'node:assert/strict'
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {setImmediate,setTimeout as delay} from 'node:timers/promises'
import {Store,type State} from '../src/main/store'
import {createAPIAccount,importIntoStore,deleteAccounts} from '../src/main/accounts'
import {DataBackups} from '../src/main/dataBackups'
import {backupCipher,backupDestination,writeBackupArchive,readBackupArchive} from '../src/main/dataBackupArchive'
import {exportBackupState,validateBackup,effectiveKeyUsage} from '../src/main/dataBackupState'
import {mutateProvider} from '../src/main/providerLibrary'
import {emptyLocalAccess} from '../src/shared/localAccess'
import {parseProxyCatalog} from '../src/main/proxyCatalogParser'
import {Gateway} from '../src/main/gateway'
import {LocalAccess} from '../src/main/localAccess'
import {History} from '../src/main/history'
import {Instances} from '../src/main/instances'

const password='fixture-only backup password 中文 🔑'
const request=()=>({requestId:randomUUID(),password})
const restore=(ticket:string)=>({ticket,requestId:randomUUID(),confirmed:true as const})
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=mkdtempSync(join(tmpdir(),'cml-backups-')),key=randomBytes(32)
  let failed=false,busy=false,now=Date.now()
  const codec={encrypt:(value:string)=>{if(failed)throw new Error('fixture vault failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()])},decrypt:(value:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(-16));return Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString()}}
  const store=new Store(join(root,'data'),codec),usage:Record<string,number>={}
  const raw=(ids:string[])=>Object.fromEntries(ids.map(id=>[id,usage[id]??0]))
  const service=new DataBackups(store,raw,()=>{if(busy)throw new Error('fixture busy')},()=>now)
  const add=(name='备份账号')=>{const a=createAPIAccount({name,apiKey:'fixture-'+randomUUID(),baseUrl:'http://127.0.0.1:9/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'inherit',note:'中文\n🧪',tags:['中文']});store.transaction(s=>s.accounts.push(a));return a}
  const file=join(root,'backup.cmlbackup')
  t.after(async()=>{await service.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,codec,service,add,usage,raw,file,fail:(v:boolean)=>{failed=v},busy:(v:boolean)=>{busy=v},expire:()=>{now+=300001}}
}
function seed(f:ReturnType<typeof fixture>){
  f.add()
  importIntoStore(f.store,JSON.stringify({access_token:'fixture-oauth-token',refresh_token:'fixture-refresh',email:'fixture@example.invalid'}))
  mutateProvider(f.store,{action:'create',details:{name:'本地供应商',baseUrl:'http://127.0.0.1:9/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'fast'}})
  let provider=f.store.read().providers![0]
  mutateProvider(f.store,{action:'addKey',id:provider.id,revision:provider.revision,name:'fixture key',apiKey:'fixture-provider-secret'})
  provider=f.store.read().providers![0]
  mutateProvider(f.store,{action:'createAccount',id:provider.id,revision:provider.revision,keyId:provider.keys.find(k=>k.apiKey==='fixture-provider-secret')!.id,name:'关联账号'})
  const retired=f.add('回收账号');deleteAccounts(f.store,[retired.id])
  const keyId=randomUUID(),directoryId=randomUUID()
  f.store.transaction(s=>{
    s.settings.defaultTier='fast';s.settings.refreshMinutes=0
    const a=s.accounts[0]
    a.source={unknown:['完整保留',null,42]};a.quota={updatedAt:1,windows:[{id:'5h',name:'5 小时',usedPercent:34}],credits:{unlimited:false,remaining:20},spendLimit:{limit:50,used:30},resetCreditsAvailable:2}
    a.providerUsage={checkedAt:1,summary:{source:'sub2api',updatedAt:1,unit:'USD',remaining:10,totalRequests:7}}
    s.groups=[{id:randomUUID(),name:'中文分组',quotaAutoRefreshMinutes:-1,sortOrder:0,createdAt:1,accountIds:s.accounts.map(a=>a.id)}]
    s.instanceApplications=[{id:'fixture-cli',name:'Fixture Codex',path:'/fixture/codex',kind:'cli'}]
    s.instanceWorkingDirectories=[{id:directoryId,path:'/fixture/work',device:1,inode:2}]
    s.instances=[{id:randomUUID(),revision:0,createdAt:1,name:'Fast 实例',applicationId:'fixture-cli',accountId:a.id,connectionMode:'local_api',defaultTier:'flex',model:'fixture-model',extraArgs:['--fixture'],workingDirectoryId:directoryId}]
    s.localAccess={...emptyLocalAccess(),accountIds:[a.id],keys:[{id:keyId,createdAt:1,revision:0,key:'fixture-local-secret',label:'测试客户端',enabled:true,inheritAccountPool:false,accountIds:[a.id],priorityAccountIds:[a.id],allowedModels:['fixture-model'],excludedModels:[],modelPrefix:'',tokenLimit:100}]}
    s.proxyCatalogs=[{id:randomUUID(),revision:1,name:'Existing only',kind:'manual',updatedAt:1,catalog:parseProxyCatalog('proxies:\n  - name: existing\n    type: http\n    server: 127.0.0.1\n    port: 12345\nproxy-groups:\n  - name: saved\n    type: select\n    proxies: [existing]\n')}]
    s.configTargets=[{id:randomUUID(),name:'local only',directory:'/fixture/local',createdAt:1} as NonNullable<State['configTargets']>[number]]
  })
  f.usage[keyId]=80
  return keyId
}
async function unpack(path:string){const result=await readBackupArchive(path,password,new AbortController().signal);result.cipher.key.fill(0);return validateBackup(result.payload)}

test('portable encrypted restore preserves accounts, relationships, Fast, existing settings and rollback across independent vault codecs',async t=>{
  const source=fixture(t),keyId=seed(source),target=fixture(t);target.add('before restore')
  target.store.transaction(s=>{s.configTargets=[{id:randomUUID(),name:'destination local',directory:'/fixture/destination',createdAt:1} as NonNullable<State['configTargets']>[number]]})
  const before=target.store.read(),original=new Store(source.store.directory,source.codec).read()
  const exported=await source.service.export(request(),source.file)
  assert.equal(exported.counts.accounts,3);assert.equal(statSync(source.file).mode&0o777,0o600)
  const encrypted=readFileSync(source.file)
  for(const secret of ['fixture-provider-secret','fixture-refresh','fixture-local-secret','中文分组'])assert.equal(encrypted.includes(secret),false)
  const preview=await target.service.preview(request(),source.file)
  assert.equal(preview.sourceDirectories,1);assert.equal(preview.current.accounts,1);assert.equal(preview.incoming.accounts,3)
  assert.equal(JSON.stringify(preview).includes('fixture-'),false)
  const result=await target.service.apply(restore(preview.ticket))
  assert.equal(result.restartRequired,true)
  const after=new Store(target.store.directory,target.codec).read()
  assert.deepEqual(after.configTargets,before.configTargets);assert.equal(after.settings.defaultTier,'fast')
  assert.deepEqual(after.providers,original.providers);assert.deepEqual(after.groups,original.groups)
  assert.deepEqual(after.instances,original.instances);assert.deepEqual(after.proxyCatalogs,original.proxyCatalogs)
  assert.deepEqual(after.accountRecycle,original.accountRecycle)
  for(let i=0;i<after.accounts.length;i++){const {generation,...a}=after.accounts[i],{generation:old,...b}=original.accounts[i];assert.deepEqual(a,b);assert.ok(generation);assert.notEqual(generation,old)}
  assert.equal(after.localAccess!.keys[0].restoredUsageOffset,80)
  assert.equal(effectiveKeyUsage(after,target.raw([keyId]))[keyId],80)
  const reopened=new Store(target.store.directory,target.codec)
  const instances=new Instances(reopened,()=>assert.fail('Restore must not launch a gateway'),async()=>assert.fail('Restore must not load account credentials'))
  await instances.recover()
  assert.equal(instances.views()[0].status,'stopped');assert.equal(instances.inUse(after.instances![0].id),false)
  assert.deepEqual(readdirSync(join(target.store.directory,'instances',after.instances![0].id)).sort(),['desktop','home','workspace'])
  const rollback=await unpack(result.rollbackPath);assert.deepEqual(rollback.state.accounts,before.accounts)
  assert.equal(readFileSync(join(target.store.directory,'state.vault')).includes('fixture-refresh'),false)
  assert.throws(()=>target.service.apply(restore(preview.ticket)),/重启/)
})

test('old backups cannot reset consumed tokens; cross-machine re-export and restore do not double count offsets',async t=>{
  const source=fixture(t),keyId=seed(source);await source.service.export(request(),source.file)
  source.usage[keyId]=95
  const preview=await source.service.preview(request(),source.file);await source.service.apply(restore(preview.ticket))
  assert.equal(source.store.read().localAccess!.keys[0].restoredUsageOffset,0)
  const target=fixture(t);target.usage[keyId]=20
  const p=await target.service.preview(request(),source.file);await target.service.apply(restore(p.ticket))
  assert.equal(target.store.read().localAccess!.keys[0].restoredUsageOffset,60)
  target.usage[keyId]=25;assert.equal(effectiveKeyUsage(target.store.read(),target.raw([keyId]))[keyId],85)
  const reopened=new DataBackups(new Store(target.store.directory,target.codec),target.raw);t.after(()=>reopened.stop())
  await reopened.export(request(),target.file);assert.equal((await unpack(target.file)).localKeyUsage[keyId],85)
  const third=fixture(t),next=await third.service.preview(request(),target.file);await third.service.apply(restore(next.ticket))
  assert.equal(effectiveKeyUsage(third.store.read(),third.raw([keyId]))[keyId],85)
  assert.throws(()=>effectiveKeyUsage(third.store.read(),{[keyId]:NaN}),/用量无效/)
})

test('wrong password, modified authenticated bytes, truncation and unsupported versions leave target state unchanged',async t=>{
  const f=fixture(t);f.add();await f.service.export(request(),f.file);const before=f.store.read(),bytes=readFileSync(f.file)
  await assert.rejects(f.service.preview({...request(),password:'wrong password'},f.file),/密码/)
  for(const index of [0,9,15,35,bytes.length-1]){const damaged=Buffer.from(bytes);damaged[index]^=1;writeFileSync(f.file,damaged);await assert.rejects(f.service.preview(request(),f.file))}
  writeFileSync(f.file,bytes.subarray(0,30));await assert.rejects(f.service.preview(request(),f.file),/格式/)
  assert.deepEqual(f.store.read(),before)
  assert.deepEqual(readdirSync(f.root).sort(),['backup.cmlbackup','data'])
})

test('archive size bounds cover both plaintext creation and authenticated decompression',async t=>{
  const f=fixture(t),cipher=await backupCipher(password),signal=new AbortController().signal
  t.after(()=>cipher.key.fill(0))
  writeFileSync(f.file,'existing')
  await assert.rejects(writeBackupArchive(f.file,{large:'x'.repeat(64*1024*1024)},cipher,signal),/上限/)
  assert.equal(readFileSync(f.file,'utf8'),'existing')
  // An authenticated, highly compressible external archive must be bounded
  // after decompression as well as before decrypting its small ciphertext.
  const {gzipSync}=await import('node:zlib'),nonce=randomBytes(12),header=Buffer.concat([Buffer.from('CMLBACKUP\x01'),cipher.salt,nonce]),c=createCipheriv('aes-256-gcm',cipher.key,nonce);c.setAAD(header)
  const compressed=gzipSync(Buffer.alloc(64*1024*1024+1,32))
  writeFileSync(f.file,Buffer.concat([header,c.update(compressed),c.final(),c.getAuthTag()]))
  await assert.rejects(readBackupArchive(f.file,password,signal),/上限/)
})

test('schema rejects unknown, duplicate and inconsistent data without silently dropping valid stored fields',async t=>{
  const f=fixture(t),keyId=seed(f),payload=exportBackupState(f.store.read(),f.raw([keyId]))
  const mutations:[string,(p:any)=>void][]=[
    ['unknown version',p=>p.version=2],['unknown root field',p=>p.extra=true],['account duplicate',p=>p.state.accounts.push(p.state.accounts[0])],
    ['missing credential',p=>p.state.accounts[0].credentials={}],['dangling group',p=>p.state.groups[0].accountIds=[randomUUID()]],
    ['provider key mismatch',p=>p.state.accounts.find((a:any)=>a.providerId).credentials.apiKey='other'],
    ['orphan provider key',p=>p.state.accounts[0].providerKeyId=randomUUID()],['key scope bypass',p=>p.state.localAccess.keys[0].accountIds=[p.state.accounts[1].id]],
    ['unknown key use',p=>delete p.localKeyUsage[keyId]],['missing group issues',p=>delete p.state.proxyCatalogs[0].catalog.groups[0].issues],
    ['unsafe instance args',p=>p.state.instances[0].extraArgs=['--remote-debugging-port=1234']],
    ['prototype key',p=>p.state.accounts[0].source=JSON.parse('{"__proto__":{"polluted":true}}')],
    ['deep source',p=>{let deep:any={};p.state.accounts[0].source=deep;for(let i=0;i<70;i++){deep.next={};deep=deep.next}}]
  ]
  for(const [name,change] of mutations)await t.test(name,()=>{const bad=structuredClone(payload);change(bad);assert.throws(()=>validateBackup(bad))})
  assert.deepEqual(validateBackup(payload),payload)
})

test('authenticated invalid JSON never exposes decrypted content through the error message',async t=>{
  const f=fixture(t),cipher=await backupCipher(password),nonce=randomBytes(12),header=Buffer.concat([Buffer.from('CMLBACKUP\x01'),cipher.salt,nonce]),c=createCipheriv('aes-256-gcm',cipher.key,nonce)
  t.after(()=>cipher.key.fill(0));c.setAAD(header)
  const {gzipSync}=await import('node:zlib'),body=gzipSync(Buffer.from('not-json fixture-private-credential'))
  writeFileSync(f.file,Buffer.concat([header,c.update(body),c.final(),c.getAuthTag()]))
  await assert.rejects(f.service.preview(request(),f.file),error=>{assert.ok(error instanceof Error);assert.equal(error.message,'备份内容不是有效的 JSON 数据');return true})
})

test('busy, expired, discarded, unconfirmed or changed previews cannot overwrite the vault',async t=>{
  const f=fixture(t);f.add();await f.service.export(request(),f.file)
  let view=await f.service.preview(request(),f.file);const before=readFileSync(join(f.store.directory,'state.vault'))
  assert.throws(()=>f.service.apply({...restore(view.ticket),confirmed:false}));f.busy(true)
  await assert.rejects(f.service.apply(restore(view.ticket)),/busy/);f.busy(false)
  view=await f.service.preview(request(),f.file);f.expire();await assert.rejects(f.service.apply(restore(view.ticket)),/过期/)
  view=await f.service.preview(request(),f.file);f.service.discard();await assert.rejects(f.service.apply(restore(view.ticket)),/过期/)
  assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),before)
  view=await f.service.preview(request(),f.file);f.store.transaction(s=>s.settings.defaultTier='standard')
  await assert.rejects(f.service.apply(restore(view.ticket)),/变化/);assert.equal(f.store.read().settings.defaultTier,'standard')
})

test('concurrent preview/discard cannot clear a restore cipher; vault failure preserves old state and a decryptable rollback',async t=>{
  const f=fixture(t);f.add('original');await f.service.export(request(),f.file);f.add('later')
  const before=f.store.read(),bytes=readFileSync(join(f.store.directory,'state.vault')),view=await f.service.preview(request(),f.file)
  f.fail(true);const task=f.service.apply(restore(view.ticket)),failure=assert.rejects(task,/vault failure/)
  assert.throws(()=>f.service.preview(request(),f.file),/正在进行/)
  await setImmediate();assert.equal(f.service.applying,true);assert.throws(()=>f.service.discard(),/恢复正在进行/)
  await failure;assert.deepEqual(f.store.read(),before);assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),bytes)
  const rollback=join(f.store.directory,'data-backups',readdirSync(join(f.store.directory,'data-backups'))[0])
  assert.deepEqual((await unpack(rollback)).state.accounts,before.accounts);assert.equal(f.service.restartRequired,false)
  f.fail(false);const retry=await f.service.preview(request(),f.file);await f.service.apply(restore(retry.ticket));assert.equal(f.store.read().accounts.length,1)
})

test('cancel and closing an in-flight preview suppress late tickets and leave existing output unchanged',async t=>{
  const f=fixture(t);f.add();await f.service.export(request(),f.file)
  let input=request(),task=f.service.preview(input,f.file),rejected=assert.rejects(task);f.service.cancel(input.requestId);await rejected
  input=request();task=f.service.preview(input,f.file);rejected=assert.rejects(task);f.service.discard();await rejected
  const prior=readFileSync(f.file),save=request(),exporting=f.service.export(save,f.file),cancelled=assert.rejects(exporting)
  f.service.cancel(save.requestId);await cancelled;assert.deepEqual(readFileSync(f.file),prior)
  assert.equal(readdirSync(f.root).some(name=>name.endsWith('.tmp')),false)
  const good=await f.service.preview(request(),f.file);assert.ok(good.ticket)
})

test('internal and symlinked internal destinations cannot overwrite application data',async t=>{
  const f=fixture(t);f.add();const path=join(f.store.directory,'state.vault'),before=readFileSync(path)
  await assert.rejects(f.service.export(request(),path),/数据目录/)
  const link=join(f.root,'data-link');symlinkSync(f.store.directory,link)
  await assert.rejects(backupDestination(f.store.directory,join(link,'state.vault')),/数据目录/)
  assert.deepEqual(readFileSync(path),before)
})

test('cancelling during archive streaming cleans its temporary file and preserves the previous destination',async t=>{
  const f=fixture(t),cipher=await backupCipher(password),controller=new AbortController()
  t.after(()=>cipher.key.fill(0));writeFileSync(f.file,'keep previous backup')
  const writing=writeBackupArchive(f.file,{data:randomBytes(4*1024*1024).toString('base64')},cipher,controller.signal),failed=assert.rejects(writing)
  const end=Date.now()+5000;while(!readdirSync(f.root).some(name=>name.endsWith('.tmp'))){assert.ok(Date.now()<end);await setImmediate()}
  controller.abort();await failed
  assert.equal(readFileSync(f.file,'utf8'),'keep previous backup');assert.equal(readdirSync(f.root).some(name=>name.endsWith('.tmp')),false)
})

test('a large 10000-account configuration round trips without truncating credentials, Unicode or grouping',async t=>{
  const f=fixture(t),sample=f.add(),ids:string[]=[]
  f.store.transaction(s=>{
    s.accounts=Array.from({length:10000},(_,i)=>{const id=randomUUID();ids.push(id);return {...sample,id,name:`账号 ${i} 🧪`,credentials:{apiKey:`fixture-key-${i}`}}})
    s.groups=[{id:randomUUID(),name:'全部账号',sortOrder:0,createdAt:1,quotaAutoRefreshMinutes:-1,accountIds:ids}]
  })
  const out=await f.service.export(request(),f.file),decoded=await unpack(f.file)
  assert.equal(out.counts.accounts,10000);assert.equal(decoded.state.accounts.length,10000)
  assert.deepEqual(decoded.state.accounts,f.store.read().accounts);assert.deepEqual(decoded.state.groups[0].accountIds,ids)
})

test('cancelling restore after rollback starts never publishes the replacement vault',async t=>{
  const f=fixture(t);f.add('original');await f.service.export(request(),f.file);f.add('keep me')
  const before=f.store.read(),bytes=readFileSync(join(f.store.directory,'state.vault')),p=await f.service.preview(request(),f.file),input=restore(p.ticket)
  const restoring=f.service.apply(input),rejected=assert.rejects(restoring)
  await setImmediate();f.service.cancel(input.requestId);await rejected
  assert.deepEqual(f.store.read(),before);assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),bytes);assert.equal(f.service.restartRequired,false)
})

test('restore refuses unresolved client authority and preserves local registrations',async t=>{
  const f=fixture(t);f.add();await f.service.export(request(),f.file)
  f.store.transaction(s=>s.clientAuthorities=[{accountId:s.accounts[0].id} as NonNullable<State['clientAuthorities']>[number]])
  const p=await f.service.preview(request(),f.file);await assert.rejects(f.service.apply(restore(p.ticket)),/解除客户端/)
  assert.equal(f.store.read().clientAuthorities?.length,1)
})

test('restored usage enforces actual local API limits after a new request while preserving Fast outbound',async t=>{
  const source=fixture(t),keyId=seed(source),target=fixture(t),seen:string[]=[]
  const upstream=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;seen.push(JSON.parse(body).service_tier);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'resp-backup',object:'response',status:'completed',output:[],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}))})
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()))})
  const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()))
  source.store.transaction(s=>{s.accounts[0].baseUrl=`http://127.0.0.1:${address.port}/v1`;s.settings.port=port})
  await source.service.export(request(),source.file);const preview=await target.service.preview(request(),source.file);await target.service.apply(restore(preview.ticket))
  const store=new Store(target.store.directory,target.codec),history=new History(target.root),gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(target.root,'runtime'),event=>history.record('backup-fixture',event))
  const access=new LocalAccess(store,gateway,async id=>store.read().accounts.find(a=>a.id===id)!,ids=>effectiveKeyUsage(store.read(),history.keyTokenUsage(ids)))
  t.after(async()=>{await access.stop();history.close()})
  assert.equal(access.view().keys[0].tokenUsed,80);access.start();await access.settled();assert.equal(access.view().running,true,access.view().error)
  const send=()=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${access.key(keyId)}`,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'fixture backup check'}),signal:AbortSignal.timeout(5000)})
  const response=await send();assert.equal(response.status,200,await response.text());assert.deepEqual(seen,['priority'])
  const deadline=Date.now()+5000;while(access.view().keys[0].tokenUsed!==105){assert.ok(Date.now()<deadline,'usage must be recorded');await delay(20)}
  const denied=await send();assert.equal(denied.status,429,await denied.text());assert.equal(seen.length,1)
  await access.stop();access.start();await access.settled();const again=await send();assert.equal(again.status,429,await again.text());assert.equal(access.view().keys[0].tokenUsed,105)
})
