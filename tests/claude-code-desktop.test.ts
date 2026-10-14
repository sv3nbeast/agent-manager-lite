import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeDesktopEnvironment, claudeCodeDesktopInstanceMarker, claudeCodeDesktopMacLaunchArgs, claudeCodeDesktopProfileDirectory, detectClaudeCodeDesktopApplications, inspectClaudeCodeDesktopIsolation, isClaudeCodeDesktopProcessOwned, validateClaudeCodeDesktopArgs, validateClaudeCodeDesktopProfileDirectory, type ClaudeCodeDesktopApplication } from '../src/main/claudeCodeDesktopAdapter'

const application: ClaudeCodeDesktopApplication = {
  clientType: 'claude_code', applicationKind: 'desktop', kind: 'desktop', id: 'desktop-fixture',
  name: 'Claude', path: '/Applications/Claude.app', executable: '/Applications/Claude.app/Contents/MacOS/Claude',
  bundleId: 'com.anthropic.claudefordesktop', version: '2.0.0',
}

test('Desktop rejects invalid profile locations instead of reporting them pending', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-boundary-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'file'), link = join(root, 'link')
  writeFileSync(file, 'not a directory'); symlinkSync(root, link)
  for (const directory of [undefined, '', 'relative/profile', join(root, 'missing'), file, link]) {
    const result = inspectClaudeCodeDesktopIsolation(application, directory)
    assert.equal(result.status, 'blocked', String(directory))
    assert.equal(result.checks.find(check => check.id === 'profile')?.status, 'blocked')
    assert.equal(result.canCreateInstance, false)
  }
})

test('an existing Desktop profile never proves login or shared session isolation', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-boundary-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'config.json')
  writeFileSync(config, 'must-not-read-or-change')
  const result = inspectClaudeCodeDesktopIsolation(application, root)
  assert.equal(result.status, 'pending')
  assert.equal(result.canCreateInstance, false)
  assert.deepEqual(result.checks.map(check => check.id), ['profile', 'login', 'configuration', 'credentials', 'sessions', 'lifecycle'])
  assert.ok(result.checks.every(check => check.status === 'pending'))
  assert.ok(result.checks.find(check => check.id === 'configuration')?.detail.includes('第三方推理配置'))
  assert.ok(result.checks.find(check => check.id === 'sessions')?.detail.includes('同一条 CLI 会话'))
  assert.equal(readFileSync(config, 'utf8'), 'must-not-read-or-change')
  assert.equal(JSON.stringify(result).includes('must-not-read-or-change'), false)
})

test('Desktop bundle metadata cannot point to an executable outside its MacOS directory', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-bundle-'))), app = join(root, 'Claude.app')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  const plist = join(app, 'Contents', 'Info.plist')
  const metadata = (name: string) => `<plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`
  writeFileSync(join(app, 'Contents', 'escape'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  for (const name of ['../escape', '..\\escape', '/bin/sh']) {
    writeFileSync(plist, metadata(name))
    assert.deepEqual(detectClaudeCodeDesktopApplications({ roots: [app] }), [])
  }
  writeFileSync(plist, metadata('Claude'))
  symlinkSync(join(app, 'Contents', 'escape'), join(app, 'Contents', 'MacOS', 'Claude'))
  assert.deepEqual(detectClaudeCodeDesktopApplications({ roots: [app] }), [])
})

test('Desktop launch arguments bind one existing profile and one nonce', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-launch-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'desktop')
  mkdirSync(profile)
  const nonce = 'nonce-fixture'
  const args = claudeCodeDesktopMacLaunchArgs({
    clientType: 'claude_code', application: '/Applications/Claude.app', desktopDirectory: profile,
    nonce, args: ['--disable-gpu'], networkRoute: undefined,
  })
  assert.deepEqual(args, ['-n', '-a', '/Applications/Claude.app', '--args', `--user-data-dir=${profile}`, claudeCodeDesktopInstanceMarker(nonce), '--disable-gpu'])
  assert.equal(claudeCodeDesktopProfileDirectory(root), profile)
  assert.equal(validateClaudeCodeDesktopProfileDirectory(profile), profile)
})

