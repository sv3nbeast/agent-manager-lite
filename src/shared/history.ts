import { z } from 'zod'

export const historyFilterSchema = z.object({
  search: z.string().trim().max(200).default(''),
  outcome: z.enum(['all', 'success', 'error']).default('all'),
  from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional()
}).strict().refine(f => f.from === undefined || f.to === undefined || f.from <= f.to, '开始时间不能晚于结束时间')
export type HistoryFilter = z.infer<typeof historyFilterSchema>
export const historyQuerySchema = z.object({ filter: historyFilterSchema, page: z.number().int().min(1).max(1000000), pageSize: z.number().int().min(1).max(200) }).strict()
export type HistoryQuery = z.infer<typeof historyQuerySchema>
export interface HistoryEntry {
  seq: number; requestId: string; requestedAt: number; model: string; upstreamModel: string; accountId: string
  success: boolean; status: number; latencyMs: number; inputTokens: number; outputTokens: number; cachedTokens: number
  apiKeyId:string; apiKeyLabel:string; totalTokens:number
  inboundTier: string | null; outboundTier: string | null; responseTier: string | null; tierSource: string
}
export interface HistoryBreakdownRow {
  key: string; requests: number; succeeded: number
  inputTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number
}
export interface HistoryReport {
  models: HistoryBreakdownRow[]; accounts: HistoryBreakdownRow[]; tiers: HistoryBreakdownRow[]
}
export interface HistoryPage {
  entries: HistoryEntry[]; total: number; succeeded: number; inputTokens: number; outputTokens: number; cachedTokens: number
  report: HistoryReport
}
