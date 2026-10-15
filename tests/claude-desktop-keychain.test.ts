import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectClaudeDesktopKeychain, prepareClaudeDesktopKeychain, type ClaudeDesktopKeychainOptions } from '../src/main/claudeDesktopKeychain'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-keychain-test-')))
  const systemHome = join(root, 'system'), home = join(root, 'instance home'), source = join(systemHome, 'Library', 'Keychains')
  mkdirSync(source, { recursive: true, mode: 0o700 }); mkdirSync(home, { mode: 0o700 })
  const defaultName = 'custom-default.keychain-db'
  writeFileSync(join(source, defaultName), 'synthetic-keychain-file-not-a-real-database', { mode: 0o600 })
  const calls: string[] = []
  const options: ClaudeDesktopKeychainOptions = { platform: 'darwin', systemHome, userId: lstatSync(home).uid,
    defaultKeychain: async directory => { calls.push(directory); return join(directory, 'Library', 'Keychains', defaultName) },
  }
  return { root, systemHome, home, source, calls, options, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('Desktop Keychain inspection reads metadata without creating the Library directory', () => {
  const f = fixture()
  try {
    const value = inspectClaudeDesktopKeychain(f.home, f.options)
    assert.equal(value.library, null); assert.equal(value.link, null)
    assert.equal(value.source.path, f.source); assert.deepEqual(f.calls, [])
    assert.throws(() => lstatSync(join(f.home, 'Library')), { code: 'ENOENT' })
  } finally { f.cleanup() }
})

test('Desktop Keychain preparation shares only the service directory and is idempotent', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.home, 'existing-config.json'), '{"keep":true}')
    const first = await prepareClaudeDesktopKeychain(f.home, f.options)
    const link = join(f.home, 'Library', 'Keychains')
    assert.equal(readlinkSync(link), f.source)
    assert.equal(realpathSync(link), f.source)
    assert.equal(readFileSync(join(f.home, 'existing-config.json'), 'utf8'), '{"keep":true}')
    assert.equal(lstatSync(join(f.home, 'Library')).mode & 0o777, 0o700)
    const second = await prepareClaudeDesktopKeychain(f.home, f.options)
    assert.deepEqual(second, first)
    assert.deepEqual(f.calls, [f.systemHome, f.home, f.systemHome, f.home])
    assert.equal(readFileSync(join(f.source, 'custom-default.keychain-db'), 'utf8'), 'synthetic-keychain-file-not-a-real-database')
  } finally { f.cleanup() }
})

test('Desktop Keychain preparation preserves an occupied directory', async () => {
  const f = fixture()
  try {
    const occupied = join(f.home, 'Library', 'Keychains')
    mkdirSync(occupied, { recursive: true }); writeFileSync(join(occupied, 'keep'), 'keep')
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, f.options), /位置已被占用/)
    assert.equal(readFileSync(join(occupied, 'keep'), 'utf8'), 'keep'); assert.deepEqual(f.calls, [])
  } finally { f.cleanup() }
})

test('Desktop Keychain preparation preserves incorrect and dangling links', async () => {
  for (const dangling of [false, true]) {
    const f = fixture()
    try {
      const library = join(f.home, 'Library'), other = join(f.root, 'other'), link = join(library, 'Keychains')
      mkdirSync(library); if (!dangling) mkdirSync(other)
      symlinkSync(other, link)
      await assert.rejects(prepareClaudeDesktopKeychain(f.home, f.options), /链接指向其他位置/)
      assert.equal(readlinkSync(link), other); assert.deepEqual(f.calls, [])
    } finally { f.cleanup() }
  }
})

test('Desktop Keychain preparation refuses a replaced Library and source directory', async () => {
  const f = fixture()
  try {
    const other = join(f.root, 'other'); mkdirSync(other)
    symlinkSync(other, join(f.home, 'Library'))
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, f.options), /替换目录或符号链接/)
    rmSync(join(f.home, 'Library'))
    const redirectedSystem = join(f.root, 'redirected-system')
    symlinkSync(f.systemHome, redirectedSystem)
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, { ...f.options, systemHome: redirectedSystem }), /替换目录或符号链接/)
    assert.deepEqual(f.calls, [])
  } finally { f.cleanup() }
})

test('Desktop Keychain preparation checks platform, owner and independent HOME', async () => {
  const f = fixture()
  try {
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, { ...f.options, platform: 'linux' }), /仅支持 macOS/)
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, { ...f.options, userId: f.options.userId! + 1 }), /归属当前用户/)
    await assert.rejects(prepareClaudeDesktopKeychain(f.systemHome, f.options), /独立的受管 HOME/)
    assert.deepEqual(f.calls, [])
  } finally { f.cleanup() }
})

test('Desktop Keychain unavailable metadata blocks launch without altering a default keychain', async () => {
  const f = fixture()
  try {
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, { ...f.options, defaultKeychain: async () => { throw new Error('metadata probe failed') } }), /已阻止启动以避免重复弹窗/)
    assert.equal(readlinkSync(join(f.home, 'Library', 'Keychains')), f.source)
    assert.equal(readFileSync(join(f.source, 'custom-default.keychain-db'), 'utf8'), 'synthetic-keychain-file-not-a-real-database')
    await prepareClaudeDesktopKeychain(f.home, f.options)
  } finally { f.cleanup() }
})

test('Desktop Keychain check accepts custom names and refuses a different default', async () => {
  const f = fixture()
  try {
    const other = join(f.source, 'another.keychain-db'); writeFileSync(other, 'different synthetic database')
    await assert.rejects(prepareClaudeDesktopKeychain(f.home, { ...f.options,
      defaultKeychain: async directory => directory === f.home ? other : join(f.source, 'custom-default.keychain-db'),
    }), /已阻止启动以避免重复弹窗/)
    await prepareClaudeDesktopKeychain(f.home, f.options)
  } finally { f.cleanup() }
})

test('Desktop Keychain identity ignores ordinary changes inside the system service directory', async () => {
  const f = fixture()
  try {
    const before = await prepareClaudeDesktopKeychain(f.home, f.options)
    writeFileSync(join(f.source, 'another-synthetic-file'), 'fixture')
    assert.deepEqual(inspectClaudeDesktopKeychain(f.home, f.options), before)
  } finally { f.cleanup() }
})
