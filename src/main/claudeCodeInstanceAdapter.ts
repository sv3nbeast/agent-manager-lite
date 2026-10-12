import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { InstanceApplication, InstanceProfile } from '../shared/instances'
import type { Account } from '../shared/types'
import type { DesktopPlan } from './instanceRuntime'
import { accountCompatibility } from '../shared/agentClients'
import { claudeCodeClient, claudeCodeClientType, claudeCodeOwnedEnvironment, type ClaudeCodeOwnedEnvironment } from '../shared/claudeCode'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const execFile = promisify(execFileCallback)

export interface ClaudeCodeApplication {
  clientType: typeof claudeCodeClientType
  id: string
  name: string
  path: string
  kind: 'cli'
  /** Detection is deliberately version agnostic until a signed/runtime probe is verified. */
  version?: string
}

export interface ClaudeDesktopApplication {
  clientType: 'claude_code'
  id: string
  name: string
  path: string
  kind: 'desktop'
  applicationId: 'com.anthropic.claudefordesktop'
  version?: string
  status: 'planned'
  reason: string
}

export interface ClaudeCodeDetectionOptions {
  home?: string
  path?: string
  platform?: NodeJS.Platform
}

function executableFile(path: string): string | undefined {
  try {
    // A candidate may be a package-manager symlink (the official macOS
    // install is one), but the path is canonicalized before it is registered.
    // Never accept a symlink as the stored executable itself.
    const original = lstatSync(path)
    if (original.isSymbolicLink()) return realpathSync(path) === path ? undefined : executableFile(realpathSync(path))
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) return
    return canonical
  } catch { return }
}

/**
 * Discover an installed `claude` CLI without executing a renderer supplied
 * file.  A CLI entry is only a candidate at this stage; registration and
 * version/signature validation belong to the later runtime adapter phase.
 */
export function detectClaudeCodeApplications(options: ClaudeCodeDetectionOptions = {}): ClaudeCodeApplication[] {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir(), pathValue = options.path ?? process.env.PATH ?? ''
  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    ...(platform === 'win32' ? [join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')] : []),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']),
    ...pathValue.split(platform === 'win32' ? ';' : ':').filter(isAbsolute).map(dir => join(dir, platform === 'win32' ? 'claude.cmd' : 'claude')),
  ]
  const found = new Map<string, ClaudeCodeApplication>()
  for (const candidate of candidates) {
    const path = executableFile(candidate)
    if (!path || found.has(path)) continue
    found.set(path, { clientType: claudeCodeClientType, id: digest(`claude-code:${path}`), name: basename(path) === 'claude.cmd' ? 'Claude Code CLI' : 'Claude Code', path, kind: 'cli' })
  }
  return [...found.values()]
}

/** Desktop is reported for diagnostics only until its Electron/VM stores have
 * a verified per-instance user-data and session boundary. */
export function detectClaudeDesktopApplications(options: { platform?: NodeJS.Platform; home?: string } = {}): ClaudeDesktopApplication[] {
  const platform=options.platform??process.platform
  if(platform!=='darwin')return []
  const home=options.home??homedir(),paths=['/Applications/Claude.app',join(home,'Applications/Claude.app')]
  return paths.filter(path=>existsSync(join(path,'Contents','MacOS','Claude'))).map(path=>({
    clientType:claudeCodeClientType,id:digest(`claude-desktop:${path}`),name:'Claude Desktop · Claude Code',path:realpathSync(path),kind:'desktop' as const,
    applicationId:'com.anthropic.claudefordesktop' as const,status:'planned' as const,reason:'Claude Desktop 使用独立 Electron/VM 会话和 OAuth 状态，尚未完成每实例隔离验证'
  }))
}

/** Convert a Claude Code candidate to the common application shape for a future registry. */
export function asInstanceApplication(application: ClaudeCodeApplication): InstanceApplication {
  // The common registry still accepts only implemented client types.  Keep
  // this bridge explicit and local rather than widening that schema early.
  return application as unknown as InstanceApplication
}

