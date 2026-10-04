import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,realpathSync,statSync,symlinkSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {execFileSync,spawn} from 'node:child_process'
import {runInNewContext} from 'node:vm'
import {Store} from '../src/main/store'
import {OfficialTempLogin} from '../src/main/tempLogin'
import {TEMP_LOGIN_HOOK,isOfficialLoginURL} from '../src/main/tempLoginHook'
import {MacDesktopRuntime,macLaunchArgs,desktopEnvironment,type DesktopRuntime,type DesktopPlan,type DesktopProcess} from '../src/main/instanceRuntime'
import {MacCodexKeyring,keychainAccount,type CodexKeyring} from '../src/main/codexKeyring'

class FixtureRuntime implements DesktopRuntime {
  plans:DesktopPlan[]=[];children=new Map<string,DesktopProcess>();blocked=false
  onLaunch:(plan:DesktopPlan)=>void|Promise<void>=()=>{}
  onClose:(plan:DesktopPlan)=>void=()=>{}
  async find(plan:DesktopPlan){return this.children.get(plan.nonce)}
  async launch(plan:DesktopPlan,signal:AbortSignal){signal.throwIfAborted();this.plans.push(structuredClone(plan));const child={pid:19000+this.plans.length,started:'fixture'};this.children.set(plan.nonce,child);await this.onLaunch(plan);return child}
  async stop(plan:DesktopPlan){if(this.blocked)throw new Error('fixture close blocked');if(this.children.delete(plan.nonce))this.onClose(plan)}
  async focus(){}
}
const auth=(workspace='workspace-fixture',generation='first')=>{
  const token='fixture.'+Buffer.from(JSON.stringify({email:'temp@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:workspace,chatgpt_user_id:'fixture-user',chatgpt_plan_type:'plus'}})).toString('base64url')+'.signature'
  return JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:token,access_token:token,refresh_token:'fixture-secret-'+generation,account_id:workspace}})
}
const wait=async(fn:()=>boolean)=>{const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw new Error('Fixture condition timeout');await delay(5)}}
function fixture(t:{after(fn:()=>void|Promise<void>):void},options:{timeoutMs?:number;armTimeoutMs?:number}={},keyring?:CodexKeyring){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-temp-login-'))),application=join(root,'Fixture.app'),key=randomBytes(32)
  mkdirSync(join(application,'Contents','MacOS'),{recursive:true});writeFileSync(join(application,'Contents','MacOS','Codex'),'not executed',{mode:0o700})
  let failed=false,busy=false,imports=0
  const codec={encrypt:(raw:string)=>{if(failed)throw new Error('fixture vault failed');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(raw),c.final(),c.getAuthTag()])},decrypt:(raw:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));c.setAuthTag(raw.subarray(-16));return Buffer.concat([c.update(raw.subarray(12,-16)),c.final()]).toString()}}
  const store=new Store(join(root,'data'),codec),runtime=new FixtureRuntime(),app={id:'fixture-application',name:'Fixture',path:application}
  const create=(r:DesktopRuntime=runtime)=>new OfficialTempLogin(store,()=>[app],r,()=>busy,()=>{imports++},{pollMs:5,...options},keyring)
  const service=create(),start=(interceptAuthUrl=true,credentialStore:'file'|'keyring'|'auto'='file')=>service.start({applicationId:app.id,interceptAuthUrl,credentialStore})
  t.after(async()=>{runtime.blocked=false;await service.stop();rmSync(root,{recursive:true,force:true})})
  return {root,application,app,store,runtime,service,create,start,codec,fail:(value:boolean)=>{failed=value},busy:(value:boolean)=>{busy=value},imports:()=>imports}
}

