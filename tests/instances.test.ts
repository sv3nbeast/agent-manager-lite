import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, renameSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import {createServer as createSocketServer} from 'node:net'
import { Store } from '../src/main/store'
import { Instances, type InstanceSpeedMenuServices } from '../src/main/instances'
import { Gateway } from '../src/main/gateway'
import { ClientConfigs } from '../src/main/clientConfig'
import { createAPIAccount, editAccount, deleteAccounts } from '../src/main/accounts'
import { TomlDocument,patchToml } from '../src/main/tomlPatch'
import {mutateProvider} from '../src/main/providerLibrary'
import {instanceProviderName} from '../src/main/instanceProviderName'
import {builtInCatalog} from '../src/main/modelCatalog'
import { MacDesktopRuntime, desktopEnvironment, macLaunchArgs, type DesktopRuntime, type DesktopPlan, type DesktopProcess } from '../src/main/instanceRuntime'

class FixtureDesktop implements DesktopRuntime {
  readonly children=new Map<string,DesktopProcess>()
  readonly plans:DesktopPlan[]=[]
  async find(plan:DesktopPlan){return this.children.get(plan.nonce)}
  async launch(plan:DesktopPlan,signal:AbortSignal){signal.throwIfAborted();this.plans.push(plan);const child={pid:40000+this.plans.length,started:'fixture'};this.children.set(plan.nonce,child);return child}
  async stop(plan:DesktopPlan){this.children.delete(plan.nonce)}
  async focus(plan:DesktopPlan){assert.ok(this.children.has(plan.nonce))}
}
type Context={after(fn:()=>void|Promise<void>):void}
function fixture(t:Context,systemLanguages:readonly string[]=['en-US'],speedMenus?:InstanceSpeedMenuServices) {
  const root=mkdtempSync(join(tmpdir(),'cml-instances-')),application=join(root,'Fixture.app')
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true})
  writeFileSync(join(application,'Contents','MacOS','Codex'),'fixture-not-executed',{mode:0o700})
  const codec={encrypt:(text:string)=>Buffer.from(text),decrypt:(buffer:Buffer)=>buffer.toString()}
  const store=new Store(join(root,'data'),codec),runtime=new FixtureDesktop(),gateways:Gateway[]=[]
  const events:Record<string,unknown>[]=[]
  let prepare=async(id:string)=>store.read().accounts.find(value=>value.id===id)!
  let now=Date.now()
  const create=()=>new Instances(store,()=>{const gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(root,'runtime'),event=>events.push(event));gateways.push(gateway);return gateway},id=>prepare(id),runtime,undefined,()=>now,undefined,systemLanguages,speedMenus)
  const instances=create(),app=instances.registerApplication(application)
  t.after(async()=>{await instances.closeAll().catch(()=>{});await Promise.all(gateways.map(gateway=>gateway.stop()));rmSync(root,{recursive:true,force:true})})
  function account(url='http://127.0.0.1:9',key='fixture-upstream',models=['fixture-model']) {const a=createAPIAccount({name:`Account ${randomUUID()}`,apiKey:key,baseUrl:url,models,wireApi:'responses',defaultTier:'inherit',note:'',tags:[]});store.transaction(state=>state.accounts.push(a));return a}
  function add(accountId:string,name='Fixture',defaultTier='fast',model='fixture-model') {instances.save({details:{name,applicationId:app.id,accountId,model,defaultTier,extraArgs:[]}});return instances.views().at(-1)!}
  return {root,store,runtime,instances,create,app,account,add,gateways,events,advance:()=>{now+=300001},setPrepare:(value:typeof prepare)=>{prepare=value}}
}
function connection(directory:string) {
  const doc=new TomlDocument(readFileSync(join(directory,'config.toml'),'utf8'))
  return {url:doc.scalar(['model_providers','cml_instance','base_url']) as string,key:doc.scalar(['model_providers','cml_instance','experimental_bearer_token']) as string,doc}
}
function linkProvider(f:ReturnType<typeof fixture>,account:ReturnType<ReturnType<typeof fixture>['account']>,name:string){
  mutateProvider(f.store,{action:'create',details:{name,baseUrl:account.baseUrl,models:account.models,wireApi:account.wireApi,defaultTier:'inherit'}})
  const provider=f.store.read().providers!.at(-1)!
  mutateProvider(f.store,{action:'linkAccount',id:provider.id,revision:provider.revision,keyId:provider.keys[0].id,accountId:account.id,accountRevision:account.revision??0})
  return f.store.read().providers!.find(value=>value.id===provider.id)!
}
function speedMenuFixture(includeLocale=false) {
  let fingerprint='fixture-speed-v1'
  const prepared: string[]=[]
  const observedScopes:Array<{pid?:number;enhancements?:string}>=[]
  const service:InstanceSpeedMenuServices={
    inspect:()=>({supported:true,reason:'',fingerprint,enhancements:'speed'}),
    prepare:options=>{
      prepared.push(options.inspection.enhancements??'speed')
      const folder=join(options.desktopDirectory,'cml-speed-menu',options.nonce)
      mkdirSync(folder,{recursive:true})
      const script=join(folder,'hook.cjs'),manifest=join(folder,'manifest.json'),statusLog=join(folder,'status.jsonl')
      for(const file of [script,manifest,statusLog])writeFileSync(file,'fixture')
      return {script,manifest,statusLog,env:{CML_CODEX_SPEED_MENU_MANIFEST:manifest,CML_CODEX_SPEED_MENU_LOG:statusLog}}
    },
    readStatus:scope=>{observedScopes.push(scope);return {state:'active'}}
  }
  if(includeLocale){
    service.inspectLocale=()=>({supported:true,reason:'',fingerprint:fingerprint+'-locale',enhancements:'locale'})
    service.inspectCombined=()=>({supported:true,reason:'',fingerprint:fingerprint+'-combined',enhancements:'speed-locale'})
  }
  return {service,prepared,observedScopes,changeClient:()=>{fingerprint='fixture-speed-v2'}}
}

test('locale and speed compatibility share one hook while new desktops keep native auto detection',async t=>{
  const menus=speedMenuFixture(true),f=fixture(t,['zh-Hans-CN'],menus.service),account=f.account('http://127.0.0.1:9','fixture-upstream',['gpt-5.5']),instance=f.add(account.id,'Combined','fast','gpt-5.5')
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopEffectiveLocale,'zh-CN')
  assert.equal(preview.desktopLocaleCompatibilityAvailable,true);assert.equal(preview.speedMenuAvailable,true)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.deepEqual(menus.prepared,['speed-locale'])
  assert.ok(f.runtime.plans[0].speedMenuHook);assert.equal(f.runtime.plans[0].desktopLocaleHook,undefined)
  assert.equal(f.instances.views()[0].desktopLocaleCompatibility,'active');assert.equal(f.instances.views()[0].speedMenu,'active')
  assert.equal(menus.observedScopes.at(-1)!.pid,f.instances.views()[0].pid)
  assert.equal(menus.observedScopes.at(-1)!.enhancements,'speed-locale')
  assert.equal(f.gateways[0].current().defaultTier,'default')
  assert.equal(connection(instance.directory).doc.raw(['desktop','localeOverride']),null)
  await f.instances.stop(instance.id)
  assert.equal(existsSync(join(instance.desktopDirectory,'cml-speed-menu',f.runtime.plans[0].nonce)),false)
})

test('locale compatibility works without Fast capability and leaves gateway tier semantics intact',async t=>{
  const menus=speedMenuFixture(true),f=fixture(t,['zh-Hans-CN'],menus.service),instance=f.add(f.account().id)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.speedMenuAvailable,false);assert.equal(preview.desktopLocaleCompatibilityAvailable,true)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.deepEqual(menus.prepared,['locale'])
  assert.equal(f.runtime.plans[0].speedMenuHook,undefined);assert.ok(f.runtime.plans[0].desktopLocaleHook)
  assert.equal(f.instances.views()[0].desktopLocaleCompatibility,'active')
  assert.equal(f.gateways[0].current().defaultTier,'priority')
  assert.equal(connection(instance.directory).doc.scalar(['service_tier']),'fast')
  const hook=f.runtime.plans[0].desktopLocaleHook!
  assert.ok(macLaunchArgs(f.runtime.plans[0]).includes(`NODE_OPTIONS=--require="${hook.script}"`))
  await f.instances.stop(instance.id)
  assert.equal(existsSync(join(instance.desktopDirectory,'cml-speed-menu',f.runtime.plans[0].nonce)),false)
})

