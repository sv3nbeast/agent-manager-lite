import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ClaudeSubscriptionOAuthService, CLAUDE_SUBSCRIPTION_OAUTH, safeClaudeSubscriptionMetadata } from '../src/main/claudeSubscriptionOAuth'

test('Claude subscription OAuth builds PKCE authorize URL and keeps secrets out of public status', async () => {
  let opened = ''
  const service = new ClaudeSubscriptionOAuthService({ open: async url => { opened = url }, timeoutMs: 10_000 })
  const status = await service.start()
  assert.equal(status.status, 'waiting')
  assert.equal(status.redirectUri, CLAUDE_SUBSCRIPTION_OAUTH.redirectUri)
  assert.ok(status.authorizationUrl)
  const auth = new URL(status.authorizationUrl!)
  assert.equal(auth.origin, 'https://claude.com')
  assert.equal(auth.searchParams.get('code'), 'true')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(createHash('sha256').update('a').digest('base64url').length, 43)
  assert.equal(opened, status.authorizationUrl)
  assert.equal('state' in status, false)
  assert.equal('verifier' in status, false)
  assert.equal(JSON.stringify(status).includes('token-fixture'), false)
  service.cancel()
})

test('Claude subscription OAuth verifies callback state, exchanges manual code, refreshes rotation, and returns safe metadata', async () => {
  let opened = '', saved: unknown
  const calls: { url: string; init?: RequestInit }[] = []
  const request = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    calls.push({ url, init })
    if (url.includes('/oauth/token')) {
      const body = String(init?.body ?? '')
      if (JSON.parse(body).grant_type === 'refresh_token') return { access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 }
      assert.equal(JSON.parse(body).code, 'manual-code')
      assert.ok(JSON.parse(body).code_verifier)
      return { access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_in: 3600, token_type: 'Bearer', scope: 'user:profile' }
    }
    if (url.includes('/profile')) return { account_uuid: 'account-1', organization_uuid: 'org-1', email_address: 'user@example.invalid', plan: 'pro', access_token: 'must-not-escape' }
    if (url.includes('/usage')) return { five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 22, resets_at: '2030-01-02T00:00:00Z' } }
    throw new Error('unexpected endpoint')
  }
  const service = new ClaudeSubscriptionOAuthService({ open: async url => { opened = url }, request, save: result => { saved = result } })
  const started = await service.start()
  const auth = new URL(opened)
  const callback = new URL(CLAUDE_SUBSCRIPTION_OAUTH.redirectUri)
  callback.search = new URLSearchParams({ code: 'wrong', state: 'wrong-state' }).toString()
  await assert.rejects(service.callback(callback.toString()), /state/)
  callback.search = new URLSearchParams({ code: 'manual-code', state: auth.searchParams.get('state')! }).toString()
  const success = await service.callback(callback.toString())
  assert.equal(success.status, 'success')
  assert.equal(calls.filter(call => call.url.includes('/oauth/token')).length, 1)
  const result = saved as { tokens: { accessToken: string; refreshToken?: string }; profile?: { accountId?: string; organizationId?: string; email?: string; plan?: string }; usage?: { windows: unknown[] }; metadata: unknown }
  assert.equal(result.tokens.accessToken, 'access-fixture')
  assert.equal(result.tokens.refreshToken, 'refresh-fixture')
  assert.equal(result.profile?.accountId, 'account-1')
  assert.equal(result.profile?.organizationId, 'org-1')
  assert.equal(result.profile?.email, 'user@example.invalid')
  assert.equal(result.profile?.plan, 'pro')
  assert.equal(result.usage?.windows.length, 2)
  assert.equal(JSON.stringify(result.metadata).includes('must-not-escape'), false)
  assert.equal(JSON.stringify(success).includes('access-fixture'), false)
  const refreshed = await service.refresh(result.tokens)
  assert.equal(refreshed.accessToken, 'access-rotated')
  assert.equal(refreshed.refreshToken, 'refresh-rotated')
  assert.equal(refreshed.tokenType, 'Bearer')
  assert.equal(refreshed.scope, 'user:profile')
})

test('Claude subscription manual code accepts code#state and metadata sanitizer removes nested secrets', async () => {
  let count = 0
  const service = new ClaudeSubscriptionOAuthService({ request: async (url, init) => {
    if (url.includes('/oauth/token')) { count++; assert.equal(JSON.parse(String(init?.body)).code, 'fixture'); return { access_token: 'opaque', refresh_token: 'rotate' } }
    return {}
  } })
  const status = await service.start()
  const state = new URL(status.authorizationUrl!).searchParams.get('state')!
  await service.manualCode(`fixture#${state}`)
  assert.equal(count, 1)
  const safe = safeClaudeSubscriptionMetadata({ account: { email: 'a@b.invalid', access_token: 'secret' }, refresh_token: 'secret2', nested: [{ authorizationCode: 'secret3', ok: true }] })
  assert.deepEqual(safe, { account: { email: 'a@b.invalid' }, nested: [{ ok: true }] })
})

test('Claude subscription profile maps organization type and usage keeps all OAuth windows', async () => {
  const headers: Record<string, string> = {}
  const service = new ClaudeSubscriptionOAuthService({ request: async (url, init) => {
    if (url.includes('/profile')) return {
      account: { uuid: 'account-2', email: 'profile@example.invalid' },
      organization: { uuid: 'org-2', name: 'Max org', organization_type: 'claude_max' },
    }
    if (url.includes('/usage')) {
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
      return {
        five_hour: { utilization: 11, resets_at: '2030-01-01T00:00:00Z' },
        seven_day: { utilization: 22, resets_at: '2030-01-02T00:00:00Z' },
        seven_day_sonnet: { utilization: 33, resets_at: '2030-01-03T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 25, used_credits: 4, utilization: 16 },
      }
    }
    throw new Error('unexpected endpoint')
  } })
  const profile = await service.profile({ accessToken: 'access-profile' })
  assert.equal(profile.accountId, 'account-2')
  assert.equal(profile.organizationId, 'org-2')
  assert.equal(profile.plan, 'max')
  const usage = await service.usage({ accessToken: 'access-profile' })
  assert.deepEqual(usage.windows.map(window => window.id), ['five_hour', 'seven_day', 'seven_day_sonnet', 'extra_usage'])
  assert.equal(usage.windows.find(window => window.id === 'seven_day_sonnet')?.utilization, 33)
  assert.deepEqual(usage.windows.find(window => window.id === 'extra_usage')?.details, { isEnabled: true, monthlyLimit: 25, usedCredits: 4 })
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20')
})
