import {z} from 'zod'
import type {SessionCopyPreview} from './sessions'

export const archiveSelectionSchema=z.object({snapshotId:z.string().uuid(),sessionIds:z.array(z.string().uuid()).min(1).max(1000)}).strict()
export const archiveImportSchema=z.object({ticket:z.string().uuid(),targetId:z.string().uuid(),applicationId:z.string().min(1).max(100),sessionIds:z.array(z.string().uuid()).min(1).max(1000)}).strict()
export type ArchiveImportInput=z.infer<typeof archiveImportSchema>
export interface ArchiveItem {id:string;title:string;cwd:string;bytes:number;archived:boolean;sourceName:string}
export interface ArchivePreview {ticket:string;fileName?:string;exportedAt?:string;items:ArchiveItem[];totalBytes:number}
export interface ArchiveImportPreview extends SessionCopyPreview {packageTicket:string;existing:Record<string,'duplicate'|'conflict'>}
export interface ArchiveProgress {id:string;operation:'export'|'import';status:'preparing'|'ready'|'running'|'completed'|'failed'|'cancelled';files:number;totalFiles:number;bytes:number;totalBytes:number;path?:string;error?:string}
