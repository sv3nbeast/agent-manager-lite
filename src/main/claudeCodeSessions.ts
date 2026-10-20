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
const maxLineBytes = 2 * 1024 * 1024
const chunkBytes = 64 * 1024
const maxContentPageCharacters = 240_000
const maxContentMessageCharacters = 12_000
const maxContentBlocks = 64
const maxToolInputDepth = 16
const maxToolInputNodes = 2000
const maxToolInputCharacters = 32_000

export interface ClaudeSessionDirectoryIdentity {
  path: string
  canonicalPath: string
  device: number
  inode: number
  mtimeMs: number
  ctimeMs: number
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
  title: string
  kind: 'conversation' | 'subagent'
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
  args: string[]
  location: ClaudeSessionLocation
}

type JsonObject = Record<string, unknown>
interface TranscriptMetadata {
  id?: string
  title?: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  model?: string
  gitBranch?: string
  messageCount: number
  kind: 'conversation' | 'subagent'
  incomplete?: boolean
  resumeBlockedReason?: string
  contentMatched?: boolean
  contentSearchTruncated?: boolean
}

interface TranscriptReadOptions {
  contentQuery?: string
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
function readTranscript(path: string, validateDirectories: () => void, options: TranscriptReadOptions = {}): { stat: Stats; sha256: string; metadata: TranscriptMetadata } {
  validateDirectories()
  const expected = lstatSync(path)
  regularFile(expected)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!sameFile(expected, stat)) throw new Error('Claude Code 会话文件已被替换')
    const metadata: TranscriptMetadata = { messageCount: 0, kind: 'conversation', ...(options.contentQuery ? { contentMatched: false } : {}) }
    const digest = createHash('sha256'), buffer = Buffer.alloc(chunkBytes), decoder = new TextDecoder('utf-8', { fatal: true })
    let offset = 0, pending = Buffer.alloc(0), customTitle: string | undefined, summary: string | undefined, firstPrompt: string | undefined
    const parse = (line: Buffer, terminated: boolean): void => {
      if (line.length > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
      if (!line.length) return
      let record: JsonObject | undefined
      try { const decoded = decoder.decode(line).trim(); if (!decoded) return; record = object(JSON.parse(decoded)) } catch {
        if (!terminated) { metadata.incomplete = true; metadata.resumeBlockedReason = 'Claude Code 会话末尾记录不完整，请等待写入完成后刷新'; return }
        throw new Error('Claude Code 会话记录损坏，请检查来源文件')
      }
      if (!record) throw new Error('Claude Code 会话记录格式无效')
      // uuid/id identify individual messages and snapshots, never a session.
      const rawId = record.sessionId ?? record.session_id
      if (rawId !== undefined) {
        const id = sessionId(rawId)
        if (!id || metadata.id && metadata.id !== id) throw new Error('Claude Code 会话文件混入不同会话 ID')
        metadata.id = id
      }
      const cwd = workingDirectory(record.cwd ?? record.projectPath ?? record.project_path)
      if (cwd) {
        if (!isAbsolute(cwd)) throw new Error('Claude Code 会话工作目录无效')
        if (metadata.cwd && resolve(metadata.cwd) !== resolve(cwd)) metadata.resumeBlockedReason = 'Claude Code 会话包含多个工作目录，请核对项目后恢复'
        metadata.cwd ??= cwd
      }
      const time = timestamp(record.timestamp ?? record.updatedAt ?? record.updated_at)
      if (time !== undefined) {
        metadata.createdAt = Math.min(metadata.createdAt ?? time, time)
        metadata.updatedAt = Math.max(metadata.updatedAt ?? time, time)
      }
      if (record.isSidechain === true) metadata.kind = 'subagent'
      if (record.type === 'custom-title') customTitle = text(record.customTitle ?? record.title ?? record.name) ?? customTitle
      if (record.type === 'summary') summary = text(record.summary) ?? summary
      const message = object(record.message)
      if ((record.type === 'user' || record.type === 'assistant') && message) metadata.messageCount++
      if (record.type === 'user' && message && record.isMeta !== true && record.isSidechain !== true && !firstPrompt) {
        const prompt = messageText(message.content)
        if (prompt && !prompt.includes('<local-command-caveat>') && !prompt.startsWith('<command-name>')) firstPrompt = prompt
      }
      if (record.type === 'assistant' && message) metadata.model = text(message.model, 200) ?? metadata.model
      metadata.gitBranch = text(record.gitBranch, 200) ?? metadata.gitBranch
      if (options.contentQuery && !metadata.contentMatched) metadata.contentMatched = contentMatches(record, options.contentQuery.toLowerCase(), () => { metadata.contentSearchTruncated = true })
      options.onRecord?.(record)
    }
    while (offset < stat.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (!bytes) throw new Error('Claude Code 会话文件在读取时被截断，请刷新列表')
      offset += bytes
      digest.update(buffer.subarray(0, bytes))
      let start = 0
      for (let end = 0; end < bytes; end++) if (buffer[end] === 10) {
        const part = buffer.subarray(start, end)
        if (pending.length + part.length > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
        parse(pending.length ? Buffer.concat([pending, part]) : part, true)
        pending = Buffer.alloc(0); start = end + 1
      }
      if (start < bytes) {
        if (pending.length + bytes - start > maxLineBytes) throw new Error('Claude Code 会话单行超过安全读取上限')
        pending = Buffer.concat([pending, buffer.subarray(start, bytes)])
      }
    }
    if (pending.length) parse(pending, false)
    metadata.title = customTitle ?? firstPrompt ?? summary
    if (!sameFile(stat, fstatSync(fd)) || !sameFile(stat, lstatSync(path))) throw new Error('Claude Code 会话文件正在变化，请刷新列表')
    validateDirectories()
    return { stat, metadata, sha256: digest.digest('hex') }
  } finally { closeSync(fd) }
}

function sourceId(source: ClaudeSessionSource, project: ClaudeSessionDirectoryIdentity, path: string, stat: Stats, sha256: string): string {
  const directory = (value: ClaudeSessionDirectoryIdentity) => [value.path, value.canonicalPath, value.device, value.inode]
  return createHash('sha256').update(JSON.stringify([source.instanceId ?? null, directory(source.config), directory(source.projects), directory(project), path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, sha256])).digest('hex')
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
    } catch { warn('部分 Claude Code 项目目录无法安全读取，请刷新或检查目录'); continue }
    const validate = (): void => { unchangedDirectory(source.config); unchangedDirectory(source.projects); unchangedDirectory(project) }
    const projectRows: ClaudeSessionRecord[] = []
    for (const fileName of files) {
      yield
      if (extname(fileName).toLowerCase() !== '.jsonl' || fileName.startsWith('agent-') || fileName === 'journal.jsonl' || fileName.includes('.superseded-')) continue
      if (++count > limit) throw new Error('Claude Code 会话文件超过扫描上限，请选择单个配置目录')
      const path = join(projectPath, fileName)
      try {
        const { stat, metadata, sha256 } = readTranscript(path, validate, { contentQuery: options.contentQuery })
        const fileId = sessionId(basename(fileName, extname(fileName))), id = metadata.id ?? fileId
        if (!id || !stat.size || metadata.kind === 'subagent') continue
        if (fileId !== id) metadata.resumeBlockedReason ??= 'Claude Code 会话 ID 与文件名不一致，请核对来源文件'
        if (!metadata.messageCount) metadata.resumeBlockedReason ??= 'Claude Code 会话缺少可恢复的消息记录'
        const location: ClaudeSessionLocation = {
          path, projectDirectory: projectPath, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256,
          sourceId: sourceId(source, project, path, stat, sha256), source, project, cwd: metadata.cwd, title: metadata.title ?? (metadata.cwd ? basename(metadata.cwd) : id), kind: metadata.kind, resumeBlockedReason: metadata.resumeBlockedReason, contentMatched: metadata.contentMatched,
        }
        if (metadata.incomplete) warn('部分 Claude Code 会话尚未写入完整，请等待写入完成后刷新')
        if (metadata.contentSearchTruncated) note('部分 Claude Code 工具参数超出读取上限，正文搜索未包含其省略部分；可打开源文件查看')
        projectRows.push({ id, title: location.title, cwd: metadata.cwd, projectDirectory: projectPath, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt ?? stat.mtimeMs, model: metadata.model, gitBranch: metadata.gitBranch, messageCount: metadata.messageCount, locations: [location], conflict: false })
      } catch { warn('部分 Claude Code 会话文件无法安全读取，请刷新或检查来源文件') }
    }
    try { validate(); unchangedDirectory(project, true) } catch { warn('Claude Code 项目目录已变化，已丢弃该目录的读取结果'); continue }
    for (const row of projectRows) {
      const previous = records.get(row.id)
      if (!previous) records.set(row.id, row)
      else { previous.locations.push(...row.locations); previous.conflict = true; previous.updatedAt = Math.max(previous.updatedAt, row.updatedAt) }
    }
  }
  unchangedDirectory(source.config)
  unchangedDirectory(source.projects, true)
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
  if (sourceId(location.source, location.project, location.path, current.stat, current.sha256) !== location.sourceId) throw new Error('Claude Code 会话来源已变化，请刷新列表')
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
  const current = readTranscript(location.path, validate, { onRecord(record) {
    // Unknown record types, indexes and title updates are not conversation text.
    if (!hasReadableContent(record)) return
    const messageIndex = index++
    if (query && !contentMatches(record, query, () => { searchTruncated = true })) return
    const position = result.total++
    if (position < start || position >= start + input.pageSize) return
    const message = readableMessage(record, messageIndex, Math.min(maxContentMessageCharacters, Math.floor(maxContentPageCharacters / input.pageSize)))
    if (message) result.messages.push(message)
  } })
  if (sourceId(location.source, location.project, location.path, current.stat, current.sha256) !== location.sourceId) throw new Error('Claude Code 会话来源已变化，请刷新列表')
  if (current.metadata.incomplete) result.warnings.push('会话末尾仍在写入，仅显示已完整保存的消息；请稍后刷新')
  if (searchTruncated) result.warnings.push('部分工具参数超出读取上限，搜索未包含其省略部分；可打开源文件查看')
  if (result.messages.some(message => message.truncated)) result.warnings.push('部分长消息或工具输出已截断，可打开源文件查看完整内容')
  return result
}

function currentResumeLocation(record: Pick<ClaudeSessionRecord, 'id' | 'locations' | 'conflict'>, targetPath?: string): ClaudeSessionLocation {
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
  const location = currentResumeLocation(record)
  if (!location.cwd || !isAbsolute(input.cwd) || resolve(input.cwd) !== resolve(location.cwd)) throw new Error('Claude Code 会话不属于当前项目工作目录')
  directoryIdentity(resolve(input.cwd), 'Claude Code 项目工作目录')
  return { clientType: 'claude_code', applicationKind: 'cli', instanceId: input.instanceId, configDirectory: scan.configDirectory, cwd: location.cwd, sessionId: record.id, sourceId: location.sourceId, projectDirectory: location.projectDirectory, args: ['--resume', record.id], location: structuredClone(location) }
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
