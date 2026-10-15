import { createHash } from 'node:crypto'
import * as nodeFS from 'node:fs'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isClaudeDesktopProfile, type InstanceLaunchPreview, type InstanceProfile } from '../shared/instances'
import { readBounded } from './clientConfig'
import { captureClaudeExecutableIdentity, type ClaudeExecutableIdentity } from './claudeCodeCapability'
import { detectClaudeCodeDesktopApplications } from './claudeCodeDesktopAdapter'
import type { DesktopPlan } from './instanceRuntime'
import { proxyAddressView } from './proxyPolicy'
import type { StoredAccount } from './store'
import { assertClaudeDesktopGatewayCapability, claudeDesktopGatewayFingerprint, prepareClaudeDesktopGateway, validateClaudeDesktopGatewayAccount } from './claudeDesktopGateway'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Electron exposes app.asar as a virtual directory through node:fs. Bundle
// ownership must inspect the physical archive, just as Codex's ASAR adapter does.
const physicalFS:typeof nodeFS=process.versions.electron?createRequire(join(dirname(process.execPath),'cml-runtime.cjs'))('original-fs'):nodeFS

interface DirectoryIdentity { path: string; device: number; inode: number }
export interface ClaudeDesktopRuntimeContext {
  profile: InstanceProfile
  plan: DesktopPlan
  fingerprint: string
  identity: ClaudeExecutableIdentity
  home: string
  temporaryDirectory: string
  upstreamProxy?: string
  version?: string
  account?: StoredAccount
}

function directoryIdentity(path: string, optional = false): DirectoryIdentity | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Claude Desktop 实例目录已被替换，不能继续启动')
    return { path, device: stat.dev, inode: stat.ino }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function bundleResourcesIdentity(application: string): unknown {
  const path = join(application, 'Contents', 'Resources', 'app.asar'), stat = physicalFS.lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || physicalFS.realpathSync(path) !== path || stat.nlink !== 1) throw new Error('Claude Desktop 应用资源已被替换，请重新选择应用')
  return [path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
}

function settingsIdentity(plan: DesktopPlan,home:string): unknown {
  const isolatedEnvironment:Record<string,string>={HOME:home,CFFIXED_USER_HOME:home,XDG_CONFIG_HOME:join(home,'.config'),CLAUDE_CONFIG_DIR:plan.directory,CLAUDE_CODE_PROJECT_DIR_NAME:'projects'}
  return [join(plan.directory,'settings.json'),join(plan.desktopDirectory,'ccd-environment-config.json'),join(`${plan.desktopDirectory}-3p`,'ccd-environment-config.json')].map(path=>{
    const raw=readBounded(path,1024*1024)
    if(raw===null)return [path,null]
    let value:unknown
    try {value=JSON.parse(raw)}catch{throw new Error('Claude Desktop 实例配置不是有效 JSON，原文件已保留')}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Claude Desktop 实例配置格式无效，原文件已保留')
    const inspect=(entry:unknown,depth=0):void=>{
      if(depth>24)throw new Error('Claude Desktop 实例配置层级过深，原文件已保留')
      if(!entry||typeof entry!=='object')return
      for(const [key,child] of Object.entries(entry)){
        if(Object.hasOwn(isolatedEnvironment,key)&&child!==isolatedEnvironment[key])throw new Error('Claude Desktop 实例配置不能覆盖受管隔离目录：'+key)
        inspect(child,depth+1)
      }
    }
    // Native encrypted environments stay opaque and untouched: saving even an
    // empty environment in Desktop creates ciphertext. Managed launch roots
    // are an isolation default, not a filesystem sandbox for native settings.
    inspect(path.endsWith('settings.json')?(value as Record<string,unknown>).env:value)
    return [path,hash(raw)]
  })
}

/** Native login and third-party API deployment have separate native profiles.
 * CLI OAuth is never projected into either Desktop login boundary. */
