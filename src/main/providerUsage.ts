// Adapted from Cockpit ee816002: codex_model_provider_commands.rs and
// modelProviderUsageService.ts. See THIRD_PARTY_NOTICES.md for provenance.
import { accountInputSchema } from '../shared/types'
import type { ProviderUsage, ProviderUsageWindow } from '../shared/providerUsage'
import type { StoredAccount } from './store'
import { HTTPError, JSONResponseError, object, requestJSON, type JSONRequest } from './network'

export class ProviderUsageUnavailable extends Error {
  constructor() { super('服务商未提供可识别的额度接口，当前额度未知') }
}
export class ProviderUsageRejected extends Error {
  constructor() { super('服务商拒绝额度查询，请检查密钥或套餐状态') }
}
const finite = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
const unit = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z][a-zA-Z_ ]{0,15}$/.test(value.trim()) ? value.trim() : undefined
const missing = (error: unknown): boolean => error instanceof ProviderUsageUnavailable || error instanceof JSONResponseError || error instanceof HTTPError && [404, 405].includes(error.status)
const known = (values: unknown[]): boolean => values.some(value => value !== undefined)
// These New API fields are Unix seconds. 0/-1 do not prove a no-expiry policy.
const expiry = (raw: unknown): number | undefined => {
  const seconds = finite(raw)
  return seconds !== undefined && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8_640_000_000_000 ? seconds * 1000 : undefined
}

export function parseSub2APIUsage(body: Record<string, unknown>, now = Date.now()): ProviderUsage {
  const quota = object(body.quota), usage = object(body.usage), today = object(usage.today), total = object(usage.total)
  const summary: ProviderUsage = {
    source: 'sub2api', updatedAt: now, unit: unit(body.unit) ?? unit(quota.unit),
    remaining: finite(body.remaining) ?? finite(quota.remaining), balance: finite(body.balance),
    limit: finite(quota.limit), used: finite(quota.used), unlimited: bool(quota.unlimited),
    isValid: bool(body.is_active) ?? bool(body.isValid),
    todayRequests: finite(today.requests), todayTokens: finite(today.total_tokens), todayCost: finite(today.cost),
    totalRequests: finite(total.requests), totalTokens: finite(total.total_tokens), totalCost: finite(total.cost)
  }
  if (!known([summary.remaining, summary.balance, summary.limit, summary.used, summary.unlimited, summary.isValid,
    summary.todayRequests, summary.todayTokens, summary.todayCost, summary.totalRequests, summary.totalTokens, summary.totalCost])) throw new ProviderUsageUnavailable()
  return summary
}

export function parseNewAPIUsage(subscription: Record<string, unknown>, usage: Record<string, unknown>, tokenUsage?: Record<string, unknown>, now = Date.now()): ProviderUsage {
  const limits = [subscription.hard_limit_usd, subscription.soft_limit_usd, subscription.system_hard_limit_usd].map(finite)
  const data = tokenUsage?.success === false ? {} : object(tokenUsage?.data), display = object(data.display)
  const displayUnit = unit(display.unit), rawUsed = finite(usage.total_usage)
  const sentinel = limits.every(value => value === 100_000_000)
  const unlimited = bool(data.unlimited_quota) ?? (sentinel ? true : undefined)
  let limit: number | undefined, used: number | undefined, remaining: number | undefined
  if (displayUnit) {
    // Never mix site-provided display amounts with billing or raw token quotas.
    limit = finite(display.total); used = finite(display.used); remaining = finite(display.remaining)
    limit ??= used !== undefined && remaining !== undefined ? finite(used + remaining) : undefined
    used ??= limit !== undefined && remaining !== undefined ? finite(Math.max(0, limit - remaining)) : undefined
    remaining ??= limit !== undefined && used !== undefined ? finite(Math.max(0, limit - used)) : undefined
  } else {
    limit = unlimited ? undefined : limits.find(value => value !== undefined)
    used = rawUsed === undefined ? undefined : rawUsed / 100
    remaining = limit !== undefined && used !== undefined ? finite(Math.max(0, limit - used)) : undefined
  }
  if (!known([limit, used, remaining, unlimited])) throw new ProviderUsageUnavailable()
  return { source: 'new_api', updatedAt: now, unit: displayUnit, unlimited,
    limit: unlimited ? undefined : limit, used, remaining,
    expiresAt: expiry(data.expires_at), accessUntil: expiry(subscription.access_until) }
}

