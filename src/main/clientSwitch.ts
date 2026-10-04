import {accountProxyURL} from './proxyPolicy'
// File-mode native switching, adapted from Cockpit's pinned account_projection
// and account_runtime_switch. Credentials/journal stay in the encrypted vault.
import {createHash,randomUUID} from 'node:crypto'
import {lstatSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import {applyClientSwitchSchema,previewClientSwitchSchema,previewClientSwitchRestoreSchema,type ClientSwitchPreview,type ClientSwitchView} from '../shared/clientSwitch'
import {Store,type StoredAccount} from './store'
import {ClientConfigs,atomic,readBounded} from './clientConfig'
import {accountIdentity} from './accountIdentity'
import {configuredProviderAuth} from './clientIdentity'
import {authFor,authKeys,adoptNative as adopt,nativeIdentity,sameNativeAccount,ownsRefreshChain,nativeConfig,recoveryIdentity} from './nativeAccountProjection'
import {displayConfigValue} from './configJournal'
import {TokenAuthority,tokenClaims,tokenFresh} from './tokens'
import {TomlDocument,patchToml,scalarRaw,type TomlEdit} from './tomlPatch'
import {probeClientDaemon,assertClientDaemonStopped} from './clientDaemon'

export interface StoredClientSwitch {
  id:string;targetId:string;accountId:string;previousAccountId?:string;createdAt:number
  device:number;inode:number;status:ClientSwitchView['status']
  beforeAuth:string|null;nextAuth:string;beforeConfig:string|null;nextConfig:string
  paths?:string[][];providerGuards?:string[]
  instanceNonce?:string
}
export interface InstanceSwitchOwner {instanceId:string;nonce:string;model:string;tier?:string}
interface Snapshot {target:ClientSwitchPreview['target'];auth:string|null;config:string|null;device:number;inode:number}
interface Pending {view:ClientSwitchPreview;snapshot:Snapshot;stateHash:string;expires:number;record:StoredClientSwitch;auth:string|null;config:string;observed?:StoredAccount;observedId?:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacyPaths=[['model_provider'],['forced_login_method']]

export function assertNativeFileMode(doc:TomlDocument):void {
  if(doc.raw(['profile'])!==null)throw new Error('启用了 Profile，请先调整客户端配置后再切换原生账号')
  const mode=doc.scalar(['cli_auth_credentials_store'])
  if(doc.raw(['cli_auth_credentials_store'])!==null&&mode!=='file')throw new Error('此切换入口仅支持 file 凭据存储，不会更改存储模式或访问系统钥匙串')
}
export class ClientSwitches {
  private readonly pending=new Map<string,Pending>()
  private readonly checking=new Map<string,AbortController>()
  private stopped=false
  constructor(private readonly store:Store,private readonly configs:ClientConfigs,private readonly tokens:TokenAuthority,
    private readonly accountInUse:(id:string)=>boolean=()=>false,private readonly targetInUse:(id:string)=>boolean=()=>false,
    private readonly write:(file:string,content:string)=>void=atomic,private readonly now:()=>number=Date.now,
    private readonly probeDaemon:typeof probeClientDaemon=probeClientDaemon,private readonly instance?:InstanceSwitchOwner){}
  views():ClientSwitchView[]{
    const state=this.store.read()
    const current=new Map((state.clientSwitches??[]).map(record=>[record.targetId,record]))
    return [...current.values()].map(record=>({targetId:record.targetId,accountId:record.accountId,accountName:state.accounts.find(a=>a.id===record.accountId)?.name??'账号不可用',previousAccountName:state.accounts.find(a=>a.id===record.previousAccountId)?.name,status:record.status,createdAt:record.createdAt,historyDepth:state.clientSwitches!.filter(value=>value.targetId===record.targetId).length,instanceOwned:!!record.instanceNonce}))
  }
  usesAccount(id:string):boolean{return !!this.store.read().clientSwitches?.some(record=>record.accountId===id||record.previousAccountId===id)}
  usesTarget(id:string):boolean{return !!this.store.read().clientSwitches?.some(record=>record.targetId===id)}
  private snapshot(id:string):Snapshot {
    const target=this.configs.identityTarget(id),stat=lstatSync(target.directory)
    const config=readBounded(join(target.directory,'config.toml'),1024*1024),auth=readBounded(join(target.directory,'auth.json'),2*1024*1024)
    assertNativeFileMode(new TomlDocument(config??''))
    return {target,auth,config,device:stat.dev,inode:stat.ino}
  }
  private account(id:string,state=this.store.read()):StoredAccount {
    const account=state.accounts.find(value=>value.id===id)
    if(!account)throw new Error('账号已不存在，请重新选择')
    return account
  }
  private busy(targetId:string,ids:string[]):void {
    if(this.targetInUse(targetId)||ids.some(id=>this.accountInUse(id)||this.tokens.busy(id)))throw new Error('请先停止相关本地服务，并等待凭据刷新完成后重试')
  }
  private stateHash(record:StoredClientSwitch):string {
    const state=this.store.read(),ids=[record.accountId,record.previousAccountId]
    const accounts=state.accounts.filter(a=>ids.includes(a.id)),providers=new Set(accounts.map(account=>account.providerId))
    return hash([accounts,accounts.map(a=>accountProxyURL(a,state)),state.settings.defaultTier,state.providers?.filter(provider=>providers.has(provider.id)),state.clientAuthorities,state.clientSwitches,
      this.instance?state.instances?.find(profile=>profile.id===record.targetId):null])
  }
  preview(input:unknown):ClientSwitchPreview {
    const {targetId,accountId}=previewClientSwitchSchema.parse(input),state=this.store.read()
    const history=(state.clientSwitches??[]).filter(record=>record.targetId===targetId),latest=history.at(-1)
    if(this.instance){
      const profile=state.instances?.find(value=>value.id===targetId)
      if(targetId!==this.instance.instanceId||profile?.connectionMode!=='native'||profile.accountId!==accountId||history.length)throw new Error('实例原生登录与启动记录不一致，请先停止并恢复实例')
    }else if(history.some(record=>record.instanceNonce))throw new Error('此登录由实例维护，请从实例页面停止并恢复')
    if(history.some(record=>record.status!=='committed'))throw new Error('此目录有未完成切换，请先恢复')
    if(history.length>=100)throw new Error('此目录已有 100 次可恢复切换，请先逐次恢复后再切换')
    this.configs.prepareIdentityTarget(targetId)
    const snapshot=this.snapshot(targetId),account=this.account(accountId,state),doc=new TomlDocument(snapshot.config??'')
    if(latest)recoveryIdentity(snapshot.auth,snapshot.config,latest,state)
    const prior=nativeIdentity(snapshot.auth,doc)
    if(prior?.kind==='agent_identity')throw new Error('当前目录保存 Agent Identity，不支持原生切换')
    const matches=prior?state.accounts.filter(a=>sameNativeAccount(a,prior)):[]
    if(prior&&matches.length!==1)throw new Error('请先读取并导入当前客户端身份，使其唯一匹配账号库，再预览切换')
    const old=matches[0]
    if(latest&&latest.accountId!==old?.id)throw new Error('当前身份与最近一次切换不一致，请先恢复或核对客户端登录')
    if(old?.id===accountId&&!this.instance)throw new Error('客户端已保存此账号，请使用同步客户端凭据')
    const ids=[accountId,...old?[old.id]:[]];this.busy(targetId,ids)
    const rotatingIds=ids.filter(id=>ownsRefreshChain(this.account(id,state)))
    if(state.clientAuthorities?.some(binding=>ids.includes(binding.accountId)&&binding.targetId!==targetId)||state.clientSwitches?.some(r=>r.targetId!==targetId&&(rotatingIds.includes(r.accountId)||!!r.previousAccountId&&rotatingIds.includes(r.previousAccountId))))throw new Error('相关账号已由其他客户端或切换记录维护，请先解除其关联')
    const binding=state.clientAuthorities?.find(value=>value.targetId===targetId)
    if(binding&&binding.accountId!==old?.id)throw new Error('客户端文件与现有凭据关联不一致，请先处理原关联')
    if(old&&prior)adopt(state,old.id,prior)
    const nextAuth=authFor(account,snapshot.auth,state)
    if(typeof tokenClaims(account.credentials.accessToken).exp==='number'&&!tokenFresh(account.credentials.accessToken,30))throw new Error('目标账号的访问令牌已过期，请先刷新用量或重新登录')
    const projection=nativeConfig(snapshot.config,account,state,history),{paths,providerGuards}=projection
    let nextConfig=projection.config
    if(this.instance){
      const edits:TomlEdit[]=[{path:['cli_auth_credentials_store'],raw:scalarRaw('file')},{path:['model'],raw:scalarRaw(this.instance.model)},
        {path:['service_tier'],raw:scalarRaw(this.instance.tier==='priority'?'fast':this.instance.tier??null)}]
      nextConfig=patchToml(nextConfig,edits)
      for(const edit of edits)if(!paths.some(path=>JSON.stringify(path)===JSON.stringify(edit.path)))paths.push(edit.path)
    }
    // In particular, retain and enforce a forced workspace restriction.
    const projected=nativeIdentity(nextAuth,new TomlDocument(nextConfig))
    if(!projected||!sameNativeAccount(account,projected))throw new Error('目标配置与账号连接不一致，已取消切换')
    const record:StoredClientSwitch={id:randomUUID(),targetId,accountId,previousAccountId:old?.id,createdAt:this.now(),device:snapshot.device,inode:snapshot.inode,status:'prepared',beforeAuth:snapshot.auth,nextAuth,beforeConfig:snapshot.config,nextConfig,paths,providerGuards,instanceNonce:this.instance?.nonce}
    return this.stage('switch',snapshot,record,nextAuth,nextConfig,prior,old?.id,account)
  }
  previewRestore(input:unknown):ClientSwitchPreview {
    const {targetId}=previewClientSwitchRestoreSchema.parse(input),state=this.store.read(),record=state.clientSwitches?.filter(value=>value.targetId===targetId).at(-1)
    if(!record)throw new Error('此目录没有可恢复的账号切换')
    if(record.instanceNonce!==this.instance?.nonce||this.instance&&targetId!==this.instance.instanceId)throw new Error('此登录由实例维护，请从实例页面停止并恢复')
    if(state.clientAuthorities?.some(binding=>binding.targetId!==targetId&&(binding.accountId===record.accountId||binding.accountId===record.previousAccountId)))throw new Error('相关账号由其他客户端维护，请先处理该关联再恢复')
    const snapshot=this.snapshot(targetId)
    if(snapshot.device!==record.device||snapshot.inode!==record.inode)throw new Error('切换目录已被替换，原凭据记录仍保留')
    this.busy(targetId,[record.accountId,...record.previousAccountId?[record.previousAccountId]:[]])
    const current=new TomlDocument(snapshot.config??''),before=new TomlDocument(record.beforeConfig??''),after=new TomlDocument(record.nextConfig)
    const edits:TomlEdit[]=[]
    for(const path of record.paths??legacyPaths){
      const raw=current.raw(path)
      if(path.length===1&&['model','service_tier'].includes(path[0])&&raw!==before.raw(path)&&raw!==after.raw(path))continue
      if(raw!==before.raw(path)&&raw!==after.raw(path))throw new Error('登录相关配置已被外部修改，已保留当前身份和配置，请先核对后再恢复')
      edits.push({path,raw:before.raw(path)})
    }
    for(const provider of record.providerGuards??[]){
      const path=['model_providers',provider],value=current.subtree(path)
      if(value!==before.subtree(path)&&value!==after.subtree(path))throw new Error('Provider 连接或鉴权配置已被外部修改，请先核对后再恢复')
    }
    const {observed,observedId}=recoveryIdentity(snapshot.auth,snapshot.config,record,state)
    if(observed&&observedId)adopt(state,observedId,observed)
    // Exact ownership still holds when no client/editor changed the projection.
    // Preserve the original formatting instead of accumulating removed lines.
    const config=snapshot.config===record.nextConfig?record.beforeConfig??'':patchToml(snapshot.config??'',edits)
    // Always use the current library chain, never replay the backed-up RT.
    const account=record.previousAccountId?this.account(record.previousAccountId,state):undefined
    if(!account&&snapshot.auth!==null&&Object.keys(JSON.parse(snapshot.auth)).some(key=>!authKeys.has(key.toLowerCase())))throw new Error('原目录没有登录，当前凭据文件新增了其他字段，已保留文件，请先核对这些修改')
    const configOnlyAPI=account?.kind==='api_key'&&record.beforeAuth===null&&configuredProviderAuth(before)!==null
    const auth=account&&!configOnlyAPI?authFor(account,snapshot.auth??record.beforeAuth,state):null
    if(account){const projected=nativeIdentity(auth,new TomlDocument(config));if(!projected||!sameNativeAccount(account,projected))throw new Error('恢复配置与原账号连接不一致，已保留当前文件')}
    return this.stage('restore',snapshot,record,auth,config,observed,observedId,account)
  }
  private stage(kind:ClientSwitchPreview['kind'],snapshot:Snapshot,record:StoredClientSwitch,auth:string|null,config:string,observed:StoredAccount|undefined,observedId:string|undefined,account:StoredAccount|undefined):ClientSwitchPreview {
    const before=new TomlDocument(snapshot.config??''),after=new TomlDocument(config)
    const view:ClientSwitchPreview={ticket:randomUUID(),kind,target:snapshot.target,before:observed?accountIdentity(observed):undefined,after:account?accountIdentity(account):undefined,
      changes:(record.paths??legacyPaths).filter(path=>before.raw(path)!==after.raw(path)).map(path=>({key:path.join('.'),before:displayConfigValue(path,before.raw(path)),after:displayConfigValue(path,after.raw(path))}))}
    this.discard(snapshot.target.id)
    this.pending.set(view.ticket,{view,snapshot,stateHash:this.stateHash(record),expires:this.now()+300000,record:structuredClone(record),auth,config,observed,observedId})
    return structuredClone(view)
  }
  // The UI always enters through this bounded, cancellable preflight. Keep the
  // actual transaction synchronous so no await can interleave its file commits.
  async applyWhenClosed(input:unknown):Promise<ClientSwitchView[]>{
    const {ticket}=applyClientSwitchSchema.parse(input),pending=this.pending.get(ticket)
    if(this.stopped)throw new Error('应用正在退出，账号切换已取消')
    if(!pending||pending.expires<this.now())throw new Error('切换预览已过期，请重新预览')
    const targetId=pending.record.targetId
    if(this.checking.has(targetId))throw new Error('此目录正在检查后台进程，请等待完成')
    const target=this.configs.identityTarget(targetId),controller=new AbortController()
    this.checking.set(targetId,controller)
    try{
      const state=await this.probeDaemon(target.directory,controller.signal)
      assertClientDaemonStopped(controller.signal.aborted?'cancelled':state)
      // apply revalidates file, directory, library and ticket versions after the
      // asynchronous probe. A closed socket does not prove all clients stopped;
      // the explicit user confirmation remains mandatory.
      return this.apply(input)
    }finally{this.checking.delete(targetId)}
  }
  apply(input:unknown):ClientSwitchView[]{
    const {ticket}=applyClientSwitchSchema.parse(input),pending=this.pending.get(ticket)
    if(!pending||pending.expires<this.now())throw new Error('切换预览已过期，请重新预览')
    this.pending.delete(ticket)
    const {snapshot,record,view}=pending
    this.busy(record.targetId,[record.accountId,...record.previousAccountId?[record.previousAccountId]:[]])
    const current=this.snapshot(record.targetId)
    if(hash(current)!==hash(snapshot)||this.stateHash(record)!==pending.stateHash)throw new Error('客户端或账号已变化，请重新预览')
    // Durably block both token chains before the first file write. On crash,
    // the user can inspect and restore this journal after restarting the app.
    this.store.transaction(state=>{
      if(pending.observed&&pending.observedId)adopt(state,pending.observedId,pending.observed)
      if(view.kind==='switch')state.clientSwitches=[...(state.clientSwitches??[]),record]
      else state.clientSwitches!.find(value=>value.id===record.id)!.status='restoring'
    })
    const verify=(config:string|null,auth:string|null)=>{
      const current=this.snapshot(record.targetId)
      if(current.device!==record.device||current.inode!==record.inode||current.config!==config||current.auth!==auth)throw new Error('客户端文件在切换时发生变化')
    }
    try{
      verify(snapshot.config,snapshot.auth)
      if(pending.config!==snapshot.config)this.write(join(snapshot.target.directory,'config.toml'),pending.config)
      verify(pending.config,snapshot.auth)
      if(pending.auth!==snapshot.auth){
        if(pending.auth===null)rmSync(join(snapshot.target.directory,'auth.json'),{force:true})
        else this.write(join(snapshot.target.directory,'auth.json'),pending.auth)
      }
      verify(pending.config,pending.auth)
      this.store.transaction(state=>{
        state.clientAuthorities=(state.clientAuthorities??[]).filter(binding=>binding.targetId!==record.targetId)
        const accountId=view.kind==='switch'?record.accountId:record.previousAccountId
        if(accountId&&ownsRefreshChain(this.account(accountId,state)))state.clientAuthorities.push({targetId:record.targetId,accountId,createdAt:this.now()})
        if(view.kind==='switch')state.clientSwitches!.find(value=>value.id===record.id)!.status='committed'
        else state.clientSwitches=state.clientSwitches!.filter(value=>value.id!==record.id)
      })
    }catch{throw new Error('切换未完整提交；加密恢复记录已保留，请保持客户端关闭并预览恢复原账号')}
    return this.views()
  }
  discard(targetId:string):void {z.string().uuid().parse(targetId);this.checking.get(targetId)?.abort();for(const [ticket,pending]of this.pending)if(pending.record.targetId===targetId||pending.expires<this.now())this.pending.delete(ticket)}
  stop():void {this.stopped=true;for(const controller of this.checking.values())controller.abort();this.pending.clear()}
}
