import {z} from 'zod'
const ids=z.array(z.string().uuid()).min(1).max(1000)
export const trashPreviewSchema=z.object({snapshotId:z.string().uuid(),sessionIds:ids,applicationId:z.string().min(1).max(100),clientsClosed:z.literal(true)}).strict()
export type TrashPreviewInput=z.infer<typeof trashPreviewSchema>
export const trashActionSchema=z.object({snapshotId:z.string().uuid(),sessionIds:ids.optional(),all:z.literal(true).optional(),action:z.enum(['restore','purge']),applicationId:z.string().min(1).max(100).optional(),clientsClosed:z.literal(true).optional()}).strict().refine(value=>value.all?value.action==='purge'&&!value.sessionIds:!!value.sessionIds,'请选择会话或明确清空全部')
export type TrashActionInput=z.infer<typeof trashActionSchema>
export const trashPageSchema=z.object({snapshotId:z.string().uuid(),page:z.number().int().min(1).max(100000),pageSize:z.number().int().min(1).max(100).default(25)}).strict()
export interface TrashRecord {id:string;title:string;cwd:string;deletedAt:number;bytes:number;copies:number;locations:{id:string;name:string;directory:string}[]}
export interface TrashPage {snapshotId:string;total:number;page:number;pageSize:number;items:TrashRecord[]}
export interface TrashTargetPreview {id:string;name:string;directory:string;sessions:number;descendants:number;copies:number;bytes:number;officialPlan:boolean}
export interface TrashPreview {ticket:string;action:'trash'|'restore'|'purge'|'import';requested:number;sessions:number;copies:number;bytes:number;targets:TrashTargetPreview[];titles:string[];skippedCopies?:number}
export interface TrashJob {id:string;action:'trash'|'restore'|'purge'|'recover'|'import';status:'preparing'|'ready'|'running'|'completed'|'cancelled'|'failed';completedTargets:string[];targets:number;bytes:number;totalBytes:number;fallbackTargets?:number;importedCopies?:number;error?:string}
export interface TrashRecovery {id:string;targetId:string;targetName:string;phase:string;message:string;canResume:boolean;canRestore:boolean}
export interface TrashState {job?:TrashJob;recoveries:TrashRecovery[]}
export interface LegacyTrashGroup {id:string;name:string;originalRoot:string}
export interface LegacyTrashRow {id:string;title:string;copies:number;bytes:number;deletedAt:number;groupIds:string[]}
export interface LegacyTrashPage {snapshotId:string;root:string;total:number;copies:number;bytes:number;page:number;pageSize:number;items:LegacyTrashRow[];groups:LegacyTrashGroup[]}
export const legacyTrashImportSchema=z.object({snapshotId:z.string().uuid(),sessionIds:ids,mappings:z.array(z.object({sourceId:z.string().regex(/^[a-f0-9]{64}$/),targetId:z.string().uuid()}).strict()).min(1).max(100)}).strict()
export type LegacyTrashImportInput=z.infer<typeof legacyTrashImportSchema>
