import { randomUUID } from 'node:crypto'
import type { Quota, QuotaWindow, RefreshStatus, ResetCredit } from '../shared/types'
import { Store, type StoredAccount } from './store'
import { AgentIdentityService } from './agentIdentity'
import { sameAgentKey } from './agentIdentityCredentials'
import { TokenAuthority, tokenClaims } from './tokens'
import { HTTPError, nonempty, object, requestJSON, type JSONRequest } from './network'
import { bulkRefreshIds, groupRefreshMinutes } from './groups'
import { ProviderUsageUnavailable, queryProviderUsage, sameUsageAccount } from './providerUsage'
import { parseCreditUsage, quotaField, quotaNumber } from './quotaDetails'
import { subscriptionFromToken } from './subscriptionClaims'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const ACCOUNT_CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'
const SUBSCRIPTIONS_URL = 'https://chatgpt.com/backend-api/subscriptions'
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const RESET_CREDITS_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'
const SUBSCRIPTION_RETRY_MS = 30 * 60_000
const SUBSCRIPTION_CACHE_MS = 24 * 60 * 60_000
// Cockpit's pinned subscription endpoints use the ChatGPT web contract, not
// the Codex usage contract. In particular they omit ChatGPT-Account-Id.
const CHATGPT_WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function boolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined }
// Cockpit codex_local_access_quota_cooldown.rs: credits/spend_control can
// keep an account usable after its included rate-limit windows are exhausted.
function usableCredits(value:Record<string,unknown>):boolean {
  const field=(raw:unknown,key:string)=>Object.entries(object(raw)).find(([name])=>name.toLowerCase()===key)?.[1]
  const finite=(raw:unknown)=>typeof raw==='number'?number(raw):typeof raw==='string'&&raw.trim()?number(Number(raw)):undefined
  const positive=(raw:unknown)=>(finite(raw)??0)>0
  const unlimited=(raw:unknown)=>raw===true||typeof raw==='number'&&Number.isFinite(raw)&&raw!==0||typeof raw==='string'&&['true','1','yes'].includes(raw.trim().toLowerCase())
  const limit=field(field(value,'spend_control'),'individual_limit'),credits=field(value,'credits')
  const total=finite(field(limit,'limit')),used=finite(field(limit,'used'))
  return unlimited(field(limit,'unlimited'))||positive(field(limit,'remaining'))||positive(field(limit,'remaining_percent'))||total!==undefined&&used!==undefined&&total>used||unlimited(field(credits,'unlimited'))||positive(field(credits,'remaining'))||positive(field(credits,'balance'))
}
export function parseQuota(value: Record<string, unknown>, now = Date.now()): { quota: Quota; plan?: string } {
  const windows: QuotaWindow[] = []
  const collect = (raw: unknown, prefix: string, label: string) => {
    const rate = object(raw)
    for (const [field, suffix] of [['primary_window', '短周期'], ['secondary_window', '周周期']]) {
      if (!rate[field] || typeof rate[field] !== 'object' || Array.isArray(rate[field])) continue
      const window = object(rate[field])
      const used = number(window.used_percent), duration = number(window.limit_window_seconds)
      const absolute = number(window.reset_at), after = number(window.reset_after_seconds)
      windows.push({
        id: `${prefix}.${field}`, name: `${label}${suffix}`, usedPercent: used === undefined ? undefined : Math.max(0, Math.min(100, used)),
        durationSeconds: duration && duration > 0 ? duration : undefined,
        resetsAt: absolute !== undefined && absolute > 0 ? (absolute > 10_000_000_000 ? absolute : absolute * 1000) : after !== undefined && after >= 0 ? now + after * 1000 : undefined,
        allowed: boolean(rate.allowed), limitReached: boolean(rate.limit_reached)
      })
    }
  }
  collect(value.rate_limit, 'main', '')
  collect(value.code_review_rate_limit, 'review', '代码审查 · ')
  if (Array.isArray(value.additional_rate_limits)) {
    for (const [index, raw] of value.additional_rate_limits.slice(0, 100).entries()) {
      const entry = object(raw)
      collect(entry.rate_limit, `extra${index}`, `${nonempty(entry.limit_name) ?? nonempty(entry.metered_feature) ?? '附加模型'} · `)
    }
  }
  const rate = object(value.rate_limit)
  const resetCredits = quotaNumber(quotaField(quotaField(value, 'rate_limit_reset_credits'), 'available_count'))
  return { plan: nonempty(value.plan_type), quota: {
    updatedAt: now, windows, allowed: boolean(rate.allowed), limitReached: boolean(rate.limit_reached), hasUsableCredits: usableCredits(value),
    credits: parseCreditUsage(quotaField(value, 'credits'), false, now),
    spendLimit: parseCreditUsage(quotaField(quotaField(value, 'spend_control'), 'individual_limit'), true, now),
    resetCreditsAvailable: resetCredits !== undefined && Number.isSafeInteger(resetCredits) && resetCredits >= 0 ? resetCredits : undefined
  } }
}

