import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalDataMigration } from '../src/main/localDataMigration'
import { Store, type VaultCodec } from '../src/main/store'
import { mutateProvider } from '../src/main/providerLibrary'
import { DataBackups } from '../src/main/dataBackups'
import { exportBackupState, validateBackup } from '../src/main/dataBackupState'
import type { LocalDataPreview } from '../src/shared/localDataMigration'

const observedAt = 1_760_000_000_000
const password = 'fixture-backup-password'
const request = () => randomUUID()
function writeJSON(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }) }
function encryptedCodec() {
  const key = randomBytes(32); let failing = false
  const codec: VaultCodec = {
    encrypt(text) { if (failing) throw new Error('fixture-disk-failure')
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce), body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), body]) },
    decrypt(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') }
  }
  return { codec, fail: (value: boolean) => { failing = value } }
}
function envelope(value: unknown, key: Buffer) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()])
  return { version: 1, kind: 'codex', algorithm: 'AES-256-GCM', key_id: 'local-secure-account-storage-v1',
    nonce: nonce.toString('base64'), ciphertext: body.toString('base64'), encrypted_at: observedAt / 1000 }
}
function bytes(root: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {}
  const visit = (directory: string) => { for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) visit(path)
    else if (item.isFile()) result[relative(root, path)] = readFileSync(path)
  } }
  visit(root); return result
}
function fixture(t: TestContext, encrypted = false) {
  const root = mkdtempSync(join(tmpdir(), 'cml-local-migration-')), source = join(root, 'source'), vault = encryptedCodec()
  mkdirSync(join(source, 'codex_accounts'), { recursive: true, mode: 0o700 })
  mkdirSync(join(source, 'codex_account_tombstones'), { mode: 0o700 })
  const details = Array.from({ length: 4 }, (_, index) => ({ id: `api-${index}`, auth_mode: 'apikey',
    account_name: `工作连接 ${index}`, email: `fixture-${index}@example.invalid`, plan_type: 'provider-plan',
    openai_api_key: `fixture-private-key-${index}`, api_base_url: 'https://provider.example.invalid/CaseSensitive/v1',
    api_provider_id: 'provider-original-id', api_wire_api: 'responses', api_model_catalog: ['custom-model'],
    app_speed: index < 3 ? 'fast' : 'standard', tags: index === 3 ? null : ['工作'], account_note: `中文备注 ${index}`,
    token_generation: 7, created_at: observedAt / 1000, last_used: observedAt / 1000 + 10,
    tokens: { access_token: '', id_token: '' }, private_metadata: { retained: `fixture-origin-secret-${index}` } }))
  const key = randomBytes(32)
  const saveAccount = (index: number) => writeJSON(join(source, 'codex_accounts', `${details[index].id}.json`), encrypted ? envelope(details[index], key) : details[index])
  details.forEach((_, index) => saveAccount(index))
  if (encrypted) writeFileSync(join(source, 'secure-account-storage.key'), key.toString('base64'), { mode: 0o600 })
  const index = { version: '1.0', detail_schema_version: 2, accounts: details.map(a => ({ id: a.id, email: a.email, plan_type: a.plan_type,
    created_at: a.created_at, last_used: a.last_used })), current_account_id: details[0].id }
  const provider = { id: 'provider-original-id', name: '工作供应商', baseUrl: details[0].api_base_url, modelCatalog: ['custom-model'],
    wireApi: 'responses', defaultTier: 'inherit', createdAt: observedAt, updatedAt: observedAt + 100,
    boundInstanceId: 'original-external-instance', website: 'https://example.invalid', customMetadata: { retained: 'fixture-provider-secret' },
    apiKeys: details.map((a, i) => ({ id: `key-${i}`, name: `密钥 ${i}`, apiKey: a.openai_api_key, createdAt: observedAt + i, updatedAt: observedAt + i + 100 })) }
  const groups = [
    { id: 'group-last', name: '归档组', sortOrder: 8, accountIds: ['api-3'], createdAt: observedAt, quotaAutoRefreshMinutes: null },
    { id: 'group-first', name: '工作组', sortOrder: 2, accountIds: ['api-0', 'api-1', 'api-2'], createdAt: observedAt, quotaAutoRefreshMinutes: -1 }
  ]
  writeJSON(join(source, 'codex_accounts.json'), index)
  writeJSON(join(source, 'codex_model_providers.json'), provider ? [provider] : [])
  writeJSON(join(source, 'codex_account_groups.json'), groups)
  writeJSON(join(source, 'codex_instances.json'), { instances: [], defaultSettings: { bindAccountId: 'api-0' } })
  const store = new Store(join(root, 'destination'), vault.codec)
  let now = observedAt
  const migration = new LocalDataMigration(store, { roots: [{ path: source, name: '兼容账号库', format: 'account_library' }], now: () => now })
  t.after(async () => { await migration.stop(); rmSync(root, { recursive: true, force: true }) })
  return { root, source, store, migration, details, index, provider, groups, key, saveAccount, codec: vault.codec,
    failWrites: vault.fail, advance: (ms: number) => { now += ms } }
}
async function preview(f: ReturnType<typeof fixture>) {
  const scan = await f.migration.scan(request())
  assert.equal(scan.sources.length, 1)
  return f.migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] })
}
const apply = (f: ReturnType<typeof fixture>, p: LocalDataPreview) => f.migration.apply({ ticket: p.ticket, confirmed: true })
async function refused(f: ReturnType<typeof fixture>): Promise<void> {
  const original = f.store.read()
  const scan = await f.migration.scan(request())
  assert.equal(scan.sources.length, 1)
  let p: LocalDataPreview | undefined
  try {
    p = await f.migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] })
  } catch (error) { assert.ok(error instanceof Error) }
  if (p) {
    assert.ok(p.errors.length > 0)
    await assert.rejects(apply(f, p))
  }
  assert.deepEqual(f.store.read(), original)
}

