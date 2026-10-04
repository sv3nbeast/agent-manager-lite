import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {createSecureServer as createTLSUpstream} from 'node:http2'
import {connect} from 'node:net'
import {execFileSync} from 'node:child_process'
import {Store,type StoredAccount} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {ClientIdentities} from '../src/main/clientIdentity'
import {ClientAuthority} from '../src/main/clientAuthority'
import {TokenAuthority} from '../src/main/tokens'
import {importParsedAccounts,parseAccountImport,saveOAuthAccount} from '../src/main/accounts'
import {Gateway} from '../src/main/gateway'
import {settingsSchema} from '../src/shared/types'

function auth(generation='first',lifetime=3600,workspace='workspace-fixture'){
  const token='fixture.'+Buffer.from(JSON.stringify({generation,exp:Math.floor(Date.now()/1000)+lifetime,email:'native@example.invalid',
    'https://api.openai.com/auth':{chatgpt_account_id:workspace,chatgpt_user_id:'user-fixture',chatgpt_plan_type:'plus'}})).toString('base64url')+'.signature'
  return JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,id_token:token,refresh_token:'fixture-rt-'+generation,account_id:workspace}})
}
function fixture(t:{after(fn:()=>void|Promise<void>):void},project:(account:StoredAccount)=>void|Promise<void>=()=>{},beforeEncrypt:()=>void=()=>{}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-authority-'))),client=join(root,'client');mkdirSync(client)
  const store=new Store(join(root,'vault'),{encrypt:value=>{beforeEncrypt();return Buffer.from(value)},decrypt:value=>value.toString()})
  const configs=new ClientConfigs(store),target=configs.register(client)
  const identities=new ClientIdentities(store,configs,async()=>{assert.fail('No system credential access')})
  let refreshes=0
  const tokens=new TokenAuthority(store,async()=>{refreshes++;assert.fail('A client-owned refresh token must not be rotated by the manager')})
  const service=new ClientAuthority(store,configs,identities,tokens,project)
  const file=join(client,'auth.json'),config=join(client,'config.toml')
  writeFileSync(config,'# preserve this\ncli_auth_credentials_store="file"\nservice_tier="fast"\n')
  writeFileSync(file,auth());importParsedAccounts(store,parseAccountImport(auth()).accounts)
  const accountId=store.read().accounts[0].id
  const bind=async()=>service.bind({ticket:(await identities.read({id:target.id})).ticket!,accountId})
  t.after(async()=>{await tokens.stop();await service.stop();identities.stop();rmSync(root,{recursive:true,force:true})})
  return {root,client,store,configs,target,identities,tokens,service,file,config,accountId,bind,refreshes:()=>refreshes}
}

test('inherited proxy cannot silently become an unproxied native refresh authority',async t=>{
  const f=fixture(t),before=readFileSync(f.file,'utf8')
  f.store.transaction(state=>{state.proxyResources=[{id:'fixture-resource',revision:0,name:'Shared',url:'http://127.0.0.1:9876/'}];state.unifiedProxy={mode:'all_accounts',resourceId:'fixture-resource'}})
  await assert.rejects(f.bind(),/本地 API/)
  assert.equal(f.service.views().length,0);assert.equal(readFileSync(f.file,'utf8'),before)
  f.store.transaction(state=>{state.unifiedProxy={mode:'off'}})
  await f.bind();assert.equal(f.service.views().length,1)
})

test('file authority adopts client rotations, projects after save, coalesces calls and never rotates the copied RT',async t=>{
  let f:ReturnType<typeof fixture>,projects=0
  f=fixture(t,account=>{projects++;assert.equal(f.store.read().accounts[0].credentials.accessToken,account.credentials.accessToken)})
  const originalConfig=readFileSync(f.config,'utf8');await f.bind()
  const first=f.store.read().accounts[0].credentials.accessToken!
  writeFileSync(f.file,auth('second',7200))
  const a=f.tokens.ensure(f.accountId),b=f.tokens.ensure(f.accountId);assert.equal(a,b)
  const updated=await a;assert.equal(updated.credentials.refreshToken,'fixture-rt-second')
  assert.equal((await f.tokens.ensure(f.accountId,{force:true,rejectedToken:first})).credentials.accessToken,updated.credentials.accessToken)
  await assert.rejects(f.tokens.ensure(f.accountId,{force:true,rejectedToken:updated.credentials.accessToken}),/客户端凭据被上游拒绝/)
  assert.equal(f.refreshes(),0);assert.ok(projects>=3)
  assert.equal(readFileSync(f.file,'utf8'),auth('second',7200));assert.equal(readFileSync(f.config,'utf8'),originalConfig)
  const view=JSON.stringify(f.service.views());assert.equal(view.includes('fixture-rt-'),false);assert.equal(view.includes(updated.credentials.accessToken!),false)
  const reopened=new Store(f.store.directory,{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()})
  const restarted=new TokenAuthority(reopened,async()=>{assert.fail('Must not refresh before external resolver is ready')})
  await assert.rejects(restarted.ensure(f.accountId),/尚未就绪/)
  const configs=new ClientConfigs(reopened),identities=new ClientIdentities(reopened,configs)
  const service=new ClientAuthority(reopened,configs,identities,restarted)
  assert.equal((await restarted.ensure(f.accountId)).credentials.refreshToken,'fixture-rt-second')
  await restarted.stop();await service.stop()
})

