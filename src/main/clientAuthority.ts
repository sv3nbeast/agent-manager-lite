import {accountProxyURL} from './proxyPolicy'
// Authority snapshot acceptance follows Cockpit's pinned
// codex_account_authority_sync.rs. This file-backed ownership stage deliberately
// does not rotate a refresh token while the official client owns its chain.
import {join} from 'node:path'
import {z} from 'zod'
import {bindClientAuthoritySchema,releaseClientAuthoritySchema,type ClientAuthorityView,type StoredClientAuthority} from '../shared/clientAuthority'
import {Store,type StoredAccount} from './store'
import {ClientConfigs,readBounded} from './clientConfig'
import {ClientIdentities,accountFromAuth} from './clientIdentity'
import {TomlDocument} from './tomlPatch'
import {TokenAuthority,tokenClaims,tokenFresh} from './tokens'
import {accountIdentity,compareIdentity} from './accountIdentity'

const credentials=(account:StoredAccount)=>JSON.stringify(account.credentials)
function compatible(library:StoredAccount,observed:StoredAccount):void {
  if(library.kind!=='oauth'||observed.kind!=='oauth'||compareIdentity(accountIdentity(library),accountIdentity(observed))!=='matched')throw new Error('客户端身份与关联账号不一致，已暂停同步并保留账号库凭据')
  const before=tokenClaims(library.credentials.accessToken).exp,after=tokenClaims(observed.credentials.accessToken).exp
  if(typeof before==='number'&&typeof after==='number'&&after<before)throw new Error('客户端凭据早于账号库版本，请在客户端重新登录后再同步')
  if(!observed.credentials.accessToken)throw new Error('客户端尚未保存可用的访问令牌，请先完成登录')
}

