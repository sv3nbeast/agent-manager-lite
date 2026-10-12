import { execFile as execFileCallback } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, sep } from 'node:path'
import { claudeCodeClientType, type ClaudeCodeApplicationKind, type ClaudeCodeAcceptance } from '../shared/claudeCode'
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
  flags: Record<'print' | 'model' | 'resume' | 'sessionId' | 'settings' | 'addDir', boolean>
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
  /** Planned clients must not enter the common instance registry by accident. */
  canRegister: false
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
  try {
    const result = await execFile(executable, ['--help'], {
      timeout: Math.min(Math.max(timeoutMs, 250), 30_000),
      maxBuffer: MAX_VERSION_OUTPUT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      windowsHide: true,
    })
    return result.stdout + result.stderr
  } catch (error) {
    const candidate = error as { stdout?: unknown; stderr?: unknown }
    return `${typeof candidate.stdout === 'string' ? candidate.stdout : ''}${typeof candidate.stderr === 'string' ? candidate.stderr : ''}`
  }
}

/**
 * Capability probe deliberately checks stable CLI contracts instead of a
 * version allow-list.  A compatible release can therefore pass unchanged;
 * an incompatible release is blocked before it can write an instance home.
 */
export async function probeClaudeCodeCliCapabilities(executable: string, options: { timeoutMs?: number; runner?: (executable: string) => Promise<string> } = {}): Promise<ClaudeCodeCliCapabilities> {
  if (!stableExecutable(executable)) return { state: 'blocked', flags: { print: false, model: false, resume: false, sessionId: false, settings: false, addDir: false }, reason: 'Claude Code CLI 路径不是稳定的普通可执行文件' }
  const output = options.runner ? await options.runner(executable) : await runCliHelp(executable, options.timeoutMs ?? 5000)
  const has = (flag: string) => new RegExp(`(?:^|[\\s,])${flag.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:[=\\s,]|$)`, 'm').test(output)
  const flags = { print: has('--print'), model: has('--model'), resume: has('--resume'), sessionId: has('--session-id'), settings: has('--settings'), addDir: has('--add-dir') }
  const required = Object.entries(flags).filter(([, value]) => !value).map(([key]) => key)
  return required.length ? { state: 'blocked', flags, reason: `Claude Code CLI 缺少受管参数：${required.join(', ')}` } : { state: 'verified', flags }
}

/**
 * Verify the selected config directory's login state using Claude's own
 * `auth status --json` command.  The JSON body is reduced to two safe fields;
 * tokens, email addresses and provider metadata never leave this function.
 */
export async function probeClaudeCodeLoginStatus(executable: string, configDirectory: string, options: { timeoutMs?: number; runner?: (executable: string, configDirectory: string) => Promise<string> } = {}): Promise<ClaudeCodeLoginProbe> {
  if (!stableExecutable(executable)) return { state: 'blocked', reason: 'Claude Code CLI 路径不是稳定的普通可执行文件' }
  if (!isAbsolute(configDirectory)) return { state: 'blocked', reason: 'Claude Code 登录探针需要绝对配置目录' }
  try {
    const output = options.runner
      ? await options.runner(executable, configDirectory)
      : (await execFile(executable, ['auth', 'status', '--json'], {
        timeout: Math.min(Math.max(options.timeoutMs ?? 5000, 250), 30_000),
        maxBuffer: MAX_VERSION_OUTPUT,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CLAUDE_CONFIG_DIR: configDirectory },
        windowsHide: true,
      })).stdout
    const value = JSON.parse(output) as Record<string, unknown>
    const loggedIn = typeof value.loggedIn === 'boolean' ? value.loggedIn : typeof value.authenticated === 'boolean' ? value.authenticated : undefined
    const rawMethod = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : typeof value.method === 'string' ? value.method.toLowerCase() : ''
    const method: ClaudeCodeLoginProbe['method'] = rawMethod.includes('oauth') ? 'oauth' : rawMethod.includes('api') ? 'api_key' : rawMethod.includes('bearer') || rawMethod.includes('token') ? 'bearer' : rawMethod.includes('profile') ? 'profile' : rawMethod.includes('bedrock') || rawMethod.includes('vertex') || rawMethod.includes('foundry') ? 'cloud' : rawMethod ? 'unknown' : undefined
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
 * Produce the evidence report used by the future registry.  This report never
 * registers an application, creates config files, or reads credential bodies.
 */
export async function verifyClaudeCodeCli(application: ClaudeCodeApplication, options: { instanceHome: string; runner?: (executable: string) => Promise<string>; helpRunner?: (executable: string) => Promise<string>; loginRunner?: (executable: string, configDirectory: string) => Promise<string>; environment?: NodeJS.ProcessEnv } ): Promise<ClaudeCodeVerificationReport> {
  const version = await probeClaudeCodeCliVersion(application.path, { runner: options.runner })
  const cliCapabilities = await probeClaudeCodeCliCapabilities(application.path, { runner: options.helpRunner })
  const config = claudeCodeConfigPaths(join(options.instanceHome, 'claude'))
  const login = inspectClaudeCodeLoginBoundary(config, options.environment ?? {})
  const loginProbe = await probeClaudeCodeLoginStatus(application.path, config.configDirectory, { runner: options.loginRunner })
  const sessions = inspectClaudeCodeSessions(config.configDirectory)
  const reasons = [
    'Claude Code 的 ~/.claude.json 仍是配置目录外的全局状态，尚未证明可按实例归属',
    'Anthropic 登录凭据、Keychain/profile、MCP OAuth 和 API 凭据尚未完成双实例实测',
    'Claude Code 会话 transcript 格式和 resume 归属尚未接入通用会话提供者',
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
    gates: { detection: 'verified', configProjection: 'pending', credentialIsolation: 'pending', protocolAdapter: 'pending', runtimeLifecycle: 'pending', globalStateOwnership: 'pending', sessionIndexing: 'pending' },
    version: application.version ? { state: 'verified', version: application.version } : { state: 'pending', reason: 'Desktop bundle 未提供可核实版本' },
    reasons: ['Claude Desktop 的 Electron profile、Keychain/cookie、MCP OAuth、插件和 Code 模式边界尚未完成双实例实测'],
    canRegister: false,
  }
}

/** Read-only discovery helper used by diagnostics, never by the Codex registry. */
export function discoverClaudeCodeCandidates(options: Parameters<typeof detectClaudeCodeApplications>[0] = {}) {
  return { cli: detectClaudeCodeApplications(options), desktop: detectClaudeCodeDesktopApplications(options) }
}
