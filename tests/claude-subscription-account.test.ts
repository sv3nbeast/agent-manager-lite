import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { saveClaudeSubscriptionAccount } from '../src/main/accounts'
import { TokenAuthority } from '../src/main/tokens'
import type { ClaudeSubscriptionLoginResult } from '../src/main/claudeSubscriptionOAuth'

function storeFixture(): { store: Store; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cml-claude-subscription-'))
  const store = new Store(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  return { store, directory }
}

function result(overrides: Partial<ClaudeSubscriptionLoginResult> = {}): ClaudeSubscriptionLoginResult {
  return {
    tokens: { accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer', scope: 'user:profile user:inference' },
    profile: { accountId: 'account-1', organizationId: 'org-1', organizationName: 'Example', email: 'USER@example.invalid', plan: 'pro', fetchedAt: 1_700_000_000_000 },
    usage: { windows: [{ id: 'five_hour', utilization: 12, resetsAt: 1_700_000_360_000 }], fetchedAt: 1_700_000_000_000 },
    metadata: { retrievedAt: 1_700_000_000_000 },
    ...overrides,
  }
}

test('Claude subscription account is created with safe identity and quota projection', () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result())
    assert.equal(account.kind, 'oauth')
    assert.equal(account.identityService, 'anthropic')
    assert.equal(account.credentialKind, 'claude_ai_oauth')
    assert.equal(account.protocol, 'anthropic_messages')
    assert.equal(account.email, 'USER@example.invalid')
    assert.equal(account.claudeSubscription?.accountId, 'account-1')
    assert.equal(account.claudeSubscription?.organizationId, 'org-1')
    assert.equal(account.quota?.windows[0]?.usedPercent, 12)
    const snapshot = store.snapshot()
    const serialized = JSON.stringify(snapshot)
    assert.equal(serialized.includes('access-one'), false)
    assert.equal(serialized.includes('refresh-one'), false)
    assert.equal(snapshot.accounts[0]?.credentialConfigured, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription relogin deduplicates by account identity and preserves rotated refresh token', () => {
  const { store, directory } = storeFixture()
  try {
    const first = saveClaudeSubscriptionAccount(store, result())
    const second = saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-two', expiresAt: Date.now() + 7_200_000 },
      profile: { accountId: 'account-1', organizationId: 'org-1', email: 'user@example.invalid', plan: 'max', fetchedAt: 1_700_000_100_000 },
    }))
    assert.equal(second.id, first.id)
    assert.equal(store.read().accounts.length, 1)
    const saved = store.read().accounts[0]
    assert.equal(saved.credentials.accessToken, 'access-two')
    assert.equal(saved.credentials.refreshToken, 'refresh-one')
    assert.equal(saved.plan, 'max')
    assert.equal(saved.claudeSubscription?.profileFetchedAt, 1_700_000_100_000)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription without a profile remains pending verification', () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result({ profile: undefined, usage: undefined }))
    assert.equal(account.claudeSubscription?.verifiedAt, undefined)
    assert.equal(account.claudeSubscription?.profileFetchedAt, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('TokenAuthority delegates Claude subscription OAuth to Anthropic authority', async () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result())
    let delegated = 0
    let openaiEndpointCalled = false
    const authority = new TokenAuthority(store, async url => {
      openaiEndpointCalled = url.includes('auth.openai.com')
      throw new Error('unexpected OpenAI OAuth request')
    })
    authority.setClaudeSubscriptionAuthority(async id => {
      delegated++
      assert.equal(id, account.id)
      return store.read().accounts.find(value => value.id === id)!
    })
    const ensured = await authority.ensure(account.id, { force: true })
    assert.equal(ensured.id, account.id)
    assert.equal(delegated, 1)
    assert.equal(openaiEndpointCalled, false)
    await authority.stop()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
