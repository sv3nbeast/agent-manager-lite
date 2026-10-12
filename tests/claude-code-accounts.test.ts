import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { AccountFiles } from '../src/main/accountFiles'
import { Store } from '../src/main/store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAccountImport } from '../src/main/accounts'
import { sameUsageAccount } from '../src/main/providerUsage'

test('Claude API key import has Anthropic protocol and identity metadata', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({
    ANTHROPIC_API_KEY: 'sk-ant-api-fixture', name: 'Anthropic key', models: ['claude-sonnet-4-5'],
  }))
  assert.equal(result.preview.errors.length, 0)
  const account = result.accounts[0]
  assert.equal(account.kind, 'api_key')
  assert.equal(account.protocol, 'anthropic_messages')
  assert.equal(account.identityService, 'anthropic')
  assert.equal(account.credentialKind, 'anthropic_api_key')
  assert.equal(account.credentials.apiKey, 'sk-ant-api-fixture')
  assert.equal(account.wireApi, 'chat_completions')
})

test('Claude provider profile imports nested environment credentials', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({ profiles: {
    work: { provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'sk-ant-profile-fixture' }, model: 'claude-sonnet-4-5' },
  } }))
  assert.equal(result.preview.errors.length, 0)
  assert.equal(result.accounts[0].credentialKind, 'anthropic_api_key')
  assert.equal(result.accounts[0].credentials.apiKey, 'sk-ant-profile-fixture')
})

test('Claude bearer token is never parsed as OpenAI OAuth', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({
    ANTHROPIC_AUTH_TOKEN: 'bearer-fixture', provider: 'anthropic', name: 'Bearer',
  }))
  assert.equal(result.preview.errors.length, 0)
  const account = result.accounts[0]
  assert.equal(account.kind, 'api_key')
  assert.equal(account.credentialKind, 'anthropic_bearer')
  assert.equal(account.identityService, 'anthropic')
  assert.equal(account.credentials.apiKey, 'bearer-fixture')
  assert.equal(account.credentials.accessToken, undefined)
})

test('Claude OAuth import keeps OAuth credentials in the Anthropic boundary', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({
    claudeAiOauth: { accessToken: 'claude-oauth-fixture', refreshToken: 'claude-refresh-fixture' },
    authMethod: 'oauth', email: 'claude@example.invalid',
  }))
  assert.equal(result.preview.errors.length, 0)
  const account = result.accounts[0]
  assert.equal(account.kind, 'oauth')
  assert.equal(account.credentialKind, 'claude_ai_oauth')
  assert.equal(account.identityService, 'anthropic')
  assert.equal(account.credentials.accessToken, 'claude-oauth-fixture')
  assert.equal(account.credentials.refreshToken, 'claude-refresh-fixture')
  assert.equal(account.credentials.apiKey, undefined)
})

test('CLAUDE_CODE_OAUTH_TOKEN is classified as OAuth even without a provider marker', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-fixture' }))
  assert.equal(result.preview.errors.length, 0)
  assert.equal(result.accounts[0].kind, 'oauth')
  assert.equal(result.accounts[0].credentialKind, 'claude_ai_oauth')
  assert.equal(result.accounts[0].credentials.accessToken, 'oauth-token-fixture')
})

test('Claude OAuth token format is kept separate from API keys', () => {
  const result = parseClaudeCodeAccountImport('sk-ant-oat01-fixture')
  assert.equal(result.preview.errors.length, 0)
  assert.equal(result.accounts[0].kind, 'oauth')
  assert.equal(result.accounts[0].credentialKind, 'claude_ai_oauth')
  assert.equal(result.accounts[0].credentials.accessToken, 'sk-ant-oat01-fixture')
})

test('generic Codex importer skips Claude OAuth exports instead of treating them as OpenAI', () => {
  const result = parseAccountImport(JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-fixture', refresh_token: 'refresh-fixture' }))
  assert.equal(result.accounts.length, 0)
  assert.equal(result.preview.skipped, 1)
})

test('Claude source is sanitized before being retained for diagnostics', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({
    ANTHROPIC_API_KEY: 'sk-ant-secret-fixture', name: 'Sanitized', note: 'fixture',
  }))
  assert.equal(result.preview.errors.length, 0)
  assert.equal(JSON.stringify(result.accounts[0].source).includes('sk-ant-secret-fixture'), false)
})

test('AccountFiles routes Claude imports through the dedicated parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-import-'))
  const store = new Store(root, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const files = new AccountFiles(store)
  const staged = files.stage(JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-file-fixture' }), undefined, 'claude_code')
  assert.equal(staged.preview.errors.length, 0)
  const committed = files.commit(staged.ticket)
  assert.equal(committed.added, 1)
  assert.equal(store.read().accounts[0].identityService, 'anthropic')
})

test('Anthropic accounts are excluded from the OpenAI provider usage cache', () => {
  const account = parseClaudeCodeAccountImport(JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-usage-fixture' })).accounts[0]
  assert.equal(sameUsageAccount(account, account), false)
})