for (const encrypted of [false, true]) test(`local migration preserves ${encrypted ? 'AES-GCM' : 'plaintext'} multi-key accounts, Fast, groups and full source without writing source`, async t => {
  const f = fixture(t, encrypted), original = bytes(f.source)
  const p = await preview(f)
  assert.deepEqual(p.errors, [])
  assert.equal(p.counts.addedAccounts, 4); assert.equal(p.counts.addedProviders, 1)
  assert.equal(p.counts.addedKeys, 4); assert.equal(p.counts.addedGroups, 2)
  assert.equal(f.store.read().accounts.length, 0)
  await apply(f, p)
  const state = new Store(f.store.directory, f.codec).read()
  assert.equal(state.providers!.length, 1); assert.equal(state.providers![0].keys.length, 4)
  assert.deepEqual(state.providers![0].keys.map(k => [k.name, k.apiKey, k.createdAt, k.updatedAt]), f.provider.apiKeys.map(k => [k.name, k.apiKey, k.createdAt, k.updatedAt]))
  assert.deepEqual(state.accounts.map(a => a.defaultTier), ['fast', 'fast', 'fast', 'standard'])
  for (const [i, account] of state.accounts.entries()) {
    assert.equal(account.name, f.details[i].account_name); assert.equal(account.email, f.details[i].email)
    assert.equal(account.plan, f.details[i].plan_type); assert.equal(account.createdAt, observedAt)
    assert.equal(account.providerId, state.providers![0].id)
    assert.equal(account.providerKeyId, state.providers![0].keys[i].id)
    assert.deepEqual(account.source, f.details[i]); assert.deepEqual(account.tags, i === 3 ? [] : ['工作'])
  }
  assert.deepEqual(state.groups.map(g => [g.name, g.quotaAutoRefreshMinutes]), [['工作组', -1], ['归档组', null]])
  assert.deepEqual(state.groups[0].accountIds, state.accounts.slice(0, 3).map(a => a.id))
  assert.equal(state.instances, undefined)
  const files = state.localDataArchives![0].sources[0].files
  assert.deepEqual(files.find(file => file.path === 'codex_accounts/api-0.json')?.content, f.details[0])
  assert.deepEqual(files.find(file => file.path === 'codex_model_providers.json')?.content, [f.provider])
  assert.equal(files.some(file => file.path === 'secure-account-storage.key'), false)
  for (const secret of ['fixture-private-key-0', 'fixture-origin-secret-0', 'fixture-provider-secret']) {
    assert.equal(JSON.stringify(p).includes(secret), false)
    assert.equal(JSON.stringify(f.store.snapshot()).includes(secret), false)
    assert.equal(readFileSync(join(f.store.directory, 'state.vault')).includes(secret), false)
  }
  assert.deepEqual(bytes(f.source), original)
  await assert.rejects(apply(f, p))
})

