import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,realpathSync,existsSync,symlinkSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createServer} from 'node:net'
import {Store,type VaultCodec} from '../src/main/store'
import {ClientConfigs,atomic} from '../src/main/clientConfig'
import {ClientIdentities} from '../src/main/clientIdentity'
import {ClientAuthority} from '../src/main/clientAuthority'
import {ClientSwitches} from '../src/main/clientSwitch'
import {TokenAuthority} from '../src/main/tokens'
import {parseAccountImport,importParsedAccounts,createAPIAccount} from '../src/main/accounts'
import {TomlDocument} from '../src/main/tomlPatch'
import {nativeProvider} from '../src/main/nativeAccountProjection'

function auth(workspace:string,generation='initial',lifetime=3600){
  const jwt='fixture.'+Buffer.from(JSON.stringify({generation,exp:Math.floor(Date.now()/1000)+lifetime,email:workspace+'@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:workspace,chatgpt_user_id:'fixture-'+workspace,chatgpt_plan_type:'plus'}})).toString('base64url')+'.signature'
  return JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:jwt,id_token:jwt,refresh_token:`fixture-rt-${workspace}-${generation}`,account_id:workspace},future_option:'preserved'})
}
function fixture(t:{after(fn:()=>void|Promise<void>):void},shortPath=false){
  const root=realpathSync(mkdtempSync(join(shortPath?'/tmp':tmpdir(),'cml-switch-'))),client=join(root,'client');mkdirSync(client)
  const key=randomBytes(32);let encryption=0,failEncryptAt=0,write=0,failWriteAt=0,clock=Date.now(),inUse=false
  const codec:VaultCodec={encrypt:value=>{if(++encryption===failEncryptAt)throw new Error('fixture encryption failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data])},decrypt:value=>{const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(12,28));return Buffer.concat([c.update(value.subarray(28)),c.final()]).toString()}}
  const store=new Store(join(root,'vault'),codec),configs=new ClientConfigs(store),target=configs.register(client)
  importParsedAccounts(store,parseAccountImport('['+auth('old')+','+auth('new')+']').accounts)
  const [old,next]=store.read().accounts
  const file=join(client,'auth.json'),config=join(client,'config.toml')
  writeFileSync(file,auth('old'));writeFileSync(config,'# user comment\ncli_auth_credentials_store="file"\nservice_tier="fast"\nmodel="gpt-fixture"\n[tools]\nfuture=true\n')
  let refreshes=0
  const tokens=new TokenAuthority(store,async()=>{refreshes++;throw new Error('fixture disallows network')})
  const identities=new ClientIdentities(store,configs,async()=>assert.fail('No OS credential access'))
  const authority=new ClientAuthority(store,configs,identities,tokens)
  const switches=new ClientSwitches(store,configs,tokens,()=>inUse,()=>false,(path,content)=>{if(++write===failWriteAt)throw new Error('fixture write failure');atomic(path,content)},()=>clock)
  const preview=()=>switches.preview({targetId:target.id,accountId:next.id})
  const apply=(ticket:string)=>switches.apply({ticket,clientClosed:true})
  const restore=()=>apply(switches.previewRestore({targetId:target.id}).ticket)
  t.after(async()=>{await tokens.stop();await authority.stop();rmSync(root,{recursive:true,force:true})})
  return {root,client,store,codec,key,configs,target,tokens,authority,identities,switches,old,next,file,config,preview,apply,restore,
    failEncrypt:(distance=1)=>{failEncryptAt=encryption+distance},failWrite:(distance=1)=>{failWriteAt=write+distance},advance:()=>{clock+=300001},setInUse:(value:boolean)=>{inUse=value},refreshes:()=>refreshes}
}

test('enabling an inherited proxy invalidates a pending native switch before any client files change',t=>{
  const f=fixture(t),preview=f.preview(),authBefore=readFileSync(f.file,'utf8'),configBefore=readFileSync(f.config,'utf8')
  f.store.transaction(state=>{state.proxyResources=[{id:'fixture-resource',revision:0,name:'Shared',url:'http://127.0.0.1:9876/'}];state.unifiedProxy={mode:'all_accounts',resourceId:'fixture-resource'}})
  assert.throws(()=>f.apply(preview.ticket),/变化/)
  assert.equal(readFileSync(f.file,'utf8'),authBefore);assert.equal(readFileSync(f.config,'utf8'),configBefore)
  assert.equal(f.store.read().clientSwitches?.length??0,0)
  assert.throws(()=>f.preview(),/本地 API/)
  f.store.transaction(state=>{state.unifiedProxy={mode:'off'}})
  f.apply(f.preview().ticket);assert.equal(f.switches.views().length,1)
})

test('native file switch preserves configuration, encrypts journal, adopts old rotation and assigns client authority',async t=>{
  const f=fixture(t),original=readFileSync(f.config,'utf8');writeFileSync(f.file,auth('old','rotated',7200))
  const preview=f.preview()
  assert.equal(preview.after?.accountId,'new');assert.equal(JSON.stringify(preview).includes('fixture-rt'),false)
  assert.equal(readFileSync(f.config,'utf8'),original)
  assert.throws(()=>f.switches.apply({ticket:preview.ticket,clientClosed:false}))
  f.apply(preview.ticket)
  const value=JSON.parse(readFileSync(f.file,'utf8')),doc=new TomlDocument(readFileSync(f.config,'utf8'))
  assert.equal(value.tokens.account_id,'new');assert.equal(value.future_option,'preserved')
  assert.equal(doc.scalar(['service_tier']),'fast');assert.equal(doc.scalar(['tools','future']),true)
  assert.equal(doc.scalar(['model_provider']),'openai');assert.equal(doc.scalar(['forced_login_method']),null)
  assert.ok(readFileSync(f.config,'utf8').includes('# user comment'))
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-rt-old-rotated')
  assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.next.id)
  assert.equal(f.switches.views()[0].status,'committed')
  assert.equal(readFileSync(join(f.store.directory,'state.vault')).includes(Buffer.from('fixture-rt')),false)
  assert.equal(JSON.stringify(f.switches.views()).includes('fixture-rt'),false)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-rt'),false)
  assert.equal(statSync(f.file).mode&0o777,0o600)
  assert.throws(()=>f.apply(preview.ticket),/已过期/)
  assert.throws(()=>f.authority.release({targetId:f.target.id,clientClosed:true}),/切换记录/)
  assert.equal((await f.tokens.ensure(f.next.id)).credentials.accountId,'new');assert.equal(f.refreshes(),0)
})

test('restore recovers latest token chains and retains later unrelated config and auth metadata',async t=>{
  const f=fixture(t);f.apply(f.preview().ticket)
  const updated=JSON.parse(auth('new','client-rotation',7200));updated.future_option='user-edited';writeFileSync(f.file,JSON.stringify(updated))
  f.store.transaction(state=>{state.accounts[0].credentials=parseAccountImport(auth('old','library-rotation',9000)).accounts[0].credentials})
  writeFileSync(f.config,readFileSync(f.config,'utf8')+'\nuser_extra="keep"\n')
  f.restore()
  const restored=JSON.parse(readFileSync(f.file,'utf8'))
  assert.equal(restored.tokens.refresh_token,'fixture-rt-old-library-rotation');assert.equal(restored.future_option,'user-edited')
  assert.equal(f.store.read().accounts[1].credentials.refreshToken,'fixture-rt-new-client-rotation')
  assert.equal(new TomlDocument(readFileSync(f.config,'utf8')).scalar(['tools','user_extra']),'keep')
  assert.equal(new TomlDocument(readFileSync(f.config,'utf8')).raw(['model_provider']),null)
  assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.old.id)
  assert.equal(f.switches.views().length,0);assert.equal(f.switches.usesAccount(f.next.id),false)
})

test('each partial file commit is recoverable after restart without allowing either manager refresh',async t=>{
  for(const at of [1,2]){
    const f=fixture(t);f.failWrite(at);assert.throws(()=>f.apply(f.preview().ticket),/未完整提交/)
    const reopened=new Store(f.store.directory,f.codec),configs=new ClientConfigs(reopened)
    const tokens=new TokenAuthority(reopened,async()=>assert.fail('Partial switch must block refresh'))
    const service=new ClientSwitches(reopened,configs,tokens)
    await assert.rejects(tokens.ensure(f.old.id),/尚未完成/);await assert.rejects(tokens.ensure(f.next.id),/尚未完成/)
    assert.equal(service.views()[0].status,'prepared')
    service.apply({ticket:service.previewRestore({targetId:f.target.id}).ticket,clientClosed:true})
    assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old');assert.equal(service.views().length,0)
    await tokens.stop()
  }
})

test('vault failure before writes leaves files untouched; failure after writes keeps a durable recovery record',async t=>{
  const f=fixture(t),before=readFileSync(f.file,'utf8'),config=readFileSync(f.config,'utf8'),preview=f.preview()
  f.failEncrypt();assert.throws(()=>f.apply(preview.ticket),/encryption failure/)
  assert.equal(readFileSync(f.file,'utf8'),before);assert.equal(readFileSync(f.config,'utf8'),config);assert.equal(f.switches.views().length,0)
  const next=f.preview();f.failEncrypt(2);assert.throws(()=>f.apply(next.ticket),/未完整提交/)
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'new');assert.equal(f.switches.views()[0].status,'prepared')
  f.restore();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
})

