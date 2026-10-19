import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAPIAccount } from '../src/main/accounts'
import { Gateway } from '../src/main/gateway'
import { settingsSchema } from '../src/shared/types'
import { emptyLocalAccess, localKeyDetailsSchema, type StoredLocalKey } from '../src/shared/localAccess'

const chatModel = 'fixture-chat-default'
const imageModel = 'fixture-image-a'
const otherImageModel = 'fixture-image-b'
const blockedImageModel = 'fixture-image-blocked'
const generations = '/v1/images/generations'
const edits = '/v1/images/edits'
const imageBytes = Buffer.from([137, 80, 78, 71, 0, 255, 13, 10, 1])
const maskBytes = Buffer.from([0, 255, 128, 10, 13, 0, 42])
const nativeResponse = '{"created":1790000000,"data":[{"b64_json":"cG5n","provider_detail":{"ok":true}}],"usage":{"input_tokens":5,"output_tokens":8,"total_tokens":13}}'
const partialEvent = 'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"cGFydGlhbA==","partial_image_index":0}\n\n'
const completedEvent = `event: image_generation.completed\ndata: ${JSON.stringify({ type:'image_generation.completed', b64_json:Buffer.alloc(4096, 97).toString('base64'), provider_detail:{ok:true}, usage:{input_tokens:5,output_tokens:8,total_tokens:13} })}\n\n`

function rejectHostProbe(req:IncomingMessage, res:ServerResponse):boolean {
  if (req.method !== 'GET' || req.url !== '/' || req.headers['user-agent'] !== undefined || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) return false
  res.writeHead(404, {Connection:'close'}); res.end(); return true
}

interface ExpectedRequest { path:string; model:string; upstreamKey:string; originalBody?:Buffer; stream?:boolean }

async function fixture(t:TestContext) {
  const binary = resolve('resources/bin/codex-proxy')
  assert.ok(existsSync(binary), 'Run npm run build:proxy before gateway tests')
  const root = mkdtempSync(join(tmpdir(), 'cml-provider-images-'))
  const expected:ExpectedRequest[] = [], received:Buffer[] = [], failures:unknown[] = [], events:Record<string,unknown>[] = []
  let finishStream:(()=>void)|undefined
  const gateway = new Gateway(binary, root, event => { if (event.type === 'usage') events.push(event) })
  const upstream = createServer((req,res) => {
    if (rejectHostProbe(req,res)) return
    void (async () => {
      const chunks:Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks); received.push(raw)
      const want = expected.shift(); assert.ok(want, 'A rejected request must never reach the provider')
      assert.equal(req.method, 'POST'); assert.equal(req.url, want.path)
      assert.equal(req.headers.authorization, `Bearer ${want.upstreamKey}`)
      assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['x-api-key'], undefined)
      if (want.originalBody) assert.deepEqual(raw, want.originalBody, 'Unmapped multipart edits must retain their original bytes')
      if (req.headers['content-type']?.startsWith('multipart/form-data')) {
        assert.equal(want.path, edits)
        const form = await new Response(new Uint8Array(raw), {headers:{'Content-Type':req.headers['content-type']}}).formData()
        assert.equal(form.get('model'), want.model)
        assert.equal(form.get('prompt'), 'Edit fixture 🧪')
        assert.deepEqual(form.getAll('style[]'), ['first','second'])
        assert.equal(form.get('provider_option'), '{"keep":"未知字段"}')
        for (const [field, bytes, filename] of [['image[]',imageBytes,'fixture.png'],['mask',maskBytes,'mask.png']] as const) {
          const file = form.get(field); assert.ok(file && typeof file !== 'string')
          assert.equal(file.name, filename); assert.equal(file.type, 'image/png')
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
        }
      } else {
        assert.equal(req.headers['content-type'], 'application/json')
        const body = JSON.parse(raw.toString('utf8'))
        assert.equal(body.model, want.model); assert.equal(body.prompt, 'Draw fixture 🧪')
        assert.equal(body.n, 2); assert.equal(body.stream, want.stream ?? false)
        assert.deepEqual(body.provider_options, {preserve:['未知字段',true]})
        assert.match(raw.toString('utf8'), /"provider_number":9007199254740993/)
        assert.equal(body.tools, undefined, 'Images must not be translated into a Responses tool call')
        assert.equal(body.messages, undefined)
      }
      res.setHeader('X-Request-Id', 'fixture-upstream-image')
      res.setHeader('Authorization', `Bearer ${want.upstreamKey}`)
      res.setHeader('Set-Cookie', 'fixture-provider-cookie=do-not-forward')
      if (want.stream) {
        assert.equal(req.headers.accept, 'text/event-stream')
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        // The caller must receive a partial image before the fixture completes.
        const release = new Promise<void>(resolve => { finishStream = resolve })
        res.flushHeaders(); res.write(partialEvent)
        await release
        res.end(completedEvent)
      } else {
        res.writeHead(201, {'Content-Type':'application/json; charset=utf-8'})
        res.end(nativeResponse)
      }
    })().catch(error => {
      failures.push(error)
      if (!res.headersSent) res.writeHead(500, {Connection:'close'})
      res.end('Image fixture assertion failed')
    })
  })
  t.after(async () => {
    finishStream?.()
    try {
      await gateway.stop()
      assert.equal(gateway.current().running, false)
      assert.equal(gateway.runtimeDirectory(), undefined)
      assert.deepEqual(readdirSync(root), [], 'Stopping must remove the manifest, config and projected credentials')
      assert.deepEqual(failures, [], 'Asynchronous provider fixture assertions must reach the test')
      assert.equal(expected.length, 0, 'Every permitted request must reach the expected provider')
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      rmSync(root, {recursive:true,force:true})
    }
  })
  await new Promise<void>((resolve,reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => { upstream.removeListener('error',reject); resolve() })
  })
  const address = upstream.address(); assert.ok(address && typeof address === 'object')
  return { gateway, expected, received, events, url:`http://127.0.0.1:${address.port}/v1`, releaseStream:() => finishStream?.() }
}

