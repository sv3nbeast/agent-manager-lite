import {accountProxyURL,type ProxyState} from './proxyPolicy'
// Native auth/provider projection adapted from Cockpit account_projection.rs
// and account_model_catalog.rs at the fixed commit in THIRD_PARTY_NOTICES.md.
import type {State,StoredAccount} from './store'
import {accountFromAuth,configuredProviderAuth} from './clientIdentity'
import {accountIdentity,sameNativeAccount} from './accountIdentity'
export {sameNativeAccount} from './accountIdentity'
import {providerURLSchema} from '../shared/providerConfig'
import {resolveServiceTier} from '../shared/serviceTier'
import {providerTierForAccount} from './providerLibrary'
import {instanceProviderName} from './instanceProviderName'
import {TomlDocument,patchToml,scalarRaw,type TomlEdit} from './tomlPatch'
import {tokenClaims} from './tokens'
import type {StoredClientSwitch} from './clientSwitch'
import {nativeAuthRefresh} from './authRefreshMetadata'

export const nativeProvider='cml_native_account'
export const authKeys=new Set(('access_token refresh_token id_token session_id expired last_refresh expires_in timestamp token_type user_code verification_uri verification_uri_complete openai_api_key personal_access_token tokens agent_identity agentidentity auth_mode authmode base_url api_base_url apibaseurl email account_email accountemail account_name accountname account_id accountid chatgpt_account_id chatgptaccountid chatgpt_user_id chatgptuserid user_id userid type').split(' '))
const providerKeys=['name','base_url','wire_api','requires_openai_auth','supports_websockets','experimental_bearer_token']
export function nativeIdentity(raw:string|null,doc:TomlDocument):StoredAccount|undefined {
  const active=configuredProviderAuth(doc)??raw
  return active===null?undefined:accountFromAuth(active,doc)
}
export function ownsRefreshChain(account:StoredAccount):boolean {
  const identity=accountIdentity(account)
  return account.kind==='oauth'&&!!(identity.accountId||identity.userId)
}
export function authFor(account:StoredAccount,template:string|null,proxyState:ProxyState={}):string {
  if(accountProxyURL(account,proxyState)!==undefined)throw new Error('此账号已配置出口代理，原生客户端代理尚未接入，请使用本地 API 模式或先清除账号代理设置')
  if(account.kind==='agent_identity')throw new Error('Agent Identity 按来源仅用于 API 服务，不支持原生客户端登录注入')
  if(account.kind==='api_key'&&(!account.credentials.apiKey||account.wireApi!=='responses'))throw new Error('原生 API 切换需要 Responses 账号；Chat Completions 账号请使用本地 API 转换入口')
  if(account.kind==='oauth'&&!account.credentials.accessToken)throw new Error('目标账号尚无访问令牌，请先刷新用量或完成登录')
  if(account.kind==='oauth'&&account.credentials.refreshToken&&!ownsRefreshChain(account))throw new Error('可刷新的账号缺少可核对的工作区或用户标识，请重新登录')
  let value:Record<string,unknown>={}
  if(template!==null){try{value=JSON.parse(template.replace(/^\uFEFF/,''))}catch{throw new Error('原凭据格式无效，已保留原文件')}}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('原凭据格式无效，已保留原文件')
  for(const key of Object.keys(value))if(authKeys.has(key.toLowerCase()))delete value[key]
  if(account.kind==='api_key')Object.assign(value,{auth_mode:'apikey',OPENAI_API_KEY:account.credentials.apiKey})
  else if(!account.credentials.idToken&&!account.credentials.refreshToken)Object.assign(value,{OPENAI_API_KEY:null,personal_access_token:account.credentials.accessToken})
  else Object.assign(value,{auth_mode:'chatgpt',OPENAI_API_KEY:null,last_refresh:nativeAuthRefresh(account),tokens:{access_token:account.credentials.accessToken,id_token:account.credentials.idToken??'',refresh_token:account.credentials.refreshToken??'',account_id:accountIdentity(account).accountId??null}})
  const raw=JSON.stringify(value,null,2)+'\n'
  if(account.kind==='oauth'&&!sameNativeAccount(account,accountFromAuth(raw,new TomlDocument(''))))throw new Error('令牌自身无法确认账号身份，请重新登录')
  return raw
}
export function adoptNative(state:State,id:string,observed:StoredAccount):void {
  const account=state.accounts.find(value=>value.id===id)
  if(!account||!sameNativeAccount(account,observed))throw new Error('客户端身份与账号库不匹配，已暂停切换')
  if(account.kind==='api_key')return // Never adopt a different API key from a client config.
  const before=tokenClaims(account.credentials.accessToken).exp,after=tokenClaims(observed.credentials.accessToken).exp
  if(typeof before==='number'&&typeof after==='number'&&after<before)throw new Error('客户端凭据早于账号库版本，请先在客户端重新登录')
  account.credentials={...account.credentials,accessToken:observed.credentials.accessToken,idToken:observed.credentials.idToken,refreshToken:observed.credentials.refreshToken,accountId:observed.credentials.accountId,lastRefresh:observed.credentials.lastRefresh}
  account.email=observed.email??account.email;account.plan=observed.plan??account.plan
  delete account.error;delete account.errorAt
}
export function nativeConfig(source:string|null,account:StoredAccount,state:State,history:StoredClientSwitch[]):{config:string;paths:string[][];providerGuards:string[]} {
  const doc=new TomlDocument(source??''),edits:TomlEdit[]=[],last=history.at(-1),providerPath=['model_providers',nativeProvider]
  const existing=doc.children(providerPath).length>0
  if(existing&&(!last||new TomlDocument(last.nextConfig).subtree(providerPath)!==doc.subtree(providerPath)))throw new Error('原生切换专用 Provider 已被外部修改，已保留其配置')
  if(doc.children(['model_providers','openai']).length)throw new Error('内建 OpenAI Provider 存在自定义覆盖，请先核对连接配置')
  const set=(path:string[],value:string|boolean|null)=>edits.push({path,raw:scalarRaw(value)})
  set(['model_provider'],account.kind==='api_key'?nativeProvider:'openai')
  // Cockpit only aligns an existing forced login choice; absence stays absent.
  if(doc.raw(['forced_login_method'])!==null)set(['forced_login_method'],account.kind==='api_key'?'api':'chatgpt')
  set(['openai_base_url'],null)
  if(account.kind==='api_key'){
    providerURLSchema.parse(account.baseUrl)
    const values:[string,string|boolean][]=[['name',instanceProviderName(state,account)],['base_url',account.baseUrl],['wire_api','responses'],['requires_openai_auth',false],['supports_websockets',false],['experimental_bearer_token',account.credentials.apiKey!]]
    for(const [key,value]of values)set([...providerPath,key],value)
    const model=doc.scalar(['model'])
    if(typeof model!=='string'||!account.models.includes(model))set(['model'],account.models[0]??null)
  }else if(existing){
    for(const key of providerKeys)set([...providerPath,key],null)
    // Leave a user's later model edit alone; otherwise return from the managed
    // API model to the latest native model, or the client's built-in default.
    if(last&&doc.raw(['model'])===new TomlDocument(last.nextConfig).raw(['model'])){
      const native=[...history].reverse().find(record=>state.accounts.find(a=>a.id===record.previousAccountId)?.kind==='oauth')
      edits.push({path:['model'],raw:native?new TomlDocument(native.beforeConfig??'').raw(['model']):null})
    }
  }
  const tier=resolveServiceTier(undefined,state.settings.defaultTier,providerTierForAccount(state,account),undefined,account.defaultTier)
  // Explicit client request settings remain authoritative over account defaults.
  // Only apply a manager default when this directory has no service_tier.
  const tierOwner=[...history].reverse().find(record=>record.paths?.some(path=>path.length===1&&path[0]==='service_tier'))
  if(doc.raw(['service_tier'])===null||tierOwner&&doc.raw(['service_tier'])===new TomlDocument(tierOwner.nextConfig).raw(['service_tier']))set(['service_tier'],tier.tier==='priority'?'fast':tier.tier??null)
  const config=patchToml(source??'',edits)
  const provider=doc.scalar(['model_provider'])
  return {config,paths:edits.filter(edit=>doc.raw(edit.path)!==edit.raw||['model_provider','forced_login_method','openai_base_url'].includes(edit.path[0])).map(edit=>edit.path),providerGuards:[...new Set([nativeProvider,...typeof provider==='string'&&provider!=='openai'?[provider]:[]])]}
}