export interface ClaudeCodeConfigPaths {
  /** The value passed as CLAUDE_CONFIG_DIR for this instance. */
  configDirectory: string
  settingsFile: string
  credentialsFile: string
  sessionsDirectory: string
  pluginsDirectory: string
  /** `~/.claude.json` is a separate global state file and needs verification. */
  globalStateFile: string
}

export function claudeCodeConfigPaths(configDirectory: string, homeDirectory?: string): ClaudeCodeConfigPaths {
  if (!isAbsolute(configDirectory)) throw new Error('Claude Code 配置目录必须是绝对路径')
  const directory = resolve(configDirectory)
  const home = homeDirectory === undefined ? homedir() : homeDirectory
  if (!isAbsolute(home)) throw new Error('Claude Code home 目录必须是绝对路径')
  return {
    configDirectory: directory,
    settingsFile: join(directory, 'settings.json'),
    credentialsFile: join(directory, '.credentials.json'),
    sessionsDirectory: join(directory, 'projects'),
    pluginsDirectory: join(directory, 'plugins'),
    globalStateFile: join(resolve(home), '.claude.json'),
  }
}

export interface ClaudeCodeProjectionInput {
  /** Manager-owned instance home. The function never creates or writes it. */
  instanceHome: string
  model?: string
  baseUrl?: string
  authToken?: string
  apiKey?: string
}

export interface ClaudeCodeProjection {
  paths: ClaudeCodeConfigPaths
  environment: Record<string, string>
  /** Environment names owned by the projection, useful for a journal. */
  ownedEnvironment: readonly ClaudeCodeOwnedEnvironment[]
  args: readonly string[]
  warnings: string[]
}

export interface ClaudeGlobalStateLock { path: string; instanceHome: string; nonce: string; pid: number }

export interface ClaudeGlobalStateLockOptions { path?: string; pid?: number }

function lockPath(path?: string): string { return path ?? `${homedir()}/.claude.json.agent-manager-lock` }

function validLockNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
}

function validLockPid(value: unknown): value is number {
  // Keep this within the range accepted by node:process.kill on every
  // supported platform.  A malformed pid must never be treated as stale.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff
}

function readExistingGlobalStateLock(path: string): ClaudeGlobalStateLock {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Claude Code 全局状态锁损坏或无法读取，拒绝覆盖')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 全局状态锁格式未知，拒绝覆盖')
  const candidate = value as Partial<ClaudeGlobalStateLock>
  const keys = Object.keys(candidate).sort()
  if (keys.length !== 4 || keys.some((key, index) => key !== ['instanceHome', 'nonce', 'path', 'pid'][index])) {
    throw new Error('Claude Code 全局状态锁格式未知，拒绝覆盖')
  }
  if (candidate.path !== path || typeof candidate.path !== 'string' || !isAbsolute(candidate.path)
    || typeof candidate.instanceHome !== 'string' || !isAbsolute(candidate.instanceHome)
    || resolve(candidate.instanceHome) !== candidate.instanceHome
    || !validLockNonce(candidate.nonce) || !validLockPid(candidate.pid)) {
    throw new Error('Claude Code 全局状态锁格式未知，拒绝覆盖')
  }
  return {
    path,
    instanceHome: candidate.instanceHome,
    nonce: candidate.nonce,
    pid: candidate.pid,
  }
}

/**
 * `~/.claude.json` remains a shared state file even with CLAUDE_CONFIG_DIR.
 * Serialize manager-owned CLI lifetimes around it and fail closed if another
 * owner is active. The lock contains only process/instance metadata.
 */
