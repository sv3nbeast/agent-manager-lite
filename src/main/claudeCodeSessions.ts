import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { claudeCodeConfigPaths } from './claudeCodeInstanceAdapter'
import type { InstanceHistorySummary } from '../shared/instances'
import { sessionContentSchema, type SessionContentBlock, type SessionContentMessage } from '../shared/sessions'

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const maxFiles = 100_000
const maxBytesPerFile = 64 * 1024 * 1024
// Claude stores large tool outputs as one compact JSONL record. Keep the line
// bound below the transcript bound, but allow current native transcripts.
const maxLineBytes = 16 * 1024 * 1024
const chunkBytes = 64 * 1024
const maxContentPageCharacters = 240_000
const maxContentMessageCharacters = 12_000
const maxContentBlocks = 64
const maxToolInputDepth = 16
const maxToolInputNodes = 2000
const maxToolInputCharacters = 32_000
const maxWorkingDirectoryCandidates = 256

export interface ClaudeSessionDirectoryIdentity {
  path: string
  canonicalPath: string
  device: number
  inode: number
  mtimeMs: number
  ctimeMs: number
}

export interface ClaudeSessionWorkingDirectoryIdentity {
  path: string
  canonicalPath: string
  device: number
  inode: number
}

export interface ClaudeSessionSource {
  instanceId?: string
  config: ClaudeSessionDirectoryIdentity
  projects: ClaudeSessionDirectoryIdentity
}

export interface ClaudeSessionLocation {
  path: string
  projectDirectory: string
  device: number
  inode: number
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
  /** Bound to the instance, directories and complete transcript snapshot. */
  sourceId: string
  source: ClaudeSessionSource
  project: ClaudeSessionDirectoryIdentity
  cwd?: string
  /** All absolute project directories observed for this session segment. */
  cwdCandidates?: string[]
  /** Stable identity captured when the session snapshot was scanned. */
  cwdCandidateIdentities?: ClaudeSessionWorkingDirectoryIdentity[]
  title: string
  kind: 'conversation' | 'subagent'
  /** Only this session segment is exposed from a mixed-ID transcript. */
  contentSessionId?: string
  /** ID-less prefix records are attributed to the first session segment. */
  contentIncludesPrefix?: boolean
  resumeBlockedReason?: string
  /** Set only when a content search was requested; no transcript text is retained. */
  contentMatched?: boolean
}

export interface ClaudeSessionRecord {
  id: string
  title: string
  cwd?: string
  projectDirectory: string
  createdAt?: number
  updatedAt: number
  model?: string
  gitBranch?: string
  messageCount: number
  locations: ClaudeSessionLocation[]
  /** Even identical copies are ambiguous to Claude's ID-based lookup. */
  conflict: boolean
}

export interface ClaudeSessionScan {
  configDirectory: string
  sessionsDirectory: string
  instanceId?: string
  source?: ClaudeSessionSource
  scannedAt: number
  records: ClaudeSessionRecord[]
  warnings: string[]
  complete: boolean
}

export interface ClaudeSessionScanOptions {
  /** The default is the process home and is only useful for diagnostics. */
  home?: string
  instanceId?: string
  now?: () => number
  maxFiles?: number
  contentQuery?: string
}

export interface ClaudeSessionResumeSelection {
  instanceId?: string
  configDirectory: string
  cwd: string
  sessionId: string
  sourceId: string
}

export interface ClaudeSessionResumePreview extends ClaudeSessionResumeSelection {
  clientType: 'claude_code'
  applicationKind: 'cli'
  projectDirectory: string
  cwdCanonicalPath: string
  cwdDevice: number
  cwdInode: number
  args: string[]
  location: ClaudeSessionLocation
}

type JsonObject = Record<string, unknown>
interface TranscriptMetadata {
  id?: string
  title?: string
  cwd?: string
  cwdCandidates?: string[]
  createdAt?: number
  updatedAt?: number
  model?: string
  gitBranch?: string
  messageCount: number
  kind: 'conversation' | 'subagent'
  firstPrompt?: string
  customTitle?: string
  summary?: string
  incomplete?: boolean
  multipleSessionIds?: boolean
  sessionIds?: string[]
  resumeBlockedReason?: string
  contentMatched?: boolean
  contentSearchTruncated?: boolean
}
interface TranscriptSegment { id: string; metadata: TranscriptMetadata }

interface TranscriptReadOptions {
  contentQuery?: string
  sessionId?: string
  includeUnscopedFor?: string
  onRecord?: (record: JsonObject) => void
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function text(value: unknown, limit = 500): string | undefined {
  if (typeof value !== 'string') return
  return value.trim().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, limit) || undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return undefined
}

/** Display cleanup must never choose a different project for a launch. */
function workingDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value)) throw new Error('Claude Code 会话工作目录无效')
  return value
}

function addWorkingDirectory(metadata: TranscriptMetadata, cwd: string): void {
  const candidates = metadata.cwdCandidates ??= []
  if (candidates.some(candidate => candidate === cwd)) return
  if (candidates.length >= maxWorkingDirectoryCandidates) {
    metadata.resumeBlockedReason ??= 'Claude Code 会话工作目录候选过多，无法安全恢复'
    return
  }
  candidates.push(cwd)
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  if (!Array.isArray(value)) return
  // Tool results may contain credentials or entire files; only a human's text
  // blocks can supply a display title. No raw message or parse error is kept.
  return text(value.flatMap(item => {
    const record = object(item)
    return record?.type === 'text' ? [text(record.text) ?? ''] : []
  }).filter(Boolean).join('\n'))
}