function account(name:string, baseUrl:string, models:string[]) {
  const value = createAPIAccount({name,baseUrl,apiKey:`fixture-provider-${name}`,models,wireApi:'chat_completions',defaultTier:'inherit',note:'',tags:[]})
  value.proxy = {mode:'direct'}
  return value
}

function generationBody(model:string, stream=false):Buffer {
  return Buffer.from(`{"model":${JSON.stringify(model)},"prompt":"Draw fixture 🧪","n":2,"stream":${stream},"provider_number":9007199254740993,"provider_options":{"preserve":["未知字段",true]}}`)
}

function multipartBody(model:string) {
  const boundary = 'fixture-image-boundary'
  const parts:Buffer[] = []
  for (const [name,value] of [['model',model],['prompt','Edit fixture 🧪'],['style[]','first'],['style[]','second'],['provider_option','{"keep":"未知字段"}'],['stream','false']]) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const [name,filename,bytes] of [['image[]','fixture.png',imageBytes],['mask','mask.png',maskBytes]] as const) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/png\r\nX-Image-Option: preserve\r\n\r\n`),bytes,Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return {body:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`}
}

function request(port:number, path:string, key:string, body:Buffer, contentType='application/json') {
  return fetch(`http://127.0.0.1:${port}${path}`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':contentType,Cookie:'fixture-client-cookie','X-Api-Key':'fixture-unrelated-client-key'},body:new Uint8Array(body),signal:AbortSignal.timeout(8000)})
}

async function assertUsage(events:Record<string,unknown>[], count:number, accountId:string, apiKeyId:string, model:string, requestedModel=model) {
  const deadline = Date.now() + 3000
  while (events.length < count && Date.now() < deadline) await delay(10)
  assert.equal(events.length, count, 'Each image call must produce one usage event')
  const event = events[count - 1]
  assert.equal(event.success, true); assert.equal(event.provider, 'provider_gateway')
  assert.equal(event.accountId, accountId); assert.equal(event.apiKeyId, apiKeyId)
  assert.equal(event.model, model); assert.equal(event.upstreamModel, model); assert.equal(event.requestedModel, requestedModel)
  const usage = event.usage as Record<string,unknown>
  assert.equal(usage.inputTokens, 5); assert.equal(usage.outputTokens, 8); assert.equal(usage.totalTokens, 13)
}

async function assertJSON(response:Response) {
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal(await response.text(), nativeResponse)
  assert.equal(response.headers.get('x-request-id'), 'fixture-upstream-image')
  assert.equal(response.headers.get('authorization'), null); assert.equal(response.headers.get('set-cookie'), null)
}

async function assertStream(response:Response, release:()=>void) {
  try {
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.ok(response.body)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let body = ''
    while (!body.includes('\n\n')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false, 'The partial image must arrive before completion')
      body += decoder.decode(chunk.value, {stream:true})
    }
    assert.equal(body, partialEvent)
    release()
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; body += decoder.decode(chunk.value, {stream:true}) }
    body += decoder.decode()
    assert.equal(body, partialEvent + completedEvent, 'Native image SSE must survive without Responses wrapping or truncation')
  } finally { release() }
}

