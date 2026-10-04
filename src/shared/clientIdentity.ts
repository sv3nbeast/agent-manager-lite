import {z} from 'zod'
import type {ClientConfigTarget} from './clientConfig'

export const readClientIdentitySchema=z.object({id:z.string().uuid(),includeKeyring:z.boolean().default(false)}).strict()
export type ClientIdentityInput=z.infer<typeof readClientIdentitySchema>
export type CredentialStoreMode='file'|'keyring'|'auto'|'ephemeral'|'unknown'
export type IdentitySource='file'|'keyring'|'config'
export interface IdentitySummary {
  kind:'oauth'|'api_key'|'agent_identity';name:string;email?:string;accountId?:string;userId?:string;organizationId?:string;plan?:string
}
export interface ClientIdentityView {
  target:ClientConfigTarget;mode:CredentialStoreMode;source?:IdentitySource;readAt:number
  status:'identified'|'missing'|'needs_keyring'|'ephemeral'|'unsupported'|'error'
  identity?:IdentitySummary;matchedAccountIds:string[];ticket?:string;notice?:string;keyringRetry?:boolean
}
