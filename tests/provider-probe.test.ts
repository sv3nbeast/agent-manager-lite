import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/main/store'
import { mutateProvider } from '../src/main/providerLibrary'
import { ProviderProbes, selectProbeModel } from '../src/main/providerProbe'
import { settingsSchema } from '../src/shared/types'
import { Gateway } from '../src/main/gateway'
import { createAPIAccount } from '../src/main/accounts'

type Context = {after(fn:()=>void|Promise<void>):void}
const binary=resolve('resources/bin/codex-proxy')
async function server(t:Context,handler:RequestListener) {
  const http=createServer(handler)
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()))})
  const address=http.address();assert.ok(address && typeof address==='object')
  return {url:`http://127.0.0.1:${address.port}`,http}
}
function fixture(t:Context,timeouts={models:2000,chat:5000}) {
  const root=mkdtempSync(join(tmpdir(),'cml-probe-'))
  const store=new Store(join(root,'vault'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()})
  const runtime=join(root,'probes'),probes=new ProviderProbes(store,binary,runtime,timeouts)
  t.after(async()=>{await probes.stop();rmSync(root,{recursive:true,force:true})})
  function add(baseUrl:string,wireApi='responses',apiKey='fixture-probe-secret') {
    mutateProvider(store,{action:'create',details:{name:'Fixture',baseUrl,wireApi,models:['fixture-model'],defaultTier:'fast'}})
    const provider=store.read().providers!.at(-1)!
    mutateProvider(store,{action:'addKey',id:provider.id,revision:provider.revision,name:'Fixture key',apiKey})
    return target(provider.id)
  }
  function target(id:string) {const provider=store.read().providers!.find(p=>p.id===id)!;return {providerId:id,revision:provider.revision,keyId:provider.keys[0].id}}
  return {root,store,runtime,probes,add,target}
}
async function until(condition:()=>boolean) {
  const end=Date.now()+3000
  while(!condition()){if(Date.now()>end)throw new Error('fixture wait timed out');await new Promise(resolve=>setTimeout(resolve,5))}
}

test('connection probe validates model lists, preserves case, redacts credential echoes and never changes the vault',async t=>{
  const seen:string[]=[]
  const upstream=await server(t,(req,res)=>{
    seen.push(req.url!)
    assert.equal(req.headers.authorization,'Bearer fixture-probe-secret')
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({data:[{id:'Model-A',display_name:'Nice'},{id:'model-a'},{id:'Model-A'},{id:'fixture-probe-secret'},{id:'safe',displayName:'echo fixture-probe-secret'}]}))
  })
  const f=fixture(t),target=f.add(upstream.url+'/Team/v1'),before=f.store.read()
  f.probes.start({mode:'models',targets:[target]});await f.probes.settled()
  const result=f.probes.snapshot()
  assert.deepEqual(seen,['/Team/v1/models'])
  assert.equal(result.succeeded,1);assert.equal(result.completed,1)
  assert.deepEqual(result.records[0].models?.map(model=>model.id),['Model-A','model-a','safe'])
  assert.equal(JSON.stringify(result).includes('fixture-probe-secret'),false)
  assert.deepEqual(f.store.read(),before)
  assert.equal(existsSync(f.runtime),false)
  assert.equal(selectProbeModel(['custom-vendor/Model-A','gpt-5.6-luna'],'responses'),'custom-vendor/Model-A')
  assert.equal(selectProbeModel(['first'],'responses','explicit'),'explicit')
})