/** Only native content fields are rendered/searched; metadata and binary
 * attachments never become readable text or trigger an external fetch. */
function binaryContent(value: JsonObject): boolean {
  const source = object(value.source), image = object(value.image_url), resource = object(value.resource)
  if ((value.type === 'image' || value.type === 'document') && source && (source.type === 'base64' && typeof source.data === 'string' || source.type === 'url' && typeof source.url === 'string')) return true
  if (value.type === 'base64' && typeof value.data === 'string') return true
  if ((value.type === 'image' || value.type === 'audio') && typeof value.data === 'string' && typeof (value.mimeType ?? value.media_type) === 'string') return true
  if (value.type === 'image_url' && typeof image?.url === 'string' || value.type === 'input_image' && typeof value.image_url === 'string') return true
  return value.type === 'resource' && typeof resource?.blob === 'string' && typeof resource.mimeType === 'string'
}

/** Project an untrusted tool payload iteratively before serializing. The tree
 * handed to JSON.stringify has bounded depth, node count and text, so deeply
 * nested input cannot amplify indentation or recursively exhaust the stack. */
function toolInputPreview(input: unknown): { text: string; truncated: boolean } {
  type Container = JsonObject | unknown[]
  const root: unknown[] = [], stack: { value: unknown; depth: number; parent: Container; key: string | number }[] = [{ value: input, depth: 0, parent: root, key: 0 }]
  let remaining = maxToolInputCharacters, nodes = 0, truncated = false
  const assign = (parent: Container, key: string | number, value: unknown): void => { Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true }) }
  const string = (value: string): string => {
    if (value.length <= remaining) { remaining -= value.length; return value }
    truncated = true
    const preview = value.slice(0, Math.max(0, remaining)); remaining = 0
    return preview + '…'
  }
  while (stack.length) {
    const { value, depth, parent, key } = stack.pop()!
    if (++nodes > maxToolInputNodes || remaining <= 0) { assign(parent, key, '[内容超出预览上限]'); truncated = true; continue }
    if (typeof value === 'string') { assign(parent, key, string(value)); continue }
    if (!value || typeof value !== 'object') { assign(parent, key, value ?? null); remaining -= 8; continue }
    const record = object(value)
    if (record && binaryContent(record)) { assign(parent, key, '[附件内容未展开]'); remaining -= 12; continue }
    if (depth >= maxToolInputDepth) { assign(parent, key, '[嵌套内容超出预览上限]'); truncated = true; continue }
    const target: Container = Array.isArray(value) ? [] : Object.create(null)
    assign(parent, key, target)
    let count = 0
    const budget = Math.max(0, maxToolInputNodes - nodes - stack.length)
    // Reserve all children in the shared node budget before visiting them.
    for (const child in value) {
      if (!Object.hasOwn(value, child)) continue
      if (count >= budget || remaining <= 0 || child.length > remaining) { truncated = true; break }
      remaining -= child.length + 4
      assign(target, Array.isArray(value) ? Number(child) : child, undefined)
      stack.push({ value: (value as JsonObject)[child], depth: depth + 1, parent: target, key: Array.isArray(value) ? Number(child) : child })
      count++
    }
  }
  const serialized = JSON.stringify(root[0]) ?? ''
  return { text: serialized.slice(0, maxToolInputCharacters), truncated: truncated || serialized.length > maxToolInputCharacters }
}

function hasReadableContent(record: JsonObject): boolean {
  if (record.type === 'summary') return typeof record.summary === 'string'
  if (record.type !== 'user' && record.type !== 'assistant') return false
  const content = object(record.message)?.content
  if (typeof content === 'string') return Boolean(content.trim())
  return Array.isArray(content) && content.some(raw => {
    const block = object(raw)
    if (!block) return false
    if (block.type === 'text') return typeof block.text === 'string'
    if (block.type === 'thinking') return typeof block.thinking === 'string'
    return ['redacted_thinking', 'tool_use', 'tool_result', 'image', 'document'].includes(String(block.type))
  })
}

function* contentBlocks(record: JsonObject): Generator<SessionContentBlock> {
  const message = object(record.message)
  if ((record.type === 'user' || record.type === 'assistant') && message) {
    const content = message.content
    if (typeof content === 'string') { if (content.trim()) yield { type: 'text', text: content }; return }
    if (!Array.isArray(content)) return
    for (const raw of content) {
      const block = object(raw)
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') yield { type: 'text', text: block.text }
      else if (block.type === 'thinking' && typeof block.thinking === 'string') yield { type: 'thinking', text: block.thinking }
      else if (block.type === 'redacted_thinking') yield { type: 'notice', text: '此思考内容由客户端隐藏' }
      else if (block.type === 'tool_use') yield { type: 'tool_use', name: text(block.name, 200) ?? '工具调用', ...toolInputPreview(block.input) }
      else if (block.type === 'tool_result') {
        const parts: string[] = []
        if (typeof block.content === 'string') parts.push(block.content)
        else if (Array.isArray(block.content)) for (const child of block.content) {
          const item = object(child)
          if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
          else if (item?.type === 'image' || item?.type === 'document') parts.push('[附件内容未展开]')
        }
        yield { type: 'tool_result', name: block.is_error === true ? '工具错误' : '工具结果', text: parts.join('\n') }
      } else if (block.type === 'image' || block.type === 'document') yield { type: 'notice', text: '附件内容未展开，请在原客户端查看' }
    }
  } else if (record.type === 'summary' && typeof record.summary === 'string') yield { type: 'notice', text: record.summary }
}

