import {z} from 'zod'
import type {ClientConfigTarget} from './clientConfig'

export const sessionKindSchema=z.enum(['all','conversation','external','subagent'])
export type SessionKind=Exclude<z.infer<typeof sessionKindSchema>,'all'>
const sessionId=z.string().trim().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value))
export const sessionScanSchema=z.object({runId:z.string().uuid(),targetId:z.string().uuid().optional(),clientType:z.enum(['all','codex','claude_code']).default('all'),projectQuery:z.string().trim().max(4096).default(''),titleQuery:z.string().trim().max(200).default(''),contentQuery:z.string().trim().max(200).default(''),kind:sessionKindSchema.default('all')}).strict()
export type SessionScanInput=z.infer<typeof sessionScanSchema>
export const sessionPageSchema=z.object({snapshotId:z.string().uuid(),page:z.number().int().min(1).max(100000),pageSize:z.number().int().min(1).max(100).default(25)}).strict()
export type SessionPageInput=z.infer<typeof sessionPageSchema>
export const sessionSelectionSchema=z.object({snapshotId:z.string().uuid(),sessionId,targetId:z.string().uuid()}).strict()
export type SessionSelection=z.infer<typeof sessionSelectionSchema>
export const sessionContentSchema=sessionSelectionSchema.extend({page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(40),query:z.string().trim().max(200).default('')}).strict()
export type SessionContentInput=z.infer<typeof sessionContentSchema>
export interface SessionContentBlock {type:'text'|'thinking'|'tool_use'|'tool_result'|'notice';text:string;name?:string;truncated?:boolean}
export interface SessionContentMessage {index:number;role:'user'|'assistant'|'system';timestamp?:number;model?:string;blocks:SessionContentBlock[];truncated?:boolean}
export interface SessionContentPage {snapshotId:string;sessionId:string;sourceSessionId:string;title:string;cwd:string;sourceName:string;clientType:'claude_code';page:number;pageSize:number;total:number;messages:SessionContentMessage[];warnings:string[]}
// Token reports may span several UI pages. Keep a bounded batch so a report
// remains cancellable and cannot turn into an unbounded directory scan.
export const sessionStatsSchema=z.object({snapshotId:z.string().uuid(),sessionIds:z.array(sessionId).min(1).max(1000)}).strict()
export interface SessionLocation {targetId:string;name:string;directory:string;running:boolean;archived:boolean;ambiguous:boolean;historicalCopies?:number;historyMode?:'paginated'}
export interface SessionTokens {input:number;output:number;total:number}
export interface SessionCapabilities {open:boolean;transfer:boolean;archive:boolean;trash:boolean;visibilityRepair:boolean;tokens:boolean;contentSearch:boolean;content?:boolean;resume?:boolean}
export interface SessionSource extends ClientConfigTarget {clientType:'codex'|'claude_code';readOnly?:boolean;launchMode?:'cli'|'desktop'}
export interface SessionRecord {id:string;title:string;cwd:string;projectName?:string;updatedAt?:number;kind:SessionKind;locations:SessionLocation[];historyMode?:'paginated';clientType?:'codex'|'claude_code';launchMode?:'cli'|'desktop';sourceSessionId?:string;resumeMode?:'managed'|'default_fork';capabilities?:SessionCapabilities;messageCount?:number;model?:string;resumeBlockedReason?:string}
export interface DefaultClaudeSessionResumePreview {ticket:string;sessionId:string;cwd:string;cliApplication:string;forkSession:true}
export interface SessionPage {snapshotId:string;scannedAt:number;total:number;page:number;pageSize:number;items:SessionRecord[];warnings:string[];sourceCounts?:Record<string,number>;sources?:SessionSource[]}
export interface SessionTokenResult {id:string;tokens?:SessionTokens;targetId?:string;error?:string}

export const sessionCopyPreviewSchema=z.object({snapshotId:z.string().uuid(),sessionIds:z.array(sessionId).min(1).max(1000),targetId:z.string().uuid(),applicationId:z.string().min(1).max(100)}).strict()
export type SessionCopyPreviewInput=z.infer<typeof sessionCopyPreviewSchema>
export const sessionCopyStartSchema=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict()
export interface SessionCopyItem {id:string;title:string;sourceName:string;sourceDirectory:string;bytes:number;status:'ready'|'existing'}
export interface SessionCopyPreview {ticket:string;targetId:string;targetName:string;directory:string;applicationName:string;provider:string;items:SessionCopyItem[];totalBytes:number}
export interface SessionTransferView {id:string;targetId:string;targetName:string;status:'copying'|'committing'|'indexing'|'completed'|'cancelled'|'failed'|'recovery_required';files:number;totalFiles:number;bytes:number;totalBytes:number;skipped:number;error?:string;indexError?:string}
export interface SessionTransferRecovery {id:string;targetId:string;targetName:string;message:string}
