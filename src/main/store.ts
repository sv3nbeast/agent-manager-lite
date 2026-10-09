import type {StoredCatalogSource} from './proxyCatalog'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { settingsSchema, type Settings, type Account, type AppSnapshot, type AccountGroup } from '../shared/types'
import type { AgentIdentity } from './agentIdentityCredentials'
import type { StoredConfigTarget } from '../shared/clientConfig'
import type { StoredLocalAccess } from '../shared/localAccess'
import type { InstanceProfile, InstanceApplication, InstanceWorkingDirectory } from '../shared/instances'
import type {StoredClientSwitch} from './clientSwitch'
import type {StoredClientAuthority} from '../shared/clientAuthority'
import { providerSummaries, type StoredProvider } from './providerLibrary'
import {accountProxyView,type StoredAccountProxy,type ProxyState} from './proxyPolicy'
import {proxyResourcesView} from './proxyResources'
import {upstreamProxyView} from './upstreamProxy'
import type { StoredWakeupState, WakeupView } from '../shared/wakeup'
import type { SshServersView } from '../shared/ssh'

export interface StoredAccount extends Omit<Account, 'credentialConfigured'|'egressProxy'> {
  proxy?:StoredAccountProxy
  generation?:string
  providerUsageRevision?:number
  credentials: { apiKey?: string; accessToken?: string; refreshToken?: string; idToken?: string; accountId?: string; lastRefresh?: string; localAPIKey?: string; agentIdentity?: AgentIdentity }
  source?: Record<string, unknown>
}
export interface RecycledAccount {id:string;deletedAt:number;account:StoredAccount;groupIds:string[];providerDefault?:StoredAccount['defaultTier'];providerModelContextWindows?:Record<string,number>}
export interface LocalDataArchive { id:string; fingerprint:string; importedAt:number; sources:{path:string;format:string;files:{path:string;hash:string;content:unknown}[]}[] }
export interface State extends ProxyState { localDataArchives?:LocalDataArchive[]; proxyCatalogs?:StoredCatalogSource[]; version: 1; settings: Settings; accounts: StoredAccount[]; groups: AccountGroup[]; accountRecycle?:RecycledAccount[]; configTargets?: StoredConfigTarget[]; providers?: StoredProvider[]; instances?:InstanceProfile[]; instanceApplications?:InstanceApplication[];instanceWorkingDirectories?:InstanceWorkingDirectory[]; localAccess?:StoredLocalAccess;clientAuthorities?:StoredClientAuthority[];clientSwitches?:StoredClientSwitch[];wakeup?:StoredWakeupState; sshServers?:SshServersView }
export interface VaultCodec { encrypt(text: string): Buffer; decrypt(data: Buffer): string }

function stripUnreleasedBindingHints(state: State): void {
  const drop = (value: Record<string, unknown>) => {
    delete value.boundInstanceId
    delete value.boundOauthAccountId
  }
  for (const account of state.accounts) drop(account as unknown as Record<string, unknown>)
  for (const recycled of state.accountRecycle ?? []) drop(recycled.account as unknown as Record<string, unknown>)
  for (const provider of state.providers ?? []) drop(provider as unknown as Record<string, unknown>)
  if (state.localAccess) drop(state.localAccess as unknown as Record<string, unknown>)
}

export class Store {
  private state: State
  private readonly path: string
  constructor(readonly directory: string, private readonly codec: VaultCodec) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'state.vault')
    this.state = { version: 1, settings: settingsSchema.parse({}), accounts: [], groups: [] }
    if (existsSync(this.path)) {
      const state = JSON.parse(codec.decrypt(readFileSync(this.path))) as State
      if (state.version !== 1 || !Array.isArray(state.accounts)) throw new Error('数据版本或格式不兼容，原文件已保留')
      state.settings = settingsSchema.parse(state.settings)
      state.groups ??= []
      stripUnreleasedBindingHints(state)
      this.state = state
    }
  }
  read(): State { return structuredClone(this.state) }
  proxyState():ProxyState{return structuredClone({upstreamProxy:this.state.upstreamProxy,proxyResources:this.state.proxyResources,unifiedProxy:this.state.unifiedProxy})}
  transaction(update: (state: State) => void): void {
    const next = this.read()
    update(next)
    next.settings = settingsSchema.parse(next.settings)
    const encrypted = this.codec.encrypt(JSON.stringify(next))
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path)
    } finally { rmSync(temporary, { force: true }) }
    this.state = next
  }
  snapshot(): AppSnapshot {
    return {
      settings: structuredClone(this.state.settings), dataDirectory: this.directory,
      providers: providerSummaries(this.state),proxyResources:proxyResourcesView(this.state),upstreamProxy:upstreamProxyView(this.state),
      ...(this.state.sshServers ? { sshServers: structuredClone(this.state.sshServers) } : {}),
      groups: structuredClone(this.state.groups).sort((a, b) => a.sortOrder - b.sortOrder),
      accounts: this.state.accounts.map(({ credentials, source: _source, generation:_generation, providerUsageRevision:_usageRevision, proxy, ...account }) => ({
        ...structuredClone(account), credentialConfigured: Boolean(credentials.apiKey || credentials.accessToken || credentials.agentIdentity),
        egressProxy:accountProxyView({...account,credentials,proxy},this.state),
        needsTokenExchange: account.kind === 'oauth' && !credentials.accessToken && Boolean(credentials.refreshToken)
      })),
      ...(this.state.wakeup ? { wakeup: { enabled: this.state.wakeup.enabled, tasks: structuredClone(this.state.wakeup.tasks), history: structuredClone(this.state.wakeup.history), runningTaskIds: [] } satisfies WakeupView } : {})
    }
  }
}
