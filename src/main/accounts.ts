import { randomUUID } from 'node:crypto'
import { accountInputSchema, accountEditSchema, accountKeyReadSchema, batchTagsSchema, accountIdsSchema, type AccountInput, type ImportPreview, type Quota } from '../shared/types'
import { type StoredAccount, Store } from './store'
import { tokenClaims, type Tokens } from './tokens'
import { removeGroupReferences } from './groups'
import { parseAgentIdentity } from './agentIdentityCredentials'
import { reconcileProviderKeys,providerTierForAccount } from './providerLibrary'
import { providerEndpoint } from '../shared/providerLibrary'
import {accountIdentity,strongIdentityConflict} from './accountIdentity'
import {invalidateProviderUsage} from './providerUsage'
import { parseQuota, parseSubscriptionTimestamp } from './quota'
import { projectSubscriptionClaim } from './subscriptionClaims'
import { providerModelContextWindows } from './providerModelContext'
import { importedAuthRefresh } from './authRefreshMetadata'
import type { ClaudeSubscriptionLoginResult, ClaudeSubscriptionProfile, ClaudeSubscriptionUsage } from './claudeSubscriptionOAuth'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号必须是 JSON 对象')
  return value as Record<string, unknown>
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function claims(token?: string): Record<string, unknown> {
  try { return object(JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString())) } catch { return {} }
}

// Saved connections may intentionally have an empty model catalog. The regular
// create/edit form still requires a model; importing must not invent one.
const importedAPIAccountSchema = accountInputSchema.extend({ models: accountInputSchema.shape.models.min(0) })

function importedCreatedAt(source: Record<string, unknown>): number {
  if (typeof source.createdAt === 'number' && Number.isSafeInteger(source.createdAt) && source.createdAt >= 0) return source.createdAt
  if (source.created_at === 0 || source.created_at === '0') return 0
  return parseSubscriptionTimestamp(source.created_at) ?? Date.now()
}

function importedQuota(source: Record<string, unknown>): Quota | undefined {
  if (!source.quota || typeof source.quota !== 'object' || Array.isArray(source.quota)) return
  const saved = source.quota as Record<string, unknown>
  const updatedAt = parseSubscriptionTimestamp(source.usage_updated_at)
  const raw = saved.raw_data && typeof saved.raw_data === 'object' && !Array.isArray(saved.raw_data)
    ? saved.raw_data as Record<string, unknown> : undefined
  // Relative resets are meaningful only when the source observation time is
  // known. Unknown formats stay intact in source instead of becoming fresh data.
  const quota = raw && updatedAt !== undefined ? parseQuota(raw, updatedAt).quota : { updatedAt: updatedAt ?? 0, windows: [] } as Quota
  if (!quota.windows.some(window => window.id.startsWith('main.'))) {
    const hasPresence = typeof saved.hourly_window_present === 'boolean' || typeof saved.weekly_window_present === 'boolean'
    for (const [prefix, field, label] of [['hourly', 'primary_window', '短周期'], ['weekly', 'secondary_window', '周周期']]) {
      const remaining = saved[`${prefix}_percentage`]
      if (hasPresence && saved[`${prefix}_window_present`] !== true || typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
      const minutes = saved[`${prefix}_window_minutes`]
      quota.windows.push({ id: `main.${field}`, name: label, usedPercent: 100 - Math.max(0, Math.min(100, remaining)),
        resetsAt: parseSubscriptionTimestamp(saved[`${prefix}_reset_time`]),
        durationSeconds: typeof minutes === 'number' && Number.isSafeInteger(minutes * 60) && minutes > 0 ? minutes * 60 : undefined })
    }
  }
  for (const window of quota.windows) {
    if (window.resetsAt !== undefined && (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0)) delete window.resetsAt
    if (window.durationSeconds !== undefined && (!Number.isSafeInteger(window.durationSeconds) || window.durationSeconds <= 0)) delete window.durationSeconds
  }
  const resets = saved.reset_credits_available
  if (typeof resets === 'number' && Number.isSafeInteger(resets) && resets >= 0) quota.resetCreditsAvailable = resets
  if (Array.isArray(saved.reset_credits)) quota.resetCredits = saved.reset_credits.slice(0, 100).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    return [{ id: text(record.id), status: text(record.status), resetType: text(record.reset_type),
      grantedAt: parseSubscriptionTimestamp(record.granted_at), expiresAt: parseSubscriptionTimestamp(record.expires_at), redeemedAt: parseSubscriptionTimestamp(record.redeemed_at) }]
  })
  quota.resetCreditsNextExpiresAt = parseSubscriptionTimestamp(saved.reset_credits_next_expires_at)
  return quota.windows.length || quota.resetCreditsAvailable !== undefined || quota.resetCredits?.length ? quota : undefined
}

