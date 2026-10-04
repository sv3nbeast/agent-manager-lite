import { Agent, ProxyAgent, Socks5ProxyAgent, buildConnector, fetch as webFetch, type Dispatcher } from 'undici'
import type { Socket } from 'node:net'

const subscriptionPaths = new Set(['/backend-api/accounts/check/v4-2023-04-27', '/backend-api/subscriptions'])
const responseLimit = 2 * 1024 * 1024

/** Keep the Node web transport scoped to the two ChatGPT subscription APIs. */
export function isChatGPTSubscriptionURL(raw: string): boolean {
  try {
    const url = new URL(raw)
    const exact = /^https:\/\/chatgpt\.com(?::443)?(\/[^?#]*)(?:\?[^#]*)?$/i.exec(raw)
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port
      && !url.username && !url.password && !url.hash && !!exact
      && !/[\u0000-\u0020\\]/.test(raw) && subscriptionPaths.has(exact[1])
  } catch { return false }
}

class SubscriptionTransportError extends Error {}

/** A per-request dispatcher preserves the chosen exit and never uses global proxy routing. */
export async function fetchSubscriptionWeb(url: string, init: RequestInit, normalizedProxy: string): Promise<Response> {
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(init.signal ? [init.signal] : [])])
  let dispatcher: Dispatcher | undefined
  const socksSockets = new Set<Socket>()
  const cancelSocks = () => { for (const socket of socksSockets) socket.destroy(new Error('操作已取消')) }
  try {
    signal.throwIfAborted()
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new SubscriptionTransportError('不支持此请求体')
    if (normalizedProxy === 'direct') dispatcher = new Agent()
    else {
      const proxy = new URL(normalizedProxy)
      if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
        const token = proxy.username || proxy.password
          ? 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64') : undefined
        dispatcher = new ProxyAgent({ uri: proxy.toString(), ...(token ? { token } : {}) })
      }
      else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
        // Socks5ProxyAgent sends hostnames to the proxy and decodes URL credentials.
        // ProxyAgent's SOCKS wrapper passes encoded credentials as explicit options.
        proxy.protocol = 'socks5:'
        const connect = buildConnector({ timeout: 10_000 })
        dispatcher = new Socks5ProxyAgent(proxy, { connect: (options, callback) => {
          connect(options, (error, socket) => {
            if (error) { callback(error, null); return }
            socksSockets.add(socket)
            socket.once('close', () => socksSockets.delete(socket))
            if (signal.aborted) { socket.destroy(); callback(new Error('操作已取消'), null); return }
            callback(null, socket)
          })
        } })
        // The SOCKS handshake happens before the pool owns the socket; destroy
        // those sockets explicitly when cancelled, including stalled handshakes.
        signal.addEventListener('abort', cancelSocks, { once: true })
      } else throw new SubscriptionTransportError('订阅网络代理配置无效')
    }
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => { headers[name] = value })
    const response = await webFetch(url, { dispatcher, method: init.method, headers,
      body: typeof init.body === 'string' ? init.body : undefined, signal, redirect: 'error' })
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > responseLimit) throw new SubscriptionTransportError('订阅响应超过大小限制')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
    }
    signal.throwIfAborted()
    const allowedHeaders: Record<string, string> = {}
    for (const name of ['content-type', 'cf-mitigated']) {
      const value = response.headers.get(name)
      if (value && value.length <= 2048) allowedHeaders[name] = value
    }
    return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
      status: response.status, headers: allowedHeaders
    })
  } catch (error) {
    if (init.signal?.aborted) throw new Error('操作已取消')
    if (error instanceof SubscriptionTransportError) throw error
    throw new Error('订阅网络请求失败或超时，请检查网络和代理设置')
  } finally {
    signal.removeEventListener('abort', cancelSocks)
    for (const socket of socksSockets) socket.destroy()
    await dispatcher?.destroy().catch(() => {})
  }
}
