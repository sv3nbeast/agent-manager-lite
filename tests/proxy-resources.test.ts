import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer,type Server} from 'node:http'
import {createSecureServer} from 'node:http2'
import {connect} from 'node:net'
import {execFileSync} from 'node:child_process'
import {Store} from '../src/main/store'
import {parseAccountImport,deleteAccounts} from '../src/main/accounts'
import {AccountRecycle} from '../src/main/accountRecycle'
import {serializeAccounts} from '../src/main/accountFiles'
import {ProxyResources} from '../src/main/proxyResources'
import {AccountProxies} from '../src/main/accountProxy'
import {AccountNetwork} from '../src/main/accountNetwork'
import {accountProxyURL,accountProxyView} from '../src/main/proxyPolicy'
import {Gateway} from '../src/main/gateway'
import {emptyLocalAccess} from '../src/shared/localAccess'
import {settingsSchema} from '../src/shared/types'
import {authFor} from '../src/main/nativeAccountProjection'
import {NativeInstanceAccounts} from '../src/main/nativeInstanceAccounts'
import {TokenAuthority} from '../src/main/tokens'

const binary=resolve('resources/bin/codex-proxy')
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=mkdtempSync(join(tmpdir(),'cml-unified-'));let fail=false,now=Date.now()
  const codec={encrypt:(value:string)=>{if(fail)throw new Error('fixture vault failure');return Buffer.from(value)},decrypt:(value:Buffer)=>value.toString()}
  const store=new Store(join(root,'vault'),codec),busy=new Set<string>(),service=new ProxyResources(store,id=>busy.has(id),()=>now)
  const inherited=parseAccountImport('at-unified-fixture').accounts[0]
  store.transaction(state=>{state.accounts.push(inherited);state.settings.refreshMinutes=0})
  const network=new AccountNetwork(binary,()=>store.proxyState()),accounts=new AccountProxies(store,network,id=>busy.has(id))
  const apply=(input:unknown)=>{const preview=service.preview(input);service.apply({ticket:preview.ticket,confirmed:true});return preview}
  const add=(name:string,url:string)=>{apply({action:'create',name,url});return store.read().proxyResources!.find(r=>r.name===name)!}
  const get=()=>store.read().accounts[0]
  t.after(async()=>{service.stop();await accounts.stop();await network.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,codec,service,busy,network,accounts,inherited,apply,add,get,fail:(value:boolean)=>{fail=value},advance:()=>{now+=300001}}
}
async function listen(t:{after(fn:()=>void|Promise<void>):void},server:Server){
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object')
  t.after(()=>{server.closeAllConnections();server.close()});return `http://127.0.0.1:${address.port}`
}

test('unified inheritance preserves independent/direct/API exclusions and never exposes saved proxy credentials',t=>{
  const f=fixture(t),a=f.add('Shared','http://fixture:shared-secret@127.0.0.1:9876'),b=f.add('Own','socks5h://fixture:own-secret@127.0.0.1:9877')
  const base=f.get(),own={...base,id:randomUUID(),proxy:{mode:'custom' as const,url:b.url}},direct={...base,id:randomUUID(),proxy:{mode:'direct' as const}},resource={...base,id:randomUUID(),proxy:{mode:'resource' as const,resourceId:b.id}}
  const api={...base,id:randomUUID(),kind:'api_key' as const},agent={...base,id:randomUUID(),kind:'agent_identity' as const},custom={...base,id:randomUUID(),providerId:randomUUID()}
  f.store.transaction(state=>{state.accounts.push(own,direct,resource,api,agent,custom)})
  const accountsBefore=f.store.read().accounts
  const preview=f.service.preview({action:'enable',id:a.id,revision:a.revision})
  assert.deepEqual(preview.affected.map(a=>a.id),[base.id]);assert.deepEqual([preview.eligible,preview.inherited,preview.independent,preview.direct],[4,1,2,1])
  assert.equal(JSON.stringify(preview).includes('shared-secret'),false)
  f.service.apply({ticket:preview.ticket,confirmed:true})
  const state=f.store.read();assert.deepEqual(state.accounts,accountsBefore)
  for(const [account,want] of [[base,a.url],[own,b.url],[direct,'direct'],[resource,b.url],[api,undefined],[agent,undefined],[custom,undefined]] as const)assert.equal(accountProxyURL(account,state),want)
  const view=f.store.snapshot(),serialized=JSON.stringify(view)
  assert.equal(view.accounts[0].egressProxy?.source,'unified');assert.equal(view.accounts[0].egressProxy?.name,'Shared')
  for(const secret of ['shared-secret','own-secret','fixture:']){assert.equal(serialized.includes(secret),false);assert.equal(serializeAccounts(state.accounts).includes(secret),false)}
  const reopened=new Store(f.store.directory,f.codec);assert.equal(accountProxyURL(reopened.read().accounts[0],reopened.proxyState()),a.url)
  f.apply({action:'disable'});assert.deepEqual(f.store.read().accounts,accountsBefore);assert.equal(accountProxyURL(base,f.store.proxyState()),undefined)
  assert.equal(accountProxyURL(resource,f.store.proxyState()),b.url)
})