test('source-built image gateway preserves native JSON, binary edits, incremental SSE and usage for a saved API connection', {timeout:30000}, async t => {
  const f = await fixture(t), provider = account('single',f.url,[chatModel,imageModel])
  const profileId = randomUUID(), localKey = 'fixture-local-single'
  const status = await f.gateway.start({id:profileId,port:0,account:provider,apiKey:localKey}, settingsSchema.parse({}))
  assert.ok(status.port)
  const manifest = JSON.parse(readFileSync(join(f.gateway.runtimeDirectory()!,'manifest.json'),'utf8'))
  const projected = manifest.apiKeys.find((key:{id:string}) => key.id === profileId)
  assert.equal(projected.providerGateway.upstreamModel,chatModel)
  assert.deepEqual(projected.providerGateway.upstreamModels,[chatModel,imageModel])
  assert.equal(projected.modelRouting,undefined)
  const body = generationBody(imageModel)
  f.expected.push({path:generations,model:imageModel,upstreamKey:provider.credentials.apiKey!})
  await assertJSON(await request(status.port,generations,localKey,body))
  await assertUsage(f.events,1,provider.id,profileId,imageModel)
  const multipart = multipartBody(imageModel)
  f.expected.push({path:edits,model:imageModel,upstreamKey:provider.credentials.apiKey!,originalBody:multipart.body})
  await assertJSON(await request(status.port,edits,localKey,multipart.body,multipart.contentType))
  await assertUsage(f.events,2,provider.id,profileId,imageModel)
  f.expected.push({path:generations,model:imageModel,upstreamKey:provider.credentials.apiKey!,stream:true})
  await assertStream(await request(status.port,generations,localKey,generationBody(imageModel,true)),f.releaseStream)
  await assertUsage(f.events,3,provider.id,profileId,imageModel)
  for (const [key,model,wantStatus] of [['fixture-wrong-key',imageModel,401],[localKey,'fixture-undeclared-image',404]] as const) {
    const denied = await request(status.port,generations,key,generationBody(model))
    assert.equal(denied.status,wantStatus,await denied.text())
  }
  assert.equal(f.received.length,3,'Unauthorized image requests must not fall back to the default chat model')
})

test('source-built local API pool routes image requests through authorized provider models and preserves key-scoped multipart rewrites', {timeout:30000}, async t => {
  const f = await fixture(t)
  const a = account('pool-a',f.url,[chatModel,imageModel,blockedImageModel]), b = account('pool-b',f.url,[chatModel,otherImageModel])
  const key = (label:string,details:Record<string,unknown>={}):StoredLocalKey => ({id:randomUUID(),revision:0,createdAt:1,key:`fixture-local-${label}`,...localKeyDetailsSchema.parse({label,enabled:true,inheritAccountPool:true,accountIds:[],modelPrefix:'',allowedModels:[imageModel,otherImageModel],excludedModels:[],tokenLimit:0,...details})})
  const pooled = key('pool'), scoped = key('scoped',{inheritAccountPool:false,accountIds:[a.id],modelPrefix:'work',allowedModels:[imageModel,blockedImageModel],excludedModels:[blockedImageModel]})
  const pool = {...emptyLocalAccess(),accountIds:[a.id,b.id],sessionAffinity:false,keys:[pooled,scoped]}
  const status = await f.gateway.start({id:randomUUID(),port:0,account:a,apiKey:'fixture-unused-profile-key',pool:{settings:pool,accounts:[a,b],providerTiers:{},tokenUsed:{}}},settingsSchema.parse({}))
  assert.ok(status.port)
  const manifest = JSON.parse(readFileSync(join(f.gateway.runtimeDirectory()!,'manifest.json'),'utf8'))
  const projected = manifest.apiKeys.find((value:{id:string}) => value.id === pooled.id)
  assert.equal(projected.modelRouting.automatic,true)
  assert.deepEqual(projected.modelRouting.routes.map((route:{providerAccountId:string}) => route.providerAccountId),[a.id,b.id])
  const body = generationBody(imageModel)
  f.expected.push({path:generations,model:imageModel,upstreamKey:a.credentials.apiKey!})
  await assertJSON(await request(status.port,generations,pooled.key,body))
  await assertUsage(f.events,1,a.id,pooled.id,imageModel)
  f.expected.push({path:generations,model:otherImageModel,upstreamKey:b.credentials.apiKey!,stream:true})
  await assertStream(await request(status.port,generations,pooled.key,generationBody(otherImageModel,true)),f.releaseStream)
  await assertUsage(f.events,2,b.id,pooled.id,otherImageModel)
  const requested = `work/${imageModel}`, multipart = multipartBody(requested)
  f.expected.push({path:edits,model:imageModel,upstreamKey:a.credentials.apiKey!})
  await assertJSON(await request(status.port,edits,scoped.key,multipart.body,multipart.contentType))
  await assertUsage(f.events,3,a.id,scoped.id,imageModel,requested)
  for (const [localKey,model,wantStatus] of [[scoped.key,`work/${otherImageModel}`,404],[scoped.key,`work/${blockedImageModel}`,404],[pooled.key,'fixture-undeclared-image',404],['fixture-wrong-key',imageModel,401]] as const) {
    const denied = await request(status.port,generations,localKey,generationBody(model))
    assert.equal(denied.status,wantStatus,await denied.text())
  }
  assert.equal(f.received.length,3,'Keys must not escape their account or model scopes through image routes')
})
