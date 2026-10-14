import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { claudeCodeApplicationKindSchema, claudeCodeClientType, type ClaudeCodeApplicationKind } from '../shared/claudeCode'
import type { DesktopPlan } from './instanceRuntime'
import { applyNetworkRouteEnvironment, managedDesktopNetworkArgs, type InstanceNetworkRoute } from './desktopNetwork'

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

/**
 * Flags whose values identify a Chromium/Electron profile or a manager-owned
 * process.  An instance must own both values.  Allowing a user supplied copy
 * of either flag would make a second instance attach to another instance's
 * profile or make lifecycle recovery signal the wrong process.
 */
const managedLaunchFlag = /^--?(?:user-data-dir|cml-instance|remote-debugging[^\s=]*|profile-directory)(?:=|$)/i

/**
 * Keep the renderer supplied argument surface deliberately tiny.  These are
 * the only flags used by our macOS startup probe; extension,
 * preload, JavaScript, sandbox and remote-debugging switches stay unavailable
 * until each one has its own isolation evidence.
 */
const verifiedDiagnosticFlags = new Set(['--disable-gpu'])

function safePathValue(name: string, value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) {
    throw new Error(`Claude Desktop ${name} 必须是规范化的绝对路径`)
  }
  return value
}

function safeFile(path: string, rejectParentSymlink = true): string | undefined {
  try {
    const original = lstatSync(path)
    if (original.isSymbolicLink() || !original.isFile()) return
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    if ((rejectParentSymlink && canonical !== path) || !stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) return
    return canonical
  } catch { return }
}

function safeDirectory(path: string, rejectParentSymlink = true): string | undefined {
  try {
    const original = lstatSync(path)
    if (!original.isDirectory() || original.isSymbolicLink()) return
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    // A canonical mismatch means the directory itself or one of its parents
    // is a symlink.  Rejecting both cases prevents an instance profile from
    // being redirected after its path was registered.
    if ((rejectParentSymlink && canonical !== path) || !stat.isDirectory() || stat.isSymbolicLink()) return
    return canonical
  } catch { return }
}

/**
 * Validate a manager-owned Electron profile directory before it is placed in
 * an application argument.  The directory must already exist so a missing or
 * replaced instance folder cannot be silently recreated outside the manager
 * root by an upstream Electron version.
 */
export function validateClaudeCodeDesktopProfileDirectory(profileDirectory: string): string {
  const path = safePathValue('profile 目录', profileDirectory)
  if (!safeDirectory(path)) throw new Error('Claude Desktop profile 必须是已存在的普通目录，不能使用文件或符号链接')
  return path
}

/**
 * Derive the profile location used by a managed instance.  Keeping this in
 * the adapter makes it harder for a caller to accidentally reuse the CLI
 * `CLAUDE_CONFIG_DIR` or the user's global Claude Desktop directory.
 */
export function claudeCodeDesktopProfileDirectory(instanceDirectory: string): string {
  const root = safePathValue('实例目录', instanceDirectory)
  return join(root, 'desktop')
}

/** A stable marker used to associate an Electron process with one instance. */
export function claudeCodeDesktopInstanceMarker(nonce: string): string {
  if (typeof nonce !== 'string' || !nonce || /[\0\r\n\s]/.test(nonce) || nonce.length > 256) {
    throw new Error('Claude Desktop 实例标识无效')
  }
  return `--cml-instance=${nonce}`
}

/**
 * Only explicitly verified diagnostic flags reach Desktop. Unknown upstream
 * options fail closed, including options that can load code or disable the
 * sandbox without changing either profile argument.
 */
export function validateClaudeCodeDesktopArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length > 50) throw new Error('Claude Desktop 参数数量无效')
  for (const arg of args) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) throw new Error('Claude Desktop 参数包含无效字符')
    if (!verifiedDiagnosticFlags.has(arg)) throw new Error('Claude Desktop 仅允许已验证的诊断参数，不能覆盖受管隔离设置、加载扩展或运行脚本')
  }
}