export interface SubscriptionSnapshot { accountId?: string; plan?: string; activeUntil?: number; source?: 'token' | 'web' }

export function parseSubscriptionTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  if (/^\d+$/.test(raw)) return parseSubscriptionTimestamp(Number(raw))
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export interface ResetCreditsSnapshot { availableCount?: number; credits: ResetCredit[]; nextExpiresAt?: number }

function resetCreditStatus(value: unknown, expiresAt: number | undefined, now: number): string | undefined {
  const status = nonempty(value)?.toLowerCase()
  if (status) return status
  return expiresAt !== undefined && expiresAt <= now ? 'expired' : undefined
}

export function parseResetCreditsSnapshot(value: Record<string, unknown>, now = Date.now()): ResetCreditsSnapshot {
  const root = object(value), data = object(root.data)
  const raw = root.credits ?? data.credits
  const credits: ResetCredit[] = Array.isArray(raw) ? raw.slice(0, 100).flatMap(item => {
    const record = object(item), expiresAt = parseSubscriptionTimestamp(record.expires_at ?? record.expire_at ?? record.expiresAt)
    const status = resetCreditStatus(record.status ?? record.state, expiresAt, now)
    return [<ResetCredit>{
      id: nonempty(record.id) ?? nonempty(record.credit_id) ?? nonempty(record.creditId), status,
      resetType: nonempty(record.type) ?? nonempty(record.reset_type) ?? nonempty(record.resetType),
      grantedAt: parseSubscriptionTimestamp(record.granted_at ?? record.created_at ?? record.grantedAt), expiresAt,
      redeemedAt: parseSubscriptionTimestamp(record.redeemed_at ?? record.used_at ?? record.consumed_at ?? record.redeemedAt)
    }]
  }) : []
  const rawCount = root.available_count ?? root.availableCount ?? data.available_count ?? data.availableCount
  const count = typeof rawCount === 'number' ? rawCount : typeof rawCount === 'string' && rawCount.trim() ? Number(rawCount) : undefined
  const availableCount = count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : credits.filter(credit => !['redeemed', 'used', 'consumed', 'expired'].includes(credit.status ?? '') && (credit.expiresAt === undefined || credit.expiresAt > now)).length
  const nextExpiresAt = credits.filter(credit => !['redeemed', 'used', 'consumed', 'expired'].includes(credit.status ?? '') && credit.expiresAt !== undefined && credit.expiresAt > now).map(credit => credit.expiresAt!).sort((a, b) => a - b)[0]
  return { availableCount, credits, nextExpiresAt }
}

function subscriptionRecordParts(value: unknown): Array<{ key?: string; record: Record<string, unknown> }> {
  const root = object(value), raw = root.accounts
  if (Array.isArray(raw)) return raw.flatMap(item => {
    const record = object(item)
    return Object.keys(record).length ? [{ record }] : []
  })
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return Object.entries(raw).flatMap(([key, item]) => {
    const record = object(item)
    return Object.keys(record).length ? [{ key, record }] : []
  })
  return []
}