export function recoveryIdentity(raw:string|null,config:string|null,record:StoredClientSwitch,state:State):{observed?:StoredAccount;observedId?:string} {
  if(raw===null)return {}
  const phases=[{id:record.accountId,auth:record.nextAuth,config:record.nextConfig},...record.status!=='committed'&&record.previousAccountId?[{id:record.previousAccountId,auth:record.beforeAuth,config:record.beforeConfig}]:[]]
  const matches:{observed:StoredAccount;observedId:string}[]=[]
  for(const phase of phases){
    const library=state.accounts.find(a=>a.id===phase.id)
    if(!library)continue
    try{
      let observed:StoredAccount|undefined
      if(raw===phase.auth)observed=nativeIdentity(raw,new TomlDocument(phase.config??''))
      else if(library.kind==='api_key'){
        const value=JSON.parse(raw.replace(/^\uFEFF/,''))
        if(value.OPENAI_API_KEY!==library.credentials.apiKey)continue
        observed=accountFromAuth(raw,new TomlDocument(phase.config??''))
      }else observed=accountFromAuth(raw,new TomlDocument(''))
      if(observed&&sameNativeAccount(library,observed))matches.push({observed,observedId:library.id})
    }catch{/* A partially written pair may only be interpretable in the other phase. */}
  }
  if(matches.length>1){
    try{const actual=nativeIdentity(raw,new TomlDocument(config??'')),selected=actual&&matches.find(match=>sameNativeAccount(match.observed,actual));if(selected)return selected}catch{}
  }
  if(matches.length!==1)throw new Error('客户端已切换为其他身份，不能用历史备份覆盖当前登录')
  return matches[0]
}
