import { Store, type StoredAccount } from './store'
import { nonempty, object, requestJSON, type JSONRequest } from './network'

// Protocol values adapted from Cockpit codex_oauth.rs at the pinned source baseline.
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
export const identityHeaders = { originator: 'Codex Desktop', 'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`, 'Content-Type': 'application/json', Accept: 'application/json' }
export type Tokens = Pick<StoredAccount['credentials'], 'accessToken' | 'refreshToken' | 'idToken' | 'accountId'>
export function tokenClaims(token?: string): Record<string, unknown> {
  try { return object(JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString())) } catch { return {} }
}
export function tokenFresh(token?: string, leadSeconds = 300): boolean {
  const exp = tokenClaims(token).exp
  return typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 > Date.now() + leadSeconds * 1000
}
export function parseTokens(value: Record<string, unknown>, previous: Tokens = {}): Tokens {
  const accessToken = nonempty(value.access_token)
  if (!accessToken) throw new Error('授权响应缺少 access_token')
  const idToken = nonempty(value.id_token) ?? previous.idToken
  if (!tokenFresh(idToken)) throw new Error('授权响应缺少有效的 id_token，请重新登录')
  const accountId = nonempty(object(tokenClaims(idToken)['https://api.openai.com/auth']).chatgpt_account_id)
    ?? nonempty(object(tokenClaims(accessToken)['https://api.openai.com/auth']).chatgpt_account_id) ?? previous.accountId
  if (previous.accountId && accountId !== previous.accountId) throw new Error('刷新返回的账号身份不匹配，请重新登录')
  return { accessToken, idToken, refreshToken: nonempty(value.refresh_token) ?? previous.refreshToken, accountId }
}

// A single authority owns refresh-token rotation; sidecar auto-refresh is disabled.
export class TokenAuthority {
  private readonly pending = new Map<string, Promise<StoredAccount>>()
  private readonly controller = new AbortController()
  private external?: (id:string,options:{force?:boolean;rejectedToken?:string})=>Promise<StoredAccount>
  constructor(private readonly store: Store, private readonly request: JSONRequest = requestJSON,
    private readonly project: (account: StoredAccount) => void | Promise<void> = () => {}) {}
  setExternalAuthority(resolve:(id:string,options:{force?:boolean;rejectedToken?:string})=>Promise<StoredAccount>):void {this.external=resolve}
  busy(id:string):boolean {return this.pending.has(id)}
  ensure(id: string, options: { force?: boolean; rejectedToken?: string } = {}): Promise<StoredAccount> {
    if(this.store.read().clientSwitches?.some(record=>record.status!=='committed'&&(record.accountId===id||record.previousAccountId===id)))return Promise.reject(new Error('客户端切换尚未完成，请先恢复；凭据刷新已暂停'))
    const pending = this.pending.get(id)
    if (pending) {
      if(options.force&&this.store.read().clientAuthorities?.some(binding=>binding.accountId===id))return pending.then(account=>{
        // A concurrent ordinary file sync does not refresh credentials. It
        // cannot turn an upstream rejection of the same token into success.
        if(!options.rejectedToken||options.rejectedToken===account.credentials.accessToken)throw new Error('客户端凭据被上游拒绝，请在客户端重新登录后重试')
        return account
      })
      return pending
    }
    const state=this.store.read(),account = state.accounts.find(a => a.id === id)
    if (!account) return Promise.reject(new Error('账号已删除'))
    if (this.controller.signal.aborted) return Promise.reject(new Error('应用正在退出'))
    if(state.clientAuthorities?.some(binding=>binding.accountId===id)){
      // Persisted links must fail closed even before the resolver is installed
      // after restart; never fall back to rotating the copied refresh token.
      if(!this.external)return Promise.reject(new Error('客户端凭据同步尚未就绪，本地刷新已暂停'))
      const operation=Promise.resolve().then(()=>this.external!(id,options)).finally(()=>this.pending.delete(id))
      this.pending.set(id,operation);return operation
    }
    if (account.kind !== 'oauth') return Promise.resolve(account)
    // A competing 401 may refer to credentials already rotated by another caller.
    if (options.rejectedToken && account.credentials.accessToken !== options.rejectedToken) return Promise.resolve(account)
    if (!options.force && tokenFresh(account.credentials.accessToken) && tokenFresh(account.credentials.idToken, 600)) return Promise.resolve(account)
    if (!account.credentials.refreshToken) {
      // PATs/opaque access tokens carry no local expiry claim; the provider is
      // authoritative. A known expired JWT or an upstream 401 is still rejected.
      const expiry = tokenClaims(account.credentials.accessToken).exp
      if (!options.force && account.credentials.accessToken && (tokenFresh(account.credentials.accessToken) || expiry === undefined)) return Promise.resolve(account)
      return Promise.reject(new Error('登录已过期且没有 refresh_token，请重新登录'))
    }
    const operation = this.refresh(account).finally(() => this.pending.delete(id))
    this.pending.set(id, operation)
    return operation
  }
  private async refresh(before: StoredAccount): Promise<StoredAccount> {
    const value = await this.request(TOKEN_ENDPOINT, {
      method: 'POST', headers: identityHeaders, signal: this.controller.signal,
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: before.credentials.refreshToken })
    }, '刷新登录',before)
    const tokens = parseTokens(value, before.credentials)
    // Commit rotated credentials before runtime projection, even if shutdown was requested.
    let updated: StoredAccount | undefined
    this.store.transaction(state => {
      const current = state.accounts.find(a => a.id === before.id)
      if (!current) throw new Error('账号已删除，刷新结果已丢弃')
      if(current.generation!==before.generation)throw new Error('账号已重新恢复，旧刷新结果已丢弃')
      if (current.credentials.refreshToken !== before.credentials.refreshToken || current.credentials.accessToken !== before.credentials.accessToken) {
        updated = structuredClone(current); return
      }
      current.credentials = { ...current.credentials, ...tokens }
      const identity = tokenClaims(tokens.idToken)
      current.email = nonempty(identity.email) ?? current.email
      current.plan = nonempty(object(identity['https://api.openai.com/auth']).chatgpt_plan_type) ?? current.plan
      delete current.error; delete current.errorAt
      updated = structuredClone(current)
    })
    await this.project(updated!)
    return updated!
  }
  async stop(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([...this.pending.values()])
  }
}