test('Desktop launch arguments reject profile, marker and remote debugging overrides', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-launch-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'desktop')
  mkdirSync(profile)
  for (const arg of ['--user-data-dir=/tmp/other', '--cml-instance=other', '--remote-debugging-port=9222', '--profile-directory=Default']) {
    assert.throws(() => validateClaudeCodeDesktopArgs([arg]), /不能覆盖/)
    assert.throws(() => claudeCodeDesktopMacLaunchArgs({ clientType: 'claude_code', application: '/Applications/Claude.app', desktopDirectory: profile, nonce: 'nonce-fixture', args: [arg], networkRoute: undefined }), /不能覆盖/)
  }
  const file = join(root, 'file'), link = join(root, 'link')
  writeFileSync(file, 'file')
  symlinkSync(profile, link)
  assert.throws(() => validateClaudeCodeDesktopProfileDirectory(file), /普通目录/)
  assert.throws(() => validateClaudeCodeDesktopProfileDirectory(link), /普通目录/)
  assert.throws(() => claudeCodeDesktopMacLaunchArgs({ clientType: 'claude_code', application: '/Applications/Claude.app', desktopDirectory: join(root, 'missing'), nonce: 'nonce-fixture', args: [], networkRoute: undefined }), /普通目录/)
})

test('Desktop profile validation rejects a parent symlink', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-parent-link-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const actual = join(root, 'actual'), profile = join(actual, 'desktop'), alias = join(root, 'alias')
  mkdirSync(profile, { recursive: true })
  symlinkSync(actual, alias, 'dir')
  assert.throws(() => validateClaudeCodeDesktopProfileDirectory(join(alias, 'desktop')), /普通目录/)
  assert.throws(() => claudeCodeDesktopMacLaunchArgs({ clientType: 'claude_code', application: '/Applications/Claude.app', desktopDirectory: join(alias, 'desktop'), nonce: 'nonce-fixture', args: [], networkRoute: undefined }), /普通目录/)
})

test('Desktop extra arguments are an explicit diagnostic allowlist', () => {
  assert.doesNotThrow(() => validateClaudeCodeDesktopArgs(['--disable-gpu']))
  for (const arg of [
    '--load-extension=/tmp/extension', '--disable-extensions-except=/tmp/extension', '--preload=/tmp/hook.js',
    '--js-flags=--jitless', '--inspect=127.0.0.1:9229', '--remote-debugging-pipe', '--no-sandbox',
    '--disable-features=Sandbox', '--lang=en-US', '--unknown-diagnostic-flag', '--disable-gpu=true',
    '--disable-software-rasterizer', '-user-data-dir=/tmp/other', '--',
  ]) assert.throws(() => validateClaudeCodeDesktopArgs([arg]), /不能覆盖/)
})

test('Desktop environment drops inherited identity and Electron hooks but preserves safe values', () => {
  const env = claudeCodeDesktopEnvironment({
    PATH: '/usr/bin', LANG: 'zh_CN.UTF-8', CLAUDE_CONFIG_DIR: '/tmp/global', CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=/tmp/hook', CML_TEST_SECRET: 'secret',
    HTTP_PROXY: 'http://proxy.invalid:80',
  }, { mode: 'direct' })
  assert.deepEqual(env.PATH, '/usr/bin')
  assert.deepEqual(env.LANG, 'zh_CN.UTF-8')
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CML_TEST_SECRET']) assert.equal(env[key], undefined, key)
  assert.equal(env.HTTP_PROXY, '')
  assert.equal(env.NO_PROXY, '*')
})

test('Desktop process ownership requires exact executable, profile and nonce', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-owner-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'desktop')
  mkdirSync(profile)
  const plan = { clientType: 'claude_code' as const, executable: '/Applications/Claude.app/Contents/MacOS/Claude', desktopDirectory: profile, nonce: 'nonce-fixture' }
  const marker = claudeCodeDesktopInstanceMarker(plan.nonce)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, marker] }), true)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${join(root, 'other')}`, marker] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: '/tmp/other', args: ['Claude', `--user-data-dir=${profile}`, marker] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, `--user-data-dir=${profile}`, marker] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, marker, marker] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, '--user-data-dir=/tmp/other', marker] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, '--remote-debugging-pipe', marker] }), false)
  for (const extra of [
    ['--cml-instance', 'other'], ['-cml-instance=other'], ['--USER-DATA-DIR=/tmp/other'],
    ['-user-data-dir=/tmp/other'], ['--remote-debugging-future-option=9222'],
  ]) assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', `--user-data-dir=${profile}`, marker, ...extra] }), false)
  assert.equal(isClaudeCodeDesktopProcessOwned(plan, { executable: plan.executable, args: ['Claude', '--', `--user-data-dir=${profile}`, marker] }), false)
})