test('connection failures are bounded and classified; redirects never receive credentials',async t=>{
  let redirected=0
  const destination=await server(t,(_req,res)=>{redirected++;res.end('{}')})
  const upstream=await server(t,(req,res)=>{
    if(req.url!.startsWith('/redirect')) {res.writeHead(307,{Location:destination.url});res.end();return}
    if(req.url!.startsWith('/error')) {res.writeHead(401);res.end('fixture-probe-secret should not appear');return}
    if(req.url!.startsWith('/invalid')) {res.end('{broken fixture-probe-secret');return}
    if(req.url!.startsWith('/shape')) {res.end('{"output":"fixture-probe-secret"}');return}
    res.end(JSON.stringify({data:[],padding:'X'.repeat(2*1024*1024)}))
  })
  const f=fixture(t)
  const targets=['redirect','error','invalid','shape','oversize'].map(path=>f.add(`${upstream.url}/${path}`))
  f.probes.start({mode:'models',targets});await f.probes.settled()
  const result=f.probes.snapshot()
  assert.equal(result.failed,5);assert.equal(result.succeeded,0);assert.equal(redirected,0)
  assert.equal(result.records[0].httpStatus,307)
  assert.match(result.records[1].error!,/鉴权/)
  assert.match(result.records[3].error!,/data/)
  assert.equal(JSON.stringify(result).includes('fixture-probe-secret'),false)
})

test('chat probes use direct Responses/Chat Completions requests and observe actual Fast, explicit tiers and replies',async t=>{
  const received:Record<string,unknown>[]=[]
  const upstream=await server(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-probe-secret')
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw);received.push(body)
    assert.equal(body.model,'fixture-model')
    res.setHeader('Content-Type','application/json')
    const reply='回复 🧪\nfixture-probe-secret'
    if(req.url!.includes('chat/completions')) res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:body.model,service_tier:'default',choices:[{index:0,message:{role:'assistant',content:reply},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}))
    else res.end(JSON.stringify({id:'fixture',object:'response',status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}],usage:{input_tokens:4,output_tokens:2,total_tokens:6}}))
  })
  const f=fixture(t)
  for(const wire of ['responses','chat_completions']) {
    const target=f.add(`${upstream.url}/${wire}/v1`,wire),before=f.store.read()
    for(const serviceTier of [undefined,'default','flex','auto']) {
      f.probes.start({mode:'chat',targets:[target],prompt:'中文 🧪\nprobe',serviceTier});await f.probes.settled()
      const result=f.probes.snapshot().records[0]
      assert.equal(result.status,'success',result.error)
      assert.equal(received.at(-1)?.service_tier,serviceTier ?? 'priority')
      assert.match(result.reply!,/回复 🧪/)
      assert.equal(result.replyTruncated,false)
      assert.equal(JSON.stringify(result).includes('fixture-probe-secret'),false)
      assert.equal(result.outboundTier,serviceTier ?? 'priority')
      assert.equal(result.responseTier,'default')
      assert.equal(existsSync(f.runtime),false)
      assert.deepEqual(f.store.read(),before)
    }
  }
})

