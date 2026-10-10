import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {Store,type VaultCodec,type StoredAccount} from '../src/main/store'
import {Instances,type InstanceSpeedMenuServices} from '../src/main/instances'
import {NativeInstanceAccounts} from '../src/main/nativeInstanceAccounts'
import {ClientConfigs} from '../src/main/clientConfig'
import {ClientIdentities} from '../src/main/clientIdentity'
import {ClientAuthority} from '../src/main/clientAuthority'
import {ClientSwitches} from '../src/main/clientSwitch'
import {TokenAuthority} from '../src/main/tokens'
import {parseAccountImport,importParsedAccounts,createAPIAccount} from '../src/main/accounts'
import {TomlDocument,patchToml} from '../src/main/tomlPatch'
import {mutateProvider} from '../src/main/providerLibrary'
import type {DesktopRuntime,DesktopPlan,DesktopProcess} from '../src/main/instanceRuntime'

function auth(workspace:string,generation='initial',lifetime=3600){
  const jwt='fixture.'+Buffer.from(JSON.stringify({generation,exp:Math.floor(Date.now()/1000)+lifetime,email:workspace+'@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:workspace,chatgpt_user_id:workspace}})).toString('base64url')+'.signature'
  return JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:jwt,id_token:jwt,refresh_token:'fixture-native-rt-'+generation,account_id:workspace}})
}
function fixture(t:{after(fn:()=>void|Promise<void>):void},systemLanguages:readonly string[]=['en-US'],compatibility?:InstanceSpeedMenuServices){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-native-instance-'))),application=join(root,'Fixture.app')
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true});writeFileSync(join(application,'Contents','MacOS','Codex'),'never execute',{mode:0o700})
  const key=randomBytes(32)
  const codec:VaultCodec={encrypt:raw=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(raw),c.final(),c.getAuthTag()])},decrypt:raw=>{const c=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));c.setAuthTag(raw.subarray(-16));return Buffer.concat([c.update(raw.subarray(12,-16)),c.final()]).toString()}}
  const store=new Store(join(root,'data'),codec),configs=new ClientConfigs(store)
  let requests=0,sharedUse=false,preparing:Promise<void>|undefined
  let project:(account:StoredAccount)=>void|Promise<void>=()=>{}
  const tokens=new TokenAuthority(store,async()=>{requests++;assert.fail('Fixture cannot refresh against a real server')})
  const identities=new ClientIdentities(store,configs,async()=>assert.fail('No keychain in tests'))
  const authority=new ClientAuthority(store,configs,identities,tokens)
  const children=new Map<string,DesktopProcess>(),plans:DesktopPlan[]=[]
  const runtime:DesktopRuntime={find:async plan=>children.get(plan.nonce),launch:async(plan,signal)=>{signal.throwIfAborted();plans.push(plan);const child={pid:45000+plans.length,started:'fixture'};children.set(plan.nonce,child);return child},stop:async plan=>{children.delete(plan.nonce)},focus:async()=>{}}
  let instances:Instances
  const create=()=>{
    const native=new NativeInstanceAccounts(store,tokens,(id,target)=>sharedUse||instances?.usesNativeAccountOutside(id,target)||authority.busy(id),account=>project(account))
    return new Instances(store,()=>assert.fail('Native mode must not start a gateway'),async id=>{await preparing;return tokens.ensure(id)},runtime,native,undefined,undefined,systemLanguages,compatibility)
  }
  instances=create();const app=instances.registerApplication(application)
  importParsedAccounts(store,parseAccountImport('['+auth('alpha')+','+auth('beta')+']').accounts)
  const [alpha,beta]=store.read().accounts
  const add=(accountId=alpha.id,name='Native',model='native-model',defaultTier='fast')=>{instances.save({details:{name,accountId,applicationId:app.id,connectionMode:'native',model,defaultTier,extraArgs:[]}});return instances.views().at(-1)!}
  const start=async(id:string)=>{const view=instances.views().find(value=>value.id===id)!;instances.start(instances.preview({id,revision:view.revision}).ticket);await instances.settled(id)}
  t.after(async()=>{children.clear();await instances.closeAll().catch(()=>{});await tokens.stop();await authority.stop();rmSync(root,{recursive:true,force:true})})
  return {root,key,codec,store,tokens,configs,authority,alpha,beta,app,instances,create,add,start,runtime,children,plans,requests:()=>requests,setShared:(value:boolean)=>{sharedUse=value},setPreparing:(value:Promise<void>)=>{preparing=value},setProject:(value:typeof project)=>{project=value}}
}