export function parseSubscriptionSnapshot(value: Record<string, unknown>, preferredAccountId?: string): SubscriptionSnapshot {
  const records = subscriptionRecordParts(value)
  const preferred = preferredAccountId?.trim() || undefined
  const recordAccountId = (record: Record<string, unknown>) => {
    const nested = object(record.account)
    return nonempty(nested.account_id) ?? nonempty(nested.id) ?? nonempty(nested.chatgpt_account_id) ?? nonempty(nested.workspace_id)
      ?? nonempty(record.account_id) ?? nonempty(record.id) ?? nonempty(record.chatgpt_account_id) ?? nonempty(record.workspace_id)
  }
  const matched = preferred ? records.find(({ key, record }) => recordAccountId(record) === preferred || key === preferred) : undefined
  // Subscription discovery is a read operation, never a workspace switch.
  if (preferred && records.length && !matched) return { accountId: preferred }
  const selected = matched ?? records.find(({ record }) => object(record.account).is_default === true || record.is_default === true)
    ?? records.find(({ record }) => {
      const nested = object(record.account), plan = nonempty(object(record.entitlement).subscription_plan) ?? nonempty(nested.plan_type) ?? nonempty(record.plan_type)
      return !!plan && !plan.toLowerCase().includes('free')
    }) ?? records[0]
  if (selected) {
    const nested = object(selected.record.account), entitlement = object(selected.record.entitlement)
    return {
      accountId: recordAccountId(selected.record) ?? selected.key,
      plan: nonempty(entitlement.subscription_plan) ?? nonempty(nested.plan_type) ?? nonempty(nested.planType) ?? nonempty(selected.record.plan_type) ?? nonempty(selected.record.planType),
      activeUntil: parseSubscriptionTimestamp(entitlement.expires_at ?? nested.expires_at ?? selected.record.expires_at ?? selected.record.active_until)
    }
  }
  if (preferred && nonempty(value.account_id) && nonempty(value.account_id) !== preferred) return { accountId: preferred }
  return {
    accountId: nonempty(value.account_id) ?? preferred,
    plan: nonempty(value.subscription_plan) ?? nonempty(value.plan_type),
    activeUntil: parseSubscriptionTimestamp(value.active_until ?? value.expires_at)
  }
}

function subscriptionHeaders(account: StoredAccount, targetPath: string): Record<string, string> {
  const accessToken = account.credentials.accessToken
  if (!accessToken) throw new Error('账号缺少访问令牌，请重新登录')
  return {
    Accept: 'application/json', Authorization: `Bearer ${accessToken}`,
    Referer: 'https://chatgpt.com/', 'User-Agent': 'Codex Desktop/0.1.0',
    'x-openai-target-path': targetPath, 'x-openai-target-route': targetPath,
    ...(account.credentials.accountId ? { 'ChatGPT-Account-Id': account.credentials.accountId } : {})
  }
}

function subscriptionMissingOrExpired(value: number | undefined, now = Date.now()): boolean {
  return value === undefined || value <= now
}

function currentTokenSubscription(account: StoredAccount, now = Date.now()) {
  const snapshot = subscriptionFromToken(account.credentials)
  if (!snapshot || snapshot.activeUntil <= now) return
  if (account.subscriptionActiveUntil !== undefined && account.subscriptionActiveUntil > now
    && (account.subscriptionSource === 'web' || account.subscriptionSource === undefined && account.subscriptionQueryLastSuccessAt !== undefined)) return
  if (account.subscriptionActiveUntil === undefined || account.subscriptionActiveUntil === snapshot.activeUntil) return snapshot
  // A cached token must not replace an entitlement observed more recently by
  // the web API (or an imported snapshot with unknown observation time).
  if (snapshot.observedAt !== undefined && account.subscriptionQueryLastSuccessAt !== undefined
    && snapshot.observedAt > account.subscriptionQueryLastSuccessAt) return snapshot
}

