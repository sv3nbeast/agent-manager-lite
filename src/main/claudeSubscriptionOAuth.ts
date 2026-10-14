import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { nonempty, requestJSON, type JSONRequest } from './network'

/**
 * Claude.ai subscription login is deliberately kept separate from the generic
 * OpenAI OAuth implementation.  The redirect is owned by Anthropic's console:
 * the browser displays a short code which can be pasted back into the app.
 */
export const CLAUDE_SUBSCRIPTION_OAUTH = Object.freeze({
  authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
  tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
  profileEndpoint: 'https://api.anthropic.com/api/oauth/profile',
  usageEndpoint: 'https://api.anthropic.com/api/oauth/usage',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  // Public OAuth client identifier used by the official Claude Code flow. It
  // is not a credential; callers may override it for a verified deployment.
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  anthropicVersion: '2023-06-01',
})

export const CLAUDE_SUBSCRIPTION_CLIENT_ID = CLAUDE_SUBSCRIPTION_OAUTH.clientId
export const CLAUDE_SUBSCRIPTION_AUTHORIZATION_ENDPOINT = CLAUDE_SUBSCRIPTION_OAUTH.authorizationEndpoint
export const CLAUDE_SUBSCRIPTION_TOKEN_ENDPOINT = CLAUDE_SUBSCRIPTION_OAUTH.tokenEndpoint
export const CLAUDE_SUBSCRIPTION_REDIRECT_URI = CLAUDE_SUBSCRIPTION_OAUTH.redirectUri

export interface ClaudeSubscriptionTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
  scope?: string
}

/** Safe identity fields suitable for an Account card or AppSnapshot. */
export interface ClaudeSubscriptionProfile {
  accountId?: string
  organizationId?: string
  organizationName?: string
  email?: string
  name?: string
  plan?: string
  expiresAt?: number
  fetchedAt: number
  /** Additional non-secret fields from the profile response, already redacted. */
  details?: Record<string, unknown>
}

export interface ClaudeSubscriptionUsageWindow {
  id: string
  utilization?: number
  resetsAt?: number
  details?: Record<string, unknown>
}

export interface ClaudeSubscriptionUsage {
  windows: ClaudeSubscriptionUsageWindow[]
  fetchedAt: number
  details?: Record<string, unknown>
}

export interface ClaudeSubscriptionMetadata {
  profile?: ClaudeSubscriptionProfile
  usage?: ClaudeSubscriptionUsage
  tokenType?: string
  scope?: string
  expiresAt?: number
  retrievedAt: number
}

export interface ClaudeSubscriptionLoginResult {
  tokens: ClaudeSubscriptionTokens
  profile?: ClaudeSubscriptionProfile
  usage?: ClaudeSubscriptionUsage
  metadata: ClaudeSubscriptionMetadata
}

export type ClaudeSubscriptionOAuthStatus = {
  id?: string
  status: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'success' | 'error' | 'cancelled'
  authorizationUrl?: string
  redirectUri?: string
  expiresAt?: number
  accountId?: string
  error?: string
  metadata?: ClaudeSubscriptionMetadata
}

export interface ClaudeSubscriptionOAuthOptions {
  request?: JSONRequest
  open?: (url: string) => Promise<void>
  save?: (result: ClaudeSubscriptionLoginResult) => string | Promise<string | void> | void
  authorizationEndpoint?: string
  tokenEndpoint?: string
  profileEndpoint?: string
  usageEndpoint?: string
  redirectUri?: string
  clientId?: string
  scope?: string
  timeoutMs?: number
  now?: () => number
}

type Pending = {
  id: string
  state: string
  verifier: string
  expiresAt: number
  controller: AbortController
  timer?: NodeJS.Timeout
  exchanging?: boolean
}

const SECRET_KEY = /(?:access|refresh|id)[_.-]?token|(?:api|auth|bearer)[_.-]?(?:key|token)|secret|credential|verifier|authorization.?code|password|cookie/i
const META_LIMIT = 32
const STRING_LIMIT = 512

