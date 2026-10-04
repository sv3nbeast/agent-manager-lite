import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {Store} from '../src/main/store'
import {createAPIAccount,parseAccountImport} from '../src/main/accounts'
import {Gateway} from '../src/main/gateway'
import {AccountNetwork} from '../src/main/accountNetwork'
import {mutateProvider} from '../src/main/providerLibrary'
import {ProviderModels} from '../src/main/providerModels'
import {ProviderProbes} from '../src/main/providerProbe'
import {ProviderUsageQueries} from '../src/main/providerUsageRefresh'
import {providerNetworkTarget} from '../src/main/providerNetworkTarget'

const build=mkdtempSync(join(tmpdir(),'aml-provider-proxy-build-')),binary=join(build,'proxy')
execFileSync('go',['build','-o',binary,'.'],{cwd:resolve('sidecars/codex-proxy'),stdio:'pipe',timeout:60000})
after(()=>rmSync(build,{recursive:true,force:true}))
type Context={after(fn:()=>void|Promise<void>):void}
async function server(t:Context,handler:(req:IncomingMessage,res:ServerResponse)=>void) {
  const listener=createServer(handler);await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done))
  t.after(async()=>{listener.closeAllConnections();await new Promise<void>(done=>listener.close(()=>done()))})
  return `http://127.0.0.1:${(listener.address() as {port:number}).port}`
}
function fixture(t:Context) {
  const root=mkdtempSync(join(tmpdir(),'aml-provider-proxy-')),store=new Store(root,{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()})
  const network=new AccountNetwork(binary,()=>store.proxyState()),gateways:Gateway[]=[]
  const gateway=()=>{const value=new Gateway(binary,join(root,'runtime'),undefined,undefined,()=>store.proxyState());gateways.push(value);return value}
  t.after(async()=>{await Promise.all(gateways.map(value=>value.stop()));await network.stop();rmSync(root,{recursive:true,force:true})})
  return {root,store,network,gateway}
}
const response=()=>({id:'resp_fixture',status:'completed',service_tier:'priority',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'代理成功'}]}],usage:{input_tokens:3,output_tokens:2}})
async function conversation(port:number,key:string) {
  const reply=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'fixture-model',input:'hi',stream:false,service_tier:'priority'})})
  return {status:reply.status,body:await reply.json()}
}

test('the source-built gateway projects the API route and sends Fast through the real authenticated HTTP proxy',async t=>{
  const f=fixture(t),seen:Array<{url?:string;authorization?:string;tier?:string}>=[]
  const proxy=await server(t,(req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    seen.push({url:req.url,authorization:req.headers.authorization,tier:JSON.parse(raw).service_tier})
    assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('proxy-user:proxy-pass').toString('base64'))
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response()))
  })})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:proxy.replace('://','://proxy-user:proxy-pass@')}})
  const account=createAPIAccount({name:'API',apiKey:'fixture-upstream-key',baseUrl:'http://provider.invalid/v1',models:['fixture-model'],wireApi:'responses'})
  const gateway=f.gateway(),status=await gateway.start({id:randomUUID(),port:0,account,apiKey:'fixture-client-key'},f.store.read().settings)
  const manifest=JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'manifest.json'),'utf8'))
  assert.equal(manifest.apiKeys[0].providerGateway.proxyUrl,f.store.proxyState().upstreamProxy!.url+'/')
  const reply=await conversation(status.port!,'fixture-client-key')
  assert.equal(reply.status,200);assert.match(JSON.stringify(reply.body),/代理成功/)
  assert.deepEqual(seen,[{url:'http://provider.invalid/v1/responses',authorization:'Bearer fixture-upstream-key',tier:'priority'}])
})

test('a failed API proxy returns an error without reaching a reachable direct upstream',async t=>{
  const f=fixture(t);let direct=0
  const target=await server(t,(_req,res)=>{direct++;res.end(JSON.stringify(response()))})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:'http://127.0.0.1:1'}})
  const account=createAPIAccount({name:'API',apiKey:'fixture-key',baseUrl:target+'/v1',models:['fixture-model'],wireApi:'responses'})
  const status=await f.gateway().start({id:randomUUID(),port:0,account,apiKey:'fixture-client-key'},f.store.read().settings)
  const reply=await conversation(status.port!,'fixture-client-key')
  assert.ok(reply.status>=400);assert.equal(direct,0)
})

test('OAuth and Agent Identity auth projections retain the selected upstream proxy',async t=>{
  const f=fixture(t),proxy='http://127.0.0.1:1/'
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:proxy}})
  const privateKey=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64')
  const accounts=parseAccountImport(JSON.stringify([{access_token:'at-fixture-proxy-pat'},
    {agent_identity:{agent_runtime_id:'fixture-runtime',agent_private_key:privateKey,account_id:'fixture-org',chatgpt_user_id:'fixture-user',chatgpt_account_is_fedramp:true,task_id:'fixture-task'}}])).accounts
  assert.equal(accounts.length,2)
  for(const account of accounts){
    const gateway=f.gateway();await gateway.start({id:randomUUID(),port:0,account,apiKey:'fixture-client'},f.store.read().settings)
    const auth=JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',account.id+'.json'),'utf8'))
    assert.equal(auth.proxy_url,proxy)
    await gateway.stop()
  }
})