function contentMatches(record: JsonObject, query: string, onTruncated?: () => void): boolean {
  for (const block of contentBlocks(record)) {
    if (block.truncated) onTruncated?.()
    if (block.type !== 'notice' && (block.text.toLowerCase().includes(query) || block.name?.toLowerCase().includes(query))) return true
  }
  return false
}

function readableMessage(record: JsonObject, index: number, characterLimit: number): SessionContentMessage | undefined {
  const blocks: SessionContentBlock[] = []
  let remaining = characterLimit, truncated = false
  for (const block of contentBlocks(record)) {
    if (blocks.length >= maxContentBlocks || remaining <= 0) { truncated = true; break }
    const safe = block.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    const shortened = safe.length > remaining
    blocks.push({ ...block, text: safe.slice(0, remaining), ...(shortened ? { truncated: true } : {}) })
    remaining -= Math.min(safe.length, remaining)
    truncated ||= shortened || block.truncated === true
  }
  if (!blocks.length) return
  const message = object(record.message)
  return { index, role: record.type === 'user' ? 'user' : record.type === 'assistant' ? 'assistant' : 'system', timestamp: timestamp(record.timestamp), model: text(message?.model, 200), blocks, ...(truncated ? { truncated: true } : {}) }
}

function sessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  return sessionIdPattern.test(value) ? value : undefined
}

