import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute } from 'node:path'
import { claudeCodeAcceptanceSchema, claudeCodeCliAcceptance, claudeCodeDesktopAcceptance, type ClaudeCodeAcceptance } from '../shared/claudeCode'
import { detectClaudeCodeApplications, type ClaudeCodeDetectionOptions, type ClaudeCodeApplication } from './claudeCodeInstanceAdapter'
import { detectClaudeCodeDesktopApplications, type ClaudeCodeDesktopApplication } from './claudeCodeDesktopAdapter'

// Official native distributions include the runtime and already exceed
// 128 MiB. Stream the executable so a normal upstream update does not require
// a manager release or allocate a binary-sized buffer in the main process.
const maxHashBytes = 1024 * 1024 * 1024

export interface ClaudeExecutableIdentity {
  path: string
  device: number
  inode: number
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
}

export interface ClaudeCodeCapabilityReport {
  cli: ClaudeCodeApplication[]
  desktop: ClaudeCodeDesktopApplication[]
  cliAcceptance: ClaudeCodeAcceptance
  desktopAcceptance: ClaudeCodeAcceptance
}

function regularExecutable(path: string): { canonical: string; stat: Stats } {
  if (!isAbsolute(path)) throw new Error('Claude Code 程序路径必须是绝对路径')
  const original = lstatSync(path)
  if (original.isSymbolicLink()) throw new Error('Claude Code 程序路径不能是符号链接，请重新选择其真实文件')
  const canonical = realpathSync(path), stat = lstatSync(canonical)
  if (stat.isSymbolicLink() || !stat.isFile() || !(stat.mode & 0o111)) throw new Error('Claude Code 程序必须是普通可执行文件')
  return { canonical, stat }
}

export function captureClaudeExecutableIdentity(path: string): ClaudeExecutableIdentity {
  const { canonical, stat } = regularExecutable(path)
  if (!Number.isSafeInteger(stat.size) || stat.size > maxHashBytes) throw new Error('Claude Code 程序文件过大，无法验证身份')
  const descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const sameFile = (candidate: Stats) => candidate.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino && candidate.size === stat.size && candidate.mtimeMs === stat.mtimeMs && candidate.ctimeMs === stat.ctimeMs
    if (!sameFile(fstatSync(descriptor))) throw new Error('Claude Code 程序身份在读取时发生变化')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (!count) throw new Error('Claude Code 程序在读取时被截断')
      hash.update(buffer.subarray(0, count)); offset += count
    }
    if (!sameFile(fstatSync(descriptor)) || !sameFile(lstatSync(canonical))) throw new Error('Claude Code 程序身份在读取时发生变化')
    return {
      path: canonical, device: stat.dev, inode: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      sha256: hash.digest('hex'),
    }
  } finally {
    closeSync(descriptor)
  }
}

export function validateClaudeExecutableIdentity(expected: ClaudeExecutableIdentity, path = expected.path): ClaudeExecutableIdentity {
  const actual = captureClaudeExecutableIdentity(path)
  if (actual.path !== expected.path || actual.device !== expected.device || actual.inode !== expected.inode || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs || actual.sha256 !== expected.sha256) {
    throw new Error('Claude Code 程序身份已变化，请重新检测后再启动')
  }
  return actual
}

/** Read-only capability report. Detection never executes a candidate or writes a registry entry. */
export function inspectClaudeCodeCapabilities(options: ClaudeCodeDetectionOptions = {}): ClaudeCodeCapabilityReport {
  return {
    cli: detectClaudeCodeApplications(options),
    desktop: detectClaudeCodeDesktopApplications(options),
    cliAcceptance: claudeCodeAcceptanceSchema.parse(claudeCodeCliAcceptance),
    desktopAcceptance: claudeCodeAcceptanceSchema.parse(claudeCodeDesktopAcceptance),
  }
}

export function claudeCodeCanRegisterDesktop(platform: NodeJS.Platform = process.platform): boolean { return platform === 'darwin' }
