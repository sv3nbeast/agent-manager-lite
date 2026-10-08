import type {ProxyResourcesView,ProxyChangePreview,ProxyResourceChange} from './proxyResources'
import type {ProxyImportInput,ProxyImportPreview,ProxyAssignmentInput,ProxyAssignmentPreview} from './proxyBatch'
import type {TrashPreviewInput,TrashActionInput,TrashPreview,TrashPage,TrashState,LegacyTrashPage,LegacyTrashImportInput} from './sessionTrash'
import { z } from 'zod'
import { modelContextWindowsSchema } from './modelContextWindows'
import { integrationTypeSchema, type IntegrationType } from './providerUsage'
import type { HistoryFilter, HistoryQuery, HistoryPage } from './history'
import type { ClientConfigTarget, ClientConfigView, ClientConfigPreview, ClientConfigChanges } from './clientConfig'
import type { ModelCatalogView, ModelCatalogInput, CatalogImport } from './modelCatalog'
import type {ProviderConfigInput,ProviderConfigView} from './providerConfig'
import type { ProviderSummary, ProviderMutation } from './providerLibrary'
import type { ProviderProbeInput, ProviderProbeState } from './providerProbe'
import type { LocalAccessMutation,LocalAccessView } from './localAccess'
import type { InstanceProfile, InstanceView, InstanceApplication, InstanceInput, InstanceLaunchPreview, InstanceWorkingDirectory, InstanceCopyInput, InstanceCopyView, InstanceCopySource, ExternalInstanceCopyInput, AttachInstanceInput, InstanceHistorySummary, ExternalInstanceDiscovery } from './instances'
import type {ClientIdentityInput,ClientIdentityView} from './clientIdentity'
import type {ClientSwitchView,ClientSwitchPreview} from './clientSwitch'
import type {ClientAuthorityView} from './clientAuthority'
import type { WakeupView, WakeupTaskInput } from './wakeup'
import type {SessionScanInput,SessionPageInput,SessionPage,SessionSelection,SessionTokenResult,SessionCopyPreviewInput,SessionCopyPreview,SessionTransferView,SessionTransferRecovery} from './sessions'
import type {SessionVisibilityRepairInput,SessionVisibilityRepairApplyInput,SessionVisibilityRepairInstanceList,SessionVisibilityRepairProviderList,SessionVisibilityRepairPreview,SessionVisibilityRepairSummary} from './sessionVisibility'
import type {SyncPreviewInput,SyncPreview,SyncView,SyncRecovery} from './sessionSync'
import type {ArchivePreview,ArchiveImportInput,ArchiveImportPreview,ArchiveProgress} from './sessionArchives'
import type {AccountRecyclePage,AccountRecycleInput,AccountRecyclePreview,AccountRecycleResult} from './accountRecycle'
import type {StartTempLogin,TempLoginView,TempLoginCleanup} from './tempLogin'
import type {AccountProxyInput,AccountProxyView,ProxyProbeInput,ProxyProbeResult} from './accountProxy'
import type { SshServersView, SshServerInput, SshSyncResult, SshTestResult } from './ssh'
import type { UpstreamProxyInput,UpstreamProxyProbeInput,UpstreamProxyView } from './upstreamProxy'

