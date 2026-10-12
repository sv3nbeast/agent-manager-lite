import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectClaudeCodeDesktopApplications } from '../src/main/claudeCodeDesktopAdapter'
import { detectClaudeCodeApplications } from '../src/main/claudeCodeInstanceAdapter'
import { discoverClaudeCodeCandidates, inspectClaudeCodeLoginBoundary, inspectClaudeCodeSessions, probeClaudeCodeCliCapabilities, probeClaudeCodeCliVersion, probeClaudeCodeLoginStatus, verifyClaudeCodeCli, verifyClaudeCodeDesktop } from '../src/main/claudeCodeVerification'
import { claudeCodeAuthEnvironment, claudeCodeConfigPaths, projectClaudeCodeConfig, readClaudeCodeAuthStatus } from '../src/main/claudeCodeInstanceAdapter'
import { claudeCodeCapabilitySchema, claudeCodeCredentialCompatibility, claudeCodeDesktopClient, claudeCodeClient } from '../src/shared/claudeCode'
import { accountCompatibility } from '../src/shared/agentClients'
import { assertImplementedClient, getClientAdapterRegistration, listClientAdapterRegistrations } from '../src/main/clientAdapterRegistry'

test('Claude CLI and Desktop remain separate planned application boundaries', () => {
  assert.equal(claudeCodeClient.status, 'planned')
  assert.equal(claudeCodeDesktopClient.status, 'planned')
  assert.deepEqual(claudeCodeClient.capabilities.launchModes, ['cli'])
  assert.deepEqual(claudeCodeDesktopClient.capabilities.launchModes, ['desktop'])
  assert.doesNotThrow(() => claudeCodeCapabilitySchema.parse(claudeCodeDesktopClient.capabilities))
})

test('Claude Desktop detection validates bundle identity and version without launching it', t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-desktop-')), app = join(root, 'Claude.app')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>Claude</string><key>CFBundleDisplayName</key><string>Claude</string><key>CFBundleShortVersionString</key><string>2.31226.1</string></dict></plist>`)
  writeFileSync(join(app, 'Contents', 'MacOS', 'Claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }); chmodSync(join(app, 'Contents', 'MacOS', 'Claude'), 0o700)
  const found = detectClaudeCodeDesktopApplications({ platform: 'darwin', roots: [app] })
  assert.equal(found.length, 1)
  assert.equal(found[0].bundleId, 'com.anthropic.claudefordesktop')
  assert.equal(found[0].version, '2.31226.1')
  assert.equal(verifyClaudeCodeDesktop(found[0]).canRegister, false)
  const wrong = join(root, 'Other.app')
  mkdirSync(join(wrong, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(wrong, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>')
  assert.equal(detectClaudeCodeDesktopApplications({ platform: 'darwin', roots: [wrong] }).length, 0)
  const linked = join(root, 'Linked.app'), externalPlist = join(root, 'external.plist')
  mkdirSync(join(linked, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(externalPlist, '<plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>')
  symlinkSync(externalPlist, join(linked, 'Contents', 'Info.plist'))
  writeFileSync(join(linked, 'Contents', 'MacOS', 'Claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  assert.equal(detectClaudeCodeDesktopApplications({ platform: 'darwin', roots: [linked] }).length, 0)
  const windowsRoot = join(root, 'Programs', 'Claude'), windowsExecutable = join(windowsRoot, 'Claude.exe')
  mkdirSync(windowsRoot, { recursive: true }); writeFileSync(windowsExecutable, 'binary', { mode: 0o700 }); chmodSync(windowsExecutable, 0o700)
  const windows = detectClaudeCodeDesktopApplications({ platform: 'win32', roots: [windowsExecutable] })
  assert.equal(windows.length, 1)
  assert.equal(windows[0].applicationKind, 'desktop')
})

test('CLI verification executes only a selected canonical binary and remains fail-closed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-cli-')), bin = join(root, 'bin'), executable = join(bin, 'claude')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(bin); writeFileSync(executable, '#!/bin/sh\nprintf "2.1.295 (Claude Code)\\n"\n', { mode: 0o700 }); chmodSync(executable, 0o700)
  const found = detectClaudeCodeApplications({ home: root, path: bin, platform: 'darwin' })
  assert.equal(found.length, 1)
  assert.deepEqual(await probeClaudeCodeCliVersion(found[0].path, { runner: async () => '2.1.295 (Claude Code)' }), { state: 'verified', version: '2.1.295' })
  assert.equal((await probeClaudeCodeCliCapabilities(found[0].path, { runner: async () => '--print --model --resume --session-id --settings --add-dir' })).state, 'verified')
  assert.equal((await probeClaudeCodeCliCapabilities(found[0].path, { runner: async () => '--help --model' })).state, 'blocked')
  const login = await probeClaudeCodeLoginStatus(found[0].path, join(root, 'instance', 'claude'), { runner: async () => '{"loggedIn":true,"authMethod":"oauth","accessToken":"must-not-return"}' })
  assert.deepEqual(login, { state: 'verified', authenticated: true, method: 'oauth' })
  const report = await verifyClaudeCodeCli(found[0], { instanceHome: join(root, 'instance'), runner: async () => '2.1.295 (Claude Code)' })
  assert.equal(report.canRegister, false)
  assert.equal(report.gates.globalStateOwnership, 'pending')
  assert.equal(report.gates.credentialIsolation, 'pending')
  assert.equal(report.login?.state, 'pending')
  assert.ok(report.reasons.some(reason => reason.includes('.claude.json')))
  const link = join(bin, 'claude-link'); symlinkSync(executable, link)
  assert.equal(await probeClaudeCodeCliVersion(link, { runner: async () => '2.1.295' }).then(result => result.state), 'blocked')
})

test('session keys include config directory and source file, and symlinks are rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-sessions-')), config = join(root, 'claude'), projects = join(config, 'projects')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(projects, '-Users-demo'), { recursive: true })
  writeFileSync(join(projects, '-Users-demo', 'same-id.jsonl'), '{}\n')
  mkdirSync(join(projects, '-Users-other'))
  writeFileSync(join(projects, '-Users-other', 'same-id.jsonl'), '{}\n')
  const result = inspectClaudeCodeSessions(config)
  assert.equal(result.state, 'verified')
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.duplicateIds, ['same-id'])
  assert.equal(result.files[0].configDirectory, realpathSync(config))
  assert.equal(result.files[0].sourceFile.endsWith('same-id.jsonl'), true)
  const outside = join(root, 'outside.jsonl'); writeFileSync(outside, '{}\n'); symlinkSync(outside, join(projects, 'escape.jsonl'))
  assert.equal(inspectClaudeCodeSessions(config).state, 'blocked')
  const linkedConfig = join(root, 'linked-claude'); symlinkSync(config, linkedConfig)
  assert.equal(inspectClaudeCodeSessions(linkedConfig).state, 'blocked')
})