test('a failed restore can resume with client-rotated credentials after an app restart',async t=>{
  const f=fixture(t);f.apply(f.preview().ticket)
  const preview=f.switches.previewRestore({targetId:f.target.id});f.failEncrypt(2)
  assert.throws(()=>f.apply(preview.ticket),/未完整提交/);assert.equal(f.switches.views()[0].status,'restoring')
  writeFileSync(f.file,auth('old','after-interruption',7200))
  const store=new Store(f.store.directory,f.codec),configs=new ClientConfigs(store),tokens=new TokenAuthority(store)
  const switches=new ClientSwitches(store,configs,tokens)
  switches.apply({ticket:switches.previewRestore({targetId:f.target.id}).ticket,clientClosed:true})
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.refresh_token,'fixture-rt-old-after-interruption')
  assert.equal(store.read().accounts[0].credentials.refreshToken,'fixture-rt-old-after-interruption');await tokens.stop()
})

test('stale tickets, cancellation, concurrent rotations, running services, replaced directories and links cannot redirect writes',async t=>{
  const f=fixture(t);let p=f.preview();f.advance();assert.throws(()=>f.apply(p.ticket),/已过期/)
  p=f.preview();f.switches.discard(f.target.id);assert.throws(()=>f.apply(p.ticket),/已过期/)
  p=f.preview();writeFileSync(f.file,auth('old','concurrent',7200));assert.throws(()=>f.apply(p.ticket),/已变化/)
  p=f.preview();f.store.transaction(state=>{state.accounts[1].credentials.refreshToken='fixture-new-concurrent'});assert.throws(()=>f.apply(p.ticket),/已变化/)
  p=f.preview();f.store.transaction(state=>{state.settings.defaultTier='fast'});assert.throws(()=>f.apply(p.ticket),/已变化/)
  p=f.preview();f.setInUse(true);assert.throws(()=>f.apply(p.ticket),/本地服务/);f.setInUse(false)
  renameSync(f.client,f.client+'-original');mkdirSync(f.client);writeFileSync(f.file,auth('old'))
  assert.throws(()=>f.preview(),/已被替换/)
  rmSync(f.client,{recursive:true});renameSync(f.client+'-original',f.client)
  rmSync(f.file);symlinkSync(join(f.root,'other-file'),f.file);assert.throws(()=>f.preview(),/安全读取/)
})

