// Official-store selection and strong identity matching adapted from Cockpit
// codex_account_authority_sync.rs; keychain addressing from projection.rs.
import {createHash,randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {readClientIdentitySchema,type ClientIdentityView,type CredentialStoreMode,type IdentitySource} from '../shared/clientIdentity'
import type {ClientConfigTarget} from '../shared/clientConfig'
import {ClientConfigs,readBounded} from './clientConfig'
import {TomlDocument} from './tomlPatch'
import {Store,type StoredAccount} from './store'
import {parseAccountImport,importParsedAccounts} from './accounts'
import {tokenClaims} from './tokens'
import {object,nonempty} from './network'
import {accountIdentity as claimsIdentity,compareIdentity,sameNativeAccount} from './accountIdentity'
import {MacCodexKeyring} from './codexKeyring'
export {compareIdentity} from './accountIdentity'
export {keychainAccount} from './codexKeyring'

const limit=2*1024*1024
const digest=(value:string|null)=>createHash('sha256').update(value===null?'missing:':`present:${value}`).digest('hex')
export type ReadKeyring=(directory:string,signal:AbortSignal)=>Promise<string|null>
const macKeyring=new MacCodexKeyring()
export const readMacKeyring:ReadKeyring=(directory,signal)=>macKeyring.read(directory,signal)

function modeOf(doc:TomlDocument):CredentialStoreMode {
  const raw=doc.scalar(['cli_auth_credentials_store'])
  return raw==null?'file':['file','keyring','auto','ephemeral'].includes(String(raw))?raw as CredentialStoreMode:'unknown'
}
// A custom provider's explicit bearer does not depend on a saved ChatGPT
// login. Resolve it before considering file/keyring access, including when an
// unrelated old auth.json remains in the directory.
export function configuredProviderAuth(doc:TomlDocument):string|null {
  const provider=doc.scalar(['model_provider']),id=typeof provider==='string'?provider:'openai'
  const path=(key:string)=>['model_providers',id,key]
  if(id==='cml_instance')throw new Error('此目录使用受管本地 API，请在实例中查看绑定账号')
  const command=doc.raw(path('auth'))!==null||doc.children(path('auth')).length>0
  const headers=['http_headers','env_http_headers'].some(field=>doc.children(path(field)).some(key=>['authorization','x-api-key','api-key'].includes(key.toLowerCase())))
  if(command||headers)throw new Error('此 Provider 使用命令或自定义请求头鉴权，尚不支持识别其当前凭据')
  if(doc.raw(path('env_key'))!==null)throw new Error('此 Provider 从环境变量读取密钥，环境变量凭据不会自动读取')
  if(doc.raw(path('experimental_bearer_token'))===null)return null
  if(['openai','ollama','lmstudio','amazon-bedrock'].includes(id))throw new Error('内建 Provider 的自定义鉴权覆盖尚不支持身份识别')
  if(doc.scalar(path('requires_openai_auth'))===true)throw new Error('此 Provider 同时配置了 OpenAI 登录和直接密钥，无法确定当前凭据')
  const bearer=nonempty(doc.scalar(path('experimental_bearer_token')))
  if(!bearer)throw new Error('Provider 的直接密钥格式无效')
  return JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:bearer})
}
export function accountFromAuth(raw:string,doc:TomlDocument):StoredAccount {
  let value:Record<string,unknown>
  try{const parsed=JSON.parse(raw.replace(/^\uFEFF/,''));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw 0;value=parsed}
  catch{throw new Error('凭据格式无效，无法识别身份')}
  const mode=nonempty(value.auth_mode)?.toLowerCase()
  if(mode && !['chatgpt','oauth','apikey','api_key','api','agentidentity','agent_identity','personalaccesstoken','personal_access_token'].includes(mode))throw new Error('暂不支持此登录类型')
  const isAPI=['apikey','api_key','api'].includes(mode??'')||!mode&&!!nonempty(value.OPENAI_API_KEY)
  const provider=doc.scalar(['model_provider']),providerId=typeof provider==='string'?provider:'openai'
  if(providerId==='cml_instance')throw new Error('此目录使用受管本地 API，请在实例中查看绑定账号')
  if(isAPI){
    if(doc.scalar(['forced_login_method'])==='chatgpt')throw new Error('配置要求 ChatGPT 登录，与文件中的 API 身份不一致')
    const base=doc.scalar(['model_providers',providerId,'base_url'])??(providerId==='openai'?doc.scalar(['openai_base_url']):null)
    const bearer=doc.scalar(['model_providers',providerId,'experimental_bearer_token'])
    const key=nonempty(bearer)??nonempty(value.OPENAI_API_KEY)
    const wire=doc.scalar(['model_providers',providerId,'wire_api'])??'responses'
    if(!key)throw new Error('文件未包含可导入的 API Key，环境变量凭据不会自动读取')
    if(providerId!=='openai'&&!base)throw new Error('自定义 Provider 缺少接口地址，无法确定此密钥的上游')
    if(doc.scalar(['model_providers',providerId,'env_key'])&&!bearer)throw new Error('此 Provider 从环境变量读取密钥，不能把 auth.json 的其他密钥当作当前凭据')
    const parsed=parseAccountImport(JSON.stringify({OPENAI_API_KEY:key,name:providerId==='openai'?'本地 OpenAI API':`本地 ${providerId}`,base_url:base??'https://api.openai.com/v1',models:[doc.scalar(['model'])??'gpt-5.5'],wireApi:wire==='chat'?'chat_completions':wire}))
    if(parsed.accounts.length!==1||parsed.preview.errors.length)throw new Error('API 登录或 Provider 配置格式无效')
    return parsed.accounts[0]
  }
  // Active custom API providers must not make stale ChatGPT tokens look active.
  if(providerId!=='openai'&&doc.scalar(['model_providers',providerId,'requires_openai_auth'])!==true)throw new Error('当前 Provider 不使用 ChatGPT 登录，请查看其 API Key 配置')
  const tokens=object(value.tokens)
  const normalized={auth_mode:value.auth_mode,last_refresh:value.last_refresh,tokens:{access_token:tokens.access_token,id_token:tokens.id_token,refresh_token:tokens.refresh_token,account_id:tokens.account_id},
    agent_identity:!mode||['agentidentity','agent_identity'].includes(mode)?value.agent_identity:undefined,personal_access_token:value.personal_access_token}
  const parsed=parseAccountImport(JSON.stringify(normalized))
  if(parsed.accounts.length!==1||parsed.preview.errors.length)throw new Error('凭据不完整，无法识别身份')
  const account=parsed.accounts[0]
  if(account.kind==='oauth'){
    const auths=[account.credentials.idToken,account.credentials.accessToken].map(token=>object(tokenClaims(token)['https://api.openai.com/auth']))
    const ids=[account.credentials.accountId,...auths.flatMap(auth=>[nonempty(auth.chatgpt_account_id),nonempty(auth.account_id)])].filter(Boolean)
    if(new Set(ids).size>1)throw new Error('凭据中的账号与工作区不一致，已保留原文件')
    for(const keys of [['chatgpt_user_id','user_id'],['organization_id']]){
      const values=auths.flatMap(auth=>keys.map(key=>nonempty(auth[key]))).filter(Boolean)
      if(new Set(values).size>1)throw new Error('凭据中的用户或组织不一致，已保留原文件')
    }
    account.credentials.accountId=claimsIdentity(account).accountId
  }
  const forced=doc.scalar(['forced_login_method']),workspace=doc.scalar(['forced_chatgpt_workspace_id'])
  if(forced==='api')throw new Error('配置要求 API 登录，与文件中的 ChatGPT 身份不一致')
  if(workspace&&claimsIdentity(account).accountId!==workspace)throw new Error('凭据工作区不符合此客户端的配置限制')
  return account
}