test('local migration archives survive authenticated portable backup restore into an independent encrypted vault', async t => {
  const f = fixture(t, true), p = await preview(f); await apply(f, p)
  const exported = exportBackupState(f.store.read(), {}, observedAt)
  assert.deepEqual(validateBackup(exported).state.localDataArchives, f.store.read().localDataArchives)
  const sourceBackups = new DataBackups(f.store, () => ({})), targetVault = encryptedCodec(), target = new Store(join(f.root, 'restore-target'), targetVault.codec)
  const targetBackups = new DataBackups(target, () => ({})); t.after(async () => { await sourceBackups.stop(); await targetBackups.stop() })
  const file = join(f.root, 'portable.cmlbackup'), req = () => ({ requestId: request(), password })
  await sourceBackups.export(req(), file)
  const staged = await targetBackups.preview(req(), file)
  await targetBackups.apply({ ticket: staged.ticket, requestId: request(), confirmed: true })
  const state = new Store(target.directory, targetVault.codec).read()
  assert.deepEqual(state.localDataArchives, f.store.read().localDataArchives)
  assert.deepEqual(state.providers, f.store.read().providers)
  assert.deepEqual(state.groups, f.store.read().groups)
  assert.deepEqual(state.accounts.map(a => a.source), f.details)
  assert.equal(readFileSync(file).includes('fixture-private-key-0'), false)
})

test('repeated scans are idempotent and duplicate source accounts never overwrite destination credentials or metadata', async t => {
  const f = fixture(t), first = await preview(f); await apply(f, first)
  f.store.transaction(state => { state.accounts[0].name = '本应用改名'; state.accounts[0].note = '本应用备注'; state.accounts[0].defaultTier = 'flex' })
  const original = f.store.read(), p = await preview(f)
  assert.equal(p.counts.addedAccounts, 0); assert.equal(p.counts.duplicateAccounts, 4)
  assert.equal(p.counts.addedProviders, 0); assert.equal(p.counts.addedKeys, 0)
  await apply(f, p)
  assert.deepEqual(f.store.read(), original)
})

test('new source metadata can be archived even when all credentials are duplicates', async t => {
  const f = fixture(t), first = await preview(f); await apply(f, first)
  const original = f.store.read()
  f.details[0].private_metadata.retained = 'fixture-updated-origin-secret'; f.saveAccount(0)
  const p = await preview(f)
  assert.equal(p.newArchive, true); assert.equal(p.counts.addedAccounts, 0)
  assert.equal(p.counts.addedProviders, 0); assert.equal(p.counts.addedKeys, 0)
  await apply(f, p)
  assert.deepEqual(f.store.read().accounts, original.accounts)
  assert.equal(f.store.read().localDataArchives!.length, 2)
  assert.deepEqual(f.store.read().localDataArchives![1].sources[0].files.find(file => file.path === 'codex_accounts/api-0.json')?.content, f.details[0])
})

test('same-name group member merges retain destination quota policy and are counted as changes', async t => {
  const f = fixture(t), first = await preview(f); await apply(f, first)
  f.store.transaction(state => { const group = state.groups.find(g => g.name === '工作组')!; group.accountIds = []; group.quotaAutoRefreshMinutes = 5 })
  const p = await preview(f)
  assert.equal(p.counts.mergedGroups, 1); assert.equal(p.newArchive, false)
  await apply(f, p)
  const state = f.store.read(), group = state.groups.find(g => g.name === '工作组')!
  assert.equal(group.quotaAutoRefreshMinutes, 5)
  assert.deepEqual(group.accountIds, state.accounts.slice(0, 3).map(a => a.id))
})