test('one provider probes each key with its own models, protocol and authentication; manual model names remain exact',async t=>{
  const received:Array<{path:string;body:Record<string,unknown>;authorization?:string;apiKey?:string}>=[]
  const upstream=await server(t,async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw)
    received.push({path:req.url!,body,authorization:req.headers.authorization,apiKey:req.headers['x-api-key'] as string|undefined})
    assert.equal(body.stream,false)
    assert.equal(req.headers['content-type'],'application/json')
    if(req.url==='/v1/messages') {
      assert.equal(req.headers['anthropic-version'],'2023-06-01')
      assert.deepEqual(body.messages,[{role:'user',content:'真实请求格式 🧪'}])
      assert.equal(body.max_tokens,256);assert.equal(body.service_tier,undefined)
      assert.equal(body.input,undefined);assert.equal(body.store,undefined)
      res.end(JSON.stringify({type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:`Anthropic ${req.headers['x-api-key']??req.headers.authorization}`}]}))
    } else if(req.url==='/v1/chat/completions') {
      assert.deepEqual(body.messages,[{role:'user',content:'真实请求格式 🧪'}])
      assert.equal(body.max_tokens,256);assert.equal(body.input,undefined)
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'chat reply'},finish_reason:'stop'}]}))
    } else {
      assert.equal(req.url,'/v1/responses')
      assert.deepEqual(body.input,[{role:'user',content:[{type:'input_text',text:'真实请求格式 🧪'}]}])
      assert.equal(body.max_output_tokens,256);assert.equal(body.store,false);assert.equal(body.messages,undefined)
      res.end(JSON.stringify({status:'completed',output_text:'responses reply'}))
    }
  })
  const f=fixture(t)
  mutateProvider(f.store,{action:'create',details:{name:'Mixed',baseUrl:upstream.url+'/v1',models:['unrelated-legacy-model'],defaultTier:'fast'}})
  const variants=[
    {name:'Responses',apiKey:'fixture-secret-responses',models:['DeepSeek/Reasoner-Custom','gpt-later'],protocol:'openai_responses',credentialKind:'openai_api_key'},
    {name:'Chat',apiKey:'fixture-secret-chat',models:['Gemini-Custom'],protocol:'openai_chat_completions',credentialKind:'openai_api_key'},
    {name:'Anthropic API',apiKey:'fixture-secret-ant-api',models:['Claude-Custom'],protocol:'anthropic_messages',credentialKind:'anthropic_api_key'},
    {name:'Anthropic Bearer',apiKey:'fixture-secret-ant-bearer',models:['My-Deployment'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer'},
  ]
  for(const variant of variants) {
    const provider=f.store.read().providers![0]
    mutateProvider(f.store,{action:'addKey',id:provider.id,revision:provider.revision,...variant})
  }
  const provider=f.store.read().providers![0],targets=provider.keys.map(key=>({providerId:provider.id,keyId:key.id,revision:provider.revision}))
  f.probes.start({mode:'chat',targets,prompt:'真实请求格式 🧪'});await f.probes.settled()
  assert.equal(f.probes.snapshot().succeeded,4,JSON.stringify(f.probes.snapshot()))
  assert.deepEqual(received.map(item=>item.body.model),variants.map(item=>item.models[0]))
  assert.deepEqual(received.map(item=>item.path),['/v1/responses','/v1/chat/completions','/v1/messages','/v1/messages'])
  assert.deepEqual(received.map(item=>item.authorization),['Bearer fixture-secret-responses','Bearer fixture-secret-chat',undefined,'Bearer fixture-secret-ant-bearer'])
  assert.deepEqual(received.map(item=>item.apiKey),[undefined,undefined,'fixture-secret-ant-api',undefined])
  assert.deepEqual(f.probes.snapshot().records.map(record=>record.protocol),variants.map(item=>item.protocol))
  assert.match(f.probes.snapshot().records[2].reply!,/已隐藏密钥/)
  assert.equal(f.probes.snapshot().records[2].reply!.includes('fixture-secret-ant-api'),false)
  f.probes.start({mode:'chat',targets:[{...targets[0],model:'manual-vendor/自由模型'}],model:'global-override',prompt:'真实请求格式 🧪'});await f.probes.settled()
  assert.equal(f.probes.snapshot().succeeded,1)
  assert.equal(received.at(-1)!.body.model,'manual-vendor/自由模型')
})

test('an explicitly empty key catalogue cannot inherit another key or legacy provider model',async t=>{
  let requests=0
  const upstream=await server(t,(_req,res)=>{requests++;res.end('{"status":"completed","output_text":"ok"}')})
  const f=fixture(t),target=f.add(upstream.url+'/v1')
  mutateProvider(f.store,{action:'editKey',id:target.providerId,revision:target.revision,keyId:target.keyId,models:[]})
  const current=f.target(target.providerId)
  f.probes.start({mode:'chat',targets:[current]});await f.probes.settled()
  assert.equal(requests,0);assert.match(f.probes.snapshot().records[0].error!,/没有可用/)
  f.probes.start({mode:'chat',targets:[{...current,model:'manually-chosen'}]});await f.probes.settled()
  assert.equal(requests,1);assert.equal(f.probes.snapshot().records[0].model,'manually-chosen')
})

