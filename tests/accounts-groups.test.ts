import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store, type VaultCodec } from '../src/main/store'
import { batchTags, createAPIAccount, deleteAccounts, editAccount, importIntoStore, parseAccountImport, saveOAuthAccount } from '../src/main/accounts'
import { AccountFiles, serializeAccounts } from '../src/main/accountFiles'
import { bulkRefreshIds, deleteGroup, groupRefreshMinutes, reorderGroups, saveGroup, updateGroupMembers } from '../src/main/groups'
import { TokenAuthority } from '../src/main/tokens'
import { QuotaService } from '../src/main/quota'

const codec: VaultCodec = { encrypt: value => Buffer.from(value), decrypt: value => value.toString() }
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'cml-accounts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, store: new Store(join(root, 'vault'), codec) }
}
function api(name = 'test') {
  return createAPIAccount({ name, apiKey: `fake-secret-${name}`, baseUrl: 'http://127.0.0.1:19191/v1', models: ['test-model'], wireApi: 'responses', defaultTier: 'fast', note: '备注 🧪', tags: ['工作'] })
}
function jwt(id: string) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, email: `${id}@example.invalid`, 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.fixture`
}
function oauth(store: Store, id: string) { return saveOAuthAccount(store, { accessToken: jwt(id), idToken: jwt(id), refreshToken: `refresh-${id}`, accountId: id }) }

test('account edits preserve rotated credentials, reject stale edits and protect active connections', async t => {
  const { store } = fixture(t)
  const original = oauth(store, 'rotating')
  let finish!: (value: Record<string, unknown>) => void
  const authority = new TokenAuthority(store, () => new Promise(resolve => { finish = resolve }))
  const refresh = authority.ensure(original.id, { force: true })
  editAccount(store, { id: original.id, revision: 0, changes: { name: 'renamed', tags: ['keep'] } })
  finish({ access_token: jwt('rotating'), refresh_token: 'fresh-rotation', id_token: jwt('rotating') })
  await refresh
  editAccount(store, { id: original.id, revision: 1, changes: { note: 'after rotation' } })
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'fresh-rotation')
  assert.equal(store.read().accounts[0].name, 'renamed')
  assert.throws(() => editAccount(store, { id: original.id, revision: 0, changes: { name: 'stale' } }), /已被修改/)
  assert.throws(() => editAccount(store, { id: original.id, revision: 2, changes: { apiKey: 'oops' } }), /仅支持/)
  const account = api(); store.transaction(s => { s.accounts.push(account) })
  editAccount(store, { id: account.id, revision: 0, changes: { name: 'display only' } }, () => true)
  assert.throws(() => editAccount(store, { id: account.id, revision: 1, changes: { baseUrl: 'https://example.invalid/v1' } }, () => true), /停止/)
  assert.equal(store.read().accounts[1].baseUrl, account.baseUrl)
  assert.throws(() => deleteAccounts(store, [account.id], () => true), /停止/)
  assert.equal(JSON.stringify(store.snapshot()).includes('fresh-rotation'), false)
  await authority.stop()
})

test('batch tags and group membership operations are atomic, persisted, and clean deleted references', t => {
  const { store } = fixture(t)
  const a = api('a'), b = api('b')
  store.transaction(s => { s.accounts.push(a, b) })
  saveGroup(store, { group: { name: 'Work', quotaAutoRefreshMinutes: null } })
  saveGroup(store, { group: { name: 'Quiet', quotaAutoRefreshMinutes: -1 } })
  let [work, quiet] = store.read().groups
  updateGroupMembers(store, { id: work.id, ids: [a.id, b.id], mode: 'add' })
  updateGroupMembers(store, { id: quiet.id, ids: [a.id], mode: 'add' })
  assert.equal(store.read().groups[0].accountIds.length, 2)
  updateGroupMembers(store, { id: quiet.id, ids: [b.id], mode: 'move' })
  assert.deepEqual(store.read().groups[0].accountIds, [a.id])
  batchTags(store, { ids: [a.id, b.id], mode: 'add', tags: ['工作', 'test'] })
  assert.deepEqual(store.read().accounts[0].tags, ['工作', 'test'])
  assert.throws(() => batchTags(store, { ids: [a.id, randomUUID()], mode: 'replace', tags: [] }), /已删除/)
  assert.deepEqual(store.read().accounts[0].tags, ['工作', 'test'])
  assert.throws(() => batchTags(store, { ids: [a.id, b.id], mode: 'add', tags: Array.from({ length: 30 }, (_, i) => `tag${i}`) }))
  assert.deepEqual(store.read().accounts[1].tags, ['工作', 'test'])
  reorderGroups(store, [quiet.id, work.id])
  assert.throws(() => reorderGroups(store, [work.id, work.id]), /改变/)
  assert.equal(new Store(store.directory, codec).snapshot().groups[0].name, 'Quiet')
  deleteAccounts(store, [a.id, b.id])
  assert.ok(store.read().groups.every(g => !g.accountIds.length))
  deleteGroup(store, quiet.id)
  assert.equal(store.read().groups.length, 1)
})

test('old vaults acquire empty groups; failed encryption cannot change metadata or membership', t => {
  const { store } = fixture(t)
  const old = store.read() as Partial<ReturnType<Store['read']>>
  delete old.groups
  writeFileSync(join(store.directory, 'state.vault'), JSON.stringify(old))
  const compatible = new Store(store.directory, codec)
  assert.deepEqual(compatible.snapshot().groups, [])
  const failed = new Store(store.directory, { ...codec, encrypt: () => { throw new Error('write failure') } })
  assert.throws(() => saveGroup(failed, { group: { name: 'unsaved' } }), /write failure/)
  assert.deepEqual(failed.snapshot().groups, [])
  assert.deepEqual(readdirSync(store.directory), ['state.vault'])
})

test('imports accept native/camelCase/nested/Sub2API/JSONL and round-trip settings without secrets in preview', t => {
  const { store } = fixture(t)
  const a = api(), b = oauth(store, 'oauth')
  b.tags = ['中文']; b.note = 'note'; b.defaultTier = 'standard'
  const exported = serializeAccounts([a, b])
  const parsed = parseAccountImport(exported)
  assert.deepEqual(parsed.preview.errors, [])
  assert.equal(parsed.accounts[0].defaultTier, 'fast')
  assert.equal(parsed.accounts[1].defaultTier, 'standard')
  assert.deepEqual(parsed.accounts[1].tags, ['中文'])
  assert.equal(parsed.accounts[1].credentials.refreshToken, b.credentials.refreshToken)
  assert.equal(JSON.stringify(parsed.preview).includes('fake-secret'), false)
  assert.equal(JSON.stringify(parsed.preview).includes('refresh-oauth'), false)
  const mixed = parseAccountImport(JSON.stringify({ accounts: [
    { credentials: { accessToken: jwt('camel'), refreshToken: 'camel-refresh' }, name: 'camel', tags: ['tag'] },
    { platform: 'openai', type: 'oauth', credentials: { access_token: jwt('sub2api') } },
    { platform: 'kiro', type: 'oauth', credentials: { access_token: 'skip' } }
  ] }))
  assert.equal(mixed.accounts.length, 2); assert.equal(mixed.preview.skipped, 1)
  assert.equal(mixed.accounts[0].credentials.refreshToken, 'camel-refresh')
  assert.equal(parseAccountImport(JSON.stringify({ tokens: { access_token: 'one' } }) + '\n' + JSON.stringify({ accessToken: 'two' })).accounts.length, 2)
  assert.equal(parseAccountImport(jwt('a') + '\n' + jwt('b')).accounts.length, 2)
  assert.equal(parseAccountImport(JSON.stringify({ OPENAI_API_KEY: 'fake', base_url: 'https://provider.example.invalid/v1' })).accounts[0].baseUrl, 'https://provider.example.invalid/v1')
  const profileToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email: 'profile@example.invalid' } })).toString('base64url')}.fixture`
  assert.equal(parseAccountImport(JSON.stringify({ accessToken: profileToken })).accounts[0].email, 'profile@example.invalid')
  importIntoStore(store, exported)
  importIntoStore(store, exported)
  assert.equal(store.snapshot().accounts.length, 2)
})