test('locale resource changes invalidate a pending launch without touching saved language or credentials',t=>{
  const menus=speedMenuFixture(true),f=fixture(t,['zh-Hans-CN'],menus.service),instance=f.add(f.account().id)
  const pending=f.instances.preview({id:instance.id,revision:instance.revision});menus.changeClient()
  assert.throws(()=>f.instances.start(pending.ticket),/已变化/)
  assert.equal(f.runtime.plans.length,0)
  assert.equal(existsSync(join(instance.directory,'config.toml')),false)
  assert.equal(existsSync(join(f.store.directory,'instances',instance.id,'desktop-locale.json')),false)
})

test('API desktop speed menu starts automatically, sends Normal despite Fast defaults, and preserves native choice across stop/restart',async t=>{
  const received:string[]=[]
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw);received.push(body.service_tier)
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture-response',object:'response',model:body.model,output:[],usage:{input_tokens:1,output_tokens:1}}))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{upstream.closeAllConnections();upstream.close(()=>resolve())}))
  const address=upstream.address();assert.ok(address&&typeof address==='object')
  const menus=speedMenuFixture(),f=fixture(t,['en-US'],menus.service),account=f.account(`http://127.0.0.1:${address.port}`,'fixture-upstream',['gpt-5.5'])
  const provider=linkProvider(f,account,'Fast provider')
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{defaultTier:'fast'}})
  f.store.transaction(state=>{state.settings.defaultTier='fast';state.accounts.find(a=>a.id===account.id)!.defaultTier='fast'})
  const instance=f.add(account.id,'Fixture','fast','gpt-5.5'),preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.speedMenuAvailable,true);assert.equal(preview.tier,'priority')
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.equal(f.instances.views()[0].speedMenu,'active');assert.equal(f.instances.views()[0].initialTier,'priority')
  assert.ok(f.runtime.plans[0].speedMenuHook)
  const c=connection(instance.directory)
  assert.equal(c.doc.scalar(['service_tier']),'fast')
  const request=async(tier?:string)=>{const response=await fetch(c.url+'/responses',{method:'POST',headers:{Authorization:`Bearer ${c.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.5',input:'fixture',service_tier:tier})});await response.text();assert.equal(response.status,200)}
  await request();await request('priority');await request()
  assert.deepEqual(received,['default','priority','default'])
  const file=join(instance.directory,'config.toml')
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['service_tier'],raw:'"default"'}]))
  await f.instances.stop(instance.id)
  assert.equal(existsSync(join(instance.desktopDirectory,'cml-speed-menu',f.runtime.plans[0].nonce)),false)
  const stopped=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(stopped.scalar(['service_tier']),'default')
  assert.equal(stopped.raw(['model_providers','cml_instance','experimental_bearer_token']),null)
  assert.equal(stopped.raw(['model_provider']),null)
  const restart=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(restart.tier,'default');assert.equal(restart.speedPreferenceSource,'existing')
  f.instances.start(restart.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.equal(connection(instance.directory).doc.scalar(['service_tier']),'default')
})

test('speed-menu client changes invalidate launch and unsupported clients retain original Fast behavior',async t=>{
  const menus=speedMenuFixture(),f=fixture(t,['en-US'],menus.service),account=f.account(),instance=f.add(account.id,'Fixture','fast','gpt-5.5')
  const preview=f.instances.preview({id:instance.id,revision:instance.revision});menus.changeClient()
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  const normal=fixture(t),other=normal.add(normal.account().id)
  const unsupported=normal.instances.preview({id:other.id,revision:other.revision})
  assert.equal(unsupported.speedMenuAvailable,false)
  normal.instances.start(unsupported.ticket);await normal.instances.settled(other.id)
  assert.equal(normal.instances.views()[0].status,'running',normal.instances.views()[0].error)
  assert.equal(normal.runtime.plans[0].speedMenuHook,undefined)
  assert.equal(normal.gateways[0].current().defaultTier,'priority')
})

test('a model without declared Fast capability retains existing Fast fallback without a misleading menu adaptation',async t=>{
  const menus=speedMenuFixture(),f=fixture(t,['en-US'],menus.service),account=f.account(),instance=f.add(account.id)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.speedMenuAvailable,false)
  assert.match(preview.speedMenuReason!,/未声明 Fast/)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.equal(f.runtime.plans[0].speedMenuHook,undefined)
  assert.equal(f.gateways[0].current().defaultTier,'priority')
})

test('speed menu launch environment is instance scoped and composes with temporary login without inheriting flags',()=>{
  const base:DesktopPlan={application:'/fixture/app.app',executable:'/fixture/app.app/Contents/MacOS/Codex',directory:'/fixture/home',desktopDirectory:'/fixture/desktop',workingDirectory:'/fixture/workspace',args:[],nonce:randomUUID()}
  const hook={script:'/fixture/desktop/speed hook.cjs',manifest:'/fixture/desktop/manifest.json',statusLog:'/fixture/desktop/status.jsonl',env:{CML_CODEX_SPEED_MENU_MANIFEST:'/fixture/desktop/manifest.json',CML_CODEX_SPEED_MENU_LOG:'/fixture/desktop/status.jsonl'}}
  const args=macLaunchArgs({...base,speedMenuHook:hook,tempLoginHook:{script:'/fixture/auth hook.cjs',capture:'/fixture/capture.jsonl'}})
  assert.ok(args.includes('NODE_OPTIONS=--require="/fixture/auth hook.cjs" --require="/fixture/desktop/speed hook.cjs"'))
  assert.ok(args.includes('CML_CODEX_SPEED_MENU_MANIFEST=/fixture/desktop/manifest.json'))
  assert.deepEqual(desktopEnvironment({PATH:'/bin',CML_CODEX_SPEED_MENU_MANIFEST:'/another-instance',NODE_OPTIONS:'--require=other'}),{PATH:'/bin'})
  assert.throws(()=>macLaunchArgs({...base,speedMenuHook:{...hook,env:{OPENAI_API_KEY:'fixture'}}}),/环境无效/)
  assert.deepEqual(macLaunchArgs({...base,desktopLocaleHook:hook}),macLaunchArgs({...base,speedMenuHook:hook}))
  assert.throws(()=>macLaunchArgs({...base,speedMenuHook:hook,desktopLocaleHook:hook}),/一份组合/)
})
async function fixtureEvidence(directory:string){
  const deadline=Date.now()+3000
  for(;;){
    try{return JSON.parse(readFileSync(join(directory,'fixture-desktop.json'),'utf8'))}
    catch(error){if(Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,20))}
  }
}

test('managed instances persist independently, expose config targets, reject stale/unsafe input and archive files without deleting accounts',async t=>{
  const f=fixture(t),account=f.account(),first=f.add(account.id),second=f.add(account.id,'Second')
  assert.notEqual(first.directory,second.directory);assert.notEqual(first.desktopDirectory,second.desktopDirectory)
  assert.equal(new ClientConfigs(f.store).targets().length,3)
  assert.equal(f.create().views().length,2)
  assert.throws(()=>f.instances.save({id:first.id,revision:12,details:first}),/变化|unrecognized/i)
  const details={name:'Unsafe',applicationId:f.app.id,accountId:account.id,model:'fixture-model',defaultTier:'fast',extraArgs:['--user-data-dir=/outside']}
  assert.throws(()=>f.instances.save({details}),/隔离/)
  assert.throws(()=>f.instances.save({details:{...details,extraArgs:[],applicationId:'unselected'}}),/选择/)
  writeFileSync(join(first.directory,'session-fixture'),'keep')
  f.instances.remove({id:first.id,revision:first.revision})
  const archived=readdirSync(join(f.store.directory,'instance-trash'))[0]
  assert.equal(readFileSync(join(f.store.directory,'instance-trash',archived,'home','session-fixture'),'utf8'),'keep')
  assert.equal(f.store.read().accounts.length,1)
  assert.equal(new ClientConfigs(f.store).targets().length,2)
  const original=second.directory+'-original';renameSync(second.directory,original);symlinkSync(f.root,second.directory,'dir')
  assert.throws(()=>f.instances.preview({id:second.id,revision:second.revision}),/目录/)
  assert.equal(existsSync(join(f.root,'config.toml')),false)
})

test('two instances own different gateways and credentials; Fast/Standard reach real upstream and stopping one preserves the other',async t=>{
  const received:{key:string|undefined;tier:unknown}[]=[]
  const upstream=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received.push({key:req.headers.authorization,tier:JSON.parse(raw).service_tier});res.setHeader('Content-Type','application/json');res.end('{"id":"fixture","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();upstream.close()})
  const address=upstream.address();assert.ok(address && typeof address==='object')
  const f=fixture(t),a=f.account(`http://127.0.0.1:${address.port}`,'fixture-a'),b=f.account(a.baseUrl,'fixture-b')
  const first=f.add(a.id),second=f.add(b.id,'Second','standard')
  writeFileSync(join(first.directory,'config.toml'),'# user comment\nmodel="original"\ncustom="keep"\n')
  for(const instance of [first,second]){const preview=f.instances.preview({id:instance.id,revision:instance.revision});assert.equal(JSON.stringify(preview).includes('fixture-a'),false);f.instances.start(preview.ticket);await f.instances.settled(instance.id)}
  assert.ok(f.instances.views().every(value=>value.status==='running'),JSON.stringify(f.instances.views()))
  const c1=connection(first.directory),c2=connection(second.directory)
  assert.notEqual(c1.url,c2.url);assert.notEqual(c1.key,c2.key)
  assert.equal(c1.doc.scalar(['cli_auth_credentials_store']),'file')
  assert.equal(c1.doc.scalar(['custom']),'keep')
  assert.equal(readFileSync(join(first.directory,'config.toml'),'utf8').includes('fixture-a'),false)
  const request=async(c:typeof c1,tier?:string,key=c.key)=>{const r=await fetch(c.url+'/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'fixture',service_tier:tier})});await r.text();return r.status}
  assert.equal(await request(c1),200);assert.deepEqual(received.at(-1),{key:'Bearer fixture-a',tier:'priority'})
  assert.equal(await request(c2),200);assert.deepEqual(received.at(-1),{key:'Bearer fixture-b',tier:'default'})
  assert.equal(await request(c1,'default'),200);assert.equal(received.at(-1)?.tier,'default')
  assert.equal(await request(c2,undefined,c1.key),401)
  assert.throws(()=>editAccount(f.store,{id:a.id,revision:0,changes:{apiKey:'replacement'}},id=>f.instances.usesAccount(id)),/停止/)
  assert.throws(()=>deleteAccounts(f.store,[a.id],id=>f.instances.usesAccount(id)),/停止/)
  const configs=new ClientConfigs(f.store,Date.now,id=>f.instances.inUse(id)),view=configs.view(first.id),draft=configs.preview({id:first.id,revision:view.revision,changes:{model:'user-new'}})
  assert.throws(()=>configs.apply(draft.ticket),/停止实例/)
  await f.instances.stop(first.id)
  assert.equal(new TomlDocument(readFileSync(join(first.directory,'config.toml'),'utf8')).scalar(['model']),'original')
  assert.equal(connection(second.directory).key,c2.key)
  assert.equal(await request(c2),200)
  await f.instances.closeAll()
  assert.equal(f.runtime.children.size,0)
  assert.deepEqual(readdirSync(join(f.root,'runtime')),[])
  assert.equal(JSON.stringify(f.instances.views()).includes(c1.key),false)
})

test('launch tickets expire on configuration/default changes; cancelling credential preparation never launches a client',async t=>{
  const f=fixture(t),account=f.account(),instance=f.add(account.id,'Fixture','inherit')
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  f.store.transaction(state=>{state.settings.defaultTier='standard'})
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  let release!:()=>void
  f.setPrepare(async()=>{await new Promise<void>(resolve=>{release=resolve});return account})
  const next=f.instances.preview({id:instance.id,revision:instance.revision});f.instances.start(next.ticket)
  assert.equal(f.instances.views()[0].status,'preparing')
  const stopping=f.instances.stop(instance.id);release();await stopping
  assert.equal(f.runtime.plans.length,0);assert.equal(f.instances.views()[0].status,'stopped')
  assert.equal(existsSync(join(instance.directory,'config.toml')),false)
})

test('local instance client configuration displays each current provider name and restores original config bytes with an existing language choice',async t=>{
  const f=fixture(t),a=f.account('https://provider-a.invalid/v1'),b=f.account('https://provider-b.invalid/v1','fixture-b')
  linkProvider(f,a,'中文供应商「甲」');linkProvider(f,b,'Provider B')
  const first=f.add(a.id),second=f.add(b.id,'Second'),original='# preserve name and formatting\nmodel="original"\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(join(first.directory,'config.toml'),original)
  for(const instance of [first,second]){
    f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
    assert.equal(f.instances.views().find(value=>value.id===instance.id)!.status,'running')
  }
  const one=connection(first.directory),two=connection(second.directory)
  assert.equal(one.doc.scalar(['model_providers','cml_instance','name']),'中文供应商「甲」')
  assert.equal(two.doc.scalar(['model_providers','cml_instance','name']),'Provider B')
  assert.equal(one.doc.scalar(['model_provider']),'cml_instance')
  assert.match(one.url,/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal(one.key.includes(a.credentials.apiKey!),false)
  await f.instances.stop(first.id)
  assert.equal(readFileSync(join(first.directory,'config.toml'),'utf8'),original)
  assert.equal(connection(second.directory).doc.scalar(['model_providers','cml_instance','name']),'Provider B')
})

test('provider renaming invalidates pending launch tickets and the next launch uses the new name; unlink uses the independent connection name',async t=>{
  const f=fixture(t),account=f.account('https://provider-label.invalid/v1'),provider=linkProvider(f,account,'Before'),instance=f.add(account.id)
  const first=f.instances.preview({id:instance.id,revision:instance.revision})
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{name:'重命名后的供应商'}})
  assert.throws(()=>f.instances.start(first.ticket),/已变化/)
  const current=f.instances.preview({id:instance.id,revision:instance.revision});f.instances.start(current.ticket);await f.instances.settled(instance.id)
  assert.equal(connection(instance.directory).doc.scalar(['model_providers','cml_instance','name']),'重命名后的供应商')
  await f.instances.stop(instance.id)
  const linked=f.store.read().accounts.find(value=>value.id===account.id)!,pending=f.instances.preview({id:instance.id,revision:instance.revision})
  mutateProvider(f.store,{action:'unlinkAccount',accountId:account.id,accountRevision:linked.revision??0})
  assert.throws(()=>f.instances.start(pending.ticket),/已变化/)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  assert.equal(connection(instance.directory).doc.scalar(['model_providers','cml_instance','name']),account.name)
})

test('instance config commit refuses a provider name changed after projection preview without writing stale attribution',t=>{
  const f=fixture(t),account=f.account('https://provider-commit.invalid/v1'),provider=linkProvider(f,account,'Before'),instance=f.add(account.id)
  const configs=new ClientConfigs(f.store),view=configs.view(instance.id),preview=configs.previewInstanceConnection(instance.id,view.revision,{port:12345,key:'fixture-local',model:'fixture-model'})
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{name:'After'}})
  assert.throws(()=>configs.apply(preview.ticket),/供应商关联或名称已变化/)
  assert.equal(existsSync(join(instance.directory,'config.toml')),false)
})

test('moving a supplier key does not retain the previous provider attribution; explicitly linking it uses the target provider',async t=>{
  const f=fixture(t),account=f.account('https://provider-old.invalid/v1'),source=linkProvider(f,account,'Old provider'),instance=f.add(account.id)
  mutateProvider(f.store,{action:'create',details:{name:'Target provider',baseUrl:'https://provider-target.invalid/v1',models:account.models,wireApi:account.wireApi,defaultTier:'inherit'}})
  const target=f.store.read().providers!.at(-1)!
  mutateProvider(f.store,{action:'moveKey',id:source.id,revision:source.revision,keyId:source.keys[0].id,targetId:target.id,targetRevision:target.revision})
  let state=f.store.read(),active=state.accounts.find(value=>value.id===account.id)!
  assert.equal(active.providerId,undefined)
  assert.equal(instanceProviderName(state,active),account.name)
  const moved=state.providers!.find(value=>value.id===target.id)!
  mutateProvider(f.store,{action:'linkAccount',id:moved.id,revision:moved.revision,keyId:moved.keys[0].id,accountId:account.id,accountRevision:active.revision??0})
  state=f.store.read();active=state.accounts.find(value=>value.id===account.id)!
  assert.equal(instanceProviderName(state,active),'Target provider')
  assert.equal(active.baseUrl,target.baseUrl)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running')
  assert.equal(connection(instance.directory).doc.scalar(['model_providers','cml_instance','name']),'Target provider')
})

test('provider attribution uses the current association and ignores archived source names',t=>{
  const f=fixture(t),account=f.account('https://provider-current.invalid/v1')
  linkProvider(f,account,'Current provider')
  f.store.transaction(state=>{state.accounts[0].source={api_provider_name:'Archived provider',provider_name:'Older provider'}})
  let state=f.store.read(),active=state.accounts[0]
  assert.equal(instanceProviderName(state,active),'Current provider')
  f.store.transaction(state=>{state.providers![0].keys[0].apiKey='different-fixture-key'})
  state=f.store.read();active=state.accounts[0]
  assert.throws(()=>instanceProviderName(state,active),/供应商关联已变化/)
  assert.equal(instanceProviderName(state,{...account,kind:'oauth',providerId:undefined,providerKeyId:undefined}),'ChatGPT')
})

test('local desktop instances default to auto detection, keep live user language changes and leave the managed default profile untouched',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(f.account().id),configs=new ClientConfigs(f.store)
  const defaultTarget=configs.prepareIdentityTarget(configs.targets()[0].id),defaultFile=join(defaultTarget.directory,'config.toml'),defaultSource='model="default-profile"\n[desktop]\nlocaleOverride="fr-FR"\n'
  writeFileSync(defaultFile,defaultSource)
  const file=join(instance.directory,'config.toml'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  const start=async()=>{
    const preview=f.instances.preview({id:instance.id,revision:instance.revision});f.instances.start(preview.ticket);await f.instances.settled(instance.id)
    assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
    return preview
  }
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopEffectiveLocale,'zh-CN');assert.equal(preview.desktopLocaleSource,'system')
  assert.equal(existsSync(file),false);assert.equal(existsSync(marker),false)
  await start()
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(existsSync(file)?readFileSync(file,'utf8'):'').raw(['desktop','localeOverride']),null)
  assert.equal(existsSync(marker),true)
  await start()
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['desktop','localeOverride'],raw:'"en-US"'}]))
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).scalar(['desktop','localeOverride']),'en-US')
  const english=await start();assert.equal(english.desktopLocale,'en-US');assert.equal(english.desktopLocaleSource,'existing')
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['desktop','localeOverride'],raw:null}]))
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  const auto=await start();assert.equal(auto.desktopLocale,undefined);assert.equal(auto.desktopLocaleSource,'initialized')
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).raw(['desktop','localeOverride']),null)
  assert.equal(readFileSync(defaultFile,'utf8'),defaultSource)
})

