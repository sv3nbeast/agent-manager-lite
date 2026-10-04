import { randomUUID } from 'node:crypto'
import { providerEndpoint } from '../shared/providerLibrary'
import type { State, StoredAccount } from './store'
import type { StoredProvider } from './providerLibrary'

/** A saved key uses its actual linked account's route; a draft inherits the global route. */
export function providerNetworkTarget(state:Pick<State,'accounts'>,provider:StoredProvider,key:{id:string;apiKey:string}):StoredAccount {
  const linked=state.accounts.filter(account=>account.providerId===provider.id&&account.providerKeyId===key.id)
  if(linked.length>1)throw new Error('此供应商密钥关联多个账号，请先修正连接后重试')
  if(linked.length) {
    const account=linked[0]
    if(account.kind!=='api_key'||account.credentials.apiKey!==key.apiKey||providerEndpoint(account.baseUrl)!==providerEndpoint(provider.baseUrl))
      throw new Error('供应商账号关联已变化，请重新关联后重试')
    return {...account,models:[...provider.models],wireApi:provider.wireApi,integrationType:provider.integrationType}
  }
  return {id:key.id||randomUUID(),name:provider.name,kind:'api_key',baseUrl:provider.baseUrl,models:[...provider.models],wireApi:provider.wireApi,
    integrationType:provider.integrationType,defaultTier:'inherit',note:'',tags:[],createdAt:0,credentials:{apiKey:key.apiKey}}
}

export type UpstreamFetch=(url:string,init:RequestInit,account?:StoredAccount)=>Promise<Response>
