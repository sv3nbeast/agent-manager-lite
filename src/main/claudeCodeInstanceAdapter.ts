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
import { detectClaudeCodeDesktopApplications, claudeCodeDesktopMacLaunchArgs, validateClaudeCodeDesktopArgs } from './claudeCodeDesktopAdapter'
import { assertClaudeSubscriptionDestination } from './claudeCodeSubscription'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const execFile = promisify(execFileCallback)

export interface ClaudeCodeApplication {
  clientType: typeof claudeCodeClientType
  id: string
  name: string
  path: string
  /** Stable official launcher path; its native version is revalidated on every launch. */
  installationPath?: string
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
  status: 'implemented'
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
    found.set(path, { clientType: claudeCodeClientType, id: digest(`claude-code:${candidate}`), installationPath: candidate, name: basename(path) === 'claude.cmd' ? 'Claude Code CLI' : 'Claude Code', path, kind: 'cli' })
  }
  return [...found.values()]
}

/** Compatibility discovery entry point; use the same validated bundle detector. */
export function detectClaudeDesktopApplications(options: { platform?: NodeJS.Platform; home?: string } = {}): ClaudeDesktopApplication[] {
  const platform=options.platform??process.platform
  if(platform!=='darwin')return []
  return detectClaudeCodeDesktopApplications(options).map(application=>({
    ...application,applicationId:'com.anthropic.claudefordesktop' as const,status:'implemented' as const,
    reason:'使用独立桌面配置与 HOME，在 Claude Desktop 内登录；CLI 凭据不作为桌面登录'
  }))
}

/** Convert a Claude Code candidate to the common application shape for a future registry. */
export function asInstanceApplication(application: ClaudeCodeApplication): InstanceApplication {
  return application
}

export interface ClaudeCodeConfigPaths {
  /** The value passed as CLAUDE_CONFIG_DIR for this instance. */
  configDirectory: string
  settingsFile: string
  credentialsFile: string
  sessionsDirectory: string
  pluginsDirectory: string
  /** Current CLI owns this state inside CLAUDE_CONFIG_DIR; Desktop is a separate boundary. */
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
    globalStateFile: join(directory, '.claude.json'),
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
 * Legacy explicit shared-state lock, retained for callers managing a shared
 * resource. Current managed CLI instances do not acquire it: real acceptance
 * verifies that CLAUDE_CONFIG_DIR also owns .claude.json.
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

type ClaudeCodeAccount = Pick<Account,'kind'|'identityService'|'credentialKind'|'wireApi'|'models'|'protocol'> & { baseUrl?: string; credentials?: { apiKey?: string; accessToken?: string; refreshToken?: string } }

export function claudeCodeAuthEnvironment(account: ClaudeCodeAccount): Pick<ClaudeCodeProjection,'environment'>['environment'] {
  if(account.identityService!=='anthropic')throw new Error('Claude Code 账号必须属于 Anthropic 身份服务')
  if(account.protocol!=='anthropic_messages')throw new Error('Claude Code 需要 Anthropic Messages 协议')
  if(account.kind==='api_key'){
    const key=account.credentials?.apiKey
    if(typeof key !== 'string' || !key.trim() || /[\0\r\n]/.test(key))throw new Error('Claude Code API 账号缺少 API Key')
    if(!['anthropic_api_key','anthropic_bearer','gateway'].includes(account.credentialKind ?? ''))throw new Error('Claude Code API 账号凭据类型未通过 Anthropic 边界验证')
    if(account.credentialKind==='anthropic_bearer')return {ANTHROPIC_AUTH_TOKEN:key}
    return {ANTHROPIC_API_KEY:key}
  }
  const token=account.credentials?.accessToken
  if(account.kind==='oauth'&&account.credentialKind==='claude_ai_oauth'&&typeof token === 'string'&&token.trim()&&!/[\0\r\n]/.test(token))return {CLAUDE_CODE_OAUTH_TOKEN:token}
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
    if (normalized === 'oauth_token') return undefined
    if (normalized.includes('oauth') || normalized === 'claude.ai') return 'oauth'
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
    const cause = error as { killed?: boolean; code?: string | number; stdout?: string }
    if (cause.killed) throw new Error('Claude Code 登录状态检查超时')
    // Claude uses exit 1 for a valid logged-out status response.
    if(cause.code===1&&typeof cause.stdout==='string')stdout=cause.stdout
    else throw new Error('Claude Code 登录状态检查失败')
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
    warnings: [],
  }
}