test('storage modes, profiles, workspace restrictions, token-pair conflicts and custom built-in providers are enforced',t=>{
  const f=fixture(t)
  for(const config of ['cli_auth_credentials_store="auto"','cli_auth_credentials_store="keyring"','cli_auth_credentials_store="ephemeral"','profile="work"','forced_chatgpt_workspace_id="old"','[model_providers.openai]\nbase_url="https://fixture.invalid"']){
    writeFileSync(f.config,config);assert.throws(()=>f.preview());assert.equal(f.switches.views().length,0)
  }
  writeFileSync(f.config,'')
  f.store.transaction(state=>{state.accounts[1].credentials.idToken=state.accounts[0].credentials.idToken})
  assert.throws(()=>f.preview(),/不一致/)
})

test('restoration refuses changed login settings and unrelated identities without discarding the journal',t=>{
  const f=fixture(t);f.apply(f.preview().ticket);const config=readFileSync(f.config,'utf8'),current=readFileSync(f.file,'utf8')
  writeFileSync(f.config,config.replace('"openai"','"other"'));assert.throws(()=>f.restore(),/外部修改/)
  writeFileSync(f.config,config);writeFileSync(f.file,auth('unrelated'));assert.throws(()=>f.restore(),/其他身份/)
  assert.equal(f.switches.views()[0].status,'committed')
  writeFileSync(f.file,current);f.restore()
})

