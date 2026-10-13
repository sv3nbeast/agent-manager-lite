import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIdentity, claudeSessionResumeArgs, previewClaudeSessionResume, readClaudeCodeInstanceHistory, scanClaudeCodeSessions } from '../src/main/claudeCodeSessions'

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

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-session-boundary-')))
  const config = join(root, 'instance-a'), project = join(config, 'projects', '-fixture-project'), cwd = join(root, 'workspace')
  const id = '44444444-4444-4444-8444-444444444444', instanceId = 'instance-a'
  mkdirSync(project, { recursive: true }); mkdirSync(cwd)
  const path = join(project, id + '.jsonl')
  const event = { type: 'user', sessionId: id, cwd, timestamp: '2026-10-12T01:02:03.000Z', message: { role: 'user', content: '检查项目边界' } }
  writeFileSync(path, JSON.stringify(event) + '\n')
  const scan = () => scanClaudeCodeSessions(config, { instanceId })
  return { root, config, project, cwd, id, instanceId, path, event, scan, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('native Claude metadata ignores message UUIDs and tool bodies, and honors the latest custom title', () => {
  const f = fixture()
  try {
    writeFileSync(f.path, [
      { type: 'file-history-snapshot', uuid: 'message-uuid-not-session', snapshot: { files: {} } },
      { ...f.event, isMeta: true, message: { content: 'INTERNAL_BODY_DO_NOT_RETURN' } },
      { ...f.event, message: { content: [{ type: 'tool_result', content: 'TOOL_BODY_DO_NOT_RETURN' }] } },
      { ...f.event, uuid: 'another-message-uuid', gitBranch: 'feature/claude' },
      { type: 'assistant', sessionId: f.id, timestamp: '2026-10-12T02:00:00.000Z', message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ASSISTANT_BODY_DO_NOT_RETURN' }] } },
      { type: 'summary', summary: '自动摘要', leafUuid: 'another-message-uuid' },
      { type: 'custom-title', sessionId: f.id, customTitle: '旧标题' },
      { type: 'custom-title', sessionId: f.id, customTitle: '确认后的标题' },
    ].map(value => JSON.stringify(value)).join('\n'))
    const scan = f.scan(), row = scan.records[0]
    assert.equal(scan.complete, true)
    assert.equal(row.id, f.id)
    assert.equal(row.title, '确认后的标题')
    assert.equal(row.model, 'claude-sonnet-4-5')
    assert.equal(row.gitBranch, 'feature/claude')
    assert.equal(row.updatedAt, Date.parse('2026-10-12T02:00:00.000Z'))
    assert.equal(JSON.stringify(scan).includes('BODY_DO_NOT_RETURN'), false)
    assert.deepEqual(claudeSessionResumeArgs(row), ['--resume', f.id])
  } finally { f.dispose() }
})

test('resume preview binds identical IDs to instance, config, project and exact source snapshot', () => {
  const f = fixture()
  try {
    const otherConfig = join(f.root, 'instance-b'), otherProject = join(otherConfig, 'projects', '-fixture-project')
    mkdirSync(otherProject, { recursive: true }); copyFileSync(f.path, join(otherProject, f.id + '.jsonl'))
    const a = f.scan(), b = scanClaudeCodeSessions(otherConfig, { instanceId: 'instance-b' })
    const input = { instanceId: f.instanceId, configDirectory: f.config, cwd: f.cwd, sessionId: f.id, sourceId: a.records[0].locations[0].sourceId }
    assert.equal(a.records[0].conflict, false)
    assert.equal(b.records[0].conflict, false)
    assert.notEqual(input.sourceId, b.records[0].locations[0].sourceId)
    assert.deepEqual(previewClaudeSessionResume(a, input).args, ['--resume', f.id])
    assert.throws(() => previewClaudeSessionResume(a, { ...input, instanceId: 'instance-b' }), /实例配置目录/)
    assert.throws(() => previewClaudeSessionResume(a, { ...input, configDirectory: otherConfig }), /实例配置目录/)
    assert.throws(() => previewClaudeSessionResume(a, { ...input, sourceId: b.records[0].locations[0].sourceId }), /来源不属于/)
    assert.throws(() => previewClaudeSessionResume(a, { ...input, cwd: f.root }), /项目工作目录/)
    appendFileSync(f.path, JSON.stringify({ type: 'custom-title', sessionId: f.id, customTitle: '新状态' }) + '\n')
    assert.throws(() => previewClaudeSessionResume(a, input), /来源已变化/)
  } finally { f.dispose() }
})

test('new identical copies after scanning still block ID resume even with an explicitly selected path', () => {
  const f = fixture()
  try {
    const before = f.scan(), other = join(f.config, 'projects', 'another-project')
    mkdirSync(other); copyFileSync(f.path, join(other, f.id + '.jsonl'))
    assert.throws(() => claudeSessionResumeArgs(before.records[0], f.path), /冲突/)
    const after = f.scan()
    assert.equal(after.records[0].conflict, true)
    assert.equal(after.records[0].locations.length, 2)
    assert.notEqual(after.records[0].locations[0].sourceId, after.records[0].locations[1].sourceId)
  } finally { f.dispose() }
})

test('subagent transcripts sharing the parent ID do not create false conversation conflicts', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.project, 'agent-child.jsonl'), JSON.stringify({ ...f.event, isSidechain: true }))
    writeFileSync(join(f.project, '55555555-5555-4555-8555-555555555555.jsonl'), JSON.stringify({ ...f.event, isSidechain: true }))
    const nested = join(f.project, f.id, 'subagents')
    mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, 'agent-child.jsonl'), JSON.stringify({ ...f.event, isSidechain: true }))
    const scan = f.scan()
    assert.equal(scan.records.length, 1)
    assert.equal(scan.records[0].conflict, false)
    assert.deepEqual(claudeSessionResumeArgs(scan.records[0]), ['--resume', f.id])
  } finally { f.dispose() }
})

