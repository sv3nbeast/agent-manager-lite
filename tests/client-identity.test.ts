import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync,linkSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {generateKeyPairSync} from 'node:crypto'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {ClientIdentities,compareIdentity,keychainAccount,type ReadKeyring} from '../src/main/clientIdentity'

const jwt=(account='workspace-a',extra:Record<string,unknown>={})=>`fixture.${Buffer.from(JSON.stringify({email:'fixture@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:account,chatgpt_user_id:'user-a',chatgpt_plan_type:'plus',organization_id:'org-a',...extra}})).toString('base64url')}.signature`
const oauth=(account='workspace-a')=>JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:jwt(account),id_token:jwt(account),refresh_token:'fixture-refresh',account_id:account},last_refresh:'2030-01-01T00:00:00Z'})
function fixture(t:{after(fn:()=>void):void},keyring:ReadKeyring=async()=>{assert.fail('File reads must never access the OS credential store')}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-identity-'))),external=join(root,'client')
  mkdirSync(external);t.after(()=>rmSync(root,{recursive:true,force:true}))
  const store=new Store(join(root,'app'),{encrypt:raw=>Buffer.from(raw),decrypt:raw=>raw.toString()})
  const configs=new ClientConfigs(store),target=configs.register(external)
  let now=Date.now()
  const service=new ClientIdentities(store,configs,keyring,()=>now)
  t.after(()=>service.stop())
  return {root,external,store,configs,target,service,advance:()=>{now+=300001},
    config:(raw:string)=>writeFileSync(join(external,'config.toml'),raw),auth:(raw:string)=>writeFileSync(join(external,'auth.json'),raw),
    read:(includeKeyring=false)=>service.read({id:target.id,includeKeyring})}
}

test('file identity previews contain no credentials, import exactly once and preserve client files and existing library tokens',async t=>{
  const f=fixture(t),raw=oauth();f.auth(raw);f.config('service_tier="fast"\n# retained\n')
  const view=await f.read()
  assert.equal(view.status,'identified');assert.equal(view.source,'file');assert.equal(view.identity?.accountId,'workspace-a')
  assert.equal(view.identity?.userId,'user-a');assert.equal(view.identity?.organizationId,'org-a')
  assert.equal(JSON.stringify(view).includes('fixture-refresh'),false);assert.equal(JSON.stringify(view).includes(jwt()),false)
  assert.equal(f.store.read().accounts.length,0)
  assert.deepEqual(f.service.import(view.ticket!),{added:1,duplicates:0})
  assert.throws(()=>f.service.import(view.ticket!),/过期/)
  assert.equal(readFileSync(join(f.external,'auth.json'),'utf8'),raw)
  assert.equal(readFileSync(join(f.external,'config.toml'),'utf8'),'service_tier="fast"\n# retained\n')
  f.store.transaction(state=>{state.accounts[0].credentials.refreshToken='fixture-newer-library-refresh'})
  const again=await f.read();assert.deepEqual(again.matchedAccountIds,[f.store.read().accounts[0].id])
  assert.deepEqual(f.service.import(again.ticket!),{added:0,duplicates:1})
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-newer-library-refresh')
})

test('keyring is explicit, authoritative over stale files, and imports the chosen snapshot without a second OS read',async t=>{
  let reads=0,reply:string|null=oauth('workspace-keyring'),fail=false
  const f=fixture(t,async directory=>{reads++;assert.equal(directory,f.external);if(fail)throw new Error('fixture-secret-echo');return reply})
  f.config('cli_auth_credentials_store="keyring"\n');f.auth('stale invalid file fixture-secret')
  assert.equal((await f.read()).status,'needs_keyring');assert.equal(reads,0)
  let view=await f.read(true);assert.equal(view.source,'keyring');assert.equal(view.identity?.accountId,'workspace-keyring')
  f.auth('other old file');reply=oauth('later-keyring-identity')
  assert.deepEqual(f.service.import(view.ticket!),{added:1,duplicates:0});assert.equal(reads,1)
  assert.equal(f.store.read().accounts[0].credentials.accountId,'workspace-keyring')
  reply=null;f.auth(oauth());view=await f.read(true)
  assert.equal(view.status,'missing','Keyring mode cannot claim stale auth.json is current')
  f.config('cli_auth_credentials_store="auto"\n');view=await f.read(true)
  assert.equal(view.source,'file');assert.equal(view.identity?.accountId,'workspace-a')
  fail=true;view=await f.read(true);assert.equal(view.status,'error')
  assert.equal(JSON.stringify(view).includes('fixture-secret-echo'),false)
  assert.equal(view.ticket,undefined,'Denied access must not silently import a stale fallback')
  const prior=reads;f.config('cli_auth_credentials_store="ephemeral"\n')
  assert.equal((await f.read(true)).status,'ephemeral');assert.equal(reads,prior)
  f.config('cli_auth_credentials_store="unknown"\n');assert.equal((await f.read(true)).status,'unsupported')
  assert.match(keychainAccount(f.external),/^cli\|[a-f0-9]{16}$/)
})

