import {z} from 'zod'
import {sessionCopySourceSelectionSchema} from './sessions'
export const legacySyncPreviewSchema=z.object({targetIds:z.array(z.string().uuid()).min(2).max(100),applicationId:z.string().min(1).max(100)}).strict()
export const directionalSyncPreviewSchema=z.object({sourceIds:z.array(z.string().uuid()).min(1).max(100),targetId:z.string().uuid(),scope:z.enum(['selected','all']),sessionIds:z.array(z.string().uuid()).max(1000).default([]),sourceSelections:z.array(sessionCopySourceSelectionSchema).max(1000).optional(),applicationId:z.string().min(1).max(100)}).strict().superRefine((value,context)=>{
  if(value.sourceIds.includes(value.targetId))context.addIssue({code:'custom',path:['targetId'],message:'目标实例不能同时作为来源'})
  if(value.scope==='selected'&&!value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'请选择要同步的会话'})
  if(value.scope==='all'&&value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'同步全部会话时不应指定会话 ID'})
  if(new Set(value.sourceIds).size!==value.sourceIds.length)context.addIssue({code:'custom',path:['sourceIds'],message:'来源实例不能重复'})
  if(new Set(value.sessionIds).size!==value.sessionIds.length)context.addIssue({code:'custom',path:['sessionIds'],message:'会话不能重复'})
  if(value.sourceSelections?.some(selection=>!value.sourceIds.includes(selection.targetId)||value.scope==='selected'&&!value.sessionIds.includes(selection.sessionId)))context.addIssue({code:'custom',path:['sourceSelections'],message:'来源文件选择必须属于当前同步范围和来源实例'})
  if(value.sourceSelections&&new Set(value.sourceSelections.map(selection=>selection.sessionId+'\0'+selection.targetId)).size!==value.sourceSelections.length)context.addIssue({code:'custom',path:['sourceSelections'],message:'同一来源实例的同一会话不能重复选择'})
})
export const syncPreviewSchema=z.union([legacySyncPreviewSchema,directionalSyncPreviewSchema])
export type SyncPreviewInput=z.infer<typeof syncPreviewSchema>
export type DirectionalSyncPreviewInput=z.infer<typeof directionalSyncPreviewSchema>
export const syncStartSchema=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict()
export const syncConflictScanSchema=z.object({requestId:z.string().uuid(),sourceIds:z.array(z.string().uuid()).min(1).max(100),targetId:z.string().uuid()}).strict().superRefine((value,context)=>{
  if(value.sourceIds.includes(value.targetId))context.addIssue({code:'custom',path:['targetId'],message:'目标实例不能同时作为来源'})
  if(new Set(value.sourceIds).size!==value.sourceIds.length)context.addIssue({code:'custom',path:['sourceIds'],message:'来源实例不能重复'})
})
export type SyncConflictScanInput=z.infer<typeof syncConflictScanSchema>
export interface SyncConflictSession {id:string;title:string;locations:{targetId:string;name:string;directory:string;ambiguous:true;versions:{id:string;label:string;archived:boolean;updatedAt?:number}[]}[]}
export interface SyncTargetPreview {id:string;name:string;directory:string;added:number;updated:number;unchanged:number;duplicates:number;repairsWorkspace:boolean;repairsIndex:boolean}
export interface SyncPreview {ticket?:string;canStart:boolean;sessionCount:number;sourceFiles:number;totalBytes:number;targets:SyncTargetPreview[];unsupportedSessions?:{id:string;title:string;sourceIds:string[];reason:string}[];paginatedTransfer?:{kind:'codex_paginated';sourceId:string;targetId:string;rollouts:number;bytes:number};directional?:{sourceIds:string[];targetId:string;scope:'selected'|'all';sources:{id:string;name:string;directory:string}[];sessions:{id:string;title:string;sourceIds:string[];sourceFiles:number;targetFiles:number;action:'add'|'merge'|'unchanged'}[]}}
export interface SyncView {id:string;status:'preparing'|'ready'|'running'|'completed'|'cancelled'|'failed';targets:SyncTargetPreview[];completedTargets:string[];currentTarget?:string;sourceFiles:number;processedFiles:number;bytes:number;totalBytes:number;error?:string;backups:{targetId:string;id:string}[];transferKind?:'jsonl'|'codex_paginated'}
export interface SyncRecovery {id:string;targetId:string;targetName:string;message:string;kind?:'session_sync'|'codex_paginated'}
