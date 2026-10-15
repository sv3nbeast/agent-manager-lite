import { randomUUID } from 'node:crypto'
import { accountCredentialKindSchema, accountIdentityServiceSchema, accountInputSchema, accountProtocolSchema, type ImportPreview } from '../shared/types'
import type { StoredAccount } from './store'

/**
 * Claude Code credentials deliberately use a separate parser.  The generic
 * account importer understands OpenAI JWT claims and must never interpret an
 * Anthropic OAuth token as an OpenAI OAuth account.
 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const SECRET_KEYS = new Set([
  'apiKey', 'api_key', 'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'idToken', 'id_token', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'anthropic_api_key', 'anthropic_auth_token', 'claude_code_oauth_token', 'oauthToken', 'oauth_token',
])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 凭据必须是 JSON 对象')
  return value as Record<string, unknown>
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function sourceWithoutSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) || /(?:api.?key|token|oauth|secret|credential)/i.test(key)) continue
    if (item && typeof item === 'object' && !Array.isArray(item)) clean[key] = sourceWithoutSecrets(item as Record<string, unknown>)
    else if (Array.isArray(item)) clean[key] = item.slice(0, 100).map(value => value && typeof value === 'object' && !Array.isArray(value)
      ? sourceWithoutSecrets(value as Record<string, unknown>)
      : /token|secret|credential/i.test(key) ? '[redacted]' : value)
    else clean[key] = item
  }
  return clean
}
function parseInput(raw: string): unknown[] {
  const input = raw.trim()
  if (!input) throw new Error('请输入 Claude 凭据')
  try {
    const value = JSON.parse(input) as unknown
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['accounts', 'credentials', 'profiles']) {
        if (Array.isArray(record[key])) return record[key] as unknown[]
        if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
          const values = Object.values(record[key] as Record<string, unknown>)
          if (values.length && values.every(value => value && typeof value === 'object' && !Array.isArray(value))) return values
        }
      }
      return [value]
    }
    if (typeof value === 'string') return [value]
  } catch { /* token / JSONL below */ }
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > 1) return lines.map(line => { try { return JSON.parse(line) as unknown } catch { return line } })
  return [input]
}
function nested(source: Record<string, unknown>): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [source]
  for (let index = 0; index < values.length; index++) {
    if (values.length > 100) throw new Error('Claude 连接的嵌套配置过多')
    for (const key of ['credentials', 'claudeAiOauth', 'claude_ai_oauth', 'oauth', 'oauthAccount', 'auth', 'env', 'environment', 'config', 'settings', 'settingsConfig', 'settings_config']) {
      const value = values[index][key]
      if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value as Record<string, unknown>)
    }
  }
  return values
}
function unique(values: (string | undefined)[], label: string): string | undefined {
  const found = [...new Set(values.filter((value): value is string => value !== undefined))]
  if (found.length > 1) throw new Error(`${label}来源冲突，请保留一致的值`)
  return found[0]
}
function take(source: Record<string, unknown>, keys: string[], label = 'Claude 凭据', normalize: (value: string) => string = value => value, allowEmpty = true): string | undefined {
  const values: string[] = []
  for (const container of nested(source)) for (const key of keys) {
    if (container[key] === undefined) continue
    const value = text(container[key])
    if (!value) {
      if (allowEmpty && (container[key] === null || container[key] === '' || typeof container[key] === 'string')) continue
      throw new Error(`${label}格式无效`)
    }
    if (/[\0\r\n]/.test(value)) throw new Error(`${label}包含无效字符`)
    values.push(normalize(value))
  }
  return unique(values, label)
}
function declaredCredentialKind(source: Record<string, unknown>): string | undefined {
  const lower = (value: string) => value.toLowerCase()
  const identity = take(source, ['identityService', 'identity_service'], '身份服务', value => {
    const name = lower(value)
    return ['claude', 'claude_code', 'claude-code'].includes(name) ? 'anthropic' : name
  }, false)
  const protocol = take(source, ['protocol', 'apiProtocol', 'api_protocol'], 'API 协议', lower, false)
  const kind = take(source, ['credentialKind', 'credential_kind'], '凭据类型', lower, false)
  if (identity !== undefined && identity !== 'anthropic'
    || protocol !== undefined && protocol !== 'anthropic_messages'
    || kind !== undefined && !['anthropic_api_key', 'anthropic_bearer', 'claude_ai_oauth', 'gateway'].includes(kind)) {
    throw new Error('导入内容声明了不兼容的身份服务、协议或凭据类型，不能转换为 Claude 连接')
  }
  for (const container of nested(source)) {
    if (['platform', 'provider', 'service'].some(key => ['openai', 'chatgpt', 'codex'].includes(text(container[key])?.toLowerCase() ?? ''))
      || ['wireApi', 'wire_api'].some(key => text(container[key])?.toLowerCase() === 'responses')) {
      throw new Error('导入内容声明了 OpenAI 连接，不能转换为 Claude 连接')
    }
  }
  return kind
}
function importedModels(source: Record<string, unknown>): string[] {
  let catalog: string[] | undefined
  const defaults: string[] = []
  for (const container of nested(source)) for (const key of ['models', 'model', 'ANTHROPIC_MODEL', 'anthropic_model']) {
    const value = container[key]
    if (value === undefined) continue
    const parsed = accountInputSchema.shape.models.safeParse(Array.isArray(value) ? value : [value])
    if (!parsed.success || parsed.data.some(model => /[\0\r\n]/.test(model))) throw new Error('Claude 模型列表格式无效')
    const models = [...new Set(parsed.data)]
    if (Array.isArray(value)) {
      if (catalog && JSON.stringify(catalog) !== JSON.stringify(models)) throw new Error('Claude 模型列表来源冲突，请保留一致的值')
      catalog = models
    } else defaults.push(models[0])
  }
  const model = unique(defaults, 'Claude 默认模型')
  if (model && catalog && !catalog.includes(model)) throw new Error('Claude 默认模型不在声明的模型列表中')
  return model ? [model, ...(catalog ?? []).filter(value => value !== model)] : catalog ?? [DEFAULT_MODEL]
}
function importedName(source: Record<string, unknown>, index: number, kind: string, email?: string): string {
  return text(source.name) ?? text(source.account_name) ?? text(source.profileName) ?? email
    ?? (kind === 'claude_ai_oauth' ? 'Claude OAuth 账号' : `Anthropic ${index + 1}`)
}
function oauthMetadata(source: Record<string, unknown>): Pick<StoredAccount['credentials'], 'expiresAt' | 'scope' | 'tokenType'> {
  const expiries: number[] = [], scopes: string[] = []
  for (const container of nested(source)) {
    for (const name of ['expiresAt', 'expires_at']) {
      const raw = container[name]
      if (raw === undefined || raw === null) continue
      let value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(value) && typeof raw === 'string') value = Date.parse(raw)
      if (!Number.isFinite(value) || value <= 0) throw new Error('Claude OAuth 到期时间格式无效')
      expiries.push(value < 10_000_000_000 ? value * 1000 : value)
    }
    for (const name of ['scope', 'scopes']) {
      const raw = container[name]
      if (raw === undefined || raw === null) continue
      const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/) : []
      if (!parts.length || parts.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(value))) throw new Error('Claude OAuth 授权范围格式无效')
      scopes.push([...new Set(parts)].sort().join(' '))
    }
  }
  if (new Set(expiries).size > 1) throw new Error('Claude OAuth 到期时间来源冲突')
  const scope = unique(scopes, 'Claude OAuth 授权范围')
  const tokenType = take(source, ['tokenType', 'token_type'], 'Claude OAuth 令牌类型')
  return { ...(expiries.length ? { expiresAt: expiries[0] } : {}), ...(scope ? { scope } : {}), ...(tokenType ? { tokenType } : {}) }
}
function accountFor(sourceValue: unknown, index: number): StoredAccount {
  const raw = typeof sourceValue === 'string' ? sourceValue.trim() : undefined
  const source = raw ? {} : object(sourceValue)
  const declaredKind = declaredCredentialKind(source)
  const genericKey = take(source, ['apiKey', 'api_key'])
  const apiKey = raw && /^sk-ant-(?:api|key)/i.test(raw) ? raw : unique([
    take(source, ['ANTHROPIC_API_KEY', 'anthropic_api_key']), declaredKind === 'anthropic_bearer' ? undefined : genericKey,
  ], 'Claude API Key')
  const bearer = raw && !raw.startsWith('sk-ant-') ? raw : unique([
    take(source, ['ANTHROPIC_AUTH_TOKEN', 'anthropic_auth_token', 'authToken', 'auth_token', 'bearerToken', 'bearer_token']), declaredKind === 'anthropic_bearer' ? genericKey : undefined,
  ], 'Claude Bearer')
  const rawOAuth = raw && /^sk-ant-oat/i.test(raw) ? raw : undefined
  const oauth = rawOAuth ?? take(source, ['CLAUDE_CODE_OAUTH_TOKEN', 'claude_code_oauth_token', 'oauthToken', 'oauth_token', 'accessToken', 'access_token'])
  const refresh = take(source, ['refreshToken', 'refresh_token'])
  const hasOAuthField = nested(source).some(item => Object.keys(item).some(key => ['CLAUDE_CODE_OAUTH_TOKEN', 'claude_code_oauth_token', 'oauthToken', 'oauth_token', 'accessToken', 'access_token'].includes(key)))
  const explicitOAuth = declaredKind === 'claude_ai_oauth'
    || take(source, ['authMethod', 'auth_method'], '登录方式', value => value.toLowerCase())?.includes('oauth')
    || !!refresh || hasOAuthField || !!rawOAuth
  if ([!!apiKey, !!bearer, !!oauth || !!refresh].filter(Boolean).length > 1 || !!(apiKey || bearer) && explicitOAuth) throw new Error('每个 Claude 连接只能包含一种凭据，请将 API Key、Bearer 与 OAuth 分开导入')
  const kind = apiKey ? 'anthropic_api_key' : explicitOAuth ? 'claude_ai_oauth' : 'anthropic_bearer'
  if (declaredKind !== undefined && (declaredKind === 'gateway' ? explicitOAuth : declaredKind !== kind)) throw new Error('Claude 凭据类型与实际凭据来源不一致')
  const secret = apiKey ?? (explicitOAuth ? oauth : bearer) ?? oauth
  if (!secret && !refresh) throw new Error('缺少 Anthropic API Key、Bearer Token 或 Claude OAuth Token')
  if (secret && secret.length > 100000 || refresh && refresh.length > 100000) throw new Error('令牌长度超出限制')
  const email = take(source, ['email', 'accountEmail', 'account_email'], '账号邮箱')
  const models = importedModels(source)
  const baseUrl = take(source, ['baseUrl', 'base_url', 'ANTHROPIC_BASE_URL', 'anthropic_base_url'], 'Anthropic 地址', value => {
    const parsed = accountInputSchema.shape.baseUrl.safeParse(value)
    if (!parsed.success) throw new Error('Anthropic 地址格式无效')
    return new URL(parsed.data).href.replace(/\/+$/, '')
  }, false) ?? DEFAULT_BASE_URL
  const credentialKind = accountCredentialKindSchema.parse(kind)
  const protocol = accountProtocolSchema.parse('anthropic_messages')
  const identityService = accountIdentityServiceSchema.parse('anthropic')
  const metadata = {
    name: accountInputSchema.shape.name.parse(importedName(source, index, kind, email)),
    note: accountInputSchema.shape.note.parse(text(source.note) ?? ''),
    tags: accountInputSchema.shape.tags.parse(Array.isArray(source.tags) ? source.tags : []),
    defaultTier: accountInputSchema.shape.defaultTier.parse(source.defaultTier ?? 'inherit'),
  }
  const account: StoredAccount = {
    ...metadata, id: randomUUID(), kind: explicitOAuth ? 'oauth' : 'api_key', email,
    baseUrl, models, wireApi: 'chat_completions', protocol, identityService, credentialKind,
    createdAt: Date.now(), credentials: explicitOAuth ? { accessToken: oauth, refreshToken: refresh, ...oauthMetadata(source) } : { apiKey: secret },
    source: sourceWithoutSecrets(source),
  }
  return account
}

export function parseClaudeCodeAccountImport(raw: string): { accounts: StoredAccount[]; preview: ImportPreview } {
  const accounts: StoredAccount[] = []
  const preview: ImportPreview = { entries: [], errors: [], skipped: 0 }
  parseInput(raw).forEach((value, index) => {
    try {
      const account = accountFor(value, index)
      accounts.push(account)
      preview.entries.push({ index, name: account.name, kind: account.kind, needsVerification: account.kind === 'oauth' && !account.credentials.accessToken })
    } catch (error) {
      const reason = error instanceof Error && error.name !== 'ZodError' ? error.message : 'Claude 凭据字段格式错误，请检查导入内容'
      preview.errors.push(`第 ${index + 1} 项：${reason}`)
    }
  })
  return { accounts, preview }
}