test('official temporary login owns a blank file profile, imports the final closing rotation and removes only its own files',async t=>{
  const f=fixture(t),outside=join(f.root,'existing-client');mkdirSync(outside);writeFileSync(join(outside,'auth.json'),'existing-user-data')
  f.runtime.onLaunch=plan=>{assert.match(readFileSync(join(plan.directory,'config.toml'),'utf8'),/cli_auth_credentials_store = "file"/);assert.equal(existsSync(join(plan.directory,'auth.json')),false);writeFileSync(join(plan.directory,'auth.json'),auth())}
  f.runtime.onClose=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('workspace-fixture','final'))
  const view=f.start();assert.ok(view.running);assert.throws(()=>f.start(),/进行/);await f.service.settled()
  assert.equal(f.service.current().phase,'completed');assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-secret-final');assert.equal(f.imports(),1)
  assert.equal(readFileSync(join(outside,'auth.json'),'utf8'),'existing-user-data');assert.equal(f.runtime.children.size,0)
  assert.deepEqual(readdirSync(join(f.store.directory,'temp-login','sessions')),[]);assert.deepEqual(readdirSync(join(f.store.directory,'temp-login','markers')),[])
  const disk=readFileSync(join(f.store.directory,'state.vault'));assert.equal(disk.includes('fixture-secret'),false)
  assert.equal(new Store(f.store.directory,f.codec).read().accounts.length,1);assert.equal(JSON.stringify(f.service.current()).includes('fixture-secret'),false)
  assert.throws(()=>f.service.authURL(view.id!),/不可用/)
})

test('system credential adapter addresses only the selected home, distinguishes metadata from a secret and sanitizes failures',async()=>{
  const calls:{args:string[];timeout:number;limit:number}[]=[],controller=new AbortController();let code:string|number=0,stdout='fixture-secret',reject=false
  const adapter=new MacCodexKeyring(async(args,signal,timeout,limit)=>{assert.equal(signal,controller.signal);calls.push({args,timeout,limit});if(reject)throw new Error('fixture-secret');return {code,stdout}})
  const home='/private/tmp/fixture home 中文'
  assert.equal(await adapter.exists(home,controller.signal),true);assert.deepEqual(calls[0].args,['find-generic-password','-s','Codex Auth','-a',keychainAccount(home)]);assert.equal(calls[0].timeout,5000)
  assert.equal(await adapter.read(home,controller.signal),'fixture-secret');assert.equal(calls[1].args.at(-1),'-w');assert.equal(calls[1].limit,2*1024*1024)
  await adapter.remove(home,controller.signal);assert.deepEqual(calls[2].args,['delete-generic-password','-s','Codex Auth','-a',keychainAccount(home)])
  code=44;assert.equal(await adapter.exists(home,controller.signal),false);assert.equal(await adapter.read(home,controller.signal),null);await adapter.remove(home,controller.signal)
  code=1;await assert.rejects(adapter.read(home,controller.signal),error=>!String(error).includes('fixture-secret')&&/系统凭据/.test(String(error)))
  reject=true;await assert.rejects(adapter.remove(home,controller.signal),error=>!String(error).includes('fixture-secret'))
  reject=false;code=0;stdout='x'.repeat(2*1024*1024+1);await assert.rejects(adapter.read(home,controller.signal),/大小限制/)
  const count=calls.length;controller.abort();await assert.rejects(adapter.exists(home,controller.signal));assert.equal(calls.length,count)
})

test('keyring login polls metadata, reads once after closing, saves the final token and deletes only its temporary item',async t=>{
  const entries=new Map<string,string>(),reads:string[]=[],removed:string[]=[];let probes=0
  const keyring:CodexKeyring={exists:async directory=>{probes++;return entries.has(directory)},read:async directory=>{assert.equal(f.runtime.children.size,0);reads.push(directory);return entries.get(directory)??null},remove:async directory=>{removed.push(directory);entries.delete(directory)}}
  const f=fixture(t,{},keyring);entries.set('/unrelated/codex-home',auth('other'))
  f.runtime.onLaunch=plan=>{assert.match(readFileSync(join(plan.directory,'config.toml'),'utf8'),/"keyring"/);writeFileSync(join(plan.directory,'auth.json'),auth('stale-file'));entries.set(plan.directory,auth())}
  f.runtime.onClose=plan=>entries.set(plan.directory,auth('workspace-fixture','final-system'))
  f.start(false,'keyring');await f.service.settled();const directory=f.runtime.plans[0].directory
  assert.equal(f.service.current().phase,'completed');assert.equal(f.service.current().credentialSource,'keyring');assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-secret-final-system')
  assert.equal(probes,1);assert.deepEqual(reads,[directory]);assert.deepEqual(removed,[directory]);assert.equal(entries.has('/unrelated/codex-home'),true)
  assert.equal(JSON.stringify(f.service.current()).includes('fixture-secret'),false);assert.equal(existsSync(directory),false)
})

