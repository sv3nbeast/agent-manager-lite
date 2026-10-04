import { z } from 'zod'

export const providerProbeInputSchema = z.object({
  mode:z.enum(['models','chat']),
  targets:z.array(z.object({providerId:z.string().uuid(),revision:z.number().int().nonnegative(),keyId:z.string().uuid()}).strict()).min(1).max(100),
  model:z.string().trim().min(1).max(200).optional(),
  prompt:z.string().trim().min(1).max(4000).default('hi'),
  serviceTier:z.enum(['priority','default','auto','flex']).optional()
}).strict()
export type ProviderProbeInput = z.infer<typeof providerProbeInputSchema>
export interface ProbeModel { id:string; name?:string }
export interface ProviderProbeRecord {
  providerId:string; providerRevision:number; providerName:string; keyId:string; keyName:string
  wireApi:'responses'|'chat_completions'; baseUrl:string
  status:'pending'|'running'|'success'|'error'|'cancelled'|'stale'
  stage:'queued'|'models'|'starting'|'chat'|'cleanup'|'done'
  startedAt?:number; finishedAt?:number; durationMs?:number; httpStatus?:number
  models?:ProbeModel[]; modelsTruncated?:boolean; model?:string; reply?:string; replyTruncated?:boolean
  error?:string; outboundTier?:string; responseTier?:string
}
export interface ProviderProbeState {
  runId?:string; mode?:'models'|'chat'; running:boolean; cancelling:boolean; cancelled:boolean
  total:number; completed:number; succeeded:number; failed:number; records:ProviderProbeRecord[]
}