export function createAPIAccount(input: AccountInput): StoredAccount {
  const valid = accountInputSchema.parse(input)
  const { apiKey, ...metadata } = valid
  if (!Object.keys(metadata.modelContextWindows ?? {}).length) delete metadata.modelContextWindows
  return {
    ...metadata,
    identityService: valid.identityService ?? 'openai',
    credentialKind: valid.credentialKind ?? (valid.identityService === 'anthropic' ? 'anthropic_api_key' : 'openai_api_key'),
    protocol: valid.protocol ?? (valid.identityService === 'anthropic' ? 'anthropic_messages' : valid.wireApi === 'responses' ? 'openai_responses' : 'openai_chat_completions'),
    id: randomUUID(), kind: 'api_key', createdAt: Date.now(), credentials: { apiKey }
  }
}

// Only an explicit edit request reads a credential; list snapshots stay summaries.
function isAnthropicAccount(account: StoredAccount): boolean {
  return account.identityService === 'anthropic' || account.protocol === 'anthropic_messages'
    || account.credentialKind?.startsWith('anthropic_') === true || account.credentialKind === 'claude_ai_oauth'
}
function editableAnthropicConnection(account: StoredAccount): boolean {
  return account.kind === 'api_key' && account.identityService === 'anthropic' && account.protocol === 'anthropic_messages'
    && ['anthropic_api_key', 'anthropic_bearer', 'gateway'].includes(account.credentialKind ?? '')
}

export function readAccountKey(store: Store, input: unknown): string {
  const { id, revision } = accountKeyReadSchema.parse(input)
  const account = store.read().accounts.find(item => item.id === id)
  if (!account) throw new Error('账号已删除，请重新打开编辑窗口')
  if ((account.revision ?? 0) !== revision) throw new Error('账号已被修改，请重新打开编辑窗口')
  if (account.kind !== 'api_key') throw new Error('登录账号不支持读取 API Key')
  if (isAnthropicAccount(account) && !editableAnthropicConnection(account)) throw new Error('此 Anthropic 凭据类型尚未支持连接编辑')
  if (account.providerId || account.providerKeyId) throw new Error('连接由供应商管理，请在供应商页编辑密钥')
  if (!account.credentials.apiKey) throw new Error('账号未配置 API Key，请重新打开编辑窗口')
  return account.credentials.apiKey
}

