import {z} from 'zod'
export const syncPreviewSchema=z.object({targetIds:z.array(z.string().uuid()).min(2).max(100),applicationId:z.string().min(1).max(100)}).strict()
export type SyncPreviewInput=z.infer<typeof syncPreviewSchema>
export const syncStartSchema=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict()
export interface SyncTargetPreview {id:string;name:string;directory:string;added:number;updated:number;unchanged:number;duplicates:number;repairsWorkspace:boolean;repairsIndex:boolean}
export interface SyncPreview {ticket:string;sessionCount:number;sourceFiles:number;totalBytes:number;targets:SyncTargetPreview[]}
export interface SyncView {id:string;status:'preparing'|'ready'|'running'|'completed'|'cancelled'|'failed';targets:SyncTargetPreview[];completedTargets:string[];currentTarget?:string;sourceFiles:number;processedFiles:number;bytes:number;totalBytes:number;error?:string;backups:{targetId:string;id:string}[]}
export interface SyncRecovery {id:string;targetId:string;targetName:string;message:string}