/** Remove inherited Claude/Anthropic routing and credentials before setting instance values. */
export function claudeCodeEnvironment(source: NodeJS.ProcessEnv, projection: Pick<ClaudeCodeProjection, 'environment'>): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const key of claudeCodeOwnedEnvironment) delete environment[key]
  delete environment.USE_LOCAL_OAUTH; delete environment.USE_STAGING_OAUTH
  for (const key of Object.keys(environment)) {
    if (/^(?:ANTHROPIC_|CLAUDE_SECURESTORAGE_|CLAUDE_CODE_(?:USE_|OAUTH_|PROVIDER_|API_|PROJECT_|HOST_|SUBSCRIPTION_|RATE_LIMIT_|SIMPLE|SAFE_MODE|SUBPROCESS_))/.test(key)) delete environment[key]
  }
  Object.assign(environment, projection.environment)
  return environment
}

// Only foreground options whose ownership has been checked belong here.
// Unknown options fail closed so a CLI update cannot silently add a remote,
// background, credential or configuration mode to a managed instance.
const foregroundFlags=new Set(['--print','-p','--verbose','--help','-h','--version','-v','--include-partial-messages','--replay-user-messages','--no-session-persistence','--dangerously-skip-permissions','--allow-dangerously-skip-permissions'])
const foregroundValues=new Set(['--output-format','--input-format','--permission-mode','--system-prompt','--append-system-prompt','--max-turns','--max-budget-usd','--json-schema','--effort','--allowedTools','--allowed-tools','--disallowedTools','--disallowed-tools','--tools'])
const managedCommands=new Set(['auth','login','logout','setup-token','install','update','upgrade','mcp','remote-control','config','desktop','web','doctor','plugin','plugins','serve','gateway','purge','agents','attach','respawn','auto-mode','import','logs','rm','stop','kill','ultrareview'])

/** Validate options and the optional prompt without mistaking option values for commands. */
export function validateClaudeCodeCliArgs(args: readonly string[], advertisedCommands: readonly string[]=[]): void {
  let prompt=false,endOfOptions=false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if(typeof arg!=='string'||/[\0\r\n]/.test(arg))throw new Error('Claude Code 参数包含无效字符')
    if(!endOfOptions&&arg==='--'){endOfOptions=true;continue}
    if(!endOfOptions&&arg.startsWith('-')){
      const separator=arg.indexOf('='),name=separator<0?arg:arg.slice(0,separator)
      if(foregroundFlags.has(name)&&separator<0)continue
      if(foregroundValues.has(name)){
        const value=separator<0?args[++index]:arg.slice(separator+1)
        if(typeof value!=='string'||!value.trim()||/[\0\r\n]/.test(value)||(separator<0&&value.startsWith('-')))throw new Error(`Claude Code ${name} 参数需要有效值`)
        continue
      }
      throw new Error('Claude Code 参数未通过前台实例边界验证；模型、配置、会话及启动方式请使用实例设置')
    }
    if(managedCommands.has(arg)||advertisedCommands.includes(arg))throw new Error('受管 Claude 实例不能执行登录、更新或管理子命令，请直接启动会话')
    if(prompt||!arg.trim())throw new Error('Claude Code 参数只允许一个完整提示词；包含空格时请整体引用')
    prompt=true
  }
}

function applications(stored: readonly InstanceApplication[] = []): InstanceApplication[] {
  const detected = detectClaudeCodeApplications().map(asInstanceApplication)
  const desktop = process.platform==='darwin'?detectClaudeCodeDesktopApplications().map(application=>({clientType:claudeCodeClientType,id:application.id,name:'Claude Desktop',path:application.path,kind:'desktop' as const})):[]
  const remembered = stored.filter(application => application.clientType === claudeCodeClientType).map(application=>{
    if(application.kind==='desktop')return application
    const path=application.installationPath?executableFile(application.installationPath):undefined
    return path?{...application,path}:application
  })
  return [...new Map([...remembered, ...detected, ...desktop].map(application => [application.id, application])).values()]
}