export function editAccount(store: Store, input: unknown, inUse: (id: string) => boolean = () => false): void {
  const { id, revision, changes } = accountEditSchema.parse(input)
  store.transaction(state => {
    const account = state.accounts.find(a => a.id === id)
    if (!account) throw new Error('账号已删除')
    if ((account.revision ?? 0) !== revision) throw new Error('账号已被修改，请重新打开编辑窗口')
    if ((['identityService', 'credentialKind', 'protocol'] as const).some(key => changes[key] !== undefined && changes[key] !== account[key])) {
      throw new Error('账号的身份服务、凭据类型和接口协议不可更改，请添加对应类型的新连接')
    }
    const anthropic = isAnthropicAccount(account)
    const connectionFields = ['apiKey', 'baseUrl', 'models', 'wireApi', 'integrationType', 'modelContextWindows']
    if (account.kind !== 'api_key' && connectionFields.some(key => key in changes)) throw new Error('登录账号仅支持修改名称、标签、备注和服务等级')
    if (anthropic) {
      if (!editableAnthropicConnection(account) && connectionFields.some(key => key in changes)) throw new Error('此 Anthropic 凭据类型尚未支持连接编辑，仅可修改名称、标签和备注')
      if (['wireApi', 'modelContextWindows'].some(key => key in changes)) throw new Error('Claude API 连接仅支持修改地址、模型、密钥和额度查询方式，接口协议固定为 Anthropic Messages')
      if ([changes.apiKey, changes.baseUrl, ...(changes.models ?? [])].some(value => value !== undefined && /[\0\r\n]/.test(value))) throw new Error('Claude 连接配置包含无效字符')
    }
    const connectionChanged = changes.apiKey !== undefined && changes.apiKey !== account.credentials.apiKey
      || (['baseUrl', 'models', 'wireApi'] as const).some(key => changes[key] !== undefined && JSON.stringify(changes[key]) !== JSON.stringify(account[key]))
    const integrationChanged = changes.integrationType !== undefined && changes.integrationType !== (account.integrationType ?? 'auto')
    if ((connectionChanged || integrationChanged) && (account.providerId || account.providerKeyId)) throw new Error('连接由供应商管理，请在供应商页修改，或先解除账号关联')
    if (connectionChanged && inUse(id)) throw new Error('请先停止使用该账号的实例、本地服务或解除客户端凭据关联，再修改连接信息')
    // Retargeting a Claude connection must explicitly supply the destination's
    // credential. Never reuse a saved secret merely because it is in the vault.
    if (anthropic && changes.baseUrl !== undefined && providerEndpoint(changes.baseUrl) !== providerEndpoint(account.baseUrl) && changes.apiKey === undefined) {
      throw new Error('Claude API 地址已更改，请重新填写用于此地址的密钥')
    }
    if (changes.baseUrl !== undefined && changes.baseUrl !== account.baseUrl
      || changes.apiKey !== undefined && changes.apiKey !== account.credentials.apiKey || integrationChanged) invalidateProviderUsage(account)
    const { apiKey, integrationType, modelContextWindows, ...metadata } = changes
    Object.assign(account, metadata)
    if (apiKey !== undefined) account.credentials.apiKey = apiKey
    if (integrationType !== undefined) account.integrationType = integrationType
    // An empty declaration clears connection overrides and resumes inheritance.
    if (modelContextWindows !== undefined) {
      if (Object.keys(modelContextWindows).length) account.modelContextWindows = modelContextWindows
      else delete account.modelContextWindows
    }
    if (state.accounts.some(a => a.id !== id && sameAccount(a, account))) throw new Error('此接口和凭据的账号已存在')
    account.tags = [...new Set(account.tags)]
    account.revision = revision + 1
    reconcileProviderKeys(state)
  })
}

export function batchTags(store: Store, input: unknown): void {
  const { ids, mode, tags } = batchTagsSchema.parse(input)
  store.transaction(state => {
    const wanted = new Set(ids)
    if (ids.some(id => !state.accounts.some(a => a.id === id))) throw new Error('部分账号已删除，请重新加载')
    for (const account of state.accounts.filter(a => wanted.has(a.id))) {
      const next = mode === 'replace' ? tags : mode === 'add' ? [...account.tags, ...tags] : account.tags.filter(tag => !tags.includes(tag))
      account.tags = accountInputSchema.shape.tags.parse([...new Set(next)])
      account.revision = (account.revision ?? 0) + 1
    }
  })
}

export function deleteAccounts(store: Store, input: unknown, inUse: (id: string) => boolean = () => false): void {
  const ids = new Set(accountIdsSchema.parse(input))
  if ([...ids].some(inUse)) throw new Error('请先停止相关服务、解除客户端凭据关联或等待凭据刷新完成')
  store.transaction(state => {
    const selected=state.accounts.filter(account=>ids.has(account.id))
    if(selected.length!==ids.size)throw new Error('部分账号已删除，请重新选择')
    if((state.accountRecycle?.length??0)+selected.length>10000)throw new Error('账号回收站最多保存 1 万条，请先导出或清理已有备份')
    state.accountRecycle??=[]
    // Every backup and the live removal publish in one encrypted vault save.
    for(const account of selected)state.accountRecycle.push({id:randomUUID(),deletedAt:Date.now(),account:structuredClone(account),groupIds:state.groups.filter(group=>group.accountIds.includes(account.id)).map(group=>group.id),providerDefault:providerTierForAccount(state,account),providerModelContextWindows:account.providerId ? providerModelContextWindows(state,account) ?? {} : undefined})
    state.accounts = state.accounts.filter(a => !ids.has(a.id))
    removeGroupReferences(state, ids)
    if(state.localAccess){
      const pool=state.localAccess;pool.accountIds=pool.accountIds.filter(id=>!ids.has(id));pool.customRoutingRules=pool.customRoutingRules?.filter(rule=>!ids.has(rule.accountId));pool.revision++
      for(const key of pool.keys){key.accountIds=key.accountIds.filter(id=>!ids.has(id));key.priorityAccountIds=key.priorityAccountIds?.filter(id=>!ids.has(id));key.revision++}
    }
    if(state.wakeup){
      // A task with no remaining account is no longer executable. Keep its
      // bounded history for audit, but remove the orphaned schedule atomically
      // with the account deletion.
      state.wakeup.tasks = state.wakeup.tasks
        .map(task => ({ ...task, accountIds: task.accountIds.filter(id => !ids.has(id)) }))
        .filter(task => task.accountIds.length > 0)
    }
  })
}

