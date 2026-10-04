import test from 'node:test'
import assert from 'node:assert/strict'
import { createJSONRequest, HTTPError, type HTTPDiagnostic } from '../src/main/network'

const operation = '查询订阅账号信息'
const url = 'https://example.invalid/subscription'
async function rejectedResponse(response: Response): Promise<HTTPError> {
  let result: HTTPError | undefined
  await assert.rejects(createJSONRequest(async () => response)(url, {}, operation), error => {
    assert.ok(error instanceof HTTPError)
    result = error
    return true
  })
  return result!
}

test('403 diagnoses only recognized Cloudflare or OAuth access errors without exposing upstream values', async () => {
  const secret = 'fixture-private-email-token'
  const cases: [string, HTTPDiagnostic | undefined][] = [
    [`<html><script>window._cf_chl_opt = {secret:'${secret}'}</script></html>`, 'cloudflare_challenge'],
    [`<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>${secret}</html>`, 'cloudflare_challenge'],
    [JSON.stringify({ error: { code: 'insufficient_scope', message: secret } }), 'oauth_permission_denied'],
    [JSON.stringify({ error: { type: 'insufficient_permissions', message: secret } }), 'oauth_permission_denied'],
    [JSON.stringify({ error: { message: `You have insufficient permissions for this operation. Missing scopes: ${secret}` } }), 'oauth_permission_denied'],
    [JSON.stringify({ error: { code: 'access_denied', message: secret } }), 'access_denied'],
    [JSON.stringify({ error: 'access_denied', private: secret }), 'access_denied'],
    [JSON.stringify({ error: { code: secret, message: secret }, other: 'insufficient_scope' }), undefined],
    [JSON.stringify({ error: { message: `/cdn-cgi/challenge-platform/${secret}` } }), undefined],
    [`<html>Cloudflare error: ${secret}</html>`, undefined],
    [JSON.stringify({ error: { code: 'task_expired', message: secret } }), undefined]
  ]
  for (const [body, diagnostic] of cases) {
    const error = await rejectedResponse(new Response(body, { status: 403 }))
    assert.equal(error.status, 403)
    assert.equal(error.code, undefined)
    assert.equal(error.diagnostic, diagnostic)
    assert.equal(error.message.includes(secret), false)
    assert.equal(JSON.stringify(error).includes(secret), false)
    assert.equal(error.stack?.includes(secret), false)
    if (!diagnostic) assert.equal(error.message, `${operation}失败（HTTP 403）`)
  }
})

test('cf-mitigated challenge header classifies and cancels without reading an untrusted body', async () => {
  let reads = 0, cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(Buffer.from('fixture-body-secret')) },
    cancel() { cancelled = true }
  }, { highWaterMark: 0 })
  const error = await rejectedResponse(new Response(body, { status: 403, headers: { 'cf-mitigated': 'challenge' } }))
  assert.equal(error.diagnostic, 'cloudflare_challenge')
  assert.equal(reads, 0)
  assert.equal(cancelled, true)
  assert.equal(error.message.includes('fixture-body-secret'), false)
})

test('error diagnostics stop at 64 KiB, cancel oversized streams and discard partial classifications', async () => {
  for (const status of [401, 403]) {
    let reads = 0, cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        // Put recognized markers before the cap: no partial body is trusted.
        controller.enqueue(Buffer.from((status === 401 ? 'invalid task_id ' : 'window._cf_chl_opt = ') + 'x'.repeat(40000)))
      },
      cancel() { cancelled = true }
    }, { highWaterMark: 0 })
    const error = await rejectedResponse(new Response(body, { status }))
    assert.equal(error.code, undefined)
    assert.equal(error.diagnostic, undefined)
    assert.equal(reads, 2)
    assert.equal(cancelled, true)
    assert.equal(error.message, `${operation}失败（HTTP ${status}）`)
  }
})

test('an error exactly at the diagnostic cap can be classified and body failures preserve HTTP status', async () => {
  const value = '{"error":{"code":"insufficient_scope"}}'
  const error = await rejectedResponse(new Response(value.padEnd(65536), { status: 403 }))
  assert.equal(error.diagnostic, 'oauth_permission_denied')
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture-stream-secret')) } })
  const failed = await rejectedResponse(new Response(broken, { status: 403 }))
  assert.equal(failed.message, `${operation}失败（HTTP 403）`)
  assert.equal(failed.diagnostic, undefined)
})

test('401 recovery classification and unrelated HTTP consumers retain their behavior', async () => {
  const expired = await rejectedResponse(new Response('{"error":{"code":"task_expired"}}', { status: 401 }))
  assert.equal(expired.code, 'agent_task_invalid')
  assert.equal(expired.diagnostic, undefined)
  assert.equal(expired.message, `${operation}失败（HTTP 401）`)
  for (const status of [401, 429, 500]) {
    const error = await rejectedResponse(new Response('{"error":{"code":"insufficient_scope"}}', { status, headers: { 'cf-mitigated': 'challenge' } }))
    assert.equal(error.diagnostic, undefined)
    assert.equal(error.message, `${operation}失败（HTTP ${status}）`)
  }
})
