import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { instanceInputSchema, type InstanceProfile } from '../src/shared/instances'
import { detectClaudeCodeDesktopApplications } from '../src/main/claudeCodeDesktopAdapter'
import { claudeDesktopRuntimeContext, prepareClaudeDesktopLaunch } from '../src/main/claudeDesktopRuntime'
import { MacDesktopRuntime, type DesktopPlan } from '../src/main/instanceRuntime'
import type { StoredAccount } from '../src/main/store'

// No real account or remote inference is used: all configured credentials and
// upstream responses belong to these disposable loopback fixtures.
const exec = promisify(execFile)

async function screenshot(pid: number, output: string): Promise<boolean> {
  try {
    const script = 'ObjC.import("CoreGraphics"); function run(argv) { const pid=Number(argv[0]); const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))); return JSON.stringify(windows.filter(w=>w.kCGWindowOwnerPID===pid&&w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>200&&w.kCGWindowBounds.Height>150).map(w=>w.kCGWindowNumber)); }'
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(pid)], { timeout: 5000, maxBuffer: 4096 })
    const ids = JSON.parse(stdout) as number[]
    if (!Number.isInteger(ids[0])) return false
    await exec('/usr/sbin/screencapture', ['-x', '-o', '-l', String(ids[0]), output], { timeout: 10_000, maxBuffer: 4096 })
    chmodSync(output, 0o600); return true
  } catch { return false }
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'darwin')
  const application = detectClaudeCodeDesktopApplications({ roots: ['/Applications/Claude.app'] })[0]
  assert.ok(application)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-api-'))), evidence = process.env.CML_DESKTOP_API_EVIDENCE || realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-api-evidence-')))
  mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const requests: Array<{ method: string; path: string; auth: boolean; scheme?: string; model?: string; stream?: boolean }> = [], errors: string[] = []
  let key = `aml-synthetic-${randomUUID()}`, scheme: 'x-api-key' | 'bearer' = 'x-api-key'
  const model = 'claude-haiku-4-5', proxyRequests: string[] = []
  const proxy = createServer((request, response) => { proxyRequests.push(request.method ?? ''); response.writeHead(502); response.end() })
  proxy.on('connect', (request, socket) => { proxyRequests.push('CONNECT'); socket.on('error', () => {}); socket.end('HTTP/1.1 502 Synthetic external network blocked\r\nContent-Length: 0\r\n\r\n') })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object')
  const server = createServer(async (request, response) => {
    try {
      const authenticated = scheme === 'x-api-key' ? request.headers['x-api-key'] === key && request.headers.authorization === undefined : request.headers.authorization === `Bearer ${key}` && request.headers['x-api-key'] === undefined
      const record: typeof requests[number] = { method: request.method ?? '', path: request.url ?? '', auth: authenticated, ...(authenticated ? { scheme } : {}) }
      requests.push(record)
      response.setHeader('content-type', 'application/json')
      if ((request.url === '/v1/messages' || request.url === '/v1/v1/messages') && request.method === 'POST') {
        assert.ok(authenticated, 'Native Desktop must authenticate its Messages request')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        assert.equal(body.model, model)
        record.model = body.model; record.stream = Boolean(body.stream)
        response.end(JSON.stringify({ id: 'msg_aml_synthetic', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Synthetic native gateway ready.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      } else if (request.url?.startsWith('/v1/models')) {
        assert.ok(authenticated, 'Native Desktop must use the configured x-api-key')
        response.end(JSON.stringify({ data: [{ id: model, type: 'model', display_name: 'Synthetic Claude', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: model, last_id: model }))
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Synthetic upstream route not found' } })) }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Mock failed')
      response.statusCode = 500; response.end('{}')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const instance = join(root, 'instance'), directory = join(instance, 'home'), desktopDirectory = join(instance, 'desktop'), workspace = join(instance, 'workspace')
  for (const path of [instance, directory, desktopDirectory, workspace]) mkdirSync(path, { mode: 0o700 })
  const account: StoredAccount = { id: randomUUID(), name: 'Synthetic Desktop API', kind: 'api_key', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key', baseUrl: `http://127.0.0.1:${address.port}${process.env.CML_DESKTOP_API_BASE_PATH ?? ''}`, models: ['claude-sonnet-4-5', model], wireApi: 'chat_completions', credentials: { apiKey: key }, defaultTier: 'inherit', note: '', tags: [], createdAt: Date.now() }
  const profile: InstanceProfile = { ...instanceInputSchema.parse({ clientType: 'claude_code', name: 'Disposable API acceptance', accountId: account.id, model, applicationId: application.id, launchMode: 'desktop', connectionMode: 'native' }), id: randomUUID(), revision: 1, createdAt: Date.now() }
  const plan: DesktopPlan = { clientType: 'claude_code', mode: 'desktop', application: application.path, executable: application.executable, directory, desktopDirectory, workingDirectory: workspace, args: [], nonce: randomUUID(), networkRoute: { mode: 'proxy', url: `http://127.0.0.1:${proxyAddress.port}` } }
  const runtime = new MacDesktopRuntime(), controller = new AbortController(), report: Record<string, unknown> = { version: application.version, requests, errors, proxyRequests, realCredentials: false }
  let failure: unknown
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    const context = claudeDesktopRuntimeContext(profile, plan, undefined, account)
    await prepareClaudeDesktopLaunch(context, controller.signal)
    const child = await runtime.launch(plan, controller.signal)
    report.process = child
    await delay(8000, undefined, { signal: controller.signal })
    report.screenshot = await screenshot(child.pid, join(evidence, 'api-window.png'))
    const files = await exec('/usr/sbin/lsof', ['-p', String(child.pid), '-Fn'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    assert.ok(files.stdout.split('\n').some(line => line.startsWith(`n${desktopDirectory}-3p/`)))
    const log = join(instance, 'desktop-home', 'Library', 'Logs', 'Claude-3p', 'main.log')
    const content = existsSync(log) ? readFileSync(log, 'utf8') : ''
    writeFileSync(join(evidence, 'startup.log'), content, { mode: 0o600 })
    assert.ok(!/safeStorage unavailable on macOS at startup|default keychain could not be found/i.test(content))
    // The signed Desktop build has changed its startup log wording across
    // releases. The profile ownership, authenticated Messages request and
    // absence of a model rejection are the stable third-party contract; keep
    // the log as evidence without pinning the smoke test to one log sentence.
    report.startupLog = { available: Boolean(content), mentionsGateway: /gateway|3P|third.?party|provider/i.test(content) }
    assert.equal(/state:\s*['"]config_model_rejected['"]/.test(content), false, 'Synthetic gateway model must be accepted')
    assert.ok(requests.some(request => /^\/v1(?:\/v1)?\/messages$/.test(request.path) && request.auth && request.model === model), JSON.stringify(requests))
    report.nativeThirdPartyProfile = true
    report.nativeMessagesProbeAccepted = true
    const recovered = new MacDesktopRuntime()
    assert.deepEqual(await recovered.find(plan), child)
    report.recovered = true
    const hold = Math.max(0, Math.min(Number(process.env.CML_DESKTOP_API_HOLD_SECONDS ?? '0') || 0, 120))
    console.log(JSON.stringify({ ownedPID: child.pid, evidence, fixture: root, hold }))
    if (hold) { for (let elapsed = 0; elapsed < hold; elapsed++) await delay(1000, undefined, { signal: controller.signal }) }
    await runtime.stop(plan)
    const originalDevice = readFileSync(join(`${desktopDirectory}-3p`, 'ant-did'), 'utf8')
    const firstRequestCount = requests.length
    key = `aml-synthetic-rotated-${randomUUID()}`; scheme = 'bearer'
    account.credentials.apiKey = key; account.credentialKind = 'anthropic_bearer'
    await prepareClaudeDesktopLaunch(claudeDesktopRuntimeContext(profile, plan, undefined, account), controller.signal)
    const second = await runtime.launch(plan, controller.signal)
    await delay(4000, undefined, { signal: controller.signal })
    assert.ok(requests.slice(firstRequestCount).some(request => /^\/v1(?:\/v1)?\/messages$/.test(request.path) && request.auth && request.scheme === 'bearer'))
    assert.equal(readFileSync(join(`${desktopDirectory}-3p`, 'ant-did'), 'utf8'), originalDevice)
    const restartedLog = existsSync(log) ? readFileSync(log, 'utf8') : ''
    report.restartLog = { available: Boolean(restartedLog), pinnedProxy: restartedLog.includes(`[egress-proxy] pinned to fixed proxy at 127.0.0.1:${proxyAddress.port}`) }
    assert.ok(proxyRequests.length > 0, 'Native Desktop must use its configured external network proxy')
    report.bearerRotation = { accepted: true, deviceRetained: true, privateProxyUsed: true, process: second }
    await screenshot(second.pid, join(evidence, 'api-bearer-window.png'))
    await runtime.stop(plan)
    const login: InstanceProfile = { ...profile, connectionMode: 'client_login', accountId: '', model: '' }
    await prepareClaudeDesktopLaunch(claudeDesktopRuntimeContext(login, plan), controller.signal)
    const loginChild = await runtime.launch(plan, controller.signal)
    assert.notEqual(loginChild.pid, child.pid)
    assert.ok(existsSync(`${desktopDirectory}-3p`))
    report.switchToLogin = { nativeProfileRetained: true, gatewaySecretsRemoved: readdirSync(join(`${desktopDirectory}-3p`, 'configLibrary')).filter(name => name.endsWith('.json')).every(name => !readFileSync(join(`${desktopDirectory}-3p`, 'configLibrary', name), 'utf8').includes(key)) }
  } catch (error) {
    failure = error
    report.error = error instanceof Error ? error.message : 'Native API acceptance failed'
  } finally {
    await runtime.stop(plan).catch(error => { failure ??= error })
    report.processRemaining = Boolean(await runtime.find(plan))
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    if (!report.processRemaining) rmSync(root, { recursive: true, force: true })
  }
  if (failure) throw failure
  assert.equal(errors.length, 0)
  console.log(`Native Desktop API acceptance passed. Evidence: ${evidence}`)
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Native Desktop API acceptance failed'); process.exitCode = 1 })