test('Claude login boundary rejects ambiguous credential precedence and credential links without exposing values', () => {
  const paths = claudeCodeConfigPaths('/tmp/aml-claude-instance/claude', '/tmp/aml-home')
  const result = inspectClaudeCodeLoginBoundary(paths, { ANTHROPIC_API_KEY: 'secret-key', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' })
  assert.equal(result.state, 'blocked')
  assert.deepEqual(result.conflictingSources.sort(), ['api_key', 'oauth_token'])
  assert.equal('secret-key' in result, false)
  assert.equal('secret-token' in result, false)
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-credentials-'))
  try {
    const linked = claudeCodeConfigPaths(join(root, 'claude'), join(root, 'home'))
    mkdirSync(linked.configDirectory, { recursive: true }); writeFileSync(join(root, 'credentials.json'), '{}'); symlinkSync(join(root, 'credentials.json'), linked.credentialsFile)
    assert.equal(inspectClaudeCodeLoginBoundary(linked, {}).state, 'blocked')
    const dangling = claudeCodeConfigPaths(join(root, 'dangling-claude'), join(root, 'home'))
    mkdirSync(dangling.configDirectory, { recursive: true }); symlinkSync(join(root, 'missing-credentials.json'), dangling.credentialsFile)
    assert.equal(inspectClaudeCodeLoginBoundary(dangling, {}).state, 'blocked')
    const realConfig = join(root, 'real-claude'), linkedConfigDirectory = join(root, 'linked-claude')
    mkdirSync(realConfig, { recursive: true }); symlinkSync(realConfig, linkedConfigDirectory)
    assert.equal(inspectClaudeCodeLoginBoundary(claudeCodeConfigPaths(linkedConfigDirectory, join(root, 'home')), {}).state, 'blocked')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Claude auth projection keeps API key, bearer, and OAuth credentials in separate channels', () => {
  const common = { identityService: 'anthropic' as const, protocol: 'anthropic_messages' as const, models: ['claude-sonnet'], wireApi: 'chat_completions' as const }
  assert.deepEqual(claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'anthropic_api_key', credentials: { apiKey: 'api-key-fixture' } }), { ANTHROPIC_API_KEY: 'api-key-fixture' })
  assert.deepEqual(claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'anthropic_bearer', credentials: { apiKey: 'bearer-fixture' } }), { ANTHROPIC_AUTH_TOKEN: 'bearer-fixture' })
  assert.deepEqual(claudeCodeAuthEnvironment({ ...common, kind: 'oauth', credentialKind: 'claude_ai_oauth', credentials: { accessToken: 'oauth-fixture' } }), { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' })
  assert.throws(() => claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'openai_api_key' as never, credentials: { apiKey: 'wrong-boundary' } }), /凭据类型未通过/)
  assert.throws(() => claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'anthropic_api_key', protocol: 'openai_responses' as never, credentials: { apiKey: 'wrong-protocol' } }), /Anthropic Messages 协议/)
  assert.throws(() => claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'anthropic_api_key', credentials: { apiKey: '   ' } }), /缺少 API Key/)
  assert.throws(() => claudeCodeAuthEnvironment({ ...common, kind: 'oauth', credentialKind: 'claude_ai_oauth', credentials: { accessToken: '   ' } }), /没有可用/)
  assert.throws(() => claudeCodeAuthEnvironment({ ...common, kind: 'api_key', credentialKind: 'anthropic_api_key', credentials: { apiKey: 'secret' }, identityService: 'openai' as never }), /Anthropic 身份服务/)
  assert.throws(() => projectClaudeCodeConfig({ instanceHome: '/tmp/aml-claude-instance', authToken: 'bearer', apiKey: 'api-key' }), /API Key 或 Bearer Token/)
  assert.equal(accountCompatibility('claude_code', { ...common, kind: 'api_key', credentialKind: 'anthropic_api_key' }, { connectionMode: 'native' }).compatible, true)
  assert.equal(accountCompatibility('claude_code', { ...common, kind: 'api_key', credentialKind: 'anthropic_api_key', protocol: 'openai_responses' as never }, { connectionMode: 'native' }).compatible, false)
})