test('local desktop upgrades only an unchanged manager-seeded language to auto detection',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(f.account().id),file=join(instance.directory,'config.toml'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  writeFileSync(file,'# preserved\nmodel="before"\n[desktop]\nlocaleOverride="zh-CN"\nappearanceTheme="dark"\n')
  writeFileSync(marker,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  const preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopEffectiveLocale,'zh-CN')
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',f.instances.views()[0].error)
  assert.equal(connection(instance.directory).doc.raw(['desktop','localeOverride']),null)
  await f.instances.stop(instance.id)
  const restored=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(restored.raw(['desktop','localeOverride']),null);assert.equal(restored.scalar(['desktop','appearanceTheme']),'dark')
  assert.equal(restored.scalar(['model']),'before')
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{version:2,source:'auto'})
})

test('changing desktop language files invalidates local launch tickets before initialization or a client launch',async t=>{
  const f=fixture(t,['zh-Hans-CN']),instance=f.add(f.account().id),file=join(instance.directory,'config.toml'),global=join(instance.directory,'.codex-global-state.json'),marker=join(f.store.directory,'instances',instance.id,'desktop-locale.json')
  const ticket=f.instances.preview({id:instance.id,revision:instance.revision}).ticket
  writeFileSync(global,'{"localeOverride":"en-US"}')
  assert.throws(()=>f.instances.start(ticket),/已变化/)
  assert.equal(f.runtime.plans.length,0);assert.equal(existsSync(file),false);assert.equal(existsSync(marker),false)
  rmSync(global)
  const next=f.instances.preview({id:instance.id,revision:instance.revision})
  f.setPrepare(async id=>{writeFileSync(global,'{"localeOverride":"ja-JP"}');return f.store.read().accounts.find(account=>account.id===id)!})
  f.instances.start(next.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'error');assert.match(f.instances.views()[0].error!,/已变化/)
  assert.equal(f.runtime.plans.length,0);assert.equal(existsSync(file),false);assert.equal(existsSync(marker),false)
})