test('auto login selects system credentials over a stale file, falls back only on missing entries and never loops a refused read',async t=>{
  for(const mode of ['present','missing','denied','invalid'] as const){
    let reads=0,removes=0
    const f=fixture(t,{}, {exists:async()=>mode!=='missing',read:async()=>{reads++;if(mode==='denied')throw new Error('系统凭据未获授权');return mode==='missing'?null:mode==='invalid'?'invalid-fixture-json':auth('system-workspace')},remove:async()=>{removes++}})
    f.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('file-workspace'))
    f.start(false,'auto');await f.service.settled();assert.equal(reads,1);assert.equal(removes,1)
    if(mode==='present'||mode==='missing'){assert.equal(f.service.current().phase,'completed');assert.equal(f.store.read().accounts[0].credentials.accountId,mode==='present'?'system-workspace':'file-workspace')}
    else{assert.equal(f.service.current().phase,'failed');assert.equal(f.store.read().accounts.length,0)}
  }
  let reads=0;const strict=fixture(t,{timeoutMs:30},{exists:async()=>false,read:async()=>{reads++;return null},remove:async()=>{}})
  strict.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('stale-file'))
  strict.start(false,'keyring');await strict.service.settled();assert.equal(strict.service.current().phase,'failed');assert.equal(reads,0);assert.equal(strict.store.read().accounts.length,0)
})

test('cancelled or replaced profiles reject delayed system reads, without importing or touching another home',async t=>{
  let resolveRead!:(raw:string)=>void,removes=0
  const f=fixture(t,{}, {exists:async()=>true,read:async()=>new Promise(resolve=>{resolveRead=resolve}),remove:async()=>{removes++}})
  f.start(false,'keyring');await wait(()=>!!resolveRead);const cancelling=f.service.cancel(f.service.current().id!);resolveRead(auth());await cancelling
  assert.equal(f.service.current().phase,'cancelled');assert.equal(f.store.read().accounts.length,0);assert.equal(removes,1)
  let resolveProbe!:(value:boolean)=>void,reads=0,deleted=0
  const replaced=fixture(t,{}, {exists:async()=>new Promise(resolve=>{resolveProbe=resolve}),read:async()=>{reads++;return auth()},remove:async()=>{deleted++}})
  replaced.start(false,'keyring');await wait(()=>!!resolveProbe)
  const home=replaced.runtime.plans[0].directory;renameSync(home,home+'-original');symlinkSync(f.root,home,'dir');resolveProbe(true);await replaced.service.settled()
  assert.equal(replaced.service.current().phase,'failed');assert.equal(reads,0);assert.equal(deleted,0);assert.equal(existsSync(home+'-original'),true)
  rmSync(home);renameSync(home+'-original',home);await replaced.service.cleanup();assert.equal(deleted,1)
})

test('cleanup retries a failed temporary keyring removal after its home disappears and preserves legacy file markers',async t=>{
  const removed:string[]=[];let blocked=true
  const f=fixture(t,{}, {exists:async()=>false,read:async()=>null,remove:async directory=>{removed.push(directory);if(blocked)throw new Error('denied')}})
  f.start(false,'keyring');await wait(()=>f.service.current().phase==='waiting-login');const id=f.service.current().id!,home=f.runtime.plans[0].directory
  await f.service.cancel(id);assert.ok(f.service.current().notice);assert.equal(existsSync(home),true)
  const markerFile=join(f.store.directory,'temp-login','markers',id+'.json'),marker=JSON.parse(readFileSync(markerFile,'utf8'));assert.equal(marker.credentialStore,'keyring');assert.equal(JSON.stringify(marker).includes('fixture-secret'),false)
  rmSync(join(f.store.directory,'temp-login','sessions',id),{recursive:true});blocked=false
  const reopened=f.create();assert.equal((await reopened.cleanup()).removed.length,1);assert.deepEqual(removed,[home,home]);assert.equal(existsSync(markerFile),false);await reopened.stop()
  f.runtime.blocked=true;f.start(false);await wait(()=>f.runtime.plans.length===2);await f.service.cancel(f.service.current().id!)
  const oldFile=join(f.store.directory,'temp-login','markers',f.service.current().id!+'.json'),old=JSON.parse(readFileSync(oldFile,'utf8'));delete old.credentialStore;writeFileSync(oldFile,JSON.stringify(old))
  f.runtime.blocked=false;assert.equal((await f.service.cleanup()).removed.length,1);assert.equal(removed.length,2)
})

