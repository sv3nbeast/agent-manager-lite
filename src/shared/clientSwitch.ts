import {z} from 'zod'
import type {IdentitySummary} from './clientIdentity'
import type {ClientConfigTarget} from './clientConfig'

export const previewClientSwitchSchema=z.object({targetId:z.string().uuid(),accountId:z.string().uuid()}).strict()
export const previewClientSwitchRestoreSchema=z.object({targetId:z.string().uuid()}).strict()
export const applyClientSwitchSchema=z.object({ticket:z.string().uuid(),clientClosed:z.literal(true)}).strict()
export interface ClientSwitchView {
  targetId:string;accountId:string;accountName:string;previousAccountName?:string
  status:'prepared'|'committed'|'restoring';createdAt:number;historyDepth:number;instanceOwned?:boolean
}
export interface ClientSwitchPreview {
  ticket:string;kind:'switch'|'restore';target:ClientConfigTarget;before?:IdentitySummary;after?:IdentitySummary
  changes:{key:string;before:string;after:string}[]
}
