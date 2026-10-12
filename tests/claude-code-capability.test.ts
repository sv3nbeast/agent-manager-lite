import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureClaudeExecutableIdentity, claudeCodeCanRegisterDesktop, inspectClaudeCodeCapabilities, validateClaudeExecutableIdentity } from '../src/main/claudeCodeCapability'

test('Claude capability report keeps Desktop planned and does not register it', () => {
  const report = inspectClaudeCodeCapabilities({ platform: 'linux', home: '/tmp/aml-empty-home', path: '' })
  assert.equal(report.cliAcceptance.configProjection, 'verified')
  assert.equal(report.desktopAcceptance.configProjection, 'pending')
  assert.equal(claudeCodeCanRegisterDesktop(), false)
})

test('Claude CLI executable identity detects replacement and symlink paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-capability-'))
  try {
    const executable = join(root, 'claude')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o700)
    const identity = captureClaudeExecutableIdentity(executable)
    assert.equal(validateClaudeExecutableIdentity(identity).sha256, identity.sha256)
    writeFileSync(executable, '#!/bin/sh\nexit 1\n'); chmodSync(executable, 0o700)
    assert.throws(() => validateClaudeExecutableIdentity(identity), /身份已变化/)
    const link = join(root, 'claude-link'); symlinkSync(executable, link)
    assert.throws(() => captureClaudeExecutableIdentity(link), /符号链接/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