test('a previously empty managed directory can switch and restore without leaving a login or overwriting added metadata',t=>{
  const f=fixture(t),target=f.configs.targets()[0]
  const preview=f.switches.preview({targetId:target.id,accountId:f.next.id});f.apply(preview.ticket)
  const file=join(target.directory,'auth.json'),current=JSON.parse(readFileSync(file,'utf8'));current.future='keep';writeFileSync(file,JSON.stringify(current))
  assert.throws(()=>f.switches.previewRestore({targetId:target.id}),/新增了其他字段/)
  delete current.future;writeFileSync(file,JSON.stringify(current))
  f.apply(f.switches.previewRestore({targetId:target.id}).ticket)
  assert.equal(existsSync(file),false);assert.equal(f.store.read().clientAuthorities?.length,0)
})

test('old client-owned credentials are synchronized before transferring the same directory to another account',async t=>{
  const f=fixture(t),identities=f.identities
  await f.authority.bind({ticket:(await identities.read({id:f.target.id})).ticket,accountId:f.old.id})
  writeFileSync(f.file,auth('old','last-client-version',7200));f.apply(f.preview().ticket)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-rt-old-last-client-version')
  assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.next.id)
  f.restore();assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.old.id)
})

test('an actual process kill between file commits leaves an encrypted recoverable journal', {skip:process.platform==='win32'},async t=>{
  for(const kind of ['oauth','api'])for(const at of [1,2]){
    const f=fixture(t),selected=kind==='api'?api(f):f.next
    const result=spawnSync(process.execPath,['--import','tsx','tests/fixtures/client-switch-crash.ts',f.store.directory,f.target.id,selected.id,String(at)],{env:{...process.env,CML_SWITCH_FIXTURE_KEY:f.key.toString('base64')},encoding:'utf8',timeout:10000})
    assert.equal(result.signal,'SIGKILL',result.stderr)
    const store=new Store(f.store.directory,f.codec),tokens=new TokenAuthority(store),configs=new ClientConfigs(store)
    const service=new ClientSwitches(store,configs,tokens)
    assert.equal(service.views()[0].status,'prepared')
    await assert.rejects(tokens.ensure(selected.id),/尚未完成/)
    service.apply({ticket:service.previewRestore({targetId:f.target.id}).ticket,clientClosed:true})
    assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
    assert.equal(service.views().length,0);await tokens.stop()
  }
})

test('re-registering a replaced active directory cannot drop its original recovery reference',t=>{
  const f=fixture(t);f.apply(f.preview().ticket)
  renameSync(f.client,f.client+'-original');mkdirSync(f.client)
  assert.throws(()=>f.configs.register(f.client),/恢复原目录/)
  assert.equal(f.configs.targets().find(value=>value.directory===f.client)?.id,f.target.id)
  rmSync(f.client,{recursive:true});renameSync(f.client+'-original',f.client);f.restore()
})

