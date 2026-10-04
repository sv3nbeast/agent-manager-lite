import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { subscriptionFromToken } from '../src/main/subscriptionClaims'
import { parseAccountImport, saveOAuthAccount } from '../src/main/accounts'
import { TokenAuthority } from '../src/main/tokens'
import { Store } from '../src/main/store'
import { serializeAccounts } from '../src/main/accountFiles'
import { exportBackupState, validateBackup } from '../src/main/dataBackupState'

const workspace = 'workspace-one'
const expiry = '2026-10-22T14:07:21+00:00'
const expiryMs = Date.parse(expiry)
function jwt(auth: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400,
    email: 'subscription@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_plan_type: 'plus', ...auth }, ...extra })).toString('base64url')}.fixture`
}
function credentials(date: unknown = expiry) {
  return { accountId: workspace, idToken: jwt({ chatgpt_subscription_active_until: date }), accessToken: jwt(), refreshToken: 'fixture-refresh' }
}
function vault(t: { after(fn: () => void): void }): Store {
  const directory = mkdtempSync(join(tmpdir(), 'cml-subscription-claims-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return new Store(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
}

test('ID Token subscription date works when the access token has no subscription claim', () => {
  assert.deepEqual(subscriptionFromToken(credentials()), { accountId: workspace, activeUntil: expiryMs, plan: 'plus' })
  const token = jwt({ chatgpt_subscription_active_until: '2026-11-03T00:00:00Z' })
  assert.equal(subscriptionFromToken({ ...credentials(), accessToken: token })?.activeUntil, expiryMs)
})

test('subscription date requires a matching bound workspace and cannot use token expiry', () => {
  assert.equal(subscriptionFromToken({ ...credentials(), accountId: undefined }), undefined)
  assert.equal(subscriptionFromToken({ ...credentials(), accountId: 'other-workspace' }), undefined)
  assert.equal(subscriptionFromToken({ ...credentials(), idToken: jwt({ chatgpt_account_id: undefined }) }), undefined)
  assert.equal(subscriptionFromToken({ ...credentials(), idToken: jwt({ account_id: 'other-workspace' }) }), undefined)
  assert.equal(subscriptionFromToken({ accountId: workspace, idToken: jwt(), accessToken: jwt() }), undefined)
  assert.equal(subscriptionFromToken({ accountId: workspace, idToken: 'not-a-jwt', accessToken: 'opaque-access-token' }), undefined)
})

test('access token fallback remains scoped to its own matching workspace', () => {
  const accessToken = jwt({ chatgpt_subscription_active_until: expiryMs / 1000 })
  assert.equal(subscriptionFromToken({ accountId: workspace, accessToken })?.activeUntil, expiryMs)
  assert.equal(subscriptionFromToken({ accountId: workspace, idToken: jwt({ chatgpt_account_id: 'other', chatgpt_subscription_active_until: '2027-01-01T00:00:00Z' }), accessToken })?.activeUntil, expiryMs)
  assert.equal(subscriptionFromToken({ accountId: workspace, accessToken: jwt({ chatgpt_account_id: undefined, account_id: workspace, chatgpt_subscription_active_until: expiry }) })?.activeUntil, expiryMs)
})

test('absolute subscription timestamps accept seconds, milliseconds and explicit zones; malformed dates stay unknown', () => {
  for (const value of [expiry, expiryMs, expiryMs / 1000, String(expiryMs), String(expiryMs / 1000)]) {
    assert.equal(subscriptionFromToken(credentials(value))?.activeUntil, expiryMs)
  }
  for (const value of [null, {}, [], false, -1, 0, 1e100, 'not-a-date', '11/03/2026', '2026-11-03', '2026-11-03T00:00:00', '2026-02-30T00:00:00Z']) {
    assert.equal(subscriptionFromToken(credentials(value)), undefined)
  }
  // A real expired subscription is still an expiry, not a valid current plan.
  assert.equal(subscriptionFromToken(credentials('2020-01-01T00:00:00Z'))?.activeUntil, Date.parse('2020-01-01T00:00:00Z'))
})

test('OAuth login and later login updates persist subscription claims without changing the bound account', t => {
  const store = vault(t)
  const saved = saveOAuthAccount(store, credentials())
  assert.equal(saved.subscriptionActiveUntil, expiryMs)
  assert.equal(store.snapshot().accounts[0].subscriptionActiveUntil, expiryMs)
  const next = '2026-11-22T14:07:21+00:00'
  const updated = saveOAuthAccount(store, { ...credentials(next), idToken: jwt({ chatgpt_subscription_active_until: next }, { iat: Math.floor(Date.now() / 1000) }) })
  assert.equal(updated.id, saved.id)
  assert.equal(updated.credentials.accountId, workspace)
  assert.equal(updated.subscriptionActiveUntil, Date.parse(next))
  assert.equal(updated.subscriptionQueryLastSuccessAt, undefined)
  const missing = saveOAuthAccount(store, { ...credentials(), idToken: jwt() })
  assert.equal(missing.subscriptionActiveUntil, Date.parse(next))
})

test('OAuth imports project matching token dates, preserve source dates and leave other workspaces untouched', () => {
  const parse = (value: unknown) => {
    const imported = parseAccountImport(JSON.stringify(value))
    assert.deepEqual(imported.preview.errors, [])
    return imported.accounts[0]
  }
  const tokens = { id_token: credentials().idToken, access_token: credentials().accessToken }
  assert.equal(parse({ tokens }).subscriptionActiveUntil, expiryMs)
  assert.equal(parse({ account_id: 'other-workspace', tokens }).subscriptionActiveUntil, undefined)
  const sourceDate = '2026-12-01T00:00:00Z'
  assert.equal(parse({ tokens, subscription_active_until: sourceDate }).subscriptionActiveUntil, Date.parse(sourceDate))
  assert.equal(parse({ OPENAI_API_KEY: 'fixture-api-key', tokens }).subscriptionActiveUntil, undefined)
  assert.equal(parse({ access_token: jwt() }).subscriptionActiveUntil, undefined)
})

test('fresh ensure backfills old OAuth accounts from their existing token without any network request', async t => {
  const store = vault(t)
  const account = saveOAuthAccount(store, credentials())
  store.transaction(state => {
    delete state.accounts[0].subscriptionActiveUntil
    state.accounts[0].subscriptionQueryLastError = 'Prior Web HTTP 403'
  })
  const authority = new TokenAuthority(store, async () => { throw new Error('Network must not be contacted') })
  t.after(() => authority.stop())
  const current = await authority.ensure(account.id)
  assert.equal(current.subscriptionActiveUntil, expiryMs)
  assert.equal(current.credentials.accountId, workspace)
  assert.equal(store.snapshot().accounts[0].subscriptionActiveUntil, expiryMs)
  assert.equal(store.read().accounts[0].subscriptionQueryLastError, 'Prior Web HTTP 403')
  assert.equal(store.read().accounts[0].subscriptionQueryLastSuccessAt, undefined)
  assert.equal(JSON.stringify(store.snapshot()).includes('fixture-refresh'), false)
})

test('refresh stores a newly granted subscription date and retains the prior date when the claim is absent', async t => {
  const store = vault(t)
  const account = saveOAuthAccount(store, credentials())
  const next = '2026-11-22T14:07:21+00:00'
  let calls = 0
  const authority = new TokenAuthority(store, async () => ({ access_token: jwt({ call: ++calls }), refresh_token: `fixture-rotated-${calls}`,
    id_token: calls === 1 ? jwt({ chatgpt_subscription_active_until: next }, { iat: Math.floor(Date.now() / 1000) }) : jwt() }))
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, Date.parse(next))
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, Date.parse(next))
  assert.equal(store.read().accounts[0].credentials.accountId, workspace)
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'fixture-rotated-2')
})

