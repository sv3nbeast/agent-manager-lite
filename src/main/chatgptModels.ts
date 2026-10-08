import { createHash } from 'node:crypto'
import { z } from 'zod'
import { modelIdSchema } from '../shared/modelCatalog'
import type { Store, StoredAccount } from './store'
import type { TokenAuthority } from './tokens'
import type { AgentIdentityService } from './agentIdentity'
import { agentAssertion } from './agentIdentityCredentials'
import { accountProxyURL } from './proxyPolicy'
import { HTTPError, requestJSON, type JSONRequest } from './network'

const inputSchema = z.object({ accountId: z.string().uuid(), requestId: z.string().uuid(), applicationId: z.string().min(1).max(100), force: z.boolean().optional() }).strict()
const modelSchema = z.object({
  slug: modelIdSchema, visibility: z.string().max(100).optional(), priority: z.number().finite().optional()
}).passthrough()
const listSchema = z.object({ models: z.array(modelSchema).min(1).max(1000) }).passthrough()
const clientVersionSchema = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/)
const operation = '获取 ChatGPT 官方模型'
const changedMessage = '账号身份、凭据或网络配置已变化，请重新获取模型'
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export interface ChatGPTModelsResult {
  requestId: string; accountId: string; models: string[]; defaultModelId: string | null
  source: 'official' | 'cache'; fetchedAt: number
}
interface CacheEntry { key: string; models: string[]; defaultModelId: string | null; fetchedAt: number }
interface ActiveRequest { accountId: string; controller: AbortController; task: Promise<ChatGPTModelsResult> }
export interface ChatGPTModelsOptions {
  resolveClientVersion: (applicationId: string, signal: AbortSignal) => Promise<string>
  timeoutMs?: number; cacheTTL?: number; now?: () => number
}

/** Official account-scoped discovery. Credentials and cache keys remain in main. */
export class ChatGPTModels {
  private readonly active = new Map<string, ActiveRequest>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly controller = new AbortController()
  private readonly timeoutMs: number
  private readonly cacheTTL: number
  private readonly now: () => number
  constructor(private readonly store: Store, private readonly tokens: Pick<TokenAuthority, 'ensure'>,
    private readonly request: JSONRequest = requestJSON, private readonly agents: Pick<AgentIdentityService, 'ensure'> | undefined,
    private readonly options: ChatGPTModelsOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000; this.cacheTTL = options.cacheTTL ?? 5 * 60_000; this.now = options.now ?? Date.now
  }