const field = (body: Record<string, unknown>, keys: string[]) => keys.map(key => finite(body[key])).find(value => value !== undefined)
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined
const textField = (body: Record<string, unknown>, keys: string[]) => keys.map(key => text(body[key])).find(value => value !== undefined)
const percent = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(100, value))
const payload = (body: Record<string, unknown>) => body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? object(body.data) : body
function success(body: Record<string, unknown>): void {
  // A 200 response can still be an authentication/plan error. Never treat its
  // diagnostic text or leftover quota fields as a successful balance query.
  const status = finite(object(body.base_resp).status_code), code = finite(body.code)
  if (body.success === false || status !== undefined && status !== 0 || code !== undefined && ![0,200].includes(code)
    || typeof body.error === 'string' && body.error.length > 0 || Object.keys(object(body.error)).length) throw new ProviderUsageRejected()
}
function resetTime(value: unknown): number | undefined {
  const number = finite(value)
  if (number !== undefined) {
    const millis = number > 10_000_000_000 ? number : number * 1000
    return millis > 0 && Number.isFinite(millis) && millis <= 8_640_000_000_000_000 ? Math.floor(millis) : undefined
  }
  // Require an explicit timezone; locale dates must not shift with this Mac.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return undefined
  const [year,month,day] = value.slice(0,10).split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()) return undefined
  const millis = Date.parse(value)
  return Number.isFinite(millis) && millis > 0 ? millis : undefined
}
const resetField = (body: Record<string, unknown>, keys: string[]) => keys.map(key => resetTime(body[key])).find(value => value !== undefined)

export function parseDeepSeekUsage(body: Record<string, unknown>, now = Date.now()): ProviderUsage {
  success(body)
  if (Array.isArray(body.balance_infos) && body.balance_infos.length > 100) throw new ProviderUsageUnavailable()
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos.map(object) : []
  const selected = infos.find(info => text(info.currency)?.toUpperCase() === 'CNY') ?? infos[0] ?? {}
  const balance = finite(selected.total_balance), grantedBalance = finite(selected.granted_balance), toppedUpBalance = finite(selected.topped_up_balance), isValid = bool(body.is_available)
  if (!known([balance, grantedBalance, toppedUpBalance, isValid])) throw new ProviderUsageUnavailable()
  return {source:'deepseek',updatedAt:now,unit:unit(selected.currency),remaining:balance,balance,grantedBalance,toppedUpBalance,isValid}
}
function planSummary(source: 'minimax' | 'zhipu', windows: ProviderUsageWindow[], planName: string | undefined, modelName: string | undefined, now: number): ProviderUsage {
  const available = windows.flatMap(window => window.remainingPercent === undefined ? [] : [window.remainingPercent])
  if (!available.length) throw new ProviderUsageUnavailable()
  // Each returned token window constrains use. Showing only the first could
  // report available quota even while another returned window is exhausted.
  const remaining = Math.min(...available)
  return {source,updatedAt:now,unit:'%',remaining,balance:remaining,limit:100,used:100-remaining,isValid:remaining>0,planName,modelName,windows}
}
export function parseMiniMaxUsage(body: Record<string, unknown>, now = Date.now()): ProviderUsage {
  success(body)
  const data = payload(body)
  if (Array.isArray(data.model_remains) && data.model_remains.length > 512) throw new ProviderUsageUnavailable()
  const models = Array.isArray(data.model_remains) ? data.model_remains.map(object) : []
  const model = models.find(value => textField(value,['model_name','modelName'])?.toLowerCase().startsWith('minimax-m')) ?? models[0] ?? data
  const windows: ProviderUsageWindow[] = []
  for (const [id,name,snake,camel,endSnake,endCamel] of [
    ['interval','周期额度','current_interval','currentInterval','end_time','endTime'],
    ['weekly','周额度','current_weekly','currentWeekly','weekly_end_time','weeklyEndTime']
  ]) {
    const limit = field(model,[`${snake}_total_count`,`${camel}TotalCount`])
    // Cockpit's endpoint contract calls remaining credits "usage_count".
    const remaining = field(model,[`${snake}_usage_count`,`${camel}UsageCount`,`${snake}_remaining`,`${camel}Remaining`])
    const remainingPercent = percent(field(model,[`${snake}_remaining_percent`,`${camel}RemainingPercent`,id==='interval'?'remaining_percent':'weekly_remaining_percent',id==='interval'?'remainingPercent':'weeklyRemainingPercent']))
      ?? percent(remaining !== undefined && limit !== undefined && limit > 0 ? remaining / limit * 100 : undefined)
    const resetsAt = resetField(model,[endSnake,endCamel])
    if (known([limit,remaining,remainingPercent,resetsAt])) windows.push({id,name,limit,remaining,remainingPercent,resetsAt})
  }
  return planSummary('minimax',windows,textField(data,['plan_name','planName']) ?? textField(body,['plan_name','planName']),textField(model,['model_name','modelName']),now)
}
export function parseZhipuUsage(body: Record<string, unknown>, now = Date.now()): ProviderUsage {
  success(body)
  const data = payload(body)
  if (!Array.isArray(data.limits) || data.limits.length > 100) throw new ProviderUsageUnavailable()
  const limits = data.limits.map(object).filter(value => text(value.type)?.toUpperCase() === 'TOKENS_LIMIT')
    .map(value => ({value,resetsAt:resetField(value,['nextResetTime','next_reset_time'])}))
    .sort((a,b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))
  const windows = limits.map(({value,resetsAt},index): ProviderUsageWindow => {
    const limit = field(value,['usage','total','limit']), used = field(value,['currentValue','current_value','used']), remaining = field(value,['remaining','remain'])
    const usedPercent = percent(field(value,['percentage','usedPercentage'])) ?? percent(used !== undefined && limit !== undefined && limit > 0 ? used / limit * 100 : undefined)
    if (usedPercent === undefined) throw new ProviderUsageUnavailable()
    // Order by the actual reset, but do not invent a weekly duration from index.
    return {id:`window-${index+1}`,name:`额度窗口 ${index+1}`,limit,used,remaining,remainingPercent:100-usedPercent,resetsAt}
  })
  return planSummary('zhipu',windows,textField(data,['level','planName']),undefined,now)
}

