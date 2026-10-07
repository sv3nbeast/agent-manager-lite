import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeClientType, claudeCodeClient } from '../src/shared/claudeCode'
import { claudeCodeEnvironment, claudeCodeConfigPaths, detectClaudeCodeApplications, projectClaudeCodeConfig, validateClaudeCodeCliArgs } from '../src/main/claudeCodeInstanceAdapter'

test('Claude Code foundation stays planned and declares its independent protocol', () => {
  assert.equal(claudeCodeClientType, 'claude_code')
  assert.equal(claudeCodeClient.status, 'planned')
  assert.equal(claudeCodeClient.protocol, 'anthropic_messages')
  assert.deepEqual(claudeCodeClient.capabilities.launchModes, ['cli'])
  assert.equal(claudeCodeClient.capabilities.localApi, false)
})

test('Claude Code detection is read-only, canonical and does not execute candidates', t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-code-')), bin = join(root, 'bin'), candidate = join(bin, 'claude'), link = join(bin, 'claude-link')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(bin); writeFileSync(candidate, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); symlinkSync(candidate, link)
  const applications = detectClaudeCodeApplications({ home: root, path: `${bin}:${bin}`, platform: 'darwin' })
  assert.equal(applications.length, 1)
  assert.equal(applications[0].clientType, 'claude_code')
  assert.equal(applications[0].path, realpathSync(candidate))
})

test('projection isolates config, credentials and sessions without writing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-code-'))
  try {
    const projection = projectClaudeCodeConfig({ instanceHome: root, model: 'claude-sonnet', baseUrl: 'https://gateway.invalid', apiKey: 'test-key' })
    assert.equal(projection.paths.configDirectory, join(root, 'claude'))
    assert.equal(projection.paths.credentialsFile, join(root, 'claude', '.credentials.json'))
    assert.equal(projection.environment.CLAUDE_CONFIG_DIR, join(root, 'claude'))
    assert.equal(projection.environment.ANTHROPIC_API_KEY, 'test-key')
    assert.equal(projection.paths.globalStateFile.endsWith('.claude.json'), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('environment removes inherited provider credentials before applying the projection', () => {
  const projection = { environment: { CLAUDE_CONFIG_DIR: '/instance/claude', ANTHROPIC_MODEL: 'sonnet' } }
  const env = claudeCodeEnvironment({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/user/.claude', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://old', CLAUDE_CODE_USE_BEDROCK: '1' }, projection)
  assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/instance/claude', ANTHROPIC_MODEL: 'sonnet' })
})

test('policy rejects arguments that escape instance config or workspace', () => {
  for (const args of [['--settings', '/tmp/settings.json'], ['--resume', '/tmp/other.jsonl'], ['--worktree', 'other'], ['--add-dir=/tmp/other'], ['--model', 'opus'], ['--model=opus']]) assert.throws(() => validateClaudeCodeCliArgs(args), /参数|模型/)
  assert.doesNotThrow(() => validateClaudeCodeCliArgs(['--print', 'hello']))
  assert.throws(() => claudeCodeConfigPaths('relative'), /绝对路径/)
})
