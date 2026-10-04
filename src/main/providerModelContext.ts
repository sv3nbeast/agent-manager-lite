import type {State,StoredAccount} from './store'
import {providerTierForAccount} from './providerLibrary'

// A provider override only belongs to its currently validated linked account.
// Imported archives and accounts with a similar URL do not establish ownership.
export function providerModelContextWindow(state:State,account:StoredAccount,model:string):number|undefined {
  return providerModelContextWindows(state,account)?.[model]
}
export function providerModelContextWindows(state:State,account:StoredAccount):Record<string,number>|undefined {
  if(!account.providerId)return undefined
  providerTierForAccount(state,account)
  const windows=state.providers!.find(provider=>provider.id===account.providerId)!.modelContextWindows
  if(!windows)return undefined
  const result=Object.create(null) as Record<string,number>
  for(const [model,value] of Object.entries(windows)){
    if(!Number.isSafeInteger(value)||value<2)throw new Error('供应商上下文窗口必须是不小于 2 的整数，请重新设置')
    result[model]=value
  }
  return result
}