export function invalidateProviderUsage(account: StoredAccount): void {
  delete account.providerUsage
  account.providerUsageRevision = (account.providerUsageRevision ?? 0) + 1
}

export function sameUsageAccount(current: StoredAccount | undefined, account: StoredAccount): current is StoredAccount {
  return !!current && current.kind === 'api_key' && current.generation === account.generation
    && current.baseUrl === account.baseUrl && current.credentials.apiKey === account.credentials.apiKey
    && (current.integrationType ?? 'auto') === (account.integrationType ?? 'auto')
    && (current.providerUsageRevision ?? 0) === (account.providerUsageRevision ?? 0)
}

export async function queryProviderUsage(account: StoredAccount, signal: AbortSignal, request: JSONRequest = requestJSON): Promise<ProviderUsage> {
  const base = new URL(accountInputSchema.shape.baseUrl.parse(account.baseUrl))
  const integrationType = accountInputSchema.shape.integrationType.parse(account.integrationType) ?? 'auto'
  if (!account.credentials.apiKey) throw new Error('账号缺少 API Key')
  const timeout = AbortSignal.timeout(20_000), combined = AbortSignal.any([signal, timeout])
  const get = async (path: string, rawAuth = false) => {
    combined.throwIfAborted()
    const url = new URL(base); url.pathname = path
    const value = await request(url.toString(), {
      headers: { Accept: 'application/json', Authorization: rawAuth ? account.credentials.apiKey! : `Bearer ${account.credentials.apiKey}` }, signal: combined
    }, '查询服务商额度', account)
    combined.throwIfAborted()
    return value
  }
  const prefix = base.pathname.replace(/\/+$/, '')
  const prefixes = prefix ? [prefix] : ['', '/v1']
  const result = (summary: ProviderUsage): ProviderUsage => {
    for (const key of ['unit','planName','modelName'] as const) if (summary[key]?.includes(account.credentials.apiKey!)) delete summary[key]
    return summary
  }
  try {
    if (base.protocol === 'https:' && base.hostname === 'api.deepseek.com') return result(parseDeepSeekUsage(await get('/user/balance')))
    if (['api.minimaxi.com','www.minimaxi.com','api.minimax.io','www.minimax.io'].includes(base.hostname)) {
      for (const path of ['/v1/token_plan/remains','/v1/api/openplatform/coding_plan/remains']) {
        try { return result(parseMiniMaxUsage(await get(path))) }
        catch (error) { if (!(error instanceof ProviderUsageUnavailable || error instanceof HTTPError && error.status === 404)) throw error }
      }
      throw new ProviderUsageUnavailable()
    }
    if (['open.bigmodel.cn','bigmodel.cn','api.z.ai','z.ai'].includes(base.hostname)) return result(parseZhipuUsage(await get('/api/monitor/usage/quota/limit',true)))
    for (const path of prefixes) {
      if (integrationType !== 'sub2api') try {
        const subscription = await get(`${path}/dashboard/billing/subscription`)
        // Reject generic HTTP 200/error documents before requesting more endpoints.
        if (!known([subscription.hard_limit_usd, subscription.soft_limit_usd, subscription.system_hard_limit_usd].map(finite))) throw new ProviderUsageUnavailable()
        const usage = await get(`${path}/dashboard/billing/usage`)
        let tokenUsage: Record<string, unknown> | undefined
        try { tokenUsage = await get(`${path === '/v1' ? '' : path}/api/usage/token/`) }
        catch (error) {
          combined.throwIfAborted()
          // This optional enrichment may be absent on older New API servers.
          // Authentication/rate-limit/server failures remain visible, not success.
          if (!missing(error)) throw error
        }
        return result(parseNewAPIUsage(subscription, usage, tokenUsage))
      } catch (error) { if (!missing(error)) throw error }
      if (integrationType !== 'new_api') try { return result(parseSub2APIUsage(await get(`${path}/usage`))) }
      catch (error) { if (!missing(error)) throw error }
    }
    throw new ProviderUsageUnavailable()
  } catch (error) {
    if (signal.aborted) throw new Error('操作已取消')
    if (timeout.aborted) throw new Error('服务商额度查询超时，请稍后重试')
    if (error instanceof HTTPError || error instanceof ProviderUsageUnavailable || error instanceof ProviderUsageRejected) throw error
    // Transport errors and invalid JSON never echo upstream text/credentials.
    throw new Error('服务商额度查询失败：连接或响应无效')
  }
}