test('Claude auth status probe uses a stable config directory and strips untrusted labels', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-auth-status-')), executable = join(root, 'claude'), config = join(root, 'config')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(config, { recursive: true })
  writeFileSync(executable, `#!/bin/sh\nprintf '%s' '{"loggedIn":true,"authMethod":"oauth secret-token","apiProvider":"https://gateway.invalid/?token=secret-token"}'\n`, { mode: 0o700 })
  chmodSync(executable, 0o700)
  const status = await readClaudeCodeAuthStatus({ executable, configDirectory: config, environment: { ANTHROPIC_API_KEY: 'inherited-secret' } })
  assert.equal(status.loggedIn, true)
  assert.equal(status.authMethod, 'oauth')
  assert.equal(status.apiProvider, undefined)
  assert.equal(JSON.stringify(status).includes('secret-token'), false)
  const linked = join(root, 'linked-config'); symlinkSync(config, linked)
  await assert.rejects(() => readClaudeCodeAuthStatus({ executable, configDirectory: linked }), /普通目录/)
})

test('Claude credential compatibility never treats OpenAI credential kinds as Anthropic identities', () => {
  assert.equal(claudeCodeCredentialCompatibility({ kind: 'anthropic_api_key', model: 'claude-sonnet', protocol: 'anthropic_messages' }).compatible, true)
  assert.equal(claudeCodeCredentialCompatibility({ kind: 'anthropic_api_key', model: 'claude-sonnet', baseUrl: 'https://gateway.example/v1?token=secret' }).compatible, false)
  assert.equal(claudeCodeCredentialCompatibility({ kind: 'anthropic_api_key', model: '', protocol: 'anthropic_messages' }).compatible, false)
  assert.deepEqual(discoverClaudeCodeCandidates({ home: '/missing', path: '', platform: 'win32' }), { cli: [], desktop: [] })
})

test('planned Claude registrations are inspectable but cannot enter the common lifecycle', () => {
  const registrations = listClientAdapterRegistrations().filter(item => item.clientType === 'claude_code')
  assert.deepEqual(registrations.map(item => item.applicationKinds), [['cli'], ['desktop']])
  assert.equal(getClientAdapterRegistration('claude_code', 'cli')?.readiness, 'pending')
  assert.throws(() => assertImplementedClient('claude_code', 'cli'), /尚未通过登录、配置、隔离和会话边界验收/)
  assert.equal(assertImplementedClient('codex').clientType, 'codex')
})