function directoryIdentity(path: string, label: string): ClaudeSessionDirectoryIdentity {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(label + '不是稳定的普通目录')
  const canonicalPath = realpathSync(path), canonicalStat = lstatSync(canonicalPath), after = lstatSync(path)
  if (!canonicalStat.isDirectory() || after.isSymbolicLink() || stat.dev !== canonicalStat.dev || stat.ino !== canonicalStat.ino || stat.dev !== after.dev || stat.ino !== after.ino) throw new Error('Claude Code 会话目录已被替换')
  return { path, canonicalPath, device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

function workingDirectoryIdentity(path: string): ClaudeSessionDirectoryIdentity {
  if (!isAbsolute(path)) throw new Error('Claude Code 项目工作目录必须是绝对路径')
  const stat = lstatSync(path)
  if (!stat.isDirectory()) throw new Error('Claude Code 项目工作目录不是普通目录')
  const canonicalPath = resolve(realpathSync(path)), resolved = lstatSync(canonicalPath)
  if (!resolved.isDirectory() || stat.dev !== resolved.dev || stat.ino !== resolved.ino) throw new Error('Claude Code 项目工作目录已变化')
  return { path, canonicalPath, device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

function unchangedDirectory(expected: ClaudeSessionDirectoryIdentity, entries = false): void {
  const actual = directoryIdentity(expected.path, 'Claude Code 会话目录')
  if (actual.canonicalPath !== expected.canonicalPath || actual.device !== expected.device || actual.inode !== expected.inode) throw new Error('Claude Code 会话目录已被替换，请刷新列表')
  if (entries && (actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs)) throw new Error('Claude Code 会话目录正在变化，请刷新列表')
}

function sameFile(first: Stats, second: Stats): boolean {
  return second.isFile() && !second.isSymbolicLink() && second.nlink === 1 && first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
}

function regularFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Claude Code 会话必须是唯一的普通文件')
  if (stat.size > maxBytesPerFile) throw new Error('Claude Code 会话文件超过安全读取上限')
}

/**
 * Read through an owned descriptor with a bounded buffer. Check the lexical
 * path before canonicalisation, so an in-root symlink cannot hide itself.
 */
function readTranscript(path: string, validateDirectories: () => void, options: TranscriptReadOptions = {}): { stat: Stats; sha256: string; metadata: TranscriptMetadata; segments: TranscriptSegment[] } {
  validateDirectories()
  const expected = lstatSync(path)
  regularFile(expected)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!sameFile(expected, stat)) throw new Error('Claude Code 会话文件已被替换')
    const metadata: TranscriptMetadata = { messageCount: 0, kind: 'conversation', ...(options.contentQuery ? { contentMatched: false } : {}) }
    const digest = createHash('sha256'), buffer = Buffer.alloc(chunkBytes), decoder = new TextDecoder('utf-8', { fatal: true })
    let offset = 0, pendingChunks: Buffer[] = [], pendingLength = 0
    const ids = new Set<string>(), segmentMetadata = new Map<string, TranscriptMetadata>()
    let activeSessionId: string | undefined
    const emptyMetadata = (): TranscriptMetadata => ({ messageCount: 0, kind: 'conversation', ...(options.contentQuery ? { contentMatched: false } : {}) })
    const unscopedMetadata = emptyMetadata()
    const parse = (line: Buffer, terminated: boolean): void => {
      if (line.length > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
      if (!line.length) return
      let decoded: string
      try { decoded = decoder.decode(line).trim() } catch { throw new Error('Claude Code 会话记录不是有效 UTF-8') }
      if (!decoded) return
      let parsed: unknown
      try { parsed = JSON.parse(decoded) } catch {
        if (!terminated) { metadata.incomplete = true; metadata.resumeBlockedReason = 'Claude Code 会话末尾记录不完整，请等待写入完成后刷新'; return }
        throw new Error('Claude Code 会话记录不是有效 JSON')
      }
      const record = object(parsed)
      if (!record) throw new Error('Claude Code 会话记录格式无效')
      // uuid/id identify individual messages and snapshots, never a session.
      const rawId = record.sessionId ?? record.session_id
      let recordMetadata = activeSessionId ? segmentMetadata.get(activeSessionId) : unscopedMetadata
      if (rawId !== undefined) {
        const id = sessionId(rawId)
        if (!id) throw new Error('Claude Code 会话记录 ID 格式无效')
        ids.add(id)
        if (ids.size > 32) throw new Error('Claude Code 会话文件包含过多不同会话 ID')
        activeSessionId = id
        recordMetadata = segmentMetadata.get(id) ?? emptyMetadata()
        segmentMetadata.set(id, recordMetadata)
        // Some Claude transcripts retain multiple conversations in one file.
        // Each ID is projected as a separate row below.
        if (ids.size > 1) metadata.multipleSessionIds = true
        metadata.id = id
        recordMetadata.id = id
      }
      recordMetadata ??= metadata
      // If the file contains multiple conversation IDs, associate ID-less
      // records with the preceding segment and never project another session's
      // content into the selected conversation.
      if (options.sessionId && activeSessionId !== options.sessionId && !(activeSessionId === undefined && options.includeUnscopedFor === options.sessionId)) return
      const cwd = workingDirectory(record.cwd ?? record.projectPath ?? record.project_path)
      if (cwd) {
        if (!isAbsolute(cwd)) throw new Error('Claude Code 会话工作目录无效')
        addWorkingDirectory(recordMetadata, cwd)
        recordMetadata.cwd ??= cwd
      }
      const time = timestamp(record.timestamp ?? record.updatedAt ?? record.updated_at)
      if (time !== undefined) {
        recordMetadata.createdAt = Math.min(recordMetadata.createdAt ?? time, time)
        recordMetadata.updatedAt = Math.max(recordMetadata.updatedAt ?? time, time)
      }
      if (record.isSidechain === true) recordMetadata.kind = 'subagent'
      if (record.type === 'custom-title') recordMetadata.customTitle = text(record.customTitle ?? record.title ?? record.name) ?? recordMetadata.customTitle
      if (record.type === 'summary') recordMetadata.summary = text(record.summary) ?? recordMetadata.summary
      const message = object(record.message)
      if ((record.type === 'user' || record.type === 'assistant') && message) recordMetadata.messageCount++
      if (record.type === 'user' && message && record.isMeta !== true && record.isSidechain !== true && !recordMetadata.firstPrompt) {
        const prompt = messageText(message.content)
        if (prompt && !prompt.includes('<local-command-caveat>') && !prompt.startsWith('<command-name>')) recordMetadata.firstPrompt = prompt
      }
      if (record.type === 'assistant' && message) recordMetadata.model = text(message.model, 200) ?? recordMetadata.model
      recordMetadata.gitBranch = text(record.gitBranch, 200) ?? recordMetadata.gitBranch
      if (options.contentQuery && !recordMetadata.contentMatched) recordMetadata.contentMatched = contentMatches(record, options.contentQuery.toLowerCase(), () => { recordMetadata.contentSearchTruncated = true })
      if (!options.sessionId || activeSessionId === options.sessionId || activeSessionId === undefined && options.includeUnscopedFor === options.sessionId) options.onRecord?.(record)
    }
    while (offset < stat.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (!bytes) throw new Error('Claude Code 会话文件在读取时被截断，请刷新列表')
      offset += bytes
      digest.update(buffer.subarray(0, bytes))
      let start = 0
      for (let end = 0; end < bytes; end++) if (buffer[end] === 10) {
        const part = buffer.subarray(start, end)
        const lineLength = pendingLength + part.length
        if (lineLength > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
        parse(pendingLength ? Buffer.concat([...pendingChunks, part], lineLength) : part, true)
        pendingChunks = []; pendingLength = 0; start = end + 1
      }
      if (start < bytes) {
        const part = buffer.subarray(start, bytes), lineLength = pendingLength + part.length
        if (lineLength > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
        // readSync reuses the same buffer; retain one copy per chunk and only
        // concatenate once when this bounded JSONL line is complete.
        pendingChunks.push(Buffer.from(part)); pendingLength = lineLength
      }
    }
    if (pendingLength) parse(Buffer.concat(pendingChunks, pendingLength), false)
    const segments = [...segmentMetadata].map(([id, value]) => {
      const segment = { ...value, multipleSessionIds: ids.size > 1 || undefined }
      segment.title = segment.customTitle ?? segment.firstPrompt ?? segment.summary
      if (ids.size > 1) segment.resumeBlockedReason ??= 'Claude Code 会话文件包含多个会话 ID；详情可查看，但不能安全继续对话'
      if (metadata.incomplete) { segment.incomplete = true; segment.resumeBlockedReason ??= metadata.resumeBlockedReason }
      return { id, metadata: segment }
    })
    if (segments.length) {
      // Older Claude transcripts can begin with unscoped control/message
      // records before the first sessionId. Keep those records with that
      // first segment rather than dropping the visible conversation prefix.
      const first = segments[0].metadata, prefix = unscopedMetadata
      first.messageCount += prefix.messageCount
      first.createdAt = Math.min(first.createdAt ?? Infinity, prefix.createdAt ?? Infinity)
      if (!Number.isFinite(first.createdAt)) first.createdAt = undefined
      first.updatedAt = Math.max(first.updatedAt ?? 0, prefix.updatedAt ?? 0) || undefined
      first.cwd ??= prefix.cwd
      for (const cwd of prefix.cwdCandidates ?? []) addWorkingDirectory(first, cwd)
      first.model ??= prefix.model
      first.gitBranch ??= prefix.gitBranch
      first.firstPrompt ??= prefix.firstPrompt
      first.customTitle ??= prefix.customTitle
      first.summary ??= prefix.summary
      first.contentMatched ||= prefix.contentMatched
      first.contentSearchTruncated ||= prefix.contentSearchTruncated
      first.resumeBlockedReason ??= prefix.resumeBlockedReason
      first.incomplete ||= prefix.incomplete
    }
    if (segments.length === 1) Object.assign(metadata, segments[0].metadata)
    else if (!segments.length) Object.assign(metadata, unscopedMetadata, { sessionIds: [...ids] })
    else Object.assign(metadata, { sessionIds: [...ids], multipleSessionIds: true, incomplete: metadata.incomplete, resumeBlockedReason: metadata.resumeBlockedReason })
    if (!sameFile(stat, fstatSync(fd)) || !sameFile(stat, lstatSync(path))) throw new Error('Claude Code 会话文件正在变化，请刷新列表')
    validateDirectories()
    return { stat, metadata, segments, sha256: digest.digest('hex') }
  } finally { closeSync(fd) }
}

function sourceId(source: ClaudeSessionSource, project: ClaudeSessionDirectoryIdentity, path: string, stat: Stats, sha256: string, sessionIdValue?: string): string {
  const directory = (value: ClaudeSessionDirectoryIdentity) => [value.path, value.canonicalPath, value.device, value.inode]
  return createHash('sha256').update(JSON.stringify([source.instanceId ?? null, directory(source.config), directory(source.projects), directory(project), path, sessionIdValue ?? null, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, sha256])).digest('hex')
}

/**
 * Scan only the native projects/<project>/<session>.jsonl layout. Nested
 * subagent transcripts and Codex files are not top-level Claude conversations.
 * Display metadata is returned; conversation bodies never enter diagnostics.
 */
function* scanClaudeCodeSessionSteps(configDirectory: string, options: ClaudeSessionScanOptions): Generator<void, ClaudeSessionScan> {
  if (!isAbsolute(configDirectory)) throw new Error('Claude Code 配置目录必须是绝对路径')
  const limit = options.maxFiles ?? maxFiles
  if (!Number.isInteger(limit) || limit < 1 || limit > maxFiles) throw new Error('Claude Code 会话扫描上限无效')
  if (options.instanceId !== undefined && (!options.instanceId || options.instanceId.length > 256 || /[\x00-\x1f\x7f]/.test(options.instanceId))) throw new Error('Claude Code 实例来源标识无效')
  if (options.contentQuery !== undefined && (typeof options.contentQuery !== 'string' || options.contentQuery.length > 200)) throw new Error('Claude Code 会话搜索条件无效')
  const paths = claudeCodeConfigPaths(resolve(configDirectory), options.home ?? homedir())
  const result: ClaudeSessionScan = { configDirectory: paths.configDirectory, sessionsDirectory: paths.sessionsDirectory, instanceId: options.instanceId, scannedAt: options.now?.() ?? Date.now(), records: [], warnings: [], complete: true }
  let source: ClaudeSessionSource
  try {
    const config = directoryIdentity(paths.configDirectory, 'Claude Code 配置目录')
    const projects = directoryIdentity(join(config.canonicalPath, 'projects'), 'Claude Code projects 目录')
    source = { instanceId: options.instanceId, config, projects }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  result.source = source
  const records = new Map<string, ClaudeSessionRecord>()
  const note = (message: string): void => { if (result.warnings.length < 100 && !result.warnings.includes(message)) result.warnings.push(message) }
  const warn = (message: string): void => { result.complete = false; note(message) }
  const skipped = new Map<string, number>()
  let mixedIdFiles = 0
  const skip = (error: unknown): void => {
    const err = error as NodeJS.ErrnoException
    const message = error instanceof Error ? error.message : ''
    let category = '读取校验失败'
    if (err.code === 'EACCES' || err.code === 'EPERM') category = '系统权限限制'
    else if (err.code === 'ENOENT') category = '文件在扫描时消失'
    else if (err.code === 'ELOOP' || /普通文件|普通目录/.test(message)) category = '检测到符号链接或非普通文件'
    else if (/超过安全读取上限/.test(message) && /单行/.test(message)) category = '单行超过安全读取上限'
    else if (/超过安全读取上限/.test(message) && /文件/.test(message)) category = '文件超过安全读取上限'
    else if (/超过安全读取上限/.test(message)) category = '超过安全读取上限'
    else if (/不是有效 UTF-8/.test(message)) category = '文本编码无效'
    else if (/不是有效 JSON/.test(message)) category = 'JSONL 记录格式损坏'
    else if (/会话记录格式无效/.test(message)) category = 'JSONL 记录不是对象'
    else if (/过多不同会话 ID/.test(message)) category = '文件包含过多不同会话 ID'
    else if (/工作目录无效/.test(message)) category = '会话工作目录字段无效'
    else if (err.code === 'ENOTDIR') category = '目录结构格式异常'
    else if (err.code === 'EMFILE' || err.code === 'ENFILE') category = '系统可用文件描述符不足'
    else if (err.code === 'EIO') category = '磁盘读取错误'
    else if (/变化|截断|替换/.test(message)) category = '文件在读取期间发生变化'
    skipped.set(category, (skipped.get(category) ?? 0) + 1)
  }
  const reportSkipped = (): void => {
    if (!skipped.size) return
    const summary = [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `${category} ${count} 个`).join('；')
    warn(`部分 Claude Code 会话未显示：${summary}。请检查本地 Claude 配置目录与会话文件。未输出文件名或会话内容。`)
  }
  let count = 0
  const root = source.projects.canonicalPath, projects = readdirSync(root).sort()
  for (const projectName of projects) {
    yield
    // Desktop stores SSH transcript caches beside local projects. These belong
    // to another host and must not be presented as resumable local sessions.
    if (projectName.startsWith('ssh-')) continue
    const projectPath = join(root, projectName)
    let project: ClaudeSessionDirectoryIdentity, files: string[]
    try {
      const stat = lstatSync(projectPath)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue
      project = directoryIdentity(projectPath, 'Claude Code 项目目录')
      files = readdirSync(projectPath).sort()
    } catch (error) { skip(error); continue }
    const validate = (): void => { unchangedDirectory(source.config); unchangedDirectory(source.projects); unchangedDirectory(project) }
    const projectRows: ClaudeSessionRecord[] = []
    for (const fileName of files) {
      yield
      if (extname(fileName).toLowerCase() !== '.jsonl' || fileName.startsWith('agent-') || fileName === 'journal.jsonl' || fileName.includes('.superseded-')) continue
      if (++count > limit) throw new Error('Claude Code 会话文件超过扫描上限，请选择单个配置目录')
      const path = join(projectPath, fileName)
      try {
        const fileId = sessionId(basename(fileName, extname(fileName)))
        const { stat, metadata, segments, sha256 } = readTranscript(path, validate, { contentQuery: options.contentQuery })
        if (!stat.size) continue
        if (metadata.incomplete) warn('部分 Claude Code 会话尚未写入完整，请等待写入完成后刷新')
        if (metadata.contentSearchTruncated || segments.some(segment => segment.metadata.contentSearchTruncated)) note('部分 Claude Code 工具参数超出读取上限，正文搜索未包含其省略部分；可打开源文件查看')
        if (segments.length > 1) mixedIdFiles++
        const sessionSegments = segments.length ? segments : [{ id: metadata.id ?? fileId ?? '', metadata }]
        for (const segment of sessionSegments) {
          const id = sessionId(segment.id)
          if (!id || segment.metadata.kind === 'subagent') continue
          const current = segment.metadata
          if (fileId && fileId !== id) current.resumeBlockedReason ??= current.multipleSessionIds ? 'Claude Code 会话文件包含多个会话 ID；详情可查看，但不能安全继续对话' : 'Claude Code 会话 ID 与文件名不一致，请核对来源文件'
          if (current.multipleSessionIds) current.resumeBlockedReason ??= 'Claude Code 会话文件包含多个会话 ID；详情可查看，但不能安全继续对话'
          if (!current.messageCount) current.resumeBlockedReason ??= 'Claude Code 会话缺少可恢复的消息记录'
          const location: ClaudeSessionLocation = {
            path, projectDirectory: projectPath, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256,
            sourceId: sourceId(source, project, path, stat, sha256, current.multipleSessionIds ? id : undefined), source, project, cwd: current.cwd, cwdCandidates: current.cwdCandidates ? [...current.cwdCandidates] : current.cwd ? [current.cwd] : undefined, cwdCandidateIdentities: (current.cwdCandidates ?? (current.cwd ? [current.cwd] : [])).flatMap(candidate => { try { const identity = workingDirectoryIdentity(candidate); return [{ path: candidate, canonicalPath: identity.canonicalPath, device: identity.device, inode: identity.inode }] } catch { return [] } }), title: current.title ?? (current.cwd ? basename(current.cwd) : id), kind: current.kind, ...(current.multipleSessionIds ? { contentSessionId: id, ...(segments[0].id === id ? { contentIncludesPrefix: true } : {}) } : {}), resumeBlockedReason: current.resumeBlockedReason, contentMatched: current.contentMatched,
          }
          projectRows.push({ id, title: location.title, cwd: current.cwd, projectDirectory: projectPath, createdAt: current.createdAt, updatedAt: current.updatedAt ?? stat.mtimeMs, model: current.model, gitBranch: current.gitBranch, messageCount: current.messageCount, locations: [location], conflict: false })
        }
      } catch (error) { skip(error) }
    }
    try { validate(); unchangedDirectory(project, true) } catch (error) { skip(error); warn('Claude Code 项目目录在扫描期间发生变化，已丢弃该目录的读取结果'); continue }
    for (const row of projectRows) {
      const previous = records.get(row.id)
      if (!previous) records.set(row.id, row)
      else { previous.locations.push(...row.locations); previous.conflict = true; previous.updatedAt = Math.max(previous.updatedAt, row.updatedAt) }
    }
  }
  unchangedDirectory(source.config)
  unchangedDirectory(source.projects, true)
  reportSkipped()
  if (mixedIdFiles) note(`${mixedIdFiles} 个 Claude Code 会话文件包含多个会话 ID：详情仍可查看，但这些文件不能安全继续对话。`)
  result.records = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return result
}

export function scanClaudeCodeSessions(configDirectory: string, options: ClaudeSessionScanOptions = {}): ClaudeSessionScan {
  const steps = scanClaudeCodeSessionSteps(configDirectory, options)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

/** Main-process catalog scans yield between files so cancellation remains live. */
export async function scanClaudeCodeSessionsAsync(configDirectory: string, options: ClaudeSessionScanOptions & { signal?: AbortSignal } = {}): Promise<ClaudeSessionScan> {
  const steps = scanClaudeCodeSessionSteps(configDirectory, options)
  try {
    while (true) {
      options.signal?.throwIfAborted()
      const result = steps.next()
      if (result.done) { options.signal?.throwIfAborted(); return result.value }
      await setImmediate()
    }
  } finally { steps.return({ configDirectory, sessionsDirectory: join(configDirectory, 'projects'), scannedAt: 0, records: [], warnings: [], complete: false }) }
}

/** Safe read-only opening does not ask Claude to resolve an ambiguous ID. */
export function verifyClaudeSessionLocation(location: ClaudeSessionLocation): string {
  const validate = (): void => { unchangedDirectory(location.source.config); unchangedDirectory(location.source.projects); unchangedDirectory(location.project) }
  const current = readTranscript(location.path, validate)
  if (sourceId(location.source, location.project, location.path, current.stat, current.sha256, location.contentSessionId ?? undefined) !== location.sourceId) throw new Error('Claude Code 会话来源已变化，请刷新列表')
  return location.path
}

export interface ClaudeSessionContentPage {
  page: number
  pageSize: number
  total: number
  messages: SessionContentMessage[]
  warnings: string[]
}

/** The requested page is projected while validating the entire transcript.
 * No body is cached in a catalog snapshot, and stale reads return no content. */
export function readClaudeSessionContent(location: ClaudeSessionLocation, raw: { page?: number; pageSize?: number; query?: string } = {}): ClaudeSessionContentPage {
  const input = sessionContentSchema.pick({ page: true, pageSize: true, query: true }).parse(raw)
  const start = (input.page - 1) * input.pageSize, query = input.query.toLowerCase()
  const result: ClaudeSessionContentPage = { page: input.page, pageSize: input.pageSize, total: 0, messages: [], warnings: [] }
  let index = 0, searchTruncated = false
  const validate = (): void => { unchangedDirectory(location.source.config); unchangedDirectory(location.source.projects); unchangedDirectory(location.project) }
  const current = readTranscript(location.path, validate, { sessionId: location.contentSessionId, includeUnscopedFor: location.contentIncludesPrefix ? location.contentSessionId : undefined, onRecord(record) {
    // Unknown record types, indexes and title updates are not conversation text.
    if (!hasReadableContent(record)) return
    const messageIndex = index++
    if (query && !contentMatches(record, query, () => { searchTruncated = true })) return
    const position = result.total++
    if (position < start || position >= start + input.pageSize) return
    const message = readableMessage(record, messageIndex, Math.min(maxContentMessageCharacters, Math.floor(maxContentPageCharacters / input.pageSize)))
    if (message) result.messages.push(message)
  } })
  if (sourceId(location.source, location.project, location.path, current.stat, current.sha256, location.contentSessionId ?? undefined) !== location.sourceId) throw new Error('Claude Code 会话来源已变化，请刷新列表')
  if (current.metadata.incomplete) result.warnings.push('会话末尾仍在写入，仅显示已完整保存的消息；请稍后刷新')
  if (searchTruncated) result.warnings.push('部分工具参数超出读取上限，搜索未包含其省略部分；可打开源文件查看')
  if (result.messages.some(message => message.truncated)) result.warnings.push('部分长消息或工具输出已截断，可打开源文件查看完整内容')
  return result
}

function currentResumeLocation(record: Pick<ClaudeSessionRecord, 'id' | 'locations' | 'conflict'>, targetPath?: string, selectedCwd?: string): ClaudeSessionLocation {
  const id = sessionId(record.id)
  if (!id) throw new Error('Claude Code 会话 ID 无效')
  if (record.conflict || record.locations.length !== 1) throw new Error('同 ID Claude Code 会话存在文件冲突，请先核对来源')
  const location = record.locations[0]
  if (!location.source || !location.sourceId) throw new Error('Claude Code 会话缺少来源身份，请刷新列表')
  if (targetPath !== undefined) {
    if (!isAbsolute(targetPath)) throw new Error('Claude Code 会话路径不属于当前索引')
    regularFile(lstatSync(targetPath))
    const parent = directoryIdentity(dirname(resolve(targetPath)), 'Claude Code 项目目录')
    if (join(parent.canonicalPath, basename(targetPath)) !== location.path) throw new Error('Claude Code 会话路径不属于当前索引')
  }
  unchangedDirectory(location.source.config)
  unchangedDirectory(location.source.projects)
  unchangedDirectory(location.project)
  // A new file with this ID may have appeared since the displayed snapshot.
  // --resume is an ID lookup; an explicitly selected path cannot disambiguate it.
  const current = scanClaudeCodeSessions(location.source.config.path, { instanceId: location.source.instanceId })
  const currentRecord = current.records.find(value => value.id === id)
  if (currentRecord?.conflict) throw new Error('同 ID Claude Code 会话存在文件冲突，请先核对来源')
  if (!current.complete) throw new Error('Claude Code 会话来源尚未完整读取，请刷新后重试')
  const selected = currentRecord?.locations[0]
  if (!selected || selected.sourceId !== location.sourceId) throw new Error('Claude Code 会话来源已变化，请刷新列表')
  if (selected.resumeBlockedReason) throw new Error(selected.resumeBlockedReason)
  if (selectedCwd !== undefined) {
    if (!isAbsolute(selectedCwd) || !(selected.cwdCandidates ?? (selected.cwd ? [selected.cwd] : [])).some(candidate => resolve(candidate) === resolve(selectedCwd))) throw new Error('Claude Code 会话不属于所选项目工作目录')
    const candidate = (selected.cwdCandidates ?? []).find(value => resolve(value) === resolve(selectedCwd))
    if (!candidate) throw new Error('Claude Code 会话不属于所选项目工作目录')
    const originalIdentity = location.cwdCandidateIdentities?.find(value => resolve(value.path) === resolve(selectedCwd))
    const candidateIdentity = selected.cwdCandidateIdentities?.find(value => resolve(value.path) === resolve(candidate))
    if (!originalIdentity || !candidateIdentity || originalIdentity.canonicalPath !== candidateIdentity.canonicalPath || originalIdentity.device !== candidateIdentity.device || originalIdentity.inode !== candidateIdentity.inode) throw new Error('Claude Code 项目目录身份已变化，请重新预览')
    const liveIdentity = workingDirectoryIdentity(candidate)
    if (candidateIdentity.canonicalPath !== liveIdentity.canonicalPath || candidateIdentity.device !== liveIdentity.device || candidateIdentity.inode !== liveIdentity.inode) throw new Error('Claude Code 项目目录身份已变化，请重新预览')
  }
  return selected
}

/** Compatibility helper. Launchers must use a scope-bound resume preview. */
export function claudeSessionResumeArgs(record: Pick<ClaudeSessionRecord, 'id' | 'locations' | 'conflict'>, targetPath?: string): string[] {
  currentResumeLocation(record, targetPath)
  return ['--resume', record.id]
}

/**
 * The caller supplies the current instance scope, not values copied from an
 * arbitrary UI row. Re-run this at launch after checking the instance revision
 * and account binding; transcript data never proves which account is logged in.
 */
export function previewClaudeSessionResume(scan: ClaudeSessionScan, input: ClaudeSessionResumeSelection): ClaudeSessionResumePreview {
  if (!isAbsolute(input.configDirectory) || resolve(input.configDirectory) !== scan.configDirectory || input.instanceId !== scan.instanceId) throw new Error('Claude Code 会话不属于当前实例配置目录')
  const record = scan.records.find(value => value.id === input.sessionId)
  if (!record || !record.locations.some(value => value.sourceId === input.sourceId)) throw new Error('Claude Code 会话来源不属于当前索引')
  const originalLocation = record.locations.find(value => value.sourceId === input.sourceId)
  if (!originalLocation) throw new Error('Claude Code 会话来源不属于当前索引')
  if (!isAbsolute(input.cwd) || !(originalLocation.cwdCandidates ?? (originalLocation.cwd ? [originalLocation.cwd] : [])).some(value => resolve(value) === resolve(input.cwd))) throw new Error('Claude Code 会话不属于当前项目工作目录')
  const originalIdentity = originalLocation.cwdCandidateIdentities?.find(value => resolve(value.path) === resolve(input.cwd))
  if (!originalIdentity) throw new Error('所选 Claude Code 项目目录在会话快照中没有稳定身份')
  const location = currentResumeLocation(record, undefined, input.cwd)
  const candidate = (location.cwdCandidates ?? (location.cwd ? [location.cwd] : [])).find(value => resolve(value) === resolve(input.cwd))
  if (!candidate) throw new Error('Claude Code 会话不属于当前项目工作目录')
  const cwdIdentity = workingDirectoryIdentity(candidate), selectedCwd = workingDirectoryIdentity(input.cwd)
  if (cwdIdentity.canonicalPath !== selectedCwd.canonicalPath || cwdIdentity.device !== selectedCwd.device || cwdIdentity.inode !== selectedCwd.inode) throw new Error('Claude Code 会话不属于当前项目工作目录')
  if (cwdIdentity.canonicalPath !== originalIdentity.canonicalPath || cwdIdentity.device !== originalIdentity.device || cwdIdentity.inode !== originalIdentity.inode) throw new Error('Claude Code 项目目录已变化，请刷新会话列表')
  const selectedLocation = { ...location, cwd: candidate }
  return { clientType: 'claude_code', applicationKind: 'cli', instanceId: input.instanceId, configDirectory: scan.configDirectory, cwd: candidate, cwdCanonicalPath: cwdIdentity.canonicalPath, cwdDevice: cwdIdentity.device, cwdInode: cwdIdentity.inode, sessionId: record.id, sourceId: location.sourceId, projectDirectory: location.projectDirectory, args: ['--resume', record.id], location: structuredClone(selectedLocation) }
}

export function claudeSessionIdentity(path: string): { path: string; device: number; inode: number; sha256: string } {
  if (!isAbsolute(path)) throw new Error('Claude Code 会话路径必须是绝对路径')
  // Do not resolve away a symlink at either the file or its project directory.
  const project = directoryIdentity(dirname(resolve(path)), 'Claude Code 项目目录')
  regularFile(lstatSync(path))
  const canonical = join(project.canonicalPath, basename(path))
  const { stat, sha256 } = readTranscript(canonical, () => unchangedDirectory(project))
  return { path: canonical, device: stat.dev, inode: stat.ino, sha256 }
}

/** Claude has no Codex archive/index projection; summarize its own projects. */
export function readClaudeCodeInstanceHistory(configDirectory: string, options: ClaudeSessionScanOptions = {}): InstanceHistorySummary {
  const summary: InstanceHistorySummary = { sessions: 0, archived: 0, projects: [], unassigned: 0, issues: [] }
  try {
    const scan = scanClaudeCodeSessions(configDirectory, options), projects = new Map<string, InstanceHistorySummary['projects'][number]>()
    summary.issues = [...scan.warnings]
    for (const record of scan.records) {
      summary.sessions++
      if (record.conflict) {
        summary.unassigned++
        if (!summary.issues.includes('部分 Claude Code 会话存在同 ID 文件冲突，未自动合并项目')) summary.issues.push('部分 Claude Code 会话存在同 ID 文件冲突，未自动合并项目')
        continue
      }
      if (!record.cwd) { summary.unassigned++; continue }
      let project = projects.get(record.cwd)
      if (!project) {
        let exists = false
        try { directoryIdentity(record.cwd, 'Claude Code 项目工作目录'); exists = true } catch { /* Only an existence hint is displayed. */ }
        project = { path: record.cwd, name: basename(record.cwd) || record.cwd, exists, sessions: 0 }
        projects.set(record.cwd, project)
      }
      project.sessions++
    }
    summary.projects = [...projects.values()].sort((a, b) => a.path.localeCompare(b.path))
  } catch { summary.issues = ['Claude Code 会话目录无法安全读取，请检查实例目录'] }
  return summary
}
