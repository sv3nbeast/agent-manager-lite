// Small bounded JSON client. Upstream error bodies and fetch exception details may
// contain credentials; neither is forwarded to IPC, logs, or persisted errors.
export type HTTPDiagnostic = 'cloudflare_challenge' | 'access_denied' | 'oauth_permission_denied'
const diagnosticMessages: Record<HTTPDiagnostic, string> = {
  cloudflare_challenge: '上游要求浏览器安全验证，请检查网络或账号代理',
  access_denied: '上游拒绝访问此接口',
  oauth_permission_denied: '当前登录凭据缺少此接口所需的权限'
}
export class HTTPError extends Error {
  constructor(readonly status: number, operation: string, readonly code?: 'agent_task_invalid', readonly diagnostic?: HTTPDiagnostic) {
    const detail = diagnostic && diagnosticMessages[diagnostic]
    super(`${operation}失败（HTTP ${status}）${detail ? `：${detail}` : ''}`)
  }
}
export class JSONResponseError extends Error {
  constructor(operation: string) { super(`${operation}响应无效或超过大小限制`) }
}
function invalidAgentTask(text: string): boolean {
  const lower = text.toLowerCase()
  return /"(?:code|error)"\s*:\s*"(?:invalid_task_id|task_not_found|task_expired)"/.test(lower)
    || ['invalid task_id', 'invalid task id', 'task_id is invalid', 'task id is invalid', 'task not found', 'task expired', 'unknown task_id', 'unknown task id'].some(marker => lower.includes(marker))
}
function forbiddenDiagnostic(text: string): HTTPDiagnostic | undefined {
  // Recognize challenge markup, not an arbitrary mention of Cloudflare.
  if (/^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<script\b)/i.test(text)
    && /window\._cf_chl_opt\s*=|\/cdn-cgi\/challenge-platform\//i.test(text)) return 'cloudflare_challenge'
  try {
    const body: unknown = JSON.parse(text)
    const error = object(body).error
    const fields = object(error)
    const code = typeof error === 'string' ? error.toLowerCase() : nonempty(fields.code)?.toLowerCase()
    const type = nonempty(fields.type)?.toLowerCase()
    if ([code, type].some(value => value === 'insufficient_scope' || value === 'insufficient_permissions')) return 'oauth_permission_denied'
    const message = nonempty(fields.message)?.toLowerCase()
    if (message?.includes('insufficient permissions for this operation') || message?.includes('missing scopes:')) return 'oauth_permission_denied'
    if ([code, type].includes('access_denied')) return 'access_denied'
  } catch { /* Unknown or non-JSON errors retain only their HTTP status. */ }
  return undefined
}
async function boundedErrorText(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks).toString('utf8')
      size += value.length
      if (size > 65536) return undefined
      chunks.push(value)
    }
  } catch { return undefined }
  finally { await reader.cancel().catch(() => {}) }
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
    let diagnostic: HTTPDiagnostic | undefined
    // Retain only allowlisted classifications; discard the bounded body itself.
    if (response.status === 403 && response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') {
      diagnostic = 'cloudflare_challenge'
      await response.body?.cancel().catch(() => {})
    } else if (response.status === 401 || response.status === 403) {
      const body = await boundedErrorText(response)
      if (body !== undefined) {
        if (response.status === 401 && invalidAgentTask(body)) code = 'agent_task_invalid'
        if (response.status === 403) diagnostic = forbiddenDiagnostic(body)
      }
    } else await response.body?.cancel().catch(() => {})
    throw new HTTPError(response.status, operation, code, diagnostic)
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
