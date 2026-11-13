import { z } from 'zod'

export const historyFilterSchema = z.object({
  search: z.string().trim().max(200).default(''),
  outcome: z.enum(['all', 'success', 'error', 'canceled', 'interrupted', 'upstream_error']).default('all'),
  from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional()
}).strict().refine(f => f.from === undefined || f.to === undefined || f.from <= f.to, '开始时间不能晚于结束时间')
export type HistoryFilter = z.infer<typeof historyFilterSchema>
export const historyQuerySchema = z.object({ filter: historyFilterSchema, page: z.number().int().min(1).max(1000000), pageSize: z.number().int().min(1).max(200) }).strict()
export type HistoryQuery = z.infer<typeof historyQuerySchema>
export interface HistoryEntry {
  seq: number; requestId: string; requestedAt: number; model: string; upstreamModel: string; accountId: string
  success: boolean; status: number; latencyMs: number; inputTokens: number; outputTokens: number; cachedTokens: number
  errorCategory?: string
  apiKeyId:string; apiKeyLabel:string; totalTokens:number
  inboundTier: string | null; outboundTier: string | null; responseTier: string | null; tierSource: string
}

// Persist a closed vocabulary only. Never copy upstream error bodies, tokens,
// URLs or arbitrary diagnostics into the history database or renderer.
export const historyErrorCategories = ['client_canceled','downstream_write_error','stream_interrupted','response_incomplete','upstream_response_failed','upstream_error','upstream_first_byte_timeout','upstream_stream_timeout','gateway_context_canceled','auth_failed','model_not_available','quota_or_rate_limit','request_failed'] as const
export function safeHistoryErrorCategory(value: unknown): string {
  return typeof value === 'string' && (historyErrorCategories as readonly string[]).includes(value) ? value : ''
}
export function historyOutcome(entry: Pick<HistoryEntry,'success'|'status'|'errorCategory'>): {label:string;color:string;detail:string} {
  if(entry.success)return {label:'成功',color:'green',detail:'请求已成功完成；HTTP 状态与请求结果分别显示。'}
  const messages: Record<string,[string,string,string]> = {
    client_canceled:['客户端取消','default','回复完成前客户端关闭连接或取消请求；不代表上游服务器报错。'],
    downstream_write_error:['传输中断','orange','向客户端传输时发生写入错误，未确认完整回复已送达。'],
    stream_interrupted:['流中断','orange','未成功转发完整的结束事件，连接已结束。HTTP 200 只说明响应已开始。'],
    response_incomplete:['回复未完成','orange','上游明确返回未完成状态。'],
    upstream_response_failed:['上游错误','red','上游流中明确返回错误或失败状态。'],
    upstream_error:['上游错误','red','上游请求失败。'],
    upstream_first_byte_timeout:['等待超时','orange','等待上游开始返回时超时。'],
    upstream_stream_timeout:['流超时','orange','等待上游继续返回时超时。'],
    gateway_context_canceled:['转发中断','orange','转发过程被取消。'],
    auth_failed:['鉴权失败','red','上游拒绝鉴权。'],
    model_not_available:['模型不可用','red','请求的模型或接口不可用。'],
    quota_or_rate_limit:['额度或限流','red','上游返回额度或限流错误。'],
    request_failed:['请求失败','red','请求未成功完成。']
  }
  const message=messages[safeHistoryErrorCategory(entry.errorCategory)]
  if(message)return {label:message[0],color:message[1],detail:message[2]}
  if(entry.status>=400)return {label:'失败',color:'red',detail:'请求返回 HTTP 错误；这条记录未保存更具体的结果类型。'}
  return {label:'结果未确认',color:'gold',detail:'这条历史记录被标记为未成功，但没有保存失败类型；可能包含完成后断连的旧版误判。无法仅凭 HTTP 200 或 Token 用量确认结果，原始记录保持不变。'}
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