test('explicit group quota refresh minutes, including inherit, take precedence over the legacy boolean', async t => {
  const f = fixture(t), common = { accountIds: ['api-0'], createdAt: observedAt, quotaRefreshEnabled: false }
  writeJSON(join(f.source, 'codex_account_groups.json'), [
    { ...common, name: '显式间隔', sortOrder: 0, quotaAutoRefreshMinutes: 5 },
    { ...common, name: '显式继承', sortOrder: 1, quotaAutoRefreshMinutes: null },
    { ...common, name: '旧版关闭', sortOrder: 2 }
  ])
  const p = await preview(f); assert.deepEqual(p.errors, []); await apply(f, p)
  assert.deepEqual(f.store.read().groups.map(group => [group.name, group.quotaAutoRefreshMinutes]), [['显式间隔', 5], ['显式继承', null], ['旧版关闭', -1]])
})

test('supplier configuration conflicts prevent all writes and preserve destination metadata', async t => {
  const f = fixture(t)
  mutateProvider(f.store, { action: 'create', details: { name: '已有供应商', baseUrl: f.provider.baseUrl, models: ['different-model'], wireApi: 'responses', defaultTier: 'inherit' } })
  const original = f.store.read(), p = await preview(f)
  assert.ok(p.errors.length > 0)
  assert.equal(p.providers[0].action, 'conflict')
  await assert.rejects(apply(f, p))
  assert.deepEqual(f.store.read(), original)
})

test('same-endpoint connections with different models keep their original routing and do not become provider projections', async t => {
  const f = fixture(t)
  f.details[0].api_model_catalog = ['account-only-model']; f.saveAccount(0)
  const p = await preview(f); assert.deepEqual(p.errors, []); await apply(f, p)
  const [different, matching] = f.store.read().accounts
  assert.deepEqual(different.models, ['account-only-model']); assert.equal(different.providerId, undefined)
  assert.ok(matching.providerId); assert.deepEqual(different.source, f.details[0])
  assert.ok(p.warnings.some(text => text.includes('独立连接')))
})

test('empty saved model catalogs can migrate and remain valid in complete backup state', async t => {
  const f = fixture(t)
  f.provider.modelCatalog = []
  writeJSON(join(f.source, 'codex_model_providers.json'), [f.provider])
  for (let i = 0; i < f.details.length; i++) { f.details[i].api_model_catalog = []; f.saveAccount(i) }
  const p = await preview(f); assert.deepEqual(p.errors, []); await apply(f, p)
  assert.deepEqual(f.store.read().providers![0].models, [])
  assert.ok(f.store.read().accounts.every(a => a.models.length === 0))
  assert.doesNotThrow(() => validateBackup(exportBackupState(f.store.read(), {})))
})

for (const broken of ['missing-key', 'wrong-key', 'short-key', 'damaged-tag', 'wrong-version'] as const) test(`encrypted local migration rejects ${broken} without partial commits or replacing source key`, async t => {
  const f = fixture(t, true)
  const path = join(f.source, 'secure-account-storage.key')
  if (broken === 'missing-key') rmSync(path)
  else if (broken === 'wrong-key') writeFileSync(path, randomBytes(32).toString('base64'))
  else if (broken === 'short-key') writeFileSync(path, randomBytes(12).toString('base64'))
  else {
    const file = join(f.source, 'codex_accounts/api-0.json'), value = JSON.parse(readFileSync(file, 'utf8'))
    if (broken === 'wrong-version') value.version = 99
    else { const cipher = Buffer.from(value.ciphertext, 'base64'); cipher[cipher.length - 1] ^= 1; value.ciphertext = cipher.toString('base64') }
    writeJSON(file, value)
  }
  const original = bytes(f.source); await refused(f); assert.deepEqual(bytes(f.source), original)
})

