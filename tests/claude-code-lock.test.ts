import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acquireClaudeGlobalStateLock,
  releaseClaudeGlobalStateLock,
} from '../src/main/claudeCodeInstanceAdapter'

const stalePid = 0x7fffffff

test('Claude global state lock serializes active owners and only its owner can release it', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-lock-'))
  try {
    const path = join(root, 'global-state.lock')
    const first = acquireClaudeGlobalStateLock(join(root, 'instance-a'), 'owner-a', { path, pid: process.pid })
    assert.throws(
      () => acquireClaudeGlobalStateLock(join(root, 'instance-b'), 'owner-b', { path, pid: process.pid }),
      /已有实例占用共享全局状态/,
    )

    releaseClaudeGlobalStateLock({ ...first, nonce: 'other-owner' })
    assert.equal(existsSync(path), true)
    releaseClaudeGlobalStateLock(first)
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude global state lock reclaims only a complete lock whose owner is gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-lock-stale-'))
  try {
    const path = join(root, 'global-state.lock')
    const instanceHome = resolve(join(root, 'old-instance'))
    writeFileSync(path, JSON.stringify({ path, instanceHome, nonce: 'old-owner', pid: stalePid }) + '\n')
    const current = acquireClaudeGlobalStateLock(join(root, 'new-instance'), 'new-owner', { path, pid: process.pid })
    assert.equal(current.nonce, 'new-owner')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).instanceHome, resolve(join(root, 'new-instance')))
    releaseClaudeGlobalStateLock(current)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude global state lock fails closed for malformed, incomplete, and unknown lock data', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-lock-invalid-'))
  try {
    const path = join(root, 'global-state.lock')
    const instanceHome = resolve(join(root, 'old-instance'))
    const values = [
      '{not-json',
      JSON.stringify({ pid: stalePid }),
      JSON.stringify({ path, instanceHome, nonce: 'old-owner', pid: stalePid, version: 2 }),
      JSON.stringify({ path, instanceHome, nonce: 'invalid nonce', pid: stalePid }),
      JSON.stringify({ path, instanceHome: `${root}/old/../instance`, nonce: 'old-owner', pid: stalePid }),
    ]
    for (const value of values) {
      writeFileSync(path, value)
      assert.throws(
        () => acquireClaudeGlobalStateLock(join(root, 'new-instance'), 'new-owner', { path, pid: process.pid }),
        /锁(?:损坏|格式未知)/,
      )
      assert.equal(readFileSync(path, 'utf8'), value)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude global state lock rejects unsafe lock parameters before touching the lock file', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-lock-args-'))
  try {
    const path = join(root, 'global-state.lock')
    assert.throws(() => acquireClaudeGlobalStateLock('relative-instance', 'owner', { path }), /参数无效/)
    assert.throws(() => acquireClaudeGlobalStateLock(join(root, 'instance'), 'owner with spaces', { path }), /参数无效/)
    assert.throws(() => acquireClaudeGlobalStateLock(join(root, 'instance'), 'owner', { path, pid: 0 }), /PID 无效/)
    assert.throws(() => acquireClaudeGlobalStateLock(join(root, 'instance'), 'owner', { path: `${root}/../global.lock` }), /路径无效/)
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude global state lock release preserves a tampered or malformed lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'aml-claude-lock-release-'))
  try {
    const path = join(root, 'global-state.lock')
    const lock = acquireClaudeGlobalStateLock(join(root, 'instance'), 'owner', { path, pid: process.pid })
    writeFileSync(path, '{"owner":"unknown"}')
    releaseClaudeGlobalStateLock(lock)
    assert.equal(readFileSync(path, 'utf8'), '{"owner":"unknown"}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