test('external native instance recovers rotated credentials and detaches without losing the original login or its refresh authority',async t=>{
  const f=fixture(t),home=join(f.root,'existing-home'),config='# preserved\nmodel="original"\nservice_tier="default"\ncustom=true\n[desktop]\nlocaleOverride="en-US"\n'
  mkdirSync(home);mkdirSync(join(home,'sessions'));writeFileSync(join(home,'sessions','keep.jsonl'),'fixture session')
  writeFileSync(join(home,'config.toml'),config);writeFileSync(join(home,'auth.json'),auth('alpha','original-latest',7200))
  const selected=f.instances.selectCopySource(home,'attach')
  await f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details:{name:'Existing native',applicationId:f.app.id,accountId:f.beta.id,connectionMode:'native',model:'native-model',defaultTier:'fast',extraArgs:[]}})
  const instance=f.instances.views()[0]
  assert.equal(readFileSync(join(home,'config.toml'),'utf8'),config)
  await f.start(instance.id);assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  assert.equal(f.plans[0].directory,home)
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.account_id,'beta')
  writeFileSync(join(home,'auth.json'),auth('beta','external-final',10800))
  await f.instances.stop(instance.id)
  assert.equal(f.store.read().accounts.find(account=>account.id===f.beta.id)!.credentials.refreshToken,'fixture-native-rt-external-final')
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.refresh_token,'fixture-native-rt-original-latest')
  assert.equal(readFileSync(join(home,'config.toml'),'utf8'),config)
  assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.alpha.id)
  f.instances.remove({id:instance.id,revision:instance.revision})
  assert.equal(f.instances.views().length,0);assert.equal(f.configs.identityTarget(instance.id).directory,home)
  assert.equal(readFileSync(join(home,'sessions','keep.jsonl'),'utf8'),'fixture session')
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.account_id,'alpha')
  writeFileSync(join(home,'auth.json'),auth('alpha','after-detach',14400))
  assert.equal((await f.tokens.ensure(f.alpha.id)).credentials.refreshToken,'fixture-native-rt-after-detach')
  assert.equal(f.requests(),0)
})

test('external native login survives a real manager crash and restores through its persisted external directory identity',async t=>{
  const f=fixture(t),home=join(f.root,'external-crash-home'),config='model="external-original"\ncustom=true\n[desktop]\nlocaleOverride="en-US"\n'
  mkdirSync(home);writeFileSync(join(home,'config.toml'),config);writeFileSync(join(home,'auth.json'),auth('alpha','before-crash',7200))
  const selected=f.instances.selectCopySource(home,'attach')
  await f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details:{name:'External crash',applicationId:f.app.id,accountId:f.beta.id,connectionMode:'native',model:'native-model',defaultTier:'fast',extraArgs:[]}})
  const instance=f.instances.views()[0]
  const child=spawnSync(process.execPath,['--import','tsx','tests/fixtures/native-instance-crash.ts',f.store.directory,instance.id],{cwd:resolve('.'),env:{...process.env,CML_NATIVE_INSTANCE_FIXTURE_KEY:f.key.toString('base64')},timeout:10000,encoding:'utf8'})
  assert.equal(child.signal,'SIGKILL',child.stderr)
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.account_id,'beta')
  const reopenedStore=new Store(f.store.directory,f.codec),tokens=new TokenAuthority(reopenedStore,async()=>assert.fail('No refresh during recovery'))
  const reopened=new Instances(reopenedStore,()=>assert.fail('No gateway'),id=>tokens.ensure(id),f.runtime,new NativeInstanceAccounts(reopenedStore,tokens))
  try{
    await reopened.recover();assert.equal(reopened.views()[0].status,'stopped',JSON.stringify(reopened.views()))
    assert.equal(readFileSync(join(home,'config.toml'),'utf8'),config)
    assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.refresh_token,'fixture-native-rt-before-crash')
    assert.equal(reopenedStore.read().clientSwitches?.length,0)
    assert.equal(existsSync(join(f.store.directory,'instances',instance.id,'home','auth.json')),false)
    reopened.remove({id:instance.id,revision:instance.revision});assert.equal(existsSync(join(home,'auth.json')),true)
  }finally{await tokens.stop()}
})

