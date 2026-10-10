import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {networkRouteEnvironment,managedDesktopNetworkArgs,type InstanceNetworkRoute} from '../src/main/desktopNetwork'
import {desktopEnvironment,macLaunchArgs,type DesktopPlan} from '../src/main/instanceRuntime'
import {cliLaunchScript,cliLaunchFiles,MacCliRuntime} from '../src/main/cliInstanceRuntime'

const bridge='http://127.0.0.1:43127'
const keys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']
const inherited={HTTP_PROXY:'http://inherited:secret@upstream.invalid:8080',HTTPS_PROXY:'http://inherited:secret@upstream.invalid:8080',ALL_PROXY:'socks5://other.invalid:1080',NO_PROXY:'*',
  http_proxy:'http://lower.invalid:8080',https_proxy:'http://lower.invalid:8080',all_proxy:'socks5://lower.invalid:1080',no_proxy:'.invalid',Http_Proxy:'http://mixed.invalid:8080',KEEP_FIXTURE:'untouched'}
function plan(networkRoute?:InstanceNetworkRoute):DesktopPlan {
  return {application:'/fixture/Codex.app',executable:'/fixture/Codex.app/Contents/MacOS/Codex',directory:'/fixture/home',desktopDirectory:'/fixture/desktop',workingDirectory:'/fixture/workspace',args:[],nonce:randomUUID(),networkRoute}
}
function launchEnvironment(args:string[]):Record<string,string> {
  const result:Record<string,string>={}
  for(let i=0;i<args.indexOf('--args');i++)if(args[i]==='--env'){
    const value=args[++i],at=value.indexOf('=');result[value.slice(0,at)]=value.slice(at+1)
  }
  return result
}

test('managed desktop routing overrides inherited proxies in both LaunchServices and child environment',()=>{
  const route:InstanceNetworkRoute={mode:'proxy',url:bridge},env=desktopEnvironment(inherited,route),args=macLaunchArgs(plan(route)),launched=launchEnvironment(args)
  for(const key of keys){
    const expected=key.toUpperCase()==='NO_PROXY'?'localhost,127.0.0.1,::1':bridge
    assert.equal(env[key],expected,key);assert.equal(launched[key],expected,key)
  }
  assert.equal(env.Http_Proxy,undefined)
  assert.equal(env.KEEP_FIXTURE,'untouched');assert.equal(inherited.HTTP_PROXY,'http://inherited:secret@upstream.invalid:8080')
  assert.ok(args.indexOf(`--proxy-server=${bridge}`)>args.indexOf('--args'))
  assert.equal(args.filter(value=>value.startsWith('--proxy-server')).length,1)
  assert.equal(args.includes('--no-proxy-server'),false)
  assert.equal(JSON.stringify(args).includes('secret'),false)
})

test('explicit direct routing disables system and inherited proxies without changing unrelated settings',()=>{
  const route:InstanceNetworkRoute={mode:'direct'},env=desktopEnvironment(inherited,route),args=macLaunchArgs(plan(route)),launched=launchEnvironment(args)
  for(const key of keys){const expected=key.toUpperCase()==='NO_PROXY'?'*':'';assert.equal(env[key],expected,key);assert.equal(launched[key],expected,key)}
  assert.ok(args.includes('--no-proxy-server'));assert.equal(args.some(value=>value.startsWith('--proxy-server')),false)
  assert.equal(env.KEEP_FIXTURE,'untouched')
})

test('managed desktop route removes conflicting joined and separated proxy flags while preserving independent arguments',()=>{
  const source=['--fixture=keep','--proxy-server','http://private:secret@old.invalid:9','--proxy-pac-url=https://old.invalid/proxy.pac',
    '--proxy-bypass-list','*','--no-proxy-server','--proxy-auto-detect','--PROXY-SERVER=http://second.invalid:8','--proxy-pac-url','--other=preserved','--','literal value']
  const filtered=['--fixture=keep','--other=preserved','--','literal value']
  const proxy=managedDesktopNetworkArgs(source,{mode:'proxy',url:bridge})
  assert.deepEqual(proxy,[`--proxy-server=${bridge}`,'--proxy-bypass-list=localhost;127.0.0.1;[::1]',...filtered])
  assert.deepEqual(managedDesktopNetworkArgs(source,{mode:'direct'}),['--no-proxy-server',...filtered])
  assert.ok(source.includes('http://private:secret@old.invalid:9'),'The saved user args are not mutated')
  assert.equal(proxy.some(value=>value.includes('secret')),false)
  assert.deepEqual(managedDesktopNetworkArgs(['--no-proxy-server','project-name'],{mode:'proxy',url:bridge}).slice(2),['project-name'],'Boolean switches cannot consume positional arguments')
})

