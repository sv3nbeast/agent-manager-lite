import {join} from 'node:path'
import type {InstanceIdentityView} from '../shared/instances'
import type {StoredAccount} from './store'
import {readBounded} from './clientConfig'
import {TomlDocument} from './tomlPatch'
import {nativeIdentity,sameNativeAccount} from './nativeAccountProjection'
import {accountIdentity} from './accountIdentity'

const configLimit=1024*1024
const authLimit=2*1024*1024

// Keep identity labels useful in the renderer while ensuring that no token or
// arbitrary auth-file value can cross the process boundary.
function safeLabel(value:unknown,max=320):string|undefined {
  if(typeof value!=='string')return undefined
  const normalized=value.trim()
  if(!normalized||normalized.length>max||/[\x00-\x1f\x7f]/.test(normalized))return undefined
  return normalized
}

function labels(account:StoredAccount):Pick<InstanceIdentityView,'email'|'accountId'> {
  const identity=accountIdentity(account)
  const email=safeLabel(identity.email),accountId=safeLabel(identity.accountId)
  return {...email?{email}:{},...accountId?{accountId}:{}}
}

/**
 * Read the persisted client files for an instance and report the identity the
 * client can actually use. This deliberately never returns auth-file content.
 */
export function readInstanceIdentityStatus(directory:string,connectionMode:'local_api'|'native',bound?:StoredAccount):InstanceIdentityView {
  if(connectionMode!=='native')return {status:'local_api'}
  let config:string|null,auth:string|null
  try {
    config=readBounded(join(directory,'config.toml'),configLimit)
    auth=readBounded(join(directory,'auth.json'),authLimit)
  } catch {
    return {status:'unknown'}
  }
  if(config===null||auth===null)return {status:'missing'}
  try {
    const parsed=JSON.parse(auth.replace(/^\uFEFF/,'')) as Record<string,unknown>
    const mode=typeof parsed.auth_mode==='string'?parsed.auth_mode.toLowerCase():''
    const tokens=parsed.tokens&&typeof parsed.tokens==='object'&&!Array.isArray(parsed.tokens)
    const oauth=mode==='chatgpt'||mode==='oauth'||(!['apikey','api_key','api','agentidentity','agent_identity','personalaccesstoken','personal_access_token'].includes(mode)&&tokens)
    if(oauth){
      const timestamp=parsed.last_refresh
      if(typeof timestamp!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.\d+)?Z$/.test(timestamp)||!Number.isFinite(Date.parse(timestamp))||Date.parse(timestamp)>Date.now())return {status:'native_unverified'}
    }
    const observed=nativeIdentity(auth,new TomlDocument(config))
    if(!observed)return {status:'native_unverified'}
    const identity=labels(observed)
    return {status:bound&&sameNativeAccount(bound,observed)?'native_verified':'native_unverified',...identity}
  } catch {
    // A file that exists but is malformed, uses an unsupported provider, or
    // contains a different account is present but cannot be verified.
    return {status:'native_unverified'}
  }
}
