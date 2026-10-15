import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DesktopPlan } from './instanceRuntime'
import type { StoredAccount } from './store'
import { atomic, directory, readBounded } from './clientConfig'

const markerKey = '_agent_manager_lite_subscription'
const limit = 256 * 1024
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Plan = Pick<DesktopPlan, 'directory' | 'nonce'>

export function isClaudeSubscriptionAccount(account: Pick<StoredAccount, 'kind' | 'identityService' | 'credentialKind'>): boolean {
  return account.kind === 'oauth' && account.identityService === 'anthropic' && account.credentialKind === 'claude_ai_oauth'
}

/** A subscription is an Anthropic identity, never a bearer key for an arbitrary gateway. */
export function assertClaudeSubscriptionDestination(account: Pick<StoredAccount, 'baseUrl'>): void {
  try {
    const url = new URL(account.baseUrl)
    if (url.origin !== 'https://api.anthropic.com' || !['', '/'].includes(url.pathname)
      || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { throw new Error('Claude 订阅账号必须使用官方 Anthropic 地址；第三方连接请使用 API Key 或 Bearer') }
}

function paths(plan: Plan): string {
  if (!isAbsolute(plan.directory) || !/^[A-Za-z0-9_-]{1,256}$/.test(plan.nonce)) throw new Error('Claude 订阅凭据的实例归属无效')
  directory(plan.directory)
  if (realpathSync(plan.directory) !== plan.directory) throw new Error('Claude 订阅配置目录已改变')
  return join(plan.directory, '.credentials.json')
}

function projection(account: StoredAccount): Record<string, unknown> {
  if (!isClaudeSubscriptionAccount(account) || account.protocol !== 'anthropic_messages') throw new Error('账号不是 Claude 订阅 OAuth')
  assertClaudeSubscriptionDestination(account)
  const { accessToken, expiresAt, scope } = account.credentials
  if (!accessToken?.trim() || /[\0\r\n]/.test(accessToken) || accessToken.length > 100_000) throw new Error('Claude 订阅账号缺少有效访问令牌，请重新登录')
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error('Claude 订阅登录已过期，请刷新后启动')
  const scopes = scope?.split(/\s+/).filter(Boolean) ?? ['user:inference']
  if (!scopes.includes('user:inference')) throw new Error('Claude 订阅授权缺少模型调用权限，请重新登录')
  const plan = account.plan?.toLowerCase()
  return {
    accessToken, refreshToken: null, expiresAt: expiresAt ?? null, scopes,
    subscriptionType: plan && ['pro', 'max', 'team', 'enterprise'].includes(plan) ? plan : null,
  }
}

function content(plan: Plan, account: StoredAccount): string {
  const claudeAiOauth = projection(account)
  return JSON.stringify({ claudeAiOauth, [markerKey]: { version: 1, nonce: plan.nonce, accountId: account.id, digest: digest(claudeAiOauth) } }) + '\n'
}

function owned(value: string, plan: Plan, accountId?: string): boolean {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2 || !parsed.claudeAiOauth || !parsed[markerKey]) return false
    const marker = parsed[markerKey]
    return marker.version === 1 && marker.nonce === plan.nonce && typeof marker.accountId === 'string'
      && (accountId === undefined || marker.accountId === accountId) && marker.digest === digest(parsed.claudeAiOauth)
      && parsed.claudeAiOauth.refreshToken === null
  } catch { return false }
}

/** Checkpoint the launch nonce before this call so interrupted preparation is recoverable. */
export function prepareClaudeSubscriptionCredentials(plan: Plan, account: StoredAccount): void {
  const path = paths(plan), body = content(plan, account)
  // Exclusive creation preserves any independently created native login. The
  // CLI reads this official store, but never receives the refresh token.
  try { writeFileSync(path, body, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Claude 实例已有独立登录凭据，已保留；请先停止并恢复实例或创建新实例')
    throw error
  }
}

/** The official CLI reloads this file between requests, including long sessions. */
export function updateClaudeSubscriptionCredentials(plan: Plan, account: StoredAccount): void {
  const path = paths(plan), previous = readBounded(path, limit), body = content(plan, account)
  if (previous === null || !owned(previous, plan, account.id)) throw new Error('Claude 实例登录凭据已由其他来源修改，已保留；请停止后重新启动')
  if ((lstatSync(path).mode & 0o077) !== 0) throw new Error('Claude 实例凭据文件权限已改变，刷新投影已暂停')
  if (previous !== body) atomic(path, body)
}

/** Call only after the owned CLI exits. A user/client replacement is preserved. */
export function releaseClaudeSubscriptionCredentials(plan: Plan): boolean {
  const path = paths(plan), previous = readBounded(path, limit)
  if (previous === null) return true
  if (!owned(previous, plan)) return false
  unlinkSync(path)
  return true
}