// Adapted from Cockpit Codex auth.json/account import semantics; raw source stays in the encrypted vault.
export function parseAccountImport(raw: string): { accounts: StoredAccount[]; preview: ImportPreview } {
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('导入文件超过 16 MB')
  raw = raw.replace(/^\uFEFF/, '').trim()
  if (!raw) throw new Error('导入内容为空')
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.every(line => line.startsWith('{') && line.endsWith('}'))) {
      try { parsed = lines.map(line => JSON.parse(line)) } catch { throw new Error('JSONL 格式错误，请检查每行是否为完整账号对象') }
    } else if (lines.every(line => /^[\w.~+\/-]+$/.test(line))) parsed = lines
    else throw new Error('无法解析账号文件，请使用 JSON、JSONL 或每行一个令牌')
  }
  const items = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? [parsed] : Array.isArray(object(parsed).accounts) ? object(parsed).accounts as unknown[] : [parsed]
  if (items.length > 10000) throw new Error('单次最多导入 10000 个账号')
  const accounts: StoredAccount[] = []
  const preview: ImportPreview = { entries: [], errors: [], skipped: 0 }
  items.forEach((value, index) => {
    try {
      const source = typeof value === 'string'
        ? (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value.trim()) || value.trim().startsWith('at-') ? { access_token: value.trim() } : { refresh_token: value.trim() })
        : object(value)
      const declaredIdentity = text(source.identityService) ?? text(source.identity_service) ?? text(source.provider) ?? text(source.platform)
      const anthropicFields = Object.keys(source).some(key => /^(?:anthropic|claude(?:_|ai)|ANTHROPIC_|CLAUDE_CODE_)/i.test(key))
      if (anthropicFields || declaredIdentity?.toLowerCase() === 'anthropic' || declaredIdentity?.toLowerCase() === 'claude' || text(source.protocol)?.toLowerCase() === 'anthropic_messages') {
        // Anthropic credentials must go through the Claude-specific parser so
        // an access token is never interpreted as an OpenAI OAuth identity.
        preview.skipped!++; return
      }
      if (source.platform !== undefined && (text(source.platform)?.toLowerCase() !== 'openai' || text(source.type)?.toLowerCase() !== 'oauth')) { preview.skipped!++; return }
      const nested = source.credentials ? object(source.credentials) : {}
      const agentIdentity = parseAgentIdentity(source)
      const tokens = source.tokens ? object(source.tokens) : nested
      const take = (...keys: string[]) => {
        for (const container of [tokens, nested, source]) for (const key of keys) { const found = text(container[key]); if (found) return found }
        return undefined
      }
      const apiKey = take('OPENAI_API_KEY', 'openai_api_key', 'apiKey', 'api_key')
      const metadata = {
        name: text(source.name) ?? text(source.account_name) ?? text(source.email),
        note: source.account_note ?? source.note ?? source.notes ?? source.remark ?? source.accountInfo ?? source.account_info ?? '', tags: source.tags ?? [],
        defaultTier: source.defaultTier ?? source.default_tier ?? (source.app_speed === 'fast' ? 'fast'
          : source.app_speed === 'standard' || source.app_speed === 'ultrafast' ? 'standard' : 'inherit')
      }
      let account: StoredAccount
      if (agentIdentity) {
        account = {
          id: randomUUID(), kind: 'agent_identity', identityService: 'openai', credentialKind: 'agent_identity', protocol: 'openai_responses',
          name: accountInputSchema.shape.name.parse(metadata.name ?? agentIdentity.email ?? `Agent Identity ${index + 1}`),
          email: agentIdentity.email, plan: agentIdentity.plan_type,
          baseUrl: 'https://chatgpt.com/backend-api/codex', models: [], wireApi: 'responses',
          defaultTier: accountInputSchema.shape.defaultTier.parse(metadata.defaultTier),
          note: accountInputSchema.shape.note.parse(metadata.note), tags: accountInputSchema.shape.tags.parse(metadata.tags), createdAt: Date.now(),
          credentials: { agentIdentity, accountId: agentIdentity.account_id }
        }
      } else if (apiKey) {
        const { apiKey: importedKey, ...connection } = importedAPIAccountSchema.parse({
          ...metadata, name: metadata.name ?? `API 账号 ${index + 1}`,
          apiKey, baseUrl: text(source.api_base_url) ?? text(source.apiBaseUrl) ?? text(source.base_url) ?? text(source.baseUrl) ?? 'https://api.openai.com/v1',
          models: source.api_model_catalog ?? source.models ?? ['gpt-5.5'],
          wireApi: source.api_wire_api ?? source.wireApi ?? 'responses',
          integrationType: source.integrationType,
          modelContextWindows: source.modelContextWindows ?? source.model_context_windows ?? source.api_model_context_windows
        })
        account = { ...connection, identityService: 'openai', credentialKind: 'openai_api_key', protocol: connection.wireApi === 'responses' ? 'openai_responses' : 'openai_chat_completions', id: randomUUID(), kind: 'api_key', createdAt: Date.now(), credentials: { apiKey: importedKey },
          email: text(source.email), plan: text(source.plan_type) ?? text(source.plan) }
      } else {
        const accessToken = take('access_token', 'accessToken', 'personal_access_token', 'personalAccessToken', 'at_token', 'token')
        const refreshToken = take('refresh_token', 'refreshToken', 'session_token', 'sessionToken')
        if (!accessToken && !refreshToken) throw new Error('缺少 API Key、access_token 或 refresh_token')
        if ([accessToken, refreshToken].some(token => token && token.length > 100000)) throw new Error('令牌长度超出限制')
        const idToken = take('id_token', 'idToken')
        const identity = claims(idToken ?? accessToken)
        const auth = identity['https://api.openai.com/auth'] && typeof identity['https://api.openai.com/auth'] === 'object' ? object(identity['https://api.openai.com/auth']) : {}
        const profile = identity['https://api.openai.com/profile']
        const email = text(source.email) ?? text(identity.email) ?? (profile && typeof profile === 'object' ? text(object(profile).email) : undefined)
        account = {
          id: randomUUID(), kind: 'oauth', identityService: 'openai', credentialKind: 'openai_oauth', protocol: 'openai_responses', name: accountInputSchema.shape.name.parse(metadata.name ?? email ?? `OAuth 账号 ${index + 1}`),
          email, plan: text(source.plan_type) ?? text(auth.chatgpt_plan_type),
          baseUrl: 'https://chatgpt.com/backend-api/codex', models: [], wireApi: 'responses',
          defaultTier: accountInputSchema.shape.defaultTier.parse(metadata.defaultTier),
          note: accountInputSchema.shape.note.parse(metadata.note), tags: accountInputSchema.shape.tags.parse(metadata.tags), createdAt: Date.now(),
          credentials: { accessToken, refreshToken, idToken, accountId: take('account_id', 'accountId') ?? text(auth.chatgpt_account_id) ?? text(auth.account_id),
            lastRefresh: importedAuthRefresh(source,nested) }
        }
      }
      account.createdAt = importedCreatedAt(source)
      const activeUntil = parseSubscriptionTimestamp(source.subscription_active_until ?? source.subscriptionActiveUntil)
      if (activeUntil !== undefined) {
        account.subscriptionActiveUntil = activeUntil
        const subscriptionSource = source.subscription_source ?? source.subscriptionSource
        if (subscriptionSource === 'token' || subscriptionSource === 'web') account.subscriptionSource = subscriptionSource
      }
      else projectSubscriptionClaim(account)
      // Provider quotas can represent money rather than ChatGPT token windows.
      // Preserve those snapshots only in source until their provider parser runs.
      if (account.kind !== 'api_key') account.quota = importedQuota(source)
      account.source = source
      accounts.push(account)
      preview.entries.push({ index, name: account.name, kind: account.kind, needsVerification: account.kind === 'oauth' && !account.credentials.accessToken })
    } catch (error) {
      // Zod enum/type errors can embed untrusted input, including credentials.
      const reason = error instanceof Error && error.name !== 'ZodError' ? error.message : '账号字段格式错误，请检查名称、标签、服务等级和接口配置'
      preview.errors.push(`第 ${index + 1} 项：${reason}`)
    }
  })
  return { accounts, preview }
}

