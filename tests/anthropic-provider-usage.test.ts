import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAPIAccount, editAccount } from '../src/main/accounts'
import { Store, type StoredAccount } from '../src/main/store'
import { TokenAuthority } from '../src/main/tokens'
import { QuotaService } from '../src/main/quota'
import { ProviderUsageUnavailable, queryProviderUsage } from '../src/main/providerUsage'
import { ProviderUsageQueries } from '../src/main/providerUsageRefresh'
import { mutateProvider } from '../src/main/providerLibrary'
import { supportsProviderUsageQuery } from '../src/shared/providerUsage'

const json = (res: ServerResponse, value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const upstream = createServer(handler)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  return `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
}
function account(baseUrl: string, credentialKind: 'anthropic_api_key' | 'anthropic_bearer' | 'gateway' = 'anthropic_api_key') {
  return createAPIAccount({ name: `Claude ${credentialKind}`, baseUrl, apiKey: `fixture-${credentialKind}`,
    models: ['any-model'], wireApi: 'chat_completions', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind,
    defaultTier: 'inherit', note: '', tags: [] })
}
function fixture(t: TestContext, accounts: StoredAccount[]) {
  const dir = mkdtempSync(join(tmpdir(), 'aml-anthropic-provider-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir, { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() })
  store.transaction(state => { state.accounts = accounts; state.settings.refreshMinutes = 0 })
  const tokens = new TokenAuthority(store, async () => { assert.fail('Provider queries must not exchange OAuth credentials') })
  const service = new QuotaService(store, tokens, undefined, undefined, () => { assert.fail('Provider balance must not change OAuth routing') })
  t.after(async () => { await service.stop(); await tokens.stop() })
  return { store, tokens, service }
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { assert.ok(Date.now() < end, 'fixture timeout'); await delay(5) }
}

test('Anthropic API Key, Bearer and gateway connections query Sub2API with provider billing auth and retain their model contract', async t => {
  const requests: { path: string; auth?: string; apiKey?: string | string[] }[] = []
  const base = await server(t, (req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization, apiKey: req.headers['x-api-key'] })
    if (req.url === '/v1/usage') json(res, { remaining: 17.5, unit: 'USD', quota: { limit: 20, used: 2.5 } })
    else res.writeHead(404).end()
  })
  const accounts = (['anthropic_api_key', 'anthropic_bearer', 'gateway'] as const).map(kind => ({ ...account(base + '/v1', kind), integrationType: 'sub2api' as const }))
  const f = fixture(t, accounts)
  f.service.start(accounts.map(a => a.id)); await f.service.settled()
  assert.equal(f.service.current().failed, 0)
  assert.deepEqual(requests.map(req => req.path), ['/v1/usage', '/v1/usage', '/v1/usage'])
  assert.deepEqual(new Set(requests.map(req => req.auth)), new Set(accounts.map(a => `Bearer ${a.credentials.apiKey}`)))
  assert.ok(requests.every(req => req.apiKey === undefined))
  for (const a of f.store.read().accounts) {
    assert.equal(a.providerUsage?.summary?.remaining, 17.5)
    assert.equal(a.quota, undefined)
    assert.equal(a.protocol, 'anthropic_messages')
    assert.equal(a.identityService, 'anthropic')
    assert.deepEqual(a.models, ['any-model'])
  }
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-anthropic'), false)
})

test('Anthropic automatic discovery supports root /v1 fallback and explicit integration selection never crosses provider billing contracts', async t => {
  const paths: string[] = []
  const base = await server(t, (req, res) => {
    paths.push(req.url!)
    if (req.url === '/v1/usage') json(res, { remaining: 0, unit: 'CNY' })
    else res.writeHead(404).end()
  })
  const value = await queryProviderUsage(account(base), new AbortController().signal)
  assert.equal(value.remaining, 0)
  assert.deepEqual(paths, ['/dashboard/billing/subscription', '/usage', '/v1/dashboard/billing/subscription', '/v1/usage'])
  paths.length = 0
  await assert.rejects(queryProviderUsage({ ...account(base + '/v1'), integrationType: 'new_api' }, new AbortController().signal), ProviderUsageUnavailable)
  assert.deepEqual(paths, ['/v1/dashboard/billing/subscription'])
  paths.length = 0
  await queryProviderUsage({ ...account(base + '/v1'), integrationType: 'sub2api' }, new AbortController().signal)
  assert.deepEqual(paths, ['/v1/usage'])
})

test('one provider can query mixed OpenAI and Anthropic library keys without linking accounts or changing per-key protocol', async t => {
  const requests: { path: string; auth?: string }[] = []
  const base = await server(t, (req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization })
    json(res, { remaining: req.headers.authorization === 'Bearer fixture-openai' ? 9 : 4, unit: 'USD' })
  })
  const f = fixture(t, [])
  mutateProvider(f.store, { action: 'create', details: { name: 'Shared Sub2API', baseUrl: base + '/v1', models: [], integrationType: 'sub2api' } })
  const provider = () => f.store.read().providers![0]
  for (const input of [
    { name: 'OpenAI', apiKey: 'fixture-openai', models: ['claude-named-model'], protocol: 'openai_responses', credentialKind: 'openai_api_key' },
    { name: 'Anthropic', apiKey: 'fixture-anthropic', models: ['gpt-named-model'], protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key' },
  ]) mutateProvider(f.store, { action: 'addKey', id: provider().id, revision: provider().revision, ...input })
  const usage = new ProviderUsageQueries(f.store)
  t.after(() => usage.stop())
  usage.start({ providerId: provider().id, revision: provider().revision, keyIds: provider().keys.map(key => key.id) })
  await usage.settled()
  assert.equal(usage.snapshot().failed, 0)
  assert.equal(f.store.read().accounts.length, 0)
  assert.deepEqual(provider().keys.map(key => key.usage?.summary?.remaining), [9, 4])
  assert.deepEqual(provider().keys.map(key => key.protocol), ['openai_responses', 'anthropic_messages'])
  assert.deepEqual(requests.map(req => req.path), ['/v1/usage', '/v1/usage'])
  assert.deepEqual(new Set(requests.map(req => req.auth)), new Set(['Bearer fixture-openai', 'Bearer fixture-anthropic']))
})

test('an Anthropic library key reuses the provider billing contract and goes straight to Sub2API without reusing another key balance', async t => {
  const requests: { path: string; auth?: string }[] = []
  const base = await server(t, (req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization })
    if (req.url === '/v1/usage') json(res, { remaining: 4, unit: 'USD' })
    else res.writeHead(404).end()
  })
  const f = fixture(t, [])
  mutateProvider(f.store, { action: 'create', details: { name: 'Shared root Sub2API', baseUrl: base, models: [], integrationType: 'auto' } })
  const provider = () => f.store.read().providers![0]
  for (const input of [
    { name: 'OpenAI', apiKey: 'fixture-openai', protocol: 'openai_responses', credentialKind: 'openai_api_key' },
    { name: 'Anthropic', apiKey: 'fixture-anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key' }
  ]) mutateProvider(f.store, { action: 'addKey', id: provider().id, revision: provider().revision, models: ['any-model'], createConnection: true, ...input })
  f.store.transaction(state => {
    state.providers![0].keys[0].usage = { checkedAt: 1, summary: { source: 'sub2api', updatedAt: 1, remaining: 900, unit: 'USD' } }
  })
  const usage = new ProviderUsageQueries(f.store)
  t.after(() => usage.stop())
  usage.start({ providerId: provider().id, revision: provider().revision, keyIds: [provider().keys[1].id] })
  await usage.settled()
  assert.equal(usage.snapshot().failed, 0)
  assert.deepEqual(requests, [{ path: '/v1/usage', auth: 'Bearer fixture-anthropic' }])
  assert.deepEqual(provider().keys.map(key => key.usage?.summary?.remaining), [900, 4])
  assert.deepEqual(provider().keys.map(key => key.protocol), ['openai_responses', 'anthropic_messages'])
  assert.equal(f.store.read().accounts.every(value => value.providerUsage === undefined), true)
  assert.equal(provider().integrationType, 'auto')
})

test('known Sub2API queries preserve tenant paths and fall back to legacy root usage when the versioned endpoint is missing', async t => {
  for (const prefix of ['', '/tenant', '/tenant/v1']) {
    const paths: string[] = []
    const base = await server(t, (req, res) => {
      paths.push(req.url!)
      if (req.url === `${prefix}/usage`) json(res, { remaining: 6 })
      else res.writeHead(404).end()
    })
    const result = await queryProviderUsage({ ...account(base + prefix), integrationType: 'sub2api' }, new AbortController().signal)
    assert.equal(result.remaining, 6)
    assert.deepEqual(paths, prefix.endsWith('/v1') ? [`${prefix}/usage`] : [`${prefix}/v1/usage`, `${prefix}/usage`])
  }
})

test('a stale Sub2API hint falls back to automatic discovery only for absent endpoints and never repeats a request', async t => {
  const paths: string[] = []
  const base = await server(t, (req, res) => {
    paths.push(req.url!)
    if (req.url === '/dashboard/billing/subscription') json(res, { hard_limit_usd: 8 })
    else if (req.url === '/dashboard/billing/usage') json(res, { total_usage: 300 })
    else res.writeHead(404).end()
  })
  const a = account(base)
  a.providerUsage = { checkedAt: 1, summary: { source: 'sub2api', updatedAt: 1, remaining: 50 } }
  const result = await queryProviderUsage(a, new AbortController().signal)
  assert.equal(result.source, 'new_api')
  assert.equal(result.remaining, 5)
  assert.deepEqual(paths, ['/v1/usage', '/usage', '/dashboard/billing/subscription', '/dashboard/billing/usage', '/api/usage/token/'])
})

test('a discovered billing contract preserves authentication, rate-limit and server failures instead of probing around them', async t => {
  const paths: string[] = []
  let status = 401
  const base = await server(t, (req, res) => { paths.push(req.url!); res.writeHead(status).end('fixture-anthropic_api_key') })
  const a = account(base)
  a.providerUsage = { checkedAt: 1, summary: { source: 'sub2api', updatedAt: 1, remaining: 50 } }
  for (const code of [401, 403, 429, 500]) {
    paths.length = 0; status = code
    await assert.rejects(queryProviderUsage(a, new AbortController().signal), error => {
      assert.match(String(error), new RegExp(`HTTP ${code}`))
      assert.equal(String(error).includes('fixture-anthropic_api_key'), false)
      return true
    })
    assert.deepEqual(paths, ['/v1/usage'])
  }
})

test('first automatic discovery preserves a tenant path before trying its versioned Sub2API endpoint',async t=>{
  const paths:string[]=[]
  const base=await server(t,(req,res)=>{
    paths.push(req.url!)
    assert.equal(req.headers.authorization,'Bearer fixture-anthropic_api_key')
    if(req.url==='/tenant/v1/usage')json(res,{remaining:17,unit:'USD'})
    else res.writeHead(404).end()
  })
  const summary=await queryProviderUsage(account(base+'/tenant'),new AbortController().signal)
  assert.equal(summary.source,'sub2api');assert.equal(summary.remaining,17)
  assert.ok(paths.includes('/tenant/v1/usage'))
  assert.ok(paths.every(path=>path.startsWith('/tenant/')))
  assert.equal(new Set(paths).size,paths.length)
})

test('conflicting key histories do not impose one supplier billing contract on an unqueried key', async t => {
  const paths: string[] = []
  const base = await server(t, (req, res) => {
    paths.push(req.url!)
    if (req.url === '/dashboard/billing/subscription') json(res, { hard_limit_usd: 8 })
    else if (req.url === '/dashboard/billing/usage') json(res, { total_usage: 300 })
    else if (req.url === '/api/usage/token/') res.writeHead(404).end()
    else res.writeHead(403).end()
  })
  const f = fixture(t, [])
  mutateProvider(f.store, { action: 'create', details: { name: 'Mixed billing provider', baseUrl: base, models: [], integrationType: 'auto' } })
  const provider = () => f.store.read().providers![0]
  for (const name of ['Sub2API', 'New API', 'Unqueried']) mutateProvider(f.store, {
    action: 'addKey', id: provider().id, revision: provider().revision, name, apiKey: `fixture-${name}`, models: ['any-model'],
    protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key'
  })
  f.store.transaction(state => {
    for (const [index, source] of (['sub2api', 'new_api'] as const).entries()) {
      state.providers![0].keys[index].usage = { checkedAt: 1, summary: { source, updatedAt: 1, remaining: 900 } }
    }
  })
  const usage = new ProviderUsageQueries(f.store)
  t.after(() => usage.stop())
  usage.start({ providerId: provider().id, revision: provider().revision, keyIds: [provider().keys[2].id] })
  await usage.settled()
  assert.equal(usage.snapshot().failed, 0)
  assert.equal(provider().keys[2].usage?.summary?.source, 'new_api')
  assert.equal(provider().keys[2].usage?.summary?.remaining, 5)
  assert.deepEqual(paths, ['/dashboard/billing/subscription', '/dashboard/billing/usage', '/api/usage/token/'])
})

test('provider queries keep Claude subscriptions and cloud/profile credentials on their separate usage contracts', async t => {
  const original = account('https://fixture.invalid/v1')
  let calls = 0
  for (const credentialKind of ['claude_ai_oauth', 'anthropic_profile', 'bedrock', 'vertex', 'foundry'] as const) {
    const a: StoredAccount = { ...original, kind: credentialKind === 'claude_ai_oauth' ? 'oauth' : 'api_key', credentialKind }
    assert.equal(supportsProviderUsageQuery(a), false)
    await assert.rejects(queryProviderUsage(a, new AbortController().signal, async () => { calls++; return { remaining: 1 } }), ProviderUsageUnavailable)
  }
  assert.equal(calls, 0)
  const subscription: StoredAccount = { ...original, kind: 'oauth', credentialKind: 'claude_ai_oauth', credentials: { accessToken: 'fixture-oauth', refreshToken: 'fixture-refresh' } }
  const f = fixture(t, [subscription])
  assert.throws(() => f.service.start([subscription.id]), /刷新订阅/)
  assert.deepEqual(f.store.read().accounts[0].credentials, subscription.credentials)
})

test('Anthropic provider failures preserve history, missing endpoints remain unsupported, and credential changes discard late results', async t => {
  let mode = 'ok', held: ServerResponse | undefined
  const base = await server(t, (_req, res) => {
    if (mode === 'hold') { held = res; return }
    if (mode === 'rate-limit') { res.writeHead(429).end('fixture-anthropic_api_key'); return }
    if (mode === 'missing') { res.writeHead(404).end(); return }
    json(res, { remaining: 3 })
  })
  const a = { ...account(base + '/v1'), integrationType: 'sub2api' as const }, f = fixture(t, [a])
  const refresh = async () => { f.service.start([a.id]); await f.service.settled() }
  await refresh()
  mode = 'rate-limit'; await refresh()
  assert.equal(f.store.read().accounts[0].providerUsage?.summary?.remaining, 3)
  assert.match(f.store.read().accounts[0].providerUsage?.error ?? '', /HTTP 429/)
  assert.equal(f.store.read().accounts[0].providerUsage?.unavailable, false)
  mode = 'missing'; await refresh()
  assert.equal(f.store.read().accounts[0].providerUsage?.unavailable, true)
  mode = 'hold'; f.service.start([a.id]); await until(() => !!held)
  editAccount(f.store, { id: a.id, revision: 0, changes: { apiKey: 'fixture-rotated' } })
  json(held!, { remaining: 900 }); await f.service.settled()
  assert.equal(f.store.read().accounts[0].providerUsage, undefined)
  assert.equal(f.store.read().accounts[0].credentials.apiKey, 'fixture-rotated')
})

test('Anthropic provider automatic refresh starts only after manual success and stops after a confirmed unsupported response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const a = { ...account('https://fixture.invalid/v1'), integrationType: 'sub2api' as const }, f = fixture(t, [a])
  f.store.transaction(state => { state.settings.refreshMinutes = 1 })
  let calls = 0, supported = true
  const service = new QuotaService(f.store, f.tokens, async () => {
    calls++
    if (supported) return { remaining: 5 }
    throw new ProviderUsageUnavailable()
  })
  t.after(() => service.stop())
  service.schedule(); t.mock.timers.tick(60_000); await service.settled()
  assert.equal(calls, 0)
  service.start([a.id]); await service.settled(); assert.equal(calls, 1)
  t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 2)
  supported = false; t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 3)
  t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 3)
})

test('bulk and scheduled quota refresh skip Claude subscriptions and cloud credentials without blocking mixed API and ChatGPT accounts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const anthropic = { ...account('https://fixture.invalid/v1'), integrationType: 'sub2api' as const }
  const openai = createAPIAccount({ name: 'OpenAI API', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-openai', models: ['any-model'], integrationType: 'sub2api' })
  const claude: StoredAccount = { ...account('https://api.anthropic.com'), kind: 'oauth', credentialKind: 'claude_ai_oauth',
    credentials: { accessToken: 'fixture-claude-oauth', refreshToken: 'fixture-claude-refresh' } }
  const cloud: StoredAccount = { ...account('https://fixture.invalid/v1'), credentialKind: 'bedrock' }
  const disabled = { ...account('https://fixture.invalid/v1'), integrationType: 'sub2api' as const }
  const chatgpt: StoredAccount = { ...createAPIAccount({ name: 'ChatGPT', baseUrl: 'https://api.openai.com/v1', apiKey: 'unused', models: ['any-model'] }),
    kind: 'oauth', credentialKind: 'openai_oauth', credentials: { accessToken: 'fixture-chatgpt-access' }, subscriptionQueryLastSuccessAt: Date.now() }
  const f = fixture(t, [anthropic, openai, claude, cloud, disabled, chatgpt])
  f.store.transaction(state => {
    state.settings.refreshMinutes = 1
    state.groups.push({ id: 'disabled', name: 'Disabled', accountIds: [disabled.id], quotaAutoRefreshMinutes: -1, sortOrder: 0, createdAt: 0 })
  })
  const requests: { id: string; url: string }[] = []
  const service = new QuotaService(f.store, f.tokens, async (url, _init, _operation, target) => {
    requests.push({ id: target!.id, url })
    if (target!.id === chatgpt.id) {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage')
      return { rate_limit: { primary_window: { used_percent: 25 } } }
    }
    assert.ok([anthropic.id, openai.id].includes(target!.id))
    assert.equal(url, 'https://fixture.invalid/v1/usage')
    return { remaining: 10, unit: 'USD' }
  })
  t.after(() => service.stop())
  const expected = new Set([anthropic.id, openai.id, chatgpt.id])
  service.startAll(); await service.settled()
  assert.equal(service.current().total, 3)
  assert.equal(service.current().failed, 0)
  assert.deepEqual(new Set(requests.map(request => request.id)), expected)
  assert.equal(requests.length, 3)
  assert.deepEqual(f.store.read().accounts.find(a => a.id === claude.id), claude)
  assert.deepEqual(f.store.read().accounts.find(a => a.id === cloud.id), cloud)
  requests.length = 0
  t.mock.timers.tick(60_000); await service.settled()
  assert.deepEqual(new Set(requests.map(request => request.id)), expected)
  assert.equal(requests.length, 3)
  // A restore/edit can replace an account after the timer was scheduled. The
  // timer must recheck today's capability before dispatching the retained ID.
  f.store.transaction(state => { state.accounts = state.accounts.map(a => a.id === openai.id ? { ...claude, id: openai.id } : a) })
  requests.length = 0
  t.mock.timers.tick(60_000); await service.settled()
  assert.deepEqual(new Set(requests.map(request => request.id)), new Set([anthropic.id, chatgpt.id]))
  assert.equal(service.current().failed, 0)
})
