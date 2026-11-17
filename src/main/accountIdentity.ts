import {providerEndpoint} from '../shared/providerLibrary'
import type {StoredAccount} from './store'
import type {IdentitySummary} from '../shared/clientIdentity'
import {tokenClaims} from './tokens'
import {object,nonempty} from './network'

export function accountIdentity(account:StoredAccount):IdentitySummary {
  const id=tokenClaims(account.credentials.idToken),access=tokenClaims(account.credentials.accessToken)
  const idAuth=object(id['https://api.openai.com/auth']),accessAuth=object(access['https://api.openai.com/auth'])
  const agent=account.credentials.agentIdentity
  return {kind:account.kind,name:account.name,email:account.email??nonempty(id.email)??nonempty(access.email)??nonempty(object(access['https://api.openai.com/profile']).email),plan:account.plan,
    accountId:account.credentials.accountId??nonempty(accessAuth.chatgpt_account_id)??nonempty(accessAuth.account_id)??nonempty(idAuth.chatgpt_account_id)??nonempty(idAuth.account_id),
    userId:agent?.chatgpt_user_id??nonempty(idAuth.chatgpt_user_id)??nonempty(idAuth.user_id)??nonempty(accessAuth.chatgpt_user_id)??nonempty(accessAuth.user_id)??nonempty(access.sub)??nonempty(account.source?.user_id),
    organizationId:nonempty(accessAuth.organization_id)??nonempty(idAuth.organization_id)??nonempty(account.source?.organization_id)}
}
export function strongIdentityConflict(left:IdentitySummary,right:IdentitySummary):boolean {
  return (['accountId','userId','organizationId'] as const).some(key=>{
    const a=left[key]?.trim().toLowerCase(),b=right[key]?.trim().toLowerCase()
    return !!a&&!!b&&a!==b
  })
}
// Cockpit authority_sync.rs: compare_official_oauth_identity. An email alone
// cannot override a disagreeing or one-sided primary identity.
export function compareIdentity(left:IdentitySummary,right:IdentitySummary):'matched'|'mismatched'|'unknown' {
  if(left.kind!==right.kind||strongIdentityConflict(left,right))return 'mismatched'
  let matched=false,oneSided=false
  for(const key of ['accountId','userId'] as const){
    const a=left[key]?.trim(),b=right[key]?.trim()
    if(a&&b)matched=true;else if(a||b)oneSided=true
  }
  if(matched)return 'matched'
  if(oneSided||!left.email||!right.email)return 'unknown'
  return left.email.toLowerCase()===right.email.toLowerCase()?'matched':'mismatched'
}

function apiIdentityType(account:StoredAccount) {
  // Missing metadata denotes a legacy OpenAI connection, as in account import.
  // Resolve defaults only for comparison; preserve explicit types and the vault.
  const identityService=account.identityService??'openai'
  return {identityService,
    protocol:account.protocol??(identityService==='anthropic'?'anthropic_messages':account.wireApi==='chat_completions'?'openai_chat_completions':'openai_responses'),
    credentialKind:account.credentialKind??(identityService==='anthropic'?'anthropic_api_key':'openai_api_key')}
}

export function sameNativeAccount(a:StoredAccount,b:StoredAccount):boolean {
  if(a.kind!==b.kind)return false
  if(a.kind==='api_key'){
    const left=apiIdentityType(a),right=apiIdentityType(b)
    return left.identityService===right.identityService&&left.protocol===right.protocol&&left.credentialKind===right.credentialKind
      &&!!a.credentials.apiKey&&a.credentials.apiKey===b.credentials.apiKey&&providerEndpoint(a.baseUrl)===providerEndpoint(b.baseUrl)&&a.wireApi===b.wireApi
  }
  const left=accountIdentity(a),right=accountIdentity(b)
  if(strongIdentityConflict(left,right))return false
  if(compareIdentity(left,right)==='matched')return true
  // An opaque PAT cannot be matched by made-up workspace claims. Its exact
  // token is sufficient only when neither copy can rotate a refresh token.
  return !a.credentials.refreshToken&&!b.credentials.refreshToken&&!!a.credentials.accessToken&&a.credentials.accessToken===b.credentials.accessToken
}
