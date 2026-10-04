import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createServer, type RequestListener} from 'node:http'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {ProviderModels} from '../src/main/providerModels'
import {mutateProvider} from '../src/main/providerLibrary'

async function fixture(t:TestContext,listener:RequestListener,timeout=1000) {
  const root=mkdtempSync(join(tmpdir(),'cml-models-'))
  const store=new Store(root,{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()})
  const server=createServer(listener)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/tenant/Case/v1`
  const models=new ProviderModels(store,timeout)
  t.after(async()=>{await models.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true})})
  return {root,store,baseUrl,models,input:(extra={})=>({requestId:randomUUID(),baseUrl,...extra})}
}
test('draft discovery uses GET, exact URL path and Bearer; deduplicates models without saving credentials',async t=>{
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.url,'/tenant/Case/v1/models');assert.equal(req.headers.authorization,'Bearer fixture-secret')
    res.end(JSON.stringify({data:[{id:'m-中文'},{id:'m-中文'},{id:'fixture-secret'},{id:'bad\nmodel'},{id:'m2',display_name:'fixture-secret name'}]}))
  })
  const result=await f.models.fetch(f.input({apiKey:'fixture-secret'}))
  assert.deepEqual(result.models.map(m=>m.id),['m-中文','m2'])
  assert.equal(JSON.stringify(result).includes('fixture-secret'),false)
  assert.equal(existsSync(join(f.root,'state.vault')),false)
})
test('public unauthenticated directory and empty list are supported',async t=>{
  const f=await fixture(t,(req,res)=>{assert.equal(req.headers.authorization,undefined);res.end('{"data":[]}')})
  assert.deepEqual((await f.models.fetch(f.input())).models,[])
})
for(const status of [301,401,403,404,429,500])test(`HTTP ${status} is reported without returning response body or following redirects`,async t=>{
  let attempts=0
  const f=await fixture(t,(_req,res)=>{attempts++;res.writeHead(status,{Location:'/unexpected'});res.end('fixture-secret echoed')})
  await assert.rejects(f.models.fetch(f.input({apiKey:'fixture-secret'})),error=>{
    assert.match(String(error),new RegExp(`HTTP ${status}`));assert.equal(String(error).includes('fixture-secret'),false);return true
  })
  assert.equal(attempts,1)
})
test('malformed, oversized and unsupported payloads are rejected; large lists are bounded',async t=>{
  let payload='not JSON'
  const f=await fixture(t,(_req,res)=>res.end(payload))
  await assert.rejects(f.models.fetch(f.input()),/响应格式/)
  payload=' '.repeat(2*1024*1024+1);await assert.rejects(f.models.fetch(f.input()),/2 MB/)
  payload='{"error":"bad","data":[]}';await assert.rejects(f.models.fetch(f.input()),/有效/)
  payload=JSON.stringify({data:Array.from({length:1500},(_,i)=>({id:`model-${i}`}))})
  const result=await f.models.fetch(f.input());assert.equal(result.models.length,1000);assert.equal(result.modelsTruncated,true)
})
test('cancel and timeout stop pending requests and allow retry; invalid IPC is rejected',async t=>{
  let reply=false
  const f=await fixture(t,(_req,res)=>{if(reply)res.end('{"data":[{"id":"ok"}]}')},70)
  const input=f.input(),pending=f.models.fetch(input)
  assert.throws(()=>f.models.fetch(f.input()),/正在获取/)
  f.models.cancel(input.requestId);await assert.rejects(pending,/取消/)
  await assert.rejects(f.models.fetch(f.input()),/超时/)
  reply=true;assert.equal((await f.models.fetch(f.input())).models[0].id,'ok')
  for(const baseUrl of ['file:///etc/passwd','https://user:password@fixture.invalid','https://fixture.invalid?key=secret'])assert.throws(()=>f.models.fetch(f.input({baseUrl})))
  assert.throws(()=>f.models.fetch({...f.input(),unknown:'x'}))
})
test('saved credentials stay in main process; changed URL or revision cannot reuse them',async t=>{
  let release:(()=>void)|undefined
  const f=await fixture(t,(req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-saved');release=()=>res.end('{"data":[{"id":"saved-model"}]}')})
  mutateProvider(f.store,{action:'create',details:{name:'saved',baseUrl:f.baseUrl,models:['existing']},initialKey:{name:'key',apiKey:'fixture-saved',createConnection:false}})
  const p=f.store.snapshot().providers![0],savedKey={providerId:p.id,keyId:p.keys[0].id,revision:p.revision}
  assert.throws(()=>f.models.fetch(f.input({savedKey,baseUrl:f.baseUrl+'/other'})),/地址已更改/)
  assert.throws(()=>f.models.fetch(f.input({savedKey,apiKey:'other'})))
  const pending=f.models.fetch(f.input({savedKey}))
  for(let i=0;!release&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.ok(release)
  mutateProvider(f.store,{action:'editKey',id:p.id,revision:p.revision,keyId:p.keys[0].id,apiKey:'rotated'})
  release();await assert.rejects(pending,/已变化/)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-saved'),false)
})
