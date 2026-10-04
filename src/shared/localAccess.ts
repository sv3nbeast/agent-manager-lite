import { z } from 'zod'

const name=z.string().trim().min(1).max(120).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
const ids=z.array(z.string().uuid()).max(10000).refine(value=>new Set(value).size===value.length,'账号不能重复')
const models=z.array(z.string().trim().min(1).max(200)).max(300)
export const localKeyDetailsSchema=z.object({label:name,enabled:z.boolean(),inheritAccountPool:z.boolean(),accountIds:ids,priorityAccountIds:ids.optional(),
  modelPrefix:z.string().trim().max(64).regex(/^[A-Za-z0-9_-]*$/),allowedModels:models,excludedModels:models,
  tokenLimit:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict()
export const quotaReserveThresholdSchema=z.object({hourlyPercent:z.number().int().min(0).max(100),weeklyPercent:z.number().int().min(0).max(100)}).strict()
export const quotaReserveSchema=z.record(z.string().uuid(),quotaReserveThresholdSchema)
export type QuotaReserveThreshold=z.infer<typeof quotaReserveThresholdSchema>
export type QuotaReserveSettings=z.infer<typeof quotaReserveSchema>
export const customRoutingRuleSchema=z.object({accountId:z.string().uuid(),priority:z.number().int().min(0).max(100),weight:z.number().int().min(1).max(100),isBackup:z.boolean(),isPreferred:z.boolean()}).strict().refine(rule=>!rule.isBackup||!rule.isPreferred,'账号不能同时优先和备用')
export const localPoolSchema=z.object({accountIds:ids,routingStrategy:z.enum(['auto','random','single_account','quota_high_first','quota_low_first','plan_high_first','plan_low_first','expiry_soon_first','custom']),
  customRoutingRules:z.array(customRoutingRuleSchema).max(10000).refine(rules=>new Set(rules.map(rule=>rule.accountId)).size===rules.length,'每个账号只能有一条调度规则').optional(),
  sessionAffinity:z.boolean(),sessionAffinityTtlMs:z.number().int().min(1000).max(86400000),quotaReserve:quotaReserveSchema.default({})}).strict()
export type LocalPoolSettings=z.infer<typeof localPoolSchema>
export type CustomRoutingRule=z.infer<typeof customRoutingRuleSchema>
export type LocalKeyDetails=z.infer<typeof localKeyDetailsSchema>
export interface StoredLocalKey extends LocalKeyDetails {id:string;revision:number;createdAt:number;key:string;restoredUsageOffset?:number}
export interface StoredLocalAccess extends LocalPoolSettings {revision:number;keys:StoredLocalKey[]}
export interface LocalKeyView extends Omit<StoredLocalKey,'key'> {tokenUsed:number|null;effectiveAccountIds:string[]}
export interface LocalAccessView extends LocalPoolSettings {revision:number;keys:LocalKeyView[];running:boolean;starting:boolean;singleStarting:boolean;port?:number;error?:string;appliedRevision?:number;accountInfo?:{id:string;remainingPercent?:number;expiresAt?:number}[]}
export function effectiveLocalAccountIds(pool:LocalPoolSettings,key:Pick<LocalKeyDetails,'inheritAccountPool'|'accountIds'>,known:Set<string>):string[] {
  const allowed=new Set(pool.accountIds)
  const ids=(key.inheritAccountPool?pool.accountIds:key.accountIds).filter(id=>known.has(id)&&allowed.has(id))
  // Source SingleAccount keeps the first scoped account and permits only one
  // credential attempt. Restrict the route before native/provider dispatch.
  return pool.routingStrategy==='single_account'?ids.slice(0,1):ids
}
export const localAccessMutationSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('savePool'),revision:z.number().int().min(0),settings:localPoolSchema}).strict(),
  z.object({action:z.literal('createKey'),details:localKeyDetailsSchema}).strict(),
  z.object({action:z.literal('updateKey'),id:z.string().uuid(),revision:z.number().int().min(0),details:localKeyDetailsSchema}).strict(),
  z.object({action:z.literal('rotateKey'),id:z.string().uuid(),revision:z.number().int().min(0)}).strict(),
  z.object({action:z.literal('deleteKey'),id:z.string().uuid(),revision:z.number().int().min(0)}).strict()
])
export type LocalAccessMutation=z.infer<typeof localAccessMutationSchema>
export const emptyLocalAccess=():StoredLocalAccess=>({revision:0,accountIds:[],routingStrategy:'auto',customRoutingRules:[],sessionAffinity:true,sessionAffinityTtlMs:3600000,quotaReserve:{},keys:[]})