test('CLI instances do not seed desktop language settings even on a Chinese system',async t=>{
  const f=fixture(t,['zh-Hans-CN']),cliFile=join(f.root,'FixtureCLI')
  writeFileSync(cliFile,Buffer.from('cffaedfe00000000','hex'),{mode:0o700})
  const cli=f.instances.registerApplication(cliFile,'cli'),account=f.account()
  f.instances.save({details:{name:'CLI',applicationId:cli.id,accountId:account.id,model:'fixture-model',defaultTier:'standard',extraArgs:[]}})
  const instance=f.instances.views()[0],preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.launchMode,'cli');assert.equal(preview.desktopLocale,undefined);assert.equal(preview.desktopLocaleSource,undefined)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  assert.equal(new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8')).raw(['desktop','localeOverride']),null)
  assert.equal(existsSync(join(f.store.directory,'instances',instance.id,'desktop-locale.json')),false)
  await f.instances.stop(instance.id)
  assert.equal(new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8')).raw(['desktop','localeOverride']),null)
})

test('external edits during startup prevent projection; later edits survive natural client exit and configuration restoration',async t=>{
  const f=fixture(t),account=f.account(),instance=f.add(account.id)
  f.setPrepare(async()=>{writeFileSync(join(instance.directory,'config.toml'),'model="newer"\n');return account})
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'error');assert.equal(f.runtime.plans.length,0)
  assert.equal(readFileSync(join(instance.directory,'config.toml'),'utf8'),'model="newer"\n')
  await f.instances.stop(instance.id)
  f.setPrepare(async()=>account)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  const text=readFileSync(join(instance.directory,'config.toml'),'utf8').replace('model="fixture-model"','model="user-after-start"').replace('model = "fixture-model"','model = "user-after-start"')
  writeFileSync(join(instance.directory,'config.toml'),text)
  f.runtime.children.clear();await f.instances.refresh()
  assert.equal(f.instances.views()[0].status,'stopped')
  assert.match(f.instances.views()[0].notice!,/保留/)
  assert.equal(new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8')).scalar(['model']),'user-after-start')
})

test('restart recovery retains owned live instances, restores dead instances, and blocks ambiguous checkpoints',async t=>{
  const f=fixture(t),account=f.account(),instance=f.add(account.id)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  await f.gateways[0].stop() // Simulate sidecar exit after its owning manager disappears.
  const reopened=f.create();await reopened.recover()
  assert.equal(reopened.views()[0].status,'error');assert.ok(reopened.views()[0].pid)
  assert.throws(()=>reopened.preview({id:instance.id,revision:instance.revision}),/正在运行/)
  await reopened.stop(instance.id);assert.equal(f.runtime.children.size,0)
  writeFileSync(join(f.store.directory,'instances',instance.id,'launch.json'),'{broken')
  const damaged=f.create();await damaged.recover()
  assert.equal(damaged.views()[0].status,'error')
  assert.throws(()=>damaged.preview({id:instance.id,revision:instance.revision}),/正在运行/)
})

test('macOS LaunchServices uses two isolated homes, verifies real PIDs and refuses a mismatched executable',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS LaunchServices integration');return}
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-native-desktop-'))),application=join(root,'Fixture.app'),executable=join(application,'Contents','MacOS','Codex')
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true})
  writeFileSync(join(application,'Contents','Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.cml.fixture.${randomUUID()}</string><key>CFBundleName</key><string>CML Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  execFileSync('go',['build','-o',executable,'tests/fixtures/desktop-client.go'],{cwd:resolve('.'),timeout:30_000,stdio:'pipe'})
  const runtime=new MacDesktopRuntime(),plans:DesktopPlan[]=[]
  t.after(async()=>{await Promise.all(plans.map(plan=>runtime.stop(plan)));rmSync(root,{recursive:true,force:true})})
  for(let i=0;i<2;i++) {
    const directory=join(root,`home-${i}`),desktopDirectory=join(root,`desktop-${i}`);mkdirSync(directory);mkdirSync(desktopDirectory)
    const plan:DesktopPlan={application,executable,directory,desktopDirectory,workingDirectory:root,args:['literal $(never-run)'],nonce:randomUUID()};plans.push(plan)
    const child=await runtime.launch(plan,new AbortController().signal)
    const evidence=await fixtureEvidence(directory)
    assert.equal(evidence.pid,child.pid);assert.equal(evidence.home,directory);assert.equal(evidence.desktop,desktopDirectory)
    assert.ok(evidence.args.includes('literal $(never-run)'))
  }
  await runtime.stop({...plans[0],executable:'/bin/sleep'})
  assert.ok(await runtime.find(plans[0]))
  await runtime.stop(plans[0]);assert.equal(await runtime.find(plans[0]),undefined);assert.ok(await runtime.find(plans[1]))
  assert.ok(macLaunchArgs(plans[1]).includes(`CODEX_HOME=${plans[1].directory}`))
  assert.deepEqual(desktopEnvironment({HOME:'/fixture',CODEX_HOME:'/other',ELECTRON_RUN_AS_NODE:'1',OPENAI_API_KEY:'fixture',NODE_OPTIONS:'--inspect',PATH:'/bin'}),{HOME:'/fixture',PATH:'/bin'})
})