test('malformed import errors omit raw content; unsupported identity and pending refresh imports are explicit', () => {
  assert.throws(() => parseAccountImport('{"access_token":"do-not-disclose"'), error => !String(error).includes('do-not-disclose'))
  const invalid = parseAccountImport(JSON.stringify({ apiKey: 'secret', wireApi: 'never-leak-this-secret' }))
  assert.equal(JSON.stringify(invalid.preview).includes('never-leak-this-secret'), false)
  assert.equal(parseAccountImport('{"refresh_token":"secret"}').preview.entries[0].needsVerification, true)
  assert.match(parseAccountImport('{"agent_identity":{},"access_token":"secret"}').preview.errors[0], /Agent Identity/)
})

test('refresh-only imports remain distinct, persist before exchange and retry without losing rotated tokens', async t => {
  const { store } = fixture(t)
  importIntoStore(store, 'fixture-refresh-one\nfixture-refresh-two')
  importIntoStore(store, JSON.stringify({ refreshToken: 'fixture-refresh-one' }))
  assert.equal(store.read().accounts.length, 2)
  assert.ok(store.snapshot().accounts.every(a => a.needsTokenExchange && !a.credentialConfigured))
  let calls = 0, projections = 0
  const authority = new TokenAuthority(store, async (_url, init) => {
    calls++
    const refresh = JSON.parse(String(init?.body)).refresh_token
    assert.ok(store.read().accounts.some(a => a.credentials.refreshToken === refresh))
    if (refresh === 'fixture-refresh-two') throw new Error('fixture upstream unavailable')
    return { access_token: jwt('resolved'), id_token: jwt('resolved'), refresh_token: 'rotated-only' }
  }, () => { projections++; throw new Error('fixture projection failure') })
  const first = store.read().accounts[0].id, second = store.read().accounts[1].id
  await assert.rejects(authority.ensure(first), /projection failure/)
  assert.equal(store.read().accounts[0].credentials.refreshToken, 'rotated-only')
  assert.equal(store.snapshot().accounts[0].needsTokenExchange, false)
  assert.equal(store.snapshot().accounts[0].email, 'resolved@example.invalid')
  await authority.ensure(first)
  assert.equal(calls, 1); assert.equal(projections, 1)
  await assert.rejects(authority.ensure(second), /unavailable/)
  assert.equal(store.read().accounts[1].credentials.refreshToken, 'fixture-refresh-two')
  assert.equal(store.snapshot().accounts[1].needsTokenExchange, true)
  const restored = new Store(store.directory, codec)
  assert.equal(restored.read().accounts[0].credentials.refreshToken, 'rotated-only')
  assert.equal(JSON.stringify(restored.snapshot()).includes('rotated-only'), false)
  await authority.stop()
})