test('native instances own independent file credentials and recover latest rotations before clearing the login',async t=>{
  const f=fixture(t),first=f.add(),second=f.add(f.beta.id,'Second')
  writeFileSync(join(first.directory,'config.toml'),'# before\nmodel="old-model"\nservice_tier="default"\nfuture=true\n')
  await Promise.all([f.start(first.id),f.start(second.id)])
  assert.ok(f.instances.views().every(value=>value.status==='running'),JSON.stringify(f.instances.views()))
  assert.equal(f.instances.views().find(value=>value.id===first.id)?.identityStatus,'native_verified')
  assert.equal(f.instances.views().find(value=>value.id===first.id)?.identityEmail,'alpha@example.invalid')
  assert.equal(f.instances.views().find(value=>value.id===second.id)?.identityStatus,'native_verified')
  assert.equal(f.store.read().clientAuthorities?.length,2)
  const one=JSON.parse(readFileSync(join(first.directory,'auth.json'),'utf8')),two=JSON.parse(readFileSync(join(second.directory,'auth.json'),'utf8'))
  assert.equal(one.tokens.account_id,'alpha');assert.equal(two.tokens.account_id,'beta')
  const config=new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8'))
  assert.equal(config.scalar(['cli_auth_credentials_store']),'file');assert.equal(config.scalar(['service_tier']),'fast');assert.equal(config.scalar(['model']),'native-model')
  assert.equal(f.instances.views()[0].port,undefined);assert.equal(f.instances.views()[0].appliedTier,'priority')
  const restored=auth('alpha','client-rotated',7200);writeFileSync(join(first.directory,'auth.json'),restored)
  assert.equal((await f.tokens.ensure(f.alpha.id)).credentials.refreshToken,'fixture-native-rt-client-rotated')
  assert.equal(f.requests(),0)
  const generic=new ClientSwitches(f.store,f.configs,f.tokens)
  assert.throws(()=>generic.previewRestore({targetId:first.id}),/实例维护/)
  await f.instances.stop(first.id)
  assert.equal(existsSync(join(first.directory,'auth.json')),false)
  assert.equal(new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8')).scalar(['model']),'old-model')
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-native-rt-client-rotated')
  assert.equal(f.store.read().clientAuthorities?.length,1);assert.equal(f.instances.views()[1].status,'running')
  await f.start(first.id);assert.equal(JSON.parse(readFileSync(join(first.directory,'auth.json'),'utf8')).tokens.refresh_token,'fixture-native-rt-client-rotated')
  await f.instances.closeAll();assert.equal(f.store.read().clientSwitches?.length,0);assert.equal(f.store.read().clientAuthorities?.length,0)
  assert.equal(JSON.stringify(f.instances.views()).includes('fixture-native-rt'),false)
  assert.equal(readFileSync(join(f.store.directory,'state.vault')).includes('fixture-native-rt'),false)
})

test('API/PAT native modes use real file shapes, support repeated starts, and do not allocate refresh ownership for static credentials',async t=>{
  const f=fixture(t),api=createAPIAccount({name:'API',apiKey:'fixture-native-key',baseUrl:'https://fixture.invalid/v1',models:['api-model'],wireApi:'responses',defaultTier:'standard'})
  const pat=parseAccountImport('{"personal_access_token":"at-fixture-native-pat"}').accounts[0]
  importParsedAccounts(f.store,[api,pat])
  const first=f.add(api.id,'API','api-model','standard'),second=f.add(api.id,'API second','api-model'),third=f.add(pat.id,'PAT')
  for(const instance of [first,second,third])await f.start(instance.id)
  assert.ok(f.instances.views().every(value=>value.status==='running'),JSON.stringify(f.instances.views()))
  assert.equal(f.store.read().clientAuthorities?.length??0,0)
  assert.equal(JSON.parse(readFileSync(join(first.directory,'auth.json'),'utf8')).OPENAI_API_KEY,'fixture-native-key')
  assert.equal(JSON.parse(readFileSync(join(third.directory,'auth.json'),'utf8')).personal_access_token,'at-fixture-native-pat')
  const doc=new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8'))
  assert.equal(doc.scalar(['model_providers','cml_native_account','base_url']),'https://fixture.invalid/v1');assert.equal(doc.scalar(['service_tier']),'default')
  await f.instances.closeAll()
  for(const instance of [first,third]){await f.start(instance.id);await f.instances.stop(instance.id)}
  assert.equal(f.children.size,0);assert.equal(f.store.read().clientSwitches?.length,0)
})

test('native API instances show the actual provider name, reject rename-stale tickets and restore the original config',async t=>{
  const f=fixture(t),api=createAPIAccount({name:'Independent connection',apiKey:'fixture-provider-key',baseUrl:'https://provider-native.invalid/v1',models:['api-model'],wireApi:'responses',defaultTier:'standard'})
  importParsedAccounts(f.store,[api])
  mutateProvider(f.store,{action:'create',details:{name:'中文供应商',baseUrl:api.baseUrl,models:api.models,wireApi:api.wireApi,defaultTier:'inherit'}})
  const provider=f.store.read().providers![0]
  mutateProvider(f.store,{action:'linkAccount',id:provider.id,revision:provider.revision,keyId:provider.keys[0].id,accountId:api.id,accountRevision:api.revision??0})
  const first=f.add(api.id,'Provider instance','api-model','standard'),original='# preserve\nmodel="before"\ncustom=true\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(join(first.directory,'config.toml'),original)
  await f.start(first.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  let doc=new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8'))
  assert.equal(doc.scalar(['model_providers','cml_native_account','name']),'中文供应商')
  assert.equal(doc.scalar(['model_providers','cml_native_account','base_url']),api.baseUrl)
  assert.equal(doc.scalar(['model_providers','cml_native_account','experimental_bearer_token']),api.credentials.apiKey)
  assert.equal(doc.scalar(['model_provider']),'cml_native_account')
  await f.instances.stop(first.id)
  assert.equal(readFileSync(join(first.directory,'config.toml'),'utf8'),original)
  const preview=f.instances.preview({id:first.id,revision:first.revision}),current=f.store.read().providers![0]
  mutateProvider(f.store,{action:'update',id:current.id,revision:current.revision,changes:{name:'新供应商名称'}})
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  await f.start(first.id)
  doc=new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8'))
  assert.equal(doc.scalar(['model_providers','cml_native_account','name']),'新供应商名称')
  await f.instances.stop(first.id)
  assert.equal(readFileSync(join(first.directory,'config.toml'),'utf8'),original)
})

test('copied Cockpit histories follow the actual native API, OAuth and PAT launch provider',async t=>{
  const f=fixture(t),api=createAPIAccount({name:'Copy API',apiKey:'fixture-copy-key',baseUrl:'https://copy-native.invalid/v1',models:['api-model'],wireApi:'responses',defaultTier:'standard'})
  const pat=parseAccountImport('{"personal_access_token":"at-fixture-copied-pat"}').accounts[0];importParsedAccounts(f.store,[api,pat])
  const home=join(f.root,'cockpit-source');mkdirSync(home);mkdirSync(join(home,'sessions'))
  const config='model_provider="cockpit_cli_proxy"\ncustom=true\n',session='copied-session',file=join(home,'sessions','rollout-fixture.jsonl'),body='{"type":"event_msg","payload":{"text":"existing dialogue"}}\n'
  writeFileSync(join(home,'config.toml'),config);writeFileSync(join(home,'auth.json'),auth('alpha','source-not-cloned'))
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:session,model_provider:'cockpit_cli_proxy',cwd:'/user/project'}})+'\n'+body)
  const dbPath=join(home,'state_5.sqlite'),db=new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,title TEXT,archived INTEGER)')
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(session,file,'cockpit_cli_proxy','kept title',0);db.close();const originalDb=readFileSync(dbPath),originalSession=readFileSync(file)
  for(const [account,model,provider]of [[api,'api-model','cml_native_account'],[f.beta,'native-model','openai'],[pat,'native-model','openai']] as const){
    const selected=f.instances.selectCopySource(home)
    f.instances.startExternalCopy({ticket:selected.ticket,sourceClosed:true,details:{name:'Copied '+account.id,applicationId:f.app.id,accountId:account.id,model,connectionMode:'native',extraArgs:[]}})
    const end=Date.now()+10000
    while(['scanning','copying'].includes(f.instances.copyView()!.status)){if(Date.now()>end)throw new Error('Copy timeout');await new Promise(resolve=>setTimeout(resolve,10))}
    assert.equal(f.instances.copyView()!.status,'completed',f.instances.copyView()!.error)
    const target=f.instances.views().find(value=>value.id===f.instances.copyView()!.targetId)!
    assert.equal(existsSync(join(target.directory,'auth.json')),false)
    await f.start(target.id);assert.equal(f.instances.views().find(value=>value.id===target.id)?.status,'running')
    const actualProvider=new TomlDocument(readFileSync(join(target.directory,'config.toml'),'utf8')).scalar(['model_provider']);assert.equal(actualProvider,provider)
    const copied=new DatabaseSync(join(target.directory,'state_5.sqlite'),{readOnly:true})
    const row=copied.prepare('SELECT * FROM threads WHERE model_provider = ?').get(actualProvider!);copied.close();assert.ok(row)
    assert.equal(row.id,session);assert.equal(row.title,'kept title');assert.equal(row.archived,0)
    const raw=readFileSync(row.rollout_path as string,'utf8'),newline=raw.indexOf('\n');assert.equal(JSON.parse(raw.slice(0,newline)).payload.model_provider,provider);assert.equal(raw.slice(newline+1),body)
    await f.instances.stop(target.id)
  }
  assert.deepEqual(readFileSync(dbPath),originalDb);assert.deepEqual(readFileSync(file),originalSession);assert.equal(readFileSync(join(home,'config.toml'),'utf8'),config)
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.refresh_token,'fixture-native-rt-source-not-cloned')
})