export function sameAccount(a: StoredAccount, b: StoredAccount): boolean {
  // Older vaults predate identity/protocol metadata.  Resolve their
  // read-only compatibility defaults before comparing them with newly
  // imported records; otherwise a duplicate legacy OpenAI key would be
  // imported as a second account merely because the new record is explicit.
  const identityA = a.identityService ?? 'openai'
  const identityB = b.identityService ?? 'openai'
  const protocolA = a.protocol ?? (identityA === 'anthropic' ? 'anthropic_messages' : a.kind === 'api_key' ? (a.wireApi === 'chat_completions' ? 'openai_chat_completions' : 'openai_responses') : 'openai_responses')
  const protocolB = b.protocol ?? (identityB === 'anthropic' ? 'anthropic_messages' : b.kind === 'api_key' ? (b.wireApi === 'chat_completions' ? 'openai_chat_completions' : 'openai_responses') : 'openai_responses')
  const credentialKindA = a.credentialKind ?? (identityA === 'anthropic' ? 'anthropic_api_key' : a.kind === 'oauth' ? 'openai_oauth' : a.kind === 'agent_identity' ? 'agent_identity' : 'openai_api_key')
  const credentialKindB = b.credentialKind ?? (identityB === 'anthropic' ? 'anthropic_api_key' : b.kind === 'oauth' ? 'openai_oauth' : b.kind === 'agent_identity' ? 'agent_identity' : 'openai_api_key')
  if (identityA !== identityB || protocolA !== protocolB) return false
  if(a.kind==='oauth'&&b.kind==='oauth'&&strongIdentityConflict(accountIdentity(a),accountIdentity(b)))return false
  if (a.kind === 'agent_identity' || b.kind === 'agent_identity') {
    const left = a.credentials.agentIdentity, right = b.credentials.agentIdentity
    return a.kind === b.kind && Boolean(left && right && left.account_id === right.account_id && left.chatgpt_user_id === right.chatgpt_user_id)
  }
  return a.kind === b.kind && (a.kind === 'api_key'
    ? identityA === identityB && protocolA === protocolB && credentialKindA === credentialKindB
      && a.credentials.apiKey === b.credentials.apiKey && providerEndpoint(a.baseUrl) === providerEndpoint(b.baseUrl)
    : Boolean(a.credentials.accessToken) && a.credentials.accessToken === b.credentials.accessToken
      || Boolean(a.credentials.refreshToken) && a.credentials.refreshToken === b.credentials.refreshToken
      || Boolean(a.credentials.accountId) && a.credentials.accountId === b.credentials.accountId && a.email === b.email)
}