test('a saved original account cannot acquire a competing file authority while its switch is recoverable',async t=>{
  const f=fixture(t);f.apply(f.preview().ticket)
  const other=join(f.root,'other-client');mkdirSync(other);writeFileSync(join(other,'auth.json'),auth('old'))
  const target=f.configs.register(other),view=await f.identities.read({id:target.id})
  await assert.rejects(f.authority.bind({ticket:view.ticket,accountId:f.old.id}),/恢复原账号/)
  assert.equal(f.store.read().clientAuthorities?.length,1)
  f.restore();assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.old.id)
})

function api(f:ReturnType<typeof fixture>,name='First API',baseUrl='https://fixture.invalid/v1',apiKey='fixture-api-secret'){
  const account=createAPIAccount({name,apiKey,baseUrl,models:['api-model'],wireApi:'responses',defaultTier:'fast'})
  importParsedAccounts(f.store,[account]);return account
}
test('native API switching aligns key, endpoint and model and restores OAuth with no stale relay address or secret preview',async t=>{
  const f=fixture(t),account=api(f)
  writeFileSync(f.config,'forced_login_method="chatgpt"\nopenai_base_url="https://old-relay.invalid/v1"\nservice_tier="default"\nmodel="gpt-fixture"\n')
  const preview=f.switches.preview({targetId:f.target.id,accountId:account.id})
  assert.equal(JSON.stringify(preview).includes('fixture-api-secret'),false)
  f.apply(preview.ticket)
  let doc=new TomlDocument(readFileSync(f.config,'utf8'))
  assert.equal(doc.scalar(['model_provider']),nativeProvider);assert.equal(doc.scalar(['openai_base_url']),null)
  assert.equal(doc.scalar(['forced_login_method']),'api');assert.equal(doc.scalar(['service_tier']),'default')
  assert.equal(doc.scalar(['model']),'api-model');assert.equal(doc.scalar(['model_providers',nativeProvider,'experimental_bearer_token']),'fixture-api-secret')
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).OPENAI_API_KEY,'fixture-api-secret')
  assert.equal(f.store.read().clientAuthorities?.length??0,0)
  assert.equal((await f.identities.read({id:f.target.id})).matchedAccountIds[0],account.id)
  // A successive OAuth switch must clear the prior API-only model/credentials.
  f.apply(f.switches.preview({targetId:f.target.id,accountId:f.next.id}).ticket)
  doc=new TomlDocument(readFileSync(f.config,'utf8'))
  assert.equal(doc.scalar(['model_provider']),'openai');assert.equal(doc.scalar(['model']),'gpt-fixture')
  assert.equal(readFileSync(f.config,'utf8').includes('fixture-api-secret'),false)
  assert.equal(f.switches.views()[0].historyDepth,2)
  f.restore();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).OPENAI_API_KEY,'fixture-api-secret')
  f.restore();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
  assert.equal(new TomlDocument(readFileSync(f.config,'utf8')).scalar(['openai_base_url']),'https://old-relay.invalid/v1')
})

test('successive API switches inherit defaults correctly and unwind endpoint-key pairs even when keys are identical',t=>{
  const f=fixture(t),first=api(f),second=api(f,'Second API','https://second.invalid/v1')
  writeFileSync(f.config,'model="gpt-fixture"\n')
  f.store.transaction(state=>{state.accounts.find(a=>a.id===second.id)!.defaultTier='standard'})
  f.apply(f.switches.preview({targetId:f.target.id,accountId:first.id}).ticket)
  assert.equal(new TomlDocument(readFileSync(f.config,'utf8')).scalar(['service_tier']),'fast')
  f.apply(f.switches.preview({targetId:f.target.id,accountId:second.id}).ticket)
  assert.equal(new TomlDocument(readFileSync(f.config,'utf8')).scalar(['service_tier']),'default')
  f.restore()
  let doc=new TomlDocument(readFileSync(f.config,'utf8'))
  assert.equal(doc.scalar(['model_providers',nativeProvider,'base_url']),'https://fixture.invalid/v1');assert.equal(doc.scalar(['service_tier']),'fast')
  f.restore();doc=new TomlDocument(readFileSync(f.config,'utf8'));assert.equal(doc.scalar(['service_tier']),null)
  assert.equal(f.switches.views().length,0)
})