test('native desktop instances default to auto detection and preserve user language changes through auth restoration',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(),file=join(instance.directory,'config.toml'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  const defaultTarget=f.configs.prepareIdentityTarget(f.configs.targets()[0].id),defaultFile=join(defaultTarget.directory,'config.toml'),defaultConfig='# untouched default\n[desktop]\nlocaleOverride="fr-FR"\n'
  writeFileSync(defaultFile,defaultConfig)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopEffectiveLocale,'zh-CN');assert.equal(preview.desktopLocaleSource,'system')
  assert.equal(existsSync(file),false);assert.equal(existsSync(marker),false)
  await f.start(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(existsSync(file)?readFileSync(file,'utf8'):'').raw(['desktop','localeOverride']),null)
  assert.equal(existsSync(marker),true);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  await f.start(instance.id)
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['desktop','localeOverride'],raw:'"en-US"'}]))
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).scalar(['desktop','localeOverride']),'en-US')
  const english=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(english.desktopLocale,'en-US');assert.equal(english.desktopLocaleSource,'existing')
  await f.start(instance.id)
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['desktop','localeOverride'],raw:null}]))
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  const auto=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(auto.desktopLocale,undefined);assert.equal(auto.desktopLocaleSource,'initialized')
  await f.start(instance.id);await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  assert.equal(readFileSync(defaultFile,'utf8'),defaultConfig)
})

