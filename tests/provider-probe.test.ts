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
  assert.equal(selectProbeModel(['gpt-image-1','gpt-5.6-luna'],'responses'),'gpt-5.6-luna')
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

test('chat probes use the real Responses/Chat Completions gateway and observe actual Fast, explicit tiers and replies',async t=>{
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
      assert.deepEqual(readdirSync(f.runtime),[])
      assert.deepEqual(f.store.read(),before)
    }
  }
})

test('chat cancellation closes the upstream, skips queued targets, cleans its sidecar and leaves an existing local service running',async t=>{
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
    assert.deepEqual(readdirSync(f.runtime),[])
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
