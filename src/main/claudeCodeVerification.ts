import { execFile as execFileCallback } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, sep } from 'node:path'
import { claudeCodeClientType, claudeCodeDesktopAcceptance, type ClaudeCodeApplicationKind, type ClaudeCodeAcceptance } from '../shared/claudeCode'
import { claudeCodeConfigPaths, detectClaudeCodeApplications, type ClaudeCodeApplication, type ClaudeCodeConfigPaths } from './claudeCodeInstanceAdapter'
import { detectClaudeCodeDesktopApplications, type ClaudeCodeDesktopApplication } from './claudeCodeDesktopAdapter'

const execFile = promisify(execFileCallback)
const MAX_SESSION_FILES = 10000
const MAX_VERSION_OUTPUT = 32 * 1024

export type ClaudeCodeVerificationState = 'verified' | 'pending' | 'blocked'

export interface ClaudeCodeVersionProbe {
  state: ClaudeCodeVerificationState
  version?: string
  reason?: string
}

export interface ClaudeCodeCliCapabilities {
  state: ClaudeCodeVerificationState
  flags: Record<'print' | 'model' | 'resume' | 'sessionId' | 'settings' | 'addDir' | 'settingSources' | 'strictMcpConfig' | 'mcpConfig', boolean>
  advertisedCommands?: string[]
  reason?: string
}

export interface ClaudeCodeSessionKey {
  clientType: typeof claudeCodeClientType
  applicationKind: 'cli'
  configDirectory: string
  sessionId: string
  sourceFile: string
}

export interface ClaudeCodeSessionBoundary {
  state: ClaudeCodeVerificationState
  directory: string
  files: ClaudeCodeSessionKey[]
  duplicateIds: string[]
  reason?: string
}

export interface ClaudeCodeLoginBoundary {
  state: ClaudeCodeVerificationState
  credentialFile: string
  configuredSources: string[]
  conflictingSources: string[]
  reason?: string
}

export interface ClaudeCodeLoginProbe {
  state: ClaudeCodeVerificationState
  authenticated?: boolean
  method?: 'oauth' | 'api_key' | 'bearer' | 'profile' | 'cloud' | 'unknown'
  reason?: string
}

export interface ClaudeCodeVerificationReport {
  clientType: typeof claudeCodeClientType
  applicationKind: ClaudeCodeApplicationKind
  application: ClaudeCodeApplication | ClaudeCodeDesktopApplication
  gates: ClaudeCodeAcceptance
  version: ClaudeCodeVersionProbe
  cliCapabilities?: ClaudeCodeCliCapabilities
  config?: ClaudeCodeConfigPaths
  login?: ClaudeCodeLoginBoundary
  loginProbe?: ClaudeCodeLoginProbe
  sessions?: ClaudeCodeSessionBoundary
  reasons: string[]
  /** Registration support does not establish live authentication. */
  canRegister: boolean
}

function stableExecutable(path: string): boolean {
  try {
    const canonical = realpathSync(path), stat = lstatSync(canonical)
    return canonical === path && stat.isFile() && !stat.isSymbolicLink() && Boolean(stat.mode & 0o111)
  } catch { return false }
}

function parseVersion(value: string): string | undefined {
  const match = value.match(/\b(\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)\b/)
  return match?.[1]
}

/** Execute only an already-selected, canonical Claude CLI for --version. */
export async function probeClaudeCodeCliVersion(executable: string, options: { timeoutMs?: number; runner?: (executable: string) => Promise<string> } = {}): Promise<ClaudeCodeVersionProbe> {
  if (!stableExecutable(executable)) return { state: 'blocked', reason: 'Claude Code CLI 路径不是稳定的普通可执行文件' }
  try {
    const output = options.runner
      ? await options.runner(executable)
      : await (async () => {
        const result = await execFile(executable, ['--version'], {
        timeout: Math.min(Math.max(options.timeoutMs ?? 5000, 250), 30_000),
        maxBuffer: MAX_VERSION_OUTPUT,
        // Do not allow shell credentials or provider routing to participate in
        // an installation probe.  Version detection must be side-effect free.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        windowsHide: true,
        })
        return result.stdout + result.stderr
      })()
    const version = parseVersion(output)
    // Never return the command output. A broken or replaced binary could put a
    // token in its banner; diagnostics only need the parsed version.
    return version ? { state: 'verified', version } : { state: 'pending', reason: 'CLI 未返回可识别的版本号' }
  } catch (error) {
    void error
    return { state: 'blocked', reason: 'Claude Code CLI 版本探针失败' }
  }
}

