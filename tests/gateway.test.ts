import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Gateway } from '../src/main/gateway'
import { createAPIAccount, parseAccountImport } from '../src/main/accounts'
import { settingsSchema } from '../src/shared/types'
import { emptyLocalAccess } from '../src/shared/localAccess'
import { setTimeout as delay } from 'node:timers/promises'

// Host service discovery can touch a fresh loopback port before the sidecar.
// Reject its exact bodyless GET / signature without relaxing the upstream
// method, path, JSON, timeout or request-count assertions below.
function rejectHostProbe(req:IncomingMessage,res:ServerResponse):boolean {
  if(req.method!=='GET'||req.url!=='/'||req.headers['user-agent']!==undefined||req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined)return false
  res.writeHead(404,{Connection:'close'});res.end();return true
}

// Send protocol failures back to the test caller. An uncaught async listener
// rejection would otherwise leave fetch waiting on an unanswered socket.
function responseFixture(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>):(req:IncomingMessage,res:ServerResponse)=>void {
  return (req,res)=>{
    if(rejectHostProbe(req,res))return
    void (async()=>{
      assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses')
      await handler(req,res)
    })().catch(error=>{
      console.error('Upstream fixture request failed',error)
      if(!res.headersSent)res.writeHead(500,{Connection:'close'})
      res.end('Upstream fixture request failed')
    })
  }
}

test('imported personal access token starts the source-built OAuth runtime without token refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cml-pat-gateway-'))
  const account = parseAccountImport('at-fixture-no-real-credential').accounts[0]
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'), root)
  try {
    const status = await gateway.start({ id: account.id, port: 0, account, apiKey: 'fixture-local-key' }, settingsSchema.parse({}))
    assert.equal(status.running, true)
    const directory = join(root, readdirSync(root)[0])
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.accounts[0].accessTokenOnly, true)
    const auth = JSON.parse(readFileSync(join(directory, 'auth', `${account.id}.json`), 'utf8'))
    assert.equal(auth.auth_mode, 'personal_access_token')
    assert.equal(auth.refresh_owner, 'codex_manager_lite')
    const response = await fetch(`http://127.0.0.1:${status.port}/v1/models`, { signal:AbortSignal.timeout(8000), headers: { Authorization: 'Bearer fixture-local-key' } })
    assert.equal(response.status, 200)
    assert.ok(Array.isArray((await response.json()).data))
  } finally { await gateway.stop(); assert.deepEqual(readdirSync(root), []); rmSync(root, { recursive: true, force: true }) }
})