test('deleted and superseded credential tombstones are skipped instead of resurrecting old account snapshots', async t => {
  const f = fixture(t)
  writeJSON(join(f.source, 'codex_account_groups.json'), [])
  writeJSON(join(f.source, 'codex_account_tombstones/api-0.json'), { deleted: true, generation: 8 })
  writeJSON(join(f.source, 'codex_account_tombstones/api-1.json'), { deleted: false, generation: 8 })
  writeJSON(join(f.source, 'codex_account_tombstones/api-2.json'), { deleted: false, generation: 7, credential_hash: 'wrong-credential-fingerprint' })
  // Rust serde_json Value uses lexically sorted object keys before SHA-256.
  const credentialHash = createHash('sha256').update(JSON.stringify({ agent_identity: null, auth_mode: 'apikey',
    openai_api_key: f.details[3].openai_api_key, tokens: { access_token: '', id_token: '' } })).digest('base64url')
  writeJSON(join(f.source, 'codex_account_tombstones/api-3.json'), { deleted: false, generation: 7, credential_hash: credentialHash })
  const p = await preview(f)
  assert.deepEqual(p.errors, [])
  await apply(f, p); assert.deepEqual(f.store.read().accounts.map(a => a.name), [f.details[3].account_name])
  assert.ok(p.warnings.length > 0)
})

test('invalid account IDs, symlinked details and root symlinks cannot escape the selected source', async t => {
  const traversal = fixture(t)
  traversal.index.accounts[0].id = '../outside-secret'; writeJSON(join(traversal.source, 'codex_accounts.json'), traversal.index)
  await refused(traversal)
  const detailLink = fixture(t), external = join(detailLink.root, 'external.json')
  writeJSON(external, detailLink.details[0]); rmSync(join(detailLink.source, 'codex_accounts/api-0.json'))
  symlinkSync(external, join(detailLink.source, 'codex_accounts/api-0.json')); await refused(detailLink)
  const rootLink = fixture(t), alias = join(rootLink.root, 'source-alias'); symlinkSync(rootLink.source, alias)
  const migration = new LocalDataMigration(rootLink.store, { roots: [{ path: alias, name: '所选来源', format: 'account_library' }] })
  t.after(() => migration.stop())
  const scan = await migration.scan(request()); assert.ok(scan.sources[0].issues.length > 0)
  await assert.rejects(migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] }))
  assert.equal(rootLink.store.read().accounts.length, 0)
})

test('symlinked intermediate directories, hardlinked files and unsafe JSON fields are rejected', async t => {
  const directory = fixture(t), external = join(directory.root, 'external-details')
  mkdirSync(external); writeJSON(join(external, 'api-0.json'), directory.details[0])
  rmSync(join(directory.source, 'codex_accounts'), { recursive: true }); symlinkSync(external, join(directory.source, 'codex_accounts'))
  await refused(directory)
  const hard = fixture(t), { linkSync } = await import('node:fs')
  linkSync(join(hard.source, 'codex_accounts/api-0.json'), join(hard.root, 'hardlink-account.json')); await refused(hard)
  const unsafe = fixture(t)
  writeFileSync(join(unsafe.source, 'codex_accounts/api-0.json'), '{"__proto__":{"secret":"fixture-secret"},"openai_api_key":"fixture-key"}')
  await refused(unsafe)
})

test('oversized files and excessive index rows are bounded before they can be committed', async t => {
  const large = fixture(t), file = join(large.source, 'codex_accounts/api-0.json')
  truncateSync(file, 16 * 1024 * 1024 + 1); await refused(large)
  const many = fixture(t)
  writeJSON(join(many.source, 'codex_accounts.json'), { accounts: Array.from({ length: 10001 }, (_, i) => ({ id: `id-${i}` })) })
  await refused(many)
})

test('cancel, superseding scans, ticket discard and expiry make prepared changes unusable', async t => {
  const f = fixture(t), id = request(), session = f.migration.begin(id)
  f.migration.cancel(id); await assert.rejects(f.migration.finishScan(session))
  const p = await preview(f); f.migration.discard(p.ticket); await assert.rejects(apply(f, p))
  const old = await preview(f); await f.migration.scan(request()); await assert.rejects(apply(f, old))
  const expired = await preview(f); f.advance(600001); await assert.rejects(apply(f, expired))
  const runningId = request(), running = f.migration.scan(runningId); f.migration.cancel(runningId); await assert.rejects(running)
  assert.equal(f.store.read().accounts.length, 0)
})

