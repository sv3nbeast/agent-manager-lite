import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ChatGPTModels, type ChatGPTModelsOptions } from '../src/main/chatgptModels'
import { Store, type StoredAccount } from '../src/main/store'
import { saveOAuthAccount } from '../src/main/accounts'
import { TokenAuthority, TOKEN_ENDPOINT, type Tokens } from '../src/main/tokens'
import { AgentIdentityService } from '../src/main/agentIdentity'
import { createJSONRequest, HTTPError, type JSONRequest } from '../src/main/network'

function jwt(suffix = ''): string {
  return `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, suffix,
    'https://api.openai.com/auth': { chatgpt_account_id: 'official-account' } })).toString('base64url')}.fixture`
}
function credentials(suffix = ''): Tokens { return { accessToken: jwt(suffix), idToken: jwt(suffix), refreshToken: 'fixture-refresh' + suffix, accountId: 'official-account' } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() >= deadline) throw new Error('fixture condition timeout'); await delay(2) }
}
function fixture(t: TestContext, request: JSONRequest, options: Partial<ChatGPTModelsOptions> & { tokenRequest?: JSONRequest; agents?: AgentIdentityService } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cml-chatgpt-models-'))
  const store = new Store(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const account = saveOAuthAccount(store, credentials())
  const tokens = new TokenAuthority(store, options.tokenRequest ?? (async () => { throw new Error('unexpected fixture refresh') }))
  const models = new ChatGPTModels(store, tokens, request, options.agents, {
    resolveClientVersion: async applicationId => { assert.equal(applicationId, 'fixture-application'); return '0.155.0' }, timeoutMs: 1000,
    ...options
  })
  t.after(async () => { await models.stop(); await tokens.stop(); rmSync(directory, { recursive: true, force: true }) })
  return { store, account, tokens, models, request, directory, input: (extra = {}) => ({ accountId: account.id, requestId: randomUUID(), applicationId: 'fixture-application', ...extra }) }
}
const list = () => ({ models: [{ slug: 'future-official-model', priority: 0, visibility: 'list' }, { slug: 'other-official-model', priority: 4, visibility: 'list' }] })

test('official discovery uses the registered CLI version, fixed destination and account network context without saving its list', async t => {
  let count = 0
  const f = fixture(t, async (url, init, operation, account) => {
    count++
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://chatgpt.com'); assert.equal(parsed.pathname, '/backend-api/codex/models')
    assert.equal(parsed.searchParams.get('client_version'), '0.155.0')
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.body, undefined)
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${f.account.credentials.accessToken}`)
    assert.equal((init?.headers as Record<string, string>)['ChatGPT-Account-Id'], 'official-account')
    assert.match((init?.headers as Record<string, string>)['User-Agent'], /0\.155\.0/)
    assert.equal(operation, '获取 ChatGPT 官方模型'); assert.equal(account?.proxy?.mode, 'custom')
    return { models: [{ slug: 'old-model', priority: 9, visibility: 'list' }, { slug: 'future-official-model', priority: 0, visibility: 'list', supported_in_api: false, availability_nux: { message: 'intro' } },
      { slug: 'OLD-MODEL', priority: 15, visibility: 'list' }, { slug: 'hidden-model', priority: -1, visibility: 'hide' },
      { slug: 'upgrade-model', priority: -2, visibility: 'upgrade' }, { slug: 'missing-visibility', priority: -3 },
      { slug: 'selected-model', priority: 2, visibility: 'list', is_default: true }] }
  }, { now: () => 1000 })
  f.store.transaction(state => { state.accounts[0].baseUrl = 'https://wrong-destination.invalid/private'; state.accounts[0].proxy = { mode: 'custom', url: 'http://proxy.invalid:8080' } })
  const input = f.input(), result = await f.models.fetch(input)
  assert.deepEqual(result, { requestId: input.requestId, accountId: f.account.id, source: 'official', fetchedAt: 1000,
    models: ['future-official-model', 'selected-model', 'old-model'], defaultModelId: 'future-official-model' })
  assert.equal(count, 1); assert.deepEqual(f.store.read().accounts[0].models, [])
  assert.equal(JSON.stringify(result).includes('fixture-refresh'), false)
  assert.equal(readFileSync(join(f.directory, 'state.vault'), 'utf8').includes('future-official-model'), false)
})

test('official query uses the core release version while its user agent retains prerelease and build identifiers', async t => {
  const version = '0.155.0-alpha.2+build.7'
  const f = fixture(t, async (url, init) => {
    assert.equal(new URL(url).searchParams.get('client_version'), '0.155.0')
    assert.ok((init?.headers as Record<string, string>)['User-Agent'].includes(version))
    return list()
  }, { resolveClientVersion: async () => version })
  assert.equal((await f.models.fetch(f.input())).source, 'official')
})

test('process cache has a short TTL, preserves fetchedAt, copies arrays and supports an explicit official refresh', async t => {
  let requests = 0, now = 1000
  const f = fixture(t, async () => { requests++; return list() }, { now: () => now, cacheTTL: 100 })
  const initial = await f.models.fetch(f.input()); initial.models.push('caller-mutation')
  now = 1050
  const cached = await f.models.fetch(f.input())
  assert.equal(cached.source, 'cache'); assert.equal(cached.fetchedAt, 1000); assert.equal(requests, 1)
  assert.deepEqual(cached.models, ['future-official-model', 'other-official-model'])
  assert.equal((await f.models.fetch(f.input({ force: true }))).source, 'official'); assert.equal(requests, 2)
  now = 1151
  assert.equal((await f.models.fetch(f.input())).source, 'official'); assert.equal(requests, 3)
})

test('cache isolation includes restored account generation, identity, credentials, network and CLI application/version', async t => {
  let requests = 0, version = '0.155.0'
  const f = fixture(t, async () => { requests++; return list() }, { resolveClientVersion: async () => version })
  await f.models.fetch(f.input()); await f.models.fetch(f.input()); assert.equal(requests, 1)
  for (const mutation of [
    (account: StoredAccount) => { account.generation = randomUUID() },
    (account: StoredAccount) => { account.credentials.accountId = 'another-official-account' },
    (account: StoredAccount) => { account.credentials.accessToken = jwt('-new-login') },
    (account: StoredAccount) => { account.proxy = { mode: 'direct' } }
  ]) {
    f.store.transaction(state => mutation(state.accounts[0]))
    assert.equal((await f.models.fetch(f.input())).source, 'official')
  }
  assert.equal(requests, 5)
  await f.models.fetch(f.input({ applicationId: 'other-registered-application' })); assert.equal(requests, 6)
  version = '0.156.0'; await f.models.fetch(f.input({ applicationId: 'other-registered-application' })); assert.equal(requests, 7)
})

test('an upstream OAuth 401 refreshes once via the authority and retries with the new account token', async t => {
  let requests = 0, refreshes = 0
  const rotated = credentials('-rotated')
  const f = fixture(t, async (_url, init) => {
    requests++
    if (requests === 1) throw new HTTPError(401, 'fixture secret operation')
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${rotated.accessToken}`)
    return list()
  }, { tokenRequest: async (url, init) => {
    assert.equal(url, TOKEN_ENDPOINT); assert.equal(JSON.parse(String(init?.body)).refresh_token, 'fixture-refresh')
    refreshes++; return { access_token: rotated.accessToken, id_token: rotated.idToken, refresh_token: rotated.refreshToken }
  } })
  assert.equal((await f.models.fetch(f.input())).source, 'official'); assert.equal(requests, 2); assert.equal(refreshes, 1)
  assert.equal(f.store.read().accounts[0].credentials.refreshToken, rotated.refreshToken)
})

