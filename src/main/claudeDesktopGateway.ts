import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { InstanceProfile } from '../shared/instances'
import type { StoredAccount } from './store'
import type { DesktopPlan } from './instanceRuntime'
import { readBounded } from './clientConfig'
import {
  claudeDesktopAppliedId, claudeDesktopConfigScope, claudeDesktopDocumentAt, claudeDesktopEntryAt, claudeDesktopLibraryEntries, claudeDesktopLibraryRecovery,
  claudeDesktopNativeSchema, claudeDesktopNativeSource, claudeDesktopNetworkFingerprint, prepareClaudeDesktopNetwork,
  removeClaudeDesktopDocument, writeClaudeDesktopDocument, type ClaudeDesktopConfigScope,
} from './claudeDesktopNetwork'

type Document = Record<string, unknown>
const digest = (value: unknown) => createHash('sha256').update(value === undefined ? 'absent' : JSON.stringify(value)).digest('hex')
const ownValue = (value: Document, key: string) => Object.hasOwn(value, key) ? value[key] : undefined
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const journalName = '.cml-claude-desktop-gateway.json'
const journalSchema = z.object({
  version: z.literal(1), entryId: z.string().regex(uuid), previousAppliedId: z.string().regex(uuid).nullable().optional(),
  metaExisted: z.boolean(), baseline: z.record(z.string().regex(/^[a-f0-9]{64}$/)), applied: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
}).strict()
type Journal = z.infer<typeof journalSchema>
const nativeFields = ['inferenceProvider', 'inferenceCredentialKind', 'inferenceGatewayBaseUrl', 'inferenceGatewayApiKey',
  'inferenceGatewayAuthScheme', 'inferenceModels', 'modelDiscoveryEnabled', 'disableDeploymentModeChooser'] as const

/** Inspect capabilities in the installed native schema, without a version list. */
export function assertClaudeDesktopGatewayCapability(application: string): void {
  try {
    const source = claudeDesktopNativeSource(application), schema = claudeDesktopNativeSchema(source)
    if (!nativeFields.every(key => schema.get(key)?.scopes.includes('3p'))
      || !['configLibrary', '_meta.json', 'appliedId', 'deploymentMode', 'claude_desktop_config.json', '-3p'].every(value => source.includes(value))) throw new Error('gateway contract')
  } catch { throw new Error('当前 Claude Desktop 未提供已验证的第三方 API 配置，请更新客户端后重试') }
}

/** OAuth from the CLI is deliberately never a Desktop gateway credential. */
export function validateClaudeDesktopGatewayAccount(profile: Pick<InstanceProfile, 'accountId' | 'model' | 'connectionMode'>, account: StoredAccount | undefined): asserts account is StoredAccount {
  if (profile.connectionMode !== 'native' || !account || account.id !== profile.accountId) throw new Error('Claude Desktop API 模式需要选择有效的供应商密钥')
  if (account.kind !== 'api_key' || account.identityService !== 'anthropic' || account.protocol !== 'anthropic_messages'
    || !['anthropic_api_key', 'anthropic_bearer', 'gateway'].includes(account.credentialKind ?? '')) throw new Error('Claude Desktop 第三方连接需要 Anthropic Messages API Key 或 Bearer 凭据')
  if (!account.credentials.apiKey?.trim() || /[\0\r\n]/.test(account.credentials.apiKey)) throw new Error('Claude Desktop API 连接缺少有效密钥')
  let base: URL
  try { base = new URL(account.baseUrl) } catch { throw new Error('Claude Desktop API 地址无效') }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Claude Desktop API 地址必须是无账号密码和查询参数的 HTTP(S) 地址')
  // This is a native Desktop schema constraint. Keep HTTP usable for the
  // shared provider library and CLI; only this launcher requires HTTPS away
  // from loopback, otherwise Desktop silently discards the connection URL.
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Claude Desktop 原生第三方连接要求远端地址使用 HTTPS；HTTP 仅支持本机地址')
  if (!profile.model || !account.models.includes(profile.model)) throw new Error('所选模型不在此密钥的模型目录中，请重新选择')
}

