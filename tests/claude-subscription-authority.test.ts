import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { saveClaudeSubscriptionAccount } from '../src/main/accounts'
import { ensureClaudeSubscriptionAccount } from '../src/main/claudeSubscriptionAuthority'
import { TokenAuthority } from '../src/main/tokens'
import type { JSONRequest } from '../src/main/network'

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'aml-claude-authority-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const account = saveClaudeSubscriptionAccount(store, {
    tokens: { accessToken: 'old-synthetic-access', refreshToken: 'old-synthetic-refresh', expiresAt: Date.now() - 1 },
    profile: { accountId: 'synthetic-user', organizationId: 'synthetic-org', fetchedAt: Date.now() }, metadata: { retrievedAt: Date.now() },
  })
  return { store, account }
}

test('Claude subscription refresh is serialized, account-routed and commits rotation without OpenAI endpoints', async t => {
  const { store, account } = fixture(t)
  let refreshes = 0
  const request: JSONRequest = async (url, init, _operation, route) => {
    assert.equal(route?.id, account.id)
    assert.equal(url.includes('openai'), false)
    if (url.endsWith('/token')) { refreshes++; assert.equal(JSON.parse(init.body as string).refresh_token, 'old-synthetic-refresh'); return { access_token: 'rotated-synthetic-access', refresh_token: 'rotated-synthetic-refresh', expires_in: 3600 } }
    if (url.endsWith('/profile')) return { account: { uuid: 'synthetic-user' }, organization: { uuid: 'synthetic-org' } }
    return { five_hour: { utilization: 2 } }
  }
  const authority = new TokenAuthority(store, async () => assert.fail('OpenAI authority reached'))
  authority.setClaudeSubscriptionAuthority((id, options) => ensureClaudeSubscriptionAccount(store, request, id, options))
  const [a, b] = await Promise.all([authority.ensure(account.id), authority.ensure(account.id)])
  assert.equal(refreshes, 1); assert.equal(a.credentials.accessToken, 'rotated-synthetic-access'); assert.deepEqual(a, b)
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'rotated-synthetic-refresh')
  await authority.ensure(account.id); assert.equal(refreshes, 1)
  await authority.stop()
})

for (const mutation of ['delete', 'relogin', 'restore'] as const) test(`Claude late refresh cannot ${mutation === 'delete' ? 'recreate deleted accounts' : 'overwrite '+mutation}`, async t => {
  const { store, account } = fixture(t)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const request: JSONRequest = async url => {
    if (url.endsWith('/token')) { await pending; return { access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 } }
    return {}
  }
  const refresh = ensureClaudeSubscriptionAccount(store, request, account.id)
  if (mutation === 'delete') store.transaction(state => { state.accounts = [] })
  else if (mutation === 'relogin') saveClaudeSubscriptionAccount(store, { tokens: { accessToken: 'new-login', refreshToken: 'new-refresh' }, profile: { accountId: 'synthetic-user', organizationId: 'synthetic-org', fetchedAt: Date.now() }, metadata: { retrievedAt: Date.now() } })
  else store.transaction(state => { state.accounts[0].generation = 'restored-generation' })
  release()
  await assert.rejects(refresh, /已删除|登录已改变/)
  assert.equal(JSON.stringify(store.read().accounts).includes('late-'), false)
  if (mutation === 'delete') assert.equal(store.read().accounts.length, 0)
})

test('Claude access-only tokens are usable until declared expiry and never sent to an unrelated refresh endpoint', async t => {
  const { store, account } = fixture(t)
  const request: JSONRequest = async () => assert.fail('access-only token must not refresh')
  store.transaction(state => { state.accounts[0].credentials = { accessToken: 'synthetic-setup-token' } })
  assert.equal((await ensureClaudeSubscriptionAccount(store, request, account.id)).credentials.accessToken, 'synthetic-setup-token')
  store.transaction(state => { state.accounts[0].credentials.expiresAt = Date.now() + 60_000 })
  await ensureClaudeSubscriptionAccount(store, request, account.id)
  store.transaction(state => { state.accounts[0].credentials.expiresAt = Date.now() - 1 })
  await assert.rejects(ensureClaudeSubscriptionAccount(store, request, account.id), /已过期/)
})
