import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync,type ChildProcess} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync,renameSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {Store} from '../src/main/store'
import {Instances} from '../src/main/instances'
import {Gateway} from '../src/main/gateway'
import {createAPIAccount,parseAccountImport,importParsedAccounts} from '../src/main/accounts'
import {TokenAuthority} from '../src/main/tokens'
import {ClientAuthority} from '../src/main/clientAuthority'
import {ClientConfigs} from '../src/main/clientConfig'
import {ClientIdentities} from '../src/main/clientIdentity'
import {NativeInstanceAccounts} from '../src/main/nativeInstanceAccounts'
import {MacCliRuntime,MacInstanceRuntime,cliLaunchFiles,validateCliArgs} from '../src/main/cliInstanceRuntime'
import {TomlDocument} from '../src/main/tomlPatch'
import {resolveCliRuntime} from '../src/main/cliResolver'
const {npmCliPackage}=createRequire(import.meta.url)('./fixtures/npm-cli-package.cjs') as {npmCliPackage:(root:string,binary:string,layout?:string)=>{root:string;entry:string;executable:string;platformRoot:string}}

const supported=process.platform==='darwin'
const build=realpathSync(mkdtempSync(join(tmpdir(),'cml-cli-build-'))),binary=join(build,'codex fixture')
if(supported)execFileSync('go',['build','-o',binary,'tests/fixtures/desktop-client.go'],{cwd:resolve('.'),timeout:30000,stdio:'pipe'})
after(()=>rmSync(build,{recursive:true,force:true}))
async function waitFor<T>(read:()=>T|undefined):Promise<T>{const end=Date.now()+5000;for(;;){const result=read();if(result!==undefined)return result;if(Date.now()>end)throw new Error('Fixture evidence timeout');await new Promise(resolve=>setTimeout(resolve,30))}}
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-cli-instance-'))),store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()})
  const children:ChildProcess[]=[],gateways:Gateway[]=[]
  const cli=new MacCliRuntime(async script=>{const child=spawn('/bin/bash',[script],{env:{...process.env,OPENAI_API_KEY:'fixture-inherited',CODEX_MANAGED_BY_BUN:'1',LC_ALL:'fr_FR.UTF-8'},stdio:'ignore'});children.push(child)})
  const runtime=new MacInstanceRuntime(undefined,cli),tokens=new TokenAuthority(store,async()=>assert.fail('No real OAuth'))
  const configs=new ClientConfigs(store),identity=new ClientIdentities(store,configs,async()=>assert.fail('No OS keychain'))
  const authority=new ClientAuthority(store,configs,identity,tokens)
  const create=()=>new Instances(store,()=>{const gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(root,'runtime'));gateways.push(gateway);return gateway},id=>tokens.ensure(id),runtime,new NativeInstanceAccounts(store,tokens))
  const instances=create(),app=instances.registerApplication(binary,'cli')
  const account=createAPIAccount({name:'Fixture API',apiKey:'fixture-cli-api',baseUrl:'http://127.0.0.1:9/v1',models:['fixture-model'],wireApi:'responses',defaultTier:'fast'})
  importParsedAccounts(store,[account])
  const add=(name='CLI',connectionMode='native',workingDirectoryId?:string,accountId=account.id)=>{instances.save({details:{name,applicationId:app.id,accountId,model:'fixture-model',connectionMode,workingDirectoryId,defaultTier:'fast',extraArgs:['literal $(no-execution);\'汉字']}});return instances.views().at(-1)!}
  const start=async(id:string)=>{const view=instances.views().find(item=>item.id===id)!;instances.start(instances.preview({id,revision:view.revision}).ticket);await instances.settled(id);assert.equal(instances.views().find(item=>item.id===id)?.status,'running',JSON.stringify(instances.views()))}
  const evidence=(home:string)=>waitFor(()=>{try{return JSON.parse(readFileSync(join(home,'fixture-desktop.json'),'utf8'))}catch{return undefined}})
  t.after(async()=>{await instances.closeAll().catch(()=>{});for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.all(gateways.map(gateway=>gateway.stop()));await tokens.stop();await authority.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,instances,create,app,account,add,start,evidence,cli,children,tokens}
}