test('temporary login capture is scoped to the active session, handles split lines, preserves URLs and never accepts arbitrary browser targets',async t=>{
  const f=fixture(t);f.start();await wait(()=>f.service.current().phase==='waiting-login')
  const plan=f.runtime.plans[0],path=join(plan.directory,'auth-capture.jsonl'),url='https://chatgpt.com/codex/desktop-auth?authorize_url=https%3A%2F%2Fauth.openai.com%2Foauth%2Fauthorize%3Fstate%3Dfixture'
  writeFileSync(path,'{"kind":"armed"}\n{"kind":"url","url":');await wait(()=>f.service.current().authStatus==='armed')
  assert.throws(()=>f.service.authURL(f.service.current().id!),/不可用/)
  writeFileSync(path,'{"kind":"armed"}\n'+JSON.stringify({kind:'url',url})+'\n');await wait(()=>f.service.current().authStatus==='captured')
  assert.equal(f.service.authURL(f.service.current().id!),url);assert.throws(()=>f.service.authURL(randomUUID()),/不可用/)
  for(const value of ['file:///tmp/x','https://auth.openai.com.attacker.invalid/oauth/authorize','https://user@auth.openai.com/oauth/authorize','https://chatgpt.com:444/codex/desktop-auth','https://auth.openai.com/oauth/authorize-evil','https://chatgpt.com/other'])assert.equal(isOfficialLoginURL(value),false)
  await f.service.cancel(f.service.current().id!);assert.equal(f.service.current().phase,'cancelled');assert.equal(f.store.read().accounts.length,0)
})

test('capture hook intercepts only official authorization and preserves browser login when its private file is unavailable',t=>{
  const f=fixture(t),capture=join(f.root,'capture.jsonl');writeFileSync(capture,'',{mode:0o600})
  const opened:string[]=[],shell={openExternal:async(url:string)=>{opened.push(url)}}
  const module={_load:(name:string)=>name==='electron'?{shell}:undefined}
  const fakeRequire=(name:string)=>name==='module'?module:name==='node:fs'?requireFS():name==='electron'?{shell}:undefined
  function requireFS(){return {openSync:requireNodeFS.openSync,constants:requireNodeFS.constants,fstatSync:requireNodeFS.fstatSync,writeFileSync:requireNodeFS.writeFileSync,closeSync:requireNodeFS.closeSync}}
  runInNewContext(TEMP_LOGIN_HOOK,{process:{env:{CML_TEMP_LOGIN_CAPTURE:capture},type:'browser'},require:fakeRequire,URL,setInterval:()=>({unref(){}}),clearInterval(){}})
  module._load('electron')
  const url='https://auth.openai.com/oauth/authorize?state=fixture'
  void shell.openExternal(url);assert.equal(opened.length,0);assert.ok(readFileSync(capture,'utf8').includes(url))
  void shell.openExternal('https://example.invalid');assert.deepEqual(opened,['https://example.invalid'])
  rmSync(capture);void shell.openExternal(url);assert.equal(opened.at(-1),url)
  symlinkSync(join(f.root,'missing'),capture);void shell.openExternal(url);assert.equal(opened.length,3)
  const env=desktopEnvironment({CML_TEMP_LOGIN_CAPTURE:'old-file',NODE_OPTIONS:'old-hook',OPENAI_API_KEY:'secret',PATH:'/usr/bin'});assert.equal(env.CML_TEMP_LOGIN_CAPTURE,undefined)
})
import * as requireNodeFS from 'node:fs'