test('a competing authority rotation reuses the newer token after a rejection without refreshing it twice', async t => {
  let requests = 0
  const rotated = credentials('-already-rotated')
  const f = fixture(t, async (_url, init) => {
    requests++
    if (requests === 1) {
      f.store.transaction(state => { state.accounts[0].credentials = { ...state.accounts[0].credentials, ...rotated } })
      throw new HTTPError(401, 'fixture')
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${rotated.accessToken}`)
    return list()
  })
  assert.equal((await f.models.fetch(f.input())).source, 'official'); assert.equal(requests, 2)
})

test('a second 401 and other HTTP failures keep only sanitized status and never fall back to a builtin list', async t => {
  let requests = 0
  const f = fixture(t, async () => { requests++; throw new HTTPError(401, 'fixture credential leaked') }, {
    tokenRequest: async () => ({ access_token: credentials('-next').accessToken, id_token: credentials('-next').idToken, refresh_token: 'fixture-next' })
  })
  await assert.rejects(f.models.fetch(f.input()), error => { assert.match(String(error), /HTTP 401/); assert.equal(String(error).includes('credential leaked'), false); return true })
  assert.equal(requests, 2)
  for (const status of [403, 429, 500]) {
    const g = fixture(t, async () => { throw new HTTPError(status, 'fixture raw body') })
    await assert.rejects(g.models.fetch(g.input()), error => { assert.match(String(error), new RegExp(`HTTP ${status}`)); assert.equal(String(error).includes('raw body'), false); return true })
  }
})

test('invalid, empty, hidden-only and token-echoed official lists are rejected without caching fake availability', async t => {
  let body: Record<string, unknown> = { models: [] }
  const f = fixture(t, async () => body)
  for (const invalid of [{ models: [] }, { data: [{ id: 'unexpected-api-list' }] }, { models: [{ slug: 'bad\nmodel' }] },
    { models: [{ slug: 'bad', priority: 'first' }] }, { error: 'raw secret', models: [{ slug: 'usable', visibility: 'list' }] },
    { models: Array.from({ length: 1001 }, () => ({ slug: 'oversized-list' })) }]) {
    body = invalid; await assert.rejects(f.models.fetch(f.input()), /响应格式/)
  }
  for (const unavailable of [{ models: [{ slug: 'hidden', visibility: 'hide' }] }, { models: [{ slug: 'upgrade', visibility: 'upgrade' }] },
    { models: [{ slug: 'missing-visibility' }] }, { models: [{ slug: 'fixture-refresh', visibility: 'list' }] }]) { body = unavailable; await assert.rejects(f.models.fetch(f.input()), /未返回可用/); }
  body = list(); assert.equal((await f.models.fetch(f.input())).source, 'official')
})

test('request, token authority and version resolution errors do not disclose raw credentials or exception text', async t => {
  for (const mode of ['request', 'version', 'authority'] as const) {
    const secret = 'fixture-raw-secret-' + mode
    const f = fixture(t, async () => { throw new Error(secret) }, { resolveClientVersion: async () => { if (mode === 'version') throw new Error(secret); return '0.155.0' },
      tokenRequest: async () => { throw new Error(secret) } })
    if (mode === 'authority') f.store.transaction(state => { state.accounts[0].credentials.accessToken = 'fixture.expired.fixture'; state.accounts[0].credentials.idToken = undefined })
    await assert.rejects(f.models.fetch(f.input()), error => { assert.equal(String(error).includes(secret), false); assert.match(String(error), /获取官方模型失败/); return true })
  }
})

test('cancellation and timeout fence late network results, release concurrency and keep the cache empty', async t => {
  const gates: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
  const f = fixture(t, async () => { const gate = deferred<Record<string, unknown>>(); gates.push(gate); return gate.promise }, { timeoutMs: 40 })
  const input = f.input(), pending = f.models.fetch(input)
  const rejection = assert.rejects(pending, /取消/)
  await until(() => gates.length === 1); await f.models.cancel(input.requestId); await rejection
  gates[0].resolve(list()); await delay(2); assert.equal(f.models.busy(), false)
  const timeout = f.models.fetch(f.input()); await assert.rejects(timeout, /超时/)
  gates[1].resolve(list()); await delay(2)
  const retry = f.models.fetch(f.input()); await until(() => gates.length === 3); gates[2].resolve(list())
  assert.equal((await retry).source, 'official')
})

test('the overall timeout also bounds version lookup and credential refresh, and stop promptly cancels pending work', async t => {
  const version = deferred<string>()
  const f = fixture(t, async () => { throw new Error('network must not start') }, { resolveClientVersion: () => version.promise, timeoutMs: 30 })
  await assert.rejects(f.models.fetch(f.input()), /超时/); version.resolve('0.155.0')
  const refresh = deferred<Record<string, unknown>>(); let upstreamCalls = 0
  const refreshing = fixture(t, async () => { upstreamCalls++; return list() }, { tokenRequest: () => refresh.promise, timeoutMs: 30 })
  refreshing.store.transaction(state => { state.accounts[0].credentials.accessToken = 'fixture.expired.fixture' })
  await assert.rejects(refreshing.models.fetch(refreshing.input()), /超时/)
  refresh.resolve({ access_token: credentials('-late').accessToken, id_token: credentials('-late').idToken, refresh_token: 'fixture-late-refresh' })
  await until(() => !refreshing.tokens.busy(refreshing.account.id)); assert.equal(upstreamCalls, 0)
  const gate = deferred<Record<string, unknown>>()
  const g = fixture(t, () => gate.promise)
  const pending = g.models.fetch(g.input()), rejection = assert.rejects(pending, /取消/)
  await g.models.stop(); await rejection; assert.equal(g.models.busy(), false)
  gate.resolve(list()); await delay(2); assert.throws(() => g.models.fetch(g.input()), /退出/)
})

test('account deletion, restoration, identity changes, credential changes and proxy changes discard in-flight results', async t => {
  for (const change of [
    (store: Store) => store.transaction(state => { state.accounts = [] }),
    (store: Store) => store.transaction(state => { state.accounts[0].generation = randomUUID() }),
    (store: Store) => store.transaction(state => { state.accounts[0].credentials.accountId = 'changed-identity' }),
    (store: Store) => store.transaction(state => { state.accounts[0].credentials.accessToken = 'different-login-token' }),
    (store: Store) => store.transaction(state => { state.accounts[0].proxy = { mode: 'direct' } }),
    (store: Store) => store.transaction(state => { state.upstreamProxy = { mode: 'direct', revision: 1 } })
  ]) {
    const gate = deferred<Record<string, unknown>>(); let started = false
    const f = fixture(t, async () => { started = true; return gate.promise })
    const pending = f.models.fetch(f.input()), rejection = assert.rejects(pending, /已变化/)
    await until(() => started); change(f.store); gate.resolve(list()); await rejection
  }
})

test('per-account mutual exclusion and four-query ceiling preserve separate account scope', async t => {
  const gates: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
  const f = fixture(t, async () => { const gate = deferred<Record<string, unknown>>(); gates.push(gate); return gate.promise })
  const accounts = [f.account.id]
  f.store.transaction(state => { for (let n = 0; n < 4; n++) { const id = randomUUID(); accounts.push(id); state.accounts.push({ ...state.accounts[0], id }) } })
  const input = f.input(), first = f.models.fetch(input)
  assert.throws(() => f.models.fetch(f.input()), /正在获取/)
  const pending = [first, ...accounts.slice(1, 4).map(accountId => f.models.fetch(f.input({ accountId })))]
  assert.throws(() => f.models.fetch(f.input({ accountId: accounts[4] })), /繁忙/)
  await until(() => gates.length === 4); for (const gate of gates) gate.resolve(list())
  const results = await Promise.all(pending)
  assert.equal(new Set(results.map(result => result.accountId)).size, 4); assert.equal(f.models.busy(), false)
})

test('invalid IPC input and API-key accounts cannot send credential-bearing official requests', async t => {
  let requests = 0
  const f = fixture(t, async () => { requests++; return list() })
  for (const input of [f.input({ accountId: 'bad' }), f.input({ requestId: 'bad' }), f.input({ applicationId: '' }),
    f.input({ applicationId: 'x'.repeat(101) }), f.input({ force: 'yes' }), f.input({ url: 'https://arbitrary.invalid' })]) assert.throws(() => f.models.fetch(input))
  f.store.transaction(state => { state.accounts[0].kind = 'api_key' })
  assert.throws(() => f.models.fetch(f.input()), /ChatGPT 登录账号/); assert.equal(requests, 0)
})

test('the trusted version resolver cannot inject URL parameters or unrelated desktop version strings', async t => {
  for (const version of ['0.155.0&unsafe=true', 'https://arbitrary.invalid', '26.1007.11041 desktop', 'not-semver']) {
    let requests = 0
    const f = fixture(t, async () => { requests++; return list() }, { resolveClientVersion: async () => version })
    await assert.rejects(f.models.fetch(f.input()), /失败/); assert.equal(requests, 0)
  }
})

test('Agent Identity discovery uses a signed AgentAssertion and refreshes an invalid task once', async t => {
  const key = generateKeyPairSync('ed25519'), privateKey = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  let requests = 0, registrations = 0
  const f = fixture(t, async (_url, init) => {
    requests++
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['ChatGPT-Account-Id'], 'agent-account'); assert.equal(headers['X-OpenAI-Fedramp'], 'true')
    assert.match(headers.Authorization, /^AgentAssertion /)
    const envelope = JSON.parse(Buffer.from(headers.Authorization.split(' ')[1], 'base64url').toString())
    assert.ok(verify(null, Buffer.from(`${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`), key.publicKey, Buffer.from(envelope.signature, 'base64')))
    if (requests === 1) { assert.equal(envelope.task_id, 'old-task'); throw new HTTPError(401, 'fixture', 'agent_task_invalid') }
    assert.equal(envelope.task_id, 'new-task'); return list()
  })
  f.store.transaction(state => { state.accounts[0].kind = 'agent_identity'; state.accounts[0].credentials = { accountId: 'agent-account', agentIdentity: {
    agent_runtime_id: 'agent-runtime', agent_private_key: privateKey, task_id: 'old-task', account_id: 'agent-account', chatgpt_user_id: 'agent-user', chatgpt_account_is_fedramp: true } } })
  const agents = new AgentIdentityService(f.store, async () => { throw new Error('unused decrypt') }, async () => { registrations++; return { task_id: 'new-task' } })
  const service = new ChatGPTModels(f.store, f.tokens, f.request, agents, { resolveClientVersion: async () => '0.155.0', timeoutMs: 1000 })
  t.after(async () => { await service.stop(); await agents.stop() })
  const result = await service.fetch(f.input())
  assert.equal(result.source, 'official'); assert.equal(requests, 2); assert.equal(registrations, 1)
  assert.equal(JSON.stringify(result).includes(privateKey), false)
})

test('bounded transport errors and redirects remain sanitized through the model service', async t => {
  const request = createJSONRequest(async (_url, init) => {
    assert.equal(init.redirect, 'error')
    return new Response('fixture-raw-body-secret', { status: 403 })
  })
  const f = fixture(t, request)
  await assert.rejects(f.models.fetch(f.input()), error => { assert.match(String(error), /HTTP 403/); assert.equal(String(error).includes('raw-body-secret'), false); return true })
  const g = fixture(t, createJSONRequest(async () => new Response('invalid-json-with-secret', { status: 200 })))
  await assert.rejects(g.models.fetch(g.input()), error => { assert.equal(String(error).includes('invalid-json-with-secret'), false); return true })
})
