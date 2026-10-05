import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Store,type StoredAccount} from '../src/main/store'
import {createAPIAccount} from '../src/main/accounts'
import {mutateProvider} from '../src/main/providerLibrary'
import {ClientConfigs} from '../src/main/clientConfig'
import {Instances} from '../src/main/instances'
import {Gateway} from '../src/main/gateway'
import {NativeInstanceAccounts} from '../src/main/nativeInstanceAccounts'
import {TokenAuthority} from '../src/main/tokens'
import {TomlDocument,patchToml} from '../src/main/tomlPatch'
import {connectionModelContextWindows,effectiveModelContextWindows,providerModelContextWindow} from '../src/main/providerModelContext'
import type {DesktopRuntime,DesktopPlan,DesktopProcess} from '../src/main/instanceRuntime'

type Mode='local_api'|'native'
function fixture(t:{after(fn:()=>void|Promise<void>):void},mode:Mode='local_api'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-connection-context-'))),application=join(root,'Fixture.app')
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true})
  writeFileSync(join(application,'Contents','MacOS','Codex'),'fixture-not-executed',{mode:0o700})
  const codec={encrypt:(text:string)=>Buffer.from(text),decrypt:(raw:Buffer)=>raw.toString()}
  const store=new Store(join(root,'data'),codec),tokens=new TokenAuthority(store,async()=>assert.fail('Static connections cannot refresh'))
  const configs=new ClientConfigs(store),gateways:Gateway[]=[],children=new Map<string,DesktopProcess>(),plans:DesktopPlan[]=[]
  const runtime:DesktopRuntime={find:async plan=>children.get(plan.nonce),launch:async(plan,signal)=>{signal.throwIfAborted();plans.push(plan);const child={pid:46000+plans.length,started:'fixture'};children.set(plan.nonce,child);return child},stop:async plan=>{children.delete(plan.nonce)},focus:async()=>{}}
  const instances=new Instances(store,()=>{assert.equal(mode,'local_api');const gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(root,'runtime'),()=>{});gateways.push(gateway);return gateway},id=>tokens.ensure(id),runtime,new NativeInstanceAccounts(store,tokens))
  const app=instances.registerApplication(application)
  t.after(async()=>{await instances.closeAll().catch(()=>{});await Promise.all(gateways.map(gateway=>gateway.stop()));await tokens.stop();rmSync(root,{recursive:true,force:true})})
  function account(models=['shared-model','connection-only','provider-only','plain-model']){
    const account=createAPIAccount({name:'Connection '+randomUUID(),apiKey:'fixture-'+randomUUID(),baseUrl:'https://context-fixture.invalid/v1',models,wireApi:'responses',defaultTier:'inherit'})
    store.transaction(state=>state.accounts.push(account));return account
  }
  function add(account:StoredAccount,model=account.models[0]){instances.save({details:{name:account.name,applicationId:app.id,accountId:account.id,connectionMode:mode,model,defaultTier:'inherit',extraArgs:[]}});return instances.views().at(-1)!}
  function windows(account:StoredAccount,value?:Record<string,number>){store.transaction(state=>{const stored=state.accounts.find(value=>value.id===account.id)!;if(value===undefined)delete stored.modelContextWindows;else stored.modelContextWindows=value})}
  function provider(accounts:StoredAccount[]){
    mutateProvider(store,{action:'create',details:{name:'Shared supplier',baseUrl:accounts[0].baseUrl,models:accounts[0].models,wireApi:'responses',modelContextWindows:{'shared-model':128000,'provider-only':200000}}})
    for(const account of accounts){const provider=store.read().providers![0],key=provider.keys.find(key=>key.apiKey===account.credentials.apiKey)!;mutateProvider(store,{action:'linkAccount',id:provider.id,revision:provider.revision,keyId:key.id,accountId:account.id,accountRevision:account.revision??0})}
    return store.read().providers![0]
  }
  function projected(directory:string){const doc=new TomlDocument(readFileSync(join(directory,'config.toml'),'utf8')),catalog=JSON.parse(readFileSync(doc.scalar(['model_catalog_json']) as string,'utf8'));return {doc,models:catalog.models as Record<string,unknown>[]}}
  async function start(id:string){const instance=instances.views().find(instance=>instance.id===id)!;instances.start(instances.preview({id,revision:instance.revision}).ticket);await instances.settled(id);assert.equal(instances.views().find(instance=>instance.id===id)!.status,'running',JSON.stringify(instances.views()))}
  return {root,store,configs,instances,account,add,windows,provider,projected,start,plans,codec}
}

