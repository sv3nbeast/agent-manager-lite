import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIdentity, claudeSessionResumeArgs, scanClaudeCodeSessions } from '../src/main/claudeCodeSessions'

test('Claude Code session scan is isolated from the Codex session layout and extracts stable metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-sessions-'))
  try {
    const project = join(root, 'claude', 'projects', '-Users-demo-project')
    mkdirSync(project, { recursive: true })
    const path = join(project, '11111111-1111-4111-8111-111111111111.jsonl')
    writeFileSync(path, [
      JSON.stringify({ type: 'user', sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/workspace/demo/project', timestamp: '2026-10-12T01:02:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '检查隔离边界' }] } }),
      JSON.stringify({ type: 'assistant', sessionId: '11111111-1111-4111-8111-111111111111', timestamp: '2026-10-12T01:03:03.000Z' }),
    ].join('\n'))
    const result = scanClaudeCodeSessions(join(root, 'claude'), { now: () => 123 })
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].title, '检查隔离边界')
    assert.equal(result.records[0].cwd, '/workspace/demo/project')
    assert.equal(result.records[0].conflict, false)
    assert.deepEqual(claudeSessionResumeArgs(result.records[0], path), ['--resume', '11111111-1111-4111-8111-111111111111'])
    assert.equal(claudeSessionIdentity(path).sha256.length, 64)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Claude Code duplicate session IDs are classified as conflicts and cannot be resumed implicitly', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-sessions-'))
  try {
    const first = join(root, 'claude', 'projects', 'one'), second = join(root, 'claude', 'projects', 'two')
    mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true })
    const id = '22222222-2222-4222-8222-222222222222'
    const a = join(first, `${id}.jsonl`), b = join(second, `${id}.jsonl`)
    writeFileSync(a, JSON.stringify({ type: 'user', sessionId: id, cwd: '/one', message: { content: 'one' } }))
    writeFileSync(b, JSON.stringify({ type: 'user', sessionId: id, cwd: '/two', message: { content: 'two' } }))
    const record = scanClaudeCodeSessions(join(root, 'claude')).records[0]
    assert.equal(record.conflict, true)
    assert.equal(record.locations.length, 2)
    assert.throws(() => claudeSessionResumeArgs(record), /冲突/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Claude Code session scan rejects symlinked transcript files', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-sessions-'))
  try {
    const project = join(root, 'claude', 'projects', 'one'), outside = join(root, 'outside.jsonl')
    mkdirSync(project, { recursive: true }); writeFileSync(outside, JSON.stringify({ type: 'user', sessionId: '33333333-3333-4333-8333-333333333333' }))
    symlinkSync(outside, join(project, '33333333-3333-4333-8333-333333333333.jsonl'))
    const result = scanClaudeCodeSessions(join(root, 'claude'))
    assert.equal(result.records.length, 0)
    assert.equal(result.warnings.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Claude Code session scan rejects a symlinked projects root', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-sessions-'))
  try {
    const config = join(root, 'claude'), outside = join(root, 'outside-projects')
    mkdirSync(outside, { recursive: true }); mkdirSync(config, { recursive: true })
    symlinkSync(outside, join(config, 'projects'))
    assert.throws(() => scanClaudeCodeSessions(config), /projects 目录不是稳定的普通目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