test('CLI native and local API instances launch real isolated native processes, preserve literal args and stop only their owner',{skip:!supported},async t=>{
  const f=fixture(t),workspace=join(f.root,"项目 ' $(literal)" );mkdirSync(workspace)
  const target=f.instances.registerWorkingDirectory(workspace),first=f.add('Native CLI','native',target.id),second=f.add('API CLI','local_api')
  const preview=f.instances.preview({id:first.id,revision:0});assert.equal(preview.launchMode,'cli');assert.equal(preview.workingDirectory,workspace);assert.equal(JSON.stringify(preview).includes('fixture-cli-api'),false)
  await f.start(first.id);await f.start(second.id)
  const a=await f.evidence(first.directory),b=await f.evidence(second.directory)
  assert.equal(a.cwd,workspace);assert.equal(a.home,first.directory);assert.equal(a.desktop,'');assert.equal(a.inheritedKey,'');assert.deepEqual(a.args,["literal $(no-execution);'汉字"])
  assert.match(a.argv0,/^--cml-instance=/);assert.notEqual(a.pid,b.pid);assert.equal(a.pid,f.instances.views()[0].pid)
  assert.equal(JSON.parse(readFileSync(join(first.directory,'auth.json'),'utf8')).OPENAI_API_KEY,'fixture-cli-api')
  const local=new TomlDocument(readFileSync(join(second.directory,'config.toml'),'utf8'));assert.equal(local.scalar(['model_provider']),'cml_instance');assert.ok(f.instances.views()[1].port)
  await f.instances.stop(first.id);assert.throws(()=>process.kill(a.pid,0));assert.doesNotThrow(()=>process.kill(b.pid,0));assert.equal(existsSync(join(first.directory,'auth.json')),false)
  await f.instances.stop(second.id);assert.throws(()=>process.kill(b.pid,0))
})