export class ClientAuthority {
  private readonly observations=new Map<string,{lastSyncedAt?:number;error?:string}>()
  private readonly pending=new Map<string,Promise<StoredAccount>>()
  constructor(private readonly store:Store,private readonly configs:ClientConfigs,private readonly identities:ClientIdentities,
    private readonly tokens:TokenAuthority,private readonly project:(account:StoredAccount)=>void|Promise<void>=()=>{},private readonly targetInUse:(id:string)=>boolean=()=>false){
    tokens.setExternalAuthority((id,options)=>this.ensure(id,options))
  }
  usesAccount(id:string):boolean{return (this.store.read().clientAuthorities??[]).some(entry=>entry.accountId===id)}
  busy(id:string):boolean{return this.pending.has(id)}
  usesTarget(id:string):boolean{return (this.store.read().clientAuthorities??[]).some(entry=>entry.targetId===id)}
  views():ClientAuthorityView[]{
    const state=this.store.read(),targets=this.configs.targets()
    return (state.clientAuthorities??[]).map(entry=>({...entry,accountName:state.accounts.find(account=>account.id===entry.accountId)?.name??'账号已不可用',
      directory:targets.find(target=>target.id===entry.targetId)?.directory??'目录已不可用',...this.observations.get(entry.targetId)}))
  }
  private binding(accountId:string):StoredClientAuthority {
    const binding=this.store.read().clientAuthorities?.find(entry=>entry.accountId===accountId)
    if(!binding)throw new Error('客户端凭据关联已不存在')
    return binding
  }
  private read(binding:StoredClientAuthority):StoredAccount|null {
    if(this.store.read().clientSwitches?.some(record=>record.targetId===binding.targetId&&record.status!=='committed'))throw new Error('客户端切换尚未完成，请先恢复原账号')
    const target=this.configs.identityTarget(binding.targetId)
    const config=readBounded(join(target.directory,'config.toml'),1024*1024),doc=new TomlDocument(config??'')
    if(doc.scalar(['profile']))throw new Error('客户端已启用 Profile，当前同步已暂停')
    const mode=doc.scalar(['cli_auth_credentials_store'])
    if(mode!==null&&mode!=='file')throw new Error('客户端不再使用文件凭据，当前同步已暂停；不会自动读取系统凭据库')
    // Match the actual active login, not a stale auth.json next to a custom
    // provider's environment, command or direct bearer authentication.
    const provider=doc.scalar(['model_provider'])??'openai'
    if(provider!=='openai'&&doc.scalar(['model_providers',String(provider),'requires_openai_auth'])!==true)throw new Error('客户端当前 Provider 不使用此登录身份，已暂停同步')
    const raw=readBounded(join(target.directory,'auth.json'),2*1024*1024)
    if(raw===null)return null
    const observed=accountFromAuth(raw,doc)
    this.configs.identityTarget(binding.targetId)
    if(readBounded(join(target.directory,'config.toml'),1024*1024)!==config||readBounded(join(target.directory,'auth.json'),2*1024*1024)!==raw)throw new Error('客户端文件正在更新，请重试同步')
    return observed
  }
  private adopt(state:ReturnType<Store['read']>,id:string,observed:StoredAccount):StoredAccount {
    const account=state.accounts.find(value=>value.id===id)
    if(!account)throw new Error('关联账号已删除')
    compatible(account,observed)
    // Absence means the client's current file no longer supplies a refresh
    // token. Retaining the old one would resurrect a different token chain.
    account.credentials={...account.credentials,accessToken:observed.credentials.accessToken,idToken:observed.credentials.idToken,
      refreshToken:observed.credentials.refreshToken,accountId:observed.credentials.accountId}
    account.email=observed.email??account.email;account.plan=observed.plan??account.plan
    delete account.error;delete account.errorAt
    return structuredClone(account)
  }
  async bind(raw:unknown):Promise<ClientAuthorityView[]> {
    const input=bindClientAuthoritySchema.parse(raw),snapshot=this.identities.takeFileSnapshot(input.ticket)
    if(this.store.read().clientSwitches?.some(record=>record.targetId===snapshot.target.id||record.accountId===input.accountId||record.previousAccountId===input.accountId))throw new Error('请先恢复原账号后再更改凭据关联')
    if(this.targetInUse(snapshot.target.id))throw new Error('请先停止此受管实例，再关联原生登录')
    if(this.tokens.busy(input.accountId))throw new Error('此账号正在刷新，请等待完成后重新读取客户端身份')
    let account!:StoredAccount
    this.store.transaction(state=>{
      if(state.clientAuthorities?.some(entry=>entry.targetId===snapshot.target.id||entry.accountId===input.accountId))throw new Error('此客户端或账号已有关联，请先查看现有关联')
      const current=state.accounts.find(value=>value.id===input.accountId)
      if(!current)throw new Error('请先将此身份导入账号库')
      if(accountProxyURL(current,state)!==undefined)throw new Error('此账号已配置出口代理，原生客户端代理尚未接入，请使用本地 API 模式')
      compatible(current,snapshot.account)
      // An RT-only/email-only match cannot authorize an external refresh owner.
      const identity=accountIdentity(snapshot.account)
      if(!identity.accountId&&!identity.userId)throw new Error('身份缺少工作区或用户标识，无法建立刷新权威关联')
      account=this.adopt(state,input.accountId,snapshot.account)
      state.clientAuthorities=[...(state.clientAuthorities??[]),{targetId:snapshot.target.id,accountId:input.accountId,createdAt:Date.now()}]
    })
    const operation=Promise.resolve().then(async()=>{
      try{await this.project(account)}catch{throw new Error('客户端凭据已保存，但本地服务尚未同步，请重试同步')}
      return account
    }).finally(()=>this.pending.delete(input.accountId))
    this.pending.set(input.accountId,operation)
    try{await operation;this.observations.set(snapshot.target.id,{lastSyncedAt:Date.now()})}
    catch{this.observations.set(snapshot.target.id,{error:'客户端凭据已保存，但本地服务尚未同步，请重试同步'})}
    return this.views()
  }
  sync(accountId:string):Promise<StoredAccount>{
    z.string().uuid().parse(accountId)
    const pending=this.pending.get(accountId);if(pending)return pending
    const binding=this.binding(accountId)
    const operation=Promise.resolve().then(async()=>{
      const observed=this.read(binding)
      if(!observed)throw new Error('客户端已退出登录或凭据文件不存在，已暂停本地刷新')
      const prior=this.store.read().accounts.find(account=>account.id===accountId)
      if(!prior)throw new Error('关联账号已删除')
      compatible(prior,observed)
      let account=prior
      if(credentials(prior)!==credentials({...prior,credentials:{...prior.credentials,accessToken:observed.credentials.accessToken,idToken:observed.credentials.idToken,refreshToken:observed.credentials.refreshToken,accountId:observed.credentials.accountId}})||observed.email!==undefined&&prior.email!==observed.email||observed.plan!==undefined&&prior.plan!==observed.plan){
        this.store.transaction(state=>{account=this.adopt(state,accountId,observed)})
      }
      try{await this.project(account)}catch{throw new Error('客户端凭据已保存，但本地服务尚未同步，请重试同步')}
      this.observations.set(binding.targetId,{lastSyncedAt:Date.now()});return account
    }).catch(error=>{
      const notice=error instanceof Error?error.message:'客户端凭据同步失败'
      this.observations.set(binding.targetId,{...this.observations.get(binding.targetId),error:notice});throw error
    }).finally(()=>this.pending.delete(accountId))
    this.pending.set(accountId,operation);return operation
  }
  private async ensure(id:string,options:{force?:boolean;rejectedToken?:string}):Promise<StoredAccount>{
    const account=await this.sync(id)
    const reject=(notice:string):never=>{
      const binding=this.binding(id)
      this.observations.set(binding.targetId,{...this.observations.get(binding.targetId),error:notice})
      throw new Error(notice)
    }
    if(options.force&&(!options.rejectedToken||options.rejectedToken===account.credentials.accessToken))reject('客户端凭据被上游拒绝，请在客户端重新登录；管理器不会并行刷新同一令牌链')
    const exp=tokenClaims(account.credentials.accessToken).exp
    if(typeof exp==='number'&&!tokenFresh(account.credentials.accessToken,30))reject('等待客户端刷新登录凭据，请在客户端完成登录后重试')
    return account
  }
  release(raw:unknown):ClientAuthorityView[]{
    const {targetId}=releaseClientAuthoritySchema.parse(raw),binding=this.store.read().clientAuthorities?.find(entry=>entry.targetId===targetId)
    if(!binding)throw new Error('关联已不存在')
    if(this.store.read().clientSwitches?.some(record=>record.targetId===targetId))throw new Error('此目录有原生切换记录，请先恢复原账号')
    if(this.pending.has(binding.accountId)||this.tokens.busy(binding.accountId))throw new Error('凭据正在同步，请稍后解除关联')
    const observed=this.read(binding),account=this.store.read().accounts.find(value=>value.id===binding.accountId)
    if(observed&&account&&compareIdentity(accountIdentity(account),accountIdentity(observed))==='matched')throw new Error('请先在客户端退出此账号或切换到其他账号，再关闭客户端后解除关联')
    this.store.transaction(state=>{state.clientAuthorities=(state.clientAuthorities??[]).filter(entry=>entry.targetId!==targetId)})
    this.observations.delete(targetId);return this.views()
  }
  async stop():Promise<void>{await Promise.allSettled([...this.pending.values()])}
}