test('a late successful chat response after catalogue revision is rejected even without a polling invalidation',async t=>{
  let release:(()=>void)|undefined
  const upstream=await server(t,(req,res)=>{req.resume();release=()=>res.end('{"status":"completed","output_text":"stale reply"}')})
  const f=fixture(t),target=f.add(upstream.url+'/v1')
  f.probes.start({mode:'chat',targets:[target]});await until(()=>!!release)
  mutateProvider(f.store,{action:'editKey',id:target.providerId,revision:target.revision,keyId:target.keyId,models:['new-model']})
  release!();await f.probes.settled()
  const record=f.probes.snapshot().records[0]
  assert.equal(record.status,'stale');assert.equal(record.reply,undefined)
})

test('a late Anthropic model page after key rotation cannot trigger another request or publish partial results',async t=>{
  let release:(()=>void)|undefined,requests=0
  const upstream=await server(t,(req,res)=>{requests++;req.resume();release=()=>res.end('{"data":[{"id":"old-model"}],"has_more":true,"last_id":"next-page"}')})
  const f=fixture(t)
  mutateProvider(f.store,{action:'create',details:{name:'Anthropic',baseUrl:upstream.url},initialKey:{name:'key',apiKey:'fixture-old',models:['custom-model'],protocol:'anthropic_messages',credentialKind:'anthropic_api_key',createConnection:false}})
  const provider=f.store.read().providers![0],target=f.target(provider.id)
  f.probes.start({mode:'models',targets:[target]});await until(()=>!!release)
  mutateProvider(f.store,{action:'editKey',id:target.providerId,revision:target.revision,keyId:target.keyId,apiKey:'fixture-new'})
  release!();await f.probes.settled()
  const record=f.probes.snapshot().records[0]
  assert.equal(record.status,'stale');assert.equal(record.models,undefined);assert.equal(requests,1)
})

test('chat cancellation closes the upstream, skips queued targets and leaves an existing local service running',async t=>{
  let count=0,closed=false
  const upstream=await server(t,(req,res)=>{count++;res.on('close',()=>{closed=true});req.resume()})
  const f=fixture(t),first=f.add(upstream.url+'/one'),second=f.add(upstream.url+'/two')
  const account=createAPIAccount({name:'Independent',apiKey:'fixture-existing',baseUrl:upstream.url,models:['fixture-model'],wireApi:'responses',defaultTier:'inherit',note:'',tags:[]})
  const existing=new Gateway(binary,join(f.root,'existing'))
  try {
    const existingStatus=await existing.start({id:account.id,port:0,account,apiKey:'fixture-local'},settingsSchema.parse({}))
    const run=f.probes.start({mode:'chat',targets:[first,second]})
    await until(()=>count===1)
    assert.throws(()=>f.probes.start({mode:'models',targets:[first]}),/正在运行/)
    assert.throws(()=>f.probes.cancel('wrong-run'),/批次已变化/)
    f.probes.cancel(run.runId!);await f.probes.settled();await until(()=>closed)
    assert.equal(count,1)
    assert.ok(f.probes.snapshot().records.every(record=>record.status==='cancelled'))
    assert.equal(f.probes.snapshot().cancelled,true)
    assert.equal(existsSync(f.runtime),false)
    assert.equal(existing.current().running,true)
    const models=await fetch(`http://127.0.0.1:${existingStatus.port}/v1/models`,{headers:{Authorization:'Bearer fixture-local'}})
    assert.equal(models.status,200)
    await models.text()
  } finally {await existing.stop()}
})