test('logout, stale snapshots, mismatched workspaces and storage changes fail closed and retain library tokens',async t=>{
  const f=fixture(t);await f.bind();const retained=f.store.read().accounts[0].credentials
  for(const value of [auth('other',7200,'wrong-workspace'),auth('old',1),'{"tokens":"fixture-private"}']){
    writeFileSync(f.file,value)
    await assert.rejects(f.tokens.ensure(f.accountId))
    assert.deepEqual(f.store.read().accounts[0].credentials,retained)
  }
  writeFileSync(f.file,auth());writeFileSync(f.config,'cli_auth_credentials_store="keyring"\n')
  await assert.rejects(f.tokens.ensure(f.accountId),/不会自动读取系统/)
  writeFileSync(f.config,'');rmSync(f.file)
  await assert.rejects(f.tokens.ensure(f.accountId),/退出登录/)
  assert.equal(f.refreshes(),0);assert.equal(JSON.stringify(f.service.views()).includes('fixture-private'),false)
})

test('an expired client-owned token waits for the client and cannot use the manager refresh path',async t=>{
  const f=fixture(t);writeFileSync(f.file,auth('expired',-100))
  f.store.transaction(state=>{state.accounts[0].credentials=parseAccountImport(auth('expired',-100)).accounts[0].credentials})
  await f.bind();await assert.rejects(f.tokens.ensure(f.accountId),/等待客户端刷新/)
  assert.match(f.service.views()[0].error!,/等待客户端刷新/)
  writeFileSync(f.file,auth('recovered',7200));assert.equal((await f.tokens.ensure(f.accountId)).credentials.refreshToken,'fixture-rt-recovered')
  assert.equal(f.service.views()[0].error,undefined)
  assert.equal(f.refreshes(),0)
})

test('projection failure keeps durable ownership and rotated credentials and retries without re-reading system storage',async t=>{
  let fail=true
  const f=fixture(t,()=>{if(fail)throw new Error('fixture projection failed')})
  await f.bind();assert.match(f.service.views()[0].error!,/尚未同步/)
  writeFileSync(f.file,auth('new',7200))
  await assert.rejects(f.tokens.ensure(f.accountId),/尚未同步/)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-rt-new')
  assert.equal(f.store.read().clientAuthorities?.length,1)
  fail=false;await f.tokens.ensure(f.accountId);assert.equal(f.service.views()[0].error,undefined)
})

test('fresh preview, unique ownership and strong identity are required; replacing a registered directory cannot redirect sync',async t=>{
  const f=fixture(t),view=await f.identities.read({id:f.target.id})
  writeFileSync(f.file,auth('changed',7200))
  await assert.rejects(f.service.bind({ticket:view.ticket,accountId:f.accountId}),/已变化/)
  await f.bind();await assert.rejects(f.bind(),/已有关联/)
  const other=join(f.root,'other');mkdirSync(other);writeFileSync(join(other,'auth.json'),auth('changed',7200))
  const target=f.configs.register(other),next=await f.identities.read({id:target.id})
  await assert.rejects(f.service.bind({ticket:next.ticket,accountId:f.accountId}),/已有关联/)
  renameSync(f.client,f.client+'-previous');mkdirSync(f.client);writeFileSync(f.file,auth('redirected',9000))
  await assert.rejects(f.tokens.ensure(f.accountId),/已被替换/)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken,'fixture-rt-changed')
})