for(const mode of ['local_api','native'] as const){
  test(`${mode}: two API connections share a provider while independently projecting model windows and restoring config`,async t=>{
    const f=fixture(t,mode),first=f.account(),second=f.account();f.provider([first,second])
    f.windows(first,{'shared-model':512000,'connection-only':400000});f.windows(second,{'shared-model':256000})
    const one=f.add(first),two=f.add(second),original='model_context_window=80000\nmodel_auto_compact_token_limit=70000\n# preserved\n[desktop]\nlocaleOverride="en-US"\n'
    for(const instance of [one,two])writeFileSync(join(instance.directory,'config.toml'),original)
    for(const [instance,window] of [[one,512000],[two,256000]] as const){const preview=f.instances.preview({id:instance.id,revision:instance.revision});assert.equal(preview.effectiveContextWindow,window);assert.equal(preview.effectiveAutoCompactTokenLimit,Math.floor(window*.9));assert.equal(preview.contextWindowSource,'connection')}
    await f.start(one.id);await f.start(two.id)
    const firstProjection=f.projected(one.directory),secondProjection=f.projected(two.directory)
    assert.equal(firstProjection.doc.scalar(['model_context_window']),null);assert.equal(secondProjection.doc.scalar(['model_auto_compact_token_limit']),null)
    for(const [models,expected] of [[firstProjection.models,512000],[secondProjection.models,256000]] as const){assert.equal(models.find(model=>model.slug==='shared-model')?.context_window,expected);assert.equal(models.find(model=>model.slug==='shared-model')?.auto_compact_token_limit,Math.floor(expected*.9));assert.equal(models.find(model=>model.slug==='provider-only')?.context_window,200000);assert.equal(models.find(model=>model.slug==='plain-model')?.context_window,80000)}
    assert.equal(firstProjection.models.find(model=>model.slug==='connection-only')?.context_window,400000);assert.equal(secondProjection.models.find(model=>model.slug==='connection-only')?.context_window,80000)
    await f.instances.stop(one.id);assert.equal(readFileSync(join(one.directory,'config.toml'),'utf8'),original)
    assert.equal(f.instances.views().find(instance=>instance.id===two.id)!.status,'running');assert.equal(f.projected(two.directory).models.find(model=>model.slug==='shared-model')?.context_window,256000)
    await f.instances.stop(two.id);assert.equal(readFileSync(join(two.directory,'config.toml'),'utf8'),original)
    f.windows(first)
    const inherited=f.instances.preview({id:one.id,revision:one.revision});assert.equal(inherited.contextWindowSource,'provider');assert.equal(inherited.effectiveContextWindow,128000)
    await f.start(one.id);assert.equal(f.projected(one.directory).models.find(model=>model.slug==='connection-only')?.context_window,80000)
    await f.instances.stop(one.id);assert.equal(readFileSync(join(one.directory,'config.toml'),'utf8'),original)
  })

  test(`${mode}: standalone connection settings persist and user changes survive stop`,async t=>{
    const f=fixture(t,mode),account=f.account();f.windows(account,{'shared-model':400000,'connection-only':128000})
    const instance=f.add(account),file=join(instance.directory,'config.toml'),original='# original\nmodel="before"\n[desktop]\nlocaleOverride="en-US"\n'
    writeFileSync(file,original)
    assert.deepEqual(new Store(f.store.directory,f.codec).read().accounts[0].modelContextWindows,{'shared-model':400000,'connection-only':128000})
    await f.start(instance.id)
    const projection=f.projected(instance.directory);assert.equal(projection.models.find(model=>model.slug==='connection-only')?.context_window,128000)
    writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['model_context_window'],raw:'96000'},{path:['model_auto_compact_token_limit'],raw:'85000'}]))
    await f.instances.stop(instance.id)
    const restored=new TomlDocument(readFileSync(file,'utf8'));assert.equal(restored.scalar(['model_context_window']),96000);assert.equal(restored.scalar(['model_auto_compact_token_limit']),85000);assert.equal(restored.scalar(['model_catalog_json']),null)
    assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  })

  test(`${mode}: connection context changes invalidate launch and pending projection before writes`,t=>{
    const f=fixture(t,mode),account=f.account();f.windows(account,{'shared-model':128000});const instance=f.add(account)
    const launch=f.instances.preview({id:instance.id,revision:instance.revision})
    const projection=mode==='native'?f.configs.previewInstanceContext(instance.id,f.configs.view(instance.id).revision,'shared-model'):f.configs.previewInstanceConnection(instance.id,f.configs.view(instance.id).revision,{port:12345,key:'fixture-local',model:'shared-model'})
    f.windows(account,{'shared-model':256000})
    assert.throws(()=>f.instances.start(launch.ticket),/已变化/);assert.throws(()=>f.configs.apply(projection.ticket),/上下文|已变化/)
    assert.equal(existsSync(join(instance.directory,'config.toml')),false);assert.equal(existsSync(join(instance.directory,'auth.json')),false);assert.equal(f.plans.length,0)
  })
}

