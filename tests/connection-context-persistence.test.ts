import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { deleteAccounts, editAccount, importParsedAccounts, parseAccountImport, saveOAuthAccount } from '../src/main/accounts'
import { AccountFiles, serializeAccounts } from '../src/main/accountFiles'
import { mutateProvider } from '../src/main/providerLibrary'
import { effectiveModelContextWindows } from '../src/main/providerModelContext'
import { AccountRecycle } from '../src/main/accountRecycle'
import { DataBackups } from '../src/main/dataBackups'
import { exportBackupState, validateBackup } from '../src/main/dataBackupState'

const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'cml-connection-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'vault'), codec)
  const current = (id: string) => store.read().accounts.find(a => a.id === id)!
  const set = (id: string, windows: Record<string, number>) => editAccount(store, { id, revision: current(id).revision ?? 0, changes: { modelContextWindows: windows } })
  const provider = () => store.read().providers![0]
  mutateProvider(store, { action: 'create', details: { name: 'Fixture provider', baseUrl: 'https://fixture.invalid/v1', models: ['alpha', 'beta'],
    modelContextWindows: { alpha: 400000, beta: 200000 } }, initialKey: { name: 'First connection', apiKey: 'fixture-first', createConnection: true } })
  let p = provider()
  mutateProvider(store, { action: 'addKey', id: p.id, revision: p.revision, name: 'Second connection', apiKey: 'fixture-second', createConnection: true })
  const [first, second] = store.read().accounts
  return { root, store, current, set, provider, first, second }
}

test('connection overrides persist independently through vault restart and supplier projection, and clear resumes inheritance', t => {
  const f = fixture(t)
  f.set(f.first.id, { alpha: 128000 })
  f.set(f.second.id, { alpha: 512000 })
  const p = f.provider()
  mutateProvider(f.store, { action: 'update', id: p.id, revision: p.revision, changes: { models: ['alpha', 'beta', 'new'], modelContextWindows: { alpha: 1000000, beta: 256000 } },
    keyChange: { keyId: f.current(f.first.id).providerKeyId, apiKey: 'fixture-rotated' } })
  const restarted = new Store(f.store.directory, codec)
  assert.deepEqual(restarted.snapshot().accounts.map(a => a.modelContextWindows), [{ alpha: 128000 }, { alpha: 512000 }])
  assert.deepEqual({ ...effectiveModelContextWindows(restarted.read(), restarted.read().accounts[0]).windows }, { alpha: 128000, beta: 256000 })
  f.set(f.first.id, {})
  assert.equal(f.current(f.first.id).modelContextWindows, undefined)
  assert.equal(effectiveModelContextWindows(f.store.read(), f.current(f.first.id)).windows?.alpha, 1000000)
  assert.deepEqual(f.current(f.second.id).modelContextWindows, { alpha: 512000 })
  assert.equal(f.provider().modelContextWindows?.alpha, 1000000)
})

test('connection validation rejects invalid windows and login edits atomically while allowing hidden-model declarations', t => {
  const f = fixture(t)
  const before = f.store.read()
  for (const value of [1, 0, -1, 2.5, 10000001, NaN, Infinity]) assert.throws(() => f.set(f.first.id, { alpha: value }))
  assert.deepEqual(f.store.read(), before)
  f.set(f.first.id, { alpha: 128000, hidden: 262144 })
  assert.deepEqual(f.current(f.first.id).modelContextWindows, { alpha: 128000, hidden: 262144 })
  assert.throws(() => editAccount(f.store, { id: f.first.id, revision: 0, changes: { modelContextWindows: {} } }), /已被修改/)
  const login = saveOAuthAccount(f.store, { accessToken: 'fixture-login-token', refreshToken: 'fixture-login-refresh' })
  for (const windows of [{}, { alpha: 128000 }]) assert.throws(() => editAccount(f.store, { id: login.id, revision: login.revision ?? 0, changes: { modelContextWindows: windows } }), /登录账号仅支持/)
  assert.equal(f.current(login.id).modelContextWindows, undefined)
})

for (const action of ['unlinkAccount', 'delete', 'removeKey', 'moveKey'] as const) test(`${action} preserves inherited and connection windows without changing other connections`, t => {
  const f = fixture(t)
  f.set(f.first.id, { alpha: 128000, hidden: 262144 })
  let p = f.provider()
  if (action === 'unlinkAccount') mutateProvider(f.store, { action, accountId: f.first.id, accountRevision: f.current(f.first.id).revision ?? 0 })
  else if (action === 'moveKey') {
    mutateProvider(f.store, { action: 'create', details: { name: 'Destination', baseUrl: 'https://destination.invalid/v1', models: ['alpha'] } })
    const target = f.store.read().providers![1]
    p = f.provider()
    mutateProvider(f.store, { action, id: p.id, revision: p.revision, keyId: f.current(f.first.id).providerKeyId, targetId: target.id, targetRevision: target.revision })
  } else mutateProvider(f.store, { action, id: p.id, revision: p.revision, ...(action === 'removeKey' ? { keyId: f.current(f.first.id).providerKeyId } : {}) })
  const detached = f.current(f.first.id)
  assert.equal(detached.providerId, undefined)
  assert.deepEqual(detached.modelContextWindows, { alpha: 128000, beta: 200000, hidden: 262144 })
  assert.equal(detached.baseUrl, 'https://fixture.invalid/v1')
  if (action === 'delete') assert.deepEqual(f.current(f.second.id).modelContextWindows, { alpha: 400000, beta: 200000 })
  else assert.equal(f.current(f.second.id).modelContextWindows, undefined)
})