test('saved stream timeouts reach the source-built sidecar, close upstream and never replay a partial response', {timeout:15000}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cml-stream-timeouts-'))
  const seen: unknown[] = [], events: Record<string, unknown>[] = []
  let mode = 'before_headers', closed = 0
  const upstream = createServer(responseFixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); seen.push(body.service_tier)
    res.once('close', () => { closed++ })
    if (mode === 'before_headers') return
    if (mode === 'delayed_success') await delay(1200)
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders()
    if (mode === 'headers_only') return
    if (mode === 'after_delta') { res.write('data: {"type":"response.output_text.delta","delta":"中文🧪"}\n\n'); return }
    res.end('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[],"service_tier":"default"}}\n\n')
  }))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve,reject)=>{
    get(`http://127.0.0.1:${address.port}/`,response=>{assert.equal(response.statusCode,404);response.once('end',resolve);response.resume()}).once('error',reject)
  })
  assert.deepEqual(seen,[]);assert.equal(closed,0)
  const account = createAPIAccount({ name:'Timeout fixture', apiKey:'fixture-only', baseUrl:`http://127.0.0.1:${address.port}/v1`, models:['fixture-model'], wireApi:'responses', defaultTier:'inherit', note:'', tags:[] })
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'), root, event => { if (event.type === 'usage') events.push(event) })
  t.after(async () => { await gateway.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(root, {recursive:true,force:true}) })
  const settings = settingsSchema.parse({ defaultTier:'fast', streamOpenTimeoutSeconds:1, streamIdleTimeoutSeconds:1 })
  const start = () => gateway.start({ id:account.id, port:0, account, apiKey:'fixture-client' }, settings)
  let status = await start()
  const config = JSON.parse(readFileSync(join(gateway.runtimeDirectory()!, 'config.json'), 'utf8'))
  assert.deepEqual(config.streaming, {'stream-open-timeout-ms':1000,'stream-idle-timeout-ms':1000,'image-stream-open-timeout-ms':60000,'image-stream-idle-timeout-ms':180000,'stream-open-max-attempts':1})
  const call = (tier?:string) => fetch(`http://127.0.0.1:${status.port}/v1/responses`, {method:'POST',headers:{Authorization:'Bearer fixture-client','Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'fixture',stream:true,service_tier:tier}),signal:AbortSignal.timeout(4000)})
  for (const [phase, tier] of [['before_headers',undefined],['headers_only','default'],['after_delta','auto']] as const) {
    mode = phase
    const response = await call(tier), body = await response.text()
    assert.equal(response.status, phase === 'after_delta' ? 200 : 504, body)
    assert.match(body, new RegExp(phase === 'before_headers' ? 'stream_open' : 'stream_idle'))
    if (phase === 'after_delta') { assert.ok(body.includes('中文🧪')); assert.equal(body.match(/event: response.failed\n/g)?.length,1) }
    assert.equal(body.includes('response.completed'), false)
    const deadline=Date.now()+1500
    while ((events.length < seen.length || closed < seen.length) && Date.now()<deadline) await delay(5)
    assert.equal(events.at(-1)?.success,false)
    assert.equal(events.at(-1)?.outboundServiceTier,tier??'priority')
    assert.equal(events.at(-1)?.responseServiceTier,undefined)
  }
  assert.deepEqual(seen,['priority','default','auto']); assert.equal(closed,3)
  await gateway.stop(); settings.streamOpenTimeoutSeconds=2; status=await start(); mode='delayed_success'
  const response=await call('flex'), body=await response.text()
  assert.equal(response.status,200); assert.ok(body.includes('response.completed')); assert.equal(body.includes('response.failed'),false)
  assert.deepEqual(seen,['priority','default','auto','flex'])
  await gateway.stop(); assert.deepEqual(readdirSync(root),[])
})

test('missing sidecar fails promptly and removes projected credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-manager-missing-'))
  const account = createAPIAccount({ name:'Local', apiKey:'fake', baseUrl:'http://127.0.0.1:9', models:['gpt-5.5'], wireApi:'responses', defaultTier:'inherit', note:'', tags:[] })
  const gateway = new Gateway(join(root,'does-not-exist'),root)
  try {
    await assert.rejects(gateway.start({ id:'missing',port:0,account,apiKey:'fake' },settingsSchema.parse({})), /ENOENT/)
    assert.equal(gateway.current().running,false)
    assert.deepEqual(readdirSync(root),[])
  } finally { await gateway.stop(); rmSync(root,{recursive:true,force:true}) }
})

test('unexpected pool exit clears account defaults before a later single-account startup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cml-exit-tier-')),binary=join(root,'fixture-runtime.cjs')
  writeFileSync(binary,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'ready',port:16321}));setTimeout(()=>process.exit(7),100)\n`,{mode:0o700})
  const account=parseAccountImport('at-fixture-no-real-credential').accounts[0]
  const gateway=new Gateway(binary,join(root,'runtime')),pool={...emptyLocalAccess(),accountIds:[account.id]}
  try{
    await gateway.start({id:'pool',port:0,account,apiKey:'fixture',pool:{settings:pool,accounts:[account],providerTiers:{},tokenUsed:{}}},settingsSchema.parse({defaultTier:'fast'}))
    assert.equal(JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',`${account.id}.json`),'utf8')).cml_default_service_tier,'priority')
    const end=Date.now()+3000
    while(gateway.current().running){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,10))}
    assert.match(gateway.current().error!,/意外退出/)
    assert.equal(gateway.current().profileId,'pool');assert.equal(gateway.usesAccount(account.id),false)
    assert.deepEqual(gateway.accountIds(),[])
    writeFileSync(binary,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'ready',port:16321}));setInterval(()=>{},1000)\n`,{mode:0o700})
    await gateway.start({id:'single',port:0,account,apiKey:'fixture'},settingsSchema.parse({defaultTier:'follow'}))
    const auth=JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',`${account.id}.json`),'utf8'))
    assert.equal(auth.cml_default_service_tier,undefined,'A new single-account session must not inherit a stopped pool default')
  }finally{await gateway.stop();rmSync(root,{recursive:true,force:true})}
})

