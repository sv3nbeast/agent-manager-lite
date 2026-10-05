import type {State,StoredAccount} from './store'
import {providerTierForAccount} from './providerLibrary'

function validatedWindows(windows:Record<string,number>|undefined,source:string):Record<string,number>|undefined {
  if(!windows)return undefined
  const result=Object.create(null) as Record<string,number>
  for(const [model,value] of Object.entries(windows)){
    if(!Number.isSafeInteger(value)||value<2||value>10_000_000)throw new Error(`${source}上下文窗口必须是 2 至 10,000,000 的整数，请重新设置`)
    result[model]=value
  }
  return Object.keys(result).length?result:undefined
}

// A provider override only belongs to its currently validated linked account.
// Imported archives and accounts with a similar URL do not establish ownership.
export function providerModelContextWindow(state:State,account:StoredAccount,model:string):number|undefined {
  return providerModelContextWindows(state,account)?.[model]
}
export function providerModelContextWindows(state:State,account:StoredAccount):Record<string,number>|undefined {
  if(!account.providerId)return undefined
  providerTierForAccount(state,account)
  const windows=state.providers!.find(provider=>provider.id===account.providerId)!.modelContextWindows
  return validatedWindows(windows,'供应商')
}

// API connections own their overrides independently of a supplier link. Login
// accounts retain the client's ordinary model catalogue and config behavior.
export function connectionModelContextWindows(account:StoredAccount):Record<string,number>|undefined {
  return account.kind==='api_key'?validatedWindows(account.modelContextWindows,'API 连接'):undefined
}

export function effectiveModelContextWindows(state:State,account:StoredAccount) {
  // Validate linked ownership even when a connection overrides every model.
  const providerWindows=providerModelContextWindows(state,account),connectionWindows=connectionModelContextWindows(account)
  const windows=providerWindows||connectionWindows
    ?Object.assign(Object.create(null) as Record<string,number>,providerWindows,connectionWindows):undefined
  return {windows,providerWindows,connectionWindows}
}