test('CLI stop saves the final OAuth rotation and manager restart finds the recorded live native PID',{skip:!supported},async t=>{
  const f=fixture(t),auth=(generation:string)=>{const jwt='fixture.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200,generation,'https://api.openai.com/auth':{chatgpt_account_id:'cli-workspace',chatgpt_user_id:'cli-user'}})).toString('base64url')+'.sig';return JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:jwt,id_token:jwt,refresh_token:'fixture-cli-rt-'+generation,account_id:'cli-workspace'}})}
  importParsedAccounts(f.store,parseAccountImport(auth('before')).accounts)
  const account=f.store.read().accounts.find(item=>item.kind==='oauth')!,instance=f.add('OAuth CLI','native',undefined,account.id)
  await f.start(instance.id);const evidence=await f.evidence(instance.directory)
  writeFileSync(join(instance.directory,'fixture-rotate-auth.json'),auth('at-exit'))
  const reopened=f.create();await reopened.recover();assert.equal(reopened.views()[0].status,'error');assert.equal(reopened.views()[0].pid,evidence.pid)
  await reopened.stop(instance.id)
  assert.equal(f.store.read().accounts.find(item=>item.id===account.id)?.credentials.refreshToken,'fixture-cli-rt-at-exit')
  assert.equal(existsSync(join(instance.directory,'auth.json')),false);assert.equal(f.store.read().clientSwitches?.length,0)
})

test('CLI startup cancellation revokes a deferred terminal launch before it can access the profile',{skip:!supported},async t=>{
  const f=fixture(t),instance=f.add();let pendingScript='',scriptText='',release!:()=>void
  const cli=new MacCliRuntime(async script=>{pendingScript=script;scriptText=readFileSync(script,'utf8');await new Promise<void>(resolve=>{release=resolve})})
  const runtime=new MacInstanceRuntime(undefined,cli)
  const instances=new Instances(f.store,()=>assert.fail('No local gateway'),id=>f.tokens.ensure(id),runtime,new NativeInstanceAccounts(f.store,f.tokens))
  instances.start(instances.preview({id:instance.id,revision:0}).ticket)
  await waitFor(()=>pendingScript||undefined)
  const stopped=instances.stop(instance.id);release();await stopped
  assert.equal(instances.views()[0].status,'stopped');assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  const result=spawn('/bin/bash',['-c',scriptText],{stdio:'ignore'})
  const code=await new Promise(resolve=>result.once('close',resolve));assert.notEqual(code,0)
  assert.equal(existsSync(join(instance.directory,'fixture-desktop.json')),false)
})

test('CLI ownership rejects a different binary and malformed records; natural exit restores config',{skip:!supported},async t=>{
  const f=fixture(t),instance=f.add();await f.start(instance.id);const evidence=await f.evidence(instance.directory)
  const launch=JSON.parse(readFileSync(join(f.store.directory,'instances',instance.id,'launch.json'),'utf8'))
  const plan={application:binary,executable:binary,directory:instance.directory,desktopDirectory:instance.desktopDirectory,workingDirectory:join(f.store.directory,'instances',instance.id,'workspace'),args:[],nonce:launch.nonce,mode:'cli' as const}
  await assert.rejects(f.cli.stop({...plan,executable:'/bin/sleep'}),/不一致/);assert.doesNotThrow(()=>process.kill(evidence.pid,0))
  const files=cliLaunchFiles(plan),original=readFileSync(files.record,'utf8');writeFileSync(files.record,'not a process record')
  await assert.rejects(f.cli.find(plan),/记录损坏/);writeFileSync(files.record,original)
  process.kill(evidence.pid,'SIGTERM');await waitFor(()=>{try{process.kill(evidence.pid,0);return undefined}catch{return true}})
  await f.instances.refresh();assert.equal(f.instances.views()[0].status,'stopped');assert.equal(existsSync(join(instance.directory,'auth.json')),false)
})

test('CLI registration and launch protect directory identity and account configuration overrides',{skip:!supported},async t=>{
  const f=fixture(t),workspace=join(f.root,'workspace');mkdirSync(workspace)
  const selected=f.instances.registerWorkingDirectory(workspace),instance=f.add('Workdir CLI','native',selected.id)
  renameSync(workspace,workspace+'-old');mkdirSync(workspace)
  assert.throws(()=>f.instances.preview({id:instance.id,revision:0}),/被替换/)
  const shell=join(f.root,'codex.js');writeFileSync(shell,'#!/usr/bin/env node\n',{mode:0o700});assert.throws(()=>f.instances.registerApplication(shell,'cli'),/原生 CLI/)
  for(const args of [['-c','model_provider="other"'],['--config="cli_auth_credentials_store"="keyring"'],['-cmodel_providers.evil.base_url="https://invalid"'],['--profile','other'],['-C/tmp']])assert.throws(()=>validateCliArgs(args),/覆盖|Profile/)
  assert.doesNotThrow(()=>validateCliArgs(['-c','service_tier="fast"','--config=model_reasoning_effort="high"']))
  assert.equal(f.instances.registerWorkingDirectory(workspace).id===selected.id,false)
})

test('npm entry launches the resolved native process with package ownership, then recovers and restores its profile',{skip:!supported},async t=>{
  // A clean macOS runner can inherit C; its lsof output must still identify
  // the actual binary under this non-ASCII package directory.
  const previousLocale=process.env.LC_ALL
  process.env.LC_ALL='C'
  t.after(()=>{if(previousLocale===undefined)delete process.env.LC_ALL;else process.env.LC_ALL=previousLocale})
  const f=fixture(t),npm=npmCliPackage(join(f.root,"npm 项目 ' $(literal)"),binary),app=f.instances.registerApplication(npm.entry,'cli')
  f.instances.save({details:{name:'npm CLI',applicationId:app.id,accountId:f.account.id,connectionMode:'native',defaultTier:'fast',model:'fixture-model',extraArgs:[]}})
  const instance=f.instances.views()[0],preview=f.instances.preview({id:instance.id,revision:0})
  assert.equal(preview.application,npm.entry);assert.equal(preview.executable,npm.executable)
  await f.start(instance.id)
  const evidence=await f.evidence(instance.directory)
  assert.equal(evidence.pid,f.instances.views()[0].pid);assert.equal(evidence.packageRoot,npm.root);assert.equal(evidence.managedByNpm,'1');assert.equal(evidence.managedByBun,'')
  assert.equal(evidence.locale,'fr_FR.UTF-8');assert.equal(evidence.home,instance.directory);assert.equal(evidence.inheritedKey,'')
  const recovered=f.create();await recovered.recover();assert.equal(recovered.views()[0].pid,evidence.pid)
  await recovered.stop(instance.id);assert.throws(()=>process.kill(evidence.pid,0));assert.equal(existsSync(join(instance.directory,'auth.json')),false)
})

test('npm runtime resolves bundled vendor and rejects modified launchers, incomplete installs and script payloads',{skip:!supported},t=>{
  const f=fixture(t),npm=npmCliPackage(join(f.root,'legacy'),binary,'bundled')
  assert.equal(resolveCliRuntime(npm.entry).executable,npm.executable)
  const source=readFileSync(npm.entry)
  writeFileSync(npm.entry,Buffer.concat([source,Buffer.from('\nconsole.log("modified");')]))
  assert.throws(()=>resolveCliRuntime(npm.entry),/尚未适配/);writeFileSync(npm.entry,source)
  rmSync(npm.executable);assert.throws(()=>resolveCliRuntime(npm.entry),/安装不完整/)
  writeFileSync(npm.executable,'#!/bin/bash\nexit 0\n',{mode:0o700});assert.throws(()=>resolveCliRuntime(npm.entry),/不是原生/)
  writeFileSync(join(npm.root,'package.json'),JSON.stringify({name:'different',bin:{codex:'bin/codex.js'}}));assert.throws(()=>resolveCliRuntime(npm.entry),/不是标准/)
})

test('npm preview detects dependency replacement and registered path redirection before injecting credentials',{skip:!supported},t=>{
  const f=fixture(t),npm=npmCliPackage(join(f.root,'npm'),binary),app=f.instances.registerApplication(npm.entry,'cli')
  f.instances.save({details:{name:'npm',applicationId:app.id,accountId:f.account.id,connectionMode:'native',defaultTier:'fast',model:'fixture-model',extraArgs:[]}})
  const instance=f.instances.views()[0],preview=f.instances.preview({id:instance.id,revision:0})
  renameSync(npm.executable,npm.executable+'-old');symlinkSync(binary,npm.executable)
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  assert.equal(existsSync(join(instance.directory,'auth.json')),false)
  renameSync(npm.entry,npm.entry+'-old');symlinkSync(npm.entry+'-old',npm.entry)
  assert.throws(()=>f.instances.preview({id:instance.id,revision:0}),/被替换/)
})

test('CLI mapping probe failure preserves a live owner but accepts a verified concurrent process exit',{skip:!supported},async t=>{
  const f=fixture(t),instance=f.add();await f.start(instance.id);const evidence=await f.evidence(instance.directory)
  const launch=JSON.parse(readFileSync(join(f.store.directory,'instances',instance.id,'launch.json'),'utf8'))
  const plan={application:binary,executable:binary,directory:instance.directory,desktopDirectory:instance.desktopDirectory,workingDirectory:join(f.store.directory,'instances',instance.id,'workspace'),args:[],nonce:launch.nonce,mode:'cli' as const}
  const failed=new MacCliRuntime(undefined,async()=>{throw new Error('simulated lsof permission failure')})
  await assert.rejects(failed.find(plan),/无法核对/)
  assert.doesNotThrow(()=>process.kill(evidence.pid,0));assert.equal(existsSync(join(instance.directory,'auth.json')),true)
  const exited=new MacCliRuntime(undefined,async pid=>{
    assert.equal(pid,evidence.pid);process.kill(pid,'SIGTERM')
    await waitFor(()=>{try{process.kill(pid,0);return undefined}catch{return true}})
    throw new Error('simulated lsof racing with exit')
  })
  assert.equal(await exited.find(plan),undefined)
  await f.instances.refresh();assert.equal(f.instances.views()[0].status,'stopped');assert.equal(existsSync(join(instance.directory,'auth.json')),false)
})

test('npm package-manager ownership follows installation metadata without inheriting unrelated shell flags',{skip:!supported},t=>{
  const f=fixture(t),pnpm=npmCliPackage(join(f.root,'pnpm'),binary)
  writeFileSync(join(f.root,'pnpm','node_modules','.modules.yaml'),'fixture')
  assert.equal(resolveCliRuntime(pnpm.entry).cliPackage?.manager,'pnpm')
  const bun=npmCliPackage(join(f.root,'.bun','install','global'),binary)
  assert.equal(resolveCliRuntime(bun.entry).cliPackage?.manager,'bun')
  const viteRoot=join(f.root,'packages'),vite=npmCliPackage(join(viteRoot,'@openai','codex','fixture','lib'),binary)
  writeFileSync(join(viteRoot,'@openai','codex.json'),JSON.stringify({name:'@openai/codex',installId:'fixture'}))
  assert.equal(resolveCliRuntime(vite.entry).cliPackage?.manager,'vite-plus')
})