export function importParsedAccounts(store: Store, accounts: StoredAccount[], collectAccountId?:(id:string)=>void): { added: number; duplicates: number } {
  let added = 0, duplicates = 0
  const accountIds:string[]=[]
  store.transaction(state => {
    for (const account of accounts) {
      const existing=state.accounts.find(candidate => sameAccount(candidate, account))
      if (existing) {duplicates++;accountIds.push(existing.id)}
      else { state.accounts.push(structuredClone(account)); added++;accountIds.push(account.id) }
    }
    reconcileProviderKeys(state)
  })
  // Report only identities actually committed. Duplicate imports resolve to the
  // existing account rather than the temporary ID generated during parsing.
  for(const id of accountIds)collectAccountId?.(id)
  return { added, duplicates }
}

export function importIntoStore(store: Store, raw: string): void {
  const { accounts, preview } = parseAccountImport(raw)
  if (preview.errors.length) throw new Error(preview.errors.join('\n'))
  importParsedAccounts(store, accounts)
}

export function saveOAuthAccount(store: Store, tokens: Tokens): StoredAccount {
  const identity = tokenClaims(tokens.idToken)
  const auth = identity['https://api.openai.com/auth'] && typeof identity['https://api.openai.com/auth'] === 'object' ? object(identity['https://api.openai.com/auth']) : {}
  const email = text(identity.email)
  let result: StoredAccount | undefined
  store.transaction(state => {
    const existing = state.accounts.find(a => a.kind === 'oauth' && (a.credentials.accessToken === tokens.accessToken
      || Boolean(tokens.accountId) && a.credentials.accountId === tokens.accountId && a.email === email))
    if (existing) {
      if(state.clientAuthorities?.some(binding=>binding.accountId===existing.id))throw new Error('此账号由客户端维护登录，请先在客户端退出并解除关联后再重新登录')
      const previousIDToken = existing.credentials.idToken
      existing.credentials = { ...existing.credentials, ...tokens }
      existing.identityService ??= 'openai'
      existing.credentialKind ??= 'openai_oauth'
      existing.protocol ??= 'openai_responses'
      existing.email = email ?? existing.email
      existing.plan = text(auth.chatgpt_plan_type) ?? existing.plan
      projectSubscriptionClaim(existing, { previousIDToken, returnedIDToken: tokens.idToken })
      delete existing.error; delete existing.errorAt
      result = structuredClone(existing)
    } else {
      result = {
        id: randomUUID(), kind: 'oauth', identityService: 'openai', credentialKind: 'openai_oauth', protocol: 'openai_responses', name: email ?? 'ChatGPT 账号', email, plan: text(auth.chatgpt_plan_type),
        baseUrl: 'https://chatgpt.com/backend-api/codex', models: [], wireApi: 'responses',
        defaultTier: 'inherit', note: '', tags: [], createdAt: Date.now(), credentials: { ...tokens }
      }
      projectSubscriptionClaim(result)
      state.accounts.push(result)
    }
  })
  return result!
}