export const tierModeSchema = z.enum(['follow', 'standard', 'fast'])
export type TierMode = z.infer<typeof tierModeSchema>
export const defaultTierSchema = z.enum(['inherit', 'follow', 'standard', 'fast', 'auto', 'flex'])
export type DefaultTier = z.infer<typeof defaultTierSchema>
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  defaultTier: tierModeSchema.default('follow'),
  port: z.number().int().min(1024).max(65535).default(16321),
  refreshMinutes: z.number().int().min(0).max(1440).default(10),
  streamOpenTimeoutSeconds: z.number().int().min(1).max(600).default(60),
  streamIdleTimeoutSeconds: z.number().int().min(1).max(600).default(120),
  imageStreamOpenTimeoutSeconds: z.number().int().min(1).max(600).default(60),
  imageStreamIdleTimeoutSeconds: z.number().int().min(1).max(600).default(180),
  launchAtLogin: z.boolean().default(false),
  closeToTray: z.boolean().default(false)
}).strict()
export type Settings = z.infer<typeof settingsSchema>
export const accountInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(10000),
  baseUrl: z.string().url().refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch { return false }
  }, '请输入不含账号密码、查询参数的 HTTP(S) 地址'),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  wireApi: z.enum(['responses', 'chat_completions']).default('responses'),
  integrationType: integrationTypeSchema.optional(),
  modelContextWindows: modelContextWindowsSchema.optional(),
  defaultTier: defaultTierSchema.default('inherit'),
  note: z.string().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([])
}).strict()
export type AccountInput = z.infer<typeof accountInputSchema>
export const accountEditSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(),
  changes: accountInputSchema.partial()
}).strict()
export type AccountEdit = z.infer<typeof accountEditSchema>
export const accountKeyReadSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative()
}).strict()
export type AccountKeyRead = z.infer<typeof accountKeyReadSchema>
export const accountIdsSchema = z.array(z.string().uuid()).min(1).max(10000)
export const batchTagsSchema = z.object({ ids: accountIdsSchema, mode: z.enum(['add', 'remove', 'replace']), tags: accountInputSchema.shape.tags }).strict()
export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  quotaAutoRefreshMinutes: z.union([z.literal(-1), z.number().int().min(1).max(999)]).nullable().default(null)
}).strict()
export type GroupInput = z.infer<typeof groupInputSchema>
export interface AccountGroup extends GroupInput { id: string; sortOrder: number; accountIds: string[]; createdAt: number }
export const groupMembersSchema = z.object({
  id: z.string().uuid(), ids: accountIdsSchema, mode: z.enum(['add', 'remove', 'move', 'replace'])
}).strict()
export interface QuotaWindow { id: string; name: string; usedPercent?: number; resetsAt?: number; durationSeconds?: number; allowed?: boolean; limitReached?: boolean }
export interface CreditUsage {
  unlimited?: boolean; remaining?: number; balance?: number; limit?: number; used?: number
  remainingPercent?: number; resetsAt?: number
}
export interface ResetCredit { id?: string; status?: string; resetType?: string; grantedAt?: number; expiresAt?: number; redeemedAt?: number }
export interface Quota {
  updatedAt: number; windows: QuotaWindow[]; allowed?: boolean; limitReached?: boolean; hasUsableCredits?: boolean
  credits?: CreditUsage; spendLimit?: CreditUsage; resetCreditsAvailable?: number; resetCredits?: ResetCredit[]; resetCreditsNextExpiresAt?: number
}
export interface LoginStatus {
  id?: string; method?: 'browser' | 'device'; status: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'success' | 'error' | 'cancelled'
  userCode?: string; verificationUrl?: string; expiresAt?: number; error?: string; accountId?: string
}
export interface RefreshStatus { running: boolean; total: number; completed: number; failed: number; cancelled: boolean; subscriptionPending?: number }
export interface Account {
  egressProxy?:AccountProxyView
  id: string; name: string; email?: string; kind: 'oauth' | 'api_key' | 'agent_identity'; plan?: string
  baseUrl: string; models: string[]; wireApi: 'responses' | 'chat_completions'
  integrationType?: IntegrationType
  modelContextWindows?: Record<string, number>
  defaultTier: DefaultTier; note: string; tags: string[]; createdAt: number
  providerId?: string; providerKeyId?: string
  quota?: Quota; error?: string; errorAt?: number
  providerUsage?: import('./providerUsage').ProviderUsageState
  subscriptionActiveUntil?: number
  subscriptionSource?: 'token' | 'web'
  subscriptionQueryLastAttemptAt?: number
  subscriptionQueryNextRetryAt?: number
  subscriptionQueryLastSuccessAt?: number
  subscriptionQueryLastError?: string
  credentialConfigured: boolean; needsTokenExchange?: boolean; revision?: number
}
export interface GatewayStatus { running: boolean; port?: number; defaultTier?: string; profileId?: string; error?: string;quotaSyncError?:string }
export interface CredentialRecoveryStatus { recovered: number; retained: number }
export interface AppSnapshot { upstreamProxy?:UpstreamProxyView; wakeup?: WakeupView; providerUsageRefresh?:import('./providerUsage').ProviderUsageRefresh; backupRestartRequired?:boolean; proxyResources?:ProxyResourcesView; sshServers?:SshServersView; tempLogin?:TempLoginView;tempLoginCleanup?:TempLoginCleanup;clientSwitches?:ClientSwitchView[];clientAuthorities?:ClientAuthorityView[];localAccess?:LocalAccessView; settings: Settings; accounts: Account[]; groups: AccountGroup[]; providers?: ProviderSummary[]; providerProbe?:ProviderProbeState; instances?:InstanceView[];instanceCopy?:InstanceCopyView; instanceApplications?:InstanceApplication[]; dataDirectory: string; gateway?: GatewayStatus; login?: LoginStatus; quotaRefresh?: RefreshStatus; historyError?: string; credentialRecovery?: CredentialRecoveryStatus }
export interface ImportPreview { entries: { index: number; name: string; kind: Account['kind']; needsVerification?: boolean }[]; errors: string[]; skipped?: number }
export interface StagedImport { ticket: string; preview: ImportPreview; fileName?: string }
export interface ManagerAPI {
  listSshServers():Promise<SshServersView>
  saveSshServer(input:SshServerInput):Promise<AppSnapshot>
  deleteSshServer(id:string):Promise<AppSnapshot>
  selectSshServer(id:string|undefined):Promise<AppSnapshot>
  testSshServer(id:string):Promise<SshTestResult>
  syncSshAccount(input:{serverId?:string;accountId:string}):Promise<SshSyncResult>
  wakeupSetEnabled(enabled:boolean):Promise<AppSnapshot>
  wakeupSave(input:WakeupTaskInput):Promise<AppSnapshot>
  wakeupDelete(id:string):Promise<AppSnapshot>
  wakeupRunNow(id:string):Promise<AppSnapshot>
  wakeupCancel(id:string):Promise<AppSnapshot>
  refreshProviderUsage(input:import('./providerUsage').ProviderUsageInput):Promise<AppSnapshot>
  cancelProviderUsage(runId:string):Promise<AppSnapshot>
  exportDataBackup(input:{requestId:string;password:string}):Promise<import('./dataBackup').BackupResult|undefined>
  previewDataBackup(input:{requestId:string;password:string}):Promise<import('./dataBackup').BackupPreview|undefined>
  restoreDataBackup(input:{ticket:string;requestId:string;confirmed:true}):Promise<import('./dataBackup').BackupRestoreResult>
  discardDataBackup(ticket:string):Promise<void>
  cancelDataBackup(requestId:string):Promise<void>
  restartAfterBackup():Promise<void>
  startProxySubscription(input:import('./proxyCatalog').SubscriptionRequest):Promise<import('./proxyCatalog').SubscriptionJob>
  proxySubscriptionJobs():Promise<import('./proxyCatalog').SubscriptionJob[]>
  cancelProxySubscription(id:string):Promise<void>
  proxyStrategyCandidates(input:import('./proxyStrategy').StrategyCandidatesInput):Promise<import('./proxyStrategy').StrategyCandidates>
  proxyStrategyEditor(input:{sourceId:string;revision:number}):Promise<import('./proxyStrategy').StrategyEditor>
  listProxyCatalogs():Promise<import('./proxyCatalog').CatalogSourceView[]>
  reorderProxyCatalogs(ids:string[]):Promise<import('./proxyCatalog').CatalogSourceView[]>
  proxyCatalogPage(input:import('./proxyCatalog').CatalogPageInput):Promise<import('./proxyCatalog').CatalogPage>
  resolveProxyCatalog(input:import('./proxyCatalog').CatalogResolveInput):Promise<import('./proxyCatalog').CatalogResolution>
  previewProxyCatalog(input:import('./proxyCatalog').CatalogChange):Promise<import('./proxyCatalog').CatalogPreview>
  applyProxyCatalog(input:{ticket:string;confirmed:true}):Promise<AppSnapshot>
  discardProxyCatalog(ticket:string):Promise<void>
  proxyEngineStatus():Promise<import('./proxyEngine').EngineStatus>
  downloadProxyEngine():Promise<import('./proxyEngine').EngineStatus>
  importProxyEngine():Promise<import('./proxyEngine').EngineStatus|undefined>
  cancelProxyEngine(jobId:string):Promise<void>
  checkProxyEngine():Promise<void>
  previewProxyImport(input:ProxyImportInput):Promise<ProxyImportPreview>
  previewProxyAssignment(input:ProxyAssignmentInput):Promise<ProxyAssignmentPreview>
  applyProxyBatch(input:{ticket:string;confirmed:true}):Promise<AppSnapshot>
  discardProxyBatch(ticket:string):Promise<void>
  previewProxyChange(input:ProxyResourceChange):Promise<ProxyChangePreview>
  applyProxyChange(input:{ticket:string;confirmed:true}):Promise<AppSnapshot>
  discardProxyChange(ticket:string):Promise<void>
  saveAccountProxy(input:AccountProxyInput):Promise<AppSnapshot>
  saveUpstreamProxy(input:UpstreamProxyInput):Promise<AppSnapshot>
  probeUpstreamProxy(input:UpstreamProxyProbeInput):Promise<ProxyProbeResult>
  cancelUpstreamProxyProbe(requestId:string):Promise<void>
  probeAccountProxy(input:ProxyProbeInput):Promise<ProxyProbeResult>
  cancelAccountProxyProbe(requestId:string):Promise<void>
  chooseLegacySessionTrash():Promise<LegacyTrashPage|undefined>
  legacySessionTrashPage(input:{snapshotId:string;page:number;pageSize?:number}):Promise<LegacyTrashPage>
  previewLegacySessionTrash(input:LegacyTrashImportInput):Promise<TrashPreview>
  discardLegacySessionTrash():Promise<void>
  sessionTrashState():Promise<TrashState>
  listSessionTrash():Promise<TrashPage>
  sessionTrashPage(input:{snapshotId:string;page:number;pageSize?:number}):Promise<TrashPage>
  previewSessionTrash(input:TrashPreviewInput):Promise<TrashPreview>
  previewSessionTrashAction(input:TrashActionInput):Promise<TrashPreview>
  startSessionTrash(input:{ticket:string;confirmed:true}):Promise<TrashState>
  discardSessionTrash():Promise<void>
  cancelSessionTrash(id:string):Promise<TrashState>
  recoverSessionTrash(input:{id:string;mode:'resume'|'restore'|'discard';applicationId?:string;clientsClosed:true}):Promise<TrashState>
  openSessionTrashBackup(id:string):Promise<void>
  sessionSyncState():Promise<{sync?:SyncView;recoveries:SyncRecovery[]}>
  previewSessionSync(input:SyncPreviewInput):Promise<SyncPreview>
  startSessionSync(input:{ticket:string;clientsClosed:true}):Promise<{sync?:SyncView;recoveries:SyncRecovery[]}>
  discardSessionSync():Promise<void>
  cancelSessionSync(id:string):Promise<{sync?:SyncView;recoveries:SyncRecovery[]}>
  retrySessionSync(input:{id:string;applicationId:string;clientsClosed:true}):Promise<{sync?:SyncView;recoveries:SyncRecovery[]}>
  openSessionSyncBackup(id:string):Promise<void>
  sessionArchiveState():Promise<ArchiveProgress|undefined>
  previewSessionExport(input:{snapshotId:string;sessionIds:string[]}):Promise<ArchivePreview>
  startSessionExport(ticket:string):Promise<ArchiveProgress|undefined>
  chooseSessionArchive():Promise<ArchivePreview|undefined>
  previewSessionImport(input:ArchiveImportInput):Promise<ArchiveImportPreview>
  startSessionImport(input:{ticket:string;clientsClosed:true}):Promise<ArchiveProgress>
  discardSessionArchive():Promise<void>
  cancelSessionArchive(id:string):Promise<ArchiveProgress|undefined>
  sessionTransferState():Promise<{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}>
  previewSessionCopy(input:SessionCopyPreviewInput):Promise<SessionCopyPreview>
  startSessionCopy(input:{ticket:string;clientsClosed:true}):Promise<{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}>
  discardSessionCopy():Promise<void>
  cancelSessionTransfer(id:string):Promise<{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}>
  retrySessionTransfer(input:{id:string;applicationId:string;clientsClosed:true}):Promise<{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}>
  openSessionTransferBackup(id:string):Promise<void>
  listSessionVisibilityRepairInstances():Promise<SessionVisibilityRepairInstanceList>
  listSessionVisibilityRepairProviders():Promise<SessionVisibilityRepairProviderList>
  previewSessionVisibilityRepair(input:SessionVisibilityRepairInput):Promise<SessionVisibilityRepairPreview>
  applySessionVisibilityRepair(input:SessionVisibilityRepairApplyInput):Promise<SessionVisibilityRepairSummary>
  discardSessionVisibilityRepair(ticket:string):Promise<void>
  cancelSessionVisibilityRepair(ticket:string):Promise<void>
  scanSessions(input:SessionScanInput):Promise<SessionPage>
  sessionPage(input:SessionPageInput):Promise<SessionPage>
  sessionTokenStats(input:{snapshotId:string;sessionIds:string[]}):Promise<SessionTokenResult[]>
  cancelSessionScan(runId:string):Promise<void>
  cancelSessionTokens(snapshotId:string):Promise<void>
  openSession(input:SessionSelection&{action:'location'|'file'|'copyId'}):Promise<void>
  mutateLocalAccess(input:LocalAccessMutation):Promise<AppSnapshot>
  startLocalAccess():Promise<AppSnapshot>
  stopLocalAccess():Promise<AppSnapshot>
  copyLocalAccessKey(id:string):Promise<void>
  load(): Promise<AppSnapshot>
  mutateProvider(input: ProviderMutation): Promise<AppSnapshot>
  readProviderKey(input: { id: string; revision: number; keyId: string }): Promise<string>
  readModelContextDefaults(models:string[]):Promise<import('./modelContextWindows').ModelContextDefault[]>
  readInstanceModelDefaults(clientType:import('./agentClients').AgentClientType):Promise<import('./instances').InstanceModelDefaults>
  fetchProviderModels(input:import('./providerModels').ProviderModelsInput):Promise<import('./providerModels').ProviderModelsResult>
  cancelProviderModels(requestId:string):Promise<void>
  startProviderProbe(input:ProviderProbeInput):Promise<AppSnapshot>
  cancelProviderProbe(runId:string):Promise<AppSnapshot>
  saveInstance(input:{id?:string;revision?:number;details:InstanceInput}):Promise<AppSnapshot>
  copyInstance(input:InstanceCopyInput):Promise<AppSnapshot>
  chooseInstanceCopySource():Promise<InstanceCopySource|undefined>
  discoverExternalInstanceSources():Promise<ExternalInstanceDiscovery>
  selectExternalInstanceSource(input:{id:string}):Promise<InstanceCopySource>
  copyExternalInstance(input:ExternalInstanceCopyInput):Promise<AppSnapshot>
  chooseExistingInstanceDirectory():Promise<InstanceCopySource|undefined>
  attachExistingInstance(input:AttachInstanceInput):Promise<AppSnapshot>
  cancelInstanceCopy(id:string):Promise<AppSnapshot>
  chooseInstanceApplication():Promise<AppSnapshot>
  chooseInstanceCli():Promise<AppSnapshot>
  chooseInstanceWorkingDirectory():Promise<InstanceWorkingDirectory|undefined>
  listInstanceWorkingDirectories():Promise<InstanceWorkingDirectory[]>
  removeInstance(input:Pick<InstanceProfile,'id'|'revision'>):Promise<AppSnapshot>
  previewInstanceLaunch(input:Pick<InstanceProfile,'id'|'revision'>):Promise<InstanceLaunchPreview>
  previewInstanceHistory(input:Pick<InstanceProfile,'id'|'revision'>):Promise<InstanceHistorySummary>
  startInstance(ticket:string):Promise<AppSnapshot>
  stopInstance(id:string):Promise<AppSnapshot>
  closeAllInstances():Promise<AppSnapshot>
  focusInstance(id:string):Promise<void>
  listClientConfigs(): Promise<ClientConfigTarget[]>
  chooseClientConfig(): Promise<ClientConfigTarget | undefined>
  readClientConfig(id: string): Promise<ClientConfigView>
  readClientIdentity(input:ClientIdentityInput):Promise<ClientIdentityView>
  importClientIdentity(ticket:string):Promise<{added:number;duplicates:number}>
  cancelClientIdentity(id:string):Promise<void>
  previewClientSwitch(input:{targetId:string;accountId:string}):Promise<ClientSwitchPreview>
  previewRestoreClientSwitch(input:{targetId:string}):Promise<ClientSwitchPreview>
  applyClientSwitch(input:{ticket:string;clientClosed:true}):Promise<ClientSwitchView[]>
  discardClientSwitch(targetId:string):Promise<void>
  listClientAuthorities():Promise<ClientAuthorityView[]>
  bindClientAuthority(input:{ticket:string;accountId:string}):Promise<ClientAuthorityView[]>
  syncClientAuthority(accountId:string):Promise<ClientAuthorityView[]>
  releaseClientAuthority(input:{targetId:string;clientClosed:true}):Promise<ClientAuthorityView[]>
  previewClientConfig(input: { id: string; revision: string; changes: ClientConfigChanges }): Promise<ClientConfigPreview>
  previewRestoreClientConfig(input: { id: string; backup: string }): Promise<ClientConfigPreview>
  applyClientConfig(ticket: string): Promise<ClientConfigView>
  discardClientConfig(): Promise<void>
  readModelCatalog(id: string): Promise<ModelCatalogView>
  previewModelCatalog(input: ModelCatalogInput): Promise<ClientConfigPreview>
  chooseModelCatalog(id: string): Promise<CatalogImport | undefined>
  readClientProviders(id:string):Promise<ProviderConfigView>
  previewClientProvider(input:ProviderConfigInput):Promise<ClientConfigPreview>
  recoverCredentials(): Promise<AppSnapshot>
  saveSettings(settings: Settings): Promise<AppSnapshot>
  addAccount(input: AccountInput): Promise<AppSnapshot>
  editAccount(input: AccountEdit): Promise<AppSnapshot>
  readAccountKey(input: AccountKeyRead): Promise<string>
  batchTags(input: z.infer<typeof batchTagsSchema>): Promise<AppSnapshot>
  saveGroup(input: { id?: string; group: GroupInput }): Promise<AppSnapshot>
  deleteGroup(id: string): Promise<AppSnapshot>
  reorderGroups(ids: string[]): Promise<AppSnapshot>
  groupMembers(input: z.infer<typeof groupMembersSchema>): Promise<AppSnapshot>
  deleteAccounts(ids: string[]): Promise<AppSnapshot>
  listAccountRecycle():Promise<AccountRecyclePage>
  pageAccountRecycle(input:{snapshotId:string;page:number;pageSize?:number}):Promise<AccountRecyclePage>
  previewAccountRecycle(input:AccountRecycleInput):Promise<AccountRecyclePreview>
  applyAccountRecycle(input:{ticket:string;confirmed:true;exportFirst?:boolean}):Promise<AccountRecycleResult>
  discardAccountRecycle():Promise<void>
  previewImport(text: string): Promise<ImportPreview>
  importAccounts(text: string): Promise<AppSnapshot>
  stageImport(text: string): Promise<StagedImport>
  chooseImportFile(selectionId?:string): Promise<StagedImport | undefined>
  cancelImportFileSelection(selectionId:string):Promise<void>
  commitImport(ticket: string): Promise<{ snapshot: AppSnapshot; added: number; duplicates: number; skipped: number; accountIds:string[] }>
  discardImport(ticket?:string): Promise<void>
  scanLocalData(requestId:string):Promise<import('./localDataMigration').LocalDataScan>
  chooseLocalData(requestId:string):Promise<import('./localDataMigration').LocalDataScan|undefined>
  previewLocalData(input:import('zod').infer<typeof import('./localDataMigration').localDataSelectionSchema>):Promise<import('./localDataMigration').LocalDataPreview>
  applyLocalData(input:{ticket:string;confirmed:true}):Promise<import('./localDataMigration').LocalDataResult>
  discardLocalData(ticket:string):Promise<void>
  cancelLocalData(requestId:string):Promise<void>
  exportAccounts(ids: string[]): Promise<{ count: number; cancelled: boolean }>
  startGateway(accountId: string): Promise<AppSnapshot>
  stopGateway(): Promise<AppSnapshot>
  copyGatewayKey(): Promise<void>
  startLogin(method: 'browser' | 'device'): Promise<AppSnapshot>
  startTempLogin(input:StartTempLogin):Promise<AppSnapshot>
  cancelTempLogin(id:string):Promise<AppSnapshot>
  openTempLoginURL(id:string):Promise<void>
  copyTempLoginURL(id:string):Promise<void>
  cleanupTempLogin():Promise<AppSnapshot>
  cancelLogin(): Promise<AppSnapshot>
  openLogin(): Promise<void>
  completeLogin(callbackUrl: string): Promise<AppSnapshot>
  refreshQuotas(ids: string[]): Promise<AppSnapshot>
  refreshAllQuotas(): Promise<AppSnapshot>
  cancelQuotaRefresh(): Promise<AppSnapshot>
  refreshSubscription(accountId: string): Promise<AppSnapshot>
  refreshResetCredits(accountId: string): Promise<AppSnapshot>
  consumeResetCredit(accountId: string): Promise<AppSnapshot>
  queryHistory(query: HistoryQuery): Promise<HistoryPage>
  exportHistory(filter: HistoryFilter): Promise<{ count: number; cancelled: boolean }>
  cancelHistoryExport(): Promise<void>
}
