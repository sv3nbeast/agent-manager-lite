import {z} from 'zod'
export const legacySyncPreviewSchema=z.object({targetIds:z.array(z.string().uuid()).min(2).max(100),applicationId:z.string().min(1).max(100)}).strict()
export const directionalSyncPreviewSchema=z.object({sourceIds:z.array(z.string().uuid()).min(1).max(100),targetId:z.string().uuid(),scope:z.enum(['selected','all']),sessionIds:z.array(z.string().uuid()).max(1000).default([]),applicationId:z.string().min(1).max(100)}).strict().superRefine((value,context)=>{
  if(value.sourceIds.includes(value.targetId))context.addIssue({code:'custom',path:['targetId'],message:'目标实例不能同时作为来源'})
  if(value.scope==='selected'&&!value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'请选择要同步的会话'})
  if(value.scope==='all'&&value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'同步全部会话时不应指定会话 ID'})
  if(new Set(value.sourceIds).size!==value.sourceIds.length)context.addIssue({code:'custom',path:['sourceIds'],message:'来源实例不能重复'})
  if(new Set(value.sessionIds).size!==value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'会话不能重复'})
})
export const syncPreviewSchema=z.union([legacySyncPreviewSchema,directionalSyncPreviewSchema])
export type SyncPreviewInput=z.infer<typeof syncPreviewSchema>
export type DirectionalSyncPreviewInput=z.infer<typeof directionalSyncPreviewSchema>
export const syncStartSchema=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict()
export interface SyncTargetPreview {id:string;name:string;directory:string;added:number;updated:number;unchanged:number;duplicates:number;repairsWorkspace:boolean;repairsIndex:boolean}
export interface SyncPreview {ticket:string;sessionCount:number;sourceFiles:number;totalBytes:number;targets:SyncTargetPreview[];directional?:{sourceIds:string[];targetId:string;scope:'selected'|'all';sources:{id:string;name:string;directory:string}[];sessions:{id:string;title:string;sourceIds:string[];sourceFiles:number;targetFiles:number;action:'add'|'merge'|'unchanged'}[]}}
export interface SyncView {id:string;status:'preparing'|'ready'|'running'|'completed'|'cancelled'|'failed';targets:SyncTargetPreview[];completedTargets:string[];currentTarget?:string;sourceFiles:number;processedFiles:number;bytes:number;totalBytes:number;error?:string;backups:{targetId:string;id:string}[]}
export interface SyncRecovery {id:string;targetId:string;targetName:string;message:string}