test('standalone account exports retain effective windows and imports preserve existing overrides on duplicates', async t => {
  const f = fixture(t), files = new AccountFiles(f.store)
  t.after(() => files.stop())
  f.set(f.first.id, { alpha: 128000 })
  const original = f.store.read(), path = join(f.root, 'connections.json')
  await files.export([f.first.id, f.second.id], path)
  const parsed = parseAccountImport(readFileSync(path, 'utf8'))
  assert.deepEqual(parsed.preview.errors, [])
  assert.deepEqual(parsed.accounts.map(a => a.modelContextWindows), [{ alpha: 128000, beta: 200000 }, { alpha: 400000, beta: 200000 }])
  assert.deepEqual(f.store.read(), original, 'Export must not materialize inherited windows into live accounts')
  const duplicate = parseAccountImport(serializeAccounts([{ ...f.current(f.first.id), modelContextWindows: { alpha: 1000000 } }]))
  assert.equal(importParsedAccounts(f.store, duplicate.accounts).duplicates, 1)
  assert.deepEqual(f.current(f.first.id).modelContextWindows, { alpha: 128000 })
  for (const field of ['modelContextWindows', 'model_context_windows', 'api_model_context_windows']) {
    const imported = parseAccountImport(JSON.stringify({ apiKey: 'fixture-import', baseUrl: 'https://fixture.invalid/v1', models: ['alpha'], [field]: { alpha: 256000 } }))
    assert.deepEqual(imported.preview.errors, [])
    assert.deepEqual(imported.accounts[0].modelContextWindows, { alpha: 256000 })
  }
})

test('encrypted portable backup round-trip retains connection overrides, inheritance and recycled provider snapshots', async t => {
  const f = fixture(t), other = fixture(t)
  f.set(f.first.id, { alpha: 128000 })
  deleteAccounts(f.store, [f.first.id])
  const original = f.store.read()
  const bundle = exportBackupState(original, {})
  assert.deepEqual(validateBackup(bundle).state.accountRecycle![0].providerModelContextWindows, { alpha: 400000, beta: 200000 })
  const bad = structuredClone(bundle)
  bad.state.accounts[0].modelContextWindows = { alpha: 0 }
  assert.throws(() => validateBackup(bad), /格式无效/)
  const recycledLogin = structuredClone(bundle)
  recycledLogin.state.accountRecycle![0].account.kind = 'oauth'
  assert.throws(() => validateBackup(recycledLogin), /登录账号不支持/)
  delete recycledLogin.state.accountRecycle![0].account.modelContextWindows
  assert.throws(() => validateBackup(recycledLogin), /登录账号不支持供应商/)
  const source = new DataBackups(f.store, () => ({}), () => {}), target = new DataBackups(other.store, () => ({}), () => {})
  t.after(async () => { await source.stop(); await target.stop() })
  const path = join(f.root, 'contexts.cmlbackup'), password = 'fixture-context-password'
  await source.export({ requestId: randomUUID(), password }, path)
  assert.equal(readFileSync(path).includes('fixture-first'), false)
  const preview = await target.preview({ requestId: randomUUID(), password }, path)
  await target.apply({ ticket: preview.ticket, requestId: randomUUID(), confirmed: true })
  assert.deepEqual(other.store.read().accountRecycle, original.accountRecycle)
  assert.deepEqual(other.store.read().providers, original.providers)
  assert.equal(other.store.read().accounts[0].modelContextWindows, undefined, 'Inheritance must remain inheritance in full backups')
})

test('recycle export and restore retain deleted windows if supplier settings changed or disappeared', async t => {
  const f = fixture(t), recycle = new AccountRecycle(f.store)
  t.after(() => recycle.stop())
  f.set(f.first.id, { alpha: 128000 })
  deleteAccounts(f.store, [f.first.id])
  const p = f.provider()
  mutateProvider(f.store, { action: 'update', id: p.id, revision: p.revision, changes: { modelContextWindows: { alpha: 512000, beta: 256000 } } })
  let list = recycle.list(), preview = recycle.preview({ snapshotId: list.snapshotId, all: true, action: 'export' })
  const path = join(f.root, 'recycled.json')
  await recycle.apply({ ticket: preview.ticket, confirmed: true }, async () => path)
  const exported = parseAccountImport(readFileSync(path, 'utf8'))
  assert.deepEqual(exported.accounts[0].modelContextWindows, { alpha: 128000, beta: 200000 })
  list = recycle.list(); preview = recycle.preview({ snapshotId: list.snapshotId, all: true, action: 'restore' })
  await recycle.apply({ ticket: preview.ticket, confirmed: true }, async () => undefined)
  assert.equal(f.current(f.first.id).providerId, undefined)
  assert.deepEqual(f.current(f.first.id).modelContextWindows, { alpha: 128000, beta: 200000 })
})

test('recycle with no previous supplier window cannot inherit a new window added after deletion', async t => {
  const f = fixture(t), recycle = new AccountRecycle(f.store)
  t.after(() => recycle.stop())
  let p = f.provider()
  mutateProvider(f.store, { action: 'update', id: p.id, revision: p.revision, changes: {}, clearModelContextWindows: true })
  deleteAccounts(f.store, [f.first.id])
  assert.deepEqual(f.store.read().accountRecycle![0].providerModelContextWindows, {})
  p = f.provider()
  mutateProvider(f.store, { action: 'update', id: p.id, revision: p.revision, changes: { modelContextWindows: { alpha: 128000 } } })
  const list = recycle.list(), preview = recycle.preview({ snapshotId: list.snapshotId, all: true, action: 'restore' })
  await recycle.apply({ ticket: preview.ticket, confirmed: true }, async () => undefined)
  assert.equal(f.current(f.first.id).providerId, undefined)
  assert.equal(f.current(f.first.id).modelContextWindows, undefined)
})
