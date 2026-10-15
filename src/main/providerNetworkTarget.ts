import { randomUUID } from 'node:crypto'
import { providerEndpoint, providerKeyModels, providerKeyProtocol, providerKeyCredentialKind } from '../shared/providerLibrary'
import type { AccountCredentialKind, AccountProtocol } from '../shared/types'
import type { State, StoredAccount } from './store'
import type { StoredProvider } from './providerLibrary'

/** A saved key uses its actual linked account's route; a draft inherits the global route. */
export function providerNetworkTarget(state:Pick<State,'accounts'>,provider:StoredProvider,key:{id:string;apiKey:string}):StoredAccount {
  const storedKey=provider.keys.find(item=>item.id===key.id)
  if(!storedKey || storedKey.apiKey!==key.apiKey)throw new Error('供应商密钥已变化，请重新选择后重试')
  const protocol=providerKeyProtocol(provider,storedKey),credentialKind=providerKeyCredentialKind(provider,storedKey)
  const connection={models:providerKeyModels(provider,storedKey),protocol,credentialKind,
    identityService:protocol==='anthropic_messages'?'anthropic' as const:'openai' as const,
    wireApi:protocol==='openai_responses'?'responses' as const:'chat_completions' as const,integrationType:provider.integrationType}
  const linked=state.accounts.filter(account=>account.providerId===provider.id&&account.providerKeyId===key.id)
  if(linked.length>1)throw new Error('此供应商密钥关联多个账号，请先修正连接后重试')
  if(linked.length) {
    const account=linked[0]
    if(account.kind!=='api_key'||account.credentials.apiKey!==key.apiKey||providerEndpoint(account.baseUrl)!==providerEndpoint(provider.baseUrl))
      throw new Error('供应商账号关联已变化，请重新关联后重试')
    return {...account,...connection}
  }
  return {id:key.id||randomUUID(),name:provider.name,kind:'api_key',baseUrl:provider.baseUrl,...connection,
    defaultTier:'inherit',note:'',tags:[],createdAt:0,credentials:{apiKey:key.apiKey}}
}

/** Anthropic accepts a root URL or an explicit /v1 prefix. Preserve tenant paths. */
export function providerAPIEndpoint(baseUrl:string,protocol:AccountProtocol,resource:'models'|'chat'):string {
  const base=baseUrl.replace(/\/+$/,'')
  if(protocol==='anthropic_messages')return `${base}${/\/v1$/.test(new URL(base).pathname)?'':'/v1'}/${resource==='models'?'models':'messages'}`
  return `${base}/${resource==='models'?'models':protocol==='openai_chat_completions'?'chat/completions':'responses'}`
}

export function providerAPIHeaders(protocol:AccountProtocol,credentialKind:AccountCredentialKind,apiKey?:string):Record<string,string> {
  return {Accept:'application/json',...(protocol==='anthropic_messages'?{'anthropic-version':'2023-06-01'}:{}),
    ...(apiKey?protocol==='anthropic_messages'&&credentialKind!=='anthropic_bearer'?{'x-api-key':apiKey}:{Authorization:`Bearer ${apiKey}`}:{})}
}

export type UpstreamFetch=(url:string,init:RequestInit,account?:StoredAccount)=>Promise<Response>
