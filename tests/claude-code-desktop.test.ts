import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectClaudeCodeDesktopApplications, inspectClaudeCodeDesktopIsolation, type ClaudeCodeDesktopApplication } from '../src/main/claudeCodeDesktopAdapter'

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