/** The chosen model is first; native Desktop remains responsible for its model
 * compatibility and model picker. No model names determine authentication. */
export function claudeDesktopGatewayProjection(account: StoredAccount, model: string): Document {
  const models = [...new Set([model, ...account.models])]
  return {
    inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayBaseUrl: claudeDesktopGatewayBaseUrl(account.baseUrl),
    inferenceGatewayApiKey: account.credentials.apiKey,
    inferenceGatewayAuthScheme: account.credentialKind === 'anthropic_bearer' ? 'bearer' : 'x-api-key',
    inferenceModels: models.map(name => ({ name })), modelDiscoveryEnabled: false, disableDeploymentModeChooser: true,
  }
}

/** Native Desktop appends `/v1/messages` itself. Shared provider values often
 * already include the OpenAI-compatible `/v1` suffix, so remove only that
 * final path segment in this projection and keep the stored account intact. */
export function claudeDesktopGatewayBaseUrl(value: string): string {
  const url = new URL(value)
  if (/\/v1\/?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/v1\/?$/i, '') || '/'
  if (url.pathname === '/') url.pathname = ''
  return url.toString().replace(/\/$/, '')
}

function journalAt(scope: ClaudeDesktopConfigScope): Journal | undefined {
  const raw = claudeDesktopDocumentAt(scope, join(scope.root, journalName))
  if (!raw) return
  const parsed = journalSchema.safeParse(raw)
  if (!parsed.success || parsed.data.previousAppliedId === parsed.data.entryId) throw new Error('Claude Desktop API 恢复记录无效，原文件已保留')
  return parsed.data
}

/** Three-way recovery preserves independent native edits; journal fields are
 * hashes/references so upstream keys are never copied into recovery metadata. */
function restoredContents(managed: Document, original: Document, journal: Journal): Document {
  const result: Array<[string, unknown]> = []
  for (const key of new Set([...Object.keys(journal.baseline), ...Object.keys(original), ...Object.keys(managed)])) {
    const before = journal.baseline[key] ?? digest(undefined), source = ownValue(original, key)
    let current = ownValue(managed, key)
    if (journal.applied[key] === digest(current)) current = source
    const a = digest(source), b = digest(current)
    if (a !== b && a !== before && b !== before) throw new Error('Claude Desktop 原连接和当前连接均已修改，请先在客户端确认配置；管理器已保留原文件')
    const value = b === before ? source : current
    if (value !== undefined) result.push([key, value])
  }
  return Object.fromEntries(result)
}

function restoreGateway(scope: ClaudeDesktopConfigScope): string | undefined {
  const journal = journalAt(scope)
  if (!journal) return
  const meta = claudeDesktopDocumentAt(scope, scope.meta), selected = claudeDesktopAppliedId(meta)
  const path = join(scope.library, `${journal.entryId}.json`), managed = claudeDesktopDocumentAt(scope, path)
  if (!managed) {
    if (selected === journal.entryId) throw new Error('Claude Desktop API 配置缺失，恢复记录已保留')
    const { metadata } = claudeDesktopLibraryRecovery(meta, journal)
    if (!journal.metaExisted && !Object.keys(metadata).length) removeClaudeDesktopDocument(scope, scope.meta)
    else writeClaudeDesktopDocument(scope, scope.meta, metadata)
    removeClaudeDesktopDocument(scope, join(scope.root, journalName)); return journal.entryId
  }
  const original = claudeDesktopEntryAt(scope, journal.previousAppliedId), restored = restoredContents(managed, original, journal)
  const { metadata: next, keepEntry } = claudeDesktopLibraryRecovery(meta, journal, restored)
  if (keepEntry) writeClaudeDesktopDocument(scope, path, restored)
  else if (journal.previousAppliedId && digest(restored) !== digest(original)) writeClaudeDesktopDocument(scope, join(scope.library, `${journal.previousAppliedId}.json`), restored)
  if (!journal.metaExisted && !Object.keys(next).length) removeClaudeDesktopDocument(scope, scope.meta)
  else writeClaudeDesktopDocument(scope, scope.meta, next)
  if (!keepEntry) removeClaudeDesktopDocument(scope, path)
  removeClaudeDesktopDocument(scope, join(scope.root, journalName))
  return keepEntry ? undefined : journal.entryId
}

