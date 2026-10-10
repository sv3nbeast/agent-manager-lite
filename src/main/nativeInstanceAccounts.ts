import {accountProxyURL} from './proxyPolicy'
// Native profile injection follows Cockpit instance/runtime_switch semantics.
// Reuse the encrypted file transaction and keep the official client as refresh
// owner until its owned process is stopped and the final token chain is saved.
import type {InstanceProfile} from '../shared/instances'
import {join} from 'node:path'
import {Store,type StoredAccount} from './store'
import {ClientConfigs,readBounded} from './clientConfig'
import {ClientSwitches,assertNativeFileMode,type InstanceSwitchOwner} from './clientSwitch'
import {TokenAuthority} from './tokens'
import {ownsRefreshChain,nativeIdentity,sameNativeAccount,adoptNative} from './nativeAccountProjection'
import {TomlDocument} from './tomlPatch'
import {probeClientDaemon,assertClientDaemonStopped} from './clientDaemon'

export class NativeInstanceAccounts {
  private operation:Promise<void>=Promise.resolve()
  constructor(private readonly store:Store,private readonly tokens:TokenAuthority,
    private readonly accountInUse:(id:string,targetId:string)=>boolean=()=>false,
    private readonly project:(account:StoredAccount)=>void|Promise<void>=()=>{}){}
  async prepare(profile:InstanceProfile,signal:AbortSignal):Promise<void> {
    this.validate(profile)
    const configs=new ClientConfigs(this.store),target=configs.identityTarget(profile.id)
    assertClientDaemonStopped(await probeClientDaemon(target.directory,signal))
    signal.throwIfAborted();this.validate(profile)
    if(this.tokens.busy(profile.accountId))throw new Error('账号正在刷新，请完成后再启动原生实例')
    const config=readBounded(join(target.directory,'config.toml'),1024*1024),raw=readBounded(join(target.directory,'auth.json'),2*1024*1024),doc=new TomlDocument(config??'')
    assertNativeFileMode(doc)
    const observed=nativeIdentity(raw,doc),account=this.store.read().accounts.find(value=>value.id===profile.accountId)!
    configs.identityTarget(profile.id)
    if(readBounded(join(target.directory,'config.toml'),1024*1024)!==config||readBounded(join(target.directory,'auth.json'),2*1024*1024)!==raw)throw new Error('实例登录文件正在变化，请重新预览')
    // A dormant profile may hold the latest rotation. Observe it before the
    // manager considers refreshing a stale library token with the same identity.
    if(observed&&sameNativeAccount(account,observed)&&JSON.stringify(account.credentials)!==JSON.stringify(observed.credentials))this.store.transaction(state=>adoptNative(state,account.id,observed))
  }
  validate(profile:InstanceProfile):void {
    const state=this.store.read(),account=state.accounts.find(value=>value.id===profile.accountId)
    if(!account)throw new Error('绑定账号不存在')
    accountProxyURL(account,state) // Validate the route; Instances applies it before injecting credentials.
    if(account.kind==='agent_identity')throw new Error('Agent Identity 仅支持本地 API 接入，请切换实例的账号接入方式')
    if(account.kind==='api_key'&&(account.wireApi!=='responses'||!account.models.includes(profile.model)))throw new Error('原生 API 接入需要 Responses 协议和账号支持的模型，请改用本地 API 或调整模型')
    if((ownsRefreshChain(account)||account.credentials.refreshToken)&&this.accountInUse(account.id,profile.id))throw new Error('此账号正在被其他服务或实例使用，请先停止后再启动原生实例')
    if(state.clientAuthorities?.some(binding=>binding.accountId===account.id&&binding.targetId!==profile.id)||state.clientSwitches?.some(record=>record.targetId===profile.id||account.credentials.refreshToken&&(record.accountId===account.id||record.previousAccountId===account.id)))throw new Error('此账号或目录仍有原生登录关联或恢复记录，请先处理后再启动实例')
  }
  private service(profile:InstanceProfile,nonce:string,tier?:string):ClientSwitches {
    const owner:InstanceSwitchOwner={instanceId:profile.id,nonce,model:profile.model,tier}
    return new ClientSwitches(this.store,new ClientConfigs(this.store),this.tokens,id=>{
      const account=this.store.read().accounts.find(value=>value.id===id)
      return !!account&&(ownsRefreshChain(account)||!!account.credentials.refreshToken)&&this.accountInUse(id,profile.id)
    },undefined,undefined,undefined,undefined,owner)
  }
  private serial(action:()=>Promise<void>):Promise<void> {
    const current=this.operation.then(action)
    this.operation=current.catch(()=>{})
    return current
  }
  inject(profile:InstanceProfile,nonce:string,tier:string|undefined,signal:AbortSignal,verify:()=>void=()=>{}):Promise<void> {
    return this.serial(()=>{verify();return this.injectNow(profile,nonce,tier,signal)})
  }
  private async injectNow(profile:InstanceProfile,nonce:string,tier:string|undefined,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();this.validate(profile)
    const service=this.service(profile,nonce,tier),cancel=()=>service.stop()
    signal.addEventListener('abort',cancel,{once:true})
    try{
      const preview=service.preview({targetId:profile.id,accountId:profile.accountId})
      if(signal.aborted)cancel()
      await service.applyWhenClosed({ticket:preview.ticket,clientClosed:true})
      signal.throwIfAborted()
      try{await this.project(this.store.read().accounts.find(account=>account.id===profile.accountId)!)}
      catch{throw new Error('原生登录已保存，但其他本地连接尚未同步，请重试启动')}
    }finally{signal.removeEventListener('abort',cancel);service.stop()}
  }
  restore(profile:InstanceProfile,nonce:string):Promise<void> {return this.serial(()=>this.restoreNow(profile,nonce))}
  private async restoreNow(profile:InstanceProfile,nonce:string):Promise<void> {
    const records=this.store.read().clientSwitches?.filter(record=>record.targetId===profile.id)??[]
    if(records.length){
      if(records.length!==1||records[0].instanceNonce!==nonce)throw new Error('实例登录恢复记录归属不一致，已保留原文件')
      const service=this.service(profile,nonce)
      try{await service.applyWhenClosed({ticket:service.previewRestore({targetId:profile.id}).ticket,clientClosed:true})}
      finally{service.stop()}
    }
    const state=this.store.read(),ids=new Set([profile.accountId,...(state.clientAuthorities??[]).filter(binding=>binding.targetId===profile.id).map(binding=>binding.accountId)])
    try{await Promise.all(state.accounts.filter(account=>ids.has(account.id)).map(account=>this.project(account)))}
    catch{throw new Error('实例最新凭据已保存，但其他本地连接尚未同步，请重试停止')}
  }
}
