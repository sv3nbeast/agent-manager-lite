import test from 'node:test'
import assert from 'node:assert/strict'
import {parseAccountImport} from '../src/main/accounts'
import {authFor,nativeConfig} from '../src/main/nativeAccountProjection'
import {settingsSchema} from '../src/shared/types'
import type {State} from '../src/main/store'
import {TomlDocument} from '../src/main/tomlPatch'

function token(workspace: string): string {
  return `fixture.${Buffer.from(JSON.stringify({iat: 1_700_000_000, exp: 2_000_000_000, email: `${workspace}@example.invalid`, 'https://api.openai.com/auth': {chatgpt_account_id: workspace, chatgpt_user_id: `${workspace}-user`}})).toString('base64url')}.signature`
}

function parse(value: unknown) {
  const result = parseAccountImport(JSON.stringify(value))
  assert.equal(result.preview.errors.length, 0, JSON.stringify(result.preview.errors))
  assert.equal(result.accounts.length, 1)
  return result.accounts[0]
}

test('native OAuth projection replaces mixed authentication fields while retaining unrelated data', () => {
  const access = token('native-account')
  const credentials = { access_token: access, id_token: access, refresh_token: 'fixture-refresh', account_id: 'native-account' }
  const account = parse({ auth_mode: 'chatgpt', tokens: credentials })
  const projected = JSON.parse(authFor(account, JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: 'stale-key', personal_access_token: 'stale-pat',
    last_refresh: '2020-01-01T00:00:00Z', account_id: 'stale-account',
    tokens: { access_token: 'stale-access', id_token: 'stale-id', refresh_token: 'stale-refresh', account_id: 'stale-account' },
    client_preference: { appearance: 'dark' }
  }))) as Record<string, unknown>
  assert.equal(projected.auth_mode, 'chatgpt')
  assert.equal(projected.OPENAI_API_KEY, null)
  assert.equal(projected.personal_access_token, undefined)
  assert.equal(projected.account_id, undefined)
  assert.equal(projected.last_refresh, new Date(1_700_000_000_000).toISOString())
  assert.deepEqual(projected.tokens, credentials)
  assert.equal(projected.client_preference && (projected.client_preference as Record<string, unknown>).appearance, 'dark')
})

test('an explicit personal access token never inherits a stale OAuth envelope', () => {
  const account = parse({ personal_access_token: 'at-fixture-explicit-pat' })
  const projected = JSON.parse(authFor(account, JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: 'old-access', refresh_token: 'old-refresh' }, custom: true
  }))) as Record<string, unknown>
  assert.equal(projected.auth_mode, undefined)
  assert.equal(projected.tokens, undefined)
  assert.equal(projected.personal_access_token, 'at-fixture-explicit-pat')
  assert.equal(projected.custom, true)
})

test('native OAuth config projection preserves client preferences and catalog fields', () => {
  const access = token('config-preserve')
  const account = parse({ auth_mode: 'chatgpt', tokens: { access_token: access, id_token: access, refresh_token: 'fixture-config-refresh' } })
  const state: State = { version: 1, settings: settingsSchema.parse({}), accounts: [account], groups: [] }
  const original = [
    'model = "client-selected"',
    'service_tier = "default"',
    'openai_base_url = "https://old-proxy.invalid/v1"',
    'model_catalog_json = "catalog-from-client"',
    'custom_scalar = "keep-me"',
    '[desktop]',
    'localeOverride = "en-US"',
    'appearanceTheme = "dark"',
    '[features]',
    'in_app_chat = true',
    'future_client_feature = true',
    ''
  ].join('\n')
  const result = nativeConfig(original, account, state, [], 'native')
  const doc = new TomlDocument(result.config)
  assert.equal(doc.scalar(['model_provider']), 'openai')
  assert.equal(doc.scalar(['openai_base_url']), null)
  assert.equal(doc.scalar(['model']), 'client-selected')
  assert.equal(doc.scalar(['service_tier']), 'default')
  assert.equal(doc.scalar(['model_catalog_json']), 'catalog-from-client')
  assert.equal(doc.scalar(['custom_scalar']), 'keep-me')
  assert.equal(doc.scalar(['desktop', 'localeOverride']), 'en-US')
  assert.equal(doc.scalar(['desktop', 'appearanceTheme']), 'dark')
  assert.equal(doc.scalar(['features', 'in_app_chat']), true)
  assert.equal(doc.scalar(['features', 'future_client_feature']), true)
})
