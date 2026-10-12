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
    if (SECRET_KEYS.has(key) || /(?:api.?key|auth.?token|oauth|refresh.?token|access.?token)/i.test(key)) continue
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
  for (const key of ['credentials', 'claudeAiOauth', 'claude_ai_oauth', 'oauth', 'oauthAccount', 'auth', 'env', 'environment', 'config', 'settings']) {
    const value = source[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value as Record<string, unknown>)
  }
  return values
}
function take(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const container of nested(source)) for (const key of keys) {
    const value = text(container[key]); if (value) return value
  }
  return undefined
}
function isAnthropic(source: Record<string, unknown>): boolean {
  const marker = [source.platform, source.provider, source.service, source.identityService, source.identity_service]
    .map(value => text(value)?.toLowerCase()).filter(Boolean)
  return marker.some(value => value === 'anthropic' || value === 'claude' || value === 'claude_code' || value === 'claude-code')
    || nested(source).some(item => Object.keys(item).some(key => /anthropic|claudeai|claude_code|claudeAiOauth/i.test(key)))
}
function importedName(source: Record<string, unknown>, index: number, kind: string, email?: string): string {
  return text(source.name) ?? text(source.account_name) ?? text(source.profileName) ?? email
    ?? (kind === 'claude_ai_oauth' ? 'Claude OAuth 账号' : `Anthropic ${index + 1}`)
}
function accountFor(sourceValue: unknown, index: number): StoredAccount {
  const raw = typeof sourceValue === 'string' ? sourceValue.trim() : undefined
  const source = raw ? {} : object(sourceValue)
  const marker = isAnthropic(source)
  const apiKey = raw && /^sk-ant-(?:api|key)/i.test(raw) ? raw : take(source, ['ANTHROPIC_API_KEY', 'anthropic_api_key', 'apiKey', 'api_key'])
  const bearer = raw && !raw.startsWith('sk-ant-') ? raw : take(source, ['ANTHROPIC_AUTH_TOKEN', 'anthropic_auth_token', 'authToken', 'auth_token', 'bearerToken', 'bearer_token'])
  const rawOAuth = raw && /^sk-ant-oat/i.test(raw) ? raw : undefined
  const oauth = rawOAuth ?? take(source, ['CLAUDE_CODE_OAUTH_TOKEN', 'claude_code_oauth_token', 'oauthToken', 'oauth_token', 'accessToken', 'access_token'])
  const refresh = take(source, ['refreshToken', 'refresh_token'])
  const hasOAuthField = nested(source).some(item => Object.keys(item).some(key => ['CLAUDE_CODE_OAUTH_TOKEN', 'claude_code_oauth_token', 'oauthToken', 'oauth_token', 'accessToken', 'access_token'].includes(key)))
  const explicitOAuth = text(source.credentialKind)?.toLowerCase().includes('oauth') || text(source.credential_kind)?.toLowerCase().includes('oauth')
    || text(source.authMethod)?.toLowerCase().includes('oauth') || text(source.auth_method)?.toLowerCase().includes('oauth')
    || !!refresh || hasOAuthField || !!rawOAuth || !!oauth && !apiKey && !bearer && marker
  const kind = apiKey ? 'anthropic_api_key' : explicitOAuth ? 'claude_ai_oauth' : 'anthropic_bearer'
  const secret = apiKey ?? (explicitOAuth ? oauth : bearer) ?? oauth
  if (!secret && !refresh) throw new Error('缺少 Anthropic API Key、Bearer Token 或 Claude OAuth Token')
  if (secret && secret.length > 100000 || refresh && refresh.length > 100000) throw new Error('令牌长度超出限制')
  const email = take(source, ['email', 'accountEmail', 'account_email'])
  const modelsValue = source.models ?? source.model
  const models = Array.isArray(modelsValue) ? modelsValue.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()).slice(0, 500) : typeof modelsValue === 'string' && modelsValue.trim() ? [modelsValue.trim()] : [DEFAULT_MODEL]
  const baseUrl = text(source.baseUrl) ?? text(source.base_url) ?? text(source.ANTHROPIC_BASE_URL) ?? DEFAULT_BASE_URL
  const parsedUrl = accountInputSchema.shape.baseUrl.safeParse(baseUrl)
  if (!parsedUrl.success) throw new Error('Anthropic 地址格式无效')
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
    baseUrl: parsedUrl.data, models, wireApi: 'chat_completions', protocol, identityService, credentialKind,
    createdAt: Date.now(), credentials: explicitOAuth ? { accessToken: oauth, refreshToken: refresh } : { apiKey: secret },
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
