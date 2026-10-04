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
import type { StoredAccount } from '../src/main/store'

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
  assert.deepEqual(parseSubscriptionSnapshot({ accounts: [{ account: { id: 'other', is_default: true }, entitlement: { subscription_plan: 'Pro', expires_at: 1791000000 } }] }, 'wanted'), { accountId: 'wanted' })
  assert.deepEqual(parseSubscriptionSnapshot({ account_id: 'other', subscription_plan: 'Pro', active_until: 1791000000 }, 'wanted'), { accountId: 'wanted' })
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
    assert.match((init?.headers as Record<string, string>)['User-Agent'], /^Mozilla\/5\.0 .*Chrome\//)
    assert.equal((init?.headers as Record<string, string>)['ChatGPT-Account-Id'], undefined)
    return { accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'chatgptplusplan', expires_at: new Date(activeUntil).toISOString() } }] }
  })
  t.after(async () => { await service.stop() })
  await service.refreshSubscriptionInfo(account.id)
  const saved = store.snapshot().accounts[0]
  assert.deepEqual(urls, [`https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${new Date().getTimezoneOffset()}`])
  assert.equal(saved.plan, 'plus')
  assert.equal(saved.subscriptionActiveUntil, activeUntil)
  assert.equal(saved.quota?.credits?.remaining, 5)
  assert.equal(saved.subscriptionQueryLastError, undefined)
})

function subscriptionFixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'cml-subscription-refresh-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url')}.signature`
  const account = saveOAuthAccount(store, { accessToken: jwt, idToken: jwt, accountId: 'fixture-account' })
  store.transaction(state => { state.settings.refreshMinutes = 0 })
  const tokens = new TokenAuthority(store)
  t.after(() => tokens.stop())
  return { store, account, tokens }
}

test('existing OAuth accounts recover the real token subscription date despite a previous web 403 cooldown', async t => {
  const f = subscriptionFixture(t), expiry = Date.now() + 30 * 86_400_000
  const idToken = `fixture.${Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000)+7200, 'https://api.openai.com/auth': {chatgpt_account_id:'fixture-account',chatgpt_plan_type:'plus',chatgpt_subscription_active_until:new Date(expiry).toISOString()}})).toString('base64url')}.signature`
  f.store.transaction(state=>{
    state.accounts[0].credentials.idToken=idToken
    state.accounts[0].subscriptionQueryLastError='查询订阅账号信息失败（HTTP 403）'
    state.accounts[0].subscriptionQueryNextRetryAt=Date.now()+30*60_000
    delete state.accounts[0].subscriptionActiveUntil
  })
  const urls:string[]=[]
  const service=new QuotaService(f.store,f.tokens,async url=>{
    urls.push(url)
    if(new URL(url).pathname.endsWith('/accounts/check/v4-2023-04-27'))return {accounts:[{account:{id:'fixture-account'},entitlement:{subscription_plan:'plus',expires_at:expiry+6*3600_000}}]}
    assert.equal(new URL(url).pathname,'/backend-api/wham/usage','automatic refresh can reuse the current login entitlement')
    return {plan_type:'plus',rate_limit:{primary_window:{used_percent:8}}}
  })
  t.after(()=>service.stop())
  service.start([f.account.id]);await service.settled();await service.subscriptionsSettled()
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil,expiry)
  assert.equal(f.store.snapshot().accounts[0].subscriptionQueryLastError,undefined)
  assert.equal(f.store.snapshot().accounts[0].quota?.windows[0].usedPercent,8)
  assert.equal(urls.length,1,'automatic refresh does not add an upstream web call for a current login entitlement')
  await service.refreshSubscriptionInfo(f.account.id)
  assert.equal(urls.length,2,'manual refresh explicitly retrieves the current web entitlement')
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil,expiry+6*3600_000)
})

test('an older token cannot roll back a newer web subscription date', async t => {
  const f=subscriptionFixture(t), oldExpiry=Date.now()+10*86_400_000, latestExpiry=Date.now()+40*86_400_000
  const idToken=`fixture.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200,iat:Math.floor(Date.now()/1000)-3600,'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account',chatgpt_subscription_active_until:oldExpiry}})).toString('base64url')}.signature`
  f.store.transaction(state=>{
    state.accounts[0].credentials.idToken=idToken
    state.accounts[0].subscriptionActiveUntil=latestExpiry
    state.accounts[0].subscriptionQueryLastSuccessAt=Date.now()
  })
  const calls:string[]=[]
  const service=new QuotaService(f.store,f.tokens,async url=>{calls.push(url);return {accounts:[{account:{id:'fixture-account'},entitlement:{subscription_plan:'plus',expires_at:latestExpiry}}]}})
  t.after(()=>service.stop())
  await service.refreshSubscriptionInfo(f.account.id)
  assert.equal(calls.length,1,'manual refresh must use the web rather than accept an older differing token claim')
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil,latestExpiry)
})

test('a subscription result cannot overwrite a same-access-token account whose ID Token changed in flight', async t => {
  for(const fail of [false,true]){
    const f=subscriptionFixture(t)
    let started!:()=>void,complete!:(value:Record<string,unknown>)=>void,reject!:(error:Error)=>void
    const waiting=new Promise<void>(resolve=>{started=resolve})
    const service=new QuotaService(f.store,f.tokens,async()=>{started();return await new Promise((resolve,fail)=>{complete=resolve;reject=fail})})
    t.after(()=>service.stop())
    const operation=service.refreshSubscriptionInfo(f.account.id).catch(()=>{})
    await waiting
    f.store.transaction(state=>{state.accounts[0].credentials.idToken='updated-id-token-same-access-token'})
    if(fail)reject(new HTTPError(403,'查询订阅账号信息'))
    else complete({accounts:[{account:{id:'fixture-account'},entitlement:{subscription_plan:'plus',expires_at:Date.now()+86_400_000}}]})
    await operation
    assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil,undefined)
    assert.equal(f.store.snapshot().accounts[0].subscriptionQueryLastError,undefined)
  }
})

test('ordinary quota refresh retrieves the real subscription using both web endpoints and caches it', async t => {
  const f = subscriptionFixture(t), expiry = Date.now() + 30 * 86_400_000
  const paths: string[] = []
  const service = new QuotaService(f.store, f.tokens, async (url, init, _operation, account) => {
    const target = new URL(url); paths.push(target.pathname)
    assert.equal(account?.id, f.account.id, 'subscription follows the account-selected network path')
    if (target.pathname.endsWith('/usage')) return { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 8 } } }
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['ChatGPT-Account-Id'], undefined)
    assert.match(headers['User-Agent'], /^Mozilla\/5\.0 .*Chrome\//)
    assert.equal(headers['x-openai-target-path'], target.pathname)
    if (target.pathname.endsWith('/v4-2023-04-27')) {
      assert.equal(target.searchParams.get('timezone_offset_min'), String(new Date().getTimezoneOffset()))
      return { accounts: { 'fixture-account': { account: { id: 'fixture-account', plan_type: 'plus' } } } }
    }
    assert.equal(target.pathname, '/backend-api/subscriptions')
    assert.equal(target.searchParams.get('account_id'), 'fixture-account')
    return { account_id: 'fixture-account', plan_type: 'plus', active_until: new Date(expiry).toISOString() }
  })
  t.after(() => service.stop())
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil, expiry)
  assert.equal(f.store.snapshot().accounts[0].quota?.windows[0].usedPercent, 8)
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  assert.deepEqual(paths, ['/backend-api/wham/usage', '/backend-api/accounts/check/v4-2023-04-27', '/backend-api/subscriptions', '/backend-api/wham/usage'])
})

test('slow subscription lookup does not hold quota completion and manual refresh reuses its in-flight request', async t => {
  const f = subscriptionFixture(t), expiry = Date.now() + 30 * 86_400_000
  let complete!: (value: Record<string, unknown>) => void, calls = 0
  const service = new QuotaService(f.store, f.tokens, async url => {
    if (url.endsWith('/usage')) return { rate_limit: { primary_window: { used_percent: 9 } } }
    calls++
    return new Promise(resolve => { complete = resolve })
  })
  t.after(() => service.stop())
  service.start([f.account.id]); await service.settled()
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.current().running, false)
  assert.equal(service.busy(), true)
  assert.equal(f.store.snapshot().accounts[0].quota?.windows[0].usedPercent, 9)
  const manual = service.refreshSubscriptionInfo(f.account.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  complete({ accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'Plus', expires_at: expiry } }] })
  await manual; await service.subscriptionsSettled()
  assert.equal(service.busy(), false)
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil, expiry)
})

test('subscription failures stay independent of successful quota, retain expiry and respect retry cooldown', async t => {
  const f = subscriptionFixture(t), expiry = Date.now() + 30 * 86_400_000
  f.store.transaction(state => { state.accounts[0].subscriptionActiveUntil = expiry })
  let calls = 0, fail = true
  const service = new QuotaService(f.store, f.tokens, async url => {
    if (url.endsWith('/usage')) return { rate_limit: { primary_window: { used_percent: 10 } } }
    calls++
    if (fail) throw new HTTPError(403, '查询订阅账号信息')
    return { accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'Plus', expires_at: expiry } }] }
  })
  t.after(() => service.stop())
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  const saved = f.store.snapshot().accounts[0]
  assert.equal(service.current().failed, 0)
  assert.equal(saved.error, undefined)
  assert.match(saved.subscriptionQueryLastError!, /403/)
  assert.equal(saved.subscriptionActiveUntil, expiry)
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  assert.equal(calls, 1)
  fail = false
  f.store.transaction(state => { state.accounts[0].subscriptionQueryNextRetryAt = Date.now() - 1 })
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  assert.equal(calls, 2)
  assert.equal(f.store.snapshot().accounts[0].subscriptionQueryLastError, undefined)
})

test('usage rejection does not prevent an independent subscription lookup or erase its usage error', async t => {
  const f = subscriptionFixture(t), expiry = Date.now() + 30 * 86_400_000
  const service = new QuotaService(f.store, f.tokens, async url => {
    if (url.endsWith('/usage')) throw new HTTPError(429, '查询用量')
    return { accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'Plus', expires_at: expiry } }] }
  })
  t.after(() => service.stop())
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  assert.equal(service.current().failed, 1)
  assert.match(f.store.snapshot().accounts[0].error!, /429/)
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil, expiry)
})

test('subscription queue is serial, cancellable after quota completion and ignores deleted or replaced accounts', async t => {
  const f = subscriptionFixture(t)
  const jwt = f.account.credentials.accessToken!
  const second = saveOAuthAccount(f.store, { accessToken: `${jwt}-second`, idToken: `${jwt}-second`, accountId: 'second-account' })
  assert.notEqual(second.id, f.account.id)
  let calls = 0, started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  const service = new QuotaService(f.store, f.tokens, async (url, init) => {
    if (url.endsWith('/usage')) return { rate_limit: {} }
    calls++; started()
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true })
    })
  })
  t.after(() => service.stop())
  service.start([f.account.id, second.id]); await service.settled(); await waiting
  assert.equal(calls, 1)
  assert.equal(service.busy(), true)
  service.cancel(); await service.subscriptionsSettled()
  assert.equal(calls, 1)
  assert.equal(service.busy(), false)
  assert.equal(f.store.snapshot().accounts.some(account => account.subscriptionQueryLastError || account.subscriptionActiveUntil), false)

  let complete!: (value: Record<string, unknown>) => void
  const replacement = new QuotaService(f.store, f.tokens, async url => {
    if (url.endsWith('/usage')) return { rate_limit: {} }
    return new Promise(resolve => { complete = resolve })
  })
  t.after(() => replacement.stop())
  replacement.start([f.account.id]); await replacement.settled()
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  f.store.transaction(state => { state.accounts[0].generation = 'replacement' })
  complete({ accounts: [{ account: { id: 'fixture-account' }, entitlement: { subscription_plan: 'Plus', expires_at: Date.now() + 86_400_000 } }] })
  await replacement.subscriptionsSettled()
  assert.equal(f.store.snapshot().accounts[0].subscriptionActiveUntil, undefined)
})

test('subscription discovery never changes the bound workspace or uses another account expiry', async t => {
  const f = subscriptionFixture(t)
  const service = new QuotaService(f.store, f.tokens, async url => {
    if (url.endsWith('/usage')) return { rate_limit: {} }
    if (url.includes('/accounts/check/')) return { accounts: [{ account: { id: 'other', is_default: true }, entitlement: { subscription_plan: 'Pro', expires_at: Date.now() + 86_400_000 } }] }
    assert.equal(new URL(url).searchParams.get('account_id'), 'fixture-account')
    return { account_id: 'other', subscription_plan: 'Pro', active_until: Date.now() + 86_400_000 }
  })
  t.after(() => service.stop())
  service.start([f.account.id]); await service.settled(); await service.subscriptionsSettled()
  const account = f.store.read().accounts[0]
  assert.equal(account.credentials.accountId, 'fixture-account')
  assert.equal(account.subscriptionActiveUntil, undefined)
  assert.notEqual(account.plan, 'Pro')
  assert.ok(account.subscriptionQueryLastError)
})

test('cancel or shutdown during a pending credential sync cannot start a new subscription request', async t => {
  for (const stop of [false, true]) {
    const f = subscriptionFixture(t)
    let complete!: (account: StoredAccount) => void, requests = 0
    f.tokens.ensure = async () => new Promise(resolve => { complete = resolve })
    const service = new QuotaService(f.store, f.tokens, async () => { requests++; return {} })
    t.after(() => service.stop())
    const manual = service.refreshSubscriptionInfo(f.account.id)
    const stopping = stop ? service.stop() : undefined
    if (!stop) service.cancel()
    complete(f.account)
    await manual; await stopping; await service.subscriptionsSettled()
    assert.equal(requests, 0)
    assert.equal(service.busy(), false)
    assert.equal(f.store.snapshot().accounts[0].subscriptionQueryLastError, undefined)
    if (stop) assert.throws(() => service.start([f.account.id]), /退出/)
  }
})

test('a manual credential-sync rejection records the independent subscription error without querying upstream', async t => {
  const f = subscriptionFixture(t)
  f.tokens.ensure = async () => { throw new Error('登录已过期，请重新登录') }
  const service = new QuotaService(f.store, f.tokens, async () => assert.fail('invalid credentials must not query subscription'))
  t.after(() => service.stop())
  await assert.rejects(service.refreshSubscriptionInfo(f.account.id), /登录已过期/)
  const account = f.store.snapshot().accounts[0]
  assert.match(account.subscriptionQueryLastError!, /登录已过期/)
  assert.ok(account.subscriptionQueryNextRetryAt! > Date.now())
  assert.equal(account.error, undefined)
})

test('restoring the account during manual credential sync discards the old subscription operation', async t => {
  const f = subscriptionFixture(t)
  let complete!: (account: StoredAccount) => void
  f.tokens.ensure = async () => new Promise(resolve => { complete = resolve })
  const service = new QuotaService(f.store, f.tokens, async () => assert.fail('old operation must not query restored credentials'))
  t.after(() => service.stop())
  const manual = service.refreshSubscriptionInfo(f.account.id)
  f.store.transaction(state => { state.accounts[0].generation = 'restored' })
  complete(f.store.read().accounts[0])
  await manual; await service.subscriptionsSettled()
  assert.equal(f.store.snapshot().accounts[0].subscriptionQueryLastAttemptAt, undefined)
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