async function runCliHelp(executable: string, timeoutMs: number): Promise<string> {
  const result = await execFile(executable, ['--help'], {
    timeout: Math.min(Math.max(timeoutMs, 250), 30_000),
    maxBuffer: MAX_VERSION_OUTPUT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    windowsHide: true,
  })
  // A flag banner printed before an error or timeout cannot certify a usable
  // binary. Let the capability probe return a sanitized blocked state.
  return result.stdout + result.stderr
}

function parseAdvertisedCommands(help: string): string[] | undefined {
  // Keep only command/alias identifiers from the dedicated table. Wrapped
  // descriptions, option rows and later sections must never become commands.
  const lines = help.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  const start = lines.findIndex(line => /^Commands:\s*$/i.test(line))
  if (start < 0) return undefined
  const commands = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = line.match(/^ {2}([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)(?=\s|$)/)
    if (!match) continue
    const names = match[1].split('|')
    if (names.some(name => name.length > 64)) continue
    for (const name of names) commands.add(name)
  }
  return [...commands]
}

/**
 * Capability probe deliberately checks stable CLI contracts instead of a
 * version allow-list.  A compatible release can therefore pass unchanged;
 * an incompatible release is blocked before it can write an instance home.
 */
export async function probeClaudeCodeCliCapabilities(executable: string, options: { timeoutMs?: number; runner?: (executable: string) => Promise<string> } = {}): Promise<ClaudeCodeCliCapabilities> {
  const missing = { print: false, model: false, resume: false, sessionId: false, settings: false, addDir: false, settingSources: false, strictMcpConfig: false, mcpConfig: false }
  if (!stableExecutable(executable)) return { state: 'blocked', flags: missing, reason: 'Claude Code CLI 路径不是稳定的普通可执行文件' }
  let output: string
  try { output = options.runner ? await options.runner(executable) : await runCliHelp(executable, options.timeoutMs ?? 5000) }
  catch { return { state: 'blocked', flags: missing, reason: 'Claude Code CLI 能力探针失败' } }
  const has = (flag: string) => new RegExp(`(?:^|[\\s,])${flag.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:[=\\s,]|$)`, 'm').test(output)
  const flags = { print: has('--print'), model: has('--model'), resume: has('--resume'), sessionId: has('--session-id'), settings: has('--settings'), addDir: has('--add-dir'), settingSources: has('--setting-sources'), strictMcpConfig: has('--strict-mcp-config'), mcpConfig: has('--mcp-config') }
  const advertisedCommands = parseAdvertisedCommands(output)
  const commandFields = advertisedCommands === undefined ? {} : { advertisedCommands }
  const required = Object.entries(flags).filter(([, value]) => !value).map(([key]) => key)
  return required.length ? { state: 'blocked', flags, ...commandFields, reason: `Claude Code CLI 缺少受管参数：${required.join(', ')}` } : { state: 'verified', flags, ...commandFields }
}

/**
 * Verify the selected config directory's login state using Claude's own
 * `auth status --json` command.  The JSON body is reduced to two safe fields;
 * tokens, email addresses and provider metadata never leave this function.
 */