interface Pending {target:ClientConfigTarget;configHash:string;authHash:string;source:IdentitySource;account:StoredAccount;expires:number}
export class ClientIdentities {
  private pending=new Map<string,Pending>()
  private active=new Map<string,AbortController>()
  constructor(private readonly store:Store,private readonly configs:ClientConfigs,private readonly keyring:ReadKeyring=readMacKeyring,private readonly now=Date.now){}
  async read(input:unknown):Promise<ClientIdentityView>{
    const parsed=readClientIdentitySchema.parse(input),target=this.configs.identityTarget(parsed.id)
    if(this.active.has(target.id))throw new Error('此目录正在读取，请等待或取消')
    this.discard(target.id)
    const controller=new AbortController();this.active.set(target.id,controller)
    const view:ClientIdentityView={target,mode:'unknown',status:'missing',matchedAccountIds:[],readAt:this.now()}
    try{
      const config=readBounded(join(target.directory,'config.toml'),1024*1024),doc=new TomlDocument(config??'')
      view.mode=modeOf(doc)
      if(doc.scalar(['profile'])){view.status='unsupported';view.notice='此目录启用了 Profile；该配置的身份识别尚未支持';return view}
      if(view.mode==='unknown'){view.status='unsupported';view.notice='无法识别此目录的凭据存储设置';return view}
      let raw=configuredProviderAuth(doc),auth:string|null=null,source:IdentitySource='config'
      if(raw===null){
        if(view.mode==='ephemeral'){view.status='ephemeral';view.notice='此客户端仅在内存保存凭据，磁盘上的旧文件不能代表当前身份';return view}
        if(view.mode!=='file'&&!parsed.includeKeyring){view.status='needs_keyring';view.notice='此目录优先使用系统凭据库。点击读取后可能出现系统授权';return view}
        source='file'
        if(view.mode==='file'){auth=readBounded(join(target.directory,'auth.json'),limit);raw=auth}
        else{
          source='keyring'
          view.keyringRetry=true
          let secret:string|null
          try{secret=await this.keyring(target.directory,controller.signal)}
          catch{throw new Error('系统凭据读取失败或未获授权，请检查系统凭据库后重试')}
          if(secret!==null)raw=secret
          else if(view.mode==='auto'){
            source='file'
            auth=readBounded(join(target.directory,'auth.json'),limit);raw=auth
            if(auth!==null)view.notice='系统凭据库未发现条目，按 auto 设置读取文件凭据'
          }
        }
      }
      controller.signal.throwIfAborted()
      // A native picker registration is an inode-bound capability, rechecked
      // after waiting for a possible OS authorization dialog.
      this.configs.identityTarget(target.id)
      if(digest(readBounded(join(target.directory,'config.toml'),1024*1024))!==digest(config)||source==='file'&&digest(readBounded(join(target.directory,'auth.json'),limit))!==digest(auth))throw new Error('读取期间客户端文件发生变化，请重新读取')
      if(raw===null){view.notice??='所选存储中未发现持久化登录凭据';return view}
      if(Buffer.byteLength(raw)>limit)throw new Error('凭据文件超过大小限制')
      const account=accountFromAuth(raw,doc),state=this.store.read()
      if(account.kind==='api_key'&&[...state.accounts.map(a=>a.credentials.localAPIKey),...(state.localAccess?.keys??[]).map(k=>k.key)].includes(account.credentials.apiKey))throw new Error('此凭据属于本应用本地网关，不能作为上游账号导入')
      const identity=claimsIdentity(account)
      const matches=state.accounts.filter(candidate=>sameNativeAccount(candidate,account))
      view.status='identified';view.source=source;view.identity=identity;view.matchedAccountIds=matches.map(a=>a.id)
      view.keyringRetry=false
      view.ticket=randomUUID()
      this.pending.set(view.ticket,{target,configHash:digest(config),authHash:digest(auth),source,account,expires:this.now()+300_000})
      return view
    }catch(error){
      view.status='error'
      view.notice=controller.signal.aborted?'读取已取消':error instanceof Error?error.message:'身份读取失败'
      return view
    }finally{if(this.active.get(target.id)===controller)this.active.delete(target.id)}
  }
  import(ticket:string):{added:number;duplicates:number}{
    z.string().uuid().parse(ticket)
    const pending=this.pending.get(ticket)
    if(!pending||pending.expires<this.now())throw new Error('身份预览已过期，请重新读取')
    this.pending.delete(ticket)
    const target=this.configs.identityTarget(pending.target.id)
    if(digest(readBounded(join(target.directory,'config.toml'),1024*1024))!==pending.configHash||pending.source==='file'&&digest(readBounded(join(target.directory,'auth.json'),limit))!==pending.authHash)throw new Error('客户端文件已变化，请重新读取身份')
    // Import exactly the explicit snapshot. Keyring is not read a second time
    // and existing credentials are never replaced by a possibly older copy.
    const account=pending.account,identity=claimsIdentity(account)
    if(account.kind!=='api_key'&&this.store.read().accounts.some(candidate=>compareIdentity(identity,claimsIdentity(candidate))==='matched'))return {added:0,duplicates:1}
    return importParsedAccounts(this.store,[account])
  }
  // Main-process-only transfer of a fresh file preview. System credentials are
  // never fetched implicitly to establish a background synchronization link.
  takeFileSnapshot(ticket:string):{target:ClientConfigTarget;account:StoredAccount}{
    z.string().uuid().parse(ticket)
    const pending=this.pending.get(ticket)
    if(!pending||pending.expires<this.now())throw new Error('身份预览已过期，请重新读取')
    if(pending.source!=='file')throw new Error('当前仅支持文件凭据的刷新权威关联，系统凭据和 Provider 直接密钥尚未接入')
    const target=this.configs.identityTarget(pending.target.id)
    if(modeOf(new TomlDocument(readBounded(join(target.directory,'config.toml'),1024*1024)??''))!=='file')throw new Error('建立持续同步需要客户端明确使用 file 存储模式；不会自动改变其配置')
    if(digest(readBounded(join(target.directory,'config.toml'),1024*1024))!==pending.configHash||digest(readBounded(join(target.directory,'auth.json'),limit))!==pending.authHash)throw new Error('客户端文件已变化，请重新读取身份')
    this.pending.delete(ticket)
    return {target,account:structuredClone(pending.account)}
  }
  discard(id:string):void {z.string().uuid().parse(id);for(const [ticket,value]of this.pending)if(value.target.id===id||value.expires<this.now())this.pending.delete(ticket)}
  cancel(id:string):void {z.string().uuid().parse(id);this.active.get(id)?.abort();this.discard(id)}
  stop():void {for(const controller of this.active.values())controller.abort();this.pending.clear()}
}