test('release requires explicit client closure and evidence that the original login is no longer present',async t=>{
  const f=fixture(t);await f.bind()
  assert.throws(()=>f.service.release({targetId:f.target.id,clientClosed:false}))
  assert.throws(()=>f.service.release({targetId:f.target.id,clientClosed:true}),/退出此账号/)
  assert.throws(()=>saveOAuthAccount(f.store,{...f.store.read().accounts[0].credentials}),/由客户端维护/)
  rmSync(f.file);assert.deepEqual(f.service.release({targetId:f.target.id,clientClosed:true}),[])
  assert.equal(f.store.read().clientAuthorities?.length,0)
  assert.equal((await f.tokens.ensure(f.accountId)).credentials.refreshToken,'fixture-rt-first')
})

test('a refresh already in flight must settle before an external client can become the authority',async t=>{
  const f=fixture(t);let finish!:(value:Record<string,unknown>)=>void
  const tokens=new TokenAuthority(f.store,async()=>new Promise(resolve=>{finish=resolve}))
  const service=new ClientAuthority(f.store,f.configs,f.identities,tokens)
  const inFlight=tokens.ensure(f.accountId,{force:true})
  await assert.rejects(service.bind({ticket:(await f.identities.read({id:f.target.id})).ticket,accountId:f.accountId}),/正在刷新/)
  const next=JSON.parse(auth('rotated',7200)).tokens;finish(next);await inFlight
  const preview=await f.identities.read({id:f.target.id})
  await assert.rejects(service.bind({ticket:preview.ticket,accountId:f.accountId}),/早于账号库/)
  assert.equal(f.store.read().clientAuthorities?.length??0,0)
  await tokens.stop();await service.stop()
})

test('client rotations reach the real sidecar and loopback TLS upstream while Fast and explicit Standard remain intact',async t=>{
  let gateway:Gateway|undefined
  const f=fixture(t,account=>gateway?.updateCredentials(account))
  const certificate=join(f.root,'fixture-cert.pem'),key=join(f.root,'fixture-key.pem'),opensslConfig=join(f.root,'fixture-openssl.cnf')
  writeFileSync(opensslConfig,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=chatgpt.com\n[ext]\nsubjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',certificate,'-config',opensslConfig],{stdio:'ignore',timeout:10000})
  const seen:{authorization:string|undefined;tier:unknown}[]=[]
  const sessions=new Set<import('node:http2').ServerHttp2Session>()
  const sockets=new Set<import('node:stream').Duplex>()
  const runtimeRoot=mkdtempSync(join(tmpdir(),'cml-authority-runtime-'))
  let cleanupProxy:ReturnType<typeof createServer>|undefined
  const upstream=createTLSUpstream({allowHTTP1:true,key:readFileSync(key),cert:readFileSync(certificate)},async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    seen.push({authorization:typeof req.headers.authorization==='string'?req.headers.authorization:undefined,tier:JSON.parse(body).service_tier})
    res.setHeader('Content-Type','text/event-stream')
    res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'resp-fixture',object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})+'\n\n')
  })
  // Register before listening or compiling: a failed cold Go build must not
  // leave this test worker alive through its loopback listeners.
  t.after(async()=>{
    try{await gateway?.stop()}
    finally{
      for(const socket of sockets)socket.destroy()
      for(const session of sessions)session.destroy()
      upstream.close();cleanupProxy?.closeAllConnections();cleanupProxy?.close()
      rmSync(runtimeRoot,{recursive:true,force:true})
    }
  })
  upstream.on('session',session=>{sessions.add(session);session.on('close',()=>sessions.delete(session))})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  // CONNECT is terminated only by our loopback TLS fixture. No request is
  // forwarded to the requested hostname; the trust root is scoped to this child.
  const proxy=createServer((_req,res)=>{res.writeHead(502);res.end()})
  cleanupProxy=proxy
  proxy.on('connect',(req,socket,head)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket))
    if(req.url!=='chatgpt.com:443'){socket.destroy();return}
    const local=connect(address.port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)local.write(head);socket.pipe(local).pipe(socket)})
    sockets.add(local);local.on('close',()=>sockets.delete(local));local.on('error',()=>socket.destroy());socket.on('error',()=>local.destroy())
  })
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyAddress=proxy.address();assert.ok(proxyAddress&&typeof proxyAddress==='object')
  const wrapper=join(f.root,'loopback-runtime.cjs'),binary=join(f.root,'codex-proxy-fixture')
  execFileSync('go',['test','-c','-o',binary],{cwd:resolve('sidecars/codex-proxy'),stdio:'pipe',timeout:90000})
  writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const args=process.argv.slice(2),path=args[args.indexOf('-config')+1];const config=JSON.parse(fs.readFileSync(path,'utf8'));config['proxy-url']=${JSON.stringify(`http://127.0.0.1:${proxyAddress.port}`)};fs.writeFileSync(path,JSON.stringify(config));const child=spawn(${JSON.stringify(binary)},['-test.run=^TestNativeAuthorityFixture$','-test.timeout=30s'],{stdio:'inherit',env:{...process.env,CML_AUTHORITY_FIXTURE_CERT:${JSON.stringify(certificate)},CML_AUTHORITY_FIXTURE_ARGS:JSON.stringify(args)}});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));`,{mode:0o700})
  await f.bind()
  gateway=new Gateway(wrapper,runtimeRoot)
  const initial=await f.tokens.ensure(f.accountId)
  const status=await gateway.start({id:initial.id,port:0,account:initial,apiKey:'fixture-downstream'},settingsSchema.parse({defaultTier:'fast'}))
  const call=async(tier?:string)=>{
    const response=await fetch(`http://127.0.0.1:${status.port}/v1/responses`,{method:'POST',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer fixture-downstream','Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.5',input:'fixture',service_tier:tier})})
    assert.equal(response.status,200,await response.text())
  }
  await call();writeFileSync(f.file,auth('live',7200));const updated=await f.tokens.ensure(f.accountId);await call('default')
  assert.deepEqual(seen,[{authorization:`Bearer ${initial.credentials.accessToken}`,tier:'priority'},{authorization:`Bearer ${updated.credentials.accessToken}`,tier:'default'}])
  assert.equal(f.refreshes(),0)
})