test('configuration changes invalidate in-flight and queued results; stale/duplicate targets fail before making requests',async t=>{
  let count=0
  const upstream=await server(t,(req,res)=>{count++;req.resume();res.on('close',()=>{})})
  const f=fixture(t),target=f.add(upstream.url)
  assert.throws(()=>f.probes.start({mode:'models',targets:[{...target,revision:0}]}),/已变化/)
  assert.throws(()=>f.probes.start({mode:'models',targets:[target,target]}),/重复/)
  assert.equal(count,0)
  f.probes.start({mode:'models',targets:[target]});await until(()=>count===1)
  mutateProvider(f.store,{action:'editKey',id:target.providerId,revision:target.revision,keyId:target.keyId,apiKey:'fixture-rotated'})
  f.probes.snapshot();await f.probes.settled()
  assert.equal(f.probes.snapshot().records[0].status,'stale')
  assert.equal(count,1)
  assert.equal(JSON.stringify(f.probes.snapshot()).includes('fixture-rotated'),false)
})

test('timeouts, empty replies and provider errors are failures; large model lists and Unicode replies report truncation',async t=>{
  const upstream=await server(t,(req,res)=>{
    req.resume()
    if(req.url!.startsWith('/slow'))return
    if(req.url!.endsWith('/models')){res.end(JSON.stringify({data:Array.from({length:1005},(_,i)=>({id:`model-${i}`}))}));return}
    res.setHeader('Content-Type','application/json')
    if(req.url!.startsWith('/long-reply')){res.end(JSON.stringify({id:'fixture',object:'response',status:'completed',output_text:'🧪'.repeat(8001)}));return}
    res.end(JSON.stringify({id:'fixture',object:'response',status:req.url!.startsWith('/incomplete') ? 'incomplete' : 'completed',output:[]}))
  })
  const f=fixture(t,{models:80,chat:3000})
  const slow=f.add(upstream.url+'/slow'),large=f.add(upstream.url+'/large')
  f.probes.start({mode:'models',targets:[slow,large]});await f.probes.settled()
  const [timeout,models]=f.probes.snapshot().records
  assert.equal(timeout.status,'error');assert.match(timeout.error!,/超时/)
  assert.equal(models.status,'success');assert.equal(models.models?.length,1000);assert.equal(models.modelsTruncated,true)
  const empty=f.add(upstream.url+'/empty'),incomplete=f.add(upstream.url+'/incomplete')
  f.probes.start({mode:'chat',targets:[empty,incomplete]});await f.probes.settled()
  assert.equal(f.probes.snapshot().failed,2)
  assert.match(f.probes.snapshot().records[0].error!,/没有可读回复/)
  assert.match(f.probes.snapshot().records[1].error!,/未正常完成/)
  const long=f.add(upstream.url+'/long-reply')
  f.probes.start({mode:'chat',targets:[long]});await f.probes.settled()
  const reply=f.probes.snapshot().records[0]
  assert.equal(reply.status,'success',reply.error)
  assert.equal(reply.replyTruncated,true)
  assert.equal(reply.reply,'🧪'.repeat(8000))
})

test('cancelling gateway startup terminates its owned process before readiness and removes private runtime files',async t=>{
  if(process.platform==='win32'){t.skip('Unix fixture executable');return}
  const f=fixture(t),script=join(f.root,'slow-sidecar')
  writeFileSync(script,'#!/bin/sh\nexec sleep 60\n',{mode:0o700})
  const gateway=new Gateway(script,f.runtime),controller=new AbortController()
  const account=createAPIAccount({name:'Startup',apiKey:'fixture-key',baseUrl:'http://127.0.0.1:9',models:['fixture-model'],wireApi:'responses',defaultTier:'inherit',note:'',tags:[]})
  const task=gateway.start({id:account.id,port:0,account,apiKey:'fixture-local'},settingsSchema.parse({}),controller.signal)
  controller.abort()
  await assert.rejects(task,/取消/)
  assert.equal(gateway.current().running,false)
  assert.deepEqual(readdirSync(f.runtime),[])
})