export async function probeClaudeCodeLoginStatus(executable: string, configDirectory: string, options: { timeoutMs?: number; environment?: NodeJS.ProcessEnv; runner?: (executable: string, configDirectory: string) => Promise<string> } = {}): Promise<ClaudeCodeLoginProbe> {
  if (!stableExecutable(executable)) return { state: 'blocked', reason: 'Claude Code CLI 路径不是稳定的普通可执行文件' }
  if (!isAbsolute(configDirectory)) return { state: 'blocked', reason: 'Claude Code 登录探针需要绝对配置目录' }
  try {
    // Deliberately copy only explicitly supplied authentication variables;
    // the manager's own shell must never choose this instance's identity.
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: options.environment?.HOME ?? process.env.HOME ?? '', CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' }
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      if (options.environment?.[name]) environment[name] = options.environment[name]
    }
    const boundary = inspectClaudeCodeLoginBoundary(claudeCodeConfigPaths(configDirectory), environment)
    if (boundary.state === 'blocked') return { state: 'blocked', reason: boundary.reason }
    if (!options.runner) {
      try {
        const stat = lstatSync(configDirectory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'blocked', reason: 'Claude Code 登录探针需要稳定的普通配置目录' }
      } catch {
        return { state: 'pending', authenticated: false, reason: 'Claude Code 配置目录尚未创建' }
      }
    }
    const output = options.runner
      ? await options.runner(executable, configDirectory)
      : await execFile(executable, ['auth', 'status', '--json'], {
        timeout: Math.min(Math.max(options.timeoutMs ?? 5000, 250), 30_000),
        maxBuffer: MAX_VERSION_OUTPUT,
        env: environment,
        windowsHide: true,
      }).then(result => result.stdout, error => {
        // The official CLI returns exit 1 for a valid logged-out result.
        // Treat only that well-formed response as a login state, never an
        // arbitrary failed command's output as successful authentication.
        const failure = error as { code?: unknown; stdout?: unknown }
        if (failure.code === 1 && typeof failure.stdout === 'string') {
          const value = JSON.parse(failure.stdout) as Record<string, unknown>
          if (value && value.loggedIn === false) return failure.stdout
        }
        throw error
      })
    const value = JSON.parse(output) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'pending', reason: 'Claude Code 登录状态格式尚未适配' }
    if (typeof value.configDirectory === 'string' && value.configDirectory !== configDirectory && realpathSync(value.configDirectory) !== realpathSync(configDirectory)) return { state: 'blocked', reason: 'Claude Code 登录状态来自其他配置目录' }
    const loggedIn = typeof value.loggedIn === 'boolean' ? value.loggedIn : typeof value.authenticated === 'boolean' ? value.authenticated : undefined
    const rawMethod = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : typeof value.method === 'string' ? value.method.toLowerCase() : ''
    // Current Claude calls ANTHROPIC_AUTH_TOKEN "oauth_token" as well. The
    // explicitly selected credential channel disambiguates a gateway bearer
    // from a subscription token; its label alone cannot prove OAuth login.
    const method: ClaudeCodeLoginProbe['method'] = environment.ANTHROPIC_AUTH_TOKEN && (rawMethod.includes('oauth') || rawMethod.includes('token') || rawMethod.includes('bearer')) ? 'bearer' : rawMethod.includes('oauth') ? 'oauth' : rawMethod.includes('api') ? 'api_key' : rawMethod.includes('bearer') || rawMethod.includes('token') ? 'bearer' : rawMethod.includes('profile') ? 'profile' : rawMethod.includes('bedrock') || rawMethod.includes('vertex') || rawMethod.includes('foundry') ? 'cloud' : rawMethod && rawMethod !== 'none' ? 'unknown' : undefined
    if (loggedIn === undefined) return { state: 'pending', ...(method ? { method } : {}), reason: 'Claude Code 登录状态格式尚未适配' }
    return { state: loggedIn ? 'verified' : 'pending', authenticated: loggedIn, ...(method ? { method } : {}), ...(loggedIn ? {} : { reason: 'Claude Code 当前配置目录未登录' }) }
  } catch (error) {
    void error
    return { state: 'blocked', reason: 'Claude Code 登录状态探针失败，未输出原始诊断内容' }
  }
}

/**
 * Enumerate transcript files without parsing conversation bodies.  A Claude
 * session key includes its config directory and source file, so two files with
 * the same basename cannot be mistaken for one another or merged with Codex.
 */