export const claudeCodeInstanceAdapter = {
  client: claudeCodeClient,
  applications,
  registerApplication(path: string, kind: 'desktop'|'cli' = 'cli'): InstanceApplication {
    if(kind==='desktop'){
      if(process.platform!=='darwin')throw new Error('Claude Desktop 实例当前支持 macOS')
      const application=detectClaudeCodeDesktopApplications({roots:[path],platform:'darwin'})[0]
      if(!application)throw new Error('请选择已安装的 Claude.app')
      return {clientType:claudeCodeClientType,id:application.id,name:'Claude Desktop',path:application.path,kind:'desktop'}
    }
    const canonical=executableFile(path)
    if(!canonical)throw new Error('请选择可执行的 Claude Code CLI')
    return {clientType:claudeCodeClientType,id:digest(`claude-code:${resolve(path)}`),name:'Claude Code',path:canonical,installationPath:resolve(path),kind:'cli'}
  },
  executable(application: InstanceApplication): string {
    if(application.clientType!==claudeCodeClientType)throw new Error('所选程序不是 Claude 客户端')
    if(application.kind==='desktop'){
      const found=detectClaudeCodeDesktopApplications({roots:[application.path],platform:'darwin'})[0]
      if(!found||found.path!==application.path)throw new Error('Claude Desktop 路径已被替换，请重新选择')
      return found.executable
    }
    if(application.kind!=='cli')throw new Error('所选程序不是 Claude Code CLI')
    const canonical=executableFile(application.path)
    if(!canonical||canonical!==application.path)throw new Error('Claude Code CLI 路径已被替换，请重新选择')
    return canonical
  },
  launchRuntime(application: InstanceApplication) { return { executable: claudeCodeInstanceAdapter.executable(application) } },
  validateApplication(profile: Pick<InstanceProfile,'clientType'|'extraArgs'|'workingDirectoryId'> & Partial<Pick<InstanceProfile,'connectionMode'>>, application: InstanceApplication): void {
    if(profile.clientType!==claudeCodeClientType||application.clientType!==claudeCodeClientType)throw new Error('实例客户端与所选程序不兼容')
    if(application.kind==='desktop'){
      if(process.platform!=='darwin')throw new Error('Claude Desktop 实例当前支持 macOS')
      if(profile.connectionMode!=='client_login'&&profile.connectionMode!=='native')throw new Error('Claude Desktop 请选择客户端内登录或原生 API 连接')
      if(profile.workingDirectoryId)throw new Error('Claude Desktop 项目请在客户端内选择')
      validateClaudeCodeDesktopArgs(profile.extraArgs)
      return
    }
    if(profile.connectionMode==='client_login')throw new Error('客户端内登录仅用于 Claude Desktop')
    validateClaudeCodeCliArgs(profile.extraArgs)
  },
  validateAccount(profile: Pick<InstanceProfile,'clientType'|'connectionMode'|'model'> & Partial<Pick<InstanceProfile,'launchMode'>>, account: ClaudeCodeAccount): void {
    const result=accountCompatibility(profile.clientType,account,{connectionMode:profile.connectionMode??'local_api',model:profile.model,launchMode:profile.launchMode})
    if(!result.compatible)throw new Error(result.reason)
    if(account.kind==='oauth'){
      assertClaudeSubscriptionDestination({baseUrl:account.baseUrl??''})
      const {accessToken,refreshToken}=account.credentials??{}
      if([accessToken,refreshToken].some(token=>typeof token==='string'&&token.trim()&&!/[\0\r\n]/.test(token)))return
    }
    claudeCodeAuthEnvironment(account)
  },
  copiedSessionProvider() { throw new Error('Claude Code 会话格式尚未与 Codex 兼容，暂不能复制或转换会话') },
  desktopEnvironment(source: NodeJS.ProcessEnv, projection: Pick<ClaudeCodeProjection,'environment'>): NodeJS.ProcessEnv { return claudeCodeEnvironment(source,projection) },
  macLaunchArgs(plan: DesktopPlan, args: readonly string[] = plan.args): string[] { return claudeCodeDesktopMacLaunchArgs(plan,args) },
  configPaths: claudeCodeConfigPaths,
  projectConfig: projectClaudeCodeConfig,
  environment: claudeCodeEnvironment,
  validateCliArgs: validateClaudeCodeCliArgs,
}