test('identity matching prioritizes workspace, user and organization and does not guess one-sided IDs from email',async t=>{
  const a={kind:'oauth' as const,name:'A',email:'same@example.invalid',accountId:'workspace-a',userId:'user-a',organizationId:'org-a'}
  assert.equal(compareIdentity(a,{...a,email:'SAME@example.invalid'}),'matched')
  for(const change of [{accountId:'workspace-b'},{userId:'user-b'},{organizationId:'org-b'}])assert.equal(compareIdentity(a,{...a,...change}),'mismatched')
  assert.equal(compareIdentity(a,{kind:'oauth',name:'B',email:a.email}),'unknown')
  assert.equal(compareIdentity({kind:'oauth',name:'A',email:'A@example.invalid'},{kind:'oauth',name:'B',email:'a@example.invalid'}),'matched')
  const f=fixture(t)
  for(const account of ['workspace-a','workspace-b']){f.auth(oauth(account));f.service.import((await f.read()).ticket!)}
  assert.equal(f.store.read().accounts.length,2)
  f.auth(oauth());assert.deepEqual((await f.read()).matchedAccountIds,[f.store.read().accounts[0].id])
  const mixed=JSON.parse(oauth());mixed.tokens.access_token=jwt('workspace-b');f.auth(JSON.stringify(mixed))
  assert.equal((await f.read()).status,'error')
  mixed.tokens.access_token=jwt('workspace-a',{chatgpt_user_id:'other'});f.auth(JSON.stringify(mixed))
  assert.equal((await f.read()).status,'error')
  mixed.tokens.access_token=jwt('workspace-a',{chatgpt_user_id:undefined,user_id:'other'});f.auth(JSON.stringify(mixed))
  assert.equal((await f.read()).status,'error','The user_id alias must not hide a conflicting identity')
  mixed.tokens.id_token=jwt('workspace-a',{chatgpt_user_id:undefined,user_id:'alias-user'})
  mixed.tokens.access_token=jwt('workspace-a',{chatgpt_user_id:undefined,user_id:'alias-user'});f.auth(JSON.stringify(mixed))
  assert.equal((await f.read()).identity?.userId,'alias-user')
  f.auth(oauth());f.config('forced_chatgpt_workspace_id="workspace-b"\n')
  assert.equal((await f.read()).status,'error')
})

test('preview expiry, client changes and replaced directories invalidate import while file links and oversized credentials are rejected',async t=>{
  const f=fixture(t);f.auth(oauth())
  let view=await f.read();f.advance();assert.throws(()=>f.service.import(view.ticket!),/过期/)
  view=await f.read();f.auth(oauth('changed'));assert.throws(()=>f.service.import(view.ticket!),/变化/)
  view=await f.read();f.config('model="changed"\n');assert.throws(()=>f.service.import(view.ticket!),/变化/)
  view=await f.read();renameSync(f.external,f.external+'-previous');mkdirSync(f.external)
  assert.throws(()=>f.service.import(view.ticket!),/替换/)
  const next=f.configs.register(f.external),file=join(f.external,'auth.json'),source=join(f.root,'source')
  writeFileSync(source,oauth());symlinkSync(source,file)
  assert.equal((await f.service.read({id:next.id})).status,'error');rmSync(file)
  linkSync(source,file);assert.equal((await f.service.read({id:next.id})).status,'error');rmSync(file)
  f.auth('x'.repeat(2*1024*1024+1));assert.equal((await f.service.read({id:next.id})).status,'error')
  assert.equal(f.store.read().accounts.length,0)
})

test('OS reads support cancellation and reject a config change while authorization is pending',async t=>{
  let finish!:(value:string)=>void
  const f=fixture(t,async()=>new Promise(resolve=>{finish=resolve}));f.config('cli_auth_credentials_store="keyring"\n')
  let reading=f.read(true)
  await assert.rejects(f.read(true),/正在读取/)
  f.service.cancel(f.target.id);finish(oauth())
  let view=await reading;assert.equal(view.status,'error');assert.match(view.notice!,/取消/);assert.equal(view.ticket,undefined)
  reading=f.read(true);f.config('cli_auth_credentials_store="file"\n');finish(oauth())
  view=await reading;assert.equal(view.status,'error');assert.match(view.notice!,/变化/)
  f.config('cli_auth_credentials_store="keyring"\n');reading=f.read(true);f.service.stop();finish(oauth())
  assert.equal((await reading).ticket,undefined)
})

