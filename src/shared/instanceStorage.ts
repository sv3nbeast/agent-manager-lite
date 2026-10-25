import {z} from 'zod'

export const instanceStorageCategorySchema=z.enum(['sessions','databases','config','skills','workspace','cache','other'])
export type InstanceStorageCategory=z.infer<typeof instanceStorageCategorySchema>

export interface InstanceStorageCategoryUsage {
  category:InstanceStorageCategory
  logicalBytes:number
  filesystemBlocksBytes?:number
  files:number
}
export interface InstanceStorageRow {
  id:string
  kind:'managed'|'legacy_trash'
  name:string
  directory:string
  logicalBytes:number
  filesystemBlocksBytes?:number
  allocatedEstimateConfidence:'low'|'unavailable'
  files:number
  categories:InstanceStorageCategoryUsage[]
  createdAt?:number
  warning?:string
}
export interface InstanceStorageInventory {
  capturedAt:number
  logicalBytes:number
  filesystemBlocksBytes?:number
  allocatedEstimateConfidence:'low'|'unavailable'
  files:number
  rows:InstanceStorageRow[]
  warnings:string[]
  notes:string[]
}