export function acquireClaudeGlobalStateLock(instanceHome: string, nonce: string, options: ClaudeGlobalStateLockOptions = {}): ClaudeGlobalStateLock {
  if (!isAbsolute(instanceHome) || !validLockNonce(nonce)) throw new Error('Claude Code 全局状态锁参数无效')
  const pid = options.pid ?? process.pid
  if (!validLockPid(pid)) throw new Error('Claude Code 全局状态锁 PID 无效')
  const path = lockPath(options.path)
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Claude Code 全局状态锁路径无效')
  let fd:number|undefined
  try{
    try{fd=openSync(path,'wx',0o600)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      const current = readExistingGlobalStateLock(path)
      try {
        process.kill(current.pid, 0)
        throw new Error('Claude Code 已有实例占用共享全局状态，请先停止后再启动')
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('已有实例')) throw cause
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Claude Code 全局状态锁占用者状态无法确认，拒绝覆盖')
      }
      rmSync(path,{force:true});fd=openSync(path,'wx',0o600)
    }
    const lock={path,instanceHome:resolve(instanceHome),nonce,pid}
    writeFileSync(fd,JSON.stringify(lock)+'\n',{encoding:'utf8'});closeSync(fd);fd=undefined
    return lock
  }finally{if(fd!==undefined)closeSync(fd)}
}

export function releaseClaudeGlobalStateLock(lock: ClaudeGlobalStateLock): void {
  try {
    const value = readExistingGlobalStateLock(lock.path)
    if (value.path === lock.path && value.pid === lock.pid && value.nonce === lock.nonce && value.instanceHome === lock.instanceHome) rmSync(lock.path, { force: true })
  } catch {/* A missing, malformed, or changed-owner lock is preserved. */}
}

type ClaudeCodeAccount = Pick<Account,'kind'|'identityService'|'credentialKind'|'wireApi'|'models'> & { credentials?: { apiKey?: string; accessToken?: string } }

export function claudeCodeAuthEnvironment(account: ClaudeCodeAccount): Pick<ClaudeCodeProjection,'environment'>['environment'] {
  if(account.identityService!=='anthropic')throw new Error('Claude Code 账号必须属于 Anthropic 身份服务')
  if(account.kind==='api_key'){
    const key=account.credentials?.apiKey
    if(typeof key !== 'string' || !key.trim())throw new Error('Claude Code API 账号缺少 API Key')
    if(!['anthropic_api_key','anthropic_bearer','gateway'].includes(account.credentialKind ?? ''))throw new Error('Claude Code API 账号凭据类型未通过 Anthropic 边界验证')
    if(account.credentialKind==='anthropic_bearer')return {ANTHROPIC_AUTH_TOKEN:key}
    return {ANTHROPIC_API_KEY:key}
  }
  const token=account.credentials?.accessToken
  if(account.kind==='oauth'&&account.credentialKind==='claude_ai_oauth'&&typeof token === 'string'&&token.trim())return {CLAUDE_CODE_OAUTH_TOKEN:token}
  throw new Error('Claude Code 账号没有可用的 Anthropic 登录凭据')
}

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  configDirectory: string
}

function safeAuthLabel(value: unknown, kind: 'method' | 'provider'): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (kind === 'method') {
    if (normalized.includes('oauth')) return 'oauth'
    if (normalized.includes('api') || normalized === 'apikey') return 'api_key'
    if (normalized.includes('bearer') || normalized.includes('token')) return 'bearer'
    if (normalized.includes('profile')) return 'profile'
    if (normalized.includes('bedrock') || normalized.includes('vertex') || normalized.includes('foundry')) return 'cloud'
    return undefined
  }
  if (normalized.includes('bedrock')) return 'bedrock'
  if (normalized.includes('vertex')) return 'vertex'
  if (normalized.includes('foundry')) return 'foundry'
  if (normalized.includes('anthropic') || normalized.includes('firstparty') || normalized.includes('first-party')) return 'anthropic'
  return undefined
}

/**
 * Run only Claude's read-only auth status command after the executable and
 * config directory have been validated. The raw output is never returned or
 * persisted because different Claude releases may include account metadata.
 */
