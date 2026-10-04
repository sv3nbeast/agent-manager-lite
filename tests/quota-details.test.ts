import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseQuota, parseResetCreditsSnapshot, parseSubscriptionSnapshot, parseSubscriptionTimestamp, QuotaService } from '../src/main/quota'
import { Store } from '../src/main/store'
import { saveOAuthAccount } from '../src/main/accounts'
import { TokenAuthority } from '../src/main/tokens'
import { HTTPError } from '../src/main/network'

const now = 1_790_000_000_000
test('subscription snapshots select the matching entitlement and normalize expiry timestamps', () => {
  assert.equal(parseSubscriptionTimestamp('1790000000'), 1790000000000)
  assert.equal(parseSubscriptionTimestamp('2026-10-02T00:00:00Z'), Date.parse('2026-10-02T00:00:00Z'))
  assert.equal(parseSubscriptionTimestamp(-1), undefined)
  assert.deepEqual(parseSubscriptionSnapshot({ accounts: [
    { account: { id: 'free', plan_type: 'free', is_default: true }, entitlement: { expires_at: '1791000000' } },
    { account: { id: 'wanted' }, entitlement: { subscription_plan: 'Plus', expires_at: '2026-10-03T00:00:00Z' } }
  ] }, 'wanted'), { accountId: 'wanted', plan: 'Plus', activeUntil: Date.parse('2026-10-03T00:00:00Z') })
  assert.deepEqual(parseSubscriptionSnapshot({ account_id: 'acct', subscription_plan: 'Pro', active_until: 1791000000 }), { accountId: 'acct', plan: 'Pro', activeUntil: 1791000000000 })
})

test('reset credit snapshots filter status and retain the next expiry', () => {
  const result = parseResetCreditsSnapshot({ availableCount: 7, credits: [
    { id: 'available', type: 'five_hour', expires_at: '2026-10-03T00:00:00Z' },
    { id: 'used', status: 'redeemed', expires_at: '2026-10-04T00:00:00Z' },
    { id: 'expired', expires_at: '2020-01-01T00:00:00Z' }
  ] }, Date.parse('2026-10-02T00:00:00Z'))
  assert.equal(result.availableCount, 7)
  assert.equal(result.credits[1].status, 'redeemed')
  assert.equal(result.credits[2].status, 'expired')
  assert.equal(result.nextExpiresAt, Date.parse('2026-10-03T00:00:00Z'))
})

test('manual subscription refresh queries account entitlement, persists expiry and keeps quota independent', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-subscription-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const store = new Store(directory, codec)
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`
  const account = saveOAuthAccount(store, { accessToken: jwt, idToken: jwt, accountId: 'fixture-account' })
  store.transaction(state => { state.accounts[0].quota = { updatedAt: now, windows: [], credits: { remaining: 5 } } })
  const urls: string[] = []
  const activeUntil = Date.now() + 24 * 60 * 60 * 1000
  const service = new QuotaService(store, new TokenAuthority(store), async (url, init) => {
    urls.push(url)
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${jwt}`)
    assert.equal((init?.headers as Record<string, string>)['x-openai-target-path'], '/backend-api/accounts/check/v4-2023-04-27')
    return { accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'Plus', expires_at: new Date(activeUntil).toISOString() } }] }
  })
  t.after(async () => { await service.stop() })
  await service.refreshSubscriptionInfo(account.id)
  const saved = store.snapshot().accounts[0]
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'])
  assert.equal(saved.plan, 'Plus')
  assert.equal(saved.subscriptionActiveUntil, activeUntil)
  assert.equal(saved.quota?.credits?.remaining, 5)
  assert.equal(saved.subscriptionQueryLastError, undefined)
})