test('vault write failure cannot transfer refresh ownership or publish credentials',async t=>{
  let fail=false,projects=0
  const f=fixture(t,()=>{projects++},()=>{if(fail)throw new Error('fixture encryption denied')})
  const before=f.store.read(),client=readFileSync(f.file,'utf8');fail=true
  await assert.rejects(f.bind(),/encryption denied/)
  assert.deepEqual(f.store.read(),before);assert.equal(projects,0);assert.equal(readFileSync(f.file,'utf8'),client)
  fail=false;await f.bind();assert.equal(projects,1);assert.equal(f.service.views().length,1)
})

test('auto fallback and active instance directories cannot silently become file-owned links',async t=>{
  const f=fixture(t);writeFileSync(f.config,'cli_auth_credentials_store="auto"\n')
  let systemReads=0
  const identities=new ClientIdentities(f.store,f.configs,async()=>{systemReads++;return null})
  const preview=await identities.read({id:f.target.id,includeKeyring:true});assert.equal(preview.source,'file')
  const service=new ClientAuthority(f.store,f.configs,identities,f.tokens)
  await assert.rejects(service.bind({ticket:preview.ticket,accountId:f.accountId}),/明确使用 file/)
  assert.equal(systemReads,1);assert.equal(f.store.read().clientAuthorities,undefined)
  writeFileSync(f.config,'')
  const running=new ClientAuthority(f.store,f.configs,f.identities,f.tokens,()=>{},()=>true)
  await assert.rejects(running.bind({ticket:(await f.identities.read({id:f.target.id})).ticket,accountId:f.accountId}),/停止此受管实例/)
  assert.equal(f.store.read().clientAuthorities,undefined)
})

test('ownership cannot be released while its first runtime projection is still pending',async t=>{
  let finish!:()=>void
  const f=fixture(t,()=>new Promise<void>(resolve=>{finish=resolve}))
  const binding=f.bind()
  for(let tries=0;!finish&&tries<10;tries++)await new Promise(resolve=>setImmediate(resolve))
  assert.ok(finish);rmSync(f.file)
  assert.throws(()=>f.service.release({targetId:f.target.id,clientClosed:true}),/正在同步/)
  finish();await binding
  assert.deepEqual(f.service.release({targetId:f.target.id,clientClosed:true}),[])
})

test('a concurrent ordinary sync cannot swallow a 401 for the same client-owned access token',async t=>{
  let hold=false,finish!:()=>void
  const f=fixture(t,()=>hold?new Promise<void>(resolve=>{finish=resolve}):undefined)
  await f.bind();hold=true
  const ordinary=f.tokens.ensure(f.accountId)
  for(let tries=0;!finish&&tries<10;tries++)await new Promise(resolve=>setImmediate(resolve))
  assert.ok(finish)
  const forced=f.tokens.ensure(f.accountId,{force:true,rejectedToken:f.store.read().accounts[0].credentials.accessToken})
  const rejected=assert.rejects(forced,/上游拒绝/)
  finish();await ordinary;await rejected;assert.equal(f.refreshes(),0)
})
