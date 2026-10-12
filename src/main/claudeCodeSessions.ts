import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { claudeCodeConfigPaths } from './claudeCodeInstanceAdapter'

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const maxFiles = 100_000
const maxBytesPerFile = 64 * 1024 * 1024
const maxLineBytes = 2 * 1024 * 1024

export interface ClaudeSessionLocation {
  path: string
  projectDirectory: string
  device: number
  inode: number
  size: number
  mtimeMs: number
}

export interface ClaudeSessionRecord {
  id: string
  title: string
  cwd?: string
  projectDirectory: string
  updatedAt: number
  locations: ClaudeSessionLocation[]
  /** Multiple JSONL files with the same ID are never auto-selected. */
  conflict: boolean
}

export interface ClaudeSessionScan {
  configDirectory: string
  sessionsDirectory: string
  scannedAt: number
  records: ClaudeSessionRecord[]
  warnings: string[]
}

export interface ClaudeSessionScanOptions {
  /** The default is the process home and is only useful for diagnostics. */
  home?: string
  now?: () => number
  maxFiles?: number
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    const parts = value.flatMap(item => {
      const record = object(item)
      return record?.type === 'text' ? [text(record.text) ?? ''] : []
    }).filter(Boolean)
    return parts.join('\n').trim() || undefined
  }
  return undefined
}

function sessionId(value: unknown): string | undefined {
  const result = text(value)
  return result && sessionIdPattern.test(result) ? result : undefined
}

function safeChild(root: string, child: string): string | undefined {
  if (!isAbsolute(root) || !isAbsolute(child)) return
  const canonicalRoot = realpathSync(root)
  const canonical = realpathSync(child)
  const path = relative(canonicalRoot, canonical)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return
  return canonical
}

function parseSessionFile(path: string, stat: Pick<Stats, 'mtimeMs' | 'size'>): {
  id?: string; title?: string; cwd?: string; updatedAt?: number
} {
  const buffer = readFileSync(path)
  if (buffer.byteLength > maxBytesPerFile) throw new Error('会话文件过大')
  let id: string | undefined
  let title: string | undefined
  let cwd: string | undefined
  let updatedAt: number | undefined
  let offset = 0
  while (offset < buffer.byteLength) {
    const end = buffer.indexOf(0x0a, offset)
    const lineEnd = end < 0 ? buffer.byteLength : end
    if (lineEnd - offset > maxLineBytes) { offset = lineEnd + 1; continue }
    const line = buffer.subarray(offset, lineEnd).toString('utf8').trim()
    offset = lineEnd + 1
    if (!line) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const record = object(value)
    if (!record) continue
    id ??= sessionId(record.sessionId ?? record.session_id ?? record.uuid ?? record.id)
    cwd ??= text(record.cwd) ?? text(record.projectPath) ?? text(record.project_path)
    updatedAt = Math.max(updatedAt ?? 0, timestamp(record.timestamp ?? record.updatedAt ?? record.updated_at) ?? 0)
    const customTitle = text(record.title) ?? text(record.name)
    if (customTitle && !title) title = customTitle
    const message = object(record.message)
    if (!title && record.type === 'user' && message) title = messageText(message.content)
  }
  return { id, title: title?.slice(0, 500), cwd, updatedAt: Math.max(updatedAt ?? 0, stat.mtimeMs), }
}

/**
 * Scan Claude Code's own JSONL transcript layout. This intentionally lives
 * outside the Codex SessionCatalog: Claude IDs, project directory encoding
 * and metadata events are different, so sharing the Codex session copier
 * would silently misclassify or overwrite conversations.
 */