test('native desktop loads locale compatibility independently of model speed and restores authentication',async t=>{
  let prepared=0
  const compatibility:InstanceSpeedMenuServices={
    inspect:()=>assert.fail('Native desktops must not inspect the API speed menu'),
    inspectLocale:()=>({supported:true,reason:'',fingerprint:'native-locale-fixture',enhancements:'locale'}),
    prepare:options=>{
      prepared++;assert.equal(options.inspection.enhancements,'locale')
      const folder=join(options.desktopDirectory,'cml-speed-menu',options.nonce);mkdirSync(folder,{recursive:true})
      const script=join(folder,'hook.cjs'),manifest=join(folder,'manifest.json'),statusLog=join(folder,'status.jsonl')
      for(const file of [script,manifest,statusLog])writeFileSync(file,'fixture')
      return {script,manifest,statusLog,env:{CML_CODEX_SPEED_MENU_MANIFEST:manifest,CML_CODEX_SPEED_MENU_LOG:statusLog}}
    },readStatus:()=>({state:'active'})
  }
  const f=fixture(t,['zh-Hans-CN'],compatibility),instance=f.add(),preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.desktopLocaleCompatibilityAvailable,true);assert.equal(preview.speedMenuAvailable,undefined)
  assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopEffectiveLocale,'zh-CN')
  await f.start(instance.id);assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.equal(prepared,1);assert.ok(f.plans[0].desktopLocaleHook);assert.equal(f.plans[0].speedMenuHook,undefined)
  assert.equal(f.instances.views()[0].desktopLocaleCompatibility,'active')
  assert.equal(new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8')).raw(['desktop','localeOverride']),null)
  assert.equal(existsSync(join(instance.directory,'auth.json')),true)
  await f.instances.stop(instance.id)
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  assert.equal(existsSync(join(instance.desktopDirectory,'cml-speed-menu',f.plans[0].nonce)),false)
})

test('native desktop migrates the old manager-seeded locale without restoring it when auth is removed',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(),file=join(instance.directory,'config.toml'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  writeFileSync(file,'# keep\nmodel="original"\n[desktop]\nlocaleOverride="zh-CN"\nappearanceTheme="dark"\n')
  writeFileSync(marker,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  await f.start(instance.id);assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  await f.instances.stop(instance.id)
  const doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.raw(['desktop','localeOverride']),null);assert.equal(doc.scalar(['model']),'original')
  assert.equal(doc.scalar(['desktop','appearanceTheme']),'dark')
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{version:2,source:'auto'})
})