export function inspectClaudeCodeSessions(configDirectory: string): ClaudeCodeSessionBoundary {
  if (!isAbsolute(configDirectory)) return { state: 'blocked', directory: configDirectory, files: [], duplicateIds: [], reason: 'Claude Code 配置目录必须是绝对路径' }
  let root: string
  try {
    const configStat = lstatSync(configDirectory)
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) return { state: 'blocked', directory: configDirectory, files: [], duplicateIds: [], reason: 'Claude Code 配置目录不是稳定的普通目录' }
    root = realpathSync(configDirectory)
  } catch { return { state: 'pending', directory: configDirectory, files: [], duplicateIds: [], reason: 'Claude Code 会话目录尚未创建' } }
  const directory = join(root, 'projects')
  const files: ClaudeCodeSessionKey[] = [], seen = new Set<string>(), idSources = new Map<string, string>(), duplicateIds = new Set<string>()
  const walk = (current: string): void => {
    if (files.length >= MAX_SESSION_FILES) throw new Error('Claude Code 会话文件超过安全上限')
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const path = `${current}${sep}${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('Claude Code 会话目录包含符号链接，已拒绝扫描')
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile() || !/\.(?:jsonl|json)$/i.test(entry.name)) continue
      const canonical = realpathSync(path)
      if (canonical !== path) throw new Error('Claude Code 会话文件已被替换，已拒绝扫描')
      const relativePath = relative(root, canonical)
      if (!relativePath || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) throw new Error('Claude Code 会话文件越过配置目录')
      const sessionId = entry.name.replace(/\.(?:jsonl|json)$/i, '')
      const key = `${claudeCodeClientType}:cli:${root}:${sessionId}:${canonical}`
      const previousSource = idSources.get(sessionId)
      if (previousSource && previousSource !== canonical) duplicateIds.add(sessionId)
      idSources.set(sessionId, canonical)
      if (seen.has(key)) duplicateIds.add(sessionId)
      seen.add(key)
      files.push({ clientType: claudeCodeClientType, applicationKind: 'cli', configDirectory: root, sessionId, sourceFile: canonical })
    }
  }
  try {
    try {
      const projectStat = lstatSync(directory)
      if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return { state: 'blocked', directory, files: [], duplicateIds: [], reason: 'Claude Code projects 目录不是稳定的普通目录' }
    } catch { return { state: 'verified', directory, files: [], duplicateIds: [], reason: '暂无 Claude Code 会话文件' } }
    walk(directory)
    return { state: 'verified', directory, files, duplicateIds: [...duplicateIds] }
  } catch (error) {
    return { state: 'blocked', directory, files: [], duplicateIds: [], reason: error instanceof Error ? error.message : 'Claude Code 会话边界无法验证' }
  }
}

/**
 * Inspect credential *ownership* without reading credential bytes.  Claude
 * Code gives environment credentials precedence over subscription login; more
 * than one active source is therefore an ambiguous instance configuration.
 */
export function inspectClaudeCodeLoginBoundary(paths: ClaudeCodeConfigPaths, environment: NodeJS.ProcessEnv = process.env): ClaudeCodeLoginBoundary {
  const names: [string, string][] = [
    ['ANTHROPIC_API_KEY', 'api_key'],
    ['ANTHROPIC_AUTH_TOKEN', 'bearer'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'oauth_token'],
    ['ANTHROPIC_PROFILE', 'profile'],
    ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
    ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
  ]
  const configuredSources = names.filter(([name]) => typeof environment[name] === 'string' && environment[name]!.trim()).map(([, source]) => source)
  const conflictingSources = configuredSources.length > 1 ? [...configuredSources] : []
  if (conflictingSources.length) return { state: 'blocked', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: 'Claude Code 同时设置了多个凭据来源，无法确定实例身份' }
  try {
    const configStat = lstatSync(paths.configDirectory)
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) return { state: 'blocked', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: 'Claude Code 配置目录不是稳定的普通目录' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'blocked', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: 'Claude Code 配置目录无法安全读取' }
  }
  let credentialStat: ReturnType<typeof lstatSync> | undefined
  try {
    credentialStat = lstatSync(paths.credentialsFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'blocked', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: 'Claude Code 凭据文件无法安全读取' }
  }
  if (credentialStat) {
    if (credentialStat.isSymbolicLink() || !credentialStat.isFile()) return { state: 'blocked', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: 'Claude Code 凭据文件不是实例目录内的普通文件' }
    return { state: 'pending', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: '发现实例凭据文件，但尚未通过真实登录、Keychain 和轮换验证' }
  }
  if (configuredSources.length) return { state: 'pending', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: '发现环境凭据，但尚未验证该凭据与模型和 Anthropic Messages 端点的归属' }
  return { state: 'pending', credentialFile: paths.credentialsFile, configuredSources, conflictingSources, reason: '未发现凭据；需要在独立配置目录中完成一次受控登录验证' }
}

function gatesForCli(version: ClaudeCodeVersionProbe, capabilities: ClaudeCodeCliCapabilities, _config: ClaudeCodeConfigPaths, _sessions: ClaudeCodeSessionBoundary): ClaudeCodeAcceptance {
  return {
    detection: version.state === 'verified' && capabilities.state === 'verified' ? 'verified' : 'pending',
    configProjection: 'verified',
    credentialIsolation: 'pending',
    protocolAdapter: 'pending',
    runtimeLifecycle: 'pending',
    globalStateOwnership: 'pending',
    sessionIndexing: 'pending',
  }
}

/**
 * Produce a conservative diagnostic report. Static probes cannot grant runtime
 * acceptance; this report never registers an application, creates config files,
 * or reads credential bodies.
 */
export async function verifyClaudeCodeCli(application: ClaudeCodeApplication, options: { instanceHome: string; runner?: (executable: string) => Promise<string>; helpRunner?: (executable: string) => Promise<string>; loginRunner?: (executable: string, configDirectory: string) => Promise<string>; environment?: NodeJS.ProcessEnv } ): Promise<ClaudeCodeVerificationReport> {
  const version = await probeClaudeCodeCliVersion(application.path, { runner: options.runner })
  const cliCapabilities = await probeClaudeCodeCliCapabilities(application.path, { runner: options.helpRunner })
  const config = claudeCodeConfigPaths(join(options.instanceHome, 'claude'))
  const login = inspectClaudeCodeLoginBoundary(config, options.environment ?? {})
  const loginProbe = await probeClaudeCodeLoginStatus(application.path, config.configDirectory, { runner: options.loginRunner, environment: options.environment })
  const sessions = inspectClaudeCodeSessions(config.configDirectory)
  const reasons = [
    'CLAUDE_CONFIG_DIR 应同时隔离 .claude.json、凭据和会话；仍需当前程序的双实例运行验收，不能只凭版本检测判定',
    '本探针不验证 API 请求和运行归属；订阅 OAuth、Keychain/profile 与 MCP OAuth 仍需独立验收',
    'Claude 只读会话索引已接入；会话迁移与管理器一键续接尚未接入',
  ]
  if (version.reason) reasons.unshift(version.reason)
  if (cliCapabilities.reason) reasons.unshift(cliCapabilities.reason)
  if (loginProbe.reason) reasons.unshift(loginProbe.reason)
  return {
    clientType: claudeCodeClientType,
    applicationKind: 'cli',
    application,
    gates: gatesForCli(version, cliCapabilities, config, sessions),
    version,
    cliCapabilities,
    config,
    login,
    loginProbe,
    sessions,
    reasons,
    canRegister: false,
  }
}

export function verifyClaudeCodeDesktop(application: ClaudeCodeDesktopApplication): ClaudeCodeVerificationReport {
  return {
    clientType: claudeCodeClientType,
    applicationKind: 'desktop',
    application,
    gates: { ...claudeCodeDesktopAcceptance },
    version: application.version ? { state: 'verified', version: application.version } : { state: 'pending', reason: 'Desktop bundle 未提供可核实版本' },
    reasons: ['macOS Desktop 在各实例内登录，启动时确认实际使用独立 profile；CLI OAuth、API 配置投影和管理器会话索引暂未接入'],
    canRegister: process.platform === 'darwin',
  }
}

/** Read-only discovery helper used by diagnostics, never by the Codex registry. */
export function discoverClaudeCodeCandidates(options: Parameters<typeof detectClaudeCodeApplications>[0] = {}) {
  return { cli: detectClaudeCodeApplications(options), desktop: detectClaudeCodeDesktopApplications(options) }
}