test('unmanaged plans retain inherited network settings and literal user proxy flags',()=>{
  const original=plan();original.args=['--proxy-server=http://user.invalid:8080','--fixture']
  assert.deepEqual(desktopEnvironment(inherited),inherited)
  assert.deepEqual(managedDesktopNetworkArgs(original.args),original.args)
  const args=macLaunchArgs(original)
  assert.deepEqual(args.slice(-original.args.length),original.args)
  assert.equal(keys.some(key=>Object.hasOwn(launchEnvironment(args),key)),false)
  assert.deepEqual(networkRouteEnvironment(),{})
})

test('runtime routes reject remote, authenticated and ambiguous URLs before reaching argv or scripts',()=>{
  const invalid=['http://proxy.invalid:8080','http://localhost:8080','https://127.0.0.1:8080','socks5://127.0.0.1:1080','http://user:secret@127.0.0.1:8080',
    'http://127.0.0.1','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:08080','http://127.0.0.1:8080/path','http://127.0.0.1:8080?secret=x','http://127.0.0.1:8080#secret',
    ' http://127.0.0.1:8080','http://127.0.0.1:8080\n','http://127.1:8080','http://[::ffff:127.0.0.1]:8080','http://127.0.0.1:8080;--fixture']
  for(const url of invalid){
    const route:InstanceNetworkRoute={mode:'proxy',url}
    for(const action of [()=>macLaunchArgs(plan(route)),()=>cliLaunchScript(plan(route)),()=>desktopEnvironment(inherited,route)])assert.throws(action,/本机 HTTP/)
  }
  for(const route of [{mode:'direct',url:bridge},{mode:'inherit'},{mode:'proxy',url:bridge,password:'secret'}] as unknown as InstanceNetworkRoute[])assert.throws(()=>macLaunchArgs(plan(route)),/无效/)
  assert.equal(networkRouteEnvironment({mode:'proxy',url:'http://[::1]:1234/'}).HTTPS_PROXY,'http://[::1]:1234')
})

test('real CLI launch scripts project account routing over Terminal proxies and preserve inherited behavior without a route',{skip:process.platform==='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-cli-network-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  for(const route of [{mode:'proxy',url:bridge},{mode:'direct'},undefined] as const){
    const launch={...plan(route),executable:'/usr/bin/env',directory:root,desktopDirectory:root,workingDirectory:root,args:[]},files=cliLaunchFiles(launch),script=cliLaunchScript(launch)
    mkdirSync(files.permit);writeFileSync(files.script,script)
    const output=execFileSync('/bin/bash',[files.script],{env:{...process.env,...inherited},encoding:'utf8',timeout:5000})
    const observed=Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}))
    for(const key of keys){
      const expected=route?networkRouteEnvironment(route)[key]:inherited[key as keyof typeof inherited]
      assert.equal(observed[key],expected,`${route?.mode??'inherit'} ${key}`)
    }
    assert.equal(observed.KEEP_FIXTURE,'untouched');assert.equal(observed.CODEX_HOME,root)
    assert.equal(existsSync(files.permit),false);assert.equal(existsSync(files.record),true)
    assert.equal(script.includes('secret'),false)
  }
})

test('invalid CLI routes cannot publish a Terminal launch permit',{skip:process.platform!=='darwin'},async t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-cli-invalid-route-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const launch={...plan({mode:'proxy',url:'http://user:secret@127.0.0.1:8080'}),desktopDirectory:root}
  const runtime=new MacCliRuntime(async()=>assert.fail('Invalid routes must never open Terminal'))
  await assert.rejects(runtime.launch(launch,new AbortController().signal),/本机 HTTP/)
  assert.equal(existsSync(cliLaunchFiles(launch).permit),false);assert.equal(existsSync(cliLaunchFiles(launch).script),false)
})
