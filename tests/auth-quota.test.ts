import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { Store } from '../src/main/store'
import { saveOAuthAccount } from '../src/main/accounts'
import { TokenAuthority, parseTokens, type Tokens } from '../src/main/tokens'
import { OAuthLogin } from '../src/main/oauth'
import { QuotaService, parseQuota } from '../src/main/quota'
import { requestJSON, HTTPError, type JSONRequest } from '../src/main/network'

function jwt(extra: Record<string, unknown> = {}, lifetime = 7200): string {
  return `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + lifetime, email: 'test@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-one', chatgpt_plan_type: 'plus' }, ...extra })).toString('base64url')}.fixture`
}
function tokens(suffix = ''): Tokens { return { accessToken: jwt({ suffix }), idToken: jwt(), refreshToken: `fake-refresh${suffix}`, accountId: 'account-one' } }
function vault(t: { after: (fn: () => void) => void }): Store {
  const dir = mkdtempSync(join(tmpdir(), 'cml-auth-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new Store(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() })
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() > end) throw new Error('condition timeout'); await delay(5) }
}

// Actual browser callback socket and local mock token endpoint verify PKCE/state.
test('browser OAuth validates state, exchanges PKCE once, and does not disclose tokens', async t => {
  const store = vault(t)
  let opened = '', exchanges = 0
  const tokenServer = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const form = new URLSearchParams(body)
    assert.equal(form.get('code'), 'fixture-authorization-code')
    assert.equal(form.get('redirect_uri'), new URL(opened).searchParams.get('redirect_uri'))
    assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), new URL(opened).searchParams.get('code_challenge'))
    exchanges++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ access_token: tokens().accessToken, id_token: tokens().idToken, refresh_token: 'rotated-fixture' }))
  })
  const port = await listen(tokenServer)
  t.after(() => { tokenServer.close(); tokenServer.closeAllConnections() })
  const login = new OAuthLogin({ callbackPort: 0, request: (_url, init, operation) => requestJSON(`http://127.0.0.1:${port}/token`, init, operation), open: async url => { opened = url }, save: value => saveOAuthAccount(store, value).id })
  t.after(() => login.cancel())
  const started = await login.start('browser')
  assert.equal(started.status, 'waiting')
  assert.equal('url' in started, false)
  const auth = new URL(opened)
  const callback = new URL(auth.searchParams.get('redirect_uri')!)
  callback.hostname = '127.0.0.1'
  callback.search = new URLSearchParams({ code: 'fixture-authorization-code', state: 'wrong-state' }).toString()
  assert.equal((await fetch(callback)).status, 400)
  assert.equal(login.current().status, 'waiting')
  assert.equal(exchanges, 0)
  callback.searchParams.set('state', auth.searchParams.get('state')!)
  const result = await fetch(callback)
  assert.equal(result.status, 200)
  assert.match(await result.text(), /登录成功/)
  assert.equal(login.current().status, 'success')
  assert.equal(store.snapshot().accounts.length, 1)
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'rotated-fixture')
  assert.equal(JSON.stringify(store.snapshot()).includes('rotated-fixture'), false)
  await assert.rejects(login.complete(callback.toString()))
  assert.equal(exchanges, 1)
})

test('OAuth cancellation during exchange cannot import credentials after cancellation', async () => {
  let opened = '', saved = 0, exchangeStarted = false
  let finish!: (value: Record<string, unknown>) => void
  const login = new OAuthLogin({ callbackPort: 0, open: async url => { opened = url }, save: () => { saved++; return 'unused' }, request: async () => {
    exchangeStarted = true
    return await new Promise(resolve => { finish = resolve })
  } })
  await login.start('browser')
  const auth = new URL(opened), callback = new URL(auth.searchParams.get('redirect_uri')!)
  callback.search = new URLSearchParams({ code: 'fixture', state: auth.searchParams.get('state')! }).toString()
  const completion = login.complete(callback.toString())
  await until(() => exchangeStarted)
  login.cancel()
  finish({ access_token: tokens().accessToken, id_token: tokens().idToken })
  await assert.rejects(completion, /取消/)
  assert.equal(login.current().status, 'cancelled')
  assert.equal(saved, 0)
})

test('OAuth occupied callback port is reported without disturbing existing server; timeout releases listener', async t => {
  const occupied = createServer((_req, res) => res.end('existing-service'))
  const port = await listen(occupied)
  t.after(() => { occupied.close(); occupied.closeAllConnections() })
  const login = new OAuthLogin({ callbackPort: port, open: async () => { assert.fail('must not open on occupied port') }, save: () => 'unused' })
  assert.equal((await login.start('browser')).status, 'error')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing-service')
  const expiring = new OAuthLogin({ callbackPort: 0, timeoutMs: 30, open: async () => {}, save: () => 'unused' })
  await expiring.start('browser')
  await until(() => expiring.current().status === 'error')
  assert.match(expiring.current().error!, /超时/)
})

