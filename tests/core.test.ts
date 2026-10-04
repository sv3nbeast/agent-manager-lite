import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { resolveServiceTier } from '../src/shared/serviceTier'
import { Store, type VaultCodec } from '../src/main/store'
import { createAPIAccount, importIntoStore, parseAccountImport } from '../src/main/accounts'

test('service tier resolves explicit requests before instance/provider/global defaults', () => {
  for (const tier of ['default', 'priority', 'flex', 'auto']) assert.deepEqual(resolveServiceTier(tier, 'fast', 'fast', 'fast'), { tier, source: 'request' })
  assert.deepEqual(resolveServiceTier(undefined, 'fast'), { tier: 'priority', source: 'global' })
  assert.deepEqual(resolveServiceTier(null, 'fast', 'standard'), { tier: 'default', source: 'provider' })
  assert.deepEqual(resolveServiceTier('', 'standard', 'follow', 'fast'), { tier: 'priority', source: 'instance' })
  assert.deepEqual(resolveServiceTier(undefined, 'fast', 'follow'), { source: 'follow' })
  assert.throws(() => resolveServiceTier(1, 'fast'))
  assert.throws(() => resolveServiceTier('invalid', 'fast'))
})

test('encrypted atomic store persists settings, omits secrets from snapshots, and rolls back failed mutations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-manager-store-'))
  const key = randomBytes(32)
  const codec: VaultCodec = {
    encrypt(text) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]) },
    decrypt(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); cipher.setAuthTag(data.subarray(12,28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString() }
  }
  try {
    const store = new Store(directory, codec)
    store.transaction(state => { state.settings.defaultTier = 'fast'; state.accounts.push(createAPIAccount({ name: 'Test', apiKey: 'local-secret-never-render', baseUrl: 'http://127.0.0.1:9999/v1', models: ['gpt-5.5'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })) })
    assert.equal(new Store(directory, codec).snapshot().settings.defaultTier, 'fast')
    assert.equal(JSON.stringify(store.snapshot()).includes('local-secret-never-render'), false)
    assert.equal(readFileSync(join(directory, 'state.vault')).includes('local-secret-never-render'), false)
    assert.throws(() => store.transaction(state => { state.accounts = []; throw new Error('abort') }))
    assert.equal(store.snapshot().accounts.length, 1)
    importIntoStore(store, JSON.stringify({ OPENAI_API_KEY: 'another-test-key', models: ['gpt-5.5'] }))
    importIntoStore(store, JSON.stringify({ OPENAI_API_KEY: 'another-test-key', models: ['gpt-5.5'] }))
    assert.equal(store.snapshot().accounts.length, 2)
    const invalid = JSON.stringify([{ OPENAI_API_KEY: 'third-test' }, { tokens: {} }])
    assert.throws(() => importIntoStore(store, invalid))
    assert.equal(store.snapshot().accounts.length, 2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Codex auth import preview contains metadata and no credentials', () => {
  const raw = JSON.stringify({ tokens: { access_token: 'opaque-test-token', refresh_token: 'test-refresh', account_id: 'test-account' } })
  const result = parseAccountImport(raw)
  assert.equal(result.accounts[0].credentials.accountId, 'test-account')
  assert.equal(result.preview.entries[0].kind, 'oauth')
  assert.equal(JSON.stringify(result.preview).includes('test-refresh'), false)
})
