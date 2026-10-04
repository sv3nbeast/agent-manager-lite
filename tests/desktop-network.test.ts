import test from 'node:test'
import assert from 'node:assert/strict'
import {chromiumEnvironmentProxy,desktopNetworkArgs} from '../src/main/desktopNetwork'
import {macLaunchArgs,type DesktopPlan} from '../src/main/instanceRuntime'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

test('desktop instances inherit an environment-only network route through supported Chromium switches',()=>{
  const args=desktopNetworkArgs(['--fixture'],{HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://127.0.0.1:7890'},false)
  assert.deepEqual(args,['--fixture','--proxy-server=http://127.0.0.1:7890','--proxy-bypass-list=localhost;127.0.0.1;[::1];<local>'])
  const plan={application:'/fixture.app',directory:'/fixture/home',desktopDirectory:'/fixture/desktop',workingDirectory:'/fixture',nonce:'fixture',args:['--fixture']} as DesktopPlan
  const launch=macLaunchArgs(plan,args)
  assert.ok(launch.indexOf('--proxy-server=http://127.0.0.1:7890')>launch.indexOf('--args'))
  assert.deepEqual(plan.args,['--fixture'])
})

test('HTTP and HTTPS routes and environment NO_PROXY retain their separate meanings',()=>{
  const args=desktopNetworkArgs([],{http_proxy:'127.0.0.1:8001',https_proxy:'http://127.0.0.1:8002',NO_PROXY:'.internal.invalid,10.0.0.0/8'},false)
  assert.equal(args[0],'--proxy-server=http=http://127.0.0.1:8001;https=http://127.0.0.1:8002')
  assert.equal(args[1],'--proxy-bypass-list=localhost;127.0.0.1;[::1];<local>;internal.invalid;*.internal.invalid;10.0.0.0/8')
  assert.deepEqual(desktopNetworkArgs([],{HTTPS_PROXY:'http://127.0.0.1:8001',NO_PROXY:'*'},false),[])
  assert.equal(desktopNetworkArgs([],{ALL_PROXY:'socks5h://[::1]:1080'},false)[0],'--proxy-server=socks5://[::1]:1080')
})

test('NO_PROXY domains retain suffix and port constraints across comma and whitespace separators',()=>{
  const environment={HTTPS_PROXY:'http://127.0.0.1:8001',NO_PROXY:'.internal.invalid:443, other.invalid:8443\t*.third.invalid\n[::1]:8080 10.0.0.1:8000 10.0.0.0/8 ::1'}
  const args=desktopNetworkArgs([],environment,false)
  assert.equal(args[1],'--proxy-bypass-list=localhost;127.0.0.1;[::1];<local>;internal.invalid:443;*.internal.invalid:443;other.invalid:8443;*.other.invalid:8443;third.invalid;*.third.invalid;[::1]:8080;10.0.0.1:8000;10.0.0.0/8')
  for(const value of ['http://internal.invalid','internal.invalid:0','internal.invalid:65536','internal.invalid:abc','bad*glob.invalid','10.0.0.0/33','[::g]:80']){
    assert.deepEqual(desktopNetworkArgs(['--fixture'],{...environment,NO_PROXY:value},false),['--fixture'],value)
  }
})

test('system proxy, PAC, direct mode and user proxy switches take precedence over automatic inheritance',()=>{
  const env={HTTPS_PROXY:'http://127.0.0.1:7890'}
  for(const state of [true,undefined])assert.deepEqual(desktopNetworkArgs(['--fixture'],env,state),['--fixture'])
  for(const args of [['--proxy-server=http://fixture:80'],['--proxy-pac-url','https://fixture/pac'],['--no-proxy-server'],['--proxy-auto-detect'],['--proxy-bypass-list=fixture']])assert.deepEqual(desktopNetworkArgs(args,env,false),args)
})

test('authenticated, malformed and unsupported environment proxies never expose secrets or block an existing launch',()=>{
  const values=['http://user:secret@127.0.0.1:7890','socks5://user%40name:secret@127.0.0.1:1080','ftp://127.0.0.1:21','http://127.0.0.1:7890/path','http://127.0.0.1:7890?token=secret','http://127.0.0.1:7890#secret','http://127.0.0.1:7890;--fixture','http://127.0.0.1:99999','\nhttp://127.0.0.1:7890','socks5://127.0.0.1']
  for(const value of values){assert.equal(chromiumEnvironmentProxy(value),undefined,value);assert.deepEqual(desktopNetworkArgs(['--fixture'],{HTTPS_PROXY:value},false),['--fixture'])}
  assert.equal(chromiumEnvironmentProxy('http://localhost'),'http://localhost:80')
  assert.equal(chromiumEnvironmentProxy('https://localhost'),'https://localhost:443')
  assert.deepEqual(desktopNetworkArgs(['--fixture'],{},false),['--fixture'])
})

test('actual windowless Electron net needs Chromium proxy switches and keeps the local gateway direct',{skip:process.platform!=='darwin',timeout:20000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-desktop-network-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const proxied:string[]=[],direct:string[]=[]
  const proxy=createServer((request,response)=>{proxied.push(request.url!);response.end('fixture-proxy-translation')})
  const gateway=createServer((request,response)=>{direct.push(request.url!);response.end('fixture-local-gateway')})
  for(const server of [proxy,gateway]){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()})}
  const proxyAddress=proxy.address(),gatewayAddress=gateway.address()
  assert.ok(proxyAddress&&typeof proxyAddress==='object'&&gatewayAddress&&typeof gatewayAddress==='object')
  const environment={HTTP_PROXY:`http://127.0.0.1:${proxyAddress.port}`,HTTPS_PROXY:`http://127.0.0.1:${proxyAddress.port}`}
  const electron=resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const run=async(args:string[],name:string,external='http://cml-desktop-network.invalid/translation-fixture')=>{
    const env={...process.env,...environment,http_proxy:environment.HTTP_PROXY,https_proxy:environment.HTTPS_PROXY,CML_NETWORK_FIXTURE_HOME:join(root,name),CML_NETWORK_FIXTURE_LOCAL:`http://127.0.0.1:${gatewayAddress.port}/responses`,CML_NETWORK_FIXTURE_EXTERNAL:external}
    delete env.ELECTRON_RUN_AS_NODE
    return new Promise<{external:{status?:number;body?:string;failed?:boolean};local:{status?:number;body?:string}}>((accept,reject)=>{
      const child=spawn(electron,[resolve('tests/fixtures/desktop-network-electron.cjs'),...args],{env,stdio:['ignore','pipe','ignore']})
      let stdout=''
      child.stdout.on('data',chunk=>{stdout+=String(chunk)})
      child.on('error',reject)
      child.on('close',code=>{
        const result=stdout.match(/CML_NETWORK_RESULT:(.+)/)
        if(code!==0||!result){reject(new Error('隔离 Electron 网络 fixture 未完成'));return}
        accept(JSON.parse(result[1]))
      })
    })
  }
  const original=await run([],'original')
  assert.notEqual(original.external.body,'fixture-proxy-translation')
  assert.equal(original.local.body,'fixture-local-gateway')
  assert.deepEqual(proxied,[])
  const inherited=await run(desktopNetworkArgs([],environment,false),'inherited')
  assert.equal(inherited.external.status,200)
  assert.equal(inherited.external.body,'fixture-proxy-translation')
  assert.equal(inherited.local.body,'fixture-local-gateway')
  assert.deepEqual(proxied,['http://cml-desktop-network.invalid/translation-fixture'])
  assert.deepEqual(direct,['/responses','/responses'])
  const bypass=desktopNetworkArgs([],{...environment,NO_PROXY:'.cml-desktop-network.invalid:80'},false)
  const rootBypass=await run(bypass,'root-bypass')
  assert.equal(rootBypass.external.failed,true,'A leading-dot host exclusion with a port must include the root host')
  const subdomainBypass=await run(bypass,'subdomain-bypass','http://child.cml-desktop-network.invalid/translation-fixture')
  assert.equal(subdomainBypass.external.failed,true,'The same port-limited exclusion must include subdomains')
  const differentPort=await run(desktopNetworkArgs([],{...environment,NO_PROXY:'.cml-desktop-network.invalid:443'},false),'different-port')
  assert.equal(differentPort.external.body,'fixture-proxy-translation','A different port must keep the proxy route')
  assert.deepEqual(proxied,['http://cml-desktop-network.invalid/translation-fixture','http://cml-desktop-network.invalid/translation-fixture'])
  assert.deepEqual(direct,Array(5).fill('/responses'))
})