test('a legal 5001-account library is not rejected by counting nonexistent tombstones as account files', { timeout: 60000 }, async t => {
  const f = fixture(t), count = 5001
  rmSync(join(f.source, 'codex_accounts'), { recursive: true }); mkdirSync(join(f.source, 'codex_accounts'))
  const rows: { id: string }[] = []
  for (let i = 0; i < count; i++) {
    const id = `large-${i}`; rows.push({ id })
    writeJSON(join(f.source, 'codex_accounts', `${id}.json`), { id, openai_api_key: `fixture-unique-secret-${i}`, account_name: `连接 ${i}`,
      api_base_url: 'https://large.example.invalid/v1', api_model_catalog: ['custom-model'], tags: null, app_speed: 'standard' })
  }
  writeJSON(join(f.source, 'codex_accounts.json'), { version: '1.0', detail_schema_version: 2, accounts: rows })
  writeJSON(join(f.source, 'codex_model_providers.json'), []); writeJSON(join(f.source, 'codex_account_groups.json'), [])
  const p = await preview(f)
  assert.deepEqual(p.errors, []); assert.equal(p.counts.addedAccounts, count)
  await apply(f, p); assert.equal(f.store.read().accounts.length, count)
  assert.equal(f.store.read().localDataArchives![0].sources[0].files.length, count + 4)
})

test('changing any selected source file or previously absent tombstone invalidates a preview', async t => {
  for (const change of ['detail', 'provider', 'new-tombstone', 'key'] as const) {
    const f = fixture(t, change === 'key'), p = await preview(f), original = f.store.read()
    if (change === 'detail') { f.details[0].account_note = '扫描后修改'; f.saveAccount(0) }
    else if (change === 'provider') { f.provider.name = '扫描后修改'; writeJSON(join(f.source, 'codex_model_providers.json'), [f.provider]) }
    else if (change === 'new-tombstone') writeJSON(join(f.source, 'codex_account_tombstones/api-0.json'), { deleted: true, generation: 8 })
    else writeFileSync(join(f.source, 'secure-account-storage.key'), randomBytes(32).toString('base64'))
    await assert.rejects(apply(f, p), /变化/); assert.deepEqual(f.store.read(), original)
  }
})

test('destination changes or vault write failures roll back all migration changes and leave sources unchanged', async t => {
  const changed = fixture(t), p = await preview(changed)
  changed.store.transaction(state => { state.settings.defaultTier = 'fast' }); const original = changed.store.read()
  await assert.rejects(apply(changed, p), /变化/); assert.deepEqual(changed.store.read(), original)
  const failed = fixture(t), sourceBytes = bytes(failed.source), staged = await preview(failed), before = failed.store.read()
  failed.failWrites(true); await assert.rejects(apply(failed, staged), /disk-failure/)
  assert.deepEqual(failed.store.read(), before); assert.deepEqual(bytes(failed.source), sourceBytes)
  failed.failWrites(false); await apply(failed, staged); assert.equal(failed.store.read().accounts.length, 4)
})

test('user-selected generic portable data and native OAuth defaults are recognized without editing client files', async t => {
  const f = fixture(t), portable = join(f.root, 'portable'); mkdirSync(portable)
  writeJSON(join(portable, 'accounts.json'), [{ access_token: 'fixture-oauth-token', refresh_token: 'fixture-oauth-refresh', account_id: 'workspace-one',
    email: 'oauth@example.invalid', account_name: '便携登录', app_speed: 'fast', tags: ['工作'], created_at: observedAt / 1000 }])
  const session = f.migration.begin(request()), scan = await f.migration.finishScan(session, portable)
  assert.equal(scan.sources[0].format, 'portable')
  const p = await f.migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] }); assert.deepEqual(p.errors, []); await apply(f, p)
  assert.equal(f.store.read().accounts[0].defaultTier, 'fast'); assert.equal(f.store.read().accounts[0].kind, 'oauth')
  const native = join(f.root, 'native'); mkdirSync(native)
  writeJSON(join(native, 'auth.json'), { tokens: { access_token: 'fixture-native-token', refresh_token: 'fixture-native-refresh', account_id: 'workspace-two' } })
  writeFileSync(join(native, 'config.toml'), 'service_tier = "default"\n')
  const original = bytes(native), selected = await f.migration.finishScan(f.migration.begin(request()), native)
  assert.equal(selected.sources[0].format, 'native_client')
  const next = await f.migration.preview({ scanId: selected.scanId, sourceIds: [selected.sources[0].id] }); assert.deepEqual(next.errors, []); await apply(f, next)
  assert.equal(f.store.read().accounts.find(a => a.credentials.accountId === 'workspace-two')?.defaultTier, 'standard')
  assert.deepEqual(bytes(native), original)
})

