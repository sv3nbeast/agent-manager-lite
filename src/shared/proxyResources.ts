import {z} from 'zod'
import type {AccountProxyView} from './accountProxy'

const name=z.string().trim().min(1).max(80),id=z.string().uuid(),revision=z.number().int().nonnegative()
export const proxyResourceChangeSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),name,url:z.string().max(8192)}).strict(),
  z.object({action:z.literal('update'),id,revision,name,url:z.string().max(8192).optional()}).strict(),
  z.object({action:z.literal('remove'),id,revision}).strict(),
  z.object({action:z.literal('enable'),id,revision}).strict(),
  z.object({action:z.literal('disable')}).strict()
])
export type ProxyResourceChange=z.infer<typeof proxyResourceChangeSchema>
export interface ProxyResourceView {id:string;name:string;revision:number;address:AccountProxyView;accountCount:number;unified:boolean;catalogSourceId?:string}
export interface ProxyResourcesView {
  resources:ProxyResourceView[]
  unified:{mode:'off'|'all_accounts'|'invalid';resourceId?:string;name?:string;error?:string;pending?:boolean;staleError?:string}
  eligible:number;inherited:number;independent:number;direct:number
}
export interface ProxyChangePreview {
  ticket:string;action:ProxyResourceChange['action'];name?:string;address?:AccountProxyView
  affected:{id:string;name:string}[];busy:{id:string;name:string}[]
  eligible:number;inherited:number;independent:number;direct:number
  disablesUnified:boolean;clearsBindings:number
}
export const applyProxyChangeSchema=z.object({ticket:id,confirmed:z.literal(true)}).strict()
