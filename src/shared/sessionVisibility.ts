import {z} from 'zod'

const safeText=z.string().trim().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'包含非法控制字符')
const providerId=z.string().trim().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'包含非法控制字符')
const sessionId=safeText

/**
 * The Lite app deliberately exposes the bounded upstream Quick repair only.
 * Deep catalog rebuilding is an explicit upstream maintenance operation and is
 * not silently folded into a normal session repair.
 */
export const sessionVisibilityRepairInputSchema=z.object({
  targetIds:z.array(z.string().uuid()).max(100).default([]),
  sessionIds:z.array(sessionId).max(1000).default([]),
  targetProvider:providerId.optional()
}).strict()
export type SessionVisibilityRepairInput=z.infer<typeof sessionVisibilityRepairInputSchema>

export const sessionVisibilityRepairApplySchema=z.object({ticket:z.string().uuid(),confirmed:z.literal(true)}).strict()
export type SessionVisibilityRepairApplyInput=z.infer<typeof sessionVisibilityRepairApplySchema>

export interface SessionVisibilityRepairInstance {
  id:string
  name:string
  directory:string
  currentProvider:string
  running:boolean
  isDefault:boolean
}

export interface SessionVisibilityRepairInstanceList {
  defaultInstanceId:string
  instances:SessionVisibilityRepairInstance[]
}

export type SessionVisibilityProviderSource='config'|'sqlite'
export interface SessionVisibilityRepairProvider {
  id:string
  sources:SessionVisibilityProviderSource[]
  isDefault:boolean
}

export interface SessionVisibilityRepairProviderList {
  defaultProvider:string
  providers:SessionVisibilityRepairProvider[]
}

export interface SessionVisibilityRepairItem {
  instanceId:string
  instanceName:string
  targetProvider:string
  changedRolloutFileCount:number
  updatedSqliteRowCount:number
  skippedSqliteFile:boolean
  running:boolean
  backupDir?:string
  warnings:string[]
}

export interface SessionVisibilityRepairPreview {
  ticket:string
  mode:'quick'
  createdAt:number
  instanceCount:number
  changedRolloutFileCount:number
  updatedSqliteRowCount:number
  skippedSqliteFileCount:number
  runningInstanceCount:number
  items:SessionVisibilityRepairItem[]
  warnings:string[]
  message:string
}

export interface SessionVisibilityRepairSummary extends Omit<SessionVisibilityRepairPreview,'ticket'|'createdAt'> {
  ticket?:string
  backupDirs:string[]
  cancelled?:boolean
}
