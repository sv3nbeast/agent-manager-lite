import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountCompatibility, getAgentClient, implementedAgentClients, resolveAgentClientType } from '../src/shared/agentClients'
import { instanceInputSchema } from '../src/shared/instances'
import { createAPIAccount } from '../src/main/accounts'
import { Store } from '../src/main/store'
import { Instances } from '../src/main/instances'
import { NativeInstanceAccounts } from '../src/main/nativeInstanceAccounts'
import { TokenAuthority } from '../src/main/tokens'
import { codexInstanceAdapter } from '../src/main/codexInstanceAdapter'
import { MacDesktopRuntime, macLaunchArgs, type DesktopPlan, type DesktopProcess, type DesktopRuntime } from '../src/main/instanceRuntime'
import { MacCliRuntime, MacInstanceRuntime, cliLaunchScript } from '../src/main/cliInstanceRuntime'

const codec={encrypt:(value:string)=>Buffer.from(value),decrypt:(value:Buffer)=>value.toString()}

class FixtureRuntime implements DesktopRuntime {
  readonly children=new Map<string,DesktopProcess>()
  readonly plans:DesktopPlan[]=[]
  finds=0
  async find(plan:DesktopPlan){this.finds++;return this.children.get(plan.nonce)}
  async launch(plan:DesktopPlan,signal:AbortSignal){signal.throwIfAborted();this.plans.push(plan);const child={pid:43000+this.plans.length,started:'fixture'};this.children.set(plan.nonce,child);return child}
  async stop(plan:DesktopPlan){this.children.delete(plan.nonce)}
  async focus(){}
}

