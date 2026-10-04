import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createAPIAccount, importParsedAccounts, parseAccountImport } from '../src/main/accounts'
import { Store, type VaultCodec } from '../src/main/store'

function api(extra: Record<string, unknown> = {}) {
  return { auth_mode: 'apikey', account_name: '中文供应商 · 工作', email: 'fixture@example.invalid', plan_type: 'provider-plan',
    openai_api_key: 'fixture-api-secret', api_base_url: 'https://example.invalid/CaseSensitive/v1',
    api_wire_api: 'responses', api_model_catalog: ['custom-MODEL'], tags: ['工作'], account_note: '中文备注 🧪', ...extra }
}
function parse(source: unknown) {
  const result = parseAccountImport(JSON.stringify(source))
  assert.deepEqual(result.preview.errors, [])
  assert.equal(result.accounts.length, 1)
  return result.accounts[0]
}
function jwt(payload: Record<string, unknown>) {
  return `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('compatible API imports preserve source fields, names, email, plan, timestamps and Fast', () => {
  const source = api({ app_speed: 'fast', created_at: 1_760_000_000, subscription_active_until: '1790000000',
    unknown_metadata: { nested: ['保留', 42] }, api_model_mappings: [{ client_model: 'client-alias', upstream_model: 'custom-MODEL' }] })
  const account = parse(source)
  assert.equal(account.name, source.account_name)
  assert.equal(account.email, source.email)
  assert.equal(account.plan, source.plan_type)
  assert.equal(account.defaultTier, 'fast')
  assert.equal(account.createdAt, 1_760_000_000_000)
  assert.equal(account.subscriptionActiveUntil, 1_790_000_000_000)
  assert.equal(account.baseUrl, source.api_base_url)
  assert.deepEqual(account.models, ['custom-MODEL'])
  assert.deepEqual(account.tags, ['工作'])
  assert.equal(account.note, '中文备注 🧪')
  assert.deepEqual(account.source, source)
  const preview = JSON.stringify(parseAccountImport(JSON.stringify(source)).preview)
  assert.equal(preview.includes('fixture-api-secret'), false)
})

test('compatible standard and legacy ultrafast stay standard; explicit defaults override app speed', () => {
  for (const speed of ['standard', 'ultrafast']) assert.equal(parse(api({ app_speed: speed })).defaultTier, 'standard')
  for (const tier of ['flex', 'auto', 'follow', 'inherit', 'standard']) {
    assert.equal(parse(api({ app_speed: 'fast', defaultTier: tier })).defaultTier, tier)
    assert.equal(parse(api({ app_speed: 'fast', default_tier: tier })).defaultTier, tier)
  }
  assert.equal(parse(api({ defaultTier: 'flex', default_tier: 'auto', app_speed: 'standard' })).defaultTier, 'flex')
  assert.equal(parse(api()).defaultTier, 'inherit')
})

test('null tags and an intentionally empty imported catalog are preserved without guessing a model', () => {
  const source = api({ tags: null, api_model_catalog: [], models: ['must-not-replace-empty-catalog'] })
  const account = parse(source)
  assert.deepEqual(account.models, [])
  assert.deepEqual(account.tags, [])
  assert.deepEqual(account.source, source)
  assert.deepEqual(parse({ ...source, api_model_catalog: undefined, models: [] }).models, [])
  assert.deepEqual(parse({ OPENAI_API_KEY: 'fixture-minimal-key' }).models, ['gpt-5.5'])
  assert.throws(() => createAPIAccount({ name: 'New account', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1', models: [],
    wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] }))
})

test('empty imported catalogs retain all other connection validation and secret-safe errors', () => {
  const invalid = [
    api({ api_model_catalog: [], api_wire_api: 'fixture-secret-wire' }),
    api({ api_model_catalog: [], api_base_url: 'https://fixture-secret@example.invalid/v1' }),
    api({ api_model_catalog: [], defaultTier: 'fixture-secret-tier' }),
    api({ api_model_catalog: [], tags: ['x'.repeat(41)] }),
    api({ api_model_catalog: ['x'.repeat(201)] })
  ]
  const result = parseAccountImport(JSON.stringify(invalid))
  assert.equal(result.accounts.length, 0)
  assert.equal(result.preview.errors.length, invalid.length)
  assert.equal(JSON.stringify(result.preview).includes('fixture-secret'), false)
  assert.equal(JSON.stringify(result.preview).includes('fixture-api-secret'), false)
})

test('OAuth identity, Chinese metadata and milliseconds are retained independently of the source JWT', () => {
  const token = jwt({ email: 'jwt@example.invalid', 'https://api.openai.com/auth': { account_id: 'workspace-one', chatgpt_plan_type: 'plus' } })
  const source = { auth_mode: 'oauth', account_name: '团队账号', email: 'source@example.invalid', plan_type: 'team',
    tokens: { access_token: token, refresh_token: 'fixture-refresh', id_token: token }, tags: null, app_speed: 'fast',
    createdAt: 1_760_000_000_111, created_at: 123, subscription_active_until: '2026-12-01T00:00:00Z' }
  const account = parse(source)
  assert.equal(account.kind, 'oauth')
  assert.equal(account.credentials.accountId, 'workspace-one')
  assert.equal(account.credentials.refreshToken, 'fixture-refresh')
  assert.equal(account.email, source.email)
  assert.equal(account.plan, 'team')
  assert.equal(account.defaultTier, 'fast')
  assert.equal(account.createdAt, source.createdAt)
  assert.equal(account.subscriptionActiveUntil, Date.parse('2026-12-01T00:00:00Z'))
  assert.deepEqual(account.source, source)
})

test('compatible timestamps tolerate missing or invalid optional metadata without creating invalid dates', () => {
  const before = Date.now()
  for (const date of [null, 'not-a-date', -1, 1e300]) {
    const account = parse(api({ created_at: date, subscription_active_until: date }))
    assert.ok(account.createdAt >= before && account.createdAt <= Date.now())
    assert.equal(account.subscriptionActiveUntil, undefined)
    assert.equal(account.source?.created_at, date)
  }
  assert.equal(parse(api({ created_at: 0 })).createdAt, 0)
  assert.equal(parse(api({ created_at: '1760000000' })).createdAt, 1_760_000_000_000)
  assert.equal(parse(api({ created_at: 1_760_000_000_000 })).createdAt, 1_760_000_000_000)
})

test('compatible OAuth remaining quota percentages become used windows with their original observation time', () => {
  const source = { tokens: { access_token: 'fixture-oauth' }, usage_updated_at: 1_760_000_000,
    quota: { hourly_percentage: 83, hourly_reset_time: 1_760_001_000, hourly_window_minutes: 300, hourly_window_present: true,
      weekly_percentage: 41, weekly_reset_time: 1_760_100_000, weekly_window_minutes: 10080, weekly_window_present: true,
      reset_credits_available: 2, reset_credits_next_expires_at: 1_770_000_000,
      reset_credits: [{ id: 'reset-one', status: 'available', reset_type: 'manual', granted_at: 1_760_000_000, expires_at: 1_770_000_000 }] } }
  const quota = parse(source).quota!
  assert.equal(quota.updatedAt, 1_760_000_000_000)
  assert.deepEqual(quota.windows.map(window => [window.id, window.usedPercent, window.durationSeconds, window.resetsAt]), [
    ['main.primary_window', 17, 18000, 1_760_001_000_000], ['main.secondary_window', 59, 604800, 1_760_100_000_000]
  ])
  assert.equal(quota.resetCreditsAvailable, 2)
  assert.equal(quota.resetCreditsNextExpiresAt, 1_770_000_000_000)
  assert.equal(quota.resetCredits?.[0].expiresAt, 1_770_000_000_000)
  assert.deepEqual(parse(source).source, source)
})

test('quota presence flags and provider money snapshots never invent ChatGPT windows', () => {
  const absent = { hourly_percentage: 100, weekly_percentage: 100, hourly_window_present: false, weekly_window_present: false }
  assert.equal(parse({ access_token: 'fixture-oauth', quota: absent }).quota, undefined)
  const one = parse({ access_token: 'fixture-oauth', quota: { ...absent, hourly_window_present: true, hourly_percentage: 60 } }).quota!
  assert.equal(one.windows.length, 1)
  assert.equal(one.windows[0].usedPercent, 40)
  assert.equal(one.updatedAt, 0) // No invented claim of a just-refreshed snapshot.
  const provider = api({ quota: { hourly_percentage: 40, hourly_window_present: true, raw_data: { usage: { total_available: 40 } } } })
  assert.equal(parse(provider).quota, undefined)
  assert.deepEqual(parse(provider).source?.quota, provider.quota)
})

test('known raw wham quota keeps exact usage and additional windows instead of rounded compatibility fields', () => {
  const source = { access_token: 'fixture-oauth', usage_updated_at: 1_760_000_000,
    quota: { hourly_percentage: 70, weekly_percentage: 20, raw_data: {
      rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 30.5, reset_after_seconds: 60, limit_window_seconds: 18000 } },
      code_review_rate_limit: { secondary_window: { used_percent: 7, reset_at: 1_760_100_000 } }
    } } }
  const quota = parse(source).quota!
  assert.equal(quota.windows.length, 2)
  assert.equal(quota.windows[0].usedPercent, 30.5)
  assert.equal(quota.windows[0].resetsAt, 1_760_000_060_000)
  assert.equal(quota.windows[1].id, 'review.secondary_window')
  assert.equal(quota.allowed, true)
  assert.equal(quota.limitReached, false)
})

test('compatible original metadata and credentials survive encrypted persistence and remain absent from renderer snapshots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-compatible-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  const codec: VaultCodec = {
    encrypt(value) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), bytes]) },
    decrypt(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8') }
  }
  const source = api({ api_model_catalog: [], tags: null, app_speed: 'fast', undocumented_secret: 'fixture-source-only-secret' })
  const account = parse(source), store = new Store(directory, codec)
  assert.deepEqual(importParsedAccounts(store, [account]), { added: 1, duplicates: 0 })
  assert.deepEqual(importParsedAccounts(store, [parse(source)]), { added: 0, duplicates: 1 })
  const reopened = new Store(directory, codec)
  assert.deepEqual(reopened.read().accounts[0].source, source)
  assert.equal(reopened.snapshot().accounts[0].defaultTier, 'fast')
  assert.deepEqual(reopened.snapshot().accounts[0].models, [])
  for (const secret of ['fixture-api-secret', 'fixture-source-only-secret']) {
    assert.equal(readFileSync(join(directory, 'state.vault')).includes(secret), false)
    assert.equal(JSON.stringify(reopened.snapshot()).includes(secret), false)
  }
})
