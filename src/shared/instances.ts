import { z } from 'zod'
import type { AccountProxyView } from './accountProxy'
import { defaultTierSchema } from './types'
import { agentClientTypeSchema, type AgentClientType } from './agentClients'

const text = z.string().trim().min(1).max(120).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
export const instanceCopyModeSchema=z.enum(['sessions','full']).default('sessions')
export type InstanceCopyMode=z.infer<typeof instanceCopyModeSchema>
export const instanceInputSchema = z.object({
  clientType:agentClientTypeSchema.default('codex'),
  name:text, applicationId:z.string().min(1).max(100), accountId:z.union([z.string().uuid(),z.literal('')]),
  connectionMode:z.enum(['local_api','native','client_login']).default('local_api'),
  launchMode:z.enum(['desktop','cli']).optional(),
  workingDirectoryId:z.string().uuid().optional(),
  defaultTier:defaultTierSchema.default('inherit'), model:z.string().trim().max(200),
  extraArgs:z.array(z.string().max(2000).refine(value=>!/[\x00-\x1f\x7f]/.test(value))).max(50).default([])
}).strict().superRefine((value,ctx)=>{
  if(value.extraArgs.some(arg=>/^(--(?:user-data-dir|cml-instance|remote-debugging.*)|-psn)(?:=|$)/.test(arg)))ctx.addIssue({code:'custom',path:['extraArgs'],message:'附加参数不能覆盖实例隔离或调试参数'})
  if(value.connectionMode==='client_login'){
    if(value.clientType!=='claude_code'||value.launchMode==='cli')ctx.addIssue({code:'custom',path:['connectionMode'],message:'客户端内登录仅适用于 Claude Desktop'})
    if(value.accountId!=='')ctx.addIssue({code:'custom',path:['accountId'],message:'Claude Desktop 在客户端内登录，不绑定管理器账号'})
    if(value.model!=='')ctx.addIssue({code:'custom',path:['model'],message:'Claude Desktop 的模型在客户端内选择'})
  }else{
    if(!value.accountId)ctx.addIssue({code:'custom',path:['accountId'],message:'请选择兼容的账号或供应商'})
    if(!value.model)ctx.addIssue({code:'custom',path:['model'],message:'请填写默认模型'})
  }
})
export type InstanceInput = z.infer<typeof instanceInputSchema>
/** Older Claude records without a launcher are CLI; client_login is Desktop-only. */
export function isClaudeDesktopProfile(profile:{clientType?:unknown;launchMode?:unknown;connectionMode?:unknown}):boolean {
  return profile.clientType==='claude_code'&&(profile.launchMode==='desktop'||profile.connectionMode==='client_login')
}
export interface InstanceModelDefaults { models:string[]; defaultModelId:string|null }
export interface ChatGPTModelsInput { accountId:string; applicationId:string; requestId:string; force?:boolean }
export interface ChatGPTModelsResult extends InstanceModelDefaults {
  accountId:string; requestId:string; source:'official'|'cache'; fetchedAt:number
}
export interface ExternalInstanceHome {directory:string;device:number;inode:number;previousTargetName?:string}
export interface InstanceProfile extends Omit<InstanceInput,'clientType'> { clientType?:AgentClientType; id:string; revision:number; createdAt:number; externalHome?:ExternalInstanceHome }
export interface InstanceApplication { clientType?:AgentClientType; id:string; name:string; path:string; installationPath?:string; kind?:'desktop'|'cli'; supportsTempLogin?:boolean }
export interface InstanceWorkingDirectory {id:string;path:string;device:number;inode:number}
export type InstanceIdentityStatus='native_verified'|'native_unverified'|'api_configured'|'subscription_configured'|'client_login'|'local_api'|'missing'|'unknown'
export interface InstanceIdentityView {
  status:InstanceIdentityStatus
  email?:string
  accountId?:string
}
export interface InstanceView extends Omit<InstanceProfile,'clientType'> {
  clientType?:unknown
  directory:string; desktopDirectory:string; applicationName?:string; accountName?:string
  launchMode?:'desktop'|'cli';workingDirectory?:string;copying?:boolean
  status:'stopped'|'preparing'|'starting'|'running'|'stopping'|'error'; pid?:number
  port?:number; appliedTier?:string; error?:string; notice?:string; startedAt?:number
  speedMenu?:'pending'|'active'|'fallback'|'unavailable'
  initialTier?:string
  desktopLocaleCompatibility?:'pending'|'active'|'fallback'|'unavailable'
  ultraCompatibility?:'pending'|'active'|'fallback'|'unavailable'
  clientVersion?:string
  identityStatus?:InstanceIdentityStatus
  identityEmail?:string
  identityAccountId?:string
}
export interface InstanceLaunchPreview {
  clientType:AgentClientType
  ticket:string; instanceId:string; name:string; application:string; directory:string; desktopDirectory:string
  workingDirectory:string; args:string[]; accountName:string; model:string; tier?:string; tierSource:string
  connectionMode:'local_api'|'native'|'client_login'
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
  ultraAvailable?:boolean
  ultraReason?:string
  clientVersion?:string
  network?:{mode:'inherit'|'direct'|'proxy';source:'settings'|'account';proxy?:AccountProxyView}
  identityStatus:InstanceIdentityStatus
  identityEmail?:string
  identityAccountId?:string
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
export const copyInstanceSchema=instanceRevisionSchema.extend({copyMode:instanceCopyModeSchema,details:instanceInputSchema}).strict()
export type InstanceCopyInput=z.infer<typeof copyInstanceSchema>
export interface InstanceCopySource {ticket:string;name:string;directory:string;history?:InstanceHistorySummary}
export interface ExternalInstanceSource {
  id:string;name:string;directory:string;sourceName:string;clientType:'codex'
  launchMode:'desktop'|'cli';runtimeState:'running'|'not_detected'|'unknown'
}
export interface ExternalInstanceDiscovery {sources:ExternalInstanceSource[];issues:string[]}
export const copyExternalInstanceSchema=z.object({ticket:z.string().uuid(),sourceClosed:z.boolean().optional(),copyMode:instanceCopyModeSchema,details:instanceInputSchema}).strict()
export type ExternalInstanceCopyInput=z.infer<typeof copyExternalInstanceSchema>
export const attachInstanceSchema=copyExternalInstanceSchema.omit({copyMode:true}).extend({sourceClosed:z.literal(true)})
export type AttachInstanceInput=z.infer<typeof attachInstanceSchema>
export interface InstanceCopyView {
  id:string;sourceId:string;sourceName:string;name:string;targetId?:string
  sourceDirectory?:string;external?:boolean;omittedSessions?:number;copyMode?:InstanceCopyMode
  status:'scanning'|'copying'|'completed'|'cancelled'|'failed';files:number;bytes:number;totalFiles:number;totalBytes:number;skipped:number;error?:string
}
