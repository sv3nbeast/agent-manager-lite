import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { InstanceApplication } from '../shared/instances'
import { claudeCodeClient, claudeCodeClientType, claudeCodeOwnedEnvironment, type ClaudeCodeOwnedEnvironment } from '../shared/claudeCode'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface ClaudeCodeApplication {
  clientType: typeof claudeCodeClientType
  id: string
  name: string
  path: string
  kind: 'cli'
  /** Detection is deliberately version agnostic until a signed/runtime probe is verified. */
  version?: string
}

export interface ClaudeCodeDetectionOptions {
  home?: string
  path?: string
  platform?: NodeJS.Platform
}

function executableFile(path: string): string | undefined {
  try {
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

export function claudeCodeConfigPaths(configDirectory: string): ClaudeCodeConfigPaths {
  if (!isAbsolute(configDirectory)) throw new Error('Claude Code 配置目录必须是绝对路径')
  const directory = resolve(configDirectory)
  return {
    configDirectory: directory,
    settingsFile: join(directory, 'settings.json'),
    credentialsFile: join(directory, '.credentials.json'),
    sessionsDirectory: join(directory, 'projects'),
    pluginsDirectory: join(directory, 'plugins'),
    globalStateFile: join(homedir(), '.claude.json'),
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

function assertValue(name: string, value: string | undefined): void {
  if (value !== undefined && (!value || /[\0\r\n]/.test(value))) throw new Error(`${name} 包含无效字符`)
}

/**
 * Build the non-secret part of an isolated launch projection.  The caller can
 * supply a provider API key/token, but the returned object must never be
 * persisted in the manager vault or logged by a future runtime transaction.
 */
export function projectClaudeCodeConfig(input: ClaudeCodeProjectionInput): ClaudeCodeProjection {
  if (!isAbsolute(input.instanceHome)) throw new Error('Claude Code 实例目录必须是绝对路径')
  assertValue('model', input.model); assertValue('baseUrl', input.baseUrl); assertValue('authToken', input.authToken); assertValue('apiKey', input.apiKey)
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
    warnings: ['Claude Code 的 ~/.claude.json 全局状态文件尚未纳入实例隔离；接入启动生命周期前必须完成归属和恢复验证。'],
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
    if (/^(?:--settings(?:=|$)|--config-dir(?:=|$)|--session-id(?:=|$)|--resume(?:=|$)|--worktree(?:=|$)|-w(?:=|$)|--add-dir(?:=|$))/.test(arg)) throw new Error('Claude Code 参数不能覆盖实例配置、会话或工作目录')
    if (arg === '--model' || arg === '-m' || arg.startsWith('--model=') || arg.startsWith('-m=')) {
      if (arg === '--model' || arg === '-m') { index++; if (!args[index]) throw new Error('Claude Code --model 需要值') }
      throw new Error('Claude Code 模型应在实例配置中选择')
    }
  }
}

export const claudeCodeInstanceAdapter = {
  client: claudeCodeClient,
  applications: detectClaudeCodeApplications,
  configPaths: claudeCodeConfigPaths,
  projectConfig: projectClaudeCodeConfig,
  environment: claudeCodeEnvironment,
  validateCliArgs: validateClaudeCodeCliArgs,
}
