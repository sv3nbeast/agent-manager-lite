import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const maxStateBytes = 16 * 1024 * 1024

function sameFile(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs && expected.mode === actual.mode && expected.nlink === actual.nlink
}

function regularStateFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Claude Code 首次使用状态必须是实例目录内无链接的普通文件')
  if (!Number.isSafeInteger(stat.size) || stat.size > maxStateBytes) throw new Error('Claude Code 首次使用状态文件过大，无法安全初始化')
}

/**
 * Initialize the first-use preference only inside a previously validated,
 * manager-owned CLAUDE_CONFIG_DIR. Official API/Bearer launches otherwise run
 * Anthropic's first-run connectivity check even with a custom API endpoint.
 * This is not authentication: Claude still asks for workspace trust, API-key
 * approval and tool permissions. Existing preferences are never overridden.
 */
export function initializeClaudeCodeOnboarding(configDirectory: string): { initialized: boolean } {
  if (!isAbsolute(configDirectory)) throw new Error('Claude Code 首次使用初始化需要绝对配置目录')
  const directoryStat = lstatSync(configDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(configDirectory) !== configDirectory) throw new Error('Claude Code 首次使用初始化需要稳定的普通配置目录')
  const directoryDescriptor = openSync(configDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const stateFile = join(configDirectory, '.claude.json')
  let stateDescriptor: number | undefined, temporaryDescriptor: number | undefined, temporaryFile: string | undefined
  const checkDirectory = () => {
    const current = lstatSync(configDirectory), opened = fstatSync(directoryDescriptor)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryStat.dev || current.ino !== directoryStat.ino || opened.dev !== directoryStat.dev || opened.ino !== directoryStat.ino || realpathSync(configDirectory) !== configDirectory) throw new Error('Claude Code 配置目录在首次使用初始化期间发生变化')
  }
  try {
    checkDirectory()
    let original: Stats | undefined
    try { original = lstatSync(stateFile) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let value: Record<string, unknown> = {}
    const checkOriginal = () => {
      if (!original || stateDescriptor === undefined) return
      const current = lstatSync(stateFile), opened = fstatSync(stateDescriptor)
      regularStateFile(current); regularStateFile(opened)
      if (!sameFile(original, current) || !sameFile(original, opened)) throw new Error('Claude Code 首次使用状态在初始化期间发生变化')
    }
    if (original) {
      regularStateFile(original)
      stateDescriptor = openSync(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      checkOriginal()
      // Read at most the initial size plus one byte. A concurrent writer may
      // grow the file after fstat; it must not create an unbounded sync read.
      const buffer = Buffer.alloc(original.size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(stateDescriptor, buffer, length, buffer.length - length, length)
        if (!count) break
        length += count
      }
      if (length !== original.size) throw new Error('Claude Code 首次使用状态在初始化期间发生变化')
      try { value = JSON.parse(buffer.subarray(0, length).toString('utf8')) as Record<string, unknown> }
      catch { throw new Error('Claude Code 首次使用状态不是有效 JSON，已保留原文件') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 首次使用状态必须是 JSON 对象，已保留原文件')
      checkOriginal(); checkDirectory()
      if (Object.hasOwn(value, 'hasCompletedOnboarding')) return { initialized: false }
    }
    temporaryFile = join(configDirectory, `.claude.json.aml-${randomUUID()}.tmp`)
    const mode = original ? original.mode & 0o7777 : 0o600
    temporaryDescriptor = openSync(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    fchmodSync(temporaryDescriptor, mode)
    writeFileSync(temporaryDescriptor, JSON.stringify({ ...value, hasCompletedOnboarding: true }, null, 2) + '\n', 'utf8')
    fsyncSync(temporaryDescriptor)
    checkOriginal(); checkDirectory()
    if (original) renameSync(temporaryFile, stateFile)
    else {
      // Publish without replacing a file that appeared after the initial read.
      linkSync(temporaryFile, stateFile)
      unlinkSync(temporaryFile)
    }
    temporaryFile = undefined
    fsyncSync(directoryDescriptor)
    return { initialized: true }
  } finally {
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor)
    if (temporaryFile) { try { unlinkSync(temporaryFile) } catch { /* Preserve the original failure. */ } }
    if (stateDescriptor !== undefined) closeSync(stateDescriptor)
    closeSync(directoryDescriptor)
  }
}