function finitePositive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(number) || number <= 0) return undefined
  return number
}
function expiry(value: unknown, now: number): number | undefined {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0) {
    const absolute = numeric < 10_000_000_000 ? numeric * 1000 : numeric
    return absolute > now - 60_000 && absolute < now + 10 * 365 * 86_400_000 ? absolute : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && parsed > now - 60_000 ? parsed : undefined
  }
  return undefined
}

/** Redact untrusted API objects before they can enter status, diagnostics or Store metadata. */
export function safeClaudeSubscriptionMetadata(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, META_LIMIT).map(item => safeClaudeSubscriptionMetadata(item, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, META_LIMIT)) {
    if (SECRET_KEY.test(key)) continue
    const safe = safeClaudeSubscriptionMetadata(item, depth + 1)
    if (safe !== undefined) output[key.slice(0, 100)] = safe
  }
  return output
}

function metadata(value: unknown): Record<string, unknown> {
  const safe = safeClaudeSubscriptionMetadata(value)
  return safe && typeof safe === 'object' && !Array.isArray(safe) ? safe as Record<string, unknown> : {}
}

function field(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim()
  return undefined
}
function normalizedProfile(value: Record<string, unknown>, fetchedAt: number): ClaudeSubscriptionProfile {
  const organization = value.organization && typeof value.organization === 'object' && !Array.isArray(value.organization) ? value.organization as Record<string, unknown> : {}
  const account = value.account && typeof value.account === 'object' && !Array.isArray(value.account) ? value.account as Record<string, unknown> : {}
  const details = metadata(value)
  return {
    accountId: field(value, ['accountId', 'account_id', 'account_uuid', 'uuid']) ?? field(account, ['id', 'uuid', 'account_id']),
    organizationId: field(value, ['organizationId', 'organization_id', 'organization_uuid', 'orgId', 'org_id']) ?? field(organization, ['id', 'uuid', 'organization_id']),
    organizationName: field(value, ['organizationName', 'organization_name']) ?? field(organization, ['name']),
    email: field(value, ['email', 'emailAddress', 'email_address']) ?? field(account, ['email', 'email_address']),
    name: field(value, ['name', 'displayName', 'display_name']) ?? field(account, ['name']),
    plan: field(value, ['plan', 'planType', 'plan_type', 'subscription_plan']),
    expiresAt: expiry(value.expiresAt ?? value.expires_at ?? value.subscriptionExpiresAt ?? value.subscription_expires_at, fetchedAt),
    fetchedAt,
  }
}
function normalizedUsage(value: Record<string, unknown>, fetchedAt: number): ClaudeSubscriptionUsage {
  const windows: ClaudeSubscriptionUsageWindow[] = []
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = raw as Record<string, unknown>
    const utilization = typeof row.utilization === 'number' && Number.isFinite(row.utilization) && row.utilization >= 0 && row.utilization <= 100 ? row.utilization : undefined
    const resetsAt = expiry(row.resetsAt ?? row.resets_at, fetchedAt)
    if (utilization !== undefined || resetsAt !== undefined) windows.push({ id, ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) })
  }
  return { windows, fetchedAt }
}

function tokenResponse(value: Record<string, unknown>, previous?: ClaudeSubscriptionTokens, now = Date.now()): ClaudeSubscriptionTokens {
  const accessToken = nonempty(value.access_token)
  if (!accessToken || accessToken.length > 100_000) throw new Error('Claude 授权响应缺少有效访问令牌')
  const refreshToken = nonempty(value.refresh_token) ?? previous?.refreshToken
  const expiresIn = finitePositive(value.expires_in)
  if (refreshToken && refreshToken.length > 100_000) throw new Error('Claude 授权响应刷新令牌无效')
  const expiresAt = expiry(value.expires_at, now) ?? (expiresIn && expiresIn <= 366 * 86400 ? now + expiresIn * 1000 : undefined)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(nonempty(value.token_type) ? { tokenType: nonempty(value.token_type) } : previous?.tokenType ? { tokenType: previous.tokenType } : {}),
    ...(nonempty(value.scope) ? { scope: nonempty(value.scope) } : previous?.scope ? { scope: previous.scope } : {}),
  }
}

