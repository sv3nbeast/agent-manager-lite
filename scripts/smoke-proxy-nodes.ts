// Explicit real-engine integration. Two pinned Mihomo processes communicate
// exclusively over loopback. Only synthetic accounts and an ephemeral TLS root.
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn,execFileSync,type ChildProcess} from 'node:child_process'
import {createServer} from 'node:http'
import {createSecureServer,type ServerHttp2Session} from 'node:http2'
import {createServer as tcpServer,connect,type Socket} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import {ProxyEngine} from '../src/main/proxyEngine'
import {ProxyTunnels} from '../src/main/proxyTunnels'
import {AccountNetwork} from '../src/main/accountNetwork'
import {Gateway} from '../src/main/gateway'
import {parseAccountImport} from '../src/main/accounts'
import {settingsSchema} from '../src/shared/types'
import {Store} from '../src/main/store'
import {ProxyCatalog} from '../src/main/proxyCatalog'
import {decodeCatalogBinding} from '../src/main/proxyCatalogBinding'
import {accountProxyURL,unifiedProxyURL} from '../src/main/proxyPolicy'
const id='11111111-2222-3333-4444-555555555555'
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('close',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})}
async function port(){const s=tcpServer();await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const a=s.address();assert.ok(a&&typeof a==='object');await new Promise<void>(resolve=>s.close(()=>resolve()));return a.port}
async function main(){
  const index=process.argv.indexOf('--archive');if(index<0)throw new Error('Pass --archive <pinned official package>')
  const root=mkdtempSync(join(tmpdir(),'cml-real-node-')),engine=new ProxyEngine(root),sockets=new Set<Socket>(),sessions=new Set<ServerHttp2Session>()
  const active=new Set<string>(),store=new Store(join(root,'fixture-vault'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),catalogs=new ProxyCatalog(store,id=>active.has(id))
  const helper=resolve('resources/bin/codex-proxy'),tunnels=new ProxyTunnels(helper,join(root,'tunnels'),()=>engine.preflight(),{idleMs:0}),network=new AccountNetwork(helper,()=>store.proxyState(),tunnels)
  let gateway:Gateway|undefined,nodeServer:ChildProcess|undefined,proxy:ReturnType<typeof createServer>|undefined,probe:ReturnType<typeof createServer>|undefined,tls:ReturnType<typeof createSecureServer>|undefined
  const emergency=()=>nodeServer?.kill('SIGKILL');process.once('exit',emergency)
  try {
    engine.begin(resolve(process.argv[index+1]));assert.equal((await engine.wait()).phase,'completed');const binary=await engine.preflight()
    const certificate=join(root,'cert.pem'),key=join(root,'key.pem'),config=join(root,'openssl.cnf')
    writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=chatgpt.com\n[ext]\nsubjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n')
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',certificate,'-config',config],{stdio:'ignore',timeout:10000})
    const seen:{tier?:string;auth?:string}[]=[]
    tls=createSecureServer({allowHTTP1:true,key:readFileSync(key),cert:readFileSync(certificate)},async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk
      assert.equal(req.headers['proxy-authorization'],undefined);seen.push({tier:JSON.parse(body).service_tier,auth:req.headers.authorization})
      res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'resp-node-fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})+'\n\n')
    })
    tls.on('session',session=>{sessions.add(session);session.on('close',()=>sessions.delete(session))})
    await new Promise<void>(resolve=>tls!.listen(0,'127.0.0.1',resolve));const ta=tls.address();assert.ok(ta&&typeof ta==='object')
    let probes=0,connects=0
    probe=createServer((req,res)=>{assert.equal(req.url,'/status');assert.equal(req.headers['proxy-authorization'],undefined);probes++;res.end('{"ok":true}')})
    await new Promise<void>(resolve=>probe!.listen(0,'127.0.0.1',resolve));const probeAddress=probe.address();assert.ok(probeAddress&&typeof probeAddress==='object')
    proxy=createServer((_req,res)=>{res.writeHead(502);res.end()})
    proxy.on('connect',(req,socket,head)=>{
      const target=req.url==='chatgpt.com:443'?ta.port:req.url==='probe.invalid:80'?probeAddress.port:undefined
      if(!target){socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return}connects++
      sockets.add(socket as Socket);socket.on('close',()=>sockets.delete(socket as Socket))
      const local=connect(target,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)local.write(head);socket.pipe(local).pipe(socket)})
      sockets.add(local);local.on('close',()=>sockets.delete(local));local.on('error',()=>socket.destroy());socket.on('error',()=>local.destroy())
    })
    await new Promise<void>(resolve=>proxy!.listen(0,'127.0.0.1',resolve));const pa=proxy.address();assert.ok(pa&&typeof pa==='object')
    const vlessPort=await port(),ssPort=await port(),serverRoot=join(root,'node-server');mkdirSync(serverRoot,{mode:0o700})
    const nodeConfig={'mode':'rule','log-level':'info','allow-lan':false,'dns':{enable:false},'tun':{enable:false},'sniffer':{enable:false},'geo-auto-update':false,'find-process-mode':'off',
      listeners:[{name:'vless-fixture',type:'vless',listen:'127.0.0.1',port:vlessPort,'allow-insecure':true,users:[{username:'fixture',uuid:id}]},{name:'ss-fixture',type:'shadowsocks',listen:'127.0.0.1',port:ssPort,cipher:'aes-256-gcm',password:'synthetic-node-secret'}],
      proxies:[{name:'loopback-fixture',type:'http',server:'127.0.0.1',port:pa.port}],rules:['MATCH,loopback-fixture']}
    nodeServer=spawn(binary,['-f','-','-d',serverRoot],{cwd:serverRoot,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}})
    let diagnostics='';nodeServer.stdout?.on('data',b=>diagnostics=(diagnostics+b).slice(-8192));nodeServer.stderr?.on('data',b=>diagnostics=(diagnostics+b).slice(-8192));nodeServer.stdin!.end(JSON.stringify(nodeConfig))
    for(let attempt=0;;attempt++){
      if(nodeServer.exitCode!==null)throw new Error('loopback node server exited: '+diagnostics)
      const ready=await new Promise<boolean>(resolve=>{const socket=connect(vlessPort,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))})
      if(ready)break;if(attempt>=100)throw new Error('loopback node server timeout: '+diagnostics);await delay(50)
    }
    const vless=`vless://${id}@127.0.0.1:${vlessPort}`,ss=`ss://${Buffer.from('aes-256-gcm:synthetic-node-secret').toString('base64url')}@127.0.0.1:${ssPort}`
    for(const uri of [vless,ss])assert.deepEqual(await network.through(uri)('http://probe.invalid/status'),{ok:true})
    assert.equal(probes,2)
    const sourceText=JSON.stringify({proxies:[{name:'VLESS',type:'vless',server:'127.0.0.1',port:vlessPort,uuid:id},{name:'SS',type:'ss',server:'127.0.0.1',port:ssPort,cipher:'aes-256-gcm',password:'synthetic-node-secret'},{name:'Offline',type:'http',server:'127.0.0.1',port:1}],
      'proxy-groups':['select','url-test','fallback','load-balance'].map(type=>({name:type,type,proxies:type==='fallback'?['Offline','VLESS','SS']:['VLESS','SS'],...(type==='select'?{}:{url:'http://probe.invalid/status','expected-status':'200',interval:600,timeout:1000,lazy:false})}))})
    const imported=catalogs.importSubscription('Real loopback groups','https://fixture.invalid/feed',{body:sourceText});catalogs.apply({ticket:imported.ticket,confirmed:true})
    const source=catalogs.list()[0]
    for(const group of store.read().proxyCatalogs![0].catalog.groups){
      const preview=catalogs.preview({action:'bind',sourceId:source.id,revision:source.revision,itemId:group.id,selections:group.kind==='select'?{[group.id]:'VLESS'}:{},name:group.name});catalogs.apply({ticket:preview.ticket,confirmed:true})
      const resource=store.read().proxyResources!.find(r=>r.name===group.name)!,graph=decodeCatalogBinding(resource.url)
      assert.equal(graph.proxies.length,group.kind==='select'?1:group.kind==='fallback'?3:2)
      const before=probes,scope='group-'+group.kind,lease=await tunnels.acquire(resource.url,scope)
      try{
        if(group.kind!=='select')for(let attempt=0;probes<=before;attempt++){assert.ok(attempt<100,'automatic group health probe did not complete');await delay(50)}
        assert.deepEqual(await network.through(resource.url,scope)('http://probe.invalid/status',{signal:AbortSignal.timeout(6000)}),{ok:true})
      }finally{lease.release()}
    }
    // User-built policies use node copies, the same strict graph boundary and
    // the real pinned engine; no subscription group is substituted for them.
    for(const kind of ['select','url-test','fallback','load-balance'] as const){
      const origin=store.read().proxyCatalogs!.find(s=>s.id===source.id)!,names=kind==='fallback'?['Offline','VLESS','SS']:['VLESS','SS']
      const p=catalogs.preview({action:'strategy',name:'Built '+kind,kind,members:names.map(name=>({sourceId:source.id,itemId:origin.catalog.nodes.find(n=>n.name===name)!.id})),options:{url:'http://probe.invalid/status',interval:600,timeout:1,lazy:false}});catalogs.apply({ticket:p.ticket,confirmed:true})
      const policy=store.read().proxyCatalogs!.at(-1)!,group=policy.catalog.groups[0],binding=catalogs.preview({action:'bind',sourceId:policy.id,revision:policy.revision,itemId:group.id,selections:kind==='select'?{[group.id]:'VLESS'}:{},name:'Strategy '+kind});catalogs.apply({ticket:binding.ticket,confirmed:true})
      const resource=store.read().proxyResources!.at(-1)!,before=probes,scope='strategy-'+kind,lease=await tunnels.acquire(resource.url,scope)
      try{if(kind!=='select')for(let attempt=0;probes<=before;attempt++){assert.ok(attempt<100,'strategy health probe did not complete');await delay(50)}assert.deepEqual(await network.through(resource.url,scope)('http://probe.invalid/status',{signal:AbortSignal.timeout(6000)}),{ok:true})}finally{lease.release()}
    }
    const testBinary=join(root,'sidecar-fixture'),wrapper=join(root,'gateway.cjs')
    execFileSync('go',['test','-c','-o',testBinary],{cwd:resolve('sidecars/codex-proxy'),timeout:90000,stdio:'pipe'})
    writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const args=process.argv.slice(2),file=args[args.indexOf('-config')+1];const config=JSON.parse(fs.readFileSync(file));config['proxy-url']='http://127.0.0.1:1';fs.writeFileSync(file,JSON.stringify(config));const child=spawn(${JSON.stringify(testBinary)},['-test.run=^TestNativeAuthorityFixture$','-test.timeout=60s'],{stdio:'inherit',env:{...process.env,CML_AUTHORITY_FIXTURE_CERT:${JSON.stringify(certificate)},CML_AUTHORITY_FIXTURE_ARGS:JSON.stringify(args)}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));`,{mode:0o700})
    const account=parseAccountImport('at-synthetic-node').accounts[0];account.proxy={mode:'resource',resourceId:store.read().proxyResources!.find(r=>r.name==='url-test')!.id}
    gateway=new Gateway(wrapper,join(root,'gateway'),undefined,undefined,()=>store.proxyState(),tunnels)
    await gateway.start({id:account.id,port:0,account,apiKey:'synthetic-downstream'},settingsSchema.parse({defaultTier:'fast'}))
    const call=async(tier?:string,stream=false)=>{
      const response=await fetch(`http://127.0.0.1:${gateway!.current().port}/v1/responses`,{method:'POST',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer synthetic-downstream','Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.5',input:'synthetic test',service_tier:tier,stream})})
      assert.equal(response.status,200,await response.text())
    }
    await call();await call('default',true)
    const original=JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',account.id+'.json'),'utf8')).proxy_url
    assert.ok(original.startsWith('socks5h://'));assert.equal(original.includes(id),false)
    account.credentials.accessToken='at-synthetic-rotated';await gateway.updateCredentials(account)
    assert.equal(JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',account.id+'.json'),'utf8')).proxy_url,original)
    await call('flex');await call('auto',true)
    assert.deepEqual(seen.map(v=>v.tier),['priority','default','flex','auto']);assert.equal(seen.at(-1)?.auth,'Bearer at-synthetic-rotated');assert.ok(connects>0)
    await gateway.stop()
    const inherited=parseAccountImport('at-synthetic-inherited').accounts[0],resourceId=account.proxy.resourceId!,resourceBefore=store.read().proxyResources!.find(r=>r.id===resourceId)!
    store.transaction(state=>{state.accounts.push(account,inherited);state.unifiedProxy={mode:'all_accounts',resourceId}})
    await gateway.start({id:inherited.id,port:0,account:inherited,apiKey:'synthetic-downstream'},settingsSchema.parse({defaultTier:'fast'}));active.add(inherited.id)
    await call();const beforeRefresh=unifiedProxyURL(store.read())
    const changed=JSON.parse(sourceText);changed['proxy-groups'].find((g:{name:string})=>g.name==='url-test').proxies=['SS']
    catalogs.refreshSubscription(source.id,catalogs.list()[0].revision,{body:JSON.stringify(changed)})
    assert.equal(store.read().unifiedProxy?.pending,true);assert.equal(unifiedProxyURL(store.read()),beforeRefresh)
    assert.deepEqual(store.read().proxyResources!.find(r=>r.id===resourceId),resourceBefore)
    assert.equal(accountProxyURL(account,store.read()),resourceBefore.url);await call('default',true)
    await gateway.stop();active.clear();catalogs.syncPendingSubscription()
    const refreshed=unifiedProxyURL(store.read()),refreshedGraph=decodeCatalogBinding(refreshed)
    assert.notEqual(refreshed,beforeRefresh);assert.equal(store.read().unifiedProxy?.pending,undefined)
    assert.deepEqual(refreshedGraph.proxies.map(p=>p.type),['ss']);assert.equal(accountProxyURL(account,store.read()),resourceBefore.url)
    assert.deepEqual(await network.through(resourceBefore.url)('http://probe.invalid/status',{signal:AbortSignal.timeout(6000)}),{ok:true})
    await gateway.start({id:inherited.id,port:0,account:inherited,apiKey:'synthetic-downstream'},settingsSchema.parse({defaultTier:'fast'}));active.add(inherited.id)
    await call();await call('default',true)
    const missing=JSON.parse(sourceText);missing['proxy-groups']=missing['proxy-groups'].filter((g:{name:string})=>g.name!=='url-test')
    catalogs.refreshSubscription(source.id,catalogs.list()[0].revision,{body:JSON.stringify(missing)})
    assert.match(store.read().unifiedProxy!.staleError!,/原选择/);assert.equal(unifiedProxyURL(store.read()),refreshed)
    await gateway.stop();active.clear()
    await gateway.start({id:inherited.id,port:0,account:inherited,apiKey:'synthetic-downstream'},settingsSchema.parse({defaultTier:'fast'}))
    await call();assert.deepEqual(seen.slice(4).map(v=>v.tier),['priority','default','priority','default','priority'])
    assert.ok(seen.slice(4).every(v=>v.auth==='Bearer at-synthetic-inherited'))
    await gateway.stop()
    const strategyAccount=parseAccountImport('at-synthetic-strategy').accounts[0];strategyAccount.proxy={mode:'resource',resourceId:store.read().proxyResources!.find(r=>r.name==='Strategy url-test')!.id}
    await gateway.start({id:strategyAccount.id,port:0,account:strategyAccount,apiKey:'synthetic-downstream'},settingsSchema.parse({defaultTier:'fast'}));await call();await call('default',true)
    assert.deepEqual(seen.slice(-2).map(v=>v.tier),['priority','default']);assert.ok(seen.slice(-2).every(v=>v.auth==='Bearer at-synthetic-strategy'))
    await stop(nodeServer);nodeServer=undefined;const previousProbes=probes
    await assert.rejects(network.through(ss)('http://probe.invalid/status',{signal:AbortSignal.timeout(3000)}));assert.equal(probes,previousProbes,'unavailable node must not use another route')
    await gateway.stop();await network.stop();await tunnels.stop()
    assert.deepEqual(readdirSync(join(root,'tunnels')),[]);assert.equal(existsSync(join(root,'state.vault')),false)
    console.log('Real pinned Mihomo passed: VLESS/SS; catalog and user-built strategy select/url-test/fallback/load-balance with all automatic candidates retained and an unavailable fallback candidate; account network; gateway Fast/Standard/Flex/Auto, SSE and token reload plus actual strategy Gateway Fast/Standard; active subscription refresh keeps the old unified exit, idle refresh applies the SS-only snapshot, independent resources remain unchanged, missing selection survives gateway restart with the last snapshot; failure without direct fallback and cleanup. Synthetic credentials, no OS keychain or external upstream.')
  }finally{
    catalogs.stop();await gateway?.stop();await network.stop();await tunnels.stop();if(nodeServer)await stop(nodeServer)
    for(const socket of sockets)socket.destroy();for(const session of sessions)session.destroy();proxy?.closeAllConnections();proxy?.close();probe?.closeAllConnections();probe?.close();tls?.close();await engine.stop();rmSync(root,{recursive:true,force:true});process.removeListener('exit',emergency)
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1})