test('config-only API and built-in API endpoint overrides are identified and restored without reviving dormant OAuth tokens',async t=>{
  for(const source of ['config','builtin','dormant']){
    const f=fixture(t),account=api(f)
    if(source==='builtin'){
      writeFileSync(f.config,'openai_base_url="https://fixture.invalid/v1"\nmodel="api-model"\nforced_login_method="api"\n')
      writeFileSync(f.file,JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:account.credentials.apiKey}))
    }else{
      writeFileSync(f.config,'model_provider="partner"\nmodel="api-model"\n[model_providers.partner]\nbase_url="https://fixture.invalid/v1"\nrequires_openai_auth=false\nexperimental_bearer_token="fixture-api-secret"\n')
      if(source==='config')rmSync(f.file)
    }
    assert.deepEqual((await f.identities.read({id:f.target.id})).matchedAccountIds,[account.id])
    f.apply(f.switches.preview({targetId:f.target.id,accountId:f.next.id}).ticket);f.restore()
    assert.deepEqual((await f.identities.read({id:f.target.id})).matchedAccountIds,[account.id])
    if(source==='config')assert.equal(existsSync(f.file),false)
    else {const value=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(value.OPENAI_API_KEY,'fixture-api-secret');assert.equal(value.tokens,undefined)}
  }
})

test('opaque PATs use the official file shape without fabricated tokens or refresh ownership',async t=>{
  const f=fixture(t),account=parseAccountImport(JSON.stringify({personal_access_token:'at-fixture-opaque-pat'})).accounts[0]
  importParsedAccounts(f.store,[account])
  f.apply(f.switches.preview({targetId:f.target.id,accountId:account.id}).ticket)
  const value=JSON.parse(readFileSync(f.file,'utf8'))
  assert.equal(value.personal_access_token,'at-fixture-opaque-pat');assert.equal(value.tokens,undefined);assert.equal(value.auth_mode,undefined)
  assert.equal(f.store.read().clientAuthorities?.length??0,0)
  assert.deepEqual((await f.identities.read({id:f.target.id})).matchedAccountIds,[account.id])
  assert.equal((await f.tokens.ensure(account.id)).credentials.refreshToken,undefined)
  f.restore();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
})

test('partial API commits restore the correct history layer and preserve later unrelated model/tier edits',t=>{
  for(const at of [1,2]){
    const f=fixture(t),account=api(f);f.apply(f.preview().ticket)
    f.failWrite(at);assert.throws(()=>f.apply(f.switches.preview({targetId:f.target.id,accountId:account.id}).ticket),/未完整提交/)
    assert.equal(f.switches.views()[0].historyDepth,2)
    f.restore();assert.equal(f.switches.views()[0].historyDepth,1);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'new')
    f.restore();assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
  }
  const f=fixture(t),account=api(f);f.apply(f.switches.preview({targetId:f.target.id,accountId:account.id}).ticket)
  writeFileSync(f.config,readFileSync(f.config,'utf8').replace('"api-model"','"user-model"').replace('"fast"','"flex"'))
  f.restore();const doc=new TomlDocument(readFileSync(f.config,'utf8'))
  assert.equal(doc.scalar(['model']),'user-model');assert.equal(doc.scalar(['service_tier']),'flex')
})