test('device authorization respects pending states and exchanges device redirect/verifier', async t => {
  const store = vault(t)
  let polls = 0, opened = ''
  const request: JSONRequest = async (url, init) => {
    if (url.endsWith('/usercode')) return { device_auth_id: 'fake-device', usercode: 'ABCD-EFGH', interval: '1' }
    if (url.endsWith('/deviceauth/token')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { device_auth_id: 'fake-device', user_code: 'ABCD-EFGH' })
      if (++polls === 1) throw new HTTPError(403, '设备授权')
      return { authorization_code: 'fake-auth-code', code_verifier: 'fake-verifier', code_challenge: 'fake-challenge' }
    }
    const form = new URLSearchParams(String(init?.body))
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback')
    assert.equal(form.get('code_verifier'), 'fake-verifier')
    return { access_token: tokens().accessToken, id_token: tokens().idToken, refresh_token: 'device-fixture' }
  }
  const login = new OAuthLogin({ request, open: async url => { opened = url }, save: value => saveOAuthAccount(store, value).id })
  t.after(() => login.cancel())
  const started = await login.start('device')
  assert.equal(started.userCode, 'ABCD-EFGH')
  await login.open()
  assert.equal(opened, 'https://auth.openai.com/codex/device')
  await until(() => login.current().status === 'success')
  assert.equal(polls, 2)
  assert.equal(store.snapshot().accounts.length, 1)
})

test('token authority serializes refresh, persists rotation before projection, and reuses a valid ID token', async t => {
  const store = vault(t)
  const account = saveOAuthAccount(store, { ...tokens(), accessToken: jwt({}, -1) })
  let calls = 0, projections = 0
  const authority = new TokenAuthority(store, async (_url, init) => {
    calls++
    assert.equal(JSON.parse(String(init?.body)).refresh_token, 'fake-refresh')
    await delay(15)
    return { access_token: tokens('next').accessToken, refresh_token: 'next-refresh' }
  }, updated => {
    projections++
    assert.equal(store.read().accounts[0].credentials.refreshToken, updated.credentials.refreshToken)
  })
  const results = await Promise.all(Array.from({ length: 10 }, () => authority.ensure(account.id)))
  assert.equal(calls, 1); assert.equal(projections, 1)
  assert.equal(results[0].credentials.refreshToken, 'next-refresh')
  assert.equal(results[0].credentials.idToken, account.credentials.idToken)
  await authority.ensure(account.id, { force: true, rejectedToken: account.credentials.accessToken })
  assert.equal(calls, 1)
  const reopened = new Store(store.directory, { encrypt: x => Buffer.from(x), decrypt: x => x.toString() })
  assert.equal(reopened.read().accounts[0].credentials.refreshToken, 'next-refresh')
  await authority.stop()
})

test('healthy access tokens do not rotate because ID metadata is expired or absent', async t => {
  for (const idToken of [jwt({}, -3600), undefined]) {
    const store = vault(t), lastRefresh = '2020-01-01T00:00:00.000Z'
    const account = saveOAuthAccount(store, { ...tokens(), idToken, lastRefresh })
    const authority = new TokenAuthority(store, async () => { assert.fail('healthy access token must not refresh') })
    t.after(() => authority.stop())
    const result = await authority.ensure(account.id)
    assert.equal(result.credentials.accessToken, account.credentials.accessToken)
    assert.equal(result.credentials.idToken, idToken)
    assert.equal(result.credentials.refreshToken, account.credentials.refreshToken)
    assert.equal(result.credentials.lastRefresh, lastRefresh)
  }
})

test('refresh without a new ID token preserves expired or absent metadata and persists its actual refresh time', async t => {
  for (const idToken of [jwt({}, -3600), undefined]) {
    const store = vault(t)
    const account = saveOAuthAccount(store, { ...tokens(), accessToken: jwt({}, -1), idToken, lastRefresh: '2020-01-01T00:00:00.000Z' })
    const started = Date.now()
    let projected = false
    const authority = new TokenAuthority(store, async () => ({
      access_token: tokens('refreshed').accessToken, refresh_token: 'refreshed-without-id'
    }), updated => {
      projected = true
      assert.equal(store.read().accounts[0].credentials.lastRefresh, updated.credentials.lastRefresh)
      assert.equal(store.read().accounts[0].credentials.refreshToken, 'refreshed-without-id')
    })
    t.after(() => authority.stop())
    const result = await authority.ensure(account.id)
    assert.equal(projected, true)
    assert.equal(result.credentials.idToken, idToken)
    assert.equal(result.credentials.refreshToken, 'refreshed-without-id')
    const timestamp = Date.parse(result.credentials.lastRefresh!)
    assert.ok(timestamp >= started && timestamp <= Date.now())
    const reopened = new Store(store.directory, { encrypt: x => Buffer.from(x), decrypt: x => x.toString() })
    assert.equal(reopened.read().accounts[0].credentials.lastRefresh, result.credentials.lastRefresh)
  }
})