test('the hook gets one native fallback, unarmed timeouts stay visible and a user-closed armed client is not reopened',async t=>{
  const f=fixture(t);f.runtime.onLaunch=plan=>{if(f.runtime.plans.length===1){f.runtime.children.delete(plan.nonce);throw new Error('fixture unsupported injection')}writeFileSync(join(plan.directory,'auth.json'),auth())}
  f.start();await f.service.settled();assert.equal(f.service.current().phase,'completed');assert.equal(f.runtime.plans.length,2);assert.ok(f.runtime.plans[0].tempLoginHook);assert.equal(f.runtime.plans[1].tempLoginHook,undefined)
  const other=fixture(t,{armTimeoutMs:1});other.start();await wait(()=>other.service.current().authStatus==='unavailable');await other.service.cancel(other.service.current().id!)
  const armed=fixture(t);armed.runtime.onLaunch=plan=>{writeFileSync(join(plan.directory,'auth-capture.jsonl'),'{"kind":"armed"}\n');armed.runtime.children.delete(plan.nonce)}
  armed.start();await armed.service.settled();assert.equal(armed.service.current().phase,'failed');assert.equal(armed.runtime.plans.length,1)
})

test('cancel during delayed launch, timeout and application shutdown never import credentials or leave a running owned client',async t=>{
  const f=fixture(t);let release!:()=>void
  f.runtime.onLaunch=()=>new Promise<void>(resolve=>{release=resolve});const v=f.start(false);await wait(()=>!!release)
  const cancel=f.service.cancel(v.id!);writeFileSync(join(f.runtime.plans[0].directory,'auth.json'),auth());release();await cancel
  assert.equal(f.service.current().phase,'cancelled');assert.equal(f.store.read().accounts.length,0);assert.equal(f.runtime.children.size,0)
  const timed=fixture(t,{timeoutMs:20});timed.start(false);await timed.service.settled();assert.equal(timed.service.current().phase,'failed');assert.match(timed.service.current().error!,/超时/)
  const exiting=fixture(t);exiting.start(false);await exiting.service.stop();assert.equal(exiting.service.current().phase,'cancelled');assert.equal(exiting.runtime.children.size,0);assert.throws(()=>exiting.start(),/退出/)
})

test('incomplete credentials wait for an atomic complete payload; existing metadata survives and active-account credentials are protected',async t=>{
  const f=fixture(t);f.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),'{"tokens":')
  f.start(false);await wait(()=>f.service.current().phase==='waiting-login');assert.equal(f.store.read().accounts.length,0)
  writeFileSync(join(f.runtime.plans[0].directory,'auth.json'),auth());await f.service.settled()
  const original=f.store.read().accounts[0];f.store.transaction(s=>{s.accounts[0].note='keep';s.accounts[0].tags=['标签'];s.accounts[0].defaultTier='fast'})
  f.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('workspace-fixture','updated'))
  f.start(false);await f.service.settled();const updated=f.store.read().accounts[0]
  assert.equal(f.service.current().updated,true);assert.equal(updated.id,original.id);assert.equal(updated.note,'keep');assert.deepEqual(updated.tags,['标签']);assert.equal(updated.defaultTier,'fast');assert.equal(updated.credentials.refreshToken,'fixture-secret-updated')
  f.busy(true);f.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('workspace-fixture','busy'))
  f.start(false);await f.service.settled();assert.equal(f.service.current().phase,'failed');assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-secret-updated')
})

test('vault failures never report success; a changed closing identity never overwrites the detected account',async t=>{
  const f=fixture(t);f.fail(true);f.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth())
  f.start(false);await f.service.settled();assert.equal(f.service.current().phase,'failed');assert.equal(f.store.read().accounts.length,0);assert.equal(f.imports(),0)
  const changed=fixture(t);changed.runtime.onLaunch=plan=>writeFileSync(join(plan.directory,'auth.json'),auth());changed.runtime.onClose=plan=>writeFileSync(join(plan.directory,'auth.json'),auth('different-workspace'))
  changed.start(false);await changed.service.settled();assert.equal(changed.service.current().phase,'failed');assert.match(changed.service.current().error!,/身份已变化/);assert.equal(changed.store.read().accounts.length,0)
})