test('resource edits/removal use fresh impact previews, stop affected users, preserve secrets and commit atomically',t=>{
  const f=fixture(t),a=f.add('Shared','http://fixture:old-secret@127.0.0.1:9876')
  f.apply({action:'enable',id:a.id,revision:0})
  const own={...f.get(),id:randomUUID(),proxy:{mode:'resource' as const,resourceId:a.id}},independent={...f.get(),id:randomUUID(),proxy:{mode:'custom' as const,url:'http://127.0.0.1:9888/'}}
  f.store.transaction(state=>state.accounts.push(own,independent))
  const before=f.store.read(),preview=f.service.preview({action:'update',id:a.id,revision:0,name:'Updated',url:'http://fixture:new-secret@127.0.0.1:9999'})
  assert.deepEqual(preview.affected.map(v=>v.id),[f.inherited.id,own.id])
  f.busy.add(f.inherited.id);assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/正在使用/);assert.deepEqual(f.store.read(),before)
  f.busy.clear();f.fail(true);assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/vault failure/);assert.deepEqual(f.store.read(),before)
  f.fail(false);f.service.apply({ticket:preview.ticket,confirmed:true});assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/过期/)
  assert.equal(accountProxyURL(f.get(),f.store.proxyState()),'http://fixture:new-secret@127.0.0.1:9999/')
  f.apply({action:'update',id:a.id,revision:1,name:'Renamed'});assert.equal(f.store.read().proxyResources![0].url,'http://fixture:new-secret@127.0.0.1:9999/')
  const deletion=f.service.preview({action:'remove',id:a.id,revision:2})
  assert.equal(deletion.disablesUnified,true);assert.equal(deletion.clearsBindings,1);assert.deepEqual(deletion.affected.map(v=>v.id),[f.inherited.id,own.id])
  f.service.apply({ticket:deletion.ticket,confirmed:true});assert.equal(f.store.read().unifiedProxy?.mode,'off')
  assert.equal(f.store.read().accounts.find(v=>v.id===own.id)!.proxy,undefined);assert.deepEqual(f.store.read().accounts.find(v=>v.id===independent.id),independent)
})

test('expired, discarded and changed-account previews cannot apply; corrupted shared settings never become direct',t=>{
  const f=fixture(t),a=f.add('Shared','http://127.0.0.1:9876'),change={action:'enable',id:a.id,revision:0}
  let preview=f.service.preview(change);f.advance();assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/过期/)
  preview=f.service.preview(change);f.service.discard(preview.ticket);assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/过期/)
  preview=f.service.preview(change);f.store.transaction(state=>state.accounts.push({...f.get(),id:randomUUID()}));assert.throws(()=>f.service.apply({ticket:preview.ticket,confirmed:true}),/变化/)
  f.apply(change)
  f.store.transaction(state=>{state.proxyResources![0].url='broken://fixture-secret'})
  assert.equal(f.store.snapshot().proxyResources?.unified.mode,'invalid');assert.equal(f.store.snapshot().accounts[0].egressProxy?.invalid,true)
  assert.throws(()=>accountProxyURL(f.get(),f.store.proxyState()))
  assert.equal(accountProxyURL({...f.get(),proxy:{mode:'direct'}},f.store.proxyState()),'direct')
  assert.equal(accountProxyURL({...f.get(),proxy:{mode:'custom',url:'http://127.0.0.1:9877'}},f.store.proxyState()),'http://127.0.0.1:9877/')
  assert.equal(accountProxyURL({...f.get(),kind:'api_key'},f.store.proxyState()),undefined)
  f.apply({action:'update',id:a.id,revision:0,name:'Repaired',url:'http://127.0.0.1:9878'})
  assert.equal(f.store.snapshot().proxyResources?.unified.mode,'all_accounts')
  f.store.transaction(state=>{state.unifiedProxy={mode:'all_accounts',resourceId:randomUUID()}})
  assert.throws(()=>accountProxyURL(f.get(),f.store.proxyState()))
  f.apply({action:'disable'});assert.equal(accountProxyURL(f.get(),f.store.proxyState()),undefined)
})