export function claudeDesktopRuntimeContext(profile: InstanceProfile, plan: DesktopPlan,upstreamProxy?:string,account?:StoredAccount): ClaudeDesktopRuntimeContext {
  if (!isClaudeDesktopProfile(profile)) throw new Error('所选实例不是 Claude Desktop')
  if (profile.connectionMode === 'native') {
    validateClaudeDesktopGatewayAccount(profile, account)
    assertClaudeDesktopGatewayCapability(plan.application)
    plan.claudeDesktopConnection = 'api'
  } else {
    if (profile.connectionMode !== 'client_login' || profile.accountId !== '' || profile.model !== '') throw new Error('Claude Desktop 客户端登录不需要绑定管理器账号或模型')
    delete plan.claudeDesktopConnection
  }
  if (profile.externalHome || plan.mode !== 'desktop' || plan.clientType !== 'claude_code') throw new Error('Claude Desktop 必须使用独立的受管桌面实例')
  const root = dirname(plan.directory), home = join(root, 'desktop-home'),temporaryDirectory=join(home,'tmp')
  if (plan.directory !== join(root, 'home') || plan.desktopDirectory !== join(root, 'desktop') || plan.workingDirectory !== join(root, 'workspace')) throw new Error('Claude Desktop 配置、桌面与工作目录必须归属同一实例')
  const application = detectClaudeCodeDesktopApplications({ platform: 'darwin', roots: [plan.application] }).find(candidate => candidate.path === plan.application && candidate.executable === plan.executable)
  if (!application) throw new Error('Claude Desktop 应用身份已变化，请重新选择应用')
  const identity = captureClaudeExecutableIdentity(plan.executable)
  const directories = [root, plan.directory, plan.desktopDirectory, plan.workingDirectory].map(path => directoryIdentity(path))
  directories.push(directoryIdentity(`${plan.desktopDirectory}-3p`, true), directoryIdentity(join(`${plan.desktopDirectory}-3p`, 'configLibrary'), true))
  const loginHome = directoryIdentity(home, true)
  const temporary = directoryIdentity(temporaryDirectory,true)
  const bundle = [readBounded(join(plan.application, 'Contents', 'Info.plist'), 256 * 1024), bundleResourcesIdentity(plan.application)]
  return { profile, plan, identity, home,temporaryDirectory,upstreamProxy, account, version: application.version,
    fingerprint: hash([profile, plan.application, identity, bundle, directories, loginHome,temporary, plan.args, settingsIdentity(plan,home),claudeDesktopGatewayFingerprint(plan),upstreamProxy,
      account&&[account.id,account.revision,account.kind,account.identityService,account.credentialKind,account.protocol,account.baseUrl,account.models,account.credentials.apiKey]]) }
}

export function claudeDesktopLaunchPreview(context: ClaudeDesktopRuntimeContext): Omit<InstanceLaunchPreview, 'ticket'> {
  const { plan, profile, account } = context
  const api=profile.connectionMode==='native',source=api?'account' as const:'settings' as const
  return {
    clientType: 'claude_code', instanceId: profile.id, name: profile.name, application: plan.application, executable: plan.executable,
    directory: plan.directory, desktopDirectory: api?`${plan.desktopDirectory}-3p`:plan.desktopDirectory, workingDirectory: plan.workingDirectory,
    args: [...plan.args], accountName: account?.name??'在 Claude Desktop 内登录', ...(account?{providerName:account.name}:{}), model: api?profile.model:'', tierSource: 'client',
    connectionMode: profile.connectionMode, launchMode: 'desktop', identityStatus: api?'api_configured':'client_login', clientVersion: context.version,
    network:context.upstreamProxy===undefined?{mode:'inherit',source}:context.upstreamProxy==='direct'?{mode:'direct',source}:{mode:'proxy',source,proxy:proxyAddressView(context.upstreamProxy)},
  }
}

/** Prepare manager-owned directories and the selected native deployment mode. */
export async function prepareClaudeDesktopLaunch(context: ClaudeDesktopRuntimeContext, signal: AbortSignal): Promise<ClaudeDesktopRuntimeContext> {
  signal.throwIfAborted()
  if (claudeDesktopRuntimeContext(context.profile, context.plan,context.upstreamProxy,context.account).fingerprint !== context.fingerprint) throw new Error('Claude Desktop 应用、配置或网络设置已变化，请重新预览')
  if (!directoryIdentity(context.home, true)) mkdirSync(context.home, { mode: 0o700 })
  directoryIdentity(context.home)
  chmodSync(context.home, 0o700)
  if(!directoryIdentity(context.temporaryDirectory,true))mkdirSync(context.temporaryDirectory,{mode:0o700})
  directoryIdentity(context.temporaryDirectory)
  chmodSync(context.temporaryDirectory,0o700)
  signal.throwIfAborted()
  prepareClaudeDesktopGateway(context.plan, context.profile, context.account)
  signal.throwIfAborted()
  context.plan.launchEnvironment = { CLAUDE_CONFIG_DIR: context.plan.directory, HOME: context.home, CFFIXED_USER_HOME: context.home,CLAUDE_CODE_TMPDIR:context.temporaryDirectory }
  return claudeDesktopRuntimeContext(context.profile, context.plan,context.upstreamProxy,context.account)
}