test('instance checkpoints survive interruptions before and after configuration replacement',async t=>{
  for(const committed of [false,true]) {
    const f=fixture(t),account=f.account(),instance=f.add(account.id)
    const configs=new ClientConfigs(f.store),view=configs.view(instance.id)
    const preview=configs.previewInstanceConnection(instance.id,view.revision,{port:43210,key:'fixture-local',model:'fixture-model',tier:'priority'})
    let backup=''
    const apply=()=>configs.apply(preview.ticket,id=>{
      backup=id
      writeFileSync(join(f.store.directory,'instances',instance.id,'launch.json'),JSON.stringify({nonce:randomUUID(),backup:id}))
      if(!committed)throw new Error('fixture interrupted before rename')
    })
    if(committed) {
      apply()
      const file=join(f.store.directory,'config-backups',instance.id,backup,'change.json')
      const journal=JSON.parse(readFileSync(file,'utf8'));journal.status='prepared';writeFileSync(file,JSON.stringify(journal))
    } else assert.throws(apply,/interrupted/)
    const reopened=f.create();await reopened.recover()
    assert.equal(reopened.views()[0].status,'stopped',JSON.stringify(reopened.views()))
    assert.equal(existsSync(join(f.store.directory,'instances',instance.id,'launch.json')),false)
    assert.equal(reopened.views()[0].notice,undefined)
    const restored=existsSync(join(instance.directory,'config.toml'))?readFileSync(join(instance.directory,'config.toml'),'utf8'):''
    assert.equal(restored.includes('fixture-local'),false)
  }
})

test('natural exit and concurrent stop share cleanup; failed local connections become actionable errors',async t=>{
  const f=fixture(t),account=f.account(),instance=f.add(account.id)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  await f.gateways[0].stop();await f.instances.refresh()
  assert.equal(f.instances.views()[0].status,'error');assert.match(f.instances.views()[0].error!,/本地连接/)
  assert.equal(f.instances.usesAccount(account.id),true)
  await f.instances.stop(instance.id)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  let stops=0
  const stop=f.runtime.stop.bind(f.runtime)
  f.runtime.stop=async plan=>{stops++;await new Promise(resolve=>setTimeout(resolve,20));await stop(plan)}
  f.runtime.children.clear()
  await Promise.all([f.instances.refresh(),f.instances.stop(instance.id),f.instances.stop(instance.id)])
  assert.equal(stops,1);assert.equal(f.instances.views()[0].status,'stopped')
  writeFileSync(join(f.store.directory,'instances',instance.id,'launch.json'),'{broken')
  const damaged=f.create();await damaged.recover()
  assert.equal(damaged.usesAccount(account.id),true)
  assert.throws(()=>deleteAccounts(f.store,[account.id],id=>damaged.usesAccount(id)),/停止/)
})