test('native language changes invalidate launch tickets before creating auth or persistent locale state',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(),file=join(instance.directory,'config.toml'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  writeFileSync(file,'[desktop]\nlocaleOverride="en-US"\n')
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  assert.equal(existsSync(marker),false);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  assert.equal(f.plans.length,0);assert.equal(f.store.read().clientSwitches?.length??0,0)
  const before=readFileSync(file,'utf8');await f.start(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  await f.instances.stop(instance.id);assert.equal(readFileSync(file,'utf8'),before)
})

test('native preflight rejects shared rotating chains, wrong protocols/models and stale auth without starting a client',async t=>{
  const f=fixture(t),first=f.add(),second=f.add(f.alpha.id,'Same account')
  f.setShared(true);assert.throws(()=>f.instances.preview({id:first.id,revision:0}),/其他服务/);f.setShared(false)
  await f.start(first.id);assert.throws(()=>f.instances.preview({id:second.id,revision:0}),/其他服务|关联/)
  await f.instances.stop(first.id)
  const preview=f.instances.preview({id:first.id,revision:0});writeFileSync(join(first.directory,'auth.json'),auth('beta'))
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  rmSync(join(first.directory,'auth.json'))
  const api=createAPIAccount({name:'Chat',apiKey:'fixture-key',baseUrl:'https://fixture.invalid',models:['chat-model'],wireApi:'chat_completions',defaultTier:'inherit'})
  importParsedAccounts(f.store,[api]);assert.throws(()=>f.add(api.id,'Unsupported','chat-model'),/Responses/)
  // A previously valid record must also reject a later protocol change.
  f.store.transaction(state=>{state.accounts.find(account=>account.id===api.id)!.wireApi='responses'})
  const unsupported=f.add(api.id,'Changed protocol','chat-model')
  f.store.transaction(state=>{state.accounts.find(account=>account.id===api.id)!.wireApi='chat_completions'})
  assert.throws(()=>f.instances.preview({id:unsupported.id,revision:0}),/Responses/)
  assert.equal(f.plans.length,1);assert.equal(f.store.read().clientSwitches?.length,0)
})

test('cancelled and failed native launches restore files and stop only the owned process',async t=>{
  const f=fixture(t),instance=f.add();let release!:()=>void
  f.setPreparing(new Promise(resolve=>{release=resolve}))
  f.instances.start(f.instances.preview({id:instance.id,revision:0}).ticket)
  const cancel=f.instances.stop(instance.id);release();await cancel
  assert.equal(f.plans.length,0);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  const launch=f.runtime.launch
  f.runtime.launch=async(plan,signal)=>{await launch(plan,signal);throw new Error('fixture after launch')}
  await f.start(instance.id)
  assert.equal(f.children.size,0);assert.equal(f.instances.views()[0].status,'error');assert.equal(f.store.read().clientSwitches?.length,0)
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  await f.instances.stop(instance.id);assert.equal(f.instances.views()[0].status,'stopped')
})

test('native exit saves final credentials; failed recovery retains authority and can retry without replaying old tokens',async t=>{
  const f=fixture(t),instance=f.add();await f.start(instance.id)
  const file=join(instance.directory,'auth.json'),config=join(instance.directory,'config.toml'),original=readFileSync(config,'utf8')
  const stop=f.runtime.stop
  f.runtime.stop=async plan=>{writeFileSync(file,auth('alpha','at-exit',7200));await stop(plan)}
  writeFileSync(config,patchToml(original,[{path:['openai_base_url'],raw:'"https://external-change.invalid"'}]))
  await assert.rejects(f.instances.stop(instance.id),/恢复配置/)
  assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.alpha.id);assert.equal(f.store.read().clientSwitches?.length,1)
  assert.equal(JSON.parse(readFileSync(file,'utf8')).tokens.refresh_token,'fixture-native-rt-at-exit')
  writeFileSync(config,original);await f.instances.stop(instance.id)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-native-rt-at-exit')
  assert.equal(existsSync(file),false);assert.equal(f.requests(),0)
})

