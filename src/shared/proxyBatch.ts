import {z} from 'zod'
import type {AccountProxyView} from './accountProxy'

export const proxyImportOptionsSchema=z.object({
  protocol:z.enum(['http','https','socks5','socks5h']).default('socks5'),
  format:z.enum(['auto','host_auth','auth_at_host','host_at_auth']).default('auto'),
  skipInvalid:z.boolean().default(false),skipDuplicates:z.boolean().default(true)
}).strict()
export const proxyImportInputSchema=z.object({input:z.string().max(2*1024*1024),options:proxyImportOptionsSchema}).strict()
export type ProxyImportInput=z.input<typeof proxyImportInputSchema>
export type ProxyImportOptions=z.output<typeof proxyImportOptionsSchema>
export interface ProxyImportRow {line:number;name?:string;address?:AccountProxyView;duplicate:boolean;error?:'invalid'|'ambiguous';included:boolean}
export interface ProxyImportPreview {ticket?:string;encoded:boolean;rows:ProxyImportRow[];valid:number;invalid:number;duplicates:number;added:number;blocked?:string}
const id=z.string().uuid()
export const proxyAssignmentSchema=z.object({accountIds:z.array(id).min(1).max(10000),mode:z.enum(['resource','inherit','direct']),resourceId:id.optional(),resourceRevision:z.number().int().nonnegative().optional()}).strict()
export type ProxyAssignmentInput=z.infer<typeof proxyAssignmentSchema>
export interface ProxyAssignmentRow {id:string;name:string;status:'change'|'same'|'ineligible';overwrite:boolean;before?:AccountProxyView;after?:AccountProxyView;busy:boolean}
export interface ProxyAssignmentPreview {ticket?:string;mode:ProxyAssignmentInput['mode'];resourceName?:string;rows:ProxyAssignmentRow[];changed:number;same:number;ineligible:number;overwritten:number;busy:number}
export const applyProxyBatchSchema=z.object({ticket:id,confirmed:z.literal(true)}).strict()