export function scanClaudeCodeSessions(configDirectory: string, options: ClaudeSessionScanOptions = {}): ClaudeSessionScan {
  if (!isAbsolute(configDirectory)) throw new Error('Claude Code 配置目录必须是绝对路径')
  const resolvedConfig = resolve(configDirectory)
  try {
    const configStat = lstatSync(resolvedConfig)
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) throw new Error('Claude Code 配置目录不是稳定的普通目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const paths = claudeCodeConfigPaths(resolvedConfig, options.home ?? homedir())
  let root: string
  try {
    const sessionsStat = lstatSync(paths.sessionsDirectory)
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) throw new Error('Claude Code projects 目录不是稳定的普通目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configDirectory: paths.configDirectory, sessionsDirectory: paths.sessionsDirectory, scannedAt: options.now?.() ?? Date.now(), records: [], warnings: [] }
    throw error
  }
  try { root = realpathSync(paths.sessionsDirectory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configDirectory: paths.configDirectory, sessionsDirectory: paths.sessionsDirectory, scannedAt: options.now?.() ?? Date.now(), records: [], warnings: [] }
    throw error
  }
  const records = new Map<string, ClaudeSessionRecord>()
  const warnings: string[] = []
  const limit = options.maxFiles ?? maxFiles
  if (!Number.isInteger(limit) || limit < 1 || limit > maxFiles) throw new Error('Claude Code 会话扫描上限无效')
  let count = 0
  let projects: string[]
  try { projects = readdirSync(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configDirectory: paths.configDirectory, sessionsDirectory: paths.sessionsDirectory, scannedAt: options.now?.() ?? Date.now(), records: [], warnings: [] }
    throw error
  }
  for (const projectName of projects) {
    let projectPath: string
    try {
      projectPath = safeChild(root, join(root, projectName)) ?? ''
      if (!projectPath || lstatSync(projectPath).isSymbolicLink() || !lstatSync(projectPath).isDirectory()) continue
    } catch { warnings.push(`项目目录无法读取：${projectName}`); continue }
    let files: string[]
    try { files = readdirSync(projectPath) } catch { warnings.push(`项目目录无法读取：${projectName}`); continue }
    for (const fileName of files) {
      if (extname(fileName).toLowerCase() !== '.jsonl') continue
      if (++count > limit) throw new Error('Claude Code 会话文件超过扫描上限，请选择单个配置目录')
      const candidate = join(projectPath, fileName)
      try {
        const path = safeChild(root, candidate)
        if (!path || lstatSync(path).isSymbolicLink()) throw new Error('符号链接')
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('特殊文件')
        const parsed = parseSessionFile(path, stat)
        const id = parsed.id ?? sessionId(basename(fileName, '.jsonl'))
        if (!id) continue
        const location: ClaudeSessionLocation = { path, projectDirectory: projectPath, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
        const previous = records.get(id)
        if (!previous) {
          records.set(id, { id, title: parsed.title ?? id, cwd: parsed.cwd, projectDirectory: projectPath, updatedAt: parsed.updatedAt ?? stat.mtimeMs, locations: [location], conflict: false })
        } else {
          previous.locations.push(location)
          previous.conflict = true
          previous.updatedAt = Math.max(previous.updatedAt, parsed.updatedAt ?? stat.mtimeMs)
          if ((!previous.title || previous.title === id) && parsed.title) previous.title = parsed.title
          if (!previous.cwd && parsed.cwd) previous.cwd = parsed.cwd
        }
      } catch (error) {
        if (warnings.length < 100) warnings.push(`会话文件无法读取：${fileName}`)
      }
    }
  }
  return { configDirectory: paths.configDirectory, sessionsDirectory: paths.sessionsDirectory, scannedAt: options.now?.() ?? Date.now(), records: [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), warnings }
}

export function claudeSessionResumeArgs(record: Pick<ClaudeSessionRecord, 'id' | 'locations' | 'conflict'>, targetPath?: string): string[] {
  const id = sessionId(record.id)
  if (!id) throw new Error('Claude Code 会话 ID 无效')
  if (record.conflict || record.locations.length !== 1) throw new Error('同 ID Claude Code 会话存在文件冲突，请先选择唯一来源')
  if (targetPath !== undefined) {
    const location = record.locations[0]
    let canonicalTarget: string
    try { canonicalTarget = realpathSync(targetPath) } catch { throw new Error('Claude Code 会话路径不属于当前索引') }
    if (canonicalTarget !== location.path) throw new Error('Claude Code 会话路径不属于当前索引')
  }
  return ['--resume', id]
}

export function claudeSessionIdentity(path: string): { path: string; device: number; inode: number; sha256: string } {
  const canonical = realpathSync(path)
  const stat = lstatSync(canonical)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Claude Code 会话必须是唯一的普通文件')
  const data = readFileSync(canonical)
  return { path: canonical, device: stat.dev, inode: stat.ino, sha256: createHash('sha256').update(data).digest('hex') }
}