test('in-root symlinks, hardlinks and linked project directories are rejected without following their contents', () => {
  for (const kind of ['file-link', 'hardlink', 'project-link'] as const) {
    const f = fixture()
    try {
      if (kind === 'file-link') { renameSync(f.path, f.path + '.saved'); symlinkSync(f.path + '.saved', f.path) }
      if (kind === 'hardlink') linkSync(f.path, join(f.root, 'other-account-history.jsonl'))
      if (kind === 'project-link') { renameSync(f.project, f.project + '.saved'); symlinkSync(f.project + '.saved', f.project) }
      const scan = f.scan()
      assert.equal(scan.complete, false, kind)
      if (kind !== 'project-link') assert.equal(scan.records.length, 0, kind)
      assert.throws(() => claudeSessionIdentity(f.path), /普通文件|普通目录/)
    } finally { f.dispose() }
  }
})

test('resume rejects replacement of the config, projects directory, project directory or transcript', () => {
  for (const kind of ['config', 'projects', 'project', 'file'] as const) {
    const f = fixture()
    try {
      const before = f.scan(), bytes = readFileSync(f.path)
      const target = kind === 'config' ? f.config : kind === 'projects' ? join(f.config, 'projects') : kind === 'project' ? f.project : f.path
      renameSync(target, target + '.saved')
      mkdirSync(f.project, { recursive: true }); writeFileSync(f.path, bytes)
      assert.throws(() => claudeSessionResumeArgs(before.records[0]), /替换|变化/, kind)
    } finally { f.dispose() }
  }
})

test('truncated trailing JSON is visible as incomplete metadata but is never resumable', () => {
  const f = fixture()
  try {
    appendFileSync(f.path, '{"type":"user","sessionId":"SENSITIVE_PARTIAL_BODY')
    const scan = f.scan()
    assert.equal(scan.records.length, 1)
    assert.equal(scan.complete, false)
    assert.match(scan.records[0].locations[0].resumeBlockedReason!, /不完整/)
    assert.equal(JSON.stringify(scan).includes('SENSITIVE_PARTIAL_BODY'), false)
    assert.throws(() => claudeSessionResumeArgs(scan.records[0]), /完整读取/)
    writeFileSync(f.path, JSON.stringify(f.event) + '\n{invalid-secret-body}\n')
    const corrupt = f.scan()
    assert.equal(corrupt.records.length, 0)
    assert.equal(corrupt.complete, false)
    assert.equal(JSON.stringify(corrupt).includes('invalid-secret-body'), false)
  } finally { f.dispose() }
})

test('mixed session IDs cannot be indexed as a single account conversation', () => {
  const f = fixture()
  try {
    appendFileSync(f.path, JSON.stringify({ ...f.event, sessionId: '66666666-6666-4666-8666-666666666666' }) + '\n')
    const scan = f.scan()
    assert.equal(scan.records.length, 0)
    assert.equal(scan.complete, false)
  } finally { f.dispose() }
})

test('truncation during descriptor reads discards metadata and closes the source', t => {
  const f = fixture()
  try {
    writeFileSync(f.path, JSON.stringify({ ...f.event, message: { content: 'x'.repeat(100_000) } }) + '\n')
    const original = fs.readSync
    let mutated = false, descriptor: number | undefined
    const read = t.mock.method(fs, 'readSync', function (...args: Parameters<typeof fs.readSync>) {
      const bytes = Reflect.apply(original, fs, args)
      if (!mutated) { mutated = true; descriptor = args[0]; truncateSync(f.path, 0) }
      return bytes
    })
    const scan = f.scan()
    read.mock.restore()
    assert.equal(scan.records.length, 0)
    assert.equal(scan.complete, false)
    assert.equal(mutated, true)
    assert.throws(() => fs.fstatSync(descriptor!), { code: 'EBADF' })
  } finally { f.dispose() }
})

test('oversized transcripts are rejected from stat before reading any conversation data', t => {
  const f = fixture()
  try {
    truncateSync(f.path, 64 * 1024 * 1024 + 1)
    const read = t.mock.method(fs, 'readSync')
    const scan = f.scan()
    assert.equal(scan.records.length, 0)
    assert.equal(scan.complete, false)
    assert.equal(read.mock.callCount(), 0)
    read.mock.restore()
  } finally { f.dispose() }
})

test('Claude instance history reports its own projects and does not count Codex or subagent layouts', () => {
  const f = fixture()
  try {
    const codex = join(f.config, 'sessions')
    mkdirSync(codex); writeFileSync(join(codex, 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'foreign' } }))
    const history = readClaudeCodeInstanceHistory(f.config, { instanceId: f.instanceId })
    assert.equal(history.sessions, 1)
    assert.equal(history.archived, 0)
    assert.equal(history.unassigned, 0)
    assert.deepEqual(history.projects, [{ path: f.cwd, name: 'workspace', exists: true, sessions: 1 }])
    assert.deepEqual(history.issues, [])
  } finally { f.dispose() }
})
