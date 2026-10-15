import type { Store, StoredAccount } from './store'
import type { JSONRequest } from './network'
import { saveClaudeSubscriptionAccount } from './accounts'
import { ClaudeSubscriptionOAuthService, type ClaudeSubscriptionLoginResult } from './claudeSubscriptionOAuth'
import { isClaudeSubscriptionAccount } from './claudeCodeSubscription'

/** TokenAuthority serializes callers; this adapter guards the vault commit across awaits. */
export async function ensureClaudeSubscriptionAccount(store: Store, request: JSONRequest, id: string,
  options: { force?: boolean; rejectedToken?: string; signal?: AbortSignal } = {}): Promise<StoredAccount> {
  const before = store.read().accounts.find(account => account.id === id)
  if (!before) throw new Error('账号已删除')
  if (!isClaudeSubscriptionAccount(before)) throw new Error('账号不是 Claude 订阅 OAuth')
  if (options.rejectedToken && before.credentials.accessToken !== options.rejectedToken) return before
  const { accessToken, refreshToken, expiresAt, tokenType, scope } = before.credentials
  if (!options.force && accessToken && (expiresAt !== undefined && expiresAt > Date.now() + 300_000
    || !refreshToken && (expiresAt === undefined || expiresAt > Date.now()))) return before
  if (!refreshToken) throw new Error('Claude 订阅登录已过期或无法刷新，请重新登录')
  const service = new ClaudeSubscriptionOAuthService({ request: (url, init, operation) => request(url, init, operation, before) })
  const refreshed = await service.refresh({ accessToken: accessToken ?? '', refreshToken, expiresAt, tokenType, scope }, options.signal)

  const currentAccount = (): StoredAccount => {
    const current = store.read().accounts.find(account => account.id === id)
    if (!current) throw new Error('Claude 账号已删除，旧刷新结果已丢弃')
    if (!isClaudeSubscriptionAccount(current) || current.generation !== before.generation
      || current.credentials.accessToken !== accessToken || current.credentials.refreshToken !== refreshToken) {
      throw new Error('Claude 账号登录已改变，旧刷新结果已丢弃')
    }
    return current
  }
  currentAccount()
  const profile = await service.profile(refreshed, options.signal).catch(() => undefined)
  const usage = await service.usage(refreshed, options.signal).catch(() => undefined)
  currentAccount()
  const accountId = before.claudeSubscription?.accountId ?? before.credentials.accountId
  const organizationId = before.claudeSubscription?.organizationId
  if (profile?.accountId && accountId && profile.accountId !== accountId
    || profile?.organizationId && organizationId && profile.organizationId !== organizationId) {
    throw new Error('Claude 订阅刷新返回的账号身份不匹配，请重新登录')
  }
  const result: ClaudeSubscriptionLoginResult = {
    tokens: refreshed, ...(profile ? { profile } : {}), ...(usage ? { usage } : {}),
    metadata: { ...(profile ? { profile } : {}), ...(usage ? { usage } : {}),
      ...(refreshed.tokenType ? { tokenType: refreshed.tokenType } : {}), ...(refreshed.scope ? { scope: refreshed.scope } : {}),
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}), retrievedAt: Date.now() },
  }
  // There is no await between the final comparison and this synchronous vault
  // transaction. A late response cannot recreate or replace a newer account.
  return saveClaudeSubscriptionAccount(store, result, before.id)
}