test('provider edits, secondary auth replacement and unsupported protocols are rejected without exposing credentials',t=>{
  const f=fixture(t),account=api(f)
  f.apply(f.switches.preview({targetId:f.target.id,accountId:account.id}).ticket)
  const config=readFileSync(f.config,'utf8'),original=readFileSync(f.file,'utf8')
  writeFileSync(f.config,'model_providers.cml_native_account.http_headers.Authorization="fixture-unrelated-secret"\n'+config)
  assert.throws(()=>f.restore(),/外部修改/)
  writeFileSync(f.config,config);writeFileSync(f.file,auth('unrelated'))
  assert.throws(()=>f.restore(),/其他身份/)
  assert.throws(()=>f.switches.preview({targetId:f.target.id,accountId:f.next.id}),/其他身份/)
  writeFileSync(f.file,original);f.restore()
  f.store.transaction(state=>{state.accounts.find(a=>a.id===account.id)!.wireApi='chat_completions'})
  assert.throws(()=>f.switches.preview({targetId:f.target.id,accountId:account.id}),/本地 API 转换/)
  writeFileSync(f.config,'openai_base_url="https://secret:fixture-password@relay.invalid/v1?key=private"')
  const preview=f.preview();assert.equal(JSON.stringify(preview).includes('fixture-password'),false);assert.equal(JSON.stringify(preview).includes('key=private'),false)
})

test('checked native switching and restore reject a real live daemon before writing the vault or client',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t,true),socket=join(f.client,'app-server-control','app-server-control.sock')
  mkdirSync(join(f.client,'app-server-control'))
  const server=createServer(connection=>connection.on('error',()=>{}))
  t.after(()=>server.close())
  const listen=()=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve)})
  const close=()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  await listen()
  const before={auth:readFileSync(f.file,'utf8'),config:readFileSync(f.config,'utf8'),vault:readFileSync(join(f.store.directory,'state.vault'))}
  const preview=f.preview()
  await assert.rejects(f.switches.applyWhenClosed({ticket:preview.ticket,clientClosed:true}),/仍在运行/)
  assert.equal(readFileSync(f.file,'utf8'),before.auth);assert.equal(readFileSync(f.config,'utf8'),before.config)
  assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),before.vault)
  await close()
  await f.switches.applyWhenClosed({ticket:f.preview().ticket,clientClosed:true})
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'new')
  await listen()
  const restore=f.switches.previewRestore({targetId:f.target.id})
  await assert.rejects(f.switches.applyWhenClosed({ticket:restore.ticket,clientClosed:true}),/仍在运行/)
  assert.equal(f.switches.views()[0].status,'committed')
  await close()
  await f.switches.applyWhenClosed({ticket:restore.ticket,clientClosed:true})
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
})

test('daemon preflight cancellation, competing calls, late file changes and shutdown cannot commit a stale switch',async t=>{
  const f=fixture(t);let finish!:(value:'not_detected')=>void,signal:AbortSignal|undefined
  const service=new ClientSwitches(f.store,f.configs,f.tokens,undefined,undefined,undefined,undefined,async(_path,abort)=>{signal=abort;return new Promise(resolve=>{finish=resolve})})
  const preview=()=>service.preview({targetId:f.target.id,accountId:f.next.id})
  const apply=(ticket:string)=>service.applyWhenClosed({ticket,clientClosed:true})
  let staged=preview(),inFlight=apply(staged.ticket)
  await assert.rejects(apply(staged.ticket),/正在检查/)
  writeFileSync(f.file,auth('old','changed'));finish('not_detected');await assert.rejects(inFlight,/已变化/)
  assert.equal(service.views().length,0)
  staged=preview();inFlight=apply(staged.ticket);service.discard(f.target.id)
  assert.equal(signal?.aborted,true);finish('not_detected');await assert.rejects(inFlight,/已取消/)
  staged=preview();inFlight=apply(staged.ticket);service.stop()
  assert.equal(signal?.aborted,true);finish('not_detected');await assert.rejects(inFlight,/已取消/)
  await assert.rejects(apply(staged.ticket),/正在退出/)
  assert.equal(service.views().length,0);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).tokens.account_id,'old')
})