/**
 * Desktop is an Electron application, not a Claude Code CLI process.  Remove
 * inherited Claude/Anthropic credentials and Electron/Node hooks before
 * applying the manager's optional credential-free network route.
 */
export function claudeCodeDesktopEnvironment(source: NodeJS.ProcessEnv, route?: InstanceNetworkRoute): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const key of Object.keys(environment)) {
    if (/^(?:CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_|CML_|ELECTRON_|NODE_|npm_config_)/.test(key)
      || ['__CFBundleIdentifier', 'XPC_SERVICE_NAME'].includes(key)) delete environment[key]
  }
  return applyNetworkRouteEnvironment(environment, route)
}

/**
 * Build the macOS LaunchServices command for a Desktop instance.  The
 * profile and marker are always manager-owned and appear after `--args`, so
 * LaunchServices does not confuse them with its own options.
 */
export function claudeCodeDesktopMacLaunchArgs(plan: Pick<DesktopPlan, 'clientType' | 'application' | 'desktopDirectory' | 'nonce' | 'args' | 'networkRoute'>, args: readonly string[] = plan.args): string[] {
  if (plan.clientType !== claudeCodeClientType) throw new Error('所选程序不是 Claude Desktop')
  const application = safePathValue('应用', plan.application)
  const profile = validateClaudeCodeDesktopProfileDirectory(plan.desktopDirectory)
  const marker = claudeCodeDesktopInstanceMarker(plan.nonce)
  validateClaudeCodeDesktopArgs(args)
  const routed = managedDesktopNetworkArgs(args, plan.networkRoute)
  return ['-n', '-a', application, '--args', `--user-data-dir=${profile}`, marker, ...routed]
}

export interface ClaudeCodeDesktopProcessOwnership {
  executable: string
  args: readonly string[]
}

/**
 * Check the two independent ownership claims used during recovery: exact
 * executable and exact profile/nonce arguments.  A marker alone is not enough
 * because a stale process can retain it after its profile has been replaced.
 */
export function isClaudeCodeDesktopProcessOwned(plan: Pick<DesktopPlan, 'clientType' | 'executable' | 'desktopDirectory' | 'nonce'>, process: ClaudeCodeDesktopProcessOwnership): boolean {
  if (plan.clientType !== claudeCodeClientType || process.executable !== plan.executable) return false
  const profile = validateClaudeCodeDesktopProfileDirectory(plan.desktopDirectory)
  const marker = claudeCodeDesktopInstanceMarker(plan.nonce)
  const args = [...process.args]
  const profileArg = `--user-data-dir=${profile}`
  const profileClaims = args.filter(arg => /^--?user-data-dir(?:=|$)/i.test(arg))
  const markerClaims = args.filter(arg => /^--?cml-instance(?:=|$)/i.test(arg))
  // Require exactly one claim of each kind and reject every alternate
  // spelling/value.  This avoids signalling an ambiguous process when an
  // Electron wrapper duplicated or rewrote command-line arguments.
  if (profileClaims.length !== 1 || profileClaims[0] !== profileArg) return false
  if (markerClaims.length !== 1 || markerClaims[0] !== marker) return false
  if (args.some(arg => managedLaunchFlag.test(arg) && arg !== profileArg && arg !== marker)) return false
  if (args.includes('--')) return false
  return true
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
  // Detection canonicalizes the app path so system aliases such as macOS's
  // /var -> /private/var do not make a valid installed bundle disappear.
  // Profile paths remain strict through validateClaudeCodeDesktopProfileDirectory;
  // this read-only discovery step never registers or launches the bundle.
  const root = safeDirectory(path, false)
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
  // As with bundle discovery, canonicalize benign platform aliases while
  // keeping instance profile validation strict.  The returned executable is
  // always the real regular file, never a symlink.
  const executable = safeFile(path, false)
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
