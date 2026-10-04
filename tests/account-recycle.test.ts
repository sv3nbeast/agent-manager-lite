import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,statSync,readdirSync,existsSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomBytes,createCipheriv,createDecipheriv,randomUUID,generateKeyPairSync} from 'node:crypto'
import {setImmediate} from 'node:timers/promises'
import {Store} from '../src/main/store'
import {createAPIAccount,deleteAccounts,editAccount,importParsedAccounts,parseAccountImport,saveOAuthAccount} from '../src/main/accounts'
import {AccountRecycle} from '../src/main/accountRecycle'
import {TokenAuthority} from '../src/main/tokens'
import {QuotaService} from '../src/main/quota'
import {AgentIdentityService} from '../src/main/agentIdentity'
import {recoverAgentTasks,writeAgentRecovery} from '../src/main/agentRecovery'
import {HTTPError} from '../src/main/network'
import {Gateway} from '../src/main/gateway'
import {settingsSchema} from '../src/shared/types'

function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=mkdtempSync(join(tmpdir(),'cml-account-recycle-')),key=randomBytes(32);let failed=false,now=Date.now(),busy=false
  const codec={encrypt:(raw:string)=>{if(failed)throw new Error('fixture encryption failed');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(raw),cipher.final(),cipher.getAuthTag()])},decrypt:(raw:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));cipher.setAuthTag(raw.subarray(-16));return Buffer.concat([cipher.update(raw.subarray(12,-16)),cipher.final()]).toString()}}
  const store=new Store(join(root,'data'),codec),service=new AccountRecycle(store,()=>now,()=>busy)
  const add=(name='API 账号')=>{const account=createAPIAccount({name,apiKey:'fixture-secret-'+randomUUID(),baseUrl:'https://example.invalid/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'fast',note:'原备注 🧪',tags:['中文']});store.transaction(s=>s.accounts.push(account));return account}
  const preview=(action:'restore'|'purge'|'export',ids?:string[])=>{const page=service.list();return service.preview({snapshotId:page.snapshotId,action,...ids?{ids}:{all:true}})}
  const apply=(view:{ticket:string},exportFirst=false,path?:string)=>service.apply({ticket:view.ticket,confirmed:true,exportFirst},async()=>path)
  t.after(async()=>{await service.stop();rmSync(root,{recursive:true,force:true})})
  return{root,store,codec,service,add,preview,apply,fail:(value:boolean)=>{failed=value},expire:()=>{now+=300001},busy:(value:boolean)=>{busy=value}}
}
const jwt=(workspace='test')=>`e30.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400,email:'fixture@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:workspace}})).toString('base64url')}.fixture`
const oauth=(store:Store)=>saveOAuthAccount(store,{accessToken:jwt(),idToken:jwt(),accountId:'test',refreshToken:'fixture-refresh-original'})

test('encrypted recycle and restart restore preserve metadata and groups without reauthorizing local API keys',async t=>{
  const f=fixture(t),account=f.add(),groupId=randomUUID(),keyId=randomUUID()
  f.store.transaction(s=>{s.groups.push({id:groupId,name:'原分组',sortOrder:0,accountIds:[account.id],createdAt:1,quotaAutoRefreshMinutes:-1});s.accounts[0].source={unknown:'original source'};s.localAccess={revision:0,accountIds:[account.id],routingStrategy:'custom',sessionAffinity:true,sessionAffinityTtlMs:30000,customRoutingRules:[{accountId:account.id,weight:2,priority:0,isPreferred:true,isBackup:false}],keys:[{id:keyId,revision:0,label:'fixture',createdAt:1,key:'fixture-local-key',enabled:true,inheritAccountPool:false,accountIds:[account.id],priorityAccountIds:[account.id],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0}]}})
  deleteAccounts(f.store,[account.id]);assert.equal(f.store.read().accounts.length,0);assert.deepEqual(f.store.read().localAccess?.accountIds,[]);assert.deepEqual(f.store.read().localAccess?.keys[0].priorityAccountIds,[])
  const raw=readFileSync(join(f.store.directory,'state.vault'));assert.equal(raw.includes(account.credentials.apiKey!),false)
  const reopened=new Store(f.store.directory,f.codec),service=new AccountRecycle(reopened),page=service.list();assert.equal(page.total,1);assert.equal(JSON.stringify(page).includes('fixture-secret'),false);assert.equal(JSON.stringify(reopened.snapshot()).includes('original source'),false)
  const view=service.preview({snapshotId:page.snapshotId,ids:[page.items[0].id],action:'restore'});await service.apply({ticket:view.ticket,confirmed:true},async()=>assert.fail('No export requested'))
  const restored=reopened.read().accounts[0];assert.equal(restored.id,account.id);assert.deepEqual(restored.credentials,account.credentials);assert.deepEqual(restored.tags,account.tags);assert.equal(restored.note,account.note);assert.deepEqual(restored.source,{unknown:'original source'});assert.ok(restored.generation);assert.equal(restored.revision,1)
  assert.deepEqual(reopened.read().groups[0].accountIds,[account.id]);assert.deepEqual(reopened.read().localAccess?.accountIds,[]);assert.equal(service.list().total,0)
  assert.throws(()=>editAccount(reopened,{id:account.id,revision:0,changes:{name:'stale'}}),/修改/);await service.stop()
})

test('archive, restore and permanent-delete storage failures leave the entire vault and all accounts unchanged',async t=>{
  const f=fixture(t),a=f.add('A'),b=f.add('B'),path=join(f.store.directory,'state.vault'),before=readFileSync(path)
  f.fail(true);assert.throws(()=>deleteAccounts(f.store,[a.id,b.id]),/encryption/);assert.equal(f.store.read().accounts.length,2);assert.deepEqual(readFileSync(path),before);f.fail(false)
  deleteAccounts(f.store,[a.id,b.id]);const archived=readFileSync(path)
  for(const action of ['restore','purge'] as const){const view=f.preview(action);f.fail(true);await assert.rejects(f.apply(view),/encryption/);assert.deepEqual(readFileSync(path),archived);assert.equal(f.service.list().total,2);f.fail(false)}
  assert.deepEqual(readdirSync(f.store.directory),['state.vault'])
})

test('61-entry pagination and empty-all use the confirmed snapshot, preserving accounts recycled while a dialog is open',async t=>{
  const f=fixture(t),accounts=Array.from({length:61},(_,i)=>f.add('Account '+i));deleteAccounts(f.store,accounts.map(a=>a.id));const page=f.service.list()
  assert.equal(page.items.length,25);assert.equal(f.service.page({snapshotId:page.snapshotId,page:3}).items.length,11)
  const view=f.service.preview({snapshotId:page.snapshotId,all:true,action:'purge'}),late=f.add('Later');deleteAccounts(f.store,[late.id])
  const done=await f.apply(view);assert.equal(done.count,61);assert.equal(f.service.list().items[0].accountId,late.id)
})

test('reimported identities cannot be overwritten by restore, while export and purge continue to use the original snapshot',async t=>{
  const f=fixture(t),a=oauth(f.store);deleteAccounts(f.store,[a.id]);const restored={...a,id:randomUUID(),name:'new login',credentials:{...a.credentials,refreshToken:'fixture-newer'}};importParsedAccounts(f.store,[restored])
  assert.throws(()=>f.preview('restore'),/已存在/);assert.equal(f.service.list().total,1)
  const file=join(f.root,'original.json');await f.apply(f.preview('export'),false,file)
  const parsed=parseAccountImport(readFileSync(file,'utf8'));assert.equal(parsed.accounts[0].credentials.refreshToken,'fixture-refresh-original')
  await f.apply(f.preview('purge'));assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-newer');assert.equal(f.service.list().total,0)
})

test('export-and-delete cancellation, unsafe destinations and incomplete selection preserve snapshots and existing files',async t=>{
  const f=fixture(t),a=f.add();deleteAccounts(f.store,[a.id]);let view=f.preview('purge')
  assert.deepEqual(await f.apply(view,true),{count:0,exported:0,cancelled:true});assert.equal(f.service.list().total,1)
  const internal=join(f.store.directory,'keep.json');writeFileSync(internal,'keep');await assert.rejects(f.apply(view,true,internal),/应用数据目录/);assert.equal(readFileSync(internal,'utf8'),'keep')
  const link=join(f.root,'data-link');symlinkSync(f.store.directory,link);await assert.rejects(f.apply(view,true,join(link,'keep.json')),/应用数据目录/)
  const missing=join(f.root,'missing','file.json');await assert.rejects(f.apply(view,true,missing));assert.equal(f.service.list().total,1)
  const page=f.service.list();assert.throws(()=>f.service.preview({snapshotId:page.snapshotId,ids:[page.items[0].id,randomUUID()],action:'purge'}),/当前/)
  const output=join(f.root,'export.json');view=f.preview('purge');const done=await f.apply(view,true,output);assert.equal(done.exported,1);assert.equal(statSync(output).mode&0o777,0o600);assert.equal(parseAccountImport(readFileSync(output,'utf8')).accounts[0].credentials.apiKey,a.credentials.apiKey);assert.equal(f.service.list().total,0)
})

test('tickets, busy guards and source changes during the save dialog prevent stale destructive actions',async t=>{
  const f=fixture(t),a=f.add();assert.throws(()=>deleteAccounts(f.store,[a.id],()=>true),/停止/);deleteAccounts(f.store,[a.id])
  let view=f.preview('restore');f.busy(true);assert.throws(()=>f.apply(view),/刷新/);f.busy(false);f.expire();assert.throws(()=>f.apply(view),/过期/)
  view=f.preview('purge');assert.throws(()=>f.service.apply({ticket:view.ticket,confirmed:false},async()=>undefined));
  let choose!:(path:string)=>void;const operation=f.service.apply({ticket:view.ticket,confirmed:true,exportFirst:true},()=>new Promise(resolve=>{choose=resolve}))
  assert.throws(()=>f.service.preview({snapshotId:f.service.list().snapshotId,all:true,action:'purge'}),/进行/)
  f.store.transaction(s=>{s.accountRecycle![0].account.note='concurrent change'});const output=join(f.root,'untouched.json');writeFileSync(output,'keep');choose(output);await assert.rejects(operation,/变化/);assert.equal(readFileSync(output,'utf8'),'keep');assert.equal(f.service.list().total,1)
})

test('stale OAuth refresh and quota results cannot modify an account restored with the same ID',async t=>{
  const f=fixture(t),a=oauth(f.store);let finish!:(value:Record<string,unknown>)=>void
  const authority=new TokenAuthority(f.store,()=>new Promise(resolve=>{finish=resolve})),refresh=authority.ensure(a.id,{force:true});const rejected=assert.rejects(refresh,/重新恢复/)
  deleteAccounts(f.store,[a.id]);await f.apply(f.preview('restore'));finish({access_token:jwt(),id_token:jwt(),refresh_token:'stale-rotated'});await rejected;assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-refresh-original')
  let started=false
  const quotaRequest=new QuotaService(f.store,authority,()=>{started=true;return new Promise(resolve=>{finish=resolve})});quotaRequest.start([a.id]);while(!started)await setImmediate()
  deleteAccounts(f.store,[a.id]);await f.apply(f.preview('restore'));finish({plan_type:'stale-plan',rate_limit:{primary_window:{used_percent:99}}});await quotaRequest.settled();assert.equal(f.store.read().accounts[0].quota,undefined);assert.notEqual(f.store.read().accounts[0].plan,'stale-plan')
  await Promise.all([authority.stop(),quotaRequest.stop()])
})

test('restored Agent Identity rejects old task registration and old crash markers while accepting the new generation',async t=>{
  const f=fixture(t),a=parseAccountImport(JSON.stringify({agent_identity:{agent_runtime_id:'fixture-runtime',agent_private_key:generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),account_id:'fixture-org',chatgpt_user_id:'fixture-user',chatgpt_account_is_fedramp:false}})).accounts[0];importParsedAccounts(f.store,[a])
  let finish!:(value:Record<string,unknown>)=>void;const agents=new AgentIdentityService(f.store,async()=>assert.fail('No encrypted task'),()=>new Promise(resolve=>{finish=resolve})),pending=agents.ensure(a.id),rejected=assert.rejects(pending,/丢弃/)
  deleteAccounts(f.store,[a.id]);await f.apply(f.preview('restore'));finish({task_id:'stale-task'});await rejected
  const identity=f.store.read().accounts[0].credentials.agentIdentity!,generation=f.store.read().accounts[0].generation,runtime=join(f.root,'runtime'),directory=join(runtime,'gateway-fixture');mkdirSync(join(directory,'auth'),{recursive:true})
  const write=()=>writeFileSync(join(directory,'auth',a.id+'.json'),JSON.stringify({auth_mode:'agentIdentity',...identity,task_id:'from-sidecar'}))
  write();writeAgentRecovery(directory,a.id,identity,12345);assert.deepEqual(recoverAgentTasks(runtime,f.store,agents,{isAlive:()=>false}),{recovered:0,retained:0});assert.equal(f.store.read().accounts[0].credentials.agentIdentity?.task_id,undefined)
  mkdirSync(join(directory,'auth'),{recursive:true});write();writeAgentRecovery(directory,a.id,identity,12345,false,generation);assert.equal(recoverAgentTasks(runtime,f.store,agents,{isAlive:()=>false}).recovered,1);assert.equal(f.store.read().accounts[0].credentials.agentIdentity?.task_id,'from-sidecar')
  const gateway=new Gateway(resolve('resources/bin/codex-proxy'),runtime,()=>{},(id,identity,expected,epoch)=>agents.adopt(id,identity,expected,epoch))
  try{
    const restored=f.store.read().accounts[0];await gateway.start({id:a.id,account:restored,apiKey:'fixture-local-key',port:0},settingsSchema.parse({}))
    const running=join(runtime,readdirSync(runtime)[0]),authPath=join(running,'auth',a.id+'.json'),auth=JSON.parse(readFileSync(authPath,'utf8'))
    assert.equal(JSON.parse(readFileSync(join(running,'agent-recovery.json'),'utf8')).accountGeneration,generation)
    writeFileSync(authPath,JSON.stringify({...auth,task_id:'current-generation-task'}));await gateway.stop();assert.equal(f.store.read().accounts[0].credentials.agentIdentity?.task_id,'current-generation-task')
  }finally{await gateway.stop();await agents.stop()}
})

test('a late quota 401 does not refresh or set an error on the restored account',async t=>{
  const f=fixture(t),a=oauth(f.store);let reject!:(error:Error)=>void,started=false
  const authority=new TokenAuthority(f.store,async()=>assert.fail('Old quota must not trigger a refresh')),quota=new QuotaService(f.store,authority,()=>{started=true;return new Promise((_,fail)=>{reject=fail})})
  quota.start([a.id]);while(!started)await setImmediate();deleteAccounts(f.store,[a.id]);await f.apply(f.preview('restore'));reject(new HTTPError(401,'fixture'));await quota.settled()
  assert.equal(f.store.read().accounts[0].error,undefined);assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-refresh-original');await Promise.all([quota.stop(),authority.stop()])
})

test('a saved export remains visible when the following vault mutation fails, and shutdown never advances deletion',async t=>{
  const f=fixture(t),a=f.add();deleteAccounts(f.store,[a.id]);let view=f.preview('purge');const output=join(f.root,'saved.json')
  f.fail(true);await assert.rejects(f.apply(view,true,output),/备份已保存/);assert.ok(existsSync(output));assert.equal(f.service.list().total,1);f.fail(false)
  view=f.preview('purge');let choose!:(path:string)=>void;const operation=f.service.apply({ticket:view.ticket,confirmed:true,exportFirst:true},()=>new Promise(resolve=>{choose=resolve})),rejected=assert.rejects(operation,/退出/),stopping=f.service.stop();choose(join(f.root,'shutdown.json'));await rejected;await stopping
  assert.equal(f.store.read().accountRecycle?.length,1);assert.equal(existsSync(join(f.root,'shutdown.json')),false)
})

test('a changed provider is detached on restore without changing the archived credential or effective Fast setting',async t=>{
  for(const mode of ['credential','tier','removed']){
  const f=fixture(t),a=f.add(),providerId=randomUUID(),keyId=randomUUID()
  f.store.transaction(s=>{s.providers=[{id:providerId,name:'Provider',baseUrl:a.baseUrl,wireApi:'responses',models:[...a.models],defaultTier:'fast',keys:[{id:keyId,name:'key',apiKey:a.credentials.apiKey!,createdAt:1,updatedAt:1}],excludedKeyHashes:[],createdAt:1,updatedAt:1,revision:0}];s.accounts[0].providerId=providerId;s.accounts[0].providerKeyId=keyId;s.accounts[0].defaultTier='inherit'})
  deleteAccounts(f.store,[a.id]);f.store.transaction(s=>{if(mode==='credential')s.providers![0].keys[0].apiKey='changed-provider-secret';else if(mode==='tier')s.providers![0].defaultTier='standard';else s.providers=[]})
  await f.apply(f.preview('restore'));const restored=f.store.read().accounts[0];assert.equal(restored.providerId,undefined);assert.equal(restored.defaultTier,'fast');assert.equal(restored.credentials.apiKey,a.credentials.apiKey)
  }
})