test('resource bindings and inherited probes follow actual HTTP exits, reject stale resources and distinguish managed from unmanaged native paths',async t=>{
  const f=fixture(t),seen:string[]=[]
  const target=await listen(t,createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);seen.push('direct');res.end('{"ip":"203.0.113.1"}')}))
  const proxy=await listen(t,createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:secret').toString('base64'));seen.push('proxy');res.end('{"ip":"203.0.113.2"}')}))
  const a=f.add('Shared',proxy.replace('://','://fixture:secret@'))
  f.apply({action:'enable',id:a.id,revision:0})
  const service=new AccountProxies(f.store,f.network,()=>false,target),requestId=()=>randomUUID()
  assert.equal((await service.probe({accountId:f.inherited.id,revision:0,requestId:requestId(),mode:'inherit'})).ip,'203.0.113.2')
  assert.equal((await f.network.request(target,{},'probe',f.get())).ip,'203.0.113.2')
  assert.equal((await f.network.request(target,{},'probe',{...f.get(),kind:'api_key'})).ip,'203.0.113.1')
  assert.equal((await service.probe({accountId:f.inherited.id,revision:0,requestId:requestId(),mode:'direct'})).ip,'203.0.113.1')
  assert.throws(()=>service.save({accountId:f.inherited.id,revision:0,mode:'resource',resourceId:a.id,resourceRevision:1}),/变化/)
  service.save({accountId:f.inherited.id,revision:0,mode:'resource',resourceId:a.id,resourceRevision:0})
  assert.equal((await service.probe({accountId:f.inherited.id,revision:1,requestId:requestId(),mode:'saved'})).ip,'203.0.113.2')
  assert.throws(()=>authFor(f.get(),null,f.store.proxyState()),/本地 API/)
  const native=new NativeInstanceAccounts(f.store,new TokenAuthority(f.store))
  assert.doesNotThrow(()=>native.validate({accountId:f.inherited.id} as never))
  service.save({accountId:f.inherited.id,revision:1,mode:'inherit'})
  assert.throws(()=>authFor(f.get(),null,f.store.proxyState()),/本地 API/)
  assert.doesNotThrow(()=>native.validate({accountId:f.inherited.id} as never))
  f.apply({action:'disable'})
  assert.equal((await service.probe({accountId:f.inherited.id,revision:2,requestId:requestId(),mode:'inherit'})).ip,'203.0.113.1')
  assert.deepEqual(seen,['proxy','proxy','direct','direct','proxy','direct'])
})

test('restoring an account whose resource was deleted keeps a visible invalid binding until explicitly repaired',async t=>{
  const f=fixture(t),resource=f.add('Original','http://127.0.0.1:9876')
  f.accounts.save({accountId:f.inherited.id,revision:0,mode:'resource',resourceId:resource.id,resourceRevision:0})
  deleteAccounts(f.store,[f.inherited.id]);f.apply({action:'remove',id:resource.id,revision:0})
  const recycle=new AccountRecycle(f.store),snapshot=recycle.list(),preview=recycle.preview({snapshotId:snapshot.snapshotId,all:true,action:'restore'})
  await recycle.apply({ticket:preview.ticket,confirmed:true},async()=>undefined)
  assert.equal(f.store.snapshot().accounts[0].egressProxy?.invalid,true)
  assert.throws(()=>accountProxyURL(f.get(),f.store.proxyState()),/不存在/)
  f.accounts.save({accountId:f.get().id,revision:f.get().revision!,mode:'inherit'})
  assert.equal(accountProxyURL(f.get(),f.store.proxyState()),undefined)
})

