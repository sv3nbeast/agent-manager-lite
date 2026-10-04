import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runtimeManifest, type RuntimeProfile, type QuotaReserveRuntimeSpec } from './runtimeManifest'
export type { RuntimeProfile } from './runtimeManifest'
import type { GatewayStatus, Settings } from '../shared/types'
import type { StoredAccount } from './store'
import { requestJSON } from './network'
import { AgentTaskProjection, type AdoptAgentTask } from './agentTaskProjection'
import { writeAgentRecovery } from './agentRecovery'
import { routingAccountState, type RoutingAccountState } from './accountRouting'
import {accountProxyURL,type ProxyState} from './proxyPolicy'
import {needsProxyTunnel} from './proxyCatalogBinding'
import type {ProxyTunnels,ProxyLease} from './proxyTunnels'

const TASK_SYNC_ERROR = '登录状态保存失败，运行凭据已保留，请重试保存并停止服务'

function authJSON(account: StoredAccount, tier?: string, proxy?:string): string {
  const managed = tier === undefined ? {} : { cml_default_service_tier: tier }
  if (account.kind === 'agent_identity') return JSON.stringify({ type: 'codex', ...managed,
    ...account.credentials.agentIdentity, proxy_url:proxy, auth_mode: 'agentIdentity', openai_auth_mode: 'agentIdentity', refresh_owner: 'codex_manager_lite' })
  return JSON.stringify({ type: 'codex', ...managed, proxy_url:proxy,access_token: account.credentials.accessToken,
    refresh_token: account.credentials.refreshToken, id_token: account.credentials.idToken,
    ...(!account.credentials.refreshToken && !account.credentials.idToken ? { auth_mode: 'personal_access_token', openai_auth_mode: 'personal_access_token' } : {}),
    account_id: account.credentials.accountId, email: account.email, refresh_owner: 'codex_manager_lite' })
}