const CLAUDE_SUBSCRIPTION_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest']

function claudeSubscriptionQuota(usage: ClaudeSubscriptionUsage, now = Date.now()): Quota {
  const windows = usage.windows.slice(0, 100).map(window => ({
    id: window.id,
    name: window.id,
    ...(window.utilization !== undefined ? { usedPercent: Math.max(0, Math.min(100, window.utilization)) } : {}),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    ...(window.details ? { details: structuredClone(window.details) } : {}),
    ...(window.utilization !== undefined ? { limitReached: window.utilization >= 100, allowed: window.utilization < 100 } : {})
  }))
  const limitReached = windows.some(window => window.limitReached === true)
  return { updatedAt: usage.fetchedAt || now, windows, ...(windows.length ? { limitReached, allowed: !limitReached } : {}) }
}

function normalizedEmail(value?: string): string | undefined {
  const textValue = text(value)
  return textValue?.toLowerCase()
}

function claudeSubscriptionIdentity(result: ClaudeSubscriptionLoginResult, previous?: StoredAccount['claudeSubscription']): StoredAccount['claudeSubscription'] {
  const profile = result.profile
  const scopes = result.tokens.scope?.split(/\s+/).map(value => value.trim()).filter(Boolean).slice(0, 100)
  return {
    ...previous,
    ...(profile?.accountId ? { accountId: profile.accountId } : {}),
    ...(profile?.organizationId ? { organizationId: profile.organizationId } : {}),
    ...(profile?.organizationName ? { organizationName: profile.organizationName } : {}),
    ...(profile?.fetchedAt ? { verifiedAt: profile.fetchedAt } : previous?.verifiedAt ? { verifiedAt: previous.verifiedAt } : {}),
    ...(profile?.fetchedAt ? { profileFetchedAt: profile.fetchedAt } : previous?.profileFetchedAt ? { profileFetchedAt: previous.profileFetchedAt } : {}),
    ...(result.usage?.fetchedAt ? { usageFetchedAt: result.usage.fetchedAt } : previous?.usageFetchedAt ? { usageFetchedAt: previous.usageFetchedAt } : {}),
    ...(result.tokens.expiresAt ? { tokenExpiresAt: result.tokens.expiresAt } : previous?.tokenExpiresAt ? { tokenExpiresAt: previous.tokenExpiresAt } : {}),
    ...(scopes?.length ? { scopes } : previous?.scopes ? { scopes: previous.scopes } : {})
  }
}

function isClaudeSubscriptionAccount(account: StoredAccount): boolean {
  return account.kind === 'oauth' && account.identityService === 'anthropic' && account.credentialKind === 'claude_ai_oauth'
}