test('native restart recovery distinguishes live and dead processes and verifies encrypted journal ownership',async t=>{
  for(const live of [true,false]){
    const f=fixture(t),instance=f.add();await f.start(instance.id)
    let finalGeneration='before-recovery'
    writeFileSync(join(instance.directory,'auth.json'),auth('alpha','before-recovery',7200))
    if(!live)f.children.clear()
    const reopened=f.create();await reopened.recover()
    assert.equal(reopened.views()[0].status,live?'error':'stopped')
    if(live){
      assert.equal(f.store.read().clientAuthorities?.length,1)
      await reopened.refresh();assert.equal(reopened.views()[0].status,'error')
      assert.equal(f.children.size,1,'A live recovered client must keep its auth and configuration')
      finalGeneration='at-natural-exit'
      writeFileSync(join(instance.directory,'auth.json'),auth('alpha',finalGeneration,7200))
      f.children.clear();await reopened.refresh()
      assert.equal(reopened.views()[0].status,'stopped')
      assert.equal(existsSync(join(f.store.directory,'instances',instance.id,'launch.json')),false)
    }
    assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-native-rt-'+finalGeneration)
    assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  }
  const f=fixture(t),instance=f.add();await f.start(instance.id);f.children.clear()
  const file=join(f.store.directory,'instances',instance.id,'launch.json'),checkpoint=JSON.parse(readFileSync(file,'utf8'))
  checkpoint.nonce='8d17de47-a7dc-4cdd-a1be-705f2e19d4a7';writeFileSync(file,JSON.stringify(checkpoint))
  const reopened=f.create();await reopened.recover()
  assert.equal(reopened.views()[0].status,'error');assert.ok(existsSync(join(instance.directory,'auth.json')));assert.equal(f.store.read().clientAuthorities?.length,1)
})

test('actual manager SIGKILL after native auth commit is recovered from encrypted ownership metadata',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),instance=f.add()
  const child=spawnSync(process.execPath,['--import','tsx','tests/fixtures/native-instance-crash.ts',f.store.directory,instance.id],{cwd:resolve('.'),env:{...process.env,CML_NATIVE_INSTANCE_FIXTURE_KEY:f.key.toString('base64')},timeout:10000,encoding:'utf8'})
  assert.equal(child.signal,'SIGKILL',child.stderr)
  const reopenedStore=new Store(f.store.directory,f.codec),tokens=new TokenAuthority(reopenedStore,async()=>assert.fail('No refresh during recovery'))
  const native=new NativeInstanceAccounts(reopenedStore,tokens),instances=new Instances(reopenedStore,()=>assert.fail('No gateway'),id=>tokens.ensure(id),f.runtime,native)
  assert.equal(reopenedStore.read().clientAuthorities?.[0].accountId,f.alpha.id)
  await assert.rejects(tokens.ensure(f.alpha.id),/同步尚未就绪/)
  await instances.recover();assert.equal(instances.views()[0].status,'stopped',JSON.stringify(instances.views()))
  assert.equal(reopenedStore.read().clientSwitches?.length,0);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  await tokens.stop()
})

test('an existing native login is restored from its current chain and can be launched again without leaking the other account',async t=>{
  const f=fixture(t),instance=f.add(f.beta.id)
  writeFileSync(join(instance.directory,'auth.json'),auth('alpha'))
  for(let round=0;round<2;round++){
    await f.start(instance.id);assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
    assert.equal(JSON.parse(readFileSync(join(instance.directory,'auth.json'),'utf8')).tokens.account_id,'beta')
    await f.instances.stop(instance.id)
    assert.equal(JSON.parse(readFileSync(join(instance.directory,'auth.json'),'utf8')).tokens.account_id,'alpha')
    assert.equal(f.store.read().clientAuthorities?.[0].accountId,f.alpha.id)
  }
  assert.equal(f.requests(),0);assert.equal(f.store.read().clientSwitches?.length,0)
})

