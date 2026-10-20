import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertClaudeDesktopGatewayCapability, claudeDesktopGatewayBaseUrl, claudeDesktopGatewayFingerprint, prepareClaudeDesktopGateway, validateClaudeDesktopGatewayAccount } from '../src/main/claudeDesktopGateway'
import { prepareClaudeDesktopNetwork } from '../src/main/claudeDesktopNetwork'
import { claudeDesktopRuntimeDirectory } from '../src/main/claudeCodeDesktopAdapter'
import type { DesktopPlan } from '../src/main/instanceRuntime'
import type { InstanceProfile } from '../src/shared/instances'
import type { StoredAccount } from '../src/main/store'

const keys = ['inferenceProvider', 'inferenceCredentialKind', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey', 'inferenceGatewayAuthScheme', 'inferenceModels', 'modelDiscoveryEnabled', 'disableDeploymentModeChooser']
const source = `const schemas=${JSON.stringify(keys.map(flatKey => ({ flatKey, support: { enabled: { scopes: ['3p'] } } })))}; const proxy={flatKey:'egressProxyUrl',appBehaviorOnly:true,support:{enabled:{scopes:['1p','3p']}}}; const contracts=['configLibrary','_meta.json','appliedId','deploymentMode','claude_desktop_config.json','-3p','egressProxyPacUrl','proxy-server','proxy-pac-url'];`

test('Desktop strips only a final /v1 suffix because native Messages appends /v1/messages', () => {
  assert.equal(claudeDesktopGatewayBaseUrl('https://sub2api.example/v1'), 'https://sub2api.example')
  assert.equal(claudeDesktopGatewayBaseUrl('https://sub2api.example/api/v1/'), 'https://sub2api.example/api')
  assert.equal(claudeDesktopGatewayBaseUrl('https://sub2api.example/api'), 'https://sub2api.example/api')
})

function archive(path: string, nativeSource = source, main = './dist/native.cjs') {
  const files: any = { files: {} }, bodies: Buffer[] = []
  let offset = 0
  for (const [entry, content] of [['package.json', JSON.stringify({ name: '@ant/desktop', main })], [main.replace(/^\.\//, ''), nativeSource]]) {
    const body = Buffer.from(content), parts = entry.split('/')
    let parent = files
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ??= { files: {} }
    parent.files[parts.at(-1)!] = { size: body.length, offset: String(offset) }
    bodies.push(body); offset += body.length
  }
  const json = Buffer.from(JSON.stringify(files)), header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4), size = Buffer.alloc(8)
  header.writeUInt32LE(header.length - 4); header.writeUInt32LE(json.length, 4); json.copy(header, 8)
  size.writeUInt32LE(4); size.writeUInt32LE(header.length, 4)
  writeFileSync(path, Buffer.concat([size, header, ...bodies]))
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-gateway-'))), application = join(root, 'Claude.app')
  const asar = join(application, 'Contents', 'Resources', 'app.asar')
  mkdirSync(join(application, 'Contents', 'Resources'), { recursive: true }); archive(asar)
  const instance = join(root, 'instance'), directory = join(instance, 'home'), desktopDirectory = join(instance, 'desktop')
  mkdirSync(directory, { recursive: true }); mkdirSync(desktopDirectory)
  const account: StoredAccount = { id: randomUUID(), name: 'API connection', kind: 'api_key', identityService: 'anthropic', credentialKind: 'anthropic_api_key', protocol: 'anthropic_messages', baseUrl: 'https://api.fixture.invalid', models: ['model-one', 'model-two'], wireApi: 'chat_completions', credentials: { apiKey: 'synthetic-isolated-key' }, defaultTier: 'inherit', note: '', tags: [], createdAt: 1 }
  const profile: InstanceProfile = { id: randomUUID(), revision: 1, createdAt: 1, clientType: 'claude_code', name: 'API Desktop', accountId: account.id, model: 'model-two', connectionMode: 'native', launchMode: 'desktop', applicationId: 'synthetic-app', extraArgs: [], defaultTier: 'inherit' }
  const login: InstanceProfile = { ...profile, connectionMode: 'client_login', accountId: '', model: '' }
  const plan: DesktopPlan = { clientType: 'claude_code', mode: 'desktop', application, executable: join(application, 'Contents', 'MacOS', 'Claude'), directory, desktopDirectory, workingDirectory: join(instance, 'workspace'), args: [], nonce: randomUUID(), claudeDesktopConnection: 'api' }
  const library = `${desktopDirectory}-3p/configLibrary`, meta = join(library, '_meta.json'), journal = join(instance, '.cml-claude-desktop-gateway.json'), deployment = join(`${desktopDirectory}-3p`, 'claude_desktop_config.json')
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  const current = () => read(join(library, `${read(meta).appliedId}.json`))
  const editor = () => {
    const value = read(meta)
    value.entries.map((entry: { id: string; name: string }) => assert.equal(typeof entry.name, 'string'))
    if (!value.entries.some((entry: { id: string }) => entry.id === value.appliedId)) throw new Error('unknown config id')
    return current()
  }
  const setup = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    mkdirSync(library, { recursive: true }); const id = randomUUID(), path = join(library, `${id}.json`)
    writeFileSync(path, JSON.stringify(config)); writeFileSync(meta, JSON.stringify({ appliedId: id, entries: [{ id, name: 'Native choice' }], ...extra })); return { id, path }
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, application, asar, instance, directory, desktopDirectory, account, profile, login, plan, library, meta, journal, deployment, read, current, editor, setup }
}

test('Desktop API connection validates credential and protocol independently of model names', t => {
  const f = fixture(t)
  assert.doesNotThrow(() => validateClaudeDesktopGatewayAccount(f.profile, f.account))
  for (const account of [undefined, { ...f.account, id: randomUUID() }, { ...f.account, kind: 'oauth', credentialKind: 'claude_ai_oauth' }, { ...f.account, protocol: 'openai_responses' }, { ...f.account, credentials: { apiKey: '' } }, { ...f.account, baseUrl: 'https://api.invalid/?key=secret' }]) {
    assert.throws(() => validateClaudeDesktopGatewayAccount(f.profile, account as StoredAccount | undefined))
  }
  assert.throws(() => validateClaudeDesktopGatewayAccount({ ...f.profile, model: 'not-in-key' }, f.account), /模型目录/)
  assert.throws(() => validateClaudeDesktopGatewayAccount(f.profile, { ...f.account, baseUrl: 'http://upstream.invalid' }), /原生第三方连接要求/)
  assert.doesNotThrow(() => validateClaudeDesktopGatewayAccount(f.profile, { ...f.account, baseUrl: 'http://127.0.0.1:16322' }))
})

test('native gateway selects per-key models and stores credentials only in a private instance entry', t => {
  const f = fixture(t), baseline = claudeDesktopGatewayFingerprint(f.plan)
  assert.equal(existsSync(`${f.desktopDirectory}-3p`), false, 'preview must not create a native profile')
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  const current = f.current(), id = f.read(f.meta).appliedId
  assert.deepEqual(f.editor(), current)
  assert.equal(current.inferenceGatewayAuthScheme, 'x-api-key')
  assert.equal(current.inferenceGatewayApiKey, f.account.credentials.apiKey)
  assert.deepEqual(current.inferenceModels, [{ name: 'model-two' }, { name: 'model-one' }])
  assert.equal(current.modelDiscoveryEnabled, false)
  assert.equal(f.read(f.deployment).deploymentMode, '3p')
  assert.equal(claudeDesktopRuntimeDirectory(f.plan), `${f.desktopDirectory}-3p`)
  assert.equal(readFileSync(f.journal, 'utf8').includes(f.account.credentials.apiKey!), false)
  assert.notEqual(claudeDesktopGatewayFingerprint(f.plan), baseline)
  for (const path of [f.meta, f.journal, f.deployment, join(f.library, `${id}.json`)]) assert.equal(lstatSync(path).mode & 0o777, 0o600)
  f.account.credentialKind = 'anthropic_bearer'; f.account.credentials.apiKey = 'replacement-synthetic-token'
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  assert.equal(f.read(f.meta).appliedId, id)
  assert.equal(f.current().inferenceGatewayAuthScheme, 'bearer')
  assert.equal(f.current().inferenceGatewayApiKey, 'replacement-synthetic-token')
  assert.ok(readdirSync(f.library).every(name => !readFileSync(join(f.library, name), 'utf8').includes('synthetic-isolated-key')))
})

test('proxy overlays compose with gateway changes and restore native login without stale credentials', t => {
  const f = fixture(t), original = { theme: 'dark', nativeField: 'keep' }, source = f.setup(original)
  writeFileSync(f.deployment, JSON.stringify({ customDeploymentField: true }))
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23192' }
  prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.current().egressProxyUrl, f.plan.networkRoute.url)
  assert.deepEqual(f.editor(), f.current())
  const selected = join(f.library, `${f.read(f.meta).appliedId}.json`)
  writeFileSync(selected, JSON.stringify({ ...f.current(), theme: 'light', userSetting: true }))
  f.account.credentials.apiKey = 'rotated-key'
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  prepareClaudeDesktopNetwork(f.plan)
  assert.deepEqual(f.editor(), f.current())
  assert.equal(f.current().inferenceGatewayApiKey, 'rotated-key')
  assert.equal(f.current().theme, 'light')
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.equal(f.read(f.meta).appliedId, source.id)
  assert.deepEqual(f.read(f.meta).entries, [{ id: source.id, name: 'Native choice' }])
  assert.deepEqual(f.editor(), f.current())
  assert.deepEqual(f.current(), { theme: 'light', nativeField: 'keep', userSetting: true })
  assert.equal(f.read(f.deployment).deploymentMode, '1p')
  assert.equal(f.read(f.deployment).customDeploymentField, true)
  assert.equal(existsSync(f.journal), false)
  assert.equal(existsSync(join(f.instance, '.cml-claude-desktop-network.json')), false)
  assert.ok(existsSync(`${f.desktopDirectory}-3p`), 'native local history remains in its profile')
  assert.equal(claudeDesktopRuntimeDirectory({ ...f.plan, claudeDesktopConnection: undefined }), f.desktopDirectory)
})

test('native fields created under an API entry survive release of that entry', t => {
  const f = fixture(t)
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  const selected = join(f.library, `${f.read(f.meta).appliedId}.json`)
  writeFileSync(selected, JSON.stringify({ ...f.current(), windowPreference: 'keep' }))
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.deepEqual(f.current(), { windowPreference: 'keep' })
  assert.deepEqual(f.editor(), f.current())
  assert.equal(existsSync(f.journal), false)
})

test('legacy unlisted API proxy can rotate credentials and restore the native editor catalogue', t => {
  const f = fixture(t), source = f.setup({ native: 'preserve' }, { future: { keep: true } })
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  const gatewayId = f.read(f.meta).appliedId
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23192' }
  prepareClaudeDesktopNetwork(f.plan)
  const proxyId = f.read(f.meta).appliedId
  writeFileSync(f.meta, JSON.stringify({ ...f.read(f.meta), entries: f.read(f.meta).entries.filter((entry: { id: string }) => entry.id !== proxyId) }))
  assert.throws(f.editor, /unknown config id/)
  writeFileSync(join(f.library, `${proxyId}.json`), JSON.stringify({ ...f.current(), userPreference: true }))
  f.account.credentials.apiKey = 'rotated-synthetic-key'
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  prepareClaudeDesktopNetwork(f.plan)
  assert.equal(f.editor().inferenceGatewayApiKey, 'rotated-synthetic-key')
  assert.equal(f.editor().userPreference, true)
  assert.deepEqual(f.read(f.meta).entries.map((entry: { id: string }) => entry.id), [source.id, gatewayId, f.read(f.meta).appliedId])
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.deepEqual(f.editor(), { native: 'preserve', userPreference: true })
  assert.deepEqual(f.read(f.meta), { appliedId: source.id, entries: [{ id: source.id, name: 'Native choice' }], future: { keep: true } })
  const before = readFileSync(f.meta, 'utf8')
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.equal(readFileSync(f.meta, 'utf8'), before)
})

test('a native entry created and selected beside API and proxy overlays survives login restoration', t => {
  const f = fixture(t), source = f.setup({ native: true })
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23192' }
  prepareClaudeDesktopNetwork(f.plan)
  const id = randomUUID(), path = join(f.library, `${id}.json`)
  writeFileSync(path, JSON.stringify({ native: 'new configuration' }))
  const entry = { id, name: 'My configuration', future: 'retained' }
  writeFileSync(f.meta, JSON.stringify({ ...f.read(f.meta), appliedId: id, entries: [...f.read(f.meta).entries, entry], future: true }))
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.deepEqual(f.editor(), { native: 'new configuration' })
  assert.deepEqual(f.read(f.meta), { appliedId: id, entries: [{ id: source.id, name: 'Native choice' }, entry], future: true })
  assert.deepEqual(f.read(source.path), { native: true })
})

test('API and proxy recovery selects a newly saved entry when the instance had no prior configuration', t => {
  const f = fixture(t)
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23192' }
  prepareClaudeDesktopNetwork(f.plan)
  const id = randomUUID(), entry = { id, name: 'Saved native config' }
  writeFileSync(join(f.library, `${id}.json`), JSON.stringify({ native: 'preserve' }))
  writeFileSync(f.meta, JSON.stringify({ ...f.read(f.meta), entries: [...f.read(f.meta).entries, entry] }))
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.deepEqual(f.read(f.meta), { appliedId: id, entries: [entry] })
  assert.deepEqual(f.editor(), { native: 'preserve' })
})

test('native concurrent edits fail before selecting or losing either configuration', t => {
  const f = fixture(t), source = f.setup({ theme: 'dark' })
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  const id = f.read(f.meta).appliedId, current = join(f.library, `${id}.json`)
  writeFileSync(current, JSON.stringify({ ...f.current(), theme: 'light' }))
  writeFileSync(source.path, JSON.stringify({ theme: 'system' }))
  assert.throws(() => prepareClaudeDesktopGateway(f.plan, f.login), /均已修改/)
  assert.equal(f.read(f.meta).appliedId, id)
  assert.equal(f.read(source.path).theme, 'system')
  assert.equal(f.current().theme, 'light')
})

test('preview fingerprints bind the original entry referenced by a network recovery', t => {
  const f = fixture(t), source = f.setup({ native: 'first' })
  f.plan.networkRoute = { mode: 'proxy', url: 'http://127.0.0.1:23778' }
  prepareClaudeDesktopNetwork(f.plan)
  const before = claudeDesktopGatewayFingerprint(f.plan)
  writeFileSync(source.path, JSON.stringify({ native: 'changed after preview' }))
  assert.notEqual(claudeDesktopGatewayFingerprint(f.plan), before)
  const after = claudeDesktopGatewayFingerprint(f.plan)
  const meta = f.read(f.meta)
  meta.entries[0].name = 'Renamed in native editor'
  writeFileSync(f.meta, JSON.stringify(meta))
  assert.notEqual(claudeDesktopGatewayFingerprint(f.plan), after, 'native catalogue edits invalidate a launch preview')
})

test('malformed native metadata, shared organization ownership and symlinks are retained', t => {
  const f = fixture(t), outside = join(f.root, 'outside')
  mkdirSync(outside); symlinkSync(outside, `${f.desktopDirectory}-3p`)
  assert.throws(() => prepareClaudeDesktopGateway(f.plan, f.profile, f.account), /目录不安全/)
  assert.deepEqual(readdirSync(outside), [])
  rmSync(`${f.desktopDirectory}-3p`)
  const source = f.setup({ theme: 'dark' }, { hybridPointer: 'https://org.invalid/config' })
  assert.throws(() => prepareClaudeDesktopGateway(f.plan, f.profile, f.account), /组织或共享配置/)
  assert.deepEqual(f.read(source.path), { theme: 'dark' })
  writeFileSync(f.meta, JSON.stringify({ appliedId: '../../outside', entries: [] }))
  assert.throws(() => claudeDesktopGatewayFingerprint(f.plan), /标识无效/)
})

test('interrupted gateway selection recovers idempotently on the next preparation', t => {
  const f = fixture(t), source = f.setup({ native: true })
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  const id = f.read(f.meta).appliedId
  writeFileSync(f.meta, JSON.stringify({ appliedId: source.id, entries: [{ id: source.id, name: 'Native choice' }] }))
  prepareClaudeDesktopGateway(f.plan, f.profile, f.account)
  assert.equal(f.read(f.meta).appliedId, id)
  assert.equal(f.current().native, true)
  prepareClaudeDesktopGateway(f.plan, f.login)
  assert.deepEqual(f.current(), { native: true })
})

test('native gateway capability follows schema and declared entry instead of version or bundler names', t => {
  const f = fixture(t)
  assert.doesNotThrow(() => assertClaudeDesktopGatewayCapability(f.application))
  archive(f.asar, source.replaceAll('"flatKey"', '"flatKey"\n'), './elsewhere/renamed-entry.js')
  assert.doesNotThrow(() => assertClaudeDesktopGatewayCapability(f.application))
  archive(f.asar, source.replace('inferenceGatewayApiKey', 'unavailable'))
  assert.throws(() => prepareClaudeDesktopGateway(f.plan, f.profile, f.account), /未提供已验证/)
  assert.equal(existsSync(`${f.desktopDirectory}-3p`), false)
})

test('installed official Desktop exposes the gateway contract without launching', t => {
  if (process.platform !== 'darwin' || !existsSync('/Applications/Claude.app/Contents/Resources/app.asar')) return t.skip('native Desktop unavailable')
  assert.doesNotThrow(() => assertClaudeDesktopGatewayCapability('/Applications/Claude.app'))
})
