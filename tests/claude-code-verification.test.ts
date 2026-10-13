import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureClaudeExecutableIdentity } from '../src/main/claudeCodeCapability'
import { probeClaudeCodeCliCapabilities, probeClaudeCodeLoginStatus } from '../src/main/claudeCodeVerification'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-verification-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const executable = join(root, 'claude'), configDirectory = join(root, 'config')
  mkdirSync(configDirectory)
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(executable, 0o700)
  return { root, executable, configDirectory }
}

test('native Claude binaries larger than the old 128 MiB limit remain verifiable', t => {
  const { executable } = fixture(t)
  const descriptor = openSync(executable, 'r+')
  try { ftruncateSync(descriptor, 129 * 1024 * 1024) } finally { closeSync(descriptor) }
  const identity = captureClaudeExecutableIdentity(executable)
  assert.equal(identity.size, 129 * 1024 * 1024)
  assert.match(identity.sha256, /^[a-f0-9]{64}$/)
})

test('oversized or non-executable Claude candidates fail before they can be launched', t => {
  const { executable } = fixture(t)
  chmodSync(executable, 0o600)
  assert.throws(() => captureClaudeExecutableIdentity(executable), /普通可执行文件/)
  chmodSync(executable, 0o700)
  const descriptor = openSync(executable, 'r+')
  try { ftruncateSync(descriptor, 1024 * 1024 * 1024 + 1) } finally { closeSync(descriptor) }
  assert.throws(() => captureClaudeExecutableIdentity(executable), /文件过大/)
})

test('managed CLI requires configuration and MCP isolation contracts across upgrades', async t => {
  const { executable } = fixture(t)
  const complete = '--print --model --resume --session-id --settings --add-dir --setting-sources --strict-mcp-config --mcp-config'
  assert.equal((await probeClaudeCodeCliCapabilities(executable, { runner: async () => complete })).state, 'verified')
  for (const removed of ['--setting-sources', '--strict-mcp-config', '--mcp-config']) {
    const result = await probeClaudeCodeCliCapabilities(executable, { runner: async () => complete.replace(removed, `${removed}-unsupported`) })
    assert.equal(result.state, 'blocked')
  }
  const failure = await probeClaudeCodeCliCapabilities(executable, { runner: async () => { throw new Error('fixture-secret-must-not-escape') } })
  assert.equal(failure.state, 'blocked'); assert.ok(!JSON.stringify(failure).includes('fixture-secret'))
})

test('a complete CLI help banner followed by a failed exit or timeout cannot pass capability validation', async t => {
  const { executable } = fixture(t)
  const flags = '--print --model --resume --session-id --settings --add-dir --setting-sources --strict-mcp-config --mcp-config'
  const banner = `#!/bin/sh\nprintf '%s\\n' '${flags}'\n`
  writeFileSync(executable, banner + 'exit 7\n', { mode: 0o700 })
  assert.equal((await probeClaudeCodeCliCapabilities(executable)).state, 'blocked')
  writeFileSync(executable, banner + 'exec /bin/sleep 5\n', { mode: 0o700 })
  assert.equal((await probeClaudeCodeCliCapabilities(executable, { timeoutMs: 250 })).state, 'blocked')
})

test('CLI capability output contains only advertised command and alias identifiers', async t => {
  const { executable } = fixture(t)
  const flags = '--print --model --resume --session-id --settings --add-dir --setting-sources --strict-mcp-config --mcp-config'
  const help = `${flags}\nCommands:\n  agents [options]              Manage agents\n  attach <id|name>               Attach\n                                 secret-description-not-a-command\n  plugin|plugins                Manage plugins\n  update|upgrade                Update CLI\n  agents                        Duplicate\n  future-command [options]      Future capability\n  auth;fixture-unsafe            Unsafe\n  bad|../escape                  Unsafe alias\n  --bad-option                  Not a command\nExamples:\n  secret-example                Not a command\n`
  const result = await probeClaudeCodeCliCapabilities(executable, { runner: async () => help })
  assert.equal(result.state, 'verified')
  assert.deepEqual(result.advertisedCommands, ['agents', 'attach', 'plugin', 'plugins', 'update', 'upgrade', 'future-command'])
  assert.ok(!JSON.stringify(result).includes('secret-'))
  const noTable = await probeClaudeCodeCliCapabilities(executable, { runner: async () => `${flags}\n  auth [options]` })
  assert.equal(noTable.advertisedCommands, undefined)
})

test('official logged-out auth status exit code is pending authentication rather than probe failure', async t => {
  const { executable, configDirectory } = fixture(t)
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":false,"authMethod":"none"}\'\nexit 1\n', { mode: 0o700 })
  assert.deepEqual(await probeClaudeCodeLoginStatus(executable, configDirectory), {
    state: 'pending', authenticated: false, reason: 'Claude Code 当前配置目录未登录',
  })
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"oauth"}\'\nexit 1\n', { mode: 0o700 })
  assert.equal((await probeClaudeCodeLoginStatus(executable, configDirectory)).state, 'blocked')
})

test('Bearer auth is not mislabeled as subscription OAuth by the CLI oauth_token label', async t => {
  const { executable, configDirectory } = fixture(t)
  const runner = async () => '{"loggedIn":true,"authMethod":"oauth_token","accessToken":"fixture-secret","email":"private@example.test"}'
  const bearer = await probeClaudeCodeLoginStatus(executable, configDirectory, { environment: { ANTHROPIC_AUTH_TOKEN: 'fixture-bearer' }, runner })
  assert.deepEqual(bearer, { state: 'verified', authenticated: true, method: 'bearer' })
  const oauth = await probeClaudeCodeLoginStatus(executable, configDirectory, { environment: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth' }, runner })
  assert.deepEqual(oauth, { state: 'verified', authenticated: true, method: 'oauth' })
  const mixed = await probeClaudeCodeLoginStatus(executable, configDirectory, { environment: { ANTHROPIC_API_KEY: 'fixture-api', ANTHROPIC_AUTH_TOKEN: 'fixture-bearer' }, runner })
  assert.equal(mixed.state, 'blocked')
  assert.ok(!JSON.stringify([bearer, oauth, mixed]).includes('fixture-'))
})

test('a login report from another configuration cannot certify the selected instance', async t => {
  const { executable, configDirectory, root } = fixture(t)
  const otherDirectory = join(root, 'other'); mkdirSync(otherDirectory)
  const result = await probeClaudeCodeLoginStatus(executable, configDirectory, { runner: async () => JSON.stringify({ loggedIn: true, authMethod: 'api_key', configDirectory: otherDirectory }) })
  assert.equal(result.state, 'blocked')
  assert.match(result.reason ?? '', /其他配置目录/)
  const missing = await probeClaudeCodeLoginStatus(executable, join(root, 'not-created'))
  assert.equal(missing.state, 'pending'); assert.equal(missing.authenticated, false)
})