test('real sidecar single/pool and credential reload consume unified/independent proxies and preserve Fast on the wire',{timeout:90000},async t=>{
  const f=fixture(t),certificate=join(f.root,'cert.pem'),key=join(f.root,'key.pem'),config=join(f.root,'openssl.cnf')
  writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=chatgpt.com\n[ext]\nsubjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',certificate,'-config',config],{stdio:'ignore',timeout:10000})
  const seen:{tier?:string;auth?:string}[]=[],sessions=new Set<import('node:http2').ServerHttp2Session>(),sockets=new Set<import('node:stream').Duplex>()
  let cleanupGateway:Gateway|undefined
  const upstream=createSecureServer({allowHTTP1:true,key:readFileSync(key),cert:readFileSync(certificate)},async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    assert.equal(req.headers['proxy-authorization'],undefined);seen.push({tier:JSON.parse(body).service_tier,auth:req.headers.authorization as string|undefined})
    res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'resp-fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})+'\n\n')
  })
  // A build error after listen must still release the upstream and CONNECT
  // connections, so the worker can report the failure and exit.
  t.after(async()=>{
    try{await cleanupGateway?.stop()}
    finally{
      for(const socket of sockets)socket.destroy()
      for(const session of sessions)session.destroy()
      upstream.close()
    }
  })
  upstream.on('session',session=>{sessions.add(session);session.on('close',()=>sessions.delete(session))})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  const proxyHits:string[]=[]
  async function proxy(name:string){
    const server=createServer((_req,res)=>{res.writeHead(502);res.end()})
    server.on('connect',(req,socket,head)=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket))
      if(req.url!=='chatgpt.com:443'||req.headers['proxy-authorization']!=='Basic '+Buffer.from('fixture:'+name).toString('base64')){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');return}
      proxyHits.push(name)
      const local=connect(address.port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)local.write(head);socket.pipe(local).pipe(socket)})
      sockets.add(local);local.on('close',()=>sockets.delete(local));local.on('error',()=>socket.destroy());socket.on('error',()=>local.destroy())
    })
    return (await listen(t,server)).replace('://',`://fixture:${name}@`)
  }
  const a=f.add('A',await proxy('a')),b=f.add('B',await proxy('b')),testBinary=join(f.root,'proxy-fixture'),wrapper=join(f.root,'runtime.cjs')
  execFileSync('go',['test','-c','-o',testBinary],{cwd:resolve('sidecars/codex-proxy'),stdio:'pipe',timeout:90000})
  // Only install an ephemeral trust root in the existing test-only Go entry.
  // Its required global proxy points at a closed loopback port: missing account
  // projection cannot pass by accidentally using the same default proxy.
  writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const args=process.argv.slice(2),file=args[args.indexOf('-config')+1];const config=JSON.parse(fs.readFileSync(file));config['proxy-url']='http://127.0.0.1:1';fs.writeFileSync(file,JSON.stringify(config));const child=spawn(${JSON.stringify(testBinary)},['-test.run=^TestNativeAuthorityFixture$','-test.timeout=40s'],{stdio:'inherit',env:{...process.env,CML_AUTHORITY_FIXTURE_CERT:${JSON.stringify(certificate)},CML_AUTHORITY_FIXTURE_ARGS:JSON.stringify(args)}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));`,{mode:0o700})
  const gateway=new Gateway(wrapper,join(f.root,'runtime'),undefined,undefined,()=>f.store.proxyState())
  cleanupGateway=gateway
  const resources=new ProxyResources(f.store,id=>gateway.usesAccount(id))
  const enable=(resource:typeof a)=>{const p=resources.preview({action:'enable',id:resource.id,revision:resource.revision});resources.apply({ticket:p.ticket,confirmed:true})}
  const call=async(tier?:string,stream=false)=>{
    const response=await fetch(`http://127.0.0.1:${gateway.current().port}/v1/responses`,{method:'POST',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer fixture-downstream','Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.5',input:'fixture',service_tier:tier,stream})})
    assert.equal(response.status,200,await response.text())
  }
  enable(a);await gateway.start({id:f.inherited.id,port:0,account:f.get(),apiKey:'fixture-downstream'},settingsSchema.parse({defaultTier:'fast'}));await call()
  const pending=resources.preview({action:'enable',id:b.id,revision:0});assert.equal(pending.busy.length,1);assert.throws(()=>resources.apply({ticket:pending.ticket,confirmed:true}),/正在使用/)
  await gateway.stop();resources.apply({ticket:pending.ticket,confirmed:true})
  await gateway.start({id:f.inherited.id,port:0,account:f.get(),apiKey:'fixture-downstream'},settingsSchema.parse({defaultTier:'fast'}));await call('default',true);await gateway.stop()
  f.accounts.save({accountId:f.inherited.id,revision:0,mode:'resource',resourceId:a.id,resourceRevision:0})
  f.store.transaction(state=>{state.settings.port=16321;state.settings.defaultTier='fast';state.localAccess={...emptyLocalAccess(),accountIds:[f.inherited.id],keys:[{id:randomUUID(),revision:0,createdAt:Date.now(),label:'Fixture',enabled:true,inheritAccountPool:true,accountIds:[],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0,key:'fixture-downstream'}]}})
  // The existing Gateway allocator permits zero; avoid fixed-port collisions.
  const state=f.store.read();await gateway.start({id:'pool',port:0,account:f.get(),apiKey:'',pool:{settings:state.localAccess!,accounts:[f.get()],providerTiers:{},tokenUsed:{}}},state.settings)
  const off=resources.preview({action:'disable'});assert.equal(off.affected.length,0);resources.apply({ticket:off.ticket,confirmed:true})
  await call(undefined,true)
  f.store.transaction(state=>{state.accounts[0].credentials.accessToken='at-rotated-fixture'})
  await gateway.updateCredentials(f.get());await call('flex')
  assert.deepEqual(seen.map(v=>v.tier),['priority','default','priority','flex'])
  assert.deepEqual(seen.map(v=>v.auth),['Bearer at-unified-fixture','Bearer at-unified-fixture','Bearer at-unified-fixture','Bearer at-rotated-fixture'])
  assert.ok(proxyHits.includes('a')&&proxyHits.includes('b'));assert.equal(accountProxyView(f.get(),f.store.proxyState())?.source,'account')
})