export async function readClaudeCodeAuthStatus(input: {
  executable: string
  configDirectory: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<ClaudeCodeAuthStatus> {
  const executable = executableFile(input.executable)
  if (!executable) throw new Error('Claude Code CLI 路径已被替换，请重新选择')
  const paths = claudeCodeConfigPaths(input.configDirectory)
  try {
    const configStat = lstatSync(paths.configDirectory)
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) throw new Error('Claude Code 配置目录不是稳定的普通目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Claude may create a fresh config directory during the status probe.
    } else if (error instanceof Error && error.message.includes('普通目录')) {
      throw error
    } else {
      throw new Error('Claude Code 配置目录无法安全读取')
    }
  }
  const env = claudeCodeEnvironment(input.environment ?? process.env, { environment: { CLAUDE_CONFIG_DIR: paths.configDirectory } })
  let stdout: string
  try {
    ({ stdout } = await execFile(executable, ['auth', 'status', '--json'], { env, timeout: input.timeoutMs ?? 15_000, maxBuffer: 64 * 1024, windowsHide: true }))
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { killed?: boolean }
    if (cause.killed) throw new Error('Claude Code 登录状态检查超时')
    throw new Error('Claude Code 登录状态检查失败')
  }
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new Error('Claude Code 登录状态响应无效') }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (!record || typeof record.loggedIn !== 'boolean') throw new Error('Claude Code 登录状态响应缺少 loggedIn')
  return {
    loggedIn: record.loggedIn,
    authMethod: safeAuthLabel(record.authMethod, 'method'),
    apiProvider: safeAuthLabel(record.apiProvider, 'provider'),
    configDirectory: paths.configDirectory,
  }
}

function assertValue(name: string, value: string | undefined): void {
  if (value !== undefined && (!value.trim() || /[\0\r\n]/.test(value))) throw new Error(`${name} 包含无效字符`)
}

function assertClaudeBaseUrl(value: string | undefined): void {
  if (value === undefined) return
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    throw new Error('Claude Code 网关地址必须是干净的 HTTP(S) 地址')
  }
}

/**
 * Build the non-secret part of an isolated launch projection.  The caller can
 * supply a provider API key/token, but the returned object must never be
 * persisted in the manager vault or logged by a future runtime transaction.
 */
export function projectClaudeCodeConfig(input: ClaudeCodeProjectionInput): ClaudeCodeProjection {
  if (!isAbsolute(input.instanceHome)) throw new Error('Claude Code 实例目录必须是绝对路径')
  assertValue('model', input.model); assertValue('baseUrl', input.baseUrl); assertValue('authToken', input.authToken); assertValue('apiKey', input.apiKey)
  assertClaudeBaseUrl(input.baseUrl)
  if (input.authToken !== undefined && input.apiKey !== undefined) throw new Error('Claude Code 只能选择 API Key 或 Bearer Token 其中一种凭据')
  const paths = claudeCodeConfigPaths(join(input.instanceHome, 'claude'))
  const environment: Record<string, string> = { CLAUDE_CONFIG_DIR: paths.configDirectory }
  if (input.model !== undefined) environment.ANTHROPIC_MODEL = input.model
  if (input.baseUrl !== undefined) environment.ANTHROPIC_BASE_URL = input.baseUrl
  if (input.authToken !== undefined) environment.ANTHROPIC_AUTH_TOKEN = input.authToken
  if (input.apiKey !== undefined) environment.ANTHROPIC_API_KEY = input.apiKey
  return {
    paths, environment, ownedEnvironment: claudeCodeOwnedEnvironment,
    args: [],
    warnings: ['Claude Code 的 ~/.claude.json 仍是共享状态；启动时必须持有管理器全局锁，不能并行启动多个受管 Claude CLI 实例。'],
  }
}

/** Remove inherited Claude/Anthropic routing and credentials before setting instance values. */
export function claudeCodeEnvironment(source: NodeJS.ProcessEnv, projection: Pick<ClaudeCodeProjection, 'environment'>): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const key of claudeCodeOwnedEnvironment) delete environment[key]
  for (const key of Object.keys(environment)) {
    if (/^(?:ANTHROPIC_|CLAUDE_CODE_(?:USE_|OAUTH_|PROVIDER_|API_|PROJECT_|SIMPLE|SAFE_MODE|SUBPROCESS_))/.test(key)) delete environment[key]
  }
  Object.assign(environment, projection.environment)
  return environment
}

/**
 * Keep manager-controlled config and isolation flags out of user supplied
 * arguments. This is a policy helper; it does not launch Claude Code.
 */