test('externally maintained credentials also backfill only their current account generation', async t => {
  const store = vault(t)
  const account = saveOAuthAccount(store, credentials())
  store.transaction(state => {
    delete state.accounts[0].subscriptionActiveUntil
    state.clientAuthorities = [{ targetId: 'fixture-link', accountId: account.id, createdAt: Date.now() }]
  })
  const authority = new TokenAuthority(store, async () => { throw new Error('Local refresh must remain disabled') })
  t.after(() => authority.stop())
  authority.setExternalAuthority(async () => store.read().accounts[0])
  assert.equal((await authority.ensure(account.id)).subscriptionActiveUntil, expiryMs)
  store.transaction(state => { delete state.accounts[0].subscriptionActiveUntil })
  authority.setExternalAuthority(async () => {
    const stale = store.read().accounts[0]
    store.transaction(state => { state.accounts[0].generation = 'restored-generation' })
    return stale
  })
  await authority.ensure(account.id)
  assert.equal(store.snapshot().accounts[0].subscriptionActiveUntil, undefined)
})

test('token observation time comes only from the selected matching token and never token exp', () => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const idToken = jwt({ chatgpt_subscription_active_until: expiry }, { iat: issuedAt })
  assert.equal(subscriptionFromToken({ ...credentials(), idToken })?.observedAt, issuedAt * 1000)
  for (const iat of [undefined, '123', -1, 0, 1e100]) {
    assert.equal(subscriptionFromToken({ ...credentials(), idToken: jwt({ chatgpt_subscription_active_until: expiry }, { iat }) })?.observedAt, undefined)
  }
  assert.equal(subscriptionFromToken({ ...credentials(), idToken: jwt({ chatgpt_account_id: 'other', chatgpt_subscription_active_until: expiry }, { iat: issuedAt }) }), undefined)
})

