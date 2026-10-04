import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAPIAccount, editAccount, readAccountKey } from '../src/main/accounts'
import { Store, type StoredAccount } from '../src/main/store'

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'cml-account-key-read-')), encryptionKey = randomBytes(32)
  let writes = 0
  const store = new Store(directory, {
    encrypt(text) {
      writes++
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt(data) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12))
      decipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    }
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const account = createAPIAccount({ name: '独立连接', apiKey: 'fixture-independent-key', baseUrl: 'https://fixture.invalid/v1',
    models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', tags: [], note: '' })
  store.transaction(state => { state.accounts.push(account) })
  return { store, account, writes: () => writes, disk: () => readFileSync(join(directory, 'state.vault')) }
}

test('explicit account key reads support legacy revision zero without writing or exposing snapshots', t => {
  const f = fixture(t), before = f.store.read(), disk = f.disk(), writes = f.writes()
  assert.equal(f.account.revision, undefined)
  assert.equal(readAccountKey(f.store, { id: f.account.id, revision: 0 }), 'fixture-independent-key')
  assert.deepEqual(f.store.read(), before)
  assert.deepEqual(f.disk(), disk)
  assert.equal(f.writes(), writes)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-independent-key'), false)
  assert.equal(f.store.snapshot().accounts[0].credentialConfigured, true)
})

test('account key reads reject invalid selections and stale or deleted accounts', t => {
  const f = fixture(t), input = { id: f.account.id, revision: 0 }
  for (const invalid of [{ ...input, id: 'invalid' }, { ...input, revision: -1 }, { ...input, revision: 0.5 },
    { id: input.id }, { ...input, extra: 'field' }]) assert.throws(() => readAccountKey(f.store, invalid))
  assert.throws(() => readAccountKey(f.store, { ...input, id: randomUUID() }), /账号已删除/)
  editAccount(f.store, { ...input, changes: { note: 'edited' } })
  assert.throws(() => readAccountKey(f.store, input), /账号已被修改/)
  assert.equal(readAccountKey(f.store, { ...input, revision: 1 }), 'fixture-independent-key')
  f.store.transaction(state => { state.accounts = [] })
  assert.throws(() => readAccountKey(f.store, { ...input, revision: 1 }), /账号已删除/)
})

test('account key reads reject OAuth, provider-managed and missing credentials with credential-free errors', t => {
  const f = fixture(t)
  const variants: Array<{ account: StoredAccount; error: RegExp }> = [
    { account: { ...f.account, kind: 'oauth', credentials: { accessToken: 'fixture-oauth-token', apiKey: 'fixture-oauth-key' } }, error: /登录账号/ },
    { account: { ...f.account, providerId: randomUUID() }, error: /供应商管理/ },
    { account: { ...f.account, providerKeyId: randomUUID() }, error: /供应商管理/ },
    { account: { ...f.account, credentials: {} }, error: /未配置 API Key/ }
  ]
  for (const { account, error } of variants) {
    f.store.transaction(state => { state.accounts = [account] })
    const disk = f.disk(), writes = f.writes()
    assert.throws(() => readAccountKey(f.store, { id: account.id, revision: 0 }), caught => {
      assert.ok(caught instanceof Error)
      assert.match(caught.message, error)
      assert.equal(caught.message.includes('fixture-'), false)
      return true
    })
    assert.deepEqual(f.disk(), disk)
    assert.equal(f.writes(), writes)
  }
})

test('reading a key leaves normal account edit and running-connection protection intact', t => {
  const f = fixture(t), input = { id: f.account.id, revision: 0 }
  assert.equal(readAccountKey(f.store, input), 'fixture-independent-key')
  const before = f.store.read()
  assert.throws(() => editAccount(f.store, { ...input, changes: { apiKey: 'fixture-replacement-key' } }, () => true), /请先停止/)
  assert.deepEqual(f.store.read(), before)
  editAccount(f.store, { ...input, changes: { apiKey: 'fixture-replacement-key' } })
  assert.equal(readAccountKey(f.store, { ...input, revision: 1 }), 'fixture-replacement-key')
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-replacement-key'), false)
})