test('failed closing keeps a recoverable marker; manual and reopened cleanup remove only owned directories and never follow replacement links',async t=>{
  const f=fixture(t);f.start(false);await wait(()=>f.runtime.plans.length===1);f.runtime.blocked=true;await f.service.cancel(f.service.current().id!)
  assert.ok(f.service.current().notice);assert.equal((await f.service.cleanup()).failed.length,1)
  const plan=f.runtime.plans[0],original=plan.directory+'-original';renameSync(plan.directory,original);symlinkSync(f.root,plan.directory,'dir')
  f.runtime.blocked=false;assert.equal((await f.service.cleanup()).failed.length,1);assert.equal(existsSync(f.application),true)
  rmSync(plan.directory);symlinkSync(join(f.root,'missing-target'),plan.directory,'dir')
  assert.equal((await f.service.cleanup()).failed.length,1);assert.equal(existsSync(original),true)
  rmSync(plan.directory);renameSync(original,plan.directory)
  const reopened=f.create();assert.equal((await reopened.cleanup()).removed.length,1);assert.equal(f.runtime.children.size,0)
  const unknown=join(f.store.directory,'temp-login','sessions','unowned');mkdirSync(unknown);writeFileSync(join(unknown,'keep'),'untouched')
  assert.equal((await reopened.cleanup()).failed.length,1);assert.equal(readFileSync(join(unknown,'keep'),'utf8'),'untouched');await reopened.stop()
})

test('macOS login launcher supplies only the chosen private hook and supports Unicode and spaces without shell expansion',t=>{
  const f=fixture(t);f.start();const plan=f.runtime.plans[0],args=macLaunchArgs(plan)
  assert.ok(args.includes('CODEX_HOME='+plan.directory));assert.ok(args.includes('CML_TEMP_LOGIN_CAPTURE='+plan.tempLoginHook!.capture))
  const strange={...plan,tempLoginHook:{script:'/tmp/空 格 $(literal)/hook.cjs',capture:'/tmp/空 格 $(literal)/capture'}}
  assert.ok(macLaunchArgs(strange).includes('NODE_OPTIONS=--require="/tmp/空 格 $(literal)/hook.cjs"'))
  assert.throws(()=>macLaunchArgs({...plan,tempLoginHook:{script:'/tmp/bad"path',capture:'/tmp/x'}}),/字符/)
})

test('SIGKILL recovery terminates the actual owned temporary macOS client and cleans its journal without touching other profiles',{skip:process.platform!=='darwin'},async t=>{
  const f=fixture(t)
  writeFileSync(join(f.application,'Contents','Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.cml.temp.${randomUUID()}</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  rmSync(join(f.application,'Contents','MacOS','Codex'))
  execFileSync('go',['build','-o',join(f.application,'Contents','MacOS','Codex'),'tests/fixtures/desktop-client.go'],{cwd:resolve('.'),timeout:30000})
  const child=spawn(process.execPath,['--import','tsx','tests/fixtures/temp-login-crash.ts',f.store.directory,f.application],{cwd:resolve('.'),stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',value=>{output+=value})
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash fixture timed out'))},20000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal})})})
  assert.equal(result.signal,'SIGKILL',output)
  const marker=JSON.parse(readFileSync(join(f.store.directory,'temp-login','markers',readdirSync(join(f.store.directory,'temp-login','markers'))[0]),'utf8'))
  const folder=join(f.store.directory,'temp-login','sessions',marker.id),plan={application:f.application,executable:join(f.application,'Contents','MacOS','Codex'),directory:join(folder,'home'),desktopDirectory:join(folder,'desktop'),workingDirectory:join(folder,'workspace'),nonce:marker.nonce,args:[]}
  const runtime=new MacDesktopRuntime();t.after(()=>runtime.stop(plan));assert.ok(await runtime.find(plan))
  const reopened=f.create(runtime),report=await reopened.cleanup();assert.equal(report.failed.length,0,JSON.stringify(report));assert.equal(report.removed.length,1);assert.equal(await runtime.find(plan),undefined);assert.equal(f.store.read().accounts.length,0);await reopened.stop()
})