test('fresh ensure and repeat login cannot downgrade a newer successful web subscription date', async t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials())
  const newerExpiry = Date.parse('2026-12-22T14:07:21+00:00'), checkedAt = Date.now()
  store.transaction(state => {
    state.accounts[0].subscriptionActiveUntil = newerExpiry
    state.accounts[0].subscriptionSource = 'web'
    state.accounts[0].subscriptionQueryLastSuccessAt = checkedAt
  })
  const authority = new TokenAuthority(store, async () => { throw new Error('No refresh needed') })
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(account.id)).subscriptionActiveUntil, newerExpiry)
  assert.equal(saveOAuthAccount(store, credentials()).subscriptionActiveUntil, newerExpiry)
  const differentOldIDToken = jwt({ chatgpt_subscription_active_until: expiry, nonce: 'old-reissue' }, { iat: Math.floor(checkedAt / 1000) - 10 })
  assert.equal(saveOAuthAccount(store, { ...credentials(), idToken: differentOldIDToken }).subscriptionActiveUntil, newerExpiry)
  const changedWithoutTime = jwt({ chatgpt_subscription_active_until: expiry, nonce: 'unknown-reissue' })
  assert.equal(saveOAuthAccount(store, { ...credentials(), idToken: changedWithoutTime }).subscriptionActiveUntil, newerExpiry)
  assert.equal(store.read().accounts[0].subscriptionQueryLastSuccessAt, checkedAt)
})

test('refresh preserves a valid web date even when a genuinely newer ID Token carries a differing date', async t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials())
  const webExpiry = Date.parse('2026-12-22T14:07:21+00:00'), checkedAt = Date.now()
  store.transaction(state => {
    state.accounts[0].subscriptionActiveUntil = webExpiry
    delete state.accounts[0].subscriptionSource
    state.accounts[0].subscriptionQueryLastSuccessAt = checkedAt
  })
  let calls = 0
  const authority = new TokenAuthority(store, async () => {
    calls++
    return { access_token: jwt({ call: calls }), refresh_token: `fixture-rotated-${calls}`,
      ...(calls === 2 ? { id_token: jwt({ chatgpt_subscription_active_until: expiry }, { iat: Math.floor(checkedAt / 1000) - 10 }) }
        : calls === 3 ? { id_token: jwt({ chatgpt_subscription_active_until: expiry }, { iat: Math.ceil(checkedAt / 1000) + 1 }) } : {}) }
  })
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, webExpiry, 'omitted ID Token reuses the previous token without rewriting the web observation')
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, webExpiry, 'a newly returned token issued before the web query is not a newer observation')
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, webExpiry, 'a new iat does not replace the valid legacy web observation')
})

test('fresh ensure preserves an explicitly imported subscription date instead of applying an older token claim', async t => {
  const store = vault(t), sourceDate = '2026-12-01T00:00:00Z'
  const imported = parseAccountImport(JSON.stringify({ account_id: workspace, tokens: {
    id_token: credentials().idToken, access_token: credentials().accessToken
  }, subscription_active_until: sourceDate }))
  store.transaction(state => { state.accounts.push(imported.accounts[0]) })
  const authority = new TokenAuthority(store, async () => { throw new Error('No refresh needed') })
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(imported.accounts[0].id)).subscriptionActiveUntil, Date.parse(sourceDate))
})