function subscriptionWebHeaders(account: StoredAccount, targetPath: string): Record<string, string> {
  const headers = subscriptionHeaders(account, targetPath)
  headers['User-Agent'] = CHATGPT_WEB_USER_AGENT
  delete headers['ChatGPT-Account-Id']
  return headers
}

interface SubscriptionJob { account: StoredAccount; controller: AbortController; task: Promise<void>; preferWeb: boolean }

export class QuotaService {
  private status: RefreshStatus = { running: false, total: 0, completed: 0, failed: 0, cancelled: false }
  private controller?: AbortController
  private job?: Promise<void>
  private timer?: NodeJS.Timeout
  private readonly scheduled = new Map<string, { minutes: number; due: number }>()
  private readonly subscriptionJobs = new Map<string, SubscriptionJob>()
  private subscriptionTail: Promise<void> = Promise.resolve()
  private stopping = false
  constructor(private readonly store: Store, private readonly tokens: TokenAuthority, private readonly request: JSONRequest = requestJSON,
    private readonly agents?: AgentIdentityService,private readonly onUpdated:(account:StoredAccount)=>void=()=>{},private readonly suspended:()=>boolean=()=>false) {}
  current(): RefreshStatus { return { ...this.status, ...(this.subscriptionJobs.size ? { subscriptionPending: this.subscriptionJobs.size } : {}) } }
  busy(id?: string): boolean { return this.status.running || (id ? this.subscriptionJobs.has(id) : this.subscriptionJobs.size > 0) }
  schedule(): void {
    clearTimeout(this.timer)
    if (this.stopping) return
    const state = this.store.read(), now = Date.now()
    const alive = new Set<string>()
    // API keys enter automatic refresh only after an explicit successful query.
    for (const account of state.accounts.filter(a => a.kind !== 'api_key' || a.providerUsage?.summary && !a.providerUsage.unavailable)) {
      const minutes = groupRefreshMinutes(account.id, state.groups, state.settings.refreshMinutes)
      if (minutes <= 0) continue
      alive.add(account.id)
      const prior = this.scheduled.get(account.id)
      if (!prior || prior.minutes !== minutes) this.scheduled.set(account.id, { minutes, due: now + minutes * 60_000 })
    }
    for (const id of this.scheduled.keys()) if (!alive.has(id)) this.scheduled.delete(id)
    if (!this.scheduled.size) return
    const next = Math.min(...[...this.scheduled.values()].map(item => item.due))
    this.timer = setTimeout(() => {
      if (!this.status.running && !this.suspended()) {
        const ids = [...this.scheduled].filter(([, item]) => item.due <= Date.now()).map(([id]) => id)
        if (ids.length) this.start(ids)
      }
      this.schedule()
    }, Math.max(1000, next - now))
    this.timer.unref()
  }
  startAll(): void { this.start(bulkRefreshIds(this.store.read())) }
  start(ids: string[]): void {
    if (this.stopping) throw new Error('应用正在退出')
    if (this.status.running) throw new Error('用量刷新正在进行')
    const wanted = new Set(ids)
    const accounts = this.store.read().accounts.filter(a => wanted.has(a.id))
    if (accounts.length !== wanted.size) throw new Error('部分账号不存在，请重新加载')
    for (const account of accounts) {
      const scheduled = this.scheduled.get(account.id)
      if (scheduled) scheduled.due = Date.now() + scheduled.minutes * 60_000
    }
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.status = { running: accounts.length > 0, total: accounts.length, completed: 0, failed: 0, cancelled: false }
    if (!accounts.length) { this.controller = undefined; this.job = Promise.resolve(); return }
    let index = 0
    const worker = async () => {
      while (!signal.aborted && index < accounts.length) {
        const account = accounts[index++]
        try {
          const current = this.store.read().accounts.find(value => value.id === account.id)
          if (account.kind === 'api_key') {
            if (sameUsageAccount(current, account)) await this.refreshProvider(account, signal)
          } else if (current && current.generation === account.generation) await this.refresh(account.id, signal)
        }
        catch (error) {
          if (!signal.aborted) {
            this.status.failed++
            // Never erase the last successful measurement on a temporary failure.
            this.store.transaction(state => {
              const current = state.accounts.find(a => a.id === account.id)
              if (account.kind === 'api_key') {
                if (sameUsageAccount(current, account)) current.providerUsage = {
                  summary: current.providerUsage?.summary, checkedAt: Date.now(),
                  unavailable: error instanceof ProviderUsageUnavailable,
                  error: error instanceof Error ? error.message : '服务商额度查询失败'
                }
              } else if (current&&current.generation===account.generation) { current.error = error instanceof Error ? error.message : '用量查询失败'; current.errorAt = Date.now() }
            })
          }
        } finally { this.status.completed++ }
      }
    }
    this.job = Promise.all(Array.from({ length: Math.min(3, accounts.length) }, worker)).then(() => {}, () => {
      this.status.failed++
    }).finally(() => { this.status.running = false; this.controller = undefined; this.schedule() })
  }
  private async refreshProvider(account: StoredAccount, signal: AbortSignal): Promise<void> {
    const summary = await queryProviderUsage(account, signal, this.request)
    signal.throwIfAborted()
    this.store.transaction(state => {
      const current = state.accounts.find(value => value.id === account.id)
      if (sameUsageAccount(current, account)) current.providerUsage = { summary, checkedAt: Date.now() }
    })
    // Provider balances never enter OAuth window/cooldown scheduling.
  }
  /** Refresh the ChatGPT subscription/entitlement snapshot without changing quota windows. */
  async refreshSubscriptionInfo(id: string): Promise<void> {
    if (this.stopping) throw new Error('应用正在退出')
    if (this.status.running) throw new Error('已有用量或订阅刷新正在进行')
    const account = this.store.read().accounts.find(value => value.id === id)
    if (!account) throw new Error('账号不存在，请重新加载')
    if (account.kind === 'api_key') throw new Error('API Key 账号不支持刷新订阅信息')
    if (account.kind === 'agent_identity') throw new Error('Agent Identity 账号暂不支持刷新订阅信息')
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.status = { running: true, total: 1, completed: 0, failed: 0, cancelled: false }
    this.job = (async () => {
      let enqueued = false
      try {
        const current = await this.tokens.ensure(id)
        signal.throwIfAborted()
        if (current.generation !== account.generation) return
        if (current.kind === 'api_key' || current.kind === 'agent_identity') throw new Error('该账号类型不支持刷新订阅信息')
        const job = this.enqueueSubscription(current, true)
        if (!job) throw new Error('订阅查询已暂停，请稍后重试')
        enqueued = true
        await job
        signal.throwIfAborted()
      } catch (error) {
        if (!signal.aborted) {
          this.status.failed++
          if (!enqueued) this.saveSubscriptionError(account, error instanceof Error ? error.message : '订阅信息查询失败')
          throw error
        }
      } finally {
        this.status.completed = 1
        this.status.running = false
        this.controller = undefined
      }
    })()
    await this.job
  }
  async refreshResetCreditsInfo(id: string): Promise<void> {
    if (this.status.running) throw new Error('已有用量或订阅刷新正在进行')
    const account = this.store.read().accounts.find(value => value.id === id)
    if (!account) throw new Error('账号不存在，请重新加载')
    if (account.kind === 'api_key') throw new Error('API Key 账号不支持查询主动重置额度')
    if (account.kind === 'agent_identity') throw new Error('Agent Identity 账号暂不支持查询主动重置额度')
    this.controller = new AbortController(); const signal = this.controller.signal
    this.status = { running: true, total: 1, completed: 0, failed: 0, cancelled: false }
    this.job = (async () => {
      try {
        const current = await this.tokens.ensure(id)
        if (current.kind !== 'oauth') throw new Error('该账号类型不支持查询主动重置额度')
        const result = await this.queryResetCredits(current, signal)
        signal.throwIfAborted(); this.saveResetCredits(current, result)
      } catch (error) {
        if (!signal.aborted) { this.status.failed++; throw error }
      } finally { this.status.completed = 1; this.status.running = false; this.controller = undefined }
    })()
    await this.job
  }
  async consumeResetCredit(id: string): Promise<void> {
    if (this.status.running) throw new Error('已有用量或额度操作正在进行')
    const account = this.store.read().accounts.find(value => value.id === id)
    if (!account) throw new Error('账号不存在，请重新加载')
    if (account.kind !== 'oauth') throw new Error('只有 OAuth 账号支持主动重置额度')
    if ((account.quota?.resetCreditsAvailable ?? 0) <= 0) throw new Error('当前没有可用的主动重置额度')
    this.controller = new AbortController(); const signal = this.controller.signal
    this.status = { running: true, total: 1, completed: 0, failed: 0, cancelled: false }
    this.job = (async () => {
      try {
        const current = await this.tokens.ensure(id)
        if (current.kind !== 'oauth') throw new Error('该账号类型不支持主动重置额度')
        const headers = { ...subscriptionHeaders(current, '/backend-api/wham/rate-limit-reset-credits/consume'), 'Content-Type': 'application/json' }
        await this.request(RESET_CREDITS_CONSUME_URL, { method: 'POST', headers, body: JSON.stringify({ redeem_request_id: randomUUID() }), signal }, '使用主动重置额度', current)
        signal.throwIfAborted()
        const refreshed = await this.queryResetCredits(current, signal)
        this.saveResetCredits(current, refreshed)
      } catch (error) {
        if (!signal.aborted) { this.status.failed++; throw error }
      } finally { this.status.completed = 1; this.status.running = false; this.controller = undefined }
    })()
    await this.job
  }
  private async refresh(id: string, signal: AbortSignal): Promise<void> {
    let account = await this.tokens.ensure(id)
    if (account.kind === 'agent_identity') {
      if (!this.agents) throw new Error('Agent Identity 服务未初始化')
      const result = await this.agents.query(id, USAGE_URL, signal)
      signal.throwIfAborted()
      this.save(result.account, result.value)
      return
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted()
        const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${account.credentials.accessToken}` }
        if (account.credentials.accountId) headers['ChatGPT-Account-Id'] = account.credentials.accountId
        try {
          const value = await this.request(USAGE_URL, { headers, signal }, '查询用量',account)
          signal.throwIfAborted()
          this.save(account, value)
          return
        } catch (error) {
          if (error instanceof HTTPError && error.status === 401 && attempt === 0 && !signal.aborted) {
            const current=this.store.read().accounts.find(value=>value.id===account.id)
            if(!current||current.generation!==account.generation)return
            account = await this.tokens.ensure(id, { force: true, rejectedToken: account.credentials.accessToken })
          } else throw error
        }
      }
    } finally {
      // Query even after a usage failure, but never delay or downgrade the
      // independent quota result. Cancellation does not launch new requests.
      if (!signal.aborted) void this.enqueueSubscription(account)?.catch(() => {})
    }
  }
  private enqueueSubscription(account: StoredAccount, force = false): Promise<void> | undefined {
    if (this.stopping || account.kind !== 'oauth' || this.suspended()) return
    const pending = this.subscriptionJobs.get(account.id)
    if (pending && pending.account.generation === account.generation) {
      if (force) pending.preferWeb = true
      return pending.task
    }
    pending?.controller.abort()
    const now = Date.now()
    const tokenSubscription = currentTokenSubscription(account, now)
    const fresh = (account.subscriptionQueryLastSuccessAt ?? 0) + SUBSCRIPTION_CACHE_MS > now
    if (!force && (((account.subscriptionQueryNextRetryAt ?? 0) > now && !tokenSubscription)
      || fresh && !account.subscriptionQueryLastError
        && (account.subscriptionActiveUntil === undefined || !subscriptionMissingOrExpired(account.subscriptionActiveUntil, now)))) return
    const controller = new AbortController()
    let current = account
    const job: SubscriptionJob = { account, controller, task: Promise.resolve(), preferWeb: force }
    job.task = this.subscriptionTail.then(async () => {
      controller.signal.throwIfAborted()
      const saved = this.store.read().accounts.find(value => value.id === account.id)
      if (!saved || saved.kind !== 'oauth' || saved.generation !== account.generation || this.suspended()) return
      current = await this.tokens.ensure(account.id)
      controller.signal.throwIfAborted()
      if (current.kind !== 'oauth' || current.generation !== account.generation) return
      const result = await this.querySubscription(current, controller.signal, job.preferWeb)
      controller.signal.throwIfAborted()
      this.saveSubscription(current, result)
    }).catch(error => {
      if (!controller.signal.aborted) this.saveSubscriptionError(current, error instanceof Error ? error.message : '订阅信息查询失败')
      throw error
    }).finally(() => { if (this.subscriptionJobs.get(account.id) === job) this.subscriptionJobs.delete(account.id) })
    this.subscriptionJobs.set(account.id, job)
    // Only one subscription request chain runs at once, including across quota
    // batches and manual refreshes. A failed job cannot poison the next one.
    this.subscriptionTail = job.task.catch(() => {})
    return job.task
  }
  private async querySubscription(account: StoredAccount, signal: AbortSignal, preferWeb = false): Promise<SubscriptionSnapshot> {
    signal.throwIfAborted()
    // The login response already carries the entitlement for this workspace.
    // Read that real date first; the web endpoints are needed only if it is
    // absent or expired, not for every account's ordinary quota refresh.
    const tokenSubscription = currentTokenSubscription(account)
    // A manual refresh explicitly asks for a current upstream observation.
    if (tokenSubscription && !preferWeb) return {...tokenSubscription,source:'token'}
    const claimAccountId = (token?: string) => nonempty(object(tokenClaims(token)['https://api.openai.com/auth']).chatgpt_account_id)
    const preferred = account.credentials.accountId ?? claimAccountId(account.credentials.idToken) ?? claimAccountId(account.credentials.accessToken)
    const checkPath = '/backend-api/accounts/check/v4-2023-04-27'
    const checkURL = `${ACCOUNT_CHECK_URL}?timezone_offset_min=${new Date().getTimezoneOffset()}`
    const checked = await this.request(checkURL, { headers: subscriptionWebHeaders(account, checkPath), signal }, '查询订阅账号信息', account)
    signal.throwIfAborted()
    let snapshot = parseSubscriptionSnapshot(checked, preferred)
    if (preferred && snapshot.accountId && snapshot.accountId !== preferred) throw new Error('订阅接口返回的账号身份不匹配')
    if (subscriptionMissingOrExpired(snapshot.activeUntil) || !snapshot.plan) {
      const accountId = snapshot.accountId ?? preferred
      if (!accountId) throw new Error('订阅接口未返回账号标识，无法继续查询')
      const url = `${SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(accountId)}`
      const subscription = await this.request(url, { headers: subscriptionWebHeaders(account, '/backend-api/subscriptions'), signal }, '查询订阅信息', account)
      signal.throwIfAborted()
      const next = parseSubscriptionSnapshot(subscription, accountId)
      snapshot = { accountId, plan: next.plan ?? snapshot.plan, activeUntil: next.activeUntil ?? snapshot.activeUntil }
    }
    if (!snapshot.activeUntil && !snapshot.plan) throw new Error('订阅接口未返回可识别的套餐或有效期')
    return {...snapshot,source:'web'}
  }
  private async queryResetCredits(account: StoredAccount, signal: AbortSignal): Promise<ResetCreditsSnapshot> {
    const value = await this.request(RESET_CREDITS_URL, { headers: subscriptionHeaders(account, '/backend-api/wham/rate-limit-reset-credits'), signal }, '查询主动重置额度', account)
    return parseResetCreditsSnapshot(value)
  }
  private saveSubscription(account: StoredAccount, result: SubscriptionSnapshot): void {
    let updated: StoredAccount | undefined
    this.store.transaction(state => {
      const current = state.accounts.find(value => value.id === account.id)
      if (!current || current.kind !== account.kind || current.generation !== account.generation || current.credentials.accessToken !== account.credentials.accessToken
        || current.credentials.idToken !== account.credentials.idToken || current.credentials.accountId !== account.credentials.accountId) return
      if (result.plan) current.plan = result.plan.toLowerCase() === 'chatgptplusplan' ? 'plus' : result.plan
      if (result.activeUntil !== undefined) {
        current.subscriptionActiveUntil = result.activeUntil
        current.subscriptionSource = result.source ?? 'web'
      }
      current.subscriptionQueryLastAttemptAt = Date.now()
      current.subscriptionQueryLastSuccessAt = Date.now()
      delete current.subscriptionQueryNextRetryAt
      delete current.subscriptionQueryLastError
      updated = structuredClone(current)
    })
    if (updated) this.onUpdated(updated)
  }
  private saveSubscriptionError(account: StoredAccount, message: string): void {
    this.store.transaction(state => {
      const current = state.accounts.find(value => value.id === account.id)
      if (!current || current.kind !== account.kind || current.generation !== account.generation || current.credentials.accessToken !== account.credentials.accessToken
        || current.credentials.idToken !== account.credentials.idToken || current.credentials.accountId !== account.credentials.accountId) return
      current.subscriptionQueryLastAttemptAt = Date.now()
      current.subscriptionQueryNextRetryAt = Date.now() + SUBSCRIPTION_RETRY_MS
      current.subscriptionQueryLastError = message.slice(0, 16_384)
    })
  }
  private saveResetCredits(account: StoredAccount, result: ResetCreditsSnapshot): void {
    this.store.transaction(state => {
      const current = state.accounts.find(value => value.id === account.id)
      if (!current || current.kind !== account.kind || current.generation !== account.generation || current.credentials.accessToken !== account.credentials.accessToken) return
      current.quota ??= { updatedAt: Date.now(), windows: [] }
      current.quota.resetCreditsAvailable = result.availableCount
      current.quota.resetCredits = result.credits
      current.quota.resetCreditsNextExpiresAt = result.nextExpiresAt
    })
  }
  private save(account: StoredAccount, value: Record<string, unknown>): void {
    const result = parseQuota(value)
    let updated:StoredAccount|undefined
    this.store.transaction(state => {
      const current = state.accounts.find(a => a.id === account.id)
      if (!current || current.kind !== account.kind || current.generation!==account.generation) return
      if (account.kind === 'agent_identity' ? !sameAgentKey(current.credentials.agentIdentity, account.credentials.agentIdentity)
        : current.credentials.accessToken !== account.credentials.accessToken) return
      current.quota = result.quota
      if (result.plan) current.plan = result.plan
      delete current.error; delete current.errorAt
      updated=structuredClone(current)
    })
    if(updated)this.onUpdated(updated)
  }
  cancel(): void {
    if (this.controller || this.subscriptionJobs.size) this.status.cancelled = true
    this.controller?.abort()
    for (const job of this.subscriptionJobs.values()) job.controller.abort()
  }
  async settled(): Promise<void> { await this.job }
  async subscriptionsSettled(): Promise<void> { await this.subscriptionTail }
  async stop(): Promise<void> { this.stopping = true; clearTimeout(this.timer); this.cancel(); await Promise.allSettled([this.settled(), this.subscriptionsSettled()]); clearTimeout(this.timer) }
}
