import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeClaudeCodeOnboarding } from '../src/main/claudeCodeOnboarding'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-onboarding-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configDirectory = join(root, 'config'); mkdirSync(configDirectory, { mode: 0o700 })
  return { root, configDirectory, stateFile: join(configDirectory, '.claude.json') }
}

test('managed first launch initializes only onboarding preference with private permissions', t => {
  const { configDirectory, stateFile } = fixture(t)
  assert.deepEqual(initializeClaudeCodeOnboarding(configDirectory), { initialized: true })
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { hasCompletedOnboarding: true })
  assert.equal(lstatSync(stateFile).mode & 0o777, 0o600)
  assert.equal(lstatSync(stateFile).nlink, 1)
  assert.deepEqual(readdirSync(configDirectory), ['.claude.json'])
  const before = lstatSync(stateFile)
  assert.deepEqual(initializeClaudeCodeOnboarding(configDirectory), { initialized: false })
  assert.equal(lstatSync(stateFile).ino, before.ino)
  assert.equal(lstatSync(stateFile).mtimeMs, before.mtimeMs)
})

test('initialization atomically preserves every existing field and file permissions', t => {
  const { configDirectory, stateFile } = fixture(t)
  const original = { theme: 'light', projects: { fixture: { hasTrustDialogAccepted: false } }, oauthAccount: { synthetic: true }, customApiKeyResponses: { approved: [], rejected: ['fixture'] }, futureVersion: { nested: [1, false, null] }, ['__proto__']: { safe: true } }
  writeFileSync(stateFile, JSON.stringify(original), { mode: 0o640 }); chmodSync(stateFile, 0o640)
  const before = lstatSync(stateFile)
  assert.deepEqual(initializeClaudeCodeOnboarding(configDirectory), { initialized: true })
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { ...original, hasCompletedOnboarding: true })
  const after = lstatSync(stateFile)
  assert.notEqual(after.ino, before.ino)
  assert.equal(after.mode & 0o777, 0o640)
  assert.equal(after.nlink, 1)
  assert.deepEqual(readdirSync(configDirectory), ['.claude.json'])
})

test('an existing onboarding value is preserved byte-for-byte including false and future formats', t => {
  const { configDirectory, stateFile } = fixture(t)
  for (const value of [true, false, null, 'future', 0, { future: 1 }]) {
    const original = JSON.stringify({ hasCompletedOnboarding: value, theme: 'dark' }, null, 4) + '\n\n'
    writeFileSync(stateFile, original, { mode: 0o600 })
    const before = lstatSync(stateFile)
    assert.deepEqual(initializeClaudeCodeOnboarding(configDirectory), { initialized: false })
    assert.equal(readFileSync(stateFile, 'utf8'), original)
    assert.equal(lstatSync(stateFile).ino, before.ino)
    assert.equal(lstatSync(stateFile).mtimeMs, before.mtimeMs)
  }
})

test('malformed or non-object global state is rejected without replacement or diagnostic disclosure', t => {
  const { configDirectory, stateFile } = fixture(t)
  for (const original of ['{invalid-fixture-secret', '[]', 'null', 'false', '"fixture-secret"', '']) {
    writeFileSync(stateFile, original)
    assert.throws(() => initializeClaudeCodeOnboarding(configDirectory), error => error instanceof Error && !error.message.includes('fixture-secret') && /JSON/.test(error.message))
    assert.equal(readFileSync(stateFile, 'utf8'), original)
    assert.deepEqual(readdirSync(configDirectory), ['.claude.json'])
  }
})

test('global-state symlinks, hardlinks and directories cannot redirect or share initialization', t => {
  const { root, configDirectory, stateFile } = fixture(t)
  const outside = join(root, 'outside.json'); writeFileSync(outside, '{}', { mode: 0o600 })
  symlinkSync(outside, stateFile)
  assert.throws(() => initializeClaudeCodeOnboarding(configDirectory), /无链接的普通文件/)
  assert.equal(readFileSync(outside, 'utf8'), '{}'); rmSync(stateFile)
  linkSync(outside, stateFile)
  assert.throws(() => initializeClaudeCodeOnboarding(configDirectory), /无链接的普通文件/)
  assert.equal(readFileSync(outside, 'utf8'), '{}'); rmSync(stateFile)
  mkdirSync(stateFile)
  assert.throws(() => initializeClaudeCodeOnboarding(configDirectory), /无链接的普通文件/)
})

test('configuration-directory links and missing or relative directories are not created or followed', t => {
  const { root, configDirectory } = fixture(t)
  const linked = join(root, 'linked'); symlinkSync(configDirectory, linked)
  assert.throws(() => initializeClaudeCodeOnboarding(linked), /稳定的普通配置目录/)
  assert.throws(() => initializeClaudeCodeOnboarding('config'), /绝对配置目录/)
  assert.throws(() => initializeClaudeCodeOnboarding(join(root, 'missing')), /ENOENT/)
  assert.deepEqual(readdirSync(configDirectory), [])
})
