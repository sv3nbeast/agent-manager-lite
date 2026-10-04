import type {State,StoredAccount} from './store'
import {providerTierForAccount} from './providerLibrary'

// The native client's account menu reads model_providers.<id>.name. Resolve it
// from the current connection, never from an imported account's archived data.
export function instanceProviderName(state:State,account:StoredAccount):string {
  if(account.kind==='oauth')return 'ChatGPT'
  if(account.kind==='agent_identity')return 'Agent Identity'
  if(!account.providerId)return account.name
  // Apply the same endpoint/key/model association checks used for tier routing
  // before attributing a connection to a named provider.
  providerTierForAccount(state,account)
  return state.providers!.find(provider=>provider.id===account.providerId)!.name
}