/** Read-only launch binding, including selected native config and recovery files. */
export function claudeDesktopGatewayFingerprint(plan: DesktopPlan): string {
  const journalPath = join(dirname(plan.directory), journalName)
  const rawJournal = readBounded(journalPath, 1024 * 1024)
  const scope = claudeDesktopConfigScope(plan, false)
  if (!scope) {
    if (rawJournal !== null) throw new Error('Claude Desktop API 配置目录缺失，恢复记录已保留')
    return digest(null)
  }
  const meta = claudeDesktopDocumentAt(scope, scope.meta), journal = journalAt(scope)
  const current = claudeDesktopEntryAt(scope, claudeDesktopAppliedId(meta))
  const previous = journal ? claudeDesktopEntryAt(scope, journal.previousAppliedId) : undefined
  const managed = journal ? claudeDesktopDocumentAt(scope, join(scope.library, `${journal.entryId}.json`)) : undefined
  const deployment = claudeDesktopDocumentAt(scope, join(`${plan.desktopDirectory}-3p`, 'claude_desktop_config.json'))
  return digest([meta, journal, current, previous, managed, deployment, claudeDesktopNetworkFingerprint(plan)])
}

/** Apply native third-party configuration only within this instance. Restore
 * the preceding proxy overlay first, then let runtime apply the new relay. */
export function prepareClaudeDesktopGateway(plan: DesktopPlan, profile: InstanceProfile, account?: StoredAccount): void {
  const api = profile.connectionMode === 'native'
  if (api) { validateClaudeDesktopGatewayAccount(profile, account); assertClaudeDesktopGatewayCapability(plan.application) }
  prepareClaudeDesktopNetwork({ ...plan, networkRoute: undefined })
  const scope = claudeDesktopConfigScope(plan, api)
  if (!scope) return
  const previousEntry = restoreGateway(scope), deploymentPath = join(`${plan.desktopDirectory}-3p`, 'claude_desktop_config.json')
  const deployment = claudeDesktopDocumentAt(scope, deploymentPath)
  if (!api) {
    // Both local data trees survive switching modes. A stale persisted 3p
    // choice must not turn an explicit native-login launch into API mode.
    if (deployment?.deploymentMode === '3p') writeClaudeDesktopDocument(scope, deploymentPath, { ...deployment, deploymentMode: '1p' })
    return
  }
  const meta = claudeDesktopDocumentAt(scope, scope.meta)
  if (meta?.hybridPointer !== undefined && meta.hybridPointer !== null) throw new Error('Claude Desktop 由组织或共享配置管理连接，请先在客户端确认配置')
  const entries = claudeDesktopLibraryEntries(meta), previousAppliedId = claudeDesktopAppliedId(meta), original = claudeDesktopEntryAt(scope, previousAppliedId)
  const entryId = previousEntry ?? randomUUID(), path = join(scope.library, `${entryId}.json`)
  if (claudeDesktopDocumentAt(scope, path)) throw new Error('Claude Desktop 受管 API 配置标识冲突，原文件已保留')
  const projection = claudeDesktopGatewayProjection(account!, profile.model), next = { ...original, ...projection }
  const journal: Journal = { version: 1, entryId, previousAppliedId, metaExisted: meta !== undefined,
    baseline: Object.fromEntries(Object.entries(original).map(([key, value]) => [key, digest(value)])),
    applied: Object.fromEntries(Object.entries(projection).map(([key, value]) => [key, digest(value)])),
  }
  writeClaudeDesktopDocument(scope, join(scope.root, journalName), journal)
  writeClaudeDesktopDocument(scope, path, next)
  writeClaudeDesktopDocument(scope, scope.meta, { ...meta, appliedId: entryId, entries: [...entries, { id: entryId, name: account!.name }] })
  writeClaudeDesktopDocument(scope, deploymentPath, { ...deployment, deploymentMode: '3p' })
}
