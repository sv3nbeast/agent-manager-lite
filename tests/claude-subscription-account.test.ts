import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { markClaudeSubscriptionRefreshError, saveClaudeSubscriptionAccount } from '../src/main/accounts'
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
    const subscriptionExpiresAt = Date.now() + 86_400_000
    const account = saveClaudeSubscriptionAccount(store, result({ profile: { ...result().profile!, expiresAt: subscriptionExpiresAt } }))
    assert.equal(account.kind, 'oauth')
    assert.equal(account.identityService, 'anthropic')
    assert.equal(account.credentialKind, 'claude_ai_oauth')
    assert.equal(account.protocol, 'anthropic_messages')
    assert.equal(account.email, 'USER@example.invalid')
    assert.equal(account.claudeSubscription?.accountId, 'account-1')
    assert.equal(account.claudeSubscription?.organizationId, 'org-1')
    assert.equal(account.subscriptionActiveUntil, subscriptionExpiresAt)
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
    assert.ok(first.generation)
    const second = saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-two', expiresAt: Date.now() + 7_200_000 },
      profile: { accountId: 'account-1', organizationId: 'org-1', email: 'user@example.invalid', plan: 'max', fetchedAt: 1_700_000_100_000 },
    }))
    assert.equal(second.id, first.id)
    assert.notEqual(second.generation, first.generation)
    assert.equal(store.read().accounts.length, 1)
    const saved = store.read().accounts[0]
    assert.equal(saved.credentials.accessToken, 'access-two')
    assert.equal(saved.credentials.refreshToken, 'refresh-one')
    assert.equal(saved.plan, 'max')
    assert.equal(saved.claudeSubscription?.profileFetchedAt, 1_700_000_100_000)
    markClaudeSubscriptionRefreshError(store, first.id, first.generation)
    assert.equal(store.read().accounts[0]?.error, undefined)
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

test('TokenAuthority aborts a pending Claude subscription refresh when it stops', async () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result())
    let signal: AbortSignal | undefined
    const authority = new TokenAuthority(store)
    authority.setClaudeSubscriptionAuthority(async (_id, options) => {
      signal = options.signal
      await new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error('aborted'))
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const pending = authority.ensure(account.id, { force: true })
    await new Promise(resolve => setImmediate(resolve))
    await authority.stop()
    assert.equal(signal?.aborted, true)
    await assert.rejects(pending, /aborted/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription without a profile remains pending verification', () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result({ profile: undefined, usage: undefined }))
    assert.equal(account.claudeSubscription?.verifiedAt, undefined)
    assert.equal(account.claudeSubscription?.profileFetchedAt, undefined)
    assert.equal(account.plan, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription refresh keeps the existing account id and rejects identity changes', () => {
  const { store, directory } = storeFixture()
  try {
    const first = saveClaudeSubscriptionAccount(store, result())
    assert.throws(() => saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-rotated', refreshToken: 'refresh-rotated' },
      profile: { accountId: 'different-account', organizationId: 'org-1', fetchedAt: 1_700_000_100_000 },
    }), first.id), /身份不匹配/)
    assert.throws(() => saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-rotated-2', refreshToken: 'refresh-rotated-2' },
      profile: { accountId: 'account-1', organizationId: 'different-org', fetchedAt: 1_700_000_100_000 },
    }), first.id), /组织身份不匹配/)
    assert.equal(store.read().accounts[0]?.credentials.accessToken, 'access-one')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscriptions with different organizations do not merge on email alone', () => {
  const { store, directory } = storeFixture()
  try {
    const first = saveClaudeSubscriptionAccount(store, result())
    const second = saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-two', refreshToken: 'refresh-two' },
      profile: { accountId: 'account-2', organizationId: 'org-2', email: 'USER@example.invalid', fetchedAt: 1_700_000_100_000 },
    }))
    assert.notEqual(second.id, first.id)
    assert.equal(store.read().accounts.length, 2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscriptions with the same account id but different organizations stay separate', () => {
  const { store, directory } = storeFixture()
  try {
    const first = saveClaudeSubscriptionAccount(store, result())
    const second = saveClaudeSubscriptionAccount(store, result({
      tokens: { accessToken: 'access-org-two', refreshToken: 'refresh-org-two' },
      profile: { accountId: 'account-1', organizationId: 'org-2', email: 'USER@example.invalid', fetchedAt: 1_700_000_100_000 },
    }))
    assert.notEqual(second.id, first.id)
    assert.equal(store.read().accounts.length, 2)
    assert.equal(store.read().accounts.find(account => account.id === first.id)?.credentials.accessToken, 'access-one')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription usage details project into quota and survive a backup snapshot', () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result({
      usage: { windows: [{ id: 'extra_usage', utilization: 16, details: { isEnabled: true, monthlyLimit: 25, usedCredits: 4 } }], fetchedAt: 1_700_000_000_000 },
    }))
    assert.deepEqual(account.quota?.windows[0]?.details, { isEnabled: true, monthlyLimit: 25, usedCredits: 4 })
    assert.deepEqual(store.snapshot().accounts[0]?.quota?.windows[0]?.details, { isEnabled: true, monthlyLimit: 25, usedCredits: 4 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Claude subscription refresh failures persist a safe card error only for the same account generation', () => {
  const { store, directory } = storeFixture()
  try {
    const account = saveClaudeSubscriptionAccount(store, result())
    markClaudeSubscriptionRefreshError(store, account.id, account.generation)
    assert.equal(store.read().accounts[0]?.error, 'Claude 订阅刷新失败，请重新登录或稍后重试')
    store.transaction(state => { delete state.accounts[0]!.error; delete state.accounts[0]!.errorAt })
    store.transaction(state => { state.accounts[0]!.generation = 'replacement-generation' })
    markClaudeSubscriptionRefreshError(store, account.id, account.generation)
    assert.equal(store.read().accounts[0]?.error, undefined)
    markClaudeSubscriptionRefreshError(store, account.id, 'replacement-generation')
    assert.equal(store.read().accounts[0]?.error, 'Claude 订阅刷新失败，请重新登录或稍后重试')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