test('OAuth initial exchange still requires a fresh ID token and records only a successful exchange time', () => {
  assert.throws(() => parseTokens({ access_token: tokens().accessToken }), /有效/)
  assert.throws(() => parseTokens({ access_token: tokens().accessToken, id_token: jwt({}, -1) }), /有效/)
  const started = Date.now(), result = parseTokens({ access_token: tokens().accessToken, id_token: tokens().idToken })
  assert.ok(Date.parse(result.lastRefresh!) >= started && Date.parse(result.lastRefresh!) <= Date.now())
})

test('token refresh rejects conflicting new access identity even when the prior ID remains present', async t => {
  const claims = [
    { chatgpt_account_id: 'another-account' },
    { account_id: 'another-account' },
    { chatgpt_user_id: 'another-user' },
    { organization_id: 'another-org' }
  ]
  for (const conflicting of claims) {
    const store = vault(t), identity = { chatgpt_account_id: 'account-one', chatgpt_user_id: 'user-one', organization_id: 'org-one' }
    const account = saveOAuthAccount(store, { ...tokens(), idToken: jwt({ 'https://api.openai.com/auth': identity }), accessToken: jwt({ 'https://api.openai.com/auth': identity }, -1) })
    const authority = new TokenAuthority(store, async () => ({
      access_token: jwt({ 'https://api.openai.com/auth': { ...identity, ...conflicting } }), refresh_token: 'must-not-persist'
    }))
    t.after(() => authority.stop())
    await assert.rejects(authority.ensure(account.id), /身份/)
    assert.deepEqual(store.read().accounts[0].credentials, account.credentials)
  }
  assert.throws(() => parseTokens({
    id_token: tokens().idToken,
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'another-account' } })
  }), /身份/)
})

test('late refresh cannot resurrect deleted accounts or overwrite newly logged-in credentials', async t => {
  for (const remove of [true, false]) {
    const store = vault(t)
    const account = saveOAuthAccount(store, tokens())
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const authority = new TokenAuthority(store, async () => { await gate; return { access_token: tokens('late').accessToken, id_token: tokens().idToken, refresh_token: 'late' } })
    const refreshing = authority.ensure(account.id, { force: true })
    store.transaction(state => { if (remove) state.accounts = []; else state.accounts[0].credentials = tokens('new-login') })
    release()
    if (remove) { await assert.rejects(refreshing, /已删除/); assert.equal(store.read().accounts.length, 0) }
    else { await refreshing; assert.equal(store.read().accounts[0].credentials.refreshToken, 'fake-refreshnew-login') }
    await authority.stop()
  }
  assert.throws(() => parseTokens({ access_token: 'new', id_token: jwt({}, -5) }, tokens()), /有效/)
  assert.throws(() => parseTokens({ access_token: 'new', id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'wrong-account' } }) }, tokens()), /身份/)
})

test('quota parser keeps absent/unknown windows unknown and supports review/additional windows', () => {
  const result = parseQuota({ plan_type: 'pro', rate_limit: { allowed: true, primary_window: { limit_window_seconds: 18000, reset_after_seconds: 60 } }, code_review_rate_limit: { primary_window: { used_percent: 120 } }, additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { secondary_window: { used_percent: 25, reset_at: 123456 } } }] }, 1000)
  assert.equal(result.plan, 'pro')
  assert.equal(result.quota.windows.length, 3)
  assert.equal(result.quota.windows[0].usedPercent, undefined)
  assert.equal(result.quota.windows[0].resetsAt, 61000)
  assert.equal(result.quota.windows[1].usedPercent, 100)
  assert.equal(result.quota.windows[2].resetsAt, 123456000)
  assert.equal(parseQuota({}).quota.windows.length, 0)
})

