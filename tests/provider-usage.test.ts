import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAPIAccount, editAccount } from '../src/main/accounts'
import { Store } from '../src/main/store'
import { TokenAuthority } from '../src/main/tokens'
import { QuotaService } from '../src/main/quota'
import { bulkRefreshIds } from '../src/main/groups'
import { mutateProvider } from '../src/main/providerLibrary'
import { parseNewAPIUsage, parseSub2APIUsage, ProviderUsageUnavailable, queryProviderUsage } from '../src/main/providerUsage'

type Context = { after(fn: () => unknown): void }
const json = (res: ServerResponse, value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
async function server(t: Context, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const upstream = createServer(handler)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  return `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
}
function account(baseUrl: string, apiKey = 'fixture-provider-secret') {
  return createAPIAccount({ name: 'API fixture', baseUrl, apiKey, models: ['fixture'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
}
function fixture(t: Context, baseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cml-provider-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() })
  const a = account(baseUrl)
  store.transaction(state => { state.accounts.push(a); state.settings.refreshMinutes = 0 })
  const tokens = new TokenAuthority(store, async () => { assert.fail('API quota must not exchange ChatGPT tokens') })
  const service = new QuotaService(store, tokens, undefined, undefined, () => { assert.fail('API balance must not change OAuth routing') })
  t.after(async () => { await service.stop(); await tokens.stop() })
  return { store, a, service }
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { assert.ok(Date.now() < end, 'fixture timed out'); await delay(5) }
}

test('Sub2API preserves zero, unknown values and currency without inventing windows', () => {
  const value = parseSub2APIUsage({ is_active: true, remaining: 0, unit: 'CNY', quota: { used: '12.5', limit: 'bad' }, usage: { today: { requests: 0, total_tokens: '20' } } }, 42)
  assert.equal(value.remaining, 0); assert.equal(value.used, 12.5); assert.equal(value.limit, undefined)
  assert.equal(value.todayRequests, 0); assert.equal(value.todayTokens, 20); assert.equal(value.totalTokens, undefined)
  assert.equal(value.unit, 'CNY'); assert.equal(value.updatedAt, 42)
  assert.throws(() => parseSub2APIUsage({ success: true }), ProviderUsageUnavailable)
  assert.throws(() => parseSub2APIUsage({ remaining: 'Infinity', quota: { used: '' } }), ProviderUsageUnavailable)
})

test('New API coherent display wins, missing values remain unknown, and sentinel is not money', () => {
  const legacy = parseNewAPIUsage({ hard_limit_usd: '10' }, { total_usage: 250 })
  assert.equal(legacy.remaining, 7.5); assert.equal(legacy.used, 2.5); assert.equal(legacy.unit, undefined)
  const display = parseNewAPIUsage({ hard_limit_usd: 999 }, { total_usage: 10000 }, { data: { display: { unit: 'CNY', remaining: 3, used: 2 } } })
  assert.equal(display.limit, 5); assert.equal(display.used, 2); assert.equal(display.remaining, 3); assert.equal(display.unit, 'CNY')
  const partial = parseNewAPIUsage({ hard_limit_usd: 999 }, { total_usage: 10000 }, { data: { display: { unit: 'TOKENS', remaining: 3 } } })
  assert.equal(partial.limit, undefined); assert.equal(partial.used, undefined)
  const unlimited = parseNewAPIUsage({ hard_limit_usd: 1e8, soft_limit_usd: 1e8, system_hard_limit_usd: 1e8 }, { total_usage: 0 })
  assert.equal(unlimited.unlimited, true); assert.equal(unlimited.remaining, undefined); assert.equal(unlimited.limit, undefined)
  const raw = parseNewAPIUsage({ hard_limit_usd: 10 }, {}, { data: { remain_quota: 500000, used_quota: 50 } })
  assert.equal(raw.remaining, undefined); assert.equal(raw.used, undefined)
  assert.throws(() => parseNewAPIUsage({}, {}), ProviderUsageUnavailable)
})

test('New API dates preserve the two source meanings and reject unknown or out-of-range values', () => {
  const summary = parseNewAPIUsage({ hard_limit_usd: 20, access_until: '1790000000' }, {}, { data: { expires_at: 1791000000 } })
  assert.equal(summary.expiresAt, 1_791_000_000_000)
  assert.equal(summary.accessUntil, 1_790_000_000_000)
  for (const invalid of [undefined, null, '', 'secret', -1, 0, 1.5, Infinity, 1e20]) {
    const unknown = parseNewAPIUsage({ hard_limit_usd: 20, access_until: invalid }, {}, { data: { expires_at: invalid } })
    assert.equal(unknown.expiresAt, undefined); assert.equal(unknown.accessUntil, undefined)
  }
  assert.equal(parseNewAPIUsage({ hard_limit_usd: 20 }, {}, { success: false, data: { expires_at: 1791000000 } }).expiresAt, undefined)
})

test('real HTTP root fallback, auth, response minimization and durable summary', async t => {
  const paths: string[] = []
  const url = await server(t, (req, res) => {
    paths.push(req.url!); assert.equal(req.headers.authorization, 'Bearer fixture-provider-secret')
    if (req.url === '/v1/usage') json(res, { remaining: 8, unit: 'USD', unexpected: 'fixture-provider-secret', quota: { used: 2, limit: 10 }, usage: { today: { requests: 4, cost: 0 }, total: { requests: 123, total_tokens: 45000, cost: '3.25' } } })
    else if (req.url === '/dashboard/billing/subscription') res.end('<html>SPA fallback</html>')
    else res.writeHead(404).end()
  })
  const { store, a, service } = fixture(t, url)
  service.start([a.id]); await service.settled()
  assert.equal(service.current().failed, 0)
  assert.deepEqual(paths, ['/dashboard/billing/subscription', '/usage', '/v1/dashboard/billing/subscription', '/v1/usage'])
  const stored = store.snapshot().accounts[0]
  assert.equal(stored.providerUsage?.summary?.remaining, 8); assert.equal(stored.quota, undefined)
  assert.equal(stored.providerUsage?.summary?.todayCost, 0)
  assert.equal(stored.providerUsage?.summary?.totalCost, 3.25)
  assert.equal(stored.providerUsage?.summary?.totalRequests, 123)
  assert.equal(stored.providerUsage?.summary?.totalTokens, 45000)
  assert.equal(JSON.stringify(stored).includes('fixture-provider-secret'), false)
  assert.deepEqual(new Store(store.directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() }).snapshot().accounts[0].providerUsage, JSON.parse(JSON.stringify(stored.providerUsage)))
})

test('New API retains billing prefix, token endpoint removes only exact /v1, and units are not guessed', async t => {
  for (const prefix of ['/v1', '/tenant/v1']) {
    const paths: string[] = []
    const url = await server(t, (req, res) => {
      paths.push(req.url!)
      if (req.url?.endsWith('/subscription')) json(res, { hard_limit_usd: 20, access_until: 1790000000 })
      else if (req.url?.endsWith('/billing/usage')) json(res, { total_usage: 400 })
      else if (req.url?.endsWith('/api/usage/token/')) json(res, { data: { expires_at: 1791000000, display: { unit: 'CNY', total: 100, remaining: 70 } } })
      else res.writeHead(404).end()
    })
    const result = await queryProviderUsage(account(url + prefix), new AbortController().signal)
    assert.deepEqual(paths, [`${prefix}/dashboard/billing/subscription`, `${prefix}/dashboard/billing/usage`, `${prefix === '/v1' ? '' : prefix}/api/usage/token/`])
    assert.equal(result.source, 'new_api'); assert.equal(result.remaining, 70); assert.equal(result.used, 30)
    assert.equal(result.expiresAt, 1_791_000_000_000); assert.equal(result.accessUntil, 1_790_000_000_000)
  }
})

test('optional token endpoint may be missing; auth, rate limits and server errors are not hidden', async t => {
  let status = 404, calls = 0
  const url = await server(t, (req, res) => {
    calls++
    if (req.url?.endsWith('/subscription')) json(res, { hard_limit_usd: 20 })
    else if (req.url?.endsWith('/billing/usage')) json(res, { total_usage: 0 })
    else res.writeHead(status).end('fixture-provider-secret')
  })
  assert.equal((await queryProviderUsage(account(url), new AbortController().signal)).remaining, 20)
  for (const code of [401, 403, 429, 500]) {
    status = code; calls = 0
    await assert.rejects(queryProviderUsage(account(url), new AbortController().signal), error => {
      assert.match(String(error), new RegExp(String(code))); assert.equal(String(error).includes('fixture-provider-secret'), false); return true
    })
    assert.equal(calls, 3)
  }
})

test('unsupported manual retry, failure preserves last value, and quota errors do not overwrite gateway errors', async t => {
  let mode: 'ok' | 'fail' | 'absent' = 'ok'
  const url = await server(t, (req, res) => {
    if (req.url === '/v1/usage') {
      if (mode === 'ok') { json(res, { balance: 12, unit: 'USD' }); return }
      if (mode === 'fail') { res.writeHead(429).end('secret failure'); return }
    }
    res.writeHead(404).end()
  })
  const { store, a, service } = fixture(t, url + '/v1')
  store.transaction(state => { state.accounts[0].error = 'existing gateway error' })
  const refresh = async () => { service.start([a.id]); await service.settled() }
  await refresh(); const original = store.read().accounts[0].providerUsage!.summary
  mode = 'fail'; await refresh()
  assert.deepEqual(store.read().accounts[0].providerUsage?.summary, original)
  assert.match(store.read().accounts[0].providerUsage!.error!, /429/)
  mode = 'absent'; await refresh()
  assert.equal(store.read().accounts[0].providerUsage?.unavailable, true)
  mode = 'ok'; await refresh()
  assert.equal(store.read().accounts[0].providerUsage?.error, undefined)
  assert.equal(store.read().accounts[0].error, 'existing gateway error')
})

test('cancel and credential/address edits discard pending measurements and old quota state', async t => {
  let pending: ServerResponse | undefined
  const url = await server(t, (req, res) => {
    if (req.url === '/v1/usage') pending = res
    else res.writeHead(404).end()
  })
  const { store, a, service } = fixture(t, url + '/v1')
  service.start([a.id]); await until(() => !!pending); service.cancel(); await service.settled()
  assert.equal(service.current().cancelled, true); assert.equal(store.read().accounts[0].providerUsage, undefined)
  pending?.end(); pending = undefined
  service.start([a.id]); await until(() => !!pending)
  editAccount(store, { id: a.id, revision: 0, changes: { apiKey: 'replacement-fixture-secret' } })
  json(pending!, { balance: 50 }); await service.settled()
  assert.equal(store.read().accounts[0].providerUsage, undefined)
  store.transaction(state => { state.accounts[0].providerUsage = { summary: parseSub2APIUsage({ balance: 20 }), checkedAt: 1 } })
  editAccount(store, { id: a.id, revision: 1, changes: { baseUrl: url + '/other' } })
  assert.equal(store.read().accounts[0].providerUsage, undefined)
})

test('late failures and deleted account generations cannot write provider state', async t => {
  let pending: ServerResponse | undefined
  const url = await server(t, (_req, res) => { pending = res })
  const { store, a, service } = fixture(t, url)
  service.start([a.id]); await until(() => !!pending)
  store.transaction(state => { state.accounts[0].generation = 'restored-generation' })
  pending!.writeHead(401).end(); await service.settled()
  assert.equal(store.read().accounts[0].providerUsage, undefined)
  pending = undefined; service.start([a.id]); await until(() => !!pending)
  store.transaction(state => { state.accounts = [] })
  pending!.writeHead(401).end(); await service.settled()
  assert.equal(store.read().accounts.length, 0)
})

test('API bulk refresh respects disabled groups and auto refresh starts only after manual success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const { store, a } = fixture(t, 'https://fixture.invalid/v1')
  store.transaction(state => { state.settings.refreshMinutes = 1 })
  const authority = new TokenAuthority(store)
  let calls = 0, unavailable = false
  const service = new QuotaService(store, authority, async url => {
    calls++
    if (!unavailable && url.endsWith('/usage') && !url.endsWith('/billing/usage')) return { balance: 1 }
    throw new ProviderUsageUnavailable()
  })
  t.after(async () => { await service.stop(); await authority.stop() })
  service.schedule(); t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 0)
  service.startAll(); await service.settled(); assert.equal(calls, 2)
  t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 4)
  unavailable = true; t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 6)
  t.mock.timers.tick(60_000); await service.settled(); assert.equal(calls, 6)
  store.transaction(state => { state.groups.push({ id: 'disabled', name: 'disabled', accountIds: [a.id], quotaAutoRefreshMinutes: -1, sortOrder: 0, createdAt: 0 }) })
  assert.deepEqual(bulkRefreshIds(store.read()), [])
})

test('provider library secret rotation invalidates linked account measurements', t => {
  const { store, a } = fixture(t, 'https://fixture.invalid/v1')
  mutateProvider(store, { action: 'create', details: { name: 'fixture', baseUrl: a.baseUrl, models: a.models, wireApi: a.wireApi } })
  let provider = store.read().providers![0]
  mutateProvider(store, { action: 'linkAccount', id: provider.id, revision: provider.revision, keyId: provider.keys[0].id, accountId: a.id, accountRevision: 0 })
  store.transaction(state => { state.accounts[0].providerUsage = { summary: parseSub2APIUsage({ balance: 8 }), checkedAt: 1 } })
  provider = store.read().providers![0]
  mutateProvider(store, { action: 'editKey', id: provider.id, revision: provider.revision, keyId: provider.keys[0].id, apiKey: 'rotated-fixture' })
  assert.equal(store.read().accounts[0].providerUsage, undefined)
})

test('quota queries refuse redirects and never transmit credentials to a redirected host', async t => {
  let received = 0
  const target = await server(t, (_req, res) => { received++; json(res, { balance: 100 }) })
  const url = await server(t, (_req, res) => { res.writeHead(302, { Location: target }).end() })
  await assert.rejects(queryProviderUsage(account(url), new AbortController().signal), /连接或响应无效/)
  assert.equal(received, 0)
})