function fixture(t:{after(fn:()=>void|Promise<void>):void}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-agent-clients-'))),application=join(root,'Fixture.app')
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true})
  writeFileSync(join(application,'Contents','MacOS','Codex'),'fixture-not-executed',{mode:0o700})
  const store=new Store(join(root,'data'),codec),runtime=new FixtureRuntime()
  const account=createAPIAccount({name:'Shared supplier key',apiKey:'fixture-provider-key',baseUrl:'https://fixture.invalid/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'inherit'})
  store.transaction(state=>state.accounts.push(account))
  const tokens=new TokenAuthority(store,async()=>assert.fail('No OAuth refresh expected'))
  let preparations=0
  const create=(selectedStore=store)=>new Instances(selectedStore,()=>assert.fail('No local gateway in native fixture'),async id=>{preparations++;return selectedStore.read().accounts.find(item=>item.id===id)!},runtime,new NativeInstanceAccounts(selectedStore,tokens))
  const instances=create(),app=instances.registerApplication(application)
  const details={name:'Fixture',clientType:'codex',applicationId:app.id,accountId:account.id,model:'fixture-model',connectionMode:'native',defaultTier:'inherit',extraArgs:[]}
  const save=(name='Fixture')=>{instances.save({details:{...details,name}});return instances.views().at(-1)!}
  t.after(async()=>{await instances.closeAll().catch(()=>{});await tokens.stop();rmSync(root,{recursive:true,force:true})})
  const vault=()=>readFileSync(join(store.directory,'state.vault'))
  return {root,store,runtime,account,instances,app,details,save,create,vault,preparations:()=>preparations}
}

test('only an absent client field resolves as legacy Codex; capability declarations expose implemented modes',()=>{
  assert.equal(resolveAgentClientType(undefined),'codex')
  assert.equal(resolveAgentClientType('codex'),'codex')
  for(const unknown of [null,'','claude','claude-desktop','unknown',false,0,{}])assert.throws(()=>resolveAgentClientType(unknown),/尚未接入/)
  assert.deepEqual(implementedAgentClients.map(client=>client.id),['codex'])
  assert.deepEqual(getAgentClient('codex').capabilities.projectDirectoryModes,['cli'])
  assert.deepEqual(getAgentClient('codex').capabilities.launchModes,['desktop','cli'])
})

test('legacy vault views and launch previews project Codex without rewriting persisted records',async t=>{
  const f=fixture(t),instance=f.save()
  f.store.transaction(state=>{delete state.instances![0].clientType;delete state.instanceApplications![0].clientType})
  const before=f.vault(),reopenedStore=new Store(f.store.directory,codec),reopened=f.create(reopenedStore)
  assert.equal(reopened.views()[0].clientType,'codex')
  assert.equal(reopened.applications().find(app=>app.id===f.app.id)?.clientType,'codex')
  const preview=reopened.preview({id:instance.id,revision:instance.revision})
  assert.equal(preview.clientType,'codex')
  assert.equal(reopenedStore.read().instances![0].clientType,undefined)
  assert.equal(reopenedStore.read().instanceApplications![0].clientType,undefined)
  assert.deepEqual(f.vault(),before)
  await reopened.recover();assert.deepEqual(f.vault(),before)
  reopened.start(preview.ticket);await reopened.settled(instance.id)
  assert.equal(reopened.views()[0].status,'running',reopened.views()[0].error)
  assert.equal(f.runtime.plans[0].clientType,'codex')
  const marker=join(f.store.directory,'instances',instance.id,'launch.json'),saved=JSON.parse(readFileSync(marker,'utf8'))
  assert.equal(saved.clientType,'codex')
  // A checkpoint written by the previous release is still recoverable.
  delete saved.clientType;writeFileSync(marker,JSON.stringify(saved))
  const recovery=f.create(reopenedStore);await recovery.recover()
  assert.equal(recovery.views()[0].pid,f.runtime.children.get(f.runtime.plans[0].nonce)!.pid)
  await recovery.stop(instance.id)
  assert.equal(existsSync(marker),false)
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  assert.equal(reopenedStore.read().instances![0].clientType,undefined)
})

test('new instances persist their client and reuse one supplier credential without cloning accounts',t=>{
  const f=fixture(t);f.save('First');f.save('Second')
  const state=f.store.read()
  assert.equal(state.version,1);assert.equal(state.accounts.length,1)
  assert.deepEqual(state.instances!.map(item=>item.clientType),['codex','codex'])
  assert.deepEqual(state.instances!.map(item=>item.accountId),[f.account.id,f.account.id])
  assert.equal(state.instanceApplications![0].clientType,'codex')
  const {clientType:_clientType,...legacyDetails}=f.details
  assert.equal(instanceInputSchema.parse(legacyDetails).clientType,'codex')
})

test('unsupported input clients reject save, copy and attach before vault, directories or process work',async t=>{
  const f=fixture(t),instance=f.save(),before=f.vault(),folders=readdirSync(join(f.store.directory,'instances'))
  for(const clientType of [null,'','claude','unknown',false,{}]){
    const details={...f.details,name:'Unsupported',clientType}
    assert.throws(()=>f.instances.save({details}))
    assert.throws(()=>f.instances.startCopy({id:instance.id,revision:instance.revision,details}))
    assert.throws(()=>f.instances.startExternalCopy({ticket:randomUUID(),sourceClosed:true,details}))
    await assert.rejects(f.instances.attachExisting({ticket:randomUUID(),sourceClosed:true,details}))
    assert.deepEqual(f.vault(),before)
    assert.deepEqual(readdirSync(join(f.store.directory,'instances')),folders)
  }
  assert.equal(f.instances.copyView(),undefined);assert.equal(f.runtime.finds,0);assert.equal(f.preparations(),0)
})

test('unsupported persisted clients remain visible and cannot preview, launch, copy, recover or be normalized by edit',async t=>{
  const f=fixture(t),instance=f.save(),pending=f.instances.preview({id:instance.id,revision:instance.revision})
  const marker=join(f.store.directory,'instances',instance.id,'launch.json'),content=JSON.stringify({nonce:randomUUID(),clientType:'claude'})
  writeFileSync(marker,content)
  f.store.transaction(state=>{(state.instances![0] as unknown as {clientType:unknown}).clientType='claude'})
  const before=f.vault()
  const view=f.instances.views()[0];assert.equal(view.clientType,'claude');assert.equal(view.status,'error');assert.match(view.error!,/尚未接入/)
  assert.throws(()=>f.instances.preview({id:instance.id,revision:instance.revision}),/尚未接入/)
  assert.throws(()=>f.instances.start(pending.ticket),/尚未接入/)
  assert.throws(()=>f.instances.startCopy({id:instance.id,revision:instance.revision,details:{...f.details,name:'Copy'}}),/尚未接入/)
  assert.throws(()=>f.instances.save({id:instance.id,revision:instance.revision,details:f.details}),/尚未接入/)
  await f.create().recover()
  assert.deepEqual(f.vault(),before);assert.equal(readFileSync(marker,'utf8'),content)
  assert.equal(f.runtime.finds,0);assert.equal(f.preparations(),0);assert.equal(f.runtime.plans.length,0)
})

test('unsupported registered applications reject save without changing the vault or filesystem',t=>{
  const f=fixture(t)
  f.store.transaction(state=>{(state.instanceApplications![0] as unknown as {clientType:unknown}).clientType=null})
  const before=f.vault(),files=readdirSync(f.store.directory)
  assert.doesNotThrow(()=>f.instances.applications())
  assert.equal(f.instances.applications().find(app=>app.id===f.app.id)?.clientType,null)
  assert.throws(()=>f.instances.save({details:f.details}),/尚未接入/)
  assert.deepEqual(f.vault(),before);assert.deepEqual(readdirSync(f.store.directory),files)
})

test('native account compatibility rejects Agent Identity, Chat Completions and unsupported models at save and rechecks changed accounts',t=>{
  const f=fixture(t),before=f.vault()
  assert.equal(accountCompatibility('codex',{...f.account,kind:'agent_identity'},{connectionMode:'native'}).compatible,false)
  assert.equal(accountCompatibility('codex',{...f.account,kind:'agent_identity'},{connectionMode:'local_api'}).compatible,true)
  assert.throws(()=>f.instances.save({details:{...f.details,model:'missing-model'}}),/Responses/)
  assert.deepEqual(f.vault(),before)
  const instance=f.save()
  f.store.transaction(state=>{state.accounts[0].wireApi='chat_completions'})
  assert.throws(()=>f.instances.preview({id:instance.id,revision:instance.revision}),/Responses/)
  assert.throws(()=>f.instances.save({details:{...f.details,name:'Chat native'}}),/Responses/)
  // Existing local protocol conversion and explicit custom-model input survive.
  f.instances.save({details:{...f.details,name:'Chat local',connectionMode:'local_api',model:'custom-model'}})
  assert.equal(f.store.read().instances!.at(-1)!.model,'custom-model')
  f.store.transaction(state=>{state.accounts[0].kind='agent_identity'})
  assert.throws(()=>f.instances.save({details:{...f.details,name:'Identity native'}}),/Agent Identity/)
  assert.equal(f.runtime.plans.length,0);assert.equal(f.preparations(),0)
})

test('runtime entry points reject unsupported clients before process discovery or launch files',async t=>{
  const f=fixture(t),instance=f.save()
  const plan={clientType:'claude',application:f.app.path,executable:join(f.app.path,'Contents','MacOS','Codex'),directory:instance.directory,
    desktopDirectory:instance.desktopDirectory,workingDirectory:join(f.store.directory,'instances',instance.id,'workspace'),args:[],nonce:randomUUID()} as unknown as DesktopPlan
  const before=readdirSync(instance.desktopDirectory)
  assert.throws(()=>macLaunchArgs(plan),/尚未接入/)
  assert.throws(()=>cliLaunchScript({...plan,mode:'cli'}),/尚未接入/)
  await assert.rejects(new MacDesktopRuntime().find(plan),/尚未接入/)
  await assert.rejects(new MacDesktopRuntime().launch(plan,new AbortController().signal),/尚未接入/)
  const cli=new MacCliRuntime(async()=>assert.fail('No terminal launch'))
  await assert.rejects(cli.find({...plan,mode:'cli'}),/尚未接入/)
  await assert.rejects(cli.launch({...plan,mode:'cli'},new AbortController().signal),/尚未接入/)
  assert.throws(()=>new MacInstanceRuntime(f.runtime,f.runtime).launch({...plan,mode:'cli'},new AbortController().signal),/尚未接入/)
  assert.deepEqual(readdirSync(instance.desktopDirectory),before)
})

test('Codex adapter preserves isolation parameters and rejects protected CLI configuration overrides',()=>{
  for(const args of [['--profile','other'],['-C/tmp'],['--config','model_provider="other"'],['-c','model_providers.other.base_url="https://invalid"']])
    assert.throws(()=>codexInstanceAdapter.validateCliArgs(args),/覆盖|Profile/)
  assert.doesNotThrow(()=>codexInstanceAdapter.validateCliArgs(['-c','service_tier="fast"']))
  const plan:DesktopPlan={application:'/fixture/Codex.app',executable:'/fixture/Codex',directory:'/fixture/home',desktopDirectory:'/fixture/desktop',workingDirectory:'/fixture/workspace',args:[],nonce:'fixture-nonce'}
  assert.ok(macLaunchArgs(plan).includes('CODEX_HOME=/fixture/home'))
  assert.ok(macLaunchArgs(plan).includes('--user-data-dir=/fixture/desktop'))
  assert.ok(macLaunchArgs(plan).includes('--cml-instance=fixture-nonce'))
  assert.deepEqual(codexInstanceAdapter.desktopEnvironment({PATH:'/usr/bin',CODEX_HOME:'/default',OPENAI_API_KEY:'inherited',NODE_OPTIONS:'--require=other'}),{PATH:'/usr/bin'})
})
