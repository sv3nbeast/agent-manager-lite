import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { prepareClaudeSubscriptionCredentials, updateClaudeSubscriptionCredentials, releaseClaudeSubscriptionCredentials } from '../src/main/claudeCodeSubscription'

function account() {
  return parseClaudeCodeAccountImport(JSON.stringify({ name: 'Synthetic subscription', claudeAiOauth: {
    accessToken: 'sk-ant-oat01-synthetic-access', refreshToken: 'synthetic-vault-refresh-only', expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference'],
  } })).accounts[0]
}

test('Claude subscription credentials rotate live with nonce ownership and never copy a refresh token', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aml-subscription-projection-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const plan = { directory, nonce: 'synthetic-owner' }, before = account(), path = join(directory, '.credentials.json')
  prepareClaudeSubscriptionCredentials(plan, before)
  const first = readFileSync(path, 'utf8')
  assert.equal(lstatSync(path).mode & 0o777, 0o600)
  assert.equal(first.includes(before.credentials.refreshToken!), false)
  assert.equal(JSON.parse(first).claudeAiOauth.refreshToken, null)
  assert.deepEqual(JSON.parse(first).claudeAiOauth.scopes, ['user:inference', 'user:profile'])
  assert.throws(() => prepareClaudeSubscriptionCredentials(plan, before), /已有独立登录/)
  assert.throws(() => updateClaudeSubscriptionCredentials({ ...plan, nonce: 'another-owner' }, before), /其他来源/)
  const after = structuredClone(before); after.credentials.accessToken = 'sk-ant-oat01-synthetic-rotated'
  updateClaudeSubscriptionCredentials(plan, after)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth.accessToken, after.credentials.accessToken)
  assert.equal(releaseClaudeSubscriptionCredentials({ ...plan, nonce: 'another-owner' }), false)
  assert.equal(existsSync(path), true)
  assert.equal(releaseClaudeSubscriptionCredentials(plan), true)
  assert.equal(existsSync(path), false)
})

test('Claude subscription cleanup preserves client edits and preparation rejects links, expiry and gateway destinations', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aml-subscription-preserve-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const plan = { directory, nonce: 'synthetic-owner' }, value = account(), path = join(directory, '.credentials.json')
  prepareClaudeSubscriptionCredentials(plan, value)
  const changed = JSON.parse(readFileSync(path, 'utf8')); changed.claudeAiOauth.accessToken = 'user-replaced-login'
  const raw = JSON.stringify(changed); writeFileSync(path, raw)
  assert.throws(() => updateClaudeSubscriptionCredentials(plan, value), /其他来源/)
  assert.equal(releaseClaudeSubscriptionCredentials(plan), false)
  assert.equal(readFileSync(path, 'utf8'), raw)
  rmSync(path); symlinkSync(join(directory, 'missing'), path)
  assert.throws(() => prepareClaudeSubscriptionCredentials(plan, value), /已有独立登录/)
  rmSync(path)
  assert.throws(() => prepareClaudeSubscriptionCredentials(plan, { ...value, baseUrl: 'https://gateway.invalid' }), /官方 Anthropic/)
  assert.throws(() => prepareClaudeSubscriptionCredentials(plan, { ...value, credentials: { ...value.credentials, expiresAt: Date.now() - 1 } }), /已过期/)
  assert.throws(() => prepareClaudeSubscriptionCredentials(plan, { ...value, credentials: { ...value.credentials, scope: 'user:profile' } }), /模型调用权限/)
  assert.equal(existsSync(path), false)
})

test('Claude OAuth import preserves declared expiry and scope so expired access-only tokens cannot look fresh', () => {
  const expired = Date.now() - 3_600_000
  const parsed = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-token', expires_at: expired, scope: 'user:profile user:inference' }))
  assert.equal(parsed.preview.errors.length, 0)
  assert.equal(parsed.accounts[0].credentials.expiresAt, expired)
  assert.equal(parsed.accounts[0].credentials.scope, 'user:inference user:profile')
  const conflict = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-token', expires_at: expired, credentials: { expiresAt: expired + 1 } }))
  assert.match(conflict.preview.errors[0], /到期时间来源冲突/)
})
