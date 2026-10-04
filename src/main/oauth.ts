import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { LoginStatus } from '../shared/types'
import { nonempty, HTTPError, requestJSON, type JSONRequest } from './network'
import { CLIENT_ID, identityHeaders, parseTokens, TOKEN_ENDPOINT, type Tokens } from './tokens'

const AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize'
const DEVICE_CODE_ENDPOINT = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_POLL_ENDPOINT = 'https://auth.openai.com/api/accounts/deviceauth/token'
const DEVICE_URL = 'https://auth.openai.com/codex/device'
const DEVICE_REDIRECT = 'https://auth.openai.com/deviceauth/callback'
interface Pending {
  public: LoginStatus; controller: AbortController; verifier: string; state: string
  redirect: string; url?: string; server?: Server; timeout?: NodeJS.Timeout; exchanging: boolean
}
interface Options { callbackPort?: number; timeoutMs?: number; deviceTimeoutMs?: number; request?: JSONRequest; open: (url: string) => Promise<void>; save: (tokens: Tokens) => string | Promise<string> }

// Adapted from Cockpit browser/device flows. Pending secrets stay in the main
// process; cancelling/closing never writes another application's auth.json.
export class OAuthLogin {
  private pending?: Pending
  private last: LoginStatus = { status: 'idle' }
  private readonly request: JSONRequest
  constructor(private readonly options: Options) { this.request = options.request ?? requestJSON }
  current(): LoginStatus { return { ...(this.pending?.public ?? this.last) } }
  private active(pending: Pending): boolean { return this.pending === pending && !pending.controller.signal.aborted }
  async start(method: 'browser' | 'device'): Promise<LoginStatus> {
    if (this.pending) throw new Error('已有登录正在进行，请完成或取消后重试')
    const pending: Pending = {
      public: { id: randomUUID(), method, status: 'starting', expiresAt: Date.now() + (method === 'browser' ? this.options.timeoutMs ?? 300_000 : this.options.deviceTimeoutMs ?? 900_000) },
      controller: new AbortController(), verifier: randomBytes(32).toString('base64url'), state: randomBytes(32).toString('base64url'), redirect: '', exchanging: false
    }
    this.pending = pending
    pending.timeout = setTimeout(() => this.finish(pending, { status: 'error', error: '登录超时，请重新开始' }), pending.public.expiresAt! - Date.now())
    try {
      if (method === 'browser') await this.browser(pending)
      else await this.device(pending)
    } catch (error) {
      if (this.active(pending)) this.finish(pending, { status: 'error', error: error instanceof Error ? error.message : '登录失败' })
    }
    return this.current()
  }
  private async browser(pending: Pending): Promise<void> {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      if (req.method !== 'GET' || !req.url?.startsWith('/auth/callback?')) { res.writeHead(404).end('Not found'); return }
      void this.acceptCallback(pending, `${pending.redirect.split('/auth/callback')[0]}${req.url}`).then(() => {
        res.end('登录成功，请返回 Agent Manager Lite。')
      }, () => { if (!res.destroyed) res.writeHead(400).end('授权失败或回调无效，请返回 Agent Manager Lite 查看状态。') })
    })
    pending.server = server
    server.requestTimeout = 30_000; server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Error('登录回调端口被占用或不可用，请使用设备码登录')))
      server.listen(this.options.callbackPort ?? 1455, '127.0.0.1', () => resolve())
    })
    if (!this.active(pending)) { server.close(); server.closeAllConnections(); return }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法获取登录回调地址')
    pending.redirect = `http://localhost:${address.port}/auth/callback`
    const url = new URL(AUTH_ENDPOINT)
    url.search = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: pending.redirect,
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256',
      id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state: pending.state, originator: 'Codex Desktop'
    }).toString()
    pending.url = url.toString(); pending.public.status = 'waiting'
    await this.options.open(pending.url)
  }
  private async device(pending: Pending): Promise<void> {
    const value = await this.request(DEVICE_CODE_ENDPOINT, {
      method: 'POST', headers: identityHeaders, signal: pending.controller.signal, body: JSON.stringify({ client_id: CLIENT_ID })
    }, '获取设备码')
    if (!this.active(pending)) return
    const deviceId = nonempty(value.device_auth_id), userCode = nonempty(value.user_code) ?? nonempty(value.usercode)
    if (!deviceId || !userCode) throw new Error('设备授权响应缺少必要字段')
    const interval = Number(value.interval)
    const seconds = Number.isInteger(interval) && interval > 0 ? interval : 5
    pending.redirect = DEVICE_REDIRECT; pending.url = DEVICE_URL
    pending.public = { ...pending.public, status: 'waiting', userCode, verificationUrl: DEVICE_URL }
    // Opening is explicit in the UI so the code is visible before the browser gains focus.
    void this.poll(pending, deviceId, userCode, seconds)
  }
  private async poll(pending: Pending, deviceId: string, userCode: string, seconds: number): Promise<void> {
    try {
      while (this.active(pending)) {
        try {
          const value = await this.request(DEVICE_POLL_ENDPOINT, {
            method: 'POST', headers: identityHeaders, signal: pending.controller.signal,
            body: JSON.stringify({ device_auth_id: deviceId, user_code: userCode })
          }, '等待设备授权')
          if (!this.active(pending)) return
          const code = nonempty(value.authorization_code), verifier = nonempty(value.code_verifier)
          if (!code || !verifier || !nonempty(value.code_challenge)) throw new Error('设备令牌响应缺少必要字段')
          pending.verifier = verifier
          await this.exchange(pending, code)
          return
        } catch (error) {
          // These are the pending statuses used by the pinned upstream flow.
          if (!(error instanceof HTTPError && [403, 404].includes(error.status))) throw error
        }
        await delay(Math.min(seconds, 900) * 1000, undefined, { signal: pending.controller.signal })
      }
    } catch (error) {
      if (this.active(pending)) this.finish(pending, { status: 'error', error: error instanceof Error ? error.message : '设备登录失败' })
    }
  }
  async open(): Promise<void> {
    if (!this.pending?.url || this.pending.public.status !== 'waiting') throw new Error('没有等待授权的登录')
    await this.options.open(this.pending.url)
  }
  async complete(callbackUrl: string): Promise<void> {
    if (!this.pending || this.pending.public.method !== 'browser') throw new Error('没有等待浏览器回调的登录')
    await this.acceptCallback(this.pending, callbackUrl)
  }
  private async acceptCallback(pending: Pending, callbackUrl: string): Promise<void> {
    if (!this.active(pending) || pending.exchanging) throw new Error('登录已结束或正在完成')
    let url: URL
    try { url = new URL(callbackUrl) } catch { throw new Error('回调链接格式无效') }
    const expected = new URL(pending.redirect)
    if (callbackUrl.length > 8192 || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== expected.port || url.pathname !== '/auth/callback' || url.username || url.password || url.hash) throw new Error('回调地址不匹配')
    const state = url.searchParams.getAll('state')
    if (state.length !== 1 || Buffer.byteLength(state[0]) !== Buffer.byteLength(pending.state)
      || !timingSafeEqual(Buffer.from(state[0]), Buffer.from(pending.state))) throw new Error('回调 state 校验失败')
    if (url.searchParams.has('error')) {
      this.finish(pending, { status: 'error', error: '用户拒绝授权或授权失败，请重新登录' })
      throw new Error('授权失败')
    }
    const codes = url.searchParams.getAll('code')
    if (codes.length !== 1 || !codes[0].trim()) throw new Error('回调链接缺少授权码')
    await this.exchange(pending, codes[0])
  }
  private async exchange(pending: Pending, code: string): Promise<void> {
    pending.exchanging = true; pending.public.status = 'exchanging'
    try {
      const value = await this.request(TOKEN_ENDPOINT, {
        method: 'POST', headers: { ...identityHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: pending.controller.signal,
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: pending.redirect, code_verifier: pending.verifier }).toString()
      }, '完成授权')
      if (!this.active(pending)) throw new Error('登录已取消')
      const id = await this.options.save(parseTokens(value))
      this.finish(pending, { status: 'success', accountId: id })
    } catch (error) {
      if (this.active(pending)) this.finish(pending, { status: 'error', error: error instanceof Error ? error.message : '完成授权失败' })
      throw error
    }
  }
  private finish(pending: Pending, status: Partial<LoginStatus>): void {
    if (this.pending !== pending) return
    clearTimeout(pending.timeout)
    // Graceful close preserves the in-flight browser callback response.
    pending.server?.close()
    pending.server?.closeIdleConnections()
    pending.controller.abort()
    this.last = { id: pending.public.id, method: pending.public.method, status: 'idle', ...status }
    this.pending = undefined
  }
  cancel(): void {
    if (this.pending) {
      this.pending.server?.closeAllConnections()
      this.finish(this.pending, { status: 'cancelled' })
    }
  }
}