async function copyFinished(instances:Instances){
  const end=Date.now()+10000
  for(;;){const state=instances.copyView();if(state&&!['scanning','copying'].includes(state.status))return state;if(Date.now()>end)throw new Error('Copy timeout');await new Promise(resolve=>setTimeout(resolve,10))}
}
function copyInput(source:ReturnType<Instances['views']>[number],name:string,accountId=source.accountId){
  return {id:source.id,revision:source.revision,details:{name,applicationId:source.applicationId,accountId,connectionMode:source.connectionMode,defaultTier:source.defaultTier,model:source.model,extraArgs:source.extraArgs,workingDirectoryId:source.workingDirectoryId}}
}
test('instance copy preserves complete profile files and launches independently with the selected API account',async t=>{
  const received:{key:string|undefined;tier:unknown}[]=[]
  const upstream=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received.push({key:req.headers.authorization,tier:JSON.parse(raw).service_tier});res.setHeader('Content-Type','application/json');res.end('{"id":"copy-fixture","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();upstream.close()})
  const address=upstream.address();assert.ok(address&&typeof address==='object')
  const f=fixture(t),original=f.account(),selected=f.account(`http://127.0.0.1:${address.port}/v1`,'fixture-copy-selected'),source=f.add(original.id,'Original')
  const config='# retain custom config\nmodel="original-model"\n[features]\nfixture_enabled=true\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(join(source.directory,'config.toml'),config);writeFileSync(join(source.directory,'auth.json'),'{"tokens":{"refresh_token":"do-not-clone-rotation"}}')
  mkdirSync(join(source.directory,'sessions'));mkdirSync(join(source.directory,'skills'))
  writeFileSync(join(source.directory,'sessions','fixture.jsonl'),'中文 $(literal)\n');writeFileSync(join(source.directory,'skills','tool.sh'),'#!/bin/bash\n',{mode:0o700})
  const state=Buffer.alloc(3*1024*1024,42);writeFileSync(join(source.directory,'opaque-state.bin'),state)
  symlinkSync('/does-not-exist',join(source.directory,'external-skill'))
  writeFileSync(join(source.desktopDirectory,'window-state'),'not a Codex home file')
  f.instances.startCopy(copyInput(source,'Independent',selected.id))
  assert.equal(f.instances.inUse(source.id),true);assert.equal(f.instances.usesAccount(selected.id),true)
  assert.throws(()=>f.instances.save({id:source.id,revision:source.revision,details:copyInput(source,'Edited').details}),/停止/)
  const done=await copyFinished(f.instances);assert.equal(done.status,'completed',done.error);assert.equal(done.files,4);assert.equal(done.skipped,2)
  const target=f.instances.views().find(value=>value.id===done.targetId)!
  assert.equal(existsSync(join(target.directory,'auth.json')),false);assert.equal(existsSync(join(target.directory,'external-skill')),false)
  assert.equal(readFileSync(join(target.directory,'config.toml'),'utf8'),config);assert.equal(readFileSync(join(target.directory,'sessions','fixture.jsonl'),'utf8'),'中文 $(literal)\n')
  assert.deepEqual(readFileSync(join(target.directory,'opaque-state.bin')),state);assert.notEqual(statSync(join(target.directory,'opaque-state.bin')).ino,statSync(join(source.directory,'opaque-state.bin')).ino)
  assert.ok(statSync(join(target.directory,'skills','tool.sh')).mode&0o100);assert.equal(existsSync(join(target.desktopDirectory,'window-state')),false)
  f.instances.start(f.instances.preview({id:target.id,revision:0}).ticket);await f.instances.settled(target.id)
  assert.equal(f.instances.views().find(value=>value.id===target.id)?.status,'running')
  assert.equal(f.gateways[0].accountIds()[0],selected.id);assert.equal(readFileSync(join(source.directory,'config.toml'),'utf8'),config)
  const conn=connection(target.directory),response=await fetch(conn.url+'/responses',{method:'POST',headers:{Authorization:`Bearer ${conn.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'fixture'})})
  assert.equal(response.status,200);await response.text();assert.deepEqual(received,[{key:'Bearer fixture-copy-selected',tier:'priority'}])
  await f.instances.stop(target.id);assert.equal(readFileSync(join(target.directory,'config.toml'),'utf8').trimStart(),config)
  assert.equal(readFileSync(join(source.directory,'auth.json'),'utf8').includes('do-not-clone-rotation'),true)
})

test('copy cancellation, stale inputs and running sources never publish partial instances',async t=>{
  const f=fixture(t),source=f.add(f.account().id)
  assert.throws(()=>f.instances.startCopy({...copyInput(source,'Stale'),revision:7}),/已变化/)
  assert.throws(()=>f.instances.startCopy(copyInput(source,source.name)),/名称/)
  assert.throws(()=>f.instances.startCopy({...copyInput(source,'Unknown program'),details:{...copyInput(source,'Unknown program').details,applicationId:'missing'}}),/选择/)
  f.instances.startCopy(copyInput(source,'Cancelled'));const id=f.instances.copyView()!.id
  assert.throws(()=>f.instances.startCopy(copyInput(source,'Concurrent')),/正在复制/)
  assert.throws(()=>f.instances.remove({id:source.id,revision:0}),/运行/)
  await f.instances.cancelCopy(id);assert.equal(f.instances.copyView()?.status,'cancelled');assert.equal(f.instances.views().length,1)
  assert.equal(f.instances.inUse(source.id),false);assert.equal(existsSync(join(f.store.directory,'instances',id)),false)
  f.instances.start(f.instances.preview({id:source.id,revision:0}).ticket);await f.instances.settled(source.id)
  assert.throws(()=>f.instances.startCopy(copyInput(source,'Running')),/运行/)
})

test('copy commit errors roll back only the new directory and retain the source',async t=>{
  const f=fixture(t),source=f.add(f.account().id)
  writeFileSync(join(source.directory,'keep'),'unchanged')
  const transaction=f.store.transaction.bind(f.store)
  f.store.transaction=()=>{throw new Error('fixture vault write failure')}
  f.instances.startCopy(copyInput(source,'Cannot commit'));const done=await copyFinished(f.instances)
  assert.equal(done.status,'failed');assert.match(done.error!,/vault/);assert.equal(f.instances.views().length,1)
  assert.equal(existsSync(join(f.store.directory,'instances',done.id)),false);assert.equal(readFileSync(join(source.directory,'keep'),'utf8'),'unchanged')
  f.store.transaction=transaction
})

test('restart archives interrupted staged and promoted copies but keeps a committed instance',async t=>{
  const f=fixture(t),source=f.add(f.account().id),committed=f.add(source.accountId,'Committed')
  for(const parent of ['instance-copies','instances']){
    const id=randomUUID(),folder=join(f.store.directory,parent,id);mkdirSync(folder,{recursive:true})
    writeFileSync(join(folder,'copy.json'),JSON.stringify({id,sourceId:source.id}));writeFileSync(join(folder,'partial'),'preserve me')
  }
  const committedFolder=join(f.store.directory,'instances',committed.id)
  writeFileSync(join(committedFolder,'copy.json'),JSON.stringify({id:committed.id,sourceId:source.id}))
  const reopened=f.create();await reopened.recover()
  assert.equal(reopened.views().length,2);assert.match(reopened.views().find(value=>value.id===source.id)!.notice!,/归档/)
  assert.equal(existsSync(join(committedFolder,'copy.json')),false);assert.equal(existsSync(committed.directory),true)
  const archived=readdirSync(join(f.store.directory,'instance-trash'));assert.equal(archived.length,2)
  for(const name of archived)assert.equal(readFileSync(join(f.store.directory,'instance-trash',name,'partial'),'utf8'),'preserve me')
})

test('explicit external home copy is read-only, uses a single-use capability and locks registered config operations',async t=>{
  const f=fixture(t),account=f.account(),source=realpathSync(f.root)+'/外部 Codex $ ;',config='# source\nmodel="source-model"\n'
  mkdirSync(source);writeFileSync(join(source,'config.toml'),config);writeFileSync(join(source,'auth.json'),'fixture-do-not-import')
  mkdirSync(join(source,'sessions'));writeFileSync(join(source,'sessions','conversation.jsonl'),'source conversation')
  const configs=new ClientConfigs(f.store,Date.now,id=>f.instances.inUse(id)),registered=configs.register(source)
  const before=configs.view(registered.id),edit=configs.preview({id:registered.id,revision:before.revision,changes:{model:'changed'}})
  const choice=f.instances.selectCopySource(source),details={name:'External copy',applicationId:f.app.id,accountId:account.id,model:'fixture-model',defaultTier:'fast',extraArgs:[]}
  assert.equal(readFileSync(join(source,'config.toml'),'utf8'),config)
  assert.throws(()=>f.instances.startExternalCopy({ticket:choice.ticket,sourceClosed:false,details}))
  assert.throws(()=>f.instances.startExternalCopy({ticket:choice.ticket,sourceClosed:true,details,directory:source}))
  f.instances.startExternalCopy({ticket:choice.ticket,sourceClosed:true,details})
  assert.equal(f.instances.inUse(registered.id),true)
  assert.throws(()=>configs.apply(edit.ticket),/停止实例/)
  assert.throws(()=>f.instances.startExternalCopy({ticket:choice.ticket,sourceClosed:true,details}),/过期/)
  const done=await copyFinished(f.instances);assert.equal(done.status,'completed',done.error);assert.equal(done.external,true)
  const target=f.instances.views().find(value=>value.id===done.targetId)!
  assert.equal(readFileSync(join(target.directory,'config.toml'),'utf8'),config);assert.equal(existsSync(join(target.directory,'auth.json')),false)
  assert.notEqual(statSync(join(target.directory,'sessions','conversation.jsonl')).ino,statSync(join(source,'sessions','conversation.jsonl')).ino)
  assert.equal(readFileSync(join(source,'auth.json'),'utf8'),'fixture-do-not-import');assert.equal(readFileSync(join(source,'config.toml'),'utf8'),config)
  assert.equal(f.instances.inUse(registered.id),false);assert.equal(f.store.read().accounts.length,1)
})

test('external copy rejects unselected, stale, replaced, overlapping and authority-owned source directories',async t=>{
  const f=fixture(t),source=realpathSync(f.root)+'/external';mkdirSync(source);writeFileSync(join(source,'config.toml'),'model="source"\n')
  const details={name:'Copy',applicationId:f.app.id,accountId:f.account().id,model:'fixture-model',extraArgs:[]}
  assert.throws(()=>f.instances.startExternalCopy({ticket:randomUUID(),sourceClosed:true,details}),/过期/)
  const expired=f.instances.selectCopySource(source);f.advance()
  assert.throws(()=>f.instances.startExternalCopy({ticket:expired.ticket,sourceClosed:true,details}),/过期/)
  const replaced=f.instances.selectCopySource(source)
  renameSync(source,source+'-original');mkdirSync(source);writeFileSync(join(source,'config.toml'),'model="replaced"\n')
  assert.throws(()=>f.instances.startExternalCopy({ticket:replaced.ticket,sourceClosed:true,details}),/替换/)
  assert.throws(()=>f.instances.selectCopySource(f.store.directory),/数据目录/)
  assert.throws(()=>f.instances.selectCopySource(f.root),/数据目录/)
  const empty=join(f.root,'empty');mkdirSync(empty);assert.throws(()=>f.instances.selectCopySource(empty),/CODEX_HOME/)
  const target=new ClientConfigs(f.store).register(source)
  f.store.transaction(state=>{state.clientAuthorities=[{targetId:target.id,accountId:details.accountId,createdAt:Date.now()}]})
  assert.throws(()=>f.instances.selectCopySource(source),/凭据关联/)
  assert.equal(f.instances.views().length,0)
})

test('external live daemon prevents copy; interrupted external copy is archived and visible after restart',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
  const f=fixture(t),source=realpathSync(mkdtempSync('/tmp/cml-copy-daemon-'))
  t.after(()=>rmSync(source,{recursive:true,force:true}))
  writeFileSync(join(source,'config.toml'),'model="fixture"\n');mkdirSync(join(source,'app-server-control'))
  const server=createSocketServer(socket=>socket.end())
  t.after(()=>server.close())
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(source,'app-server-control','app-server-control.sock'),resolve)})
  const choice=f.instances.selectCopySource(source)
  f.instances.startExternalCopy({ticket:choice.ticket,sourceClosed:true,details:{name:'No live copy',applicationId:f.app.id,accountId:f.account().id,model:'fixture-model',extraArgs:[]}})
  const done=await copyFinished(f.instances);assert.equal(done.status,'failed');assert.match(done.error!,/后台进程仍在运行/)
  assert.equal(f.instances.views().length,0);assert.equal(server.listening,true)
  const id=randomUUID(),folder=join(f.store.directory,'instance-copies',id);mkdirSync(folder,{recursive:true})
  writeFileSync(join(folder,'copy.json'),JSON.stringify({id,sourceId:choice.ticket,external:true,sourceName:'external'}));writeFileSync(join(folder,'partial'),'preserved')
  const reopened=f.create();await reopened.recover()
  assert.equal(reopened.copyView()?.external,true);assert.match(reopened.copyView()!.error!,/已归档/)
  const archive=readdirSync(join(f.store.directory,'instance-trash'))[0]
  assert.equal(readFileSync(join(f.store.directory,'instance-trash',archive,'partial'),'utf8'),'preserved')
})

test('existing directory registration keeps its config identity, launches against that home and detaches without removing source files',async t=>{
  const f=fixture(t),requests:unknown[]=[]
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({key:req.headers.authorization,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end('{"id":"existing-fixture","object":"response","status":"completed","output":[]}')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const port=(server.address() as {port:number}).port,account=f.account(`http://127.0.0.1:${port}/v1`,'fixture-existing-key')
  const path=realpathSync(f.root)+'/existing',config='# retain source\nmodel="original"\ncustom="untouched"\n';mkdirSync(path)
  writeFileSync(join(path,'config.toml'),config);writeFileSync(join(path,'auth.json'),'fixture-original-auth');writeFileSync(join(path,'session.jsonl'),'original session')
  const configs=new ClientConfigs(f.store,Date.now,id=>f.instances.inUse(id)),target=configs.register(path),before=configs.view(target.id)
  const backup=configs.apply(configs.preview({id:target.id,revision:before.revision,changes:{model_reasoning_effort:'high'}}).ticket).revisions[0].id
  const original=readFileSync(join(path,'config.toml'),'utf8'),inode=statSync(path).ino
  const choice=f.instances.selectCopySource(path,'attach')
  await f.instances.attachExisting({ticket:choice.ticket,sourceClosed:true,details:{name:'Existing',applicationId:f.app.id,accountId:account.id,model:'fixture-model',defaultTier:'fast',extraArgs:[]}})
  let instance=f.instances.views()[0]
  assert.equal(instance.id,target.id);assert.equal(instance.directory,path);assert.ok(instance.externalHome)
  assert.equal(configs.targets().filter(value=>value.directory===path).length,1);assert.equal(configs.register(path).id,target.id)
  assert.equal(f.store.read().configTargets?.length,0);assert.equal(configs.view(target.id).revisions[0].id,backup)
  assert.equal(readFileSync(join(path,'config.toml'),'utf8'),original)
  f.instances.save({id:instance.id,revision:0,details:copyInput(instance,'Renamed').details});instance=f.instances.views()[0]
  assert.equal(instance.externalHome?.directory,path)
  const preview=f.instances.preview({id:instance.id,revision:instance.revision});assert.equal(preview.externalHome,true);assert.equal(preview.directory,path)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running');assert.equal(f.runtime.plans[0].directory,path)
  const conn=connection(path),response=await fetch(conn.url+'/responses',{method:'POST',headers:{Authorization:'Bearer '+conn.key,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'fixture request'})})
  assert.equal(response.status,200);await response.text()
  assert.deepEqual(requests,[{key:'Bearer fixture-existing-key',body:{model:'fixture-model',input:'fixture request',service_tier:'priority'}}])
  assert.throws(()=>f.instances.remove({id:instance.id,revision:instance.revision}),/运行/)
  assert.equal(readFileSync(join(path,'auth.json'),'utf8'),'fixture-original-auth')
  await f.instances.stop(instance.id)
  const restored=new TomlDocument(readFileSync(join(path,'config.toml'),'utf8'))
  assert.equal(restored.scalar(['model']),'original');assert.equal(restored.scalar(['custom']),'untouched')
  f.instances.remove({id:instance.id,revision:instance.revision})
  assert.equal(statSync(path).ino,inode);assert.equal(readFileSync(join(path,'session.jsonl'),'utf8'),'original session')
  assert.equal(readFileSync(join(path,'auth.json'),'utf8'),'fixture-original-auth')
  assert.equal(configs.targets().find(value=>value.directory===path)?.id,target.id);assert.ok(configs.view(target.id).revisions.some(value=>value.id===backup))
  assert.equal(f.instances.views().length,0);assert.equal(readdirSync(join(f.store.directory,'instance-trash')).length,1)
})

test('existing-directory registration enforces purpose, confirmation, uniqueness, atomic vault commit and immutable directory identity',async t=>{
  const f=fixture(t),path=realpathSync(f.root)+'/existing';mkdirSync(path);writeFileSync(join(path,'config.toml'),'model="keep"\n')
  const details={name:'Existing',applicationId:f.app.id,accountId:f.account().id,model:'fixture-model',extraArgs:[]}
  const copying=f.instances.selectCopySource(path)
  await assert.rejects(f.instances.attachExisting({ticket:copying.ticket,sourceClosed:true,details}),/过期/)
  const selected=f.instances.selectCopySource(path,'attach')
  await assert.rejects(f.instances.attachExisting({ticket:selected.ticket,sourceClosed:false,details}))
  assert.throws(()=>f.instances.startExternalCopy({ticket:selected.ticket,sourceClosed:true,details}),/过期/)
  const configs=new ClientConfigs(f.store),target=configs.register(path),transaction=f.store.transaction.bind(f.store)
  f.store.transaction=()=>{throw new Error('fixture vault unavailable')}
  await assert.rejects(f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details}),/vault unavailable/)
  assert.equal(f.instances.views().length,0);assert.equal(f.store.read().configTargets?.[0].id,target.id)
  assert.equal(existsSync(join(f.store.directory,'instances',target.id)),false);assert.equal(readFileSync(join(path,'config.toml'),'utf8'),'model="keep"\n')
  f.store.transaction=transaction
  await f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details});const instance=f.instances.views()[0]
  await assert.rejects(f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details}),/过期/)
  const duplicate=f.instances.selectCopySource(path,'attach')
  await assert.rejects(f.instances.attachExisting({ticket:duplicate.ticket,sourceClosed:true,details:{...details,name:'Duplicate'}}),/已被实例使用/)
  const launched=f.instances.preview({id:instance.id,revision:0})
  renameSync(path,path+'-original');mkdirSync(path);writeFileSync(join(path,'config.toml'),'replacement="untouched"\n')
  assert.throws(()=>f.instances.start(launched.ticket),/替换/)
  assert.throws(()=>configs.register(path),/替换/)
  assert.throws(()=>configs.view(instance.id),/替换/)
  f.instances.remove({id:instance.id,revision:0})
  assert.equal(readFileSync(join(path,'config.toml'),'utf8'),'replacement="untouched"\n');assert.equal(readFileSync(join(path+'-original','config.toml'),'utf8'),'model="keep"\n')
})