test('reset credit query and explicit consume use separate authenticated requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-reset-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const store = new Store(directory, codec)
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
  const account = saveOAuthAccount(store, { accessToken: jwt, idToken: jwt })
  let count = 0; const methods: string[] = []
  const service = new QuotaService(store, new TokenAuthority(store), async (url, init) => {
    methods.push(`${init?.method ?? 'GET'} ${url}`)
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${jwt}`)
    if (init?.method === 'POST') { assert.match(String(init.body), /redeem_request_id/); return {} }
    count++
    return { credits: [{ id: `credit-${count}`, status: 'available', expires_at: '2026-10-03T00:00:00Z' }], available_count: 1 }
  })
  t.after(async () => { await service.stop() })
  await service.refreshResetCreditsInfo(account.id)
  assert.equal(store.snapshot().accounts[0].quota?.resetCreditsAvailable, 1)
  await service.consumeResetCredit(account.id)
  assert.deepEqual(methods.map(value => value.split(' ')[0]), ['GET', 'POST', 'GET'])
  assert.equal(store.snapshot().accounts[0].quota?.resetCredits?.length, 1)
})
test('monthly spend and additional credits stay separate, including zero and unlimited balances', () => {
  const quota = parseQuota({
    plan_type: 'business', rate_limit: { limit_reached: true },
    spend_control: { individual_limit: { limit: '25000', used: '8000', remaining_percent: 68, reset_at: 1_790_000_000 } },
    credits: { balance: '0', unlimited: true, unexpected: 'fixture-secret' },
    rate_limit_reset_credits: { available_count: 0 }
  }, now).quota
  assert.equal(quota.spendLimit?.remaining, 17000)
  assert.equal(quota.spendLimit?.remainingPercent, 68)
  assert.equal(quota.spendLimit?.used, 8000)
  assert.equal(quota.spendLimit?.resetsAt, now)
  assert.equal(quota.credits?.remaining, 0)
  assert.equal(quota.credits?.balance, 0)
  assert.equal(quota.credits?.unlimited, true)
  assert.equal(quota.resetCreditsAvailable, 0)
  assert.equal(quota.hasUsableCredits, true)
  assert.equal(JSON.stringify(quota).includes('fixture-secret'), false)
  assert.equal(parseQuota({ credits: { balance: '42' } }).quota.credits?.remaining, 42)
})

test('unknown credit data is never converted to zero or a fabricated balance', () => {
  for (const raw of [undefined, null, [], {}, { remaining: '', balance: 'NaN', unlimited: 'maybe' }, { balance: 'fixture-secret' }]) {
    assert.equal(parseQuota({ credits: raw }).quota.credits, undefined)
  }
  const partial = parseQuota({ spend_control: { individual_limit: { limit: 200 } }, credits: { unlimited: false } }).quota
  assert.equal(partial.spendLimit?.remaining, undefined)
  assert.equal(partial.spendLimit?.used, undefined)
  assert.equal(partial.credits?.remaining, undefined)
  assert.equal(partial.credits?.unlimited, false)
  for (const count of [-1, 0.5, Infinity, 'NaN', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseQuota({ rate_limit_reset_credits: { available_count: count } }).quota.resetCreditsAvailable, undefined)
  }
})

test('credit normalization retains source zero, handles case and timestamps, and rejects overflow', () => {
  const parse = (limit: unknown) => parseQuota({ SPEND_CONTROL: { INDIVIDUAL_LIMIT: limit } }, now).quota.spendLimit
  const exact = parse({ LIMIT: '50', USED: '10', REMAINING: 0, REMAINING_PERCENT: 0, RESET_AFTER_SECONDS: '0' })
  assert.equal(exact?.remaining, 0); assert.equal(exact?.remainingPercent, 0); assert.equal(exact?.resetsAt, now)
  assert.equal(parse({ limit: 50, used: 75, reset_at: String(now) })?.remaining, 0)
  assert.equal(parse({ limit: 50, used: 75, reset_at: String(now) })?.resetsAt, now)
  assert.equal(parse({ remaining_percent: 150, reset_at: -1, reset_after_seconds: 30 })?.remainingPercent, 100)
  assert.equal(parse({ remaining_percent: 150, reset_at: -1, reset_after_seconds: 30 })?.resetsAt, now + 30_000)
  const invalid = parse({ limit: 1e308, used: -1e308, reset_at: 1e308, reset_after_seconds: 1e308 })
  assert.equal(invalid?.remaining, undefined); assert.equal(invalid?.resetsAt, undefined)
  assert.equal(parse({ remaining_percent: 50, reset_after_seconds: -1 })?.resetsAt, undefined)
})

test('quota details persist through service snapshots and failures, then clear only on successful replacement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-credit-details-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const store = new Store(directory, codec)
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`
  const account = saveOAuthAccount(store, { accessToken: jwt, idToken: jwt, accountId: 'fixture-account' })
  store.transaction(state => { state.settings.refreshMinutes = 0 })
  const tokens = new TokenAuthority(store)
  let mode = 'ok'
  let release: ((value: Record<string, unknown>) => void) | undefined
  const service = new QuotaService(store, tokens, async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${jwt}`)
    if (mode === 'fail') throw new HTTPError(429, '用量')
    if (mode === 'hold') return new Promise(resolve => { release = resolve })
    return mode === 'empty' ? { rate_limit: {} } : { credits: { balance: 7.5 }, spend_control: { individual_limit: { limit: 100, used: 25 } } }
  })
  t.after(async () => { await service.stop(); await tokens.stop() })
  service.start([account.id]); await service.settled()
  const prior = store.snapshot().accounts[0].quota
  assert.equal(prior?.credits?.remaining, 7.5)
  assert.equal(prior?.spendLimit?.remaining, 75)
  assert.deepEqual(new Store(directory, codec).snapshot().accounts[0].quota, JSON.parse(JSON.stringify(prior)))
  mode = 'fail'; service.start([account.id]); await service.settled()
  assert.deepEqual(store.snapshot().accounts[0].quota, prior)
  mode = 'hold'; service.start([account.id])
  while (!release) await new Promise(resolve => setImmediate(resolve))
  service.cancel(); release({ credits: { balance: 999 } }); await service.settled()
  assert.deepEqual(store.snapshot().accounts[0].quota, prior)
  release = undefined; service.start([account.id])
  while (!release) await new Promise(resolve => setImmediate(resolve))
  store.transaction(state => { state.accounts[0].generation = 'replacement-account' })
  ;(release as (value: Record<string, unknown>) => void)({ credits: { balance: 999 } }); await service.settled()
  assert.deepEqual(store.snapshot().accounts[0].quota, prior)
  mode = 'empty'; service.start([account.id]); await service.settled()
  assert.equal(store.snapshot().accounts[0].quota?.credits, undefined)
  assert.equal(store.snapshot().accounts[0].quota?.spendLimit, undefined)
  assert.equal(store.snapshot().accounts[0].error, undefined)
})
