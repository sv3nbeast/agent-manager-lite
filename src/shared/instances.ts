import { z } from 'zod'
import { defaultTierSchema } from './types'
import { agentClientTypeSchema, type AgentClientType } from './agentClients'

const text = z.string().trim().min(1).max(120).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
export const instanceInputSchema = z.object({
  clientType:agentClientTypeSchema.default('codex'),
  name:text, applicationId:z.string().min(1).max(100), accountId:z.string().uuid(),
  connectionMode:z.enum(['local_api','native']).default('local_api'),
  workingDirectoryId:z.string().uuid().optional(),
  defaultTier:defaultTierSchema.default('inherit'), model:z.string().trim().min(1).max(200),
  extraArgs:z.array(z.string().max(2000).refine(value=>!/[\x00-\x1f\x7f]/.test(value))).max(50).default([])
}).strict().superRefine((value,ctx)=>{
  if(value.extraArgs.some(arg=>/^(--(?:user-data-dir|cml-instance|remote-debugging.*)|-psn)(?:=|$)/.test(arg)))ctx.addIssue({code:'custom',path:['extraArgs'],message:'附加参数不能覆盖实例隔离或调试参数'})
})
export type InstanceInput = z.infer<typeof instanceInputSchema>
export interface ExternalInstanceHome {directory:string;device:number;inode:number;previousTargetName?:string}
export interface InstanceProfile extends Omit<InstanceInput,'clientType'> { clientType?:AgentClientType; id:string; revision:number; createdAt:number; externalHome?:ExternalInstanceHome }
export interface InstanceApplication { clientType?:AgentClientType; id:string; name:string; path:string; kind?:'desktop'|'cli'; supportsTempLogin?:boolean }
export interface InstanceWorkingDirectory {id:string;path:string;device:number;inode:number}
export interface InstanceView extends Omit<InstanceProfile,'clientType'> {
  clientType?:unknown
  directory:string; desktopDirectory:string; applicationName?:string; accountName?:string
  launchMode?:'desktop'|'cli';workingDirectory?:string;copying?:boolean
  status:'stopped'|'preparing'|'starting'|'running'|'stopping'|'error'; pid?:number
  port?:number; appliedTier?:string; error?:string; notice?:string; startedAt?:number
  speedMenu?:'pending'|'active'|'fallback'|'unavailable'
  initialTier?:string
  desktopLocaleCompatibility?:'pending'|'active'|'fallback'|'unavailable'
}
export interface InstanceLaunchPreview {
  clientType:AgentClientType
  ticket:string; instanceId:string; name:string; application:string; directory:string; desktopDirectory:string
  workingDirectory:string; args:string[]; accountName:string; model:string; tier?:string; tierSource:string
  connectionMode:'local_api'|'native'
  launchMode?:'desktop'|'cli';executable?:string
  externalHome?:boolean
  providerName?:string
  desktopLocale?:string
  desktopEffectiveLocale?:string
  desktopLocaleSource?:'existing'|'legacy'|'system'|'initialized'
  effectiveContextWindow?:number
  effectiveAutoCompactTokenLimit?:number
  contextWindowSource?:'connection'|'provider'|'config'|'catalog'|'template'
  speedMenuAvailable?:boolean
  speedMenuReason?:string
  speedPreferenceSource?:'existing'|'initial'|'initialized'
  desktopLocaleCompatibilityAvailable?:boolean
  desktopLocaleCompatibilityReason?:string
  history?:InstanceHistorySummary
}
export interface InstanceHistorySummary {
  sessions:number
  archived:number
  projects:{path:string;name:string;exists:boolean;sessions:number}[]
  unassigned:number
  issues:string[]
}
export const instanceRevisionSchema=z.object({id:z.string().uuid(),revision:z.number().int().nonnegative()}).strict()
export const saveInstanceSchema=z.object({id:z.string().uuid().optional(),revision:z.number().int().nonnegative().optional(),details:instanceInputSchema}).strict()
export const copyInstanceSchema=instanceRevisionSchema.extend({details:instanceInputSchema}).strict()
export type InstanceCopyInput=z.infer<typeof copyInstanceSchema>
export interface InstanceCopySource {ticket:string;name:string;directory:string;history?:InstanceHistorySummary}
export interface ExternalInstanceSource {
  id:string;name:string;directory:string;sourceName:string;clientType:'codex'
  launchMode:'desktop'|'cli';runtimeState:'running'|'not_detected'|'unknown'
}
export interface ExternalInstanceDiscovery {sources:ExternalInstanceSource[];issues:string[]}
export const copyExternalInstanceSchema=z.object({ticket:z.string().uuid(),sourceClosed:z.boolean().optional(),details:instanceInputSchema}).strict()
export type ExternalInstanceCopyInput=z.infer<typeof copyExternalInstanceSchema>
export const attachInstanceSchema=copyExternalInstanceSchema.extend({sourceClosed:z.literal(true)})
export type AttachInstanceInput=z.infer<typeof attachInstanceSchema>
export interface InstanceCopyView {
  id:string;sourceId:string;sourceName:string;name:string;targetId?:string
  sourceDirectory?:string;external?:boolean;omittedSessions?:number
  status:'scanning'|'copying'|'completed'|'cancelled'|'failed';files:number;bytes:number;totalFiles:number;totalBytes:number;skipped:number;error?:string
}