test('connection defaults merge without redefining provider ownership or hiding overridden supplier changes',t=>{
  const f=fixture(t),account=f.account(),provider=f.provider([account]);f.windows(account,{'shared-model':256000});const instance=f.add(account)
  let state=f.store.read(),linked=state.accounts[0],effective=effectiveModelContextWindows(state,linked)
  assert.equal(providerModelContextWindow(state,linked,'shared-model'),128000);assert.equal(effective.windows?.['shared-model'],256000);assert.equal(effective.windows?.['provider-only'],200000)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{modelContextWindows:{'shared-model':512000,'provider-only':200000}}})
  assert.equal(f.configs.instanceModelContext(instance.id,'shared-model').window,256000);assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  f.store.transaction(state=>{state.accounts[0].credentials.apiKey='fixture-corrupt-link'})
  state=f.store.read();linked=state.accounts[0]
  assert.throws(()=>effectiveModelContextWindows(state,linked),/重新关联/);assert.throws(()=>f.configs.instanceModelContext(instance.id,'shared-model'),/重新关联/)
})

test('model IDs use own exact keys including prototype-shaped names and OAuth ignores connection overrides',t=>{
  const f=fixture(t),account=f.account(['GPT-6-SOL','constructor','toString','__proto__'])
  f.windows(account,JSON.parse('{"GPT-6-SOL":400000,"constructor":128000,"__proto__":64000}'))
  const instance=f.add(account),context=f.configs.instanceModelContext(instance.id,'GPT-6-SOL')
  assert.equal(context.window,400000);assert.equal(context.origin,'connection')
  assert.equal(effectiveModelContextWindows(f.store.read(),f.store.read().accounts[0]).windows?.['gpt-6-sol'],undefined)
  assert.throws(()=>f.configs.instanceModelContext(instance.id,'gpt-6-sol'),/模型名称仅大小写不同/)
  assert.equal(f.configs.instanceModelContext(instance.id,'constructor').window,128000);assert.equal(f.configs.instanceModelContext(instance.id,'__proto__').window,64000);assert.equal(f.configs.instanceModelContext(instance.id,'toString').window,272000)
  const catalog=JSON.parse(context.catalogFile!.content).models as Record<string,unknown>[]
  assert.equal(catalog.find(model=>model.slug==='GPT-6-SOL')?.context_window,400000);assert.equal(catalog.some(model=>model.slug==='gpt-6-sol'),false)
  const windows=connectionModelContextWindows(f.store.read().accounts[0])!;assert.equal(Object.getPrototypeOf(windows),null);assert.equal(Object.hasOwn(windows,'toString'),false)
  f.store.transaction(state=>{state.accounts[0].kind='oauth';state.accounts[0].modelContextWindows={'GPT-6-SOL':2}})
  assert.equal(connectionModelContextWindows(f.store.read().accounts[0]),undefined);assert.equal(f.configs.instanceModelContext(instance.id,'GPT-6-SOL').override,undefined);assert.equal(f.configs.instanceModelContext(instance.id,'GPT-6-SOL').catalogFile,undefined)
})

test('invalid persisted connection overrides fail before any launch writes',t=>{
  const f=fixture(t),account=f.account(),instance=f.add(account)
  for(const value of [1,128000.5,10_000_001]){f.windows(account,{'shared-model':value});assert.throws(()=>f.instances.preview({id:instance.id,revision:instance.revision}),/上下文窗口/);assert.equal(existsSync(join(instance.directory,'config.toml')),false)}
})