test('existing-directory tickets cannot commit after expiry, competing registration or manager shutdown',async t=>{
  const f=fixture(t),path=realpathSync(f.root)+'/ticket-existing';mkdirSync(path)
  const details={name:'Ticket existing',applicationId:f.app.id,accountId:f.account().id,model:'fixture-model',extraArgs:[]}
  let selected=f.instances.selectCopySource(path,'attach')
  const expired=f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details});f.advance()
  await assert.rejects(expired,/过期/);assert.equal(f.instances.views().length,0)
  selected=f.instances.selectCopySource(path,'attach')
  const cancelled=f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details})
  await f.instances.closeAll();await assert.rejects(cancelled,/abort/i)
  assert.equal(f.instances.views().length,0);assert.deepEqual(readdirSync(path),[])
  selected=f.instances.selectCopySource(path,'attach')
  const results=await Promise.allSettled([f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details}),f.instances.attachExisting({ticket:selected.ticket,sourceClosed:true,details})])
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1)
  assert.equal(results.filter(value=>value.status==='rejected').length,1)
  assert.equal(f.instances.views().length,1);assert.deepEqual(readdirSync(path),[])
})

test('attaching and later launching an existing directory reject live external daemons without changing its config',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
  const f=fixture(t),path=realpathSync(mkdtempSync('/tmp/cml-existing-'))
  t.after(()=>rmSync(path,{recursive:true,force:true}));mkdirSync(join(path,'app-server-control'));const original='model="original"\n';writeFileSync(join(path,'config.toml'),original)
  const socketPath=join(path,'app-server-control','app-server-control.sock'),server=createSocketServer(socket=>socket.end())
  t.after(()=>server.close())
  const listen=()=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)})
  await listen()
  const account=f.account(),details={name:'Existing daemon',applicationId:f.app.id,accountId:account.id,model:'fixture-model',extraArgs:[]},selection=f.instances.selectCopySource(path,'attach')
  await assert.rejects(f.instances.attachExisting({ticket:selection.ticket,sourceClosed:true,details}),/后台进程仍在运行/)
  assert.equal(f.instances.views().length,0);assert.equal(readFileSync(join(path,'config.toml'),'utf8'),original)
  await new Promise<void>(resolve=>server.close(()=>resolve()))
  await f.instances.attachExisting({ticket:selection.ticket,sourceClosed:true,details});const instance=f.instances.views()[0]
  const preview=f.instances.preview({id:instance.id,revision:0})
  f.setPrepare(async()=>{await listen();return account})
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.match(f.instances.views()[0].error!,/后台进程仍在运行/);assert.equal(f.runtime.plans.length,0)
  assert.equal(readFileSync(join(path,'config.toml'),'utf8'),original);assert.equal(server.listening,true)
  await f.instances.stop(instance.id)
})

