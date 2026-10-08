import {z} from 'zod'

export const sessionKindSchema=z.enum(['all','conversation','external','subagent'])
export type SessionKind=Exclude<z.infer<typeof sessionKindSchema>,'all'>
const sessionId=z.string().trim().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
export const sessionScanSchema=z.object({runId:z.string().uuid(),targetId:z.string().uuid().optional(),titleQuery:z.string().trim().max(200).default(''),contentQuery:z.string().trim().max(200).default(''),kind:sessionKindSchema.default('all')}).strict()
export type SessionScanInput=z.infer<typeof sessionScanSchema>
export const sessionPageSchema=z.object({snapshotId:z.string().uuid(),page:z.number().int().min(1).max(100000),pageSize:z.number().int().min(1).max(100).default(25)}).strict()
export type SessionPageInput=z.infer<typeof sessionPageSchema>
export const sessionSelectionSchema=z.object({snapshotId:z.string().uuid(),sessionId,targetId:z.string().uuid()}).strict()
export type SessionSelection=z.infer<typeof sessionSelectionSchema>
// Token reports may span several UI pages. Keep a bounded batch so a report
// remains cancellable and cannot turn into an unbounded directory scan.
export const sessionStatsSchema=z.object({snapshotId:z.string().uuid(),sessionIds:z.array(sessionId).min(1).max(1000)}).strict()
export interface SessionLocation {targetId:string;name:string;directory:string;running:boolean;archived:boolean;ambiguous:boolean;historicalCopies?:number;historyMode?:'paginated'}
export interface SessionTokens {input:number;output:number;total:number}
export interface SessionRecord {id:string;title:string;cwd:string;projectName?:string;updatedAt?:number;kind:SessionKind;locations:SessionLocation[];historyMode?:'paginated'}
export interface SessionPage {snapshotId:string;scannedAt:number;total:number;page:number;pageSize:number;items:SessionRecord[];warnings:string[];sourceCounts?:Record<string,number>}
export interface SessionTokenResult {id:string;tokens?:SessionTokens;targetId?:string;error?:string}

export const sessionCopyPreviewSchema=z.object({snapshotId:z.string().uuid(),sessionIds:z.array(sessionId).min(1).max(1000),targetId:z.string().uuid(),applicationId:z.string().min(1).max(100)}).strict()
export type SessionCopyPreviewInput=z.infer<typeof sessionCopyPreviewSchema>
export const sessionCopyStartSchema=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict()
export interface SessionCopyItem {id:string;title:string;sourceName:string;sourceDirectory:string;bytes:number;status:'ready'|'existing'}
export interface SessionCopyPreview {ticket:string;targetId:string;targetName:string;directory:string;applicationName:string;provider:string;items:SessionCopyItem[];totalBytes:number}
export interface SessionTransferView {id:string;targetId:string;targetName:string;status:'copying'|'committing'|'indexing'|'completed'|'cancelled'|'failed'|'recovery_required';files:number;totalFiles:number;bytes:number;totalBytes:number;skipped:number;error?:string;indexError?:string}
export interface SessionTransferRecovery {id:string;targetId:string;targetName:string;message:string}