test('draft model discovery uses the global proxy while saved-key discovery honors the linked direct override',async t=>{
  const f=fixture(t);let proxied=0,direct=0
  const proxy=await server(t,(_req,res)=>{proxied++;res.end(JSON.stringify({data:[{id:'global-model'}]}))})
  const target=await server(t,(_req,res)=>{direct++;res.end(JSON.stringify({data:[{id:'direct-model'}]}))})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:proxy}})
  mutateProvider(f.store,{action:'create',details:{name:'Provider',baseUrl:target+'/v1',models:['fixture-model'],wireApi:'responses'},initialKey:{name:'Key',apiKey:'fixture-key',createConnection:true}})
  f.store.transaction(state=>{state.accounts[0].proxy={mode:'direct'}})
  const provider=f.store.read().providers![0],key=provider.keys[0]
  const models=new ProviderModels(f.store,3000,f.network.fetchUpstream);t.after(()=>models.stop())
  assert.deepEqual((await models.fetch({requestId:randomUUID(),baseUrl:target+'/v1',apiKey:'draft-key'})).models.map(model=>model.id),['global-model'])
  assert.deepEqual((await models.fetch({requestId:randomUUID(),baseUrl:target+'/v1',savedKey:{providerId:provider.id,keyId:key.id,revision:provider.revision}})).models.map(model=>model.id),['direct-model'])
  assert.equal(proxied,1);assert.equal(direct,1)
})

test('provider models, usage, model probes and chat probes share the actual linked account proxy',async t=>{
  const f=fixture(t),paths:string[]=[];let globalHits=0
  const global=await server(t,(_req,res)=>{globalHits++;res.end('{}')})
  const proxy=await server(t,(req,res)=>{paths.push(new URL(req.url!).pathname);res.setHeader('Content-Type','application/json')
    if(req.url!.endsWith('/models'))res.end(JSON.stringify({data:[{id:'fixture-model'}]}))
    else if(req.url!.endsWith('/usage'))res.end(JSON.stringify({remaining:25,unit:'USD'}))
    else{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{assert.equal(JSON.parse(raw).service_tier,'priority');res.end(JSON.stringify(response()))})}
  })
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:global}})
  mutateProvider(f.store,{action:'create',details:{name:'Provider',baseUrl:'http://provider.invalid/v1',models:['fixture-model'],wireApi:'responses',integrationType:'sub2api'},initialKey:{name:'Key',apiKey:'fixture-key',createConnection:true}})
  f.store.transaction(state=>{state.accounts[0].proxy={mode:'custom',url:proxy}})
  const provider=f.store.read().providers![0],key=provider.keys[0],target={providerId:provider.id,keyId:key.id,revision:provider.revision}
  const models=new ProviderModels(f.store,3000,f.network.fetchUpstream),usage=new ProviderUsageQueries(f.store,f.network.request)
  const probes=new ProviderProbes(f.store,binary,join(f.root,'probes'),{models:3000,chat:5000},f.network.fetchUpstream,()=>f.store.proxyState())
  t.after(async()=>{await models.stop();await usage.stop();await probes.stop()})
  await models.fetch({requestId:randomUUID(),baseUrl:provider.baseUrl,savedKey:target})
  usage.start({providerId:provider.id,revision:provider.revision,keyIds:[key.id]});await usage.settled();assert.equal(usage.snapshot().failed,0)
  probes.start({mode:'models',targets:[target]});await probes.settled();assert.equal(probes.snapshot().succeeded,1,JSON.stringify(probes.snapshot()))
  probes.start({mode:'chat',targets:[target],serviceTier:'priority'});await probes.settled();assert.equal(probes.snapshot().succeeded,1,JSON.stringify(probes.snapshot()))
  assert.equal(f.store.read().providers![0].keys[0].usage?.summary?.remaining,25)
  assert.deepEqual(paths,['/v1/models','/v1/usage','/v1/models','/v1/responses']);assert.equal(globalHits,0)
  assert.equal(f.store.read().accounts.length,1)
})

test('mismatched or ambiguous linked accounts cannot silently choose a route by display name',t=>{
  const f=fixture(t)
  mutateProvider(f.store,{action:'create',details:{name:'Provider',baseUrl:'http://provider.invalid/v1',models:['fixture-model'],wireApi:'responses'},initialKey:{name:'Key',apiKey:'fixture-key',createConnection:true}})
  const state=f.store.read(),provider=state.providers![0],key=provider.keys[0]
  const bad={...state.accounts[0],credentials:{apiKey:'different-key'}}
  assert.throws(()=>providerNetworkTarget({accounts:[bad]},provider,key),/关联已变化/)
  assert.throws(()=>providerNetworkTarget({accounts:[state.accounts[0],{...state.accounts[0],id:randomUUID()}]},provider,key),/多个账号/)
  const fallback=providerNetworkTarget({accounts:[{...state.accounts[0],providerId:undefined,providerKeyId:undefined}]},provider,key)
  assert.equal(fallback.proxy,undefined);assert.equal(fallback.id,key.id)
})
