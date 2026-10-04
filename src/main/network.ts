// Small bounded JSON client. Upstream error bodies and fetch exception details may
// contain credentials; neither is forwarded to IPC, logs, or persisted errors.
export class HTTPError extends Error {
  constructor(readonly status: number, operation: string, readonly code?: 'agent_task_invalid') { super(`${operation}失败（HTTP ${status}）`) }
}
export class JSONResponseError extends Error {
  constructor(operation: string) { super(`${operation}响应无效或超过大小限制`) }
}
function invalidAgentTask(text: string): boolean {
  const lower = text.toLowerCase()
  return /"(?:code|error)"\s*:\s*"(?:invalid_task_id|task_not_found|task_expired)"/.test(lower)
    || ['invalid task_id', 'invalid task id', 'task_id is invalid', 'task id is invalid', 'task not found', 'task expired', 'unknown task_id', 'unknown task id'].some(marker => lower.includes(marker))
}
export type JSONRequest = (url: string, init?: RequestInit, operation?: string, account?:import('./store').StoredAccount) => Promise<Record<string, unknown>>
export type JSONFetch=(url:string,init:RequestInit)=>Promise<Response>
export const createJSONRequest=(transport:JSONFetch):JSONRequest=>async (url, init = {}, operation = '请求') => {
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(init.signal ? [init.signal] : [])])
  let response: Response
  try { response = await transport(url, { ...init, redirect: 'error', signal }) }
  catch {
    if (init.signal?.aborted) throw new Error('操作已取消')
    throw new Error(`${operation}连接失败或超时，请检查网络和代理设置`)
  }
  if (!response.ok) {
    let code: 'agent_task_invalid' | undefined
    // Retain only an allowlisted recovery classification, never the raw body.
    if (response.status === 401 && response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        while (size <= 65536) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size <= 65536) chunks.push(value)
        }
        if (size <= 65536 && invalidAgentTask(Buffer.concat(chunks).toString('utf8'))) code = 'agent_task_invalid'
      } catch { /* Status remains authoritative if the diagnostic body fails. */ }
      finally { await reader.cancel().catch(() => {}) }
    } else await response.body?.cancel()
    throw new HTTPError(response.status, operation, code)
  }
  if (!response.body) throw new Error(`${operation}返回空响应`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > 2 * 1024 * 1024) throw new Error('size')
      chunks.push(item.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
    return value as Record<string, unknown>
  } catch { throw new JSONResponseError(operation) }
  finally { await reader.cancel().catch(() => {}) }
}
export const requestJSON:JSONRequest=createJSONRequest((url,init)=>fetch(url,init))

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
