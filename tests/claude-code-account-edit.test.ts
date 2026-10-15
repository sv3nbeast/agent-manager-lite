import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAPIAccount, editAccount, readAccountKey } from '../src/main/accounts'
import { claudeCodeAuthEnvironment } from '../src/main/claudeCodeInstanceAdapter'
import { QuotaService } from '../src/main/quota'
import { Store, type StoredAccount } from '../src/main/store'
import { TokenAuthority } from '../src/main/tokens'

const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
function fixture(t: { after(fn: () => void): void }, credentialKind: 'anthropic_api_key' | 'anthropic_bearer' | 'gateway' = 'anthropic_api_key') {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-edit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store(root, codec)
  const account = createAPIAccount({ name: 'Claude fixture', baseUrl: 'https://gateway.invalid/anthropic', apiKey: 'synthetic-saved-secret',
    models: ['model-a'], wireApi: 'chat_completions', protocol: 'anthropic_messages', identityService: 'anthropic', credentialKind,
    defaultTier: 'inherit', tags: ['old'], note: 'old note' })
  account.proxy = { mode: 'custom', url: 'socks5h://127.0.0.1:1080' }
  store.transaction(state => { state.accounts.push(account) })
  return { store, account, disk: () => readFileSync(join(root, 'state.vault')), current: () => store.read().accounts[0] }
}

test('Claude API Key and Bearer edits persist endpoint, models and credentials without changing their auth contract or proxy', t => {
  for (const credentialKind of ['anthropic_api_key', 'anthropic_bearer', 'gateway'] as const) {
    const f = fixture(t, credentialKind)
    editAccount(f.store, { id: f.account.id, revision: 0, changes: {
      name: 'Edited Claude', baseUrl: 'https://destination.invalid/anthropic', apiKey: 'synthetic-destination-secret', models: ['model-b', 'model-c'],
      tags: ['work', 'work'], note: 'Updated note',
    } })
    const changed = f.current()
    assert.equal(changed.revision, 1)
    assert.equal(changed.identityService, 'anthropic')
    assert.equal(changed.protocol, 'anthropic_messages')
    assert.equal(changed.credentialKind, credentialKind)
    assert.equal(changed.wireApi, f.account.wireApi)
    assert.equal(changed.baseUrl, 'https://destination.invalid/anthropic')
    assert.deepEqual(changed.models, ['model-b', 'model-c'])
    assert.equal(changed.name, 'Edited Claude')
    assert.equal(changed.note, 'Updated note')
    assert.deepEqual(changed.tags, ['work'])
    assert.deepEqual(changed.proxy, f.account.proxy)
    assert.deepEqual(claudeCodeAuthEnvironment(changed), { [credentialKind === 'anthropic_bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: 'synthetic-destination-secret' })
    assert.equal(readAccountKey(f.store, { id: changed.id, revision: 1 }), 'synthetic-destination-secret')
    assert.deepEqual(new Store(f.store.directory, codec).read().accounts[0], changed)
    assert.equal(JSON.stringify(f.store.snapshot()).includes('synthetic-'), false)
  }
})

test('Claude edits and explicit credential reads reject stale revisions atomically', t => {
  const f = fixture(t, 'anthropic_bearer')
  editAccount(f.store, { id: f.account.id, revision: 0, changes: { apiKey: 'synthetic-rotated-secret' } })
  const before = f.store.read(), disk = f.disk()
  assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes: { apiKey: 'synthetic-stale-secret', name: 'stale' } }), /已被修改/)
  assert.throws(() => readAccountKey(f.store, { id: f.account.id, revision: 0 }), /已被修改/)
  assert.deepEqual(f.store.read(), before)
  assert.deepEqual(f.disk(), disk)
})

test('running Claude connections reject changed routing, models and secrets while metadata stays editable', t => {
  const f = fixture(t), used: string[] = []
  const inUse = (id: string) => { used.push(id); return true }
  for (const changes of [{ apiKey: 'synthetic-replacement' }, { models: ['model-b'] }, { baseUrl: 'https://new.invalid', apiKey: 'synthetic-replacement' }]) {
    const before = f.disk()
    assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes }, inUse), /请先停止.*实例/)
    assert.deepEqual(f.disk(), before)
  }
  editAccount(f.store, { id: f.account.id, revision: 0, changes: { name: 'Still running', note: 'metadata', tags: ['running'] } }, inUse)
  assert.equal(f.current().name, 'Still running')
  assert.equal(f.current().credentials.apiKey, f.account.credentials.apiKey)
  assert.deepEqual(used, [f.account.id, f.account.id, f.account.id])
})

test('changing a Claude destination requires an explicitly supplied credential including when the same key is reused', t => {
  const f = fixture(t)
  assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes: { baseUrl: 'https://new.invalid' } }), /地址已更改.*重新填写/)
  assert.equal(f.current().baseUrl, f.account.baseUrl)
  editAccount(f.store, { id: f.account.id, revision: 0, changes: { baseUrl: f.account.baseUrl + '/' } })
  assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 1, changes: { baseUrl: f.account.baseUrl + '/other' } }), /重新填写/)
  editAccount(f.store, { id: f.account.id, revision: 1, changes: { baseUrl: 'https://new.invalid', apiKey: f.account.credentials.apiKey } })
  assert.equal(f.current().baseUrl, 'https://new.invalid')
  assert.equal(f.current().credentials.apiKey, f.account.credentials.apiKey)
})