// Each profile owns its process, loopback port and credentials directory. No installed Cockpit is used.
export class Gateway {
  private process?: ChildProcessWithoutNullStreams
  private directory?: string
  private status: GatewayStatus = { running: false }
  private starting = false
  private startTask?:Promise<GatewayStatus>
  private startControl?:AbortController
  private stopping?:Promise<void>
  private controlKey?: string
  private activeAccountIds=new Set<string>()
  private projectedCredentials=new Map<string,string>()
  private agentProjections=new Map<string,AgentTaskProjection>()
  private managedTiers=new Map<string,string>()
  private projectedProxies=new Map<string,string|undefined>()
  private proxyLeases:ProxyLease[]=[]
  private routingAccounts=new Map<string,RoutingAccountState & {routingUpdatedAtMs:number}>()
  private routingSyncFailures=new Set<string>()
  private quotaReserveSpecs=new Map<string,QuotaReserveRuntimeSpec>()
  constructor(private readonly binary: string, private readonly runtimeRoot: string,
    private readonly onEvent: (event: Record<string, unknown>) => void = () => {},
    private readonly adoptAgentTask?: AdoptAgentTask, private readonly proxyState:()=>ProxyState=()=>({}),private readonly tunnels?:Pick<ProxyTunnels,'acquire'>) {}
  current(): GatewayStatus { return { ...this.status } }
  runtimeDirectory(): string | undefined { return this.directory }
  usesAccount(id: string): boolean { return this.activeAccountIds.has(id) && (this.starting || this.status.running || Boolean(this.directory)) }
  accountIds():string[] {return [...this.activeAccountIds]}
  private writeRoutingAccounts(accounts:Map<string,RoutingAccountState & {routingUpdatedAtMs:number}>):void {
    const target=join(this.directory!,'quota-pool-state.json'),temporary=`${target}.${randomUUID()}.tmp`
    try {writeFileSync(temporary,JSON.stringify({accounts:Object.fromEntries(accounts)}),{mode:0o600,flag:'wx'});renameSync(temporary,target)}
    finally {rmSync(temporary,{force:true})}
    this.routingAccounts=accounts
  }
  private writeQuotaReserveState(accounts:Map<string,RoutingAccountState & {routingUpdatedAtMs:number}>):void {
    if(!this.directory || !this.quotaReserveSpecs.size)return
    const snapshots:Record<string,Record<string,unknown>>={}
    for(const id of this.quotaReserveSpecs.keys()){
      const observed=accounts.get(id)
      if(!observed)continue
      snapshots[id]={
        ...(observed.updatedAt===undefined?{}:{snapshotUpdatedAtUnixSeconds:observed.updatedAt}),
        ...(observed.primary?{hourlyRemainingPercent:observed.primary.remainingPercent,hourlyWindowPresent:true}:{hourlyWindowPresent:false}),
        ...(observed.secondary?{weeklyRemainingPercent:observed.secondary.remainingPercent,weeklyWindowPresent:true}:{weeklyWindowPresent:false})
      }
    }
    const target=join(this.directory,'quota-reserve-state.json'),temporary=`${target}.${randomUUID()}.tmp`
    try{writeFileSync(temporary,JSON.stringify({accounts:snapshots}),{mode:0o600,flag:'wx'});renameSync(temporary,target)}
    finally{rmSync(temporary,{force:true})}
  }
  updateRoutingAccount(account:StoredAccount):void {
    if(!this.status.running||this.stopping||!this.directory||!this.activeAccountIds.has(account.id))return
    const value=routingAccountState(account),prior=this.routingAccounts.get(account.id)
    const {routingUpdatedAtMs:_time,...previous}=prior??{}
    if(JSON.stringify(value)===JSON.stringify(previous)){
      this.routingSyncFailures.delete(account.id)
      if(!this.routingSyncFailures.size)delete this.status.quotaSyncError
      return
    }
    const accounts=new Map(this.routingAccounts)
    accounts.set(account.id,{...value,routingUpdatedAtMs:Math.max(Date.now(),(prior?.routingUpdatedAtMs??0)+1)})
    try{
      this.writeRoutingAccounts(accounts)
      this.writeQuotaReserveState(accounts)
      this.routingSyncFailures.delete(account.id)
      if(!this.routingSyncFailures.size)delete this.status.quotaSyncError
    }
    catch{this.routingSyncFailures.add(account.id);this.status.quotaSyncError='配额已保存，但同步到本地服务失败，请刷新用量重试';throw new Error(this.status.quotaSyncError)}
  }
  syncCredentials(id?:string): StoredAccount | undefined {
    try {
      let account:StoredAccount|undefined
      for(const [accountId,projection] of this.agentProjections)if(!id || id===accountId)account=projection.sync()
      if (this.status.error === TASK_SYNC_ERROR) delete this.status.error
      return account
    } catch {
      this.status.error = TASK_SYNC_ERROR
      throw new Error(TASK_SYNC_ERROR)
    }
  }
  async updateCredentials(account: StoredAccount): Promise<void> {
    if (!this.status.running || !this.activeAccountIds.has(account.id) || !this.directory || account.kind === 'api_key') return
    if (this.agentProjections.has(account.id)) {
      const current = this.syncCredentials(account.id)
      if (!current) return
      account = current
    }
    const credentials = authJSON(account,this.managedTiers.get(account.id),this.projectedProxies.get(account.id))
    if (credentials === this.projectedCredentials.get(account.id)) return
    const target = join(this.directory, 'auth', `${account.id}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    // Explicitly reload managed auth projections. Rotation is committed to the
    // encrypted authority first, so a projection failure never loses the token.
    try { writeFileSync(temporary, credentials, { mode: 0o600, flag: 'wx' }); renameSync(temporary, target) }
    finally { rmSync(temporary, { force: true }) }
    if (account.credentials.agentIdentity) this.agentProjections.get(account.id)?.projected(account.credentials.agentIdentity)
    await requestJSON(`http://127.0.0.1:${this.status.port}/v1/cockpit/auth/reload`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.controlKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ accountIds: [account.id] })
    }, '同步本地服务凭据')
    this.projectedCredentials.set(account.id,credentials)
  }
  start(profile: RuntimeProfile, settings: Settings, signal?:AbortSignal): Promise<GatewayStatus> {
    if (this.process || this.starting || this.stopping || this.directory) return Promise.reject(new Error('请先停止服务并保存登录状态，再应用配置'))
    this.startControl=new AbortController()
    const combined=AbortSignal.any([this.startControl.signal,...signal?[signal]:[]])
    const task=this.startRuntime(profile,settings,combined);this.startTask=task
    void task.finally(()=>{if(this.startTask===task){this.startTask=undefined;this.startControl=undefined}}).catch(()=>{})
    return task
  }
  private async startRuntime(profile:RuntimeProfile,settings:Settings,signal:AbortSignal):Promise<GatewayStatus>{
    signal?.throwIfAborted()
    this.starting = true
    try {
      mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 })
      this.directory = mkdtempSync(join(this.runtimeRoot, 'gateway-'))
      const authDir = join(this.directory, 'auth')
      mkdirSync(authDir, { mode: 0o700 })
      this.controlKey = `cml-management-${randomBytes(32).toString('hex')}`
      // Freeze every route, including API keys, before creating the manifest.
      // Engine-backed routes retain their lease until this gateway stops.
      for(const account of profile.pool?.accounts??[profile.account]) {
        let proxy=accountProxyURL(account,this.proxyState())
        if(proxy&&needsProxyTunnel(proxy)){
          if(!this.tunnels)throw new Error('代理引擎尚未接入')
          const lease=await this.tunnels.acquire(proxy,account.id,signal)
          this.proxyLeases.push(lease);proxy=lease.url
        }
        signal.throwIfAborted()
        this.projectedProxies.set(account.id,proxy)
      }
      const {accounts,tiers,manifest,config,priorities,quotaReserve}=runtimeManifest(profile,settings,this.controlKey,this.projectedProxies)
      const tier=tiers.get(profile.account.id)!
      this.activeAccountIds=new Set(accounts.map(account=>account.id))
      this.quotaReserveSpecs=new Map(Object.entries(quotaReserve))
      for(const account of accounts) {
        if(account.kind==='api_key') {
          if(!account.credentials.apiKey || !account.models.length)throw new Error('API 账号缺少密钥或模型')
          continue
        }
        if(account.kind==='oauth' && !account.credentials.accessToken)throw new Error('OAuth 账号缺少 access_token')
        if(account.kind==='agent_identity' && !account.credentials.agentIdentity)throw new Error('Agent Identity 凭据缺失')
        if(profile.pool)this.managedTiers.set(account.id,tiers.get(account.id)!.tier??'')
        const credentials=authJSON(account,this.managedTiers.get(account.id),this.projectedProxies.get(account.id))
        writeFileSync(join(authDir,`${account.id}.json`),credentials,{mode:0o600})
        this.projectedCredentials.set(account.id,credentials)
        if(account.credentials.agentIdentity && this.adoptAgentTask) {
          const directory=this.directory
          const projection=new AgentTaskProjection(account.id,join(authDir,`${account.id}.json`),account.credentials.agentIdentity,(id,identity,expected)=>this.adoptAgentTask!(id,identity,expected,account.generation),
            identity=>writeAgentRecovery(directory,account.id,identity,this.process?.pid,Boolean(profile.pool),account.generation))
          this.agentProjections.set(account.id,projection);projection.checkpoint()
        }
      }
      config['auth-dir']=authDir
      const manifestPath = join(this.directory, 'manifest.json'), configPath = join(this.directory, 'config.json')
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
      writeFileSync(join(this.directory,'api-key-priorities.json'),JSON.stringify(priorities),{mode:0o600})
      const routingAccounts=new Map(accounts.map(account=>[account.id,{...routingAccountState(account),routingUpdatedAtMs:Date.now()}]))
      this.writeRoutingAccounts(routingAccounts)
      this.writeQuotaReserveState(routingAccounts)
      signal.throwIfAborted()
      const childArgs=['-config', configPath, '-manifest', manifestPath,'-quota-pool-state',join(this.directory,'quota-pool-state.json'), '-parent-pid', String(process.pid)]
      if(this.quotaReserveSpecs.size)childArgs.push('-quota-reserve-state',join(this.directory,'quota-reserve-state.json'))
      const child = spawn(this.binary, childArgs, { stdio: 'pipe', windowsHide: true })
      const runtimeDirectory = this.directory
      this.process = child
      child.stderr.resume()
      // Only structured sidecar events are forwarded; arbitrary stdout/stderr can contain sensitive diagnostics.
      const lines = createInterface({ input: child.stdout })
      await new Promise<void>((resolve, reject) => {
        let ready = false
        const timeout = setTimeout(() => { reject(new Error('本地服务启动超时')); child.kill('SIGTERM') }, 20_000)
        const abort = () => { cleanup(); reject(new Error('操作已取消')); child.kill('SIGTERM') }
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort',abort) }
        signal?.addEventListener('abort',abort,{once:true})
        if(signal?.aborted)abort()
        child.once('error', error => { cleanup(); reject(error) })
        child.once('exit', code => {
          this.releaseProxies()
          cleanup(); this.process = undefined; this.status = { running: false, profileId:profile.id,
            error: ready ? (this.stopping ? undefined : `本地服务意外退出 (${code ?? child.signalCode})，请重新启动`) : `服务退出 (${code})` }
          try {
            this.syncCredentials()
            rmSync(runtimeDirectory, { recursive: true, force: true })
            if (this.directory === runtimeDirectory) { this.directory = undefined; this.clearProjections() }
          } catch {
            // Preserve the private runtime directory if the vault cannot commit.
            // stop() can retry; never silently discard the only recovered task.
            this.status.error = TASK_SYNC_ERROR
          }
          if (!ready) reject(new Error(`本地服务启动失败 (${code})，请检查账号配置或端口`))
        })
        lines.on('line', line => {
          let event: Record<string, unknown>
          try { event = JSON.parse(line) } catch { return }
          if (event.type === 'ready' && typeof event.port === 'number') {
            if(signal?.aborted)return
            ready = true; cleanup()
            this.status = { running: true, port: event.port, defaultTier: profile.pool?undefined:tier.tier, profileId: profile.id }
            resolve()
          }
          if (event.type === 'usage') {
            try { this.syncCredentials() } catch { /* syncCredentials exposes a retryable status. */ }
            // Source metadata describes this running profile, never the unsaved
            // UI or new settings that will apply only after a restart.
            const selectedId=typeof event.accountId==='string' && event.accountId?event.accountId:accounts.length===1?accounts[0].id:''
            const selectedTier=tiers.get(selectedId)
            const incoming = event.inboundServiceTier, outgoing = event.outboundServiceTier
            const tierSource = typeof outgoing !== 'string' ? 'unknown'
              : typeof incoming === 'string' && incoming ? (incoming === outgoing ? 'request' : 'transformed')
                : !outgoing ? 'follow' : outgoing === selectedTier?.tier ? selectedTier.source : 'transformed'
            this.onEvent({ ...event, accountId: selectedId, tierSource })
          } else this.onEvent(event)
        })
      })
      for(const projection of this.agentProjections.values())projection.checkpoint()
      return this.current()
    } catch (error) {
      await this.stopRuntime()
      throw error
    } finally { this.starting = false }
  }
  stop(): Promise<void> {
    if(this.stopping)return this.stopping
    this.startControl?.abort()
    const task=(async()=>{await this.startTask?.catch(()=>{});await this.stopRuntime()})();this.stopping=task
    void task.then(()=>{this.stopping=undefined},()=>{this.stopping=undefined})
    return task
  }
  private async stopRuntime(): Promise<void> {
    this.syncCredentials()
    const child = this.process
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
        child.once('close', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
    this.process = undefined
    this.releaseProxies()
    this.syncCredentials()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
    this.directory = undefined
    this.clearProjections()
    this.status = { running: false }
  }
  private clearProjections():void {
    this.releaseProxies()
    this.controlKey = undefined
    this.activeAccountIds.clear()
    this.managedTiers.clear()
    this.routingAccounts.clear()
    this.routingSyncFailures.clear()
    this.quotaReserveSpecs.clear()
    this.projectedCredentials.clear()
    this.agentProjections.clear()
  }
  private releaseProxies():void {for(const lease of this.proxyLeases)lease.release();this.proxyLeases=[];this.projectedProxies.clear()}
}
