import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { DataBackups } from '../src/main/dataBackups'
import { Store, type State, type VaultCodec } from '../src/main/store'
import { instanceInputSchema } from '../src/shared/instances'

const password = 'synthetic Claude portable backup passphrase'
const request = () => ({ requestId: randomUUID(), password })

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-backup-')))
  const key = randomBytes(32)
  const codec: VaultCodec = {
    encrypt(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decrypt(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8')
    },
  }
  const store = new Store(join(root, 'data'), codec)
  const service = new DataBackups(store, () => ({}))
  t.after(async () => { await service.stop(); key.fill(0); rmSync(root, { recursive: true, force: true }) })
  return { root, store, service, codec, archive: join(root, 'claude.cmlbackup') }
}

function assertClaudeState(actual: State, expected: State): void {
  assert.equal(actual.accounts.length, 2)
  for (const [index, credentialKind] of ['anthropic_api_key', 'anthropic_bearer'].entries()) {
    const account = actual.accounts[index], source = expected.accounts[index]
    assert.equal(account.kind, 'api_key')
    assert.equal(account.identityService, 'anthropic')
    assert.equal(account.protocol, 'anthropic_messages')
    assert.equal(account.credentialKind, credentialKind)
    assert.deepEqual(account.credentials, source.credentials)
    assert.equal(account.credentials.accessToken, undefined)
    assert.equal(account.baseUrl, source.baseUrl)
    const { generation: _restoredGeneration, ...restored } = account
    const { generation: _sourceGeneration, ...original } = source
    assert.deepEqual(restored, original)
  }
  assert.deepEqual(actual.instances, expected.instances)
  assert.ok(actual.instances!.every(instance => instance.clientType === 'claude_code' && instance.connectionMode === 'native'))
  assert.deepEqual(actual.instanceApplications, expected.instanceApplications)
  const application = actual.instanceApplications![0]
  assert.equal(application.clientType, 'claude_code')
  assert.equal(application.kind, 'cli')
  assert.ok(application.installationPath)
  assert.notEqual(application.installationPath, application.path)
  for (const instance of actual.instances!) {
    assert.equal(instance.applicationId, application.id)
    assert.ok(actual.accounts.some(account => account.id === instance.accountId))
  }
}

test('portable encrypted backup restores Claude API and Bearer identity, instance type and launcher paths across independent vaults', async t => {
  const source = fixture(t), destination = fixture(t)
  const imported = parseClaudeCodeAccountImport(JSON.stringify([
    { name: 'Claude API fixture', ANTHROPIC_API_KEY: 'sk-ant-api03-backup-fixture-only', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', models: ['claude-sonnet-4-5'] },
    { name: 'Claude Bearer fixture', ANTHROPIC_AUTH_TOKEN: 'bearer-backup-fixture-only', ANTHROPIC_BASE_URL: 'https://gateway.invalid/anthropic', models: ['claude-haiku-4-5'] },
  ]))
  assert.deepEqual(imported.preview.errors, [])
  assert.equal(imported.accounts.length, 2)
  const applicationId = 'claude-native-fixture'
  const path = join(source.root, 'synthetic-install', 'versions', '2.1.295')
  const installationPath = join(source.root, 'synthetic-install', 'bin', 'claude')
  source.store.transaction(state => {
    state.accounts = imported.accounts
    state.instanceApplications = [{ id: applicationId, clientType: 'claude_code', name: 'Claude native fixture', kind: 'cli', path, installationPath }]
    state.instances = imported.accounts.map(account => ({
      ...instanceInputSchema.parse({ clientType: 'claude_code', name: account.name, applicationId, accountId: account.id, model: account.models[0], connectionMode: 'native' }),
      id: randomUUID(), revision: 3, createdAt: 1,
    }))
  })
  const expected = new Store(source.store.directory, source.codec).read()
  const exported = await source.service.export(request(), source.archive)
  assert.equal(exported.counts.accounts, 2); assert.equal(exported.counts.instances, 2)
  const encrypted = readFileSync(source.archive)
  for (const secret of imported.accounts.map(account => account.credentials.apiKey!)) assert.equal(encrypted.includes(secret), false)
  assert.equal(encrypted.includes(installationPath), false)
  const preview = await destination.service.preview(request(), source.archive)
  assert.equal(preview.incoming.accounts, 2); assert.equal(preview.incoming.instances, 2)
  const restored = await destination.service.apply({ ticket: preview.ticket, requestId: randomUUID(), confirmed: true })
  assert.equal(restored.restartRequired, true)
  const reopened = new Store(destination.store.directory, destination.codec)
  assertClaudeState(reopened.read(), expected)
  for (const instance of expected.instances!) {
    assert.deepEqual(readdirSync(join(destination.store.directory, 'instances', instance.id)).sort(), ['desktop', 'home', 'workspace'])
  }
  assert.equal(readFileSync(join(destination.store.directory, 'state.vault')).includes('bearer-backup-fixture-only'), false)
  assert.throws(() => source.codec.decrypt(readFileSync(join(destination.store.directory, 'state.vault'))))

  // A new manager process can export the restored definitions again without
  // confusing the stable install launcher with its versioned native binary.
  const reexport = new DataBackups(reopened, () => ({})), next = fixture(t)
  t.after(() => reexport.stop())
  await reexport.export(request(), destination.archive)
  const nextPreview = await next.service.preview(request(), destination.archive)
  await next.service.apply({ ticket: nextPreview.ticket, requestId: randomUUID(), confirmed: true })
  assertClaudeState(new Store(next.store.directory, next.codec).read(), expected)
  assertClaudeState(new Store(source.store.directory, source.codec).read(), expected)
})