test('Claude edits cannot change identity, auth kind or Anthropic Messages protocol or enable OpenAI-specific options', t => {
  const f = fixture(t)
  for (const changes of [
    { identityService: 'openai' }, { credentialKind: 'anthropic_bearer' }, { credentialKind: 'claude_ai_oauth' }, { protocol: 'openai_responses' },
    { wireApi: 'responses' }, { integrationType: 'auto' }, { modelContextWindows: { 'model-a': 200000 } },
  ]) {
    const before = f.disk()
    assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes }), /不可更改|Anthropic Messages/)
    assert.deepEqual(f.disk(), before)
  }
  const openAI = createAPIAccount({ name: 'OpenAI fixture', apiKey: 'synthetic-openai-key', baseUrl: 'https://openai.invalid/v1', models: ['openai-model'], wireApi: 'responses', note: '', tags: [], defaultTier: 'inherit' })
  f.store.transaction(state => { state.accounts = [openAI] })
  assert.throws(() => editAccount(f.store, { id: openAI.id, revision: 0, changes: { identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key' } }), /不可更改/)
  assert.equal(f.current().identityService, 'openai')
})

test('Claude subscription and unverified credentials remain metadata-only with no credential reads', t => {
  const f = fixture(t)
  for (const credentialKind of ['claude_ai_oauth', 'anthropic_profile', 'bedrock', 'vertex', 'foundry'] as const) {
    const account: StoredAccount = { ...f.account, credentialKind, kind: credentialKind === 'claude_ai_oauth' ? 'oauth' : 'api_key',
      credentials: credentialKind === 'claude_ai_oauth' ? { accessToken: 'synthetic-oauth-token', refreshToken: 'synthetic-refresh' } : { apiKey: 'synthetic-profile' } }
    f.store.transaction(state => { state.accounts = [account] })
    for (const changes of [{ apiKey: 'synthetic-replacement' }, { models: ['model-b'] }, { baseUrl: 'https://new.invalid' }]) {
      assert.throws(() => editAccount(f.store, { id: account.id, revision: 0, changes }), /仅支持|仅可/)
    }
    assert.throws(() => readAccountKey(f.store, { id: account.id, revision: 0 }), /登录账号|尚未支持/)
    editAccount(f.store, { id: account.id, revision: 0, changes: { name: 'Saved identity', note: 'metadata', tags: ['retained'] } })
    assert.deepEqual(f.current().credentials, account.credentials)
    assert.equal(f.current().credentialKind, credentialKind)
    assert.equal(f.current().baseUrl, account.baseUrl)
  }
})

test('invalid Claude connection fields and duplicate retargeting fail without a partial save', t => {
  const f = fixture(t)
  for (const changes of [{ apiKey: 'synthetic-private\nkey' }, { models: ['model\ninvalid'] }, { baseUrl: 'https://gateway.invalid/\npath', apiKey: 'synthetic-private' }]) {
    const before = f.disk()
    assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes }), error => {
      assert.equal(String(error).includes('synthetic-private'), false)
      return true
    })
    assert.deepEqual(f.disk(), before)
  }
  const duplicate = { ...f.account, id: randomUUID(), baseUrl: 'https://duplicate.invalid', credentials: { apiKey: 'synthetic-duplicate' } }
  f.store.transaction(state => { state.accounts.push(duplicate) })
  const before = f.disk()
  assert.throws(() => editAccount(f.store, { id: f.account.id, revision: 0, changes: { name: 'must rollback', baseUrl: duplicate.baseUrl, apiKey: duplicate.credentials.apiKey } }), /已存在/)
  assert.deepEqual(f.disk(), before)
})

test('Claude edits reconcile independent Anthropic key settings without scheduling OpenAI usage and token requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 })
  const f = fixture(t)
  f.store.transaction(state => {
    state.providers = [{ id: randomUUID(), name: 'OpenAI contract', revision: 0, baseUrl: f.account.baseUrl, models: ['openai-model'], wireApi: 'responses', defaultTier: 'inherit', keys: [], excludedKeyHashes: [], createdAt: 1, updatedAt: 1 }]
  })
  let upstreamCalls = 0
  const request = async () => { upstreamCalls++; throw new Error('OpenAI request must not run') }
  const authority = new TokenAuthority(f.store, request), quotas = new QuotaService(f.store, authority, request)
  t.after(async () => { await quotas.stop(); await authority.stop() })
  editAccount(f.store, { id: f.account.id, revision: 0, changes: { apiKey: 'synthetic-updated-key', models: ['model-b'] } })
  quotas.schedule()
  t.mock.timers.tick(24 * 60 * 60_000)
  await quotas.settled()
  assert.equal((await authority.ensure(f.account.id, { force: true })).credentials.apiKey, 'synthetic-updated-key')
  const provider=f.store.read().providers![0]
  assert.equal(provider.keys.length,1)
  assert.deepEqual(provider.keys[0].models,['model-b'])
  assert.equal(provider.keys[0].protocol,'anthropic_messages')
  assert.equal(provider.keys[0].credentialKind,'anthropic_api_key')
  assert.deepEqual(provider.models,['openai-model'])
  assert.equal(f.store.read().accounts[0].providerId,undefined)
  assert.equal(provider.revision,1)
  assert.equal(upstreamCalls, 0)
})