test('native startup adopts its existing fresh login before considering a stale library refresh token',async t=>{
  const f=fixture(t),instance=f.add()
  f.store.transaction(state=>{state.accounts[0].credentials=parseAccountImport(auth('alpha','stale-library',-60)).accounts[0].credentials})
  writeFileSync(join(instance.directory,'auth.json'),auth('alpha','new-profile',7200))
  const projected:string[]=[];f.setProject(account=>{projected.push(account.credentials.refreshToken??'')})
  await f.start(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  assert.equal(JSON.parse(readFileSync(join(instance.directory,'auth.json'),'utf8')).tokens.refresh_token,'fixture-native-rt-new-profile')
  assert.equal(f.requests(),0);assert.deepEqual(projected,['fixture-native-rt-new-profile'])
  await f.instances.stop(instance.id)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-native-rt-new-profile')
})

test('a failed post-stop runtime update preserves the latest token and retries without recreating the native login',async t=>{
  const f=fixture(t),instance=f.add();await f.start(instance.id)
  writeFileSync(join(instance.directory,'auth.json'),auth('alpha','saved-before-sync',7200))
  f.setProject(()=>{throw new Error('fixture runtime rejected update')})
  await assert.rejects(f.instances.stop(instance.id),/最新凭据已保存/)
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  assert.equal(f.store.read().clientAuthorities?.length,0);assert.equal(f.store.read().clientSwitches?.length,0)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-native-rt-saved-before-sync')
  assert.ok(existsSync(join(f.store.directory,'instances',instance.id,'launch.json')))
  let updated='';f.setProject(account=>{updated=account.credentials.refreshToken!})
  await f.instances.stop(instance.id)
  assert.equal(updated,'fixture-native-rt-saved-before-sync');assert.equal(f.instances.views()[0].status,'stopped')
})

function contextSupplier(f:ReturnType<typeof fixture>){
  const api=createAPIAccount({name:'Context connection',apiKey:'fixture-context-key',baseUrl:'https://context-native.invalid/v1',models:['api-model'],wireApi:'responses',defaultTier:'standard'})
  importParsedAccounts(f.store,[api])
  mutateProvider(f.store,{action:'create',details:{name:'Context supplier',baseUrl:api.baseUrl,models:api.models,wireApi:api.wireApi,defaultTier:'inherit',modelContextWindows:{'api-model':400000}}})
  const provider=f.store.read().providers![0]
  mutateProvider(f.store,{action:'linkAccount',id:provider.id,revision:provider.revision,keyId:provider.keys[0].id,accountId:api.id,accountRevision:api.revision??0})
  return {api,instance:f.add(api.id,'Context instance','api-model','standard')}
}

test('native supplier context reaches the client, restores original values and preserves later manual changes',async t=>{
  const f=fixture(t),{instance}=contextSupplier(f),file=join(instance.directory,'config.toml')
  const original='# preserve\nmodel="before"\nmodel_context_window=128000\nmodel_auto_compact_token_limit=115200\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(file,original)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,400000);assert.equal(preview.effectiveAutoCompactTokenLimit,360000);assert.equal(preview.contextWindowSource,'provider')
  await f.start(instance.id);assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  let doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_context_window']),null);assert.equal(doc.scalar(['model_auto_compact_token_limit']),null)
  const projected=JSON.parse(readFileSync(doc.scalar(['model_catalog_json']) as string,'utf8')).models as Record<string,unknown>[]
  assert.equal(projected.find(model=>model.slug==='api-model')?.context_window,400000)
  assert.equal(projected.find(model=>model.slug==='api-model')?.auto_compact_token_limit,360000)
  await f.instances.stop(instance.id);assert.equal(readFileSync(file,'utf8'),original)
  await f.start(instance.id)
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['model_context_window'],raw:'512000'},{path:['model_auto_compact_token_limit'],raw:'460000'}]))
  await f.instances.stop(instance.id)
  doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_context_window']),512000);assert.equal(doc.scalar(['model_auto_compact_token_limit']),460000)
  assert.equal(doc.scalar(['model_providers','cml_native_account','base_url']),null);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
})

test('actual native startup crash restores the supplier context journal with its auth transaction',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),{instance}=contextSupplier(f),file=join(instance.directory,'config.toml')
  const original='# crash original\nmodel="before"\nmodel_context_window=100000\nmodel_auto_compact_token_limit=85000\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(file,original)
  const child=spawnSync(process.execPath,['--import','tsx','tests/fixtures/native-instance-crash.ts',f.store.directory,instance.id],{cwd:resolve('.'),env:{...process.env,CML_NATIVE_INSTANCE_FIXTURE_KEY:f.key.toString('base64')},timeout:10000,encoding:'utf8'})
  assert.equal(child.signal,'SIGKILL',child.stderr)
  const projected=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(projected.scalar(['model_context_window']),null)
  assert.equal((JSON.parse(readFileSync(projected.scalar(['model_catalog_json']) as string,'utf8')).models as Record<string,unknown>[]).find(model=>model.slug==='api-model')?.context_window,400000)
  const reopenedStore=new Store(f.store.directory,f.codec),tokens=new TokenAuthority(reopenedStore,async()=>assert.fail('No real token request'))
  const reopened=new Instances(reopenedStore,()=>assert.fail('No gateway'),id=>tokens.ensure(id),f.runtime,new NativeInstanceAccounts(reopenedStore,tokens))
  try{
    await reopened.recover();assert.equal(reopened.views()[0].status,'stopped',JSON.stringify(reopened.views()))
    assert.equal(readFileSync(file,'utf8'),original);assert.equal(existsSync(join(instance.directory,'auth.json')),false)
    assert.equal(reopenedStore.read().clientSwitches?.length,0)
  }finally{await tokens.stop()}
})
