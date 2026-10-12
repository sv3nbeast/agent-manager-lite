import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { claudeCodeApplicationKindSchema, claudeCodeClientType, type ClaudeCodeApplicationKind } from '../shared/claudeCode'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface ClaudeCodeDesktopApplication {
  clientType: typeof claudeCodeClientType
  applicationKind: 'desktop'
  kind: 'desktop'
  id: string
  name: string
  path: string
  executable: string
  bundleId: string
  version?: string
}

export interface ClaudeCodeDesktopDetectionOptions {
  home?: string
  platform?: NodeJS.Platform
  roots?: string[]
}

function safeFile(path: string): string | undefined {
  try {
    const original = lstatSync(path)
    if (original.isSymbolicLink() || !original.isFile()) return
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) return
    return canonical
  } catch { return }
}

function safeDirectory(path: string): string | undefined {
  try {
    const original = lstatSync(path)
    if (!original.isDirectory() || original.isSymbolicLink()) return
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    return canonical
  } catch { return }
}

/** Read only the small, stable subset of an XML Info.plist that identifies an app. */
function plistValues(path: string): Record<string, string> | undefined {
  try {
    const original = lstatSync(path)
    if (original.isSymbolicLink() || !original.isFile() || realpathSync(path) !== path) return
    const raw = readFileSync(path, 'utf8')
    if (raw.length > 256 * 1024 || !raw.includes('<plist')) return
    const values: Record<string, string> = {}
    const pair = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
    for (let match; (match = pair.exec(raw));) {
      const key = match[1].trim(), value = match[2].trim()
      if (key.length <= 160 && value.length <= 512) values[key] = value
    }
    return values
  } catch { return }
}

function candidateRoots(options: ClaudeCodeDesktopDetectionOptions): string[] {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir()
  if (options.roots) return options.roots
  if (platform === 'darwin') return ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')]
  if (platform === 'win32') return [join(home, 'AppData', 'Local', 'Programs', 'Claude', 'Claude.exe'), join(home, 'AppData', 'Local', 'Claude', 'Claude.exe')]
  return [join(home, '.local', 'share', 'claude', 'Claude'), '/opt/Claude/Claude']
}

function inspectBundle(path: string): ClaudeCodeDesktopApplication | undefined {
  const root = safeDirectory(path)
  if (!root || !root.endsWith('.app')) return
  const infoPath = join(root, 'Contents', 'Info.plist'), info = plistValues(infoPath)
  if (!info || info.CFBundleIdentifier !== 'com.anthropic.claudefordesktop') return
  const executableName = info.CFBundleExecutable || 'Claude', executable = safeFile(join(root, 'Contents', 'MacOS', executableName))
  if (!executable) return
  return {
    clientType: claudeCodeClientType,
    applicationKind: 'desktop',
    kind: 'desktop',
    id: digest(`claude-code-desktop:${root}`),
    name: info.CFBundleDisplayName || info.CFBundleName || basename(root, '.app'),
    path: root,
    executable,
    bundleId: info.CFBundleIdentifier,
    ...(info.CFBundleShortVersionString ? { version: info.CFBundleShortVersionString } : {}),
  }
}

function inspectKnownExecutable(path: string): ClaudeCodeDesktopApplication | undefined {
  const executable = safeFile(path)
  if (!executable || !/(?:^|[\\/])claude(?:\.exe)?$/i.test(executable)) return
  const parent = basename(dirname(executable)).toLowerCase()
  if (!parent.includes('claude')) return
  return {
    clientType: claudeCodeClientType,
    applicationKind: 'desktop',
    kind: 'desktop',
    id: digest(`claude-code-desktop:${executable}`),
    name: 'Claude Desktop',
    path: executable,
    executable,
    bundleId: 'com.anthropic.claudefordesktop',
  }
}

/**
 * Discover the installed Claude Desktop bundle without opening it.  This is
 * intentionally separate from CLI detection: Desktop's Electron profile,
 * Keychain records and Code mode are not controlled by CLAUDE_CONFIG_DIR.
 */
export function detectClaudeCodeDesktopApplications(options: ClaudeCodeDesktopDetectionOptions = {}): ClaudeCodeDesktopApplication[] {
  const found = new Map<string, ClaudeCodeDesktopApplication>()
  for (const candidate of candidateRoots(options)) {
    if (!isAbsolute(candidate)) continue
    const application = candidate.endsWith('.app') ? inspectBundle(candidate) : inspectKnownExecutable(candidate)
    if (application && !found.has(application.path)) found.set(application.path, application)
  }
  return [...found.values()]
}

export interface ClaudeCodeDesktopIsolationBoundary {
  application: ClaudeCodeDesktopApplication
  /** Desktop profile path is not inferred: caller must supply a measured path. */
  profileDirectory?: string
  status: 'pending' | 'verified' | 'blocked'
  reasons: string[]
}

/**
 * Desktop cannot be projected from the CLI adapter.  Until a profile path and
 * system credential ownership are measured, report a fail-closed boundary.
 */
export function inspectClaudeCodeDesktopIsolation(application: ClaudeCodeDesktopApplication, profileDirectory?: string): ClaudeCodeDesktopIsolationBoundary {
  const reasons: string[] = []
  if (!profileDirectory) reasons.push('Claude Desktop 的 Electron profile、Keychain/cookie 和 Code 模式目录尚未测量')
  else if (!isAbsolute(profileDirectory)) reasons.push('Claude Desktop profile 必须是绝对路径')
  else if (!safeDirectory(profileDirectory)) reasons.push('Claude Desktop profile 不是稳定的普通目录')
  else reasons.push('profile 目录已存在，但仍需验证登录、MCP OAuth、插件和会话是否完全归属该目录')
  return { application, profileDirectory, status: reasons.length === 1 && Boolean(profileDirectory) ? 'pending' : 'blocked', reasons }
}

// Keep the application-kind schema exercised by this module so adding a new
// launcher cannot silently bypass the two-application boundary.
export const claudeCodeDesktopApplicationKind: ClaudeCodeApplicationKind = claudeCodeApplicationKindSchema.parse('desktop')
