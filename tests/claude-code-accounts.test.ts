import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { AccountFiles } from '../src/main/accountFiles'
import { Store } from '../src/main/store'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('AccountFiles routes Claude imports through the dedicated parser', t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-import-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const store = new Store(root, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const files = new AccountFiles(store)
  const staged = files.stage(JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-file-fixture' }), undefined, 'claude_code')
  assert.equal(staged.preview.errors.length, 0)
  const committed = files.commit(staged.ticket)
  assert.equal(committed.added, 1)
  assert.equal(store.read().accounts[0].identityService, 'anthropic')
})

test('Claude bearer aliases remain in credentials and never survive in retained source metadata', () => {
  for(const field of ['bearerToken','bearer_token','authToken','auth_token']){
    const result=parseClaudeCodeAccountImport(JSON.stringify({[field]:'fixture-private-bearer',provider:'anthropic',metadata:{client_secret:'fixture-private-client-secret'}}))
    assert.equal(result.accounts[0]?.credentials.apiKey,'fixture-private-bearer')
    assert.equal(JSON.stringify(result.accounts[0].source).includes('fixture-private'),false)
  }
})

test('Claude rejects competing API, Bearer and OAuth credential sources', () => {
  for(const extra of [{ANTHROPIC_AUTH_TOKEN:'fixture-token'},{CLAUDE_CODE_OAUTH_TOKEN:'fixture-oauth'},{credentialKind:'claude_ai_oauth'}]){
    const result=parseClaudeCodeAccountImport(JSON.stringify({ANTHROPIC_API_KEY:'fixture-api',...extra}))
    assert.equal(result.accounts.length,0)
    assert.match(result.preview.errors[0],/一种凭据/)
  }
})

test('nested gateway settings retain their endpoint and model with the matching credential', () => {
  const environment = {
    ANTHROPIC_AUTH_TOKEN: 'synthetic-gateway-credential',
    ANTHROPIC_BASE_URL: 'https://gateway.invalid/anthropic',
    ANTHROPIC_MODEL: 'gateway-model',
  }
  for (const source of [
    { env: environment }, { environment }, { config: { env: environment } },
    { settings: { env: environment } }, { settingsConfig: { env: environment } },
    { profiles: { work: { settings: { env: environment } } } },
  ]) {
    const result = parseClaudeCodeAccountImport(JSON.stringify(source))
    assert.deepEqual(result.preview.errors, [])
    assert.equal(result.accounts[0].baseUrl, 'https://gateway.invalid/anthropic')
    assert.deepEqual(result.accounts[0].models, ['gateway-model'])
    assert.equal(result.accounts[0].credentialKind, 'anthropic_bearer')
    assert.equal(result.accounts[0].credentials.apiKey, environment.ANTHROPIC_AUTH_TOKEN)
    assert.equal(JSON.stringify(result.accounts[0].source).includes(environment.ANTHROPIC_AUTH_TOKEN), false)
  }
})

test('Claude import rejects conflicting aliases without disclosing their values', () => {
  const candidates = [
    { ANTHROPIC_API_KEY: 'synthetic-private-first', apiKey: 'synthetic-private-second' },
    { ANTHROPIC_API_KEY: 'synthetic-private-first', settings: { env: { ANTHROPIC_API_KEY: 'synthetic-private-second' } } },
    { ANTHROPIC_AUTH_TOKEN: 'synthetic-private-first', auth: { bearerToken: 'synthetic-private-second' } },
    { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-private-first', credentials: { access_token: 'synthetic-private-second' } },
    { refreshToken: 'synthetic-private-first', oauth: { refresh_token: 'synthetic-private-second' } },
    { apiKey: 'synthetic-private-first', baseUrl: 'https://first.invalid', settings: { env: { ANTHROPIC_BASE_URL: 'https://second.invalid' } } },
    { apiKey: 'synthetic-private-first', model: 'model-a', env: { ANTHROPIC_MODEL: 'model-b' } },
    { apiKey: 'synthetic-private-first', models: ['model-a'], config: { models: ['model-b'] } },
  ]
  for (const source of candidates) {
    const result = parseClaudeCodeAccountImport(JSON.stringify(source))
    assert.equal(result.accounts.length, 0)
    assert.match(result.preview.errors[0], /来源冲突/)
    assert.equal(JSON.stringify(result.preview).includes('synthetic-private'), false)
  }
})

test('matching aliases and a declared default model import without changing the gateway route', () => {
  const result = parseClaudeCodeAccountImport(JSON.stringify({
    apiKey: 'synthetic-matching-key', ANTHROPIC_API_KEY: 'synthetic-matching-key',
    baseUrl: 'https://gateway.invalid/anthropic/', models: ['model-a', 'model-b'],
    settings: { env: { ANTHROPIC_API_KEY: 'synthetic-matching-key', ANTHROPIC_BASE_URL: 'https://gateway.invalid/anthropic', ANTHROPIC_MODEL: 'model-b' } },
  }))
  assert.deepEqual(result.preview.errors, [])
  assert.equal(result.accounts[0].baseUrl, 'https://gateway.invalid/anthropic')
  assert.deepEqual(result.accounts[0].models, ['model-b', 'model-a'])
})

test('declared invalid gateway settings never fall back to the official endpoint or model', () => {
  for (const environment of [
    { ANTHROPIC_BASE_URL: '' }, { ANTHROPIC_BASE_URL: null },
    { ANTHROPIC_BASE_URL: 'not-a-url' }, { ANTHROPIC_BASE_URL: { url: 'https://gateway.invalid' } },
    { ANTHROPIC_MODEL: '' }, { ANTHROPIC_MODEL: null },
    { models: [] }, { models: ['model-a'], ANTHROPIC_MODEL: 'model-b' },
  ]) {
    const result = parseClaudeCodeAccountImport(JSON.stringify({ apiKey: 'synthetic-key', settings: { env: environment } }))
    assert.equal(result.accounts.length, 0)
    assert.equal(result.preview.errors.length, 1)
  }
})

test('explicit OpenAI identity, protocol and credential declarations cannot be relabeled as Anthropic', () => {
  for (const declaration of [
    { identityService: 'openai' }, { identity_service: 'OpenAI' },
    { protocol: 'openai_responses' }, { api_protocol: 'openai_chat_completions' },
    { credentialKind: 'openai_api_key' }, { credential_kind: 'openai_oauth' },
    { provider: 'openai' }, { platform: 'codex' }, { service: 'chatgpt' }, { wireApi: 'responses' },
  ]) for (const source of [declaration, { settings: declaration }]) {
    const result = parseClaudeCodeAccountImport(JSON.stringify({ apiKey: 'synthetic-key', ...source }))
    assert.equal(result.accounts.length, 0)
    assert.match(result.preview.errors[0], /不能转换为 Claude/)
  }
})

test('unmarked generic keys and explicitly declared Anthropic bearer exports remain supported', () => {
  for (const source of [{ apiKey: 'synthetic-generic-key' }, { credentials: { api_key: 'synthetic-generic-key' } }]) {
    const result = parseClaudeCodeAccountImport(JSON.stringify(source))
    assert.deepEqual(result.preview.errors, [])
    assert.equal(result.accounts[0].credentialKind, 'anthropic_api_key')
    assert.equal(result.accounts[0].credentials.apiKey, 'synthetic-generic-key')
  }
  const bearer = parseClaudeCodeAccountImport(JSON.stringify({
    identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_bearer',
    credentials: { apiKey: 'synthetic-bearer-export' },
  }))
  assert.deepEqual(bearer.preview.errors, [])
  assert.equal(bearer.accounts[0].credentialKind, 'anthropic_bearer')
  assert.equal(bearer.accounts[0].credentials.apiKey, 'synthetic-bearer-export')
  for (const source of [
    { credentialKind: 'anthropic_bearer', ANTHROPIC_API_KEY: 'synthetic-key' },
    { credentialKind: 'anthropic_api_key', ANTHROPIC_AUTH_TOKEN: 'synthetic-token' },
  ]) assert.equal(parseClaudeCodeAccountImport(JSON.stringify(source)).accounts.length, 0)
})

test('Anthropic API keys use the provider usage cache while subscription OAuth stays separate', () => {
  const account = parseClaudeCodeAccountImport(JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-usage-fixture' })).accounts[0]
  assert.equal(sameUsageAccount(account, account), true)
  const subscription = { ...account, kind: 'oauth' as const, credentialKind: 'claude_ai_oauth' as const,
    credentials: { accessToken: 'fixture-oauth', refreshToken: 'fixture-refresh' } }
  assert.equal(sameUsageAccount(subscription, subscription), false)
  assert.equal(sameUsageAccount(subscription, account), false)
})