  busy(accountId?: string): boolean { return [...this.active.values()].some(value => accountId === undefined || value.accountId === accountId) }
  fetch(raw: unknown): Promise<ChatGPTModelsResult> {
    const input = inputSchema.parse(raw)
    if (this.controller.signal.aborted) throw new Error('应用正在退出')
    if (this.active.has(input.requestId) || this.busy(input.accountId)) throw new Error('此账号正在获取模型，请等待或取消当前请求')
    const before = this.account(input.accountId), beforeIdentity = this.identity(before), beforeNetwork = this.network(before)
    if (this.active.size >= 4) throw new Error('模型查询繁忙，请稍后重试')
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.controller.signal])
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    const task = Promise.resolve().then(async () => {
      try {
        const clientVersion = clientVersionSchema.parse(await this.wait(this.options.resolveClientVersion(input.applicationId, signal), signal))
        this.check(before, beforeIdentity, beforeNetwork, this.credentials(before))
        const key = this.cacheKey(before, input.applicationId, clientVersion), cached = this.cache.get(before.id)
        if (!input.force && cached?.key === key && this.now() - cached.fetchedAt >= 0 && this.now() - cached.fetchedAt < this.cacheTTL) {
          this.cache.delete(before.id); this.cache.set(before.id, cached)
          return { requestId: input.requestId, accountId: before.id, models: [...cached.models], defaultModelId: cached.defaultModelId,
            source: 'cache' as const, fetchedAt: cached.fetchedAt }
        }
        if (cached) this.cache.delete(before.id)
        const modelsURL = new URL('https://chatgpt.com/backend-api/codex/models')
        // The official model endpoint compares the core release version;
        // prerelease/build identifiers remain available in the client UA.
        modelsURL.searchParams.set('client_version', clientVersion.split(/[+-]/, 1)[0])
        let account = await this.wait(this.tokens.ensure(before.id), signal)
        if (account.kind === 'agent_identity') {
          if (!this.agents) throw new Error('Agent Identity 服务未初始化')
          account = await this.wait(this.agents.ensure(before.id), signal)
        }
        this.check(account, beforeIdentity, beforeNetwork)
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted()
          const credentials = this.credentials(account), headers = this.headers(account, clientVersion)
          try {
            const body = await this.wait(this.request(modelsURL.toString(), { method: 'GET', headers, redirect: 'error', signal }, operation, account), signal)
            signal.throwIfAborted(); this.check(account, beforeIdentity, beforeNetwork, credentials)
            const parsed = listSchema.safeParse(body)
            if (!parsed.success || body.error !== undefined) throw new Error('官方模型列表响应格式无效')
            const secrets = [account.credentials.accessToken, account.credentials.refreshToken, account.credentials.idToken,
              account.credentials.agentIdentity?.agent_private_key, account.credentials.agentIdentity?.task_id, headers.Authorization].filter((value): value is string => !!value)
            const seen = new Set<string>()
            // ChatGPT clients expose only "list" entries. supported_in_api is
            // a separate public-API restriction; availability_nux is an intro.
            const visible = parsed.data.models.filter(model => model.visibility === 'list')
              .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
              .filter(model => {
                if (secrets.some(secret => model.slug.includes(secret))) return false
                const id = model.slug.toLowerCase()
                if (seen.has(id)) return false
                seen.add(id); return true
              })
            if (!visible.length) throw new Error('官方未返回可用模型')
            const models = visible.map(model => model.slug), defaultModelId = models[0]
            const fetchedAt = this.now(), entry = { key: this.cacheKey(account, input.applicationId, clientVersion), models, defaultModelId, fetchedAt }
            this.cache.delete(account.id); this.cache.set(account.id, entry)
            while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
            return { requestId: input.requestId, accountId: account.id, models: [...models], defaultModelId, source: 'official' as const, fetchedAt }
          } catch (error) {
            if (attempt !== 0 || !(error instanceof HTTPError) || error.status !== 401 || signal.aborted) throw error
            // Another authority caller may already have rotated this rejected
            // token/task. Preserve principal and network fences, then let the
            // existing rejected-token compare-and-swap reuse newer credentials.
            this.check(account, beforeIdentity, beforeNetwork, undefined, true)
            account = account.kind === 'agent_identity'
              ? await this.wait(this.agents!.ensure(account.id, account.credentials.agentIdentity?.task_id), signal)
              : await this.wait(this.tokens.ensure(account.id, { force: true, rejectedToken: account.credentials.accessToken }), signal)
            this.check(account, beforeIdentity, beforeNetwork)
          }
        }
        throw new Error('官方模型查询失败')
      } catch (error) {
        if (timedOut) throw new Error('获取官方模型超时，请检查账号网络代理后重试')
        if (signal.aborted) throw new Error('已取消获取官方模型')
        if (error instanceof HTTPError) throw new HTTPError(error.status, operation, undefined, error.diagnostic)
        if (error instanceof Error && [changedMessage, '官方模型列表响应格式无效', '官方未返回可用模型'].includes(error.message)) throw error
        throw new Error('获取官方模型失败，请检查账号登录和网络代理后重试')
      } finally { clearTimeout(timer); this.active.delete(input.requestId) }
    })
    this.active.set(input.requestId, { accountId: before.id, controller, task })
    return task
  }
  async cancel(raw: unknown): Promise<void> {
    const requestId = z.string().uuid().parse(raw), active = this.active.get(requestId)
    active?.controller.abort(); await active?.task.catch(() => {})
  }
  async stop(): Promise<void> {
    this.controller.abort(); this.cache.clear()
    await Promise.allSettled([...this.active.values()].map(value => value.task))
  }
  private account(id: string): StoredAccount {
    const account = this.store.read().accounts.find(value => value.id === id)
    if (!account || !['oauth', 'agent_identity'].includes(account.kind)) throw new Error('请选择 ChatGPT 登录账号获取官方模型')
    return account
  }
  private identity(account: StoredAccount): string {
    const agent = account.credentials.agentIdentity
    return digest({ id: account.id, generation: account.generation, kind: account.kind, accountId: account.credentials.accountId,
      ...(agent ? { runtime: agent.agent_runtime_id, account: agent.account_id, user: agent.chatgpt_user_id, key: agent.agent_private_key } : {}) })
  }
  private credentials(account: StoredAccount): string { return digest(account.credentials) }
  private network(account: StoredAccount): string {
    const state = this.store.proxyState(), resourceId = account.proxy?.resourceId ?? (!account.proxy ? state.unifiedProxy?.resourceId : undefined)
    return digest({ effective: accountProxyURL(account, state), proxy: account.proxy,
      ...(!account.proxy ? { global: state.upstreamProxy, unified: state.unifiedProxy } : {}),
      resource: resourceId ? state.proxyResources?.find(value => value.id === resourceId) : undefined })
  }
  private cacheKey(account: StoredAccount, applicationId: string, clientVersion: string): string { return digest([this.identity(account), this.credentials(account), this.network(account), applicationId, clientVersion]) }
  private check(account: StoredAccount, identity: string, network: string, credentials?: string, allowRotatedCredentials = false): void {
    let current: StoredAccount
    try { current = this.account(account.id) } catch { throw new Error(changedMessage) }
    if (this.identity(account) !== identity || this.identity(current) !== identity || this.network(account) !== network || this.network(current) !== network
      || !allowRotatedCredentials && (this.credentials(current) !== this.credentials(account) || credentials !== undefined && this.credentials(current) !== credentials)) throw new Error(changedMessage)
  }
  private headers(account: StoredAccount, clientVersion: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', originator: 'codex_cli_rs',
      'User-Agent': `codex_cli_rs/${clientVersion} (${process.platform}; ${process.arch})` }
    if (account.kind === 'agent_identity') {
      const identity = account.credentials.agentIdentity
      if (!identity) throw new Error('Agent Identity 凭据缺失')
      headers.Authorization = agentAssertion(identity); headers['ChatGPT-Account-Id'] = identity.account_id
      if (identity.chatgpt_account_is_fedramp) headers['X-OpenAI-Fedramp'] = 'true'
    } else {
      if (!account.credentials.accessToken) throw new Error('登录凭据缺失')
      headers.Authorization = `Bearer ${account.credentials.accessToken}`
      if (account.credentials.accountId) headers['ChatGPT-Account-Id'] = account.credentials.accountId
    }
    return headers
  }
  private wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('已取消获取官方模型')) }, cleanup = () => signal.removeEventListener('abort', abort)
      promise.then(value => { cleanup(); signal.aborted ? reject(new Error('已取消获取官方模型')) : resolve(value) }, error => { cleanup(); reject(error) })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
  }
}