export function validateClaudeCodeCliArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (/^(?:--settings(?:=|$)|--config-dir(?:=|$)|--plugin-dir(?:=|$)|--mcp-config(?:=|$)|--strict-mcp-config(?:=|$)|--setting-sources(?:=|$)|--session-id(?:=|$)|--resume(?:=|$)|--continue(?:=|$)|--fork-session(?:=|$)|--worktree(?:=|$)|-w(?:=|$)|--add-dir(?:=|$)|--desktop(?:=|$)|--cloud(?:=|$)|--from-pr(?:=|$))/.test(arg)) throw new Error('Claude Code 参数不能覆盖实例配置、会话、工作目录或启动形态')
    if (arg === '--model' || arg === '-m' || arg.startsWith('--model=') || arg.startsWith('-m=')) {
      if (arg === '--model' || arg === '-m') { index++; if (!args[index]) throw new Error('Claude Code --model 需要值') }
      throw new Error('Claude Code 模型应在实例配置中选择')
    }
  }
}

function applications(stored: readonly InstanceApplication[] = []): InstanceApplication[] {
  const detected = detectClaudeCodeApplications().map(asInstanceApplication)
  const remembered = stored.filter(application => application.clientType === claudeCodeClientType && application.kind === 'cli')
  return [...new Map([...detected, ...remembered].map(application => [application.path, application])).values()]
}

export const claudeCodeInstanceAdapter = {
  client: claudeCodeClient,
  applications,
  registerApplication(path: string, kind: 'desktop'|'cli' = 'cli'): InstanceApplication {
    if(kind!=='cli')throw new Error('Claude Desktop 尚未完成隔离验证，暂不能登记为实例应用')
    const canonical=executableFile(path)
    if(!canonical)throw new Error('请选择可执行的 Claude Code CLI')
    return {clientType:claudeCodeClientType,id:digest(`claude-code:${canonical}`),name:'Claude Code',path:canonical,kind:'cli'}
  },
  executable(application: InstanceApplication): string {
    if(application.clientType!==claudeCodeClientType||application.kind!=='cli')throw new Error('所选程序不是 Claude Code CLI')
    const canonical=executableFile(application.path)
    if(!canonical||canonical!==application.path)throw new Error('Claude Code CLI 路径已被替换，请重新选择')
    return canonical
  },
  launchRuntime(application: InstanceApplication) { return { executable: claudeCodeInstanceAdapter.executable(application) } },
  validateApplication(profile: Pick<InstanceProfile,'clientType'|'extraArgs'|'workingDirectoryId'>, application: InstanceApplication): void {
    if(profile.clientType!==claudeCodeClientType||application.clientType!==claudeCodeClientType)throw new Error('实例客户端与所选程序不兼容')
    if(application.kind!=='cli')throw new Error('Claude Desktop 尚未完成隔离验证，请使用 Claude Code CLI')
    validateClaudeCodeCliArgs(profile.extraArgs)
  },
  validateAccount(profile: Pick<InstanceProfile,'clientType'|'connectionMode'|'model'>, account: ClaudeCodeAccount): void {
    const result=accountCompatibility(profile.clientType,account,{connectionMode:profile.connectionMode??'local_api',model:profile.model})
    if(!result.compatible)throw new Error(result.reason)
    claudeCodeAuthEnvironment(account)
  },
  copiedSessionProvider() { throw new Error('Claude Code 会话格式尚未与 Codex 兼容，暂不能复制或转换会话') },
  desktopEnvironment(source: NodeJS.ProcessEnv, projection: Pick<ClaudeCodeProjection,'environment'>): NodeJS.ProcessEnv { return claudeCodeEnvironment(source,projection) },
  macLaunchArgs(plan: DesktopPlan, args: readonly string[] = plan.args): string[] { validateClaudeCodeCliArgs(args); return [...args] },
  configPaths: claudeCodeConfigPaths,
  projectConfig: projectClaudeCodeConfig,
  environment: claudeCodeEnvironment,
  validateCliArgs: validateClaudeCodeCliArgs,
}
