import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceProfile, InstanceLaunchPreview } from '../shared/instances'
import type { StoredAccount } from './store'
import type { DesktopPlan } from './instanceRuntime'
import { directory, readBounded } from './clientConfig'
import { claudeCodeAuthEnvironment, claudeCodeConfigPaths, claudeCodeInstanceAdapter, validateClaudeCodeCliArgs } from './claudeCodeInstanceAdapter'
import { captureClaudeExecutableIdentity, validateClaudeExecutableIdentity, type ClaudeExecutableIdentity } from './claudeCodeCapability'
import { probeClaudeCodeCliCapabilities, probeClaudeCodeCliVersion, probeClaudeCodeLoginStatus } from './claudeCodeVerification'
import { isClaudeSubscriptionAccount } from './claudeCodeSubscription'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeHeaders = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', '7f454c46'])
const ownedEnvironment = /^(?:ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|CML_|NODE_|ELECTRON_|HOME$|XDG_CONFIG_HOME$)/

export interface ClaudeRuntimeContext {
  fingerprint: string
  identity: ClaudeExecutableIdentity
  account: StoredAccount
  plan: DesktopPlan
}

export function claudeConnectionStatus(profile:InstanceProfile,account:StoredAccount|undefined):'api_configured'|'subscription_configured'|'missing'|'unknown' {
  if(!account)return 'missing'
  try {claudeCodeInstanceAdapter.validateAccount(profile,account);return isClaudeSubscriptionAccount(account)?'subscription_configured':'api_configured'}catch{return 'unknown'}
}

/** Only the native launcher has verified process ownership; never execute an npm script to discover it. */
export function validateClaudeNativeProgram(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd), header = Buffer.alloc(4)
    if (!stat.isFile() || !(stat.mode & 0o111) || readSync(fd, header, 0, 4, 0) !== 4 || !nativeHeaders.has(header.toString('hex'))) {
      throw new Error('受管 Claude 实例需要官方原生 CLI；请安装原生版本后重新选择程序')
    }
  } finally { closeSync(fd) }
}

/** Keep user settings intact, while rejecting alternate credential/routing owners. */
export function claudeSettingsFingerprint(configDirectory: string): string {
  directory(configDirectory)
  if (realpathSync(configDirectory) !== configDirectory) throw new Error('Claude 配置目录已被替换')
  const raw = readBounded(join(configDirectory, 'settings.json'), 1024 * 1024)
  if (raw === null) return hash(null)
  let settings: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    settings = value as Record<string, unknown>
  } catch { throw new Error('Claude 实例 settings.json 格式无效，原文件已保留') }
  for (const key of ['apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'awsAuthRefresh', 'awsCredentialExport']) {
    if (settings[key] !== undefined) throw new Error('Claude 实例设置包含其他登录来源；请在管理器选择连接，并移除实例设置中的 ' + key)
  }
  if (settings.env !== undefined) {
    if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) throw new Error('Claude 实例设置的 env 格式无效')
    if (Object.keys(settings.env).some(key => ownedEnvironment.test(key))) throw new Error('Claude 实例设置不能覆盖管理器选择的登录、模型或隔离目录')
  }
  const stat = lstatSync(join(configDirectory, 'settings.json'))
  return hash([raw, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs])
}

export function claudeRuntimeContext(profile: InstanceProfile, account: StoredAccount, plan: DesktopPlan, proxy?: string): ClaudeRuntimeContext {
  if (profile.externalHome) throw new Error('Claude 尚不支持直接接管外部配置目录，请创建独立实例')
  claudeCodeInstanceAdapter.validateAccount(profile, account)
  validateClaudeNativeProgram(plan.executable)
  const identity = captureClaudeExecutableIdentity(plan.executable)
  const settings = claudeSettingsFingerprint(plan.directory)
  const directories = [plan.directory, plan.desktopDirectory, plan.workingDirectory].map(path => {
    directory(path)
    const stat = lstatSync(path)
    return [path, stat.dev, stat.ino]
  })
  return { account, plan, identity, fingerprint: hash([profile, identity, settings, directories, account.id, account.kind,
    account.identityService, account.credentialKind, account.protocol, account.baseUrl, account.models, account.credentials.apiKey,
    account.credentials.accountId, account.claudeSubscription?.accountId, account.claudeSubscription?.organizationId, proxy]) }
}

export function claudeLaunchPreview(context: ClaudeRuntimeContext): Omit<InstanceLaunchPreview, 'ticket'> {
  const { plan, account } = context
  return {
    clientType: 'claude_code', instanceId: '', name: '', application: plan.application, executable: plan.executable,
    directory: plan.directory, desktopDirectory: plan.desktopDirectory, workingDirectory: plan.workingDirectory,
    args: [...plan.args], accountName: account.name, providerName: account.name, model: '', tierSource: 'client',
    connectionMode: 'native', launchMode: 'cli', identityStatus: isClaudeSubscriptionAccount(account)?'subscription_configured':'api_configured',
  }
}

/** Secrets exist only in the launch handoff, never in a preview, checkpoint or settings.json. */
export async function prepareClaudeLaunch(context: ClaudeRuntimeContext, model: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const [version, capabilities] = await Promise.all([
    probeClaudeCodeCliVersion(context.plan.executable),
    probeClaudeCodeCliCapabilities(context.plan.executable),
  ])
  signal.throwIfAborted()
  validateClaudeExecutableIdentity(context.identity)
  if (version.state !== 'verified' || capabilities.state !== 'verified') throw new Error(capabilities.reason ?? version.reason ?? '当前 Claude CLI 未通过启动能力检查')
  validateClaudeCodeCliArgs(context.plan.args,capabilities.advertisedCommands)
  claudeSettingsFingerprint(context.plan.directory)
  const paths = claudeCodeConfigPaths(context.plan.directory)
  context.plan.launchEnvironment = {
    CLAUDE_CONFIG_DIR: paths.configDirectory,
    // Anthropic's separate profile store must not select the shell user's
    // organization/credentials ahead of this instance's subscription file.
    ANTHROPIC_CONFIG_DIR: join(paths.configDirectory, 'anthropic'),
    ANTHROPIC_BASE_URL: context.account.baseUrl,
    ANTHROPIC_MODEL: model,
    ...isClaudeSubscriptionAccount(context.account)?{}:claudeCodeAuthEnvironment(context.account),
  }
  // Project instructions remain readable; project login hooks and MCP cannot
  // silently replace the instance connection. User-selectable sources are limited
  // to instance settings; Claude still enforces system/organization policies.
  context.plan.managedArgs = ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', model]
  return version.version!
}

/** Validate the current CLI's native credential contract, independent of version numbers. */
export async function verifyClaudeSubscriptionLaunch(plan: DesktopPlan, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const status = await probeClaudeCodeLoginStatus(plan.executable, plan.directory, { environment: plan.launchEnvironment })
  signal.throwIfAborted()
  if (status.state !== 'verified' || !status.authenticated || status.method !== 'oauth') {
    throw new Error('当前 Claude CLI 未识别实例订阅登录，请更新官方原生 CLI 后重试')
  }
}