test('quota 401 refreshes once, sends account identity, persists real usage, and retains prior data on errors', async t => {
  const store = vault(t)
  const account = saveOAuthAccount(store, tokens())
  let rotations = 0, requests = 0, rotatedAccess = ''
  const authority = new TokenAuthority(store, async () => {
    rotations++
    rotatedAccess = tokens('quota').accessToken!
    return { access_token: rotatedAccess, id_token: tokens().idToken, refresh_token: 'quota-next' }
  })
  let fail = false,projected=0,projectionFails=false
  const service = new QuotaService(store, authority, async (url, init) => {
    if (!url.endsWith('/usage')) throw new HTTPError(403, '查询订阅')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['ChatGPT-Account-Id'], 'account-one')
    requests++
    if (fail) throw new HTTPError(429, '查询用量')
    if (requests === 1) throw new HTTPError(401, '查询用量')
    assert.equal(headers.Authorization, `Bearer ${rotatedAccess}`)
    return { plan_type: 'team', rate_limit: { primary_window: { used_percent: 42, reset_after_seconds: 90 } } }
  },undefined,current=>{
    projected++
    assert.deepEqual(store.read().accounts.find(value=>value.id===current.id)?.quota,current.quota,'Quota must persist before runtime projection')
    if(projectionFails)throw new Error('fixture routing projection failed')
  })
  service.start([account.id]); await service.settled()
  assert.equal(rotations, 1); assert.equal(requests, 2)
  assert.equal(store.snapshot().accounts[0].quota?.windows[0].usedPercent, 42)
  assert.equal(store.snapshot().accounts[0].plan, 'team')
  assert.equal(projected,1)
  fail = true
  service.start([account.id]); await service.settled()
  assert.equal(service.current().failed, 1)
  assert.match(store.snapshot().accounts[0].error!, /429/)
  assert.equal(store.snapshot().accounts[0].quota?.windows[0].usedPercent, 42)
  assert.equal(projected,1,'A failed upstream read must not publish an empty quota')
  fail=false;projectionFails=true
  service.start([account.id]);await service.settled()
  assert.equal(service.current().failed,1);assert.equal(projected,2)
  assert.equal(store.snapshot().accounts[0].quota?.windows[0].usedPercent,42)
  assert.match(store.snapshot().accounts[0].error!,/routing projection failed/)
  projectionFails=false;service.start([account.id]);await service.settled()
  assert.equal(service.current().failed,0);assert.equal(projected,3);assert.equal(store.snapshot().accounts[0].error,undefined)
  await service.stop(); await authority.stop()
})

test('batch quota refresh bounds concurrency, supports cancellation, and leaves cancelled accounts unchanged', async t => {
  const store = vault(t)
  const ids: string[] = []
  for (let i = 0; i < 8; i++) ids.push(saveOAuthAccount(store, { ...tokens(String(i)), accountId: `a-${i}` }).id)
  let active = 0, maximum = 0
  const authority = new TokenAuthority(store)
  const service = new QuotaService(store, authority, async (_url, init) => {
    active++; maximum = Math.max(maximum, active)
    try { await delay(10_000, undefined, { signal: init?.signal ?? undefined }); return {} }
    finally { active-- }
  })
  service.start(ids)
  assert.throws(() => service.start(ids), /正在进行/)
  await until(() => active === 3)
  service.cancel(); await service.settled()
  assert.equal(maximum, 3)
  assert.equal(service.current().cancelled, true)
  assert.equal(service.current().failed, 0)
  assert.equal(store.snapshot().accounts.some(a => a.error || a.quota), false)
  await service.stop(); await authority.stop()
})

test('network errors omit upstream bodies and refuse credential-bearing redirects', async t => {
  let redirected = 0
  const target = createServer((_req, res) => { redirected++; res.end('{}') })
  const targetPort = await listen(target)
  const source = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}` }).end(); return }
    res.writeHead(401).end('{"error":"echo-secret-token"}')
  })
  const port = await listen(source)
  t.after(() => { for (const server of [source, target]) { server.close(); server.closeAllConnections() } })
  await assert.rejects(requestJSON(`http://127.0.0.1:${port}/`, {}, '测试'), error => {
    assert.ok(error instanceof HTTPError); assert.equal(error.message.includes('echo-secret'), false); return true
  })
  await assert.rejects(requestJSON(`http://127.0.0.1:${port}/redirect`, { headers: { Authorization: 'Bearer fake' } }))
  assert.equal(redirected, 0)
})

test('rotated refresh token survives a runtime projection failure', async t => {
  const store = vault(t), account = saveOAuthAccount(store, tokens())
  const authority = new TokenAuthority(store, async () => ({ access_token: tokens('durable').accessToken, id_token: tokens().idToken, refresh_token: 'durable-rotation' }), () => { throw new Error('runtime unavailable') })
  await assert.rejects(authority.ensure(account.id, { force: true }), /runtime unavailable/)
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'durable-rotation')
  await authority.stop()
})