test('supplier context overrides reach local instance config and clearing them restores the existing client defaults',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Context supplier'),instance=f.add(account.id)
  const file=join(instance.directory,'config.toml'),original='# preserve hand configuration\nmodel="before"\nmodel_context_window=80000\nmodel_auto_compact_token_limit=70000\n[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(file,original)
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{models:['fixture-model','other-model','fallback-model'],modelContextWindows:{'fixture-model':128000,'other-model':256000}}})
  let preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,128000);assert.equal(preview.effectiveAutoCompactTokenLimit,115200);assert.equal(preview.contextWindowSource,'provider')
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  let doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_context_window']),null);assert.equal(doc.scalar(['model_auto_compact_token_limit']),null)
  const projected=JSON.parse(readFileSync(doc.scalar(['model_catalog_json']) as string,'utf8')).models as Record<string,unknown>[]
  assert.equal(projected.find(model=>model.slug==='fixture-model')?.context_window,128000)
  assert.equal(projected.find(model=>model.slug==='fixture-model')?.auto_compact_token_limit,115200)
  assert.equal(projected.find(model=>model.slug==='other-model')?.context_window,256000)
  assert.equal(projected.find(model=>model.slug==='other-model')?.auto_compact_token_limit,230400)
  assert.equal(projected.find(model=>model.slug==='fallback-model')?.context_window,80000)
  assert.equal(projected.find(model=>model.slug==='fallback-model')?.auto_compact_token_limit,70000)
  await f.instances.stop(instance.id);assert.equal(readFileSync(file,'utf8'),original)
  const current=f.store.read().providers![0]
  mutateProvider(f.store,{action:'update',id:current.id,revision:current.revision,changes:{},clearModelContextWindows:true})
  preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,80000);assert.equal(preview.effectiveAutoCompactTokenLimit,70000);assert.equal(preview.contextWindowSource,'config')
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_context_window']),80000);assert.equal(doc.scalar(['model_auto_compact_token_limit']),70000)
  await f.instances.stop(instance.id);assert.equal(readFileSync(file,'utf8'),original)
})

test('local context restoration keeps a later user window and compact limit together',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Hand edit supplier'),instance=f.add(account.id),file=join(instance.directory,'config.toml')
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{modelContextWindows:{'fixture-model':128000}}})
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['model_context_window'],raw:'96000'},{path:['model_auto_compact_token_limit'],raw:'85000'}]))
  await f.instances.stop(instance.id)
  const doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_context_window']),96000);assert.equal(doc.scalar(['model_auto_compact_token_limit']),85000)
  assert.equal(doc.scalar(['model_providers','cml_instance','base_url']),null)
})

test('provider windows and external model directory contents invalidate startup and config tickets',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Stale context supplier'),instance=f.add(account.id)
  const defaults=new ClientConfigs(f.store)
  assert.equal(defaults.instanceModelContext(instance.id,'constructor').origin,'template')
  assert.equal(defaults.instanceModelContext(instance.id,'toString').window,272000)
  let preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,272000);assert.equal(preview.contextWindowSource,'template')
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{modelContextWindows:{'fixture-model':200000}}})
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  const configs=new ClientConfigs(f.store),project=configs.previewInstanceConnection(instance.id,configs.view(instance.id).revision,{port:12345,key:'fixture-local',model:'fixture-model'})
  let current=f.store.read().providers![0]
  mutateProvider(f.store,{action:'update',id:current.id,revision:current.revision,changes:{modelContextWindows:{'fixture-model':256000}}})
  assert.throws(()=>configs.apply(project.ticket),/上下文|已变化/)
  assert.equal(existsSync(join(instance.directory,'config.toml')),false)
  current=f.store.read().providers![0]
  mutateProvider(f.store,{action:'update',id:current.id,revision:current.revision,changes:{},clearModelContextWindows:true})
  const catalog=structuredClone(builtInCatalog),model=catalog.models[0]
  Object.assign(model,{slug:'fixture-model',context_window:333333,max_context_window:333333,auto_compact_token_limit:300000})
  writeFileSync(join(instance.directory,'models.json'),JSON.stringify(catalog))
  writeFileSync(join(instance.directory,'config.toml'),'model_catalog_json="models.json"\n')
  preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,333333);assert.equal(preview.effectiveAutoCompactTokenLimit,300000);assert.equal(preview.contextWindowSource,'catalog')
  const catalogProject=configs.previewInstanceConnection(instance.id,configs.view(instance.id).revision,{port:12345,key:'fixture-local',model:'fixture-model'})
  Object.assign(model,{context_window:400000,max_context_window:400000,auto_compact_token_limit:360000})
  writeFileSync(join(instance.directory,'models.json'),JSON.stringify(catalog))
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  assert.throws(()=>configs.apply(catalogProject.ticket),/上下文|模型目录/)
  assert.equal(readFileSync(join(instance.directory,'config.toml'),'utf8'),'model_catalog_json="models.json"\n')
  assert.equal(f.runtime.plans.length,0)
})

test('supplier catalog preserves actual model spelling and unknown model template defaults',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Case supplier')
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{models:['GPT-6-SOL','constructor','toString'],modelContextWindows:{'GPT-6-SOL':400000}}})
  f.instances.save({details:{name:'Case instance',applicationId:f.app.id,accountId:account.id,model:'GPT-6-SOL',defaultTier:'inherit',extraArgs:[]}})
  const instance=f.instances.views()[0],preview=f.instances.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.effectiveContextWindow,400000)
  f.instances.start(preview.ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  const doc=new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8'))
  const models=JSON.parse(readFileSync(doc.scalar(['model_catalog_json']) as string,'utf8')).models as Record<string,unknown>[]
  assert.equal(models.find(model=>model.slug==='GPT-6-SOL')?.context_window,400000)
  assert.equal(models.some(model=>model.slug==='gpt-6-sol'),false)
  const configs=new ClientConfigs(f.store)
  assert.equal(configs.instanceModelContext(instance.id,'constructor').window,272000)
  assert.equal(configs.instanceModelContext(instance.id,'toString').compact,244800)
  await f.instances.stop(instance.id)
})

test('changing the model catalog during a run keeps the new catalog without restoring its old global window',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Catalog edit supplier'),instance=f.add(account.id),file=join(instance.directory,'config.toml')
  writeFileSync(file,'model_context_window=80000\nmodel_auto_compact_token_limit=70000\n')
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{modelContextWindows:{'fixture-model':128000}}})
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  writeFileSync(join(instance.directory,'chosen-models.json'),JSON.stringify(builtInCatalog))
  writeFileSync(file,patchToml(readFileSync(file,'utf8'),[{path:['model_catalog_json'],raw:'"chosen-models.json"'}]))
  await f.instances.stop(instance.id)
  const doc=new TomlDocument(readFileSync(file,'utf8'))
  assert.equal(doc.scalar(['model_catalog_json']),'chosen-models.json')
  assert.equal(doc.scalar(['model_context_window']),null);assert.equal(doc.scalar(['model_auto_compact_token_limit']),null)
  assert.equal(doc.scalar(['model_providers','cml_instance','base_url']),null)
})

test('one supplier window does not expand a 500-model discovery list into duplicated model instructions',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Large supplier'),instance=f.add(account.id)
  const models=['fixture-model',...Array.from({length:499},(_,index)=>`large-model-${index}`)]
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{models,modelContextWindows:{'fixture-model':128000}}})
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket);await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status,'running',JSON.stringify(f.instances.views()))
  const doc=new TomlDocument(readFileSync(join(instance.directory,'config.toml'),'utf8'))
  const generated=JSON.parse(readFileSync(doc.scalar(['model_catalog_json']) as string,'utf8'))
  assert.equal(generated.models.length,builtInCatalog.models.length+1)
  assert.equal(generated.models.find((model:Record<string,unknown>)=>model.slug==='fixture-model').context_window,128000)
  assert.equal(generated.models.some((model:Record<string,unknown>)=>model.slug==='large-model-0'),false)
  assert.equal(new ClientConfigs(f.store).instanceModelContext(instance.id,'large-model-0').window,272000)
  await f.instances.stop(instance.id)
})

test('oversized projection needed to preserve an existing global window fails before writing config or model files',async t=>{
  const f=fixture(t),account=f.account(),provider=linkProvider(f,account,'Global large supplier'),instance=f.add(account.id),file=join(instance.directory,'config.toml')
  const original='model_context_window=80000\nmodel_auto_compact_token_limit=70000\n'
  writeFileSync(file,original)
  mutateProvider(f.store,{action:'update',id:provider.id,revision:provider.revision,changes:{models:['fixture-model',...Array.from({length:499},(_,index)=>`large-model-${index}`)],modelContextWindows:{'fixture-model':128000}}})
  assert.throws(()=>f.instances.preview({id:instance.id,revision:instance.revision}),/模型目录超过.*16 MiB/)
  assert.equal(readFileSync(file,'utf8'),original)
  assert.equal(existsSync(join(f.store.directory,'model-catalogs',instance.id)),false)
  assert.equal(existsSync(join(f.store.directory,'config-backups',instance.id)),false)
  assert.equal(f.runtime.plans.length,0);assert.equal(f.instances.views()[0].status,'stopped')
})