test('source-built sidecar: projected Fast reaches HTTP upstream, explicit Standard survives, invalid key is denied', async () => {
  const binary = resolve('resources/bin/codex-proxy')
  assert.ok(existsSync(binary), 'Run npm run build:proxy before gateway tests')
  const root = mkdtempSync(join(tmpdir(), 'codex-manager-gateway-'))
  const received: Record<string, unknown>[] = []
  const upstream = createServer(responseFixture(async (req,res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({ id: 'resp_local_only', object: 'response', status: 'completed', service_tier: 'default', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }))
  }))
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const account = createAPIAccount({ name: 'Local test', apiKey: 'fake-upstream', baseUrl: `http://127.0.0.1:${address.port}`, models: ['gpt-5.5'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
  const events: Record<string, unknown>[] = []
  const gateway = new Gateway(binary,root,event => { if (event.type === 'usage') events.push(event) })
  try {
    const status = await gateway.start({ id: 'test-profile', port: 0, account, apiKey: 'fake-client' },settingsSchema.parse({ defaultTier: 'fast' }))
    assert.equal(status.running,true)
    const url = `http://127.0.0.1:${status.port}/v1/responses`
    for (const tier of [undefined,'default','flex']) {
      const response = await fetch(url,{ signal:AbortSignal.timeout(8000), method:'POST', headers:{ Authorization:'Bearer fake-client','Content-Type':'application/json' }, body:JSON.stringify({ model:'gpt-5.5',input:'Local 🧪\nprobe', service_tier:tier }) })
      assert.equal(response.status,200,await response.text())
      assert.equal(received.at(-1)?.service_tier,tier ?? 'priority')
      const deadline = Date.now() + 2000
      while (events.length < received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      const entry = events.at(-1)!
      assert.equal(entry.inboundServiceTier,tier ?? '')
      assert.equal(entry.outboundServiceTier,tier ?? 'priority')
      assert.equal(entry.responseServiceTier,'default')
      assert.equal(entry.serviceTier,'standard')
      assert.equal(entry.tierSource,tier ? 'request' : 'global')
    }
    const invalid = await fetch(url,{ signal:AbortSignal.timeout(8000),method:'POST',headers:{Authorization:'Bearer wrong-key'},body:JSON.stringify({model:'gpt-5.5',input:'denied'}) })
    assert.equal(invalid.status,401)
    assert.equal(received.length,3)
  } finally {
    await gateway.stop()
    assert.deepEqual(readdirSync(root),[],'Runtime credentials should be removed when the service stops')
    upstream.closeAllConnections();await new Promise<void>(resolve => upstream.close(() => resolve()))
    rmSync(root,{recursive:true,force:true})
  }
})

test('source-built profiles honor account/instance precedence and apply changes after restart across models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cml-tier-profiles-'))
  const bodies: Record<string, unknown>[] = []
  const upstream = createServer(responseFixture(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw))
    res.setHeader('Content-Type', 'application/json')
    // Deliberately omit service_tier: configuration is not an upstream echo.
    res.end('{"id":"fixture","object":"response","status":"completed","output":[]}')
  }))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); assert.ok(address && typeof address === 'object')
  const account = createAPIAccount({ name: 'Profile test', apiKey: 'fake-only', baseUrl: `http://127.0.0.1:${address.port}`, models: ['gpt-5.5','model-b'], wireApi:'responses', defaultTier:'inherit', note:'',tags:[] })
  const events: Record<string, unknown>[] = []
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'), root,event => { if (event.type === 'usage') events.push(event) })
  try {
    const cases = [
      { provider: 'inherit', instance: 'inherit', want: 'priority' },
      { provider: 'standard', instance: 'inherit', want: 'default' },
      { provider: 'standard', instance: 'fast', want: 'priority' },
      { provider: 'fast', instance: 'follow', want: undefined }
    ] as const
    for (const testcase of cases) {
      account.defaultTier = testcase.provider
      const status = await gateway.start({ id: account.id, port: 0, account, apiKey: 'client-fixture', defaultTier: testcase.instance }, settingsSchema.parse({ defaultTier: 'fast' }))
      for (const model of account.models) {
        const response = await fetch(`http://127.0.0.1:${status.port}/v1/responses`, { signal:AbortSignal.timeout(8000), method:'POST', headers:{Authorization:'Bearer client-fixture','Content-Type':'application/json'}, body:JSON.stringify({model,input:'fixture'}) })
        assert.equal(response.status, 200)
        assert.equal((await response.json()).service_tier, undefined)
        assert.equal(bodies.at(-1)?.service_tier, testcase.want)
        assert.equal(bodies.at(-1)?.model, model)
        const deadline = Date.now() + 2000
        while (events.length < bodies.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
        const entry = events.at(-1)!
        assert.equal(entry.inboundServiceTier,'')
        assert.equal(entry.outboundServiceTier,testcase.want ?? '')
        assert.equal(entry.responseServiceTier,undefined)
        assert.equal(entry.serviceTier,undefined,'No upstream echo must remain unknown')
        assert.equal(entry.tierSource,testcase.instance === 'follow' ? 'follow' : testcase.instance === 'fast' ? 'instance' : testcase.provider === 'standard' ? 'account' : 'global')
      }
      await gateway.stop()
    }
  } finally { await gateway.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(root,{recursive:true,force:true}) }
})
