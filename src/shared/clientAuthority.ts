import {z} from 'zod'

export const bindClientAuthoritySchema=z.object({ticket:z.string().uuid(),accountId:z.string().uuid()}).strict()
export const releaseClientAuthoritySchema=z.object({targetId:z.string().uuid(),clientClosed:z.literal(true)}).strict()
export interface StoredClientAuthority {targetId:string;accountId:string;createdAt:number}
export interface ClientAuthorityView extends StoredClientAuthority {
  accountName:string;directory:string;lastSyncedAt?:number;error?:string
}
