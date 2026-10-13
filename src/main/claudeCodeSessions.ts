import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { claudeCodeConfigPaths } from './claudeCodeInstanceAdapter'
import type { InstanceHistorySummary } from '../shared/instances'

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const maxFiles = 100_000
const maxBytesPerFile = 64 * 1024 * 1024
const maxLineBytes = 2 * 1024 * 1024
const chunkBytes = 64 * 1024

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
function readTranscript(path: string, validateDirectories: () => void): { stat: Stats; sha256: string; metadata: TranscriptMetadata } {
  validateDirectories()
  const expected = lstatSync(path)
  regularFile(expected)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!sameFile(expected, stat)) throw new Error('Claude Code 会话文件已被替换')
    const metadata: TranscriptMetadata = { messageCount: 0, kind: 'conversation' }
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
      const cwd = text(record.cwd ?? record.projectPath ?? record.project_path, 4096)
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
      if (record.type === 'user' && message && record.isMeta !== true && record.isSidechain !== true && !firstPrompt) firstPrompt = messageText(message.content)
      if (record.type === 'assistant' && message) metadata.model = text(message.model, 200) ?? metadata.model
      metadata.gitBranch = text(record.gitBranch, 200) ?? metadata.gitBranch
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
    metadata.title = customTitle ?? summary ?? firstPrompt
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
  const warn = (message: string): void => { result.complete = false; if (result.warnings.length < 100) result.warnings.push(message) }
  let count = 0
  const root = source.projects.canonicalPath, projects = readdirSync(root).sort()
  for (const projectName of projects) {
    yield
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
      if (extname(fileName).toLowerCase() !== '.jsonl' || fileName.startsWith('agent-')) continue
      if (++count > limit) throw new Error('Claude Code 会话文件超过扫描上限，请选择单个配置目录')
      const path = join(projectPath, fileName)
      try {
        const { stat, metadata, sha256 } = readTranscript(path, validate)
        const fileId = sessionId(basename(fileName, extname(fileName))), id = metadata.id ?? fileId
        if (!id || !stat.size || metadata.kind === 'subagent') continue
        if (fileId !== id) metadata.resumeBlockedReason ??= 'Claude Code 会话 ID 与文件名不一致，请核对来源文件'
        if (!metadata.messageCount) metadata.resumeBlockedReason ??= 'Claude Code 会话缺少可恢复的消息记录'
        const location: ClaudeSessionLocation = {
          path, projectDirectory: projectPath, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256,
          sourceId: sourceId(source, project, path, stat, sha256), source, project, cwd: metadata.cwd, title: metadata.title ?? id, kind: metadata.kind, resumeBlockedReason: metadata.resumeBlockedReason,
        }
        if (metadata.incomplete) warn('部分 Claude Code 会话尚未写入完整，请等待写入完成后刷新')
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
