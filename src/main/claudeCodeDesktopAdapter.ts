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
    if (original.isSymbolicLink() || !original.isFile() || original.size > 256 * 1024 || realpathSync(path) !== path) return
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
  const executableName = info.CFBundleExecutable || 'Claude'
  if (!executableName || /[\\/\u0000-\u001f\u007f]/.test(executableName) || executableName === '.' || executableName === '..') return
  const executablePath = join(root, 'Contents', 'MacOS', executableName), executable = safeFile(executablePath)
  if (!executable || executable !== executablePath) return
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
  canCreateInstance: false
  checks: ClaudeCodeDesktopBoundaryCheck[]
}

export interface ClaudeCodeDesktopBoundaryCheck {
  id: 'profile' | 'login' | 'configuration' | 'credentials' | 'sessions' | 'lifecycle'
  status: 'pending' | 'blocked'
  title: string
  detail: string
  documentationUrl?: string
}

/**
 * Desktop cannot be projected from the CLI adapter.  Until a profile path and
 * system credential ownership are measured, report a fail-closed boundary.
 */
export function inspectClaudeCodeDesktopIsolation(application: ClaudeCodeDesktopApplication, profileDirectory?: string): ClaudeCodeDesktopIsolationBoundary {
  let profileStatus: 'pending' | 'blocked' = 'blocked'
  let profileReason: string
  if (!profileDirectory) profileReason = '尚未指定独立的 Claude Desktop 数据目录；仅检测到应用不能证明多实例隔离。'
  else if (!isAbsolute(profileDirectory)) profileReason = 'Claude Desktop 数据目录必须是绝对路径。'
  else if (!safeDirectory(profileDirectory)) profileReason = 'Claude Desktop 数据目录必须是已存在的普通目录，不能使用文件或符号链接。'
  else {
    profileStatus = 'pending'
    profileReason = '目录已存在；仍需确认当前安装版本实际使用该目录。启动参数或环境变量不能替代运行验收。'
  }
  const desktopDocs = 'https://code.claude.com/docs/en/desktop'
  const checks: ClaudeCodeDesktopBoundaryCheck[] = [
    { id: 'profile', status: profileStatus, title: '独立数据目录', detail: profileReason },
    { id: 'login', status: 'pending', title: '登录方式', detail: '订阅登录与第三方推理配置需分别验收。CLI 的 --desktop 入口要求受支持的订阅登录，不能用它验证 API 连接。', documentationUrl: `${desktopDocs}#coming-from-the-cli` },
    { id: 'configuration', status: 'pending', title: '配置与 API 连接', detail: 'Desktop 网关使用独立的第三方推理配置。ANTHROPIC_BASE_URL 和 CLI settings.json 不能替代该配置，且组织配置可能优先于本地配置。', documentationUrl: 'https://code.claude.com/docs/en/llm-gateway-connect#desktop-app' },
    { id: 'credentials', status: 'pending', title: '登录凭据隔离', detail: '尚未验证系统凭据、Cookie、MCP OAuth 和插件授权是否归属独立实例；不复制已有登录目录。' },
    { id: 'sessions', status: 'pending', title: '配置与会话边界', detail: 'Desktop 与 CLI 会共享用户和项目配置；Desktop 还读取自己的 MCP 配置，并可继续同一条 CLI 会话。独立窗口不代表账号、配置或会话隔离。', documentationUrl: `${desktopDocs}#shared-configuration` },
    { id: 'lifecycle', status: 'pending', title: '启动与恢复', detail: '尚未验证独立进程归属、管理器退出后的存活、停止及恢复；Desktop 暂不开放创建实例。' },
  ]
  return { application, profileDirectory, status: profileStatus, canCreateInstance: false, reasons: checks.map(check => check.detail), checks }
}

// Keep the application-kind schema exercised by this module so adding a new
// launcher cannot silently bypass the two-application boundary.
export const claudeCodeDesktopApplicationKind: ClaudeCodeApplicationKind = claudeCodeApplicationKindSchema.parse('desktop')