test('provider-only and group-only selected libraries are recognized without requiring an account index', async t => {
  const f = fixture(t)
  const providers = join(f.root, 'provider-only'); mkdirSync(providers)
  writeJSON(join(providers, 'codex_model_providers.json'), [f.provider])
  const scan = await f.migration.finishScan(f.migration.begin(request()), providers)
  assert.equal(scan.sources[0].format, 'account_library'); assert.equal(scan.sources[0].providers, 1)
  assert.equal(scan.sources[0].accounts, 0)
  const p = await f.migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] }); assert.deepEqual(p.errors, []); await apply(f, p)
  assert.equal(f.store.read().providers![0].keys.length, 4); assert.equal(f.store.read().accounts.length, 0)
  const groups = join(f.root, 'group-only'); mkdirSync(groups)
  writeJSON(join(groups, 'codex_account_groups.json'), [{ name: '空分组', accountIds: [], sortOrder: 0, createdAt: observedAt, quotaAutoRefreshMinutes: -1 }])
  const selected = await f.migration.finishScan(f.migration.begin(request()), groups)
  assert.equal(selected.sources[0].format, 'account_library'); assert.equal(selected.sources[0].groups, 1)
  const next = await f.migration.preview({ scanId: selected.scanId, sourceIds: [selected.sources[0].id] }); assert.deepEqual(next.errors, []); await apply(f, next)
  assert.equal(f.store.read().groups[0].name, '空分组')
})

test('portable duplicate source IDs are rejected before group references can map to a wrong account', async t => {
  const f = fixture(t), directory = join(f.root, 'duplicate-id-portable'); mkdirSync(directory)
  writeJSON(join(directory, 'accounts.json'), [
    { id: 'same-id', access_token: 'fixture-oauth-first', email: 'first@example.invalid' },
    { id: 'same-id', access_token: 'fixture-oauth-second', email: 'second@example.invalid' }
  ])
  writeJSON(join(directory, 'groups.json'), [{ name: '工作', accountIds: ['same-id'] }])
  const scan = await f.migration.finishScan(f.migration.begin(request()), directory)
  assert.ok(scan.sources[0].issues.length > 0)
  await assert.rejects(f.migration.preview({ scanId: scan.scanId, sourceIds: [scan.sources[0].id] }), /重复/)
  assert.equal(f.store.read().accounts.length, 0)
})

test('account index metadata fills missing detail metadata without rewriting the preserved original detail', async t => {
  const f = fixture(t), { email, plan_type, created_at, ...originalDetail } = f.details[0]
  writeJSON(join(f.source, 'codex_accounts/api-0.json'), originalDetail)
  writeJSON(join(f.source, 'codex_accounts.json'), { ...f.index, accounts: f.index.accounts.map((row, index) => index === 0
    ? { ...row, subscription_active_until: '1790000000' } : row) })
  const p = await preview(f); assert.deepEqual(p.errors, []); await apply(f, p)
  const account = f.store.read().accounts[0]
  assert.equal(account.email, email); assert.equal(account.plan, plan_type); assert.equal(account.createdAt, created_at * 1000)
  assert.equal(account.subscriptionActiveUntil, 1_790_000_000_000)
  assert.deepEqual(account.source, originalDetail)
  assert.deepEqual(f.store.read().localDataArchives![0].sources[0].files.find(file => file.path === 'codex_accounts/api-0.json')?.content, originalDetail)
})
