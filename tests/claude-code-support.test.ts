import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeClientType, claudeCodeClient } from '../src/shared/claudeCode'
import { claudeCodeEnvironment, claudeCodeConfigPaths, detectClaudeCodeApplications, projectClaudeCodeConfig, validateClaudeCodeCliArgs } from '../src/main/claudeCodeInstanceAdapter'

test('Claude family exposes CLI and Desktop with independently scoped connections', () => {
  assert.equal(claudeCodeClientType, 'claude_code')
  assert.equal(claudeCodeClient.status, 'implemented')
  assert.equal(claudeCodeClient.protocol, 'anthropic_messages')
  assert.deepEqual(claudeCodeClient.capabilities.launchModes, ['cli', 'desktop'])
  assert.equal(claudeCodeClient.capabilities.localApi, false)
  assert.equal(claudeCodeClient.capabilities.login, false)
  assert.equal(claudeCodeClient.capabilities.contextWindow, false)
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
    assert.throws(() => projectClaudeCodeConfig({ instanceHome: root, baseUrl: 'ftp://gateway.invalid', apiKey: 'test-key' }), /干净的 HTTP\(S\)/)
    assert.throws(() => projectClaudeCodeConfig({ instanceHome: root, baseUrl: 'https://gateway.invalid/?token=secret', apiKey: 'test-key' }), /干净的 HTTP\(S\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('environment removes inherited provider credentials before applying the projection', () => {
  const projection = { environment: { CLAUDE_CONFIG_DIR: '/instance/claude', ANTHROPIC_MODEL: 'sonnet' } }
  const env = claudeCodeEnvironment({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/user/.claude', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://old', CLAUDE_CODE_USE_BEDROCK: '1' }, projection)
  assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/instance/claude', ANTHROPIC_MODEL: 'sonnet' })
})

test('policy rejects arguments that escape instance config or workspace', () => {
  for (const args of [['--settings', '/tmp/settings.json'], ['--plugin-dir', '/tmp/plugin'], ['--mcp-config', '/tmp/mcp.json'], ['--strict-mcp-config'], ['--setting-sources', 'project'], ['--resume', '/tmp/other.jsonl'], ['--continue'], ['--desktop'], ['--cloud', 'other'], ['--from-pr', '123'], ['--worktree', 'other'], ['--add-dir=/tmp/other'], ['--model', 'opus'], ['--model=opus']]) assert.throws(() => validateClaudeCodeCliArgs(args), /参数|模型/)
  assert.doesNotThrow(() => validateClaudeCodeCliArgs(['--print', 'hello']))
  assert.throws(() => claudeCodeConfigPaths('relative'), /绝对路径/)
})

test('managed CLI accepts only verified foreground options and treats their values as data', () => {
  for(const args of [[],['--print','hello'],['--append-system-prompt','auth'],['--system-prompt=desktop','--output-format','json','--print','explain the code'],['--','--background is a literal prompt']])assert.doesNotThrow(()=>validateClaudeCodeCliArgs(args))
  for(const args of [['--bg'],['--background'],['--environment','remote'],['--teleport'],['--remote-control'],['--future-mode'],['-pd'],['--print=true'],['--output-format'],['--system-prompt','--settings'],['--system-prompt='],['--print','hello','world'],['auth'],['--print','gateway'],['--','attach'],['purge'],['agents'],['respawn']])assert.throws(()=>validateClaudeCodeCliArgs(args),/参数|子命令/)
  assert.throws(()=>validateClaudeCodeCliArgs(['future-service'],['future-service']),/子命令/)
  assert.doesNotThrow(()=>validateClaudeCodeCliArgs(['--system-prompt','future-service'],['future-service']))
})
