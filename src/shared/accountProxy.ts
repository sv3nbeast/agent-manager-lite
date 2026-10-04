import {z} from 'zod'
export const proxyModeSchema=z.enum(['inherit','direct','custom','resource'])
export type ProxyMode=z.infer<typeof proxyModeSchema>
export interface AccountProxyView {mode:ProxyMode;protocol?:string;server?:string;port?:number;authenticated?:boolean;invalid?:boolean;source?:'account'|'unified'|'global'|'default';resourceId?:string;name?:string;catalog?:boolean}
const account=z.object({accountId:z.string().uuid(),revision:z.number().int().nonnegative()})
export const accountProxyInputSchema=account.extend({mode:proxyModeSchema,url:z.string().max(8192).optional(),resourceId:z.string().uuid().optional(),resourceRevision:z.number().int().nonnegative().optional()}).strict()
export type AccountProxyInput=z.infer<typeof accountProxyInputSchema>
export const proxyProbeInputSchema=account.extend({requestId:z.string().uuid(),mode:z.enum(['saved','inherit','direct','custom','resource']),url:z.string().max(8192).optional(),resourceId:z.string().uuid().optional(),resourceRevision:z.number().int().nonnegative().optional()}).strict()
export type ProxyProbeInput=z.infer<typeof proxyProbeInputSchema>
export interface ProxyProbeResult {requestId:string;ip:string;latencyMs:number;checkedAt:number}