function safeError(error: unknown, fallback: string): string {
  // Network/HTTP errors in this project are already operation-scoped. Never
  // forward errors from custom transports since they may echo request bodies.
  return fallback
}

export function createClaudeSubscriptionPKCE(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') }
}

export function buildClaudeSubscriptionAuthorizeUrl(input: {
  state: string
  codeChallenge: string
  authorizationEndpoint?: string
  clientId?: string
  redirectUri?: string
  scope?: string
}): string {
  if (!input.state || !input.codeChallenge) throw new Error('OAuth PKCE 参数无效')
  const url = new URL(input.authorizationEndpoint ?? CLAUDE_SUBSCRIPTION_OAUTH.authorizationEndpoint)
  if (url.username || url.password || url.hash) throw new Error('Claude OAuth 地址无效')
  url.search = new URLSearchParams({
    code: 'true', client_id: input.clientId ?? CLAUDE_SUBSCRIPTION_OAUTH.clientId,
    response_type: 'code', redirect_uri: input.redirectUri ?? CLAUDE_SUBSCRIPTION_OAUTH.redirectUri,
    scope: input.scope ?? CLAUDE_SUBSCRIPTION_OAUTH.scope, state: input.state,
    code_challenge: input.codeChallenge, code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

export class ClaudeSubscriptionOAuthService {
  private pending?: Pending
  private last: ClaudeSubscriptionOAuthStatus = { status: 'idle' }
  private readonly request: JSONRequest
  private readonly now: () => number
  private readonly options: Required<Pick<ClaudeSubscriptionOAuthOptions, 'authorizationEndpoint' | 'tokenEndpoint' | 'profileEndpoint' | 'usageEndpoint' | 'redirectUri' | 'clientId' | 'scope'>>

  constructor(options: ClaudeSubscriptionOAuthOptions = {}) {
    this.request = options.request ?? requestJSON
    this.now = options.now ?? Date.now
    this.options = {
      authorizationEndpoint: options.authorizationEndpoint ?? CLAUDE_SUBSCRIPTION_OAUTH.authorizationEndpoint,
      tokenEndpoint: options.tokenEndpoint ?? CLAUDE_SUBSCRIPTION_OAUTH.tokenEndpoint,
      profileEndpoint: options.profileEndpoint ?? CLAUDE_SUBSCRIPTION_OAUTH.profileEndpoint,
      usageEndpoint: options.usageEndpoint ?? CLAUDE_SUBSCRIPTION_OAUTH.usageEndpoint,
      redirectUri: options.redirectUri ?? CLAUDE_SUBSCRIPTION_OAUTH.redirectUri,
      clientId: options.clientId ?? CLAUDE_SUBSCRIPTION_OAUTH.clientId,
      scope: options.scope ?? CLAUDE_SUBSCRIPTION_OAUTH.scope,
    }
    this.save = options.save
    this.open = options.open
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
  }
  private readonly save?: ClaudeSubscriptionOAuthOptions['save']
  private readonly open?: ClaudeSubscriptionOAuthOptions['open']
  private readonly timeoutMs: number

  current(): ClaudeSubscriptionOAuthStatus { return structuredClone(this.last) }
  private active(pending: Pending): boolean { return this.pending === pending && !pending.controller.signal.aborted && pending.expiresAt > this.now() }
  private authorizationUrl(pending: Pending): string { return buildClaudeSubscriptionAuthorizeUrl({ state: pending.state, codeChallenge: createHash('sha256').update(pending.verifier).digest('base64url'), authorizationEndpoint: this.options.authorizationEndpoint, clientId: this.options.clientId, redirectUri: this.options.redirectUri, scope: this.options.scope }) }

  async start(): Promise<ClaudeSubscriptionOAuthStatus> {
    if (this.pending) throw new Error('已有 Claude 订阅登录正在进行，请完成或取消后重试')
    const pkce = createClaudeSubscriptionPKCE()
    const pending: Pending = { id: randomUUID(), state: pkce.state, verifier: pkce.verifier, expiresAt: this.now() + this.timeoutMs, controller: new AbortController() }
    this.pending = pending
    pending.timer = setTimeout(() => this.finish(pending, { status: 'error', error: 'Claude 订阅登录超时，请重新开始' }), this.timeoutMs)
    pending.timer.unref()
    this.last = { id: pending.id, status: 'starting', expiresAt: pending.expiresAt }
    try {
      this.last = { id: pending.id, status: 'waiting', authorizationUrl: this.authorizationUrl(pending), redirectUri: this.options.redirectUri, expiresAt: pending.expiresAt }
      if (this.open) await this.open(this.last.authorizationUrl!)
      return this.current()
    } catch (error) {
      this.finish(pending, { status: 'error', error: safeError(error, '无法打开 Claude 授权页面') })
      return this.current()
    }
  }
  async openAuthorization(): Promise<void> {
    if (!this.pending || !this.active(this.pending)) throw new Error('没有等待 Claude 订阅授权')
    if (this.open) await this.open(this.authorizationUrl(this.pending))
  }
  async callback(callbackUrl: string): Promise<ClaudeSubscriptionOAuthStatus> {
    const pending = this.pending
    if (!pending || !this.active(pending)) throw new Error('没有等待 Claude 订阅授权')
    let url: URL
    try { url = new URL(callbackUrl) } catch { throw new Error('Claude OAuth 回调链接格式无效') }
    const expected = new URL(this.options.redirectUri)
    if (callbackUrl.length > 16_384 || url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.pathname !== expected.pathname || url.hash || url.username || url.password) throw new Error('Claude OAuth 回调地址不匹配')
    const state = url.searchParams.get('state')
    if (url.searchParams.getAll('state').length !== 1 || !state || !this.equal(state, pending.state)) throw new Error('Claude OAuth 回调 state 校验失败')
    if (url.searchParams.has('error')) { this.finish(pending, { status: 'error', error: 'Claude 授权被拒绝，请重新登录' }); throw new Error('Claude 授权被拒绝') }
    const code = url.searchParams.get('code')
    if (url.searchParams.getAll('code').length !== 1 || !code?.trim()) throw new Error('Claude OAuth 回调缺少授权码')
    await this.exchange(pending, code)
    return this.current()
  }
  /** Claude's console may show `code#state`; accept that value as manual input. */
  async manualCode(input: string): Promise<ClaudeSubscriptionOAuthStatus> {
    const pending = this.pending
    if (!pending || !this.active(pending)) throw new Error('没有等待 Claude 订阅授权')
    const value = input.trim()
    if (!value || value.length > 16_384) throw new Error('Claude OAuth 手动授权码无效')
    const separator = value.lastIndexOf('#')
    const code = separator > 0 ? value.slice(0, separator) : value
    const state = separator > 0 ? value.slice(separator + 1) : undefined
    if (separator >= 0 && (!state || !this.equal(state, pending.state))) throw new Error('Claude OAuth 手动授权码 state 校验失败')
    await this.exchange(pending, code)
    return this.current()
  }
  complete(input: string): Promise<ClaudeSubscriptionOAuthStatus> { return input.includes('://') ? this.callback(input) : this.manualCode(input) }
  private equal(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }

  async exchangeCode(code: string, verifier: string, redirectUri = this.options.redirectUri, signal?: AbortSignal, state?: string): Promise<ClaudeSubscriptionTokens> {
    if (!code.trim() || !verifier.trim()) throw new Error('Claude OAuth 授权码或 PKCE verifier 无效')
    try {
      const value = await this.request(this.options.tokenEndpoint, { method: 'POST', signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: this.options.clientId, code, redirect_uri: redirectUri, code_verifier: verifier, ...(state ? { state } : {}) }) }, '完成 Claude 授权')
      return tokenResponse(value, undefined, this.now())
    } catch { throw new Error('Claude 授权响应无效或请求失败，请重试') }
  }
  async refresh(tokens: ClaudeSubscriptionTokens): Promise<ClaudeSubscriptionTokens> {
    if (!tokens.refreshToken) throw new Error('Claude 订阅凭据缺少 refresh_token')
    try {
      const value = await this.request(this.options.tokenEndpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: this.options.clientId, refresh_token: tokens.refreshToken }) }, '刷新 Claude 订阅登录')
      return tokenResponse(value, tokens, this.now())
    } catch { throw new Error('Claude 订阅刷新失败，请重新登录') }
  }
  async profile(tokens: ClaudeSubscriptionTokens): Promise<ClaudeSubscriptionProfile> { return normalizedProfile(await this.api(this.options.profileEndpoint, tokens, '读取 Claude 账号资料'), this.now()) }
  async usage(tokens: ClaudeSubscriptionTokens): Promise<ClaudeSubscriptionUsage> { return normalizedUsage(await this.api(this.options.usageEndpoint, tokens, '读取 Claude 订阅用量'), this.now()) }
  private async api(url: string, tokens: ClaudeSubscriptionTokens, operation: string): Promise<Record<string, unknown>> {
    if (!tokens.accessToken) throw new Error('Claude 订阅凭据缺少 access_token')
    try {
      return await this.request(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${tokens.accessToken}`, 'anthropic-version': CLAUDE_SUBSCRIPTION_OAUTH.anthropicVersion } }, operation)
    } catch { throw new Error(`${operation}失败，请稍后重试`) }
  }
  private async exchange(pending: Pending, code: string): Promise<void> {
    if (!this.active(pending) || pending.exchanging) throw new Error('Claude 订阅登录已取消、过期或正在完成')
    pending.exchanging = true
    this.last = { id: pending.id, status: 'exchanging', expiresAt: pending.expiresAt }
    try {
      const tokens = await this.exchangeCode(code, pending.verifier, this.options.redirectUri, pending.controller.signal, pending.state)
      if (!this.active(pending)) throw new Error('Claude 订阅登录已取消')
      const profile = await this.profile(tokens).catch(() => undefined)
      const usage = await this.usage(tokens).catch(() => undefined)
      if (!this.active(pending)) throw new Error('Claude 订阅登录已取消')
      const result: ClaudeSubscriptionLoginResult = { tokens, ...(profile ? { profile } : {}), ...(usage ? { usage } : {}), metadata: { ...(profile ? { profile } : {}), ...(usage ? { usage } : {}), ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}), ...(tokens.scope ? { scope: tokens.scope } : {}), ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}), retrievedAt: this.now() } }
      const accountId = this.save ? await this.save(result) : undefined
      this.finish(pending, { status: 'success', ...(typeof accountId === 'string' && accountId ? { accountId } : {}), metadata: result.metadata })
    } catch (error) {
      if (this.active(pending)) this.finish(pending, { status: 'error', error: safeError(error, 'Claude 订阅授权失败，请重试') })
      throw new Error('Claude 订阅授权失败或已取消，请重试')
    }
  }
  private finish(pending: Pending, status: Partial<ClaudeSubscriptionOAuthStatus>): void {
    if (this.pending !== pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.controller.abort(); this.pending = undefined
    this.last = { id: pending.id, status: status.status ?? 'idle', ...status }
  }
  cancel(): void { if (this.pending) this.finish(this.pending, { status: 'cancelled' }) }
  async stop(): Promise<void> { this.cancel() }
}

/** Short alias for callers that do not need the longer service name. */
export const ClaudeSubscriptionOAuth = ClaudeSubscriptionOAuthService
export const sanitizeClaudeSubscriptionMetadata = safeClaudeSubscriptionMetadata