test('API identity uses its active Provider endpoint and credential source and rejects managed gateway loops',async t=>{
  const f=fixture(t);f.auth(JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-auth-key',tokens:JSON.parse(oauth()).tokens}))
  f.config('model="fixture-model"\nmodel_provider="partner"\n[model_providers.partner]\nbase_url="https://provider.invalid/v1"\nwire_api="responses"\nexperimental_bearer_token="fixture-provider-key"\n')
  let view=await f.read();assert.equal(view.identity?.kind,'api_key');assert.equal(JSON.stringify(view).includes('fixture-provider-key'),false)
  f.service.import(view.ticket!);let account=f.store.read().accounts[0]
  assert.equal(account.baseUrl,'https://provider.invalid/v1');assert.equal(account.credentials.apiKey,'fixture-provider-key')
  f.config('model_provider="partner"\n[model_providers.partner]\nbase_url="https://provider.invalid/v1"\nenv_key="DO_NOT_READ_ENV"\n')
  assert.equal((await f.read()).status,'error')
  f.config('forced_login_method="chatgpt"\n');assert.equal((await f.read()).status,'error')
  f.config('model_provider="cml_instance"\n');assert.equal((await f.read()).status,'error')
  f.config('');f.store.transaction(state=>{state.accounts[0].credentials.localAPIKey='fixture-auth-key'})
  assert.equal((await f.read()).status,'error')
  f.auth(oauth());f.config('model_provider="partner"\n[model_providers.partner]\nrequires_openai_auth=false\n')
  assert.equal((await f.read()).status,'error')
})

test('Agent Identity and PAT files import while private keys and parser errors stay out of views',async t=>{
  const f=fixture(t),key=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64')
  f.auth(JSON.stringify({auth_mode:'agentIdentity',agent_identity:{agent_runtime_id:'fixture-runtime',agent_private_key:key,account_id:'workspace-a',chatgpt_user_id:'user-a'}}))
  let view=await f.read();assert.equal(view.identity?.kind,'agent_identity');assert.equal(JSON.stringify(view).includes(key),false)
  f.service.import(view.ticket!);assert.equal(f.store.read().accounts[0].credentials.agentIdentity?.agent_private_key,key)
  f.auth(JSON.stringify({auth_mode:'personalAccessToken',personal_access_token:'at-fixture-pat'}));view=await f.read()
  assert.equal(view.status,'identified');f.service.import(view.ticket!)
  assert.equal(f.store.read().accounts[1].credentials.accessToken,'at-fixture-pat')
  f.auth('{"tokens":"fixture-private-secret"');view=await f.read()
  assert.equal(view.status,'error');assert.equal(JSON.stringify(view).includes('fixture-private-secret'),false)
  f.auth(oauth());f.config('model = fixture-private-secret\n');view=await f.read()
  assert.equal(view.status,'error');assert.equal(JSON.stringify(view).includes('fixture-private-secret'),false)
})

test('direct Provider credentials are identified without auth.json or system access and tickets bind the config',async t=>{
  const f=fixture(t)
  const provider='model_provider="partner"\nmodel="fixture-model"\n[model_providers.partner]\nbase_url="https://provider.invalid/v1"\nexperimental_bearer_token="fixture-direct-key"\nrequires_openai_auth=false\n'
  for(const mode of ['file','keyring','auto','ephemeral']){
    f.config(`cli_auth_credentials_store="${mode}"\n${provider}`)
    const view=await f.read()
    assert.equal(view.status,'identified');assert.equal(view.source,'config');assert.equal(view.identity?.kind,'api_key')
    assert.equal(JSON.stringify(view).includes('fixture-direct-key'),false)
  }
  // Stale, invalid or replaced auth files have no authority over this source.
  f.auth('stale invalid auth');let view=await f.read()
  f.auth(oauth());assert.deepEqual(f.service.import(view.ticket!),{added:1,duplicates:0})
  const account=f.store.read().accounts[0]
  assert.equal(account.credentials.apiKey,'fixture-direct-key');assert.equal(account.baseUrl,'https://provider.invalid/v1')
  view=await f.read();assert.deepEqual(view.matchedAccountIds,[account.id])
  f.config(provider.replace('fixture-direct-key','changed-fixture-key'))
  assert.throws(()=>f.service.import(view.ticket!),/变化/)
  for(const extra of ['env_key="NO_ENV_ACCESS"','requires_openai_auth=true','auth={command="must-not-execute"}','http_headers={Authorization="fixture-header-key"}','experimental_bearer_token=4']){
    f.config('cli_auth_credentials_store="keyring"\n'+provider.replace('requires_openai_auth=false\n','').replace(extra.startsWith('experimental_')?'experimental_bearer_token="fixture-direct-key"\n':'unused','')+extra+'\n')
    view=await f.read(true);assert.equal(view.status,'error');assert.equal(view.ticket,undefined);assert.notEqual(view.keyringRetry,true)
  }
})