test('access-only PATs and session aliases preserve identity and reject upstream 401 without refresh', async t => {
  const { store } = fixture(t)
  importIntoStore(store, 'at-fixture-personal-access')
  importIntoStore(store, JSON.stringify({ accessToken: jwt('session'), accountInfo: 'session note', sessionToken: 'session-refresh' }))
  const authority = new TokenAuthority(store, async () => { assert.fail('must not attempt PAT refresh') })
  const pat = store.read().accounts[0]
  assert.equal((await authority.ensure(pat.id)).credentials.accessToken, 'at-fixture-personal-access')
  await assert.rejects(authority.ensure(pat.id, { force: true }), /没有 refresh_token/)
  const session = store.read().accounts[1]
  assert.equal(session.credentials.refreshToken, 'session-refresh')
  assert.equal(session.note, 'session note')
  assert.equal(session.credentials.accountId, 'session')
  const expired = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.fixture`
  importIntoStore(store, JSON.stringify({ access_token: expired }))
  await assert.rejects(authority.ensure(store.read().accounts[2].id), /已过期/)
  await authority.stop()
})

test('file imports use immutable, expiring, single-use tickets; exports are restricted and atomic', async t => {
  const { root, store } = fixture(t)
  let now = 0
  const files = new AccountFiles(store, () => now)
  const path = join(root, 'accounts.json')
  writeFileSync(path, serializeAccounts([api()]))
  const preview = await files.stageFile(path)
  writeFileSync(path, serializeAccounts([api('changed-after-preview')]))
  assert.equal(JSON.stringify(preview).includes('fake-secret'), false)
  assert.deepEqual(files.commit(preview.ticket), { added: 1, duplicates: 0, skipped: 0, accountIds:[store.read().accounts[0].id] })
  assert.equal(store.snapshot().accounts[0].name, 'test')
  assert.throws(() => files.commit(preview.ticket), /过期/)
  const expired = files.stage(serializeAccounts([api('expired')]))
  now = 10 * 60_000
  assert.throws(() => files.commit(expired.ticket), /过期/)
  const cancelled = files.stage(serializeAccounts([api('cancelled')]))
  files.discard()
  assert.throws(() => files.commit(cancelled.ticket), /过期/)
  const output = join(root, 'output.json')
  assert.equal(await files.export(store.read().accounts.map(a => a.id), output), 1)
  assert.equal(parseAccountImport(readFileSync(output, 'utf8')).accounts[0].name, 'test')
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600)
  await assert.rejects(files.export([store.read().accounts[0].id], join(store.directory, 'state.vault')), /数据目录/)
  if (process.platform !== 'win32') {
    symlinkSync(store.directory, join(root, 'alias'))
    await assert.rejects(files.export([store.read().accounts[0].id], join(root, 'alias', 'state.vault')), /数据目录/)
  }
  await assert.rejects(files.export([randomUUID()], output), /已删除/)
  assert.ok(!readdirSync(root).some(file => file.endsWith('.tmp')))
})

test('large imports retain every account and reject oversized files without partial commits', async t => {
  const { root, store } = fixture(t)
  const files = new AccountFiles(store)
  t.after(() => files.discard())
  const raw = JSON.stringify(Array.from({ length: 10000 }, (_, i) => ({ apiKey: `fixture-${i}`, name: `账号 ${i}`, models: ['test-model'] })))
  const staged = files.stage(raw)
  assert.equal(staged.preview.entries.length, 10000)
  assert.equal(files.commit(staged.ticket).added, 10000)
  const repeated = files.stage(raw)
  assert.equal(files.commit(repeated.ticket).duplicates, 10000)
  assert.equal(new Store(store.directory, codec).snapshot().accounts.length, 10000)
  const large = join(root, 'large.json')
  writeFileSync(large, Buffer.alloc(16 * 1024 * 1024 + 1))
  await assert.rejects(files.stageFile(large), /16 MB/)
  const valid = files.stage(serializeAccounts([api('not-imported')]))
  await assert.rejects(files.stageFile(root), /普通账号文件/)
  assert.throws(() => files.commit(valid.ticket), /过期/)
  assert.equal(store.snapshot().accounts.length, 10000)
})

test('group quotas override global interval; bulk refresh skips disabled groups while explicit refresh works', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 })
  const { store } = fixture(t)
  const a = oauth(store, 'custom'), b = oauth(store, 'disabled'), c = oauth(store, 'inherit')
  store.transaction(s => { s.settings.refreshMinutes = 0 })
  saveGroup(store, { group: { name: 'custom', quotaAutoRefreshMinutes: 1 } })
  saveGroup(store, { group: { name: 'disabled', quotaAutoRefreshMinutes: -1 } })
  const [custom, disabled] = store.read().groups
  updateGroupMembers(store, { id: custom.id, ids: [a.id], mode: 'add' })
  updateGroupMembers(store, { id: disabled.id, ids: [b.id], mode: 'add' })
  assert.equal(groupRefreshMinutes(a.id, store.read().groups, 0), 1)
  assert.equal(groupRefreshMinutes(c.id, store.read().groups, 0), 0)
  assert.deepEqual(bulkRefreshIds(store.read()), [a.id, c.id])
  const requested: string[] = []
  const authority = new TokenAuthority(store, async () => { assert.fail('fresh fixture must not rotate') })
  const quotas = new QuotaService(store, authority, async (_url, init) => {
    requested.push((init?.headers as Record<string, string>)['ChatGPT-Account-Id'])
    return { rate_limit: { primary_window: { used_percent: 20 } } }
  })
  quotas.schedule()
  t.mock.timers.tick(60_000); await quotas.settled()
  assert.deepEqual(requested, ['custom'])
  quotas.startAll(); await quotas.settled()
  assert.deepEqual(requested.slice(1).sort(), ['custom', 'inherit'])
  quotas.start([b.id]); await quotas.settled()
  assert.equal(requested.at(-1), 'disabled')
  saveGroup(store, { id: custom.id, group: { name: 'custom', quotaAutoRefreshMinutes: -1 } })
  quotas.schedule()
  const before = requested.length
  t.mock.timers.tick(180_000); await quotas.settled()
  assert.equal(requested.length, before)
  await quotas.stop(); await authority.stop()
})