test('the real six-hour entitlement boundary remains a web date after fresh token issuance and repeated login', async t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials())
  const webDate = expiryMs + 6 * 60 * 60_000, issuedAt = Math.floor(Date.now() / 1000) + 1
  store.transaction(state => { state.accounts[0].subscriptionActiveUntil = webDate; state.accounts[0].subscriptionSource = 'web' })
  const idToken = jwt({ chatgpt_subscription_active_until: expiry }, { iat: issuedAt })
  const authority = new TokenAuthority(store, async () => ({ access_token: jwt({ rotated: true }), id_token: idToken }))
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(account.id, { force: true })).subscriptionActiveUntil, webDate)
  assert.equal(saveOAuthAccount(store, { ...credentials(), idToken }).subscriptionActiveUntil, webDate)
  assert.equal(store.snapshot().accounts[0].subscriptionSource, 'web')
})

test('an expired web date may recover from a current token without requiring a new token request', async t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials())
  store.transaction(state => {
    state.accounts[0].subscriptionActiveUntil = Date.now() - 1000
    state.accounts[0].subscriptionSource = 'web'
    state.accounts[0].subscriptionQueryLastSuccessAt = Date.now()
  })
  const authority = new TokenAuthority(store, async () => { throw new Error('No refresh needed') })
  t.after(() => authority.stop())
  assert.equal((await authority.ensure(account.id)).subscriptionActiveUntil, expiryMs)
  assert.equal(store.snapshot().accounts[0].subscriptionSource, 'token')
})

test('ordinary account export and snake/camel imports preserve the web boundary over the different JWT date', async t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials()), webDate = expiryMs + 6 * 60 * 60_000
  store.transaction(state => { state.accounts[0].subscriptionActiveUntil = webDate; state.accounts[0].subscriptionSource = 'web' })
  const exported = serializeAccounts(store.read().accounts)
  const imported = parseAccountImport(exported)
  assert.deepEqual(imported.preview.errors, [])
  assert.equal(imported.accounts[0].subscriptionActiveUntil, webDate)
  assert.equal(imported.accounts[0].subscriptionSource, 'web')
  const camel = parseAccountImport(JSON.stringify({ tokens: { accessToken: credentials().accessToken, idToken: credentials().idToken,
    accountId: workspace }, subscriptionActiveUntil: webDate, subscriptionSource: 'web' }))
  assert.equal(camel.accounts[0].subscriptionActiveUntil, webDate)
  assert.equal(camel.accounts[0].subscriptionSource, 'web')
  // Existing successful web snapshots without an explicit source stay protected
  // when exported through the ordinary account migration path.
  store.transaction(state => { delete state.accounts[0].subscriptionSource; state.accounts[0].subscriptionQueryLastSuccessAt = Date.now() })
  const legacy = parseAccountImport(serializeAccounts(store.read().accounts)).accounts[0]
  assert.equal(legacy.subscriptionActiveUntil, webDate)
  assert.equal(legacy.subscriptionSource, 'web')
  assert.equal(account.credentials.accountId, workspace)
})

test('strict portable backups preserve explicit and legacy subscription sources across restore validation', t => {
  const store = vault(t), account = saveOAuthAccount(store, credentials()), webDate = expiryMs + 6 * 60 * 60_000
  store.transaction(state => { state.accounts[0].subscriptionActiveUntil = webDate; state.accounts[0].subscriptionSource = 'web' })
  const bundle = validateBackup(JSON.parse(JSON.stringify(exportBackupState(store.read(), {}))))
  assert.equal(bundle.state.accounts[0].subscriptionActiveUntil, webDate)
  assert.equal(bundle.state.accounts[0].subscriptionSource, 'web')
  const restored = new Store(join(store.directory, 'restored'), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  restored.transaction(state => Object.assign(state, bundle.state))
  assert.equal(restored.snapshot().accounts[0].subscriptionActiveUntil, webDate)
  assert.equal(restored.snapshot().accounts[0].subscriptionSource, 'web')
  delete bundle.state.accounts[0].subscriptionSource
  bundle.state.accounts[0].subscriptionQueryLastSuccessAt = Date.now()
  assert.equal(validateBackup(bundle).state.accounts[0].subscriptionSource, undefined)
  const invalid = structuredClone(bundle)
  invalid.state.accounts[0].subscriptionSource = 'unrecognized' as never
  assert.throws(() => validateBackup(invalid), /备份内容格式无效/)
  assert.equal(account.id, restored.read().accounts[0].id)
})
