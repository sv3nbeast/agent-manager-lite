import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIdentity, claudeSessionResumeArgs, previewClaudeSessionResume, readClaudeCodeInstanceHistory, readClaudeSessionContent, scanClaudeCodeSessions } from '../src/main/claudeCodeSessions'

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

test('Claude Code preserves every cwd in a session segment and requires choosing a snapshot-bound directory identity', () => {
  const f=fixture()
  try {
    const otherCwd=join(f.root,'second-worktree');mkdirSync(otherCwd)
    writeFileSync(f.path,[
      JSON.stringify({...f.event,message:{role:'user',content:'First project'}}),
      JSON.stringify({type:'assistant',sessionId:f.id,cwd:otherCwd,message:{content:'Second project'}}),
    ].join('\n')+'\n')
    const scan=f.scan(),record=scan.records[0],location=record.locations[0]
    assert.deepEqual(location.cwdCandidates,[f.cwd,otherCwd])
    assert.equal(location.resumeBlockedReason,undefined)
    assert.equal(location.cwdCandidateIdentities?.length,2)
    assert.equal(previewClaudeSessionResume(scan,{instanceId:f.instanceId,configDirectory:f.config,cwd:otherCwd,sessionId:f.id,sourceId:location.sourceId}).cwd,otherCwd)
    assert.throws(()=>previewClaudeSessionResume(scan,{instanceId:f.instanceId,configDirectory:f.config,cwd:f.root,sessionId:f.id,sourceId:location.sourceId}),/当前项目工作目录/)
    renameSync(otherCwd,otherCwd+'-old');mkdirSync(otherCwd)
    assert.throws(()=>previewClaudeSessionResume(scan,{instanceId:f.instanceId,configDirectory:f.config,cwd:otherCwd,sessionId:f.id,sourceId:location.sourceId}),/目录身份已变化|项目目录已变化/)
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

test('mixed-ID fork exposes only the latest filename ID for resume and keeps each segment cwd and content separate', () => {
  const f = fixture()
  try {
    const oldId = '66666666-6666-4666-8666-666666666666'
    const oldCwd = join(f.root, 'older-worktree'), currentCwd = join(f.root, 'current-worktree')
    mkdirSync(oldCwd); mkdirSync(currentCwd)
    // Claude keeps fork ancestry in the same transcript. The current file ID
    // names the resumable branch; the older branch remains display-only.
    writeFileSync(f.path, [
      JSON.stringify({ ...f.event, sessionId: oldId, uuid: 'older-message', cwd: oldCwd, message: { content: 'OLDER_CONVERSATION_DETAIL' } }),
      JSON.stringify({ ...f.event, sessionId: oldId, uuid: 'older-leaf', parentUuid: 'older-message', cwd: oldCwd, message: { content: 'OLDER_FOLLOWUP_DETAIL' } }),
      JSON.stringify({ ...f.event, sessionId: f.id, uuid: 'current-message', parentUuid: 'older-leaf', cwd: currentCwd, message: { content: 'CURRENT_CONVERSATION_DETAIL' } }),
    ].join('\n') + '\n')
    const scan = f.scan()
    assert.equal(scan.records.length, 2)
    assert.equal(scan.complete, true)
    const old = scan.records.find(record => record.id === oldId)!, current = scan.records.find(record => record.id === f.id)!
    assert.ok(old); assert.ok(current)
    assert.match(old.locations[0].resumeBlockedReason!, /较早 Claude 会话/)
    assert.equal(current.locations[0].resumeBlockedReason, undefined)
    assert.equal(current.locations[0].resumeIncludesAncestors, true)
    assert.deepEqual(old.locations[0].cwdCandidates, [oldCwd])
    assert.deepEqual(current.locations[0].cwdCandidates, [currentCwd])
    assert.ok(scan.warnings.some(warning => warning.includes('文件名对应且顺序明确的当前会话可以继续')))
    const oldPage = readClaudeSessionContent(old.locations[0]), currentPage = readClaudeSessionContent(current.locations[0])
    assert.equal(oldPage.total, 2); assert.equal(currentPage.total, 1)
    assert.ok(JSON.stringify(oldPage).includes('OLDER_CONVERSATION_DETAIL'))
    assert.ok(!JSON.stringify(oldPage).includes('CURRENT_CONVERSATION_DETAIL'))
    assert.ok(JSON.stringify(currentPage).includes('CURRENT_CONVERSATION_DETAIL'))
    assert.ok(!JSON.stringify(currentPage).includes('OLDER_CONVERSATION_DETAIL'))
    assert.deepEqual(claudeSessionResumeArgs(current), ['--resume', f.id])
    assert.throws(() => claudeSessionResumeArgs(old), /较早 Claude 会话/)
  } finally { f.dispose() }
})

test('interleaved IDs, a mismatched final filename ID and ambiguous tails remain blocked', () => {
  for (const rows of [
    (f: ReturnType<typeof fixture>, oldId: string) => [
      { ...f.event, sessionId: f.id, uuid: 'a1' },
      { ...f.event, sessionId: oldId, uuid: 'b1' },
      { ...f.event, sessionId: f.id, uuid: 'a2' },
    ],
    (f: ReturnType<typeof fixture>, oldId: string) => [
      { ...f.event, sessionId: f.id, uuid: 'a1' },
      { ...f.event, sessionId: oldId, uuid: 'b1' },
    ],
  ]) {
    const f = fixture()
    try {
      const oldId = '77777777-7777-4777-8777-777777777777'
      writeFileSync(f.path, rows(f, oldId).map(value => JSON.stringify(value)).join('\n') + '\n')
      const scan = f.scan(), current = scan.records.find(record => record.id === f.id)!
      assert.ok(current)
      assert.ok(current.locations[0].resumeBlockedReason)
      assert.throws(() => claudeSessionResumeArgs(current), /无法确认当前分叉|较早 Claude 会话/)
      const finalId = scan.records.find(record => record.id === oldId)!
      assert.ok(finalId.locations[0].resumeBlockedReason)
      assert.throws(() => claudeSessionResumeArgs(finalId), /无法确认当前分叉|较早 Claude 会话/)
    } finally { f.dispose() }
  }
})

test('latest mixed-ID sessions without a verified parent chain can resume without an ancestor claim', () => {
  for (const parentUuid of [undefined, 'unknown-parent-uuid', 'current-with-cycle']) {
    const f = fixture()
    try {
      const oldId = '88888888-8888-4888-8888-888888888888'
      writeFileSync(f.path, [
        JSON.stringify({ ...f.event, sessionId: oldId, uuid: 'unlinked-parent', message: { content: 'OLDER' } }),
        JSON.stringify({ ...f.event, sessionId: f.id, uuid: 'current-with-cycle', ...(parentUuid ? { parentUuid } : {}), message: { content: 'CURRENT' } }),
      ].join('\n') + '\n')
      const scan = f.scan(), latest = scan.records.find(record => record.id === f.id)!
      assert.equal(latest.locations[0].resumeBlockedReason, undefined)
      assert.notEqual(latest.locations[0].resumeIncludesAncestors, true)
      assert.deepEqual(claudeSessionResumeArgs(latest), ['--resume', f.id])
    } finally { f.dispose() }
  }
})

test('conflicting transcript ID fields and filename-only identities fail closed for resume', () => {
  const f = fixture()
  try {
    writeFileSync(f.path, JSON.stringify({ ...f.event, session_id: '99999999-9999-4999-8999-999999999999' }) + '\n')
    const conflict = f.scan()
    assert.equal(conflict.records.length, 0)
    assert.equal(conflict.complete, false)

    const { sessionId: _sessionId, ...withoutSessionId } = f.event
    writeFileSync(f.path, JSON.stringify(withoutSessionId) + '\n')
    const filenameOnly = f.scan(), row = filenameOnly.records.find(record => record.id === f.id)!
    assert.ok(row)
    assert.match(row.locations[0].resumeBlockedReason!, /没有 transcript 会话 ID/)
    assert.throws(() => claudeSessionResumeArgs(row), /没有 transcript 会话 ID/)
  } finally { f.dispose() }
})


test('too many distinct session IDs stop parsing at the first ID over the bound', t => {
  const f = fixture()
  try {
    const rows = Array.from({ length: 33 }, (_, index) => JSON.stringify({ ...f.event, sessionId: 'bounded-id-' + index, message: { content: 'bounded fixture' } }))
    writeFileSync(f.path, rows.join(String.fromCharCode(10)) + String.fromCharCode(10))
    const scan = f.scan()
    assert.equal(scan.records.length, 0)
    assert.equal(scan.complete, false)
    assert.ok(scan.warnings.some(warning => warning.includes('文件包含过多不同会话 ID 1 个')))
  } finally { f.dispose() }
})

test('large native tool-result lines within the bounded reader limit remain discoverable', () => {
  const f = fixture()
  try {
    const output = 'L'.repeat(8 * 1024 * 1024 + 1)
    writeFileSync(f.path, JSON.stringify({ ...f.event, message: { content: [{ type: 'tool_result', content: output }] } }) + '\n')
    const scan = f.scan()
    assert.equal(scan.complete, true)
    assert.equal(scan.records.length, 1)
    assert.equal(scan.records[0].messageCount, 1)
  } finally { f.dispose() }
})

test('native tool-result lines above the bounded reader limit produce a specific safe warning', () => {
  const f = fixture()
  try {
    const output = 'L'.repeat(16 * 1024 * 1024)
    writeFileSync(f.path, JSON.stringify({ ...f.event, message: { content: [{ type: 'tool_result', content: output }] } }) + '\n')
    const scan = f.scan()
    assert.equal(scan.complete, false)
    assert.equal(scan.records.length, 0)
    assert.ok(scan.warnings.some(warning => warning.includes('单行超过安全读取上限 1 个')))
    assert.ok(!JSON.stringify(scan).includes('L'.repeat(100)))
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

test('Claude titles skip injected commands and prefer the first real prompt over later compact summaries', () => {
  const f = fixture()
  try {
    writeFileSync(f.path, [
      { ...f.event, message: { content: '<local-command-caveat>local only</local-command-caveat>' } },
      { ...f.event, message: { content: '<command-name>/clear</command-name>' } },
      f.event,
      { type: 'summary', summary: 'Later compacted description' },
    ].map(value => JSON.stringify(value)).join('\n'))
    assert.equal(f.scan().records[0].title, f.event.message.content)
  } finally { f.dispose() }
})

test('Claude reader paginates native message blocks and searches bodies without exposing binary or metadata fields', () => {
  const f = fixture()
  try {
    writeFileSync(f.path, [
      f.event,
      { type: 'assistant', sessionId: f.id, timestamp: '2026-10-12T01:03:03.000Z', message: { model: 'claude-test', content: [
        { type: 'thinking', thinking: 'Plan the implementation', signature: 'THINKING_SIGNATURE_NOT_TEXT' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/example.ts' } },
      ] } },
      { ...f.event, message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Needle inside tool result' }, { type: 'image', source: { type: 'base64', data: 'BINARY_ATTACHMENT_NOT_TEXT' } }] }] } },
      { type: 'assistant', sessionId: f.id, message: { content: [{ type: 'text', text: '<script>plain text only</script>' }, { type: 'redacted_thinking', data: 'REDACTED_NOT_TEXT' }, { type: 'image', source: { type: 'url', url: 'https://unused.invalid/image' } }] } },
      { type: 'file-history-snapshot', snapshot: { secret: 'METADATA_NOT_TEXT' } },
    ].map(value => JSON.stringify(value)).join('\n'))
    const location = f.scan().records[0].locations[0]
    const first = readClaudeSessionContent(location, { pageSize: 2 }), second = readClaudeSessionContent(location, { page: 2, pageSize: 2 })
    assert.equal(first.total, 4)
    assert.deepEqual(first.messages.map(message => message.role), ['user', 'assistant'])
    assert.equal(first.messages[1].model, 'claude-test')
    assert.deepEqual(first.messages[1].blocks.map(block => block.type), ['thinking', 'tool_use'])
    assert.deepEqual(second.messages.map(message => message.index), [2, 3])
    assert.ok(second.messages[1].blocks.some(block => block.text === '<script>plain text only</script>'))
    for (const secret of ['THINKING_SIGNATURE_NOT_TEXT', 'BINARY_ATTACHMENT_NOT_TEXT', 'REDACTED_NOT_TEXT', 'METADATA_NOT_TEXT', 'https://unused.invalid']) assert.ok(!JSON.stringify([first, second]).includes(secret))
    const matches = readClaudeSessionContent(location, { query: 'NEEDLE' })
    assert.equal(matches.total, 1); assert.equal(matches.messages[0].index, 2)
    assert.equal(scanClaudeCodeSessions(f.config, { contentQuery: 'needle' }).records[0].locations[0].contentMatched, true)
    assert.equal(scanClaudeCodeSessions(f.config, { contentQuery: 'METADATA_NOT_TEXT' }).records[0].locations[0].contentMatched, false)
    assert.equal(readClaudeSessionContent(location, { query: 'BINARY_ATTACHMENT_NOT_TEXT' }).total, 0)
  } finally { f.dispose() }
})

test('Claude content pages bound long tool outputs while searching beyond the visible preview', () => {
  const f = fixture()
  try {
    const body = '中'.repeat(20_000) + 'matching-tail'
    writeFileSync(f.path, Array.from({ length: 100 }, () => JSON.stringify({ ...f.event, message: { content: [{ type: 'tool_result', content: body }] } })).join('\n'))
    const location = f.scan().records[0].locations[0], page = readClaudeSessionContent(location, { pageSize: 100, query: 'matching-tail' })
    assert.equal(page.total, 100); assert.equal(page.messages.length, 100)
    assert.ok(page.messages.every(message => message.truncated))
    assert.ok(page.messages.flatMap(message => message.blocks).reduce((count, block) => count + block.text.length, 0) <= 240_000)
    assert.ok(page.warnings.some(warning => warning.includes('截断')))
    assert.throws(() => readClaudeSessionContent(location, { pageSize: 101 }))
    assert.throws(() => readClaudeSessionContent(location, { page: 0 }))
  } finally { f.dispose() }
})

test('Claude recent reader returns the last ten native records and accepts contiguous offsets',()=>{
  const f=fixture()
  try{
    writeFileSync(f.path,Array.from({length:41},(_,index)=>JSON.stringify({...f.event,type:index%2?'assistant':'user',timestamp:new Date(Date.UTC(2026,9,12,1,index)).toISOString(),message:{content:'record-'+(index+1)}})).join('\n'))
    const location=f.scan().records[0].locations[0],recent=readClaudeSessionContent(location,{page:1,pageSize:10,recent:true})
    assert.equal(recent.total,41);assert.equal(recent.startIndex,31);assert.deepEqual(recent.messages.map(message=>message.blocks[0].text),Array.from({length:10},(_,index)=>'record-'+(index+32)))
    const previous=readClaudeSessionContent(location,{page:1,pageSize:10,recent:true,offset:21})
    assert.equal(previous.startIndex,21);assert.deepEqual(previous.messages.map(message=>message.blocks[0].text),Array.from({length:10},(_,index)=>'record-'+(index+22)))
    const next=readClaudeSessionContent(location,{page:1,pageSize:10,recent:true,offset:31})
    assert.equal(next.startIndex,31);assert.deepEqual(next.messages.map(message=>message.blocks[0].text),recent.messages.map(message=>message.blocks[0].text))
  }finally{f.dispose()}
})

test('Claude reader rejects changed snapshots, linked sources and concurrent writes without returning partial text', t => {
  for (const kind of ['append', 'symlink', 'concurrent'] as const) {
    const f = fixture()
    try {
      const location = f.scan().records[0].locations[0]
      if (kind === 'append') appendFileSync(f.path, JSON.stringify(f.event) + '\n')
      if (kind === 'symlink') { renameSync(f.path, f.path + '.saved'); symlinkSync(f.path + '.saved', f.path) }
      let restore = () => {}
      if (kind === 'concurrent') {
        const original = fs.readSync
        let mutated = false
        const read = t.mock.method(fs, 'readSync', function (...args: Parameters<typeof fs.readSync>) {
          const bytes = Reflect.apply(original, fs, args)
          if (!mutated) { mutated = true; appendFileSync(f.path, JSON.stringify(f.event) + '\n') }
          return bytes
        })
        restore = () => read.mock.restore()
      }
      try { assert.throws(() => readClaudeSessionContent(location), /变化|普通文件/) } finally { restore() }
    } finally { f.dispose() }
  }
})

test('Claude local catalog excludes native SSH caches, journals and superseded transcripts', () => {
  const f = fixture()
  try {
    const remote = join(f.config, 'projects', 'ssh-sessions')
    mkdirSync(remote)
    copyFileSync(f.path, join(remote, f.id + '.jsonl'))
    copyFileSync(f.path, join(f.project, 'journal.jsonl'))
    copyFileSync(f.path, join(f.project, f.id + '.superseded-old.jsonl'))
    const scan = f.scan()
    assert.equal(scan.records.length, 1); assert.equal(scan.records[0].conflict, false)
    assert.deepEqual(scan.warnings, [])
  } finally { f.dispose() }
})

test('Claude reader retains complete messages when the current snapshot ends with a partial record', () => {
  const f = fixture()
  try {
    appendFileSync(f.path, '{"type":"user","message":{"content":"PARTIAL_NOT_RETURNED')
    const location = f.scan().records[0].locations[0], page = readClaudeSessionContent(location)
    assert.equal(page.total, 1)
    assert.ok(page.warnings.some(warning => warning.includes('末尾')))
    assert.ok(!JSON.stringify(page).includes('PARTIAL_NOT_RETURNED'))
  } finally { f.dispose() }
})

test('Claude tool previews redact nested binary schemas while retaining ordinary data, source and text fields', () => {
  const f = fixture()
  try {
    const binary = Buffer.from('BINARY_FIXTURE_NOT_TEXT').toString('base64')
    writeFileSync(f.path, JSON.stringify({ ...f.event, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Inspect', input: {
      data: 'plain data searchable', source: 'plain source searchable', text: 'plain text searchable',
      image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: binary } },
      nested: [{ source: { type: 'base64', media_type: 'image/png', data: binary } }, { type: 'image', mimeType: 'image/png', data: binary }],
      document: { type: 'document', source: { type: 'url', url: 'https://attachment.invalid/private-doc' } },
      remote: { type: 'image_url', image_url: { url: 'data:image/png;base64,' + binary } },
    } }] } }) + '\n')
    const location = f.scan().records[0].locations[0], page = readClaudeSessionContent(location)
    assert.ok(!JSON.stringify(page).includes(binary)); assert.ok(!JSON.stringify(page).includes('attachment.invalid'))
    for (const query of ['plain data searchable', 'plain source searchable', 'plain text searchable']) assert.equal(readClaudeSessionContent(location, { query }).total, 1)
    assert.equal(readClaudeSessionContent(location, { query: binary }).total, 0)
    const search = scanClaudeCodeSessions(f.config, { contentQuery: binary })
    assert.equal(search.records[0].locations[0].contentMatched, false)
    assert.equal(search.complete, true)
  } finally { f.dispose() }
})

test('deep tool inputs are bounded before serialization and are not projected for other reader pages', t => {
  const f = fixture()
  try {
    const deep = '{"nested":'.repeat(2200) + '"HIDDEN_DEEP_TAIL"' + '}'.repeat(2200)
    const tool = JSON.stringify({ ...f.event, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Deep', input: '__DEEP_INPUT__' }] } }).replace('"__DEEP_INPUT__"', deep)
    writeFileSync(f.path, JSON.stringify(f.event) + '\n' + tool + '\n')
    const location = f.scan().records[0].locations[0], original = JSON.stringify
    let projections = 0
    const stringify = t.mock.method(JSON, 'stringify', function (...args: Parameters<typeof JSON.stringify>) {
      let value = args[0], depth = 0
      while (value && typeof value === 'object' && Object.hasOwn(value, 'nested')) { depth++; value = value.nested }
      if (depth) { projections++; assert.ok(depth <= 16, 'Only the bounded projection can reach JSON.stringify') }
      return Reflect.apply(original, JSON, args)
    })
    try {
      assert.equal(readClaudeSessionContent(location, { pageSize: 1 }).total, 2)
      assert.equal(projections, 0, 'Messages outside the current page do not stringify tool inputs')
      const page = readClaudeSessionContent(location, { page: 2, pageSize: 1 })
      assert.equal(projections, 1); assert.equal(page.messages[0].truncated, true)
      assert.ok(page.warnings.some(warning => warning.includes('截断')))
      const search = readClaudeSessionContent(location, { query: 'HIDDEN_DEEP_TAIL' })
      assert.equal(search.total, 0); assert.ok(search.warnings.some(warning => warning.includes('搜索未包含')))
    } finally { stringify.mock.restore() }
    const search = scanClaudeCodeSessions(f.config, { contentQuery: 'HIDDEN_DEEP_TAIL' })
    assert.equal(search.complete, true); assert.ok(search.warnings.some(warning => warning.includes('搜索未包含')))
  } finally { f.dispose() }
})

test('wide and long tool input projections stay bounded and disclose search truncation', () => {
  const f = fixture()
  try {
    const input = { list: Array.from({ length: 10_000 }, (_, index) => ({ value: String(index) })), long: 'x'.repeat(100_000) + 'TAIL_NOT_SEARCHABLE' }
    writeFileSync(f.path, JSON.stringify({ ...f.event, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Large', input }] } }) + '\n')
    const location = f.scan().records[0].locations[0], page = readClaudeSessionContent(location, { pageSize: 1 })
    assert.equal(page.messages[0].truncated, true)
    assert.ok(page.messages[0].blocks[0].text.length <= 12_000)
    const search = readClaudeSessionContent(location, { query: 'TAIL_NOT_SEARCHABLE' })
    assert.equal(search.total, 0); assert.ok(search.warnings.some(warning => warning.includes('搜索未包含')))
  } finally { f.dispose() }
})

test('Claude transcript project paths preserve significant whitespace instead of choosing another real directory', () => {
  const f = fixture()
  try {
    const significant = f.cwd + ' '; mkdirSync(significant)
    for (const field of ['cwd', 'projectPath', 'project_path']) {
      const event: Record<string, unknown> = { ...f.event }; delete event.cwd; event[field] = significant
      writeFileSync(f.path, JSON.stringify(event) + '\n')
      const scan = f.scan(), row = scan.records[0], location = row.locations[0]
      assert.equal(row.cwd, significant); assert.notEqual(row.cwd, f.cwd)
      const preview = previewClaudeSessionResume(scan, { instanceId: f.instanceId, configDirectory: f.config, cwd: significant, sessionId: f.id, sourceId: location.sourceId })
      assert.equal(preview.cwd, significant)
      assert.throws(() => previewClaudeSessionResume(scan, { ...preview, cwd: f.cwd }), /不属于当前项目/)
    }
  } finally { f.dispose() }
})

test('Claude resume preview accepts a stable absolute alias through a symlinked parent directory', () => {
  const f = fixture()
  try {
    const aliasParent = join(f.root, 'workspace-parent-alias')
    symlinkSync(f.root, aliasParent, 'dir')
    const aliasCwd = join(aliasParent, 'workspace')
    writeFileSync(f.path, JSON.stringify({ ...f.event, cwd: aliasCwd }) + '\n')
    const scan = f.scan(), row = scan.records[0], location = row.locations[0]
    assert.notEqual(realpathSync(aliasCwd), aliasCwd)
    const preview = previewClaudeSessionResume(scan, { instanceId: f.instanceId, configDirectory: f.config, cwd: aliasCwd, sessionId: row.id, sourceId: location.sourceId })
    assert.equal(preview.cwd, aliasCwd)
    assert.equal(preview.cwdCanonicalPath, f.cwd)
  } finally { f.dispose() }
})

test('Claude transcript project paths reject invalid controls or excessive length without cleaning them into another path', () => {
  const f = fixture()
  try {
    for (const cwd of [f.cwd + '\u0000', f.cwd + '\n', f.cwd + 'x'.repeat(4096), 7]) {
      writeFileSync(f.path, JSON.stringify({ ...f.event, cwd }) + '\n')
      const scan = f.scan()
      assert.equal(scan.records.length, 0); assert.equal(scan.complete, false)
    }
  } finally { f.dispose() }
})