/** Persist a Claude.ai subscription OAuth result without exposing its tokens in the account projection. */
export function saveClaudeSubscriptionAccount(store: Store, result: ClaudeSubscriptionLoginResult, existingId?: string): StoredAccount {
  const profile: ClaudeSubscriptionProfile | undefined = result.profile
  const accountId = text(profile?.accountId)
  const email = normalizedEmail(profile?.email)
  const accessToken = text(result.tokens.accessToken)
  const refreshToken = text(result.tokens.refreshToken)
  if (!accessToken) throw new Error('Claude 订阅登录缺少访问令牌')
  let saved: StoredAccount | undefined
  store.transaction(state => {
    const existing = state.accounts.find(account => {
      if (!isClaudeSubscriptionAccount(account)) return false
      if (existingId && account.id === existingId) return true
      const existingAccountId = text(account.claudeSubscription?.accountId) ?? text(account.credentials.accountId)
      if (accountId && existingAccountId) {
        if (accountId !== existingAccountId) return false
        const existingOrganization = text(account.claudeSubscription?.organizationId)
        const organization = text(profile?.organizationId)
        // Claude account IDs may be stable across organization memberships.
        // Never replace an explicitly different organization's credentials.
        return !organization || !existingOrganization || organization === existingOrganization
      }
      if (accessToken && account.credentials.accessToken === accessToken) return true
      if (refreshToken && account.credentials.refreshToken === refreshToken) return true
      const existingEmail = normalizedEmail(account.email)
      const existingOrganization = text(account.claudeSubscription?.organizationId)
      const organization = text(profile?.organizationId)
      // Email remains a useful fallback when a profile response omits its
      // account id. Never merge two explicitly different organizations.
      return Boolean(email && existingEmail && email === existingEmail
        && (!organization || !existingOrganization || organization === existingOrganization))
    })
    if (existing && existingId) {
      const savedAccountId = text(existing.claudeSubscription?.accountId) ?? text(existing.credentials.accountId)
      const savedOrganizationId = text(existing.claudeSubscription?.organizationId)
      if (accountId && savedAccountId && accountId !== savedAccountId) throw new Error('Claude 订阅刷新返回的账号身份不匹配，请重新登录')
      if (profile?.organizationId && savedOrganizationId && profile.organizationId !== savedOrganizationId) throw new Error('Claude 订阅刷新返回的组织身份不匹配，请重新登录')
    }
    const target: StoredAccount = existing ?? {
      id: randomUUID(), kind: 'oauth', identityService: 'anthropic', credentialKind: 'claude_ai_oauth', protocol: 'anthropic_messages',
      name: profile?.name ?? profile?.email ?? 'Claude 订阅账号', email: profile?.email, plan: profile?.plan,
      baseUrl: 'https://api.anthropic.com', models: [...CLAUDE_SUBSCRIPTION_MODELS], wireApi: 'chat_completions',
      defaultTier: 'inherit', note: '', tags: [], createdAt: Date.now(), credentials: {}
    }
    target.kind = 'oauth'; target.identityService = 'anthropic'; target.credentialKind = 'claude_ai_oauth'; target.protocol = 'anthropic_messages'
    target.baseUrl = 'https://api.anthropic.com'; target.wireApi = 'chat_completions'
    if (!target.models.length) target.models = [...CLAUDE_SUBSCRIPTION_MODELS]
    target.name = profile?.name ?? profile?.email ?? target.name
    target.email = profile?.email ?? target.email
    target.plan = profile?.plan ?? target.plan
    if (profile?.expiresAt) target.subscriptionActiveUntil = profile.expiresAt
    target.credentials = {
      ...target.credentials,
      accessToken,
      ...(refreshToken ? { refreshToken } : target.credentials.refreshToken ? { refreshToken: target.credentials.refreshToken } : {}),
      ...(accountId ? { accountId } : target.credentials.accountId ? { accountId: target.credentials.accountId } : {}),
      ...(result.tokens.expiresAt ? { expiresAt: result.tokens.expiresAt } : {}),
      ...(result.tokens.tokenType ? { tokenType: result.tokens.tokenType } : {}),
      ...(result.tokens.scope ? { scope: result.tokens.scope } : {})
    }
    target.claudeSubscription = claudeSubscriptionIdentity(result, target.claudeSubscription)
    if (result.usage) target.quota = claudeSubscriptionQuota(result.usage)
    delete target.error; delete target.errorAt
    // A successful login or token rotation replaces this account's
    // credentials. Publish a new generation so a stale refresh failure cannot
    // be written onto the newly saved identity.
    target.generation = randomUUID()
    if (!existing) state.accounts.push(target)
    reconcileProviderKeys(state)
    saved = structuredClone(target)
  })
  return saved!
}

/** Record a safe per-account refresh failure without persisting transport details. */
export function markClaudeSubscriptionRefreshError(store: Store, id: string, generation?: string): void {
  store.transaction(state => {
    const account = state.accounts.find(value => value.id === id)
    if (!account || !isClaudeSubscriptionAccount(account) || generation !== account.generation) return
    account.error = 'Claude 订阅刷新失败，请重新登录或稍后重试'
    account.errorAt = Date.now()
  })
}
