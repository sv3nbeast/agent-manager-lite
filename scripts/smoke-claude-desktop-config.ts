import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import type { Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { instanceInputSchema, type InstanceProfile } from '../src/shared/instances'
import { detectClaudeCodeDesktopApplications } from '../src/main/claudeCodeDesktopAdapter'
import { claudeDesktopRuntimeContext, prepareClaudeDesktopLaunch } from '../src/main/claudeDesktopRuntime'
import { MacDesktopRuntime, type DesktopPlan } from '../src/main/instanceRuntime'
import type { StoredAccount } from '../src/main/store'

// This acceptance test controls only the exact nonce-owned disposable PID.
// It uses the unmodified signed application, synthetic credentials and a
// loopback Messages fixture. Its explicit proxy rejects external connections.
const exec = promisify(execFile)
let accessibilityDriver = ''
let diagnosticsDirectory = ''
let assertOwned: (pid: number) => Promise<void> = async () => { throw new Error('No owned process') }
async function ax(pid: number, command: string, ...args: string[]): Promise<unknown> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  await assertOwned(pid)
  return JSON.parse((await exec(accessibilityDriver, [String(pid), command, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout)
}
async function axSnapshot(pid: number, path: string): Promise<unknown[]> {
  const value = await ax(pid, 'snapshot') as unknown[]
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  return value
}

type AxRow = { pid: number; role?: string; title?: string; description?: string; value?: string }
async function waitUI(pid: number, predicate: (rows: AxRow[]) => boolean, message: string): Promise<AxRow[]> {
  const deadline = Date.now() + 20_000
  let latest: AxRow[] = []
  while (Date.now() < deadline) {
    const rows = await ax(pid, 'snapshot') as AxRow[]
    latest = rows
    if (predicate(rows)) return rows
    await delay(200)
  }
  writeFileSync(join(diagnosticsDirectory, 'failed-ui.ax.json'), JSON.stringify(latest, null, 2), { mode: 0o600 })
  await screenshot(pid, join(diagnosticsDirectory, 'failed-ui')).catch(() => {})
  throw new Error(message)
}
async function screenshot(pid: number, output: string): Promise<void> {
  await assertOwned(pid)
  const script = 'ObjC.import("CoreGraphics"); function run(argv) { return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).filter(w=>w.kCGWindowOwnerPID===Number(argv[0])&&w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>200&&w.kCGWindowBounds.Height>150).map(w=>w.kCGWindowNumber)); }'
  const ids = JSON.parse((await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(pid)], { timeout: 5000, maxBuffer: 4096 })).stdout) as number[]
  assert.ok(ids.length > 0 && ids.every(Number.isInteger), 'Owned configuration window must be visible')
  for (let index = 0; index < ids.length; index++) {
    const path = `${output}-${index}.png`
    await exec('/usr/sbin/screencapture', ['-x', '-o', '-l', String(ids[index]), path], { timeout: 10_000, maxBuffer: 4096 })
    chmodSync(path, 0o600)
  }
}

async function cleanupOwnedUpdaters(application: string, root: string): Promise<number[]> {
  const helper = join(application, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt')
  const roots = [...new Set([root, root.replace(/^\/private\/var\//, '/var/')])]
  const commands = roots.map(path => `${helper} com.anthropic.claudefordesktop.ShipIt ${join(path, 'instance', 'desktop-home', 'Library', 'Caches', 'com.anthropic.claudefordesktop.ShipIt', 'ShipItState.plist')}`)
  const processes = (await exec('/bin/ps', ['-ww', '-axo', 'pid=,args='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout
  const candidates = processes.split('\n').flatMap(line => { const match = line.match(/^\s*(\d+)\s+(.+)$/); return match && commands.includes(match[2]) ? [Number(match[1])] : [] })
  const snapshot = async (pid: number): Promise<string | undefined> => {
    try { return (await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=,args='], { timeout: 3000, maxBuffer: 16 * 1024 })).stdout.trim() }
    catch (error) { if ((error as { code?: number }).code === 1) return; throw error }
  }
  const stopped: number[] = []
  for (const pid of candidates) {
    const identity = await snapshot(pid)
    if (!identity || !commands.some(command => identity.slice(24).trim() === command)) continue
    // A PID alone is insufficient: recheck its exact executable, fixture state
    // file and start time before each signal. Never stop other native updaters.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (await snapshot(pid) !== identity) break
      try { process.kill(pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && await snapshot(pid) === identity) await delay(100)
    }
    assert.notEqual(await snapshot(pid), identity, 'Disposable native updater must stop before its state directory is removed')
    stopped.push(pid)
  }
  return stopped
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'darwin')
  const application = detectClaudeCodeDesktopApplications({ roots: ['/Applications/Claude.app'] })[0]
  assert.ok(application)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-config-')))
  const servers = new Set<Server>(), sockets = new Set<Socket>(), state = { preserveFixture: false }
  try {
    const evidence = resolve(process.env.CML_DESKTOP_CONFIG_EVIDENCE || realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-config-evidence-'))))
    await runFixture(root, evidence, application, servers, sockets, state)
  } finally {
    for (const socket of sockets) socket.destroy()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    if (!state.preserveFixture) rmSync(root, { recursive: true, force: true })
  }
}

async function runFixture(root: string, evidence: string, application: ReturnType<typeof detectClaudeCodeDesktopApplications>[number], servers: Set<Server>, sockets: Set<Socket>, state: { preserveFixture: boolean }): Promise<void> {
  mkdirSync(evidence, { recursive: true, mode: 0o700 })
  diagnosticsDirectory = evidence
  accessibilityDriver = join(root, 'ax-driver')
  await exec('/usr/bin/xcrun', ['swiftc', join(dirname(fileURLToPath(import.meta.url)), 'claude-desktop-config-accessibility.swift'), '-o', accessibilityDriver], { timeout: 60_000, maxBuffer: 16 * 1024 })
  const key = `aml-synthetic-${randomUUID()}`, model = 'claude-haiku-4-5'
  const requests: Array<{ method: string; path: string; authenticated: boolean }> = [], proxyRequests: string[] = [], errors: string[] = []
  const proxy = createServer((request, response) => { proxyRequests.push(request.method ?? ''); response.writeHead(502); response.end() })
  proxy.on('connect', (_request, socket) => { proxyRequests.push('CONNECT'); socket.on('error', () => {}); socket.end('HTTP/1.1 502 Synthetic external network blocked\r\nContent-Length: 0\r\n\r\n') })
  servers.add(proxy)
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await listen(proxy)
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object')
  const upstream = createServer(async (request, response) => {
    try {
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET' && request.url === '/' && !request.headers['user-agent']) { response.end('{}'); return }
      const authenticated = request.headers['x-api-key'] === key
      requests.push({ method: request.method ?? '', path: request.url ?? '', authenticated })
      if (request.url === '/v1/messages' && request.method === 'POST') {
        assert.ok(authenticated)
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).model, model)
        response.end(JSON.stringify({ id: 'msg_synthetic_config', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Synthetic configuration ready.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      } else if (request.url?.startsWith('/v1/models')) {
        assert.ok(authenticated)
        response.end(JSON.stringify({ data: [{ id: model, type: 'model', display_name: 'Synthetic Claude', created_at: '2026-01-01T00:00:00Z' }], has_more: false }))
      } else { response.statusCode = 404; response.end('{}') }
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Fixture failed'); response.statusCode = 500; response.end('{}') }
  })
  servers.add(upstream)
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await listen(upstream)
  const address = upstream.address(); assert.ok(address && typeof address === 'object')
  const instance = join(root, 'instance'), directory = join(instance, 'home'), desktopDirectory = join(instance, 'desktop'), workspace = join(instance, 'workspace')
  for (const path of [instance, directory, desktopDirectory, workspace]) mkdirSync(path, { mode: 0o700 })
  const account: StoredAccount = { id: randomUUID(), name: 'Synthetic configuration account', kind: 'api_key', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key', baseUrl: `http://127.0.0.1:${address.port}`, models: [model], wireApi: 'chat_completions', credentials: { apiKey: key }, defaultTier: 'inherit', note: '', tags: [], createdAt: Date.now() }
  const profile: InstanceProfile = { ...instanceInputSchema.parse({ clientType: 'claude_code', name: 'Disposable configuration acceptance', accountId: account.id, model, applicationId: application.id, launchMode: 'desktop', connectionMode: 'native' }), id: randomUUID(), revision: 1, createdAt: Date.now() }
  const plan: DesktopPlan = { clientType: 'claude_code', mode: 'desktop', application: application.path, executable: application.executable, directory, desktopDirectory, workingDirectory: workspace, args: [], nonce: randomUUID(), networkRoute: { mode: 'proxy', url: `http://127.0.0.1:${proxyAddress.port}` } }
  const runtime = new MacDesktopRuntime(), controller = new AbortController()
  const report: Record<string, unknown> = { version: application.version, realCredentials: false, requests, proxyRequests, errors }
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let failure: unknown
  try {
    await prepareClaudeDesktopLaunch(claudeDesktopRuntimeContext(profile, plan, undefined, account), controller.signal)
    state.preserveFixture = true
    const child = await runtime.launch(plan, controller.signal)
    report.process = child
    assertOwned = async pid => { const actual = await runtime.find(plan); assert.equal(actual?.pid, pid, 'Accessibility requires the nonce-owned process'); assert.ok(actual?.started) }
    console.log(JSON.stringify({ ownedPID: child.pid, fixture: root, evidence }))
    await delay(5000, undefined, { signal: controller.signal })
    const library = join(`${desktopDirectory}-3p`, 'configLibrary'), metadataPath = join(library, '_meta.json')
    const goodMetadata = readFileSync(metadataPath, 'utf8'), metadata = JSON.parse(goodMetadata)
    assert.ok(metadata.entries.some((entry: { id: string }) => entry.id === metadata.appliedId))
    const broken = { ...metadata, entries: metadata.entries.filter((entry: { id: string }) => entry.id !== metadata.appliedId) }
    writeFileSync(metadataPath, JSON.stringify(broken), { mode: 0o600 })
    await ax(child.pid, 'activate')
    await ax(child.pid, 'menu', 'Developer', 'Configure Third-Party Inference…')
    report.developerMenu = true
    await delay(2500, undefined, { signal: controller.signal })
    await waitUI(child.pid, rows => rows.some(row => /Couldn.t load configuration/.test(row.value ?? '')) && rows.some(row => row.title === 'Retry'), 'Native editor did not reproduce the missing-entry error')
    await axSnapshot(child.pid, join(evidence, 'broken-configuration.ax.json'))
    await screenshot(child.pid, join(evidence, 'broken-configuration'))
    report.originalErrorReproduced = true
    // Recreate the old metadata bug only in this disposable instance. Restoring
    // the missing entry must let the already-open native editor recover on Retry.
    writeFileSync(metadataPath, goodMetadata, { mode: 0o600 })
    await ax(child.pid, 'press', 'AXButton', 'Retry')
    await waitUI(child.pid, rows => rows.some(row => row.description === 'Gateway base URL' && row.value === account.baseUrl), 'Retry did not read the repaired native configuration')
    const loaded = await axSnapshot(child.pid, join(evidence, 'repaired-configuration.ax.json')) as AxRow[]
    assert.ok(loaded.some(row => row.description === `Select configuration: ${account.name}`))
    assert.ok(!loaded.some(row => /Couldn.t load configuration/.test(row.value ?? '')))
    await screenshot(child.pid, join(evidence, 'repaired-configuration'))
    report.retryRecoveredWithoutRestart = true
    report.nativeListAndRead = true
    const marker = `AML saved in native editor ${randomUUID().slice(0, 8)}`
    await ax(child.pid, 'press', 'AXButton', 'Appearance')
    await waitUI(child.pid, rows => rows.some(row => row.description === 'Deployment display name'), 'Appearance settings did not load')
    await ax(child.pid, 'set', 'AXTextField', 'Deployment display name', marker)
    await waitUI(child.pid, rows => rows.some(row => row.title === 'Save Changes'), 'Native editor did not register the field edit')
    await ax(child.pid, 'press', 'AXButton', 'Save Changes')
    const saveDeadline = Date.now() + 10_000
    while (Date.now() < saveDeadline) {
      const selected = JSON.parse(readFileSync(metadataPath, 'utf8')).appliedId
      if (JSON.parse(readFileSync(join(library, `${selected}.json`), 'utf8')).deploymentDisplayName === marker) break
      await delay(100)
    }
    const selected = JSON.parse(readFileSync(metadataPath, 'utf8')).appliedId
    assert.equal(JSON.parse(readFileSync(join(library, `${selected}.json`), 'utf8')).deploymentDisplayName, marker, 'Save Changes must persist the native field')
    await axSnapshot(child.pid, join(evidence, 'saved-configuration.ax.json'))
    await screenshot(child.pid, join(evidence, 'saved-configuration'))
    report.nativeEditedAndSaved = true
    await runtime.stop(plan)
    await prepareClaudeDesktopLaunch(claudeDesktopRuntimeContext(profile, plan, undefined, account), controller.signal)
    const restarted = await runtime.launch(plan, controller.signal)
    report.restartedProcess = restarted
    assert.notEqual(restarted.pid, child.pid)
    await delay(3000, undefined, { signal: controller.signal })
    await ax(restarted.pid, 'activate')
    await ax(restarted.pid, 'menu', 'Developer', 'Configure Third-Party Inference…')
    await delay(2500, undefined, { signal: controller.signal })
    await waitUI(restarted.pid, rows => rows.some(row => row.description === 'Gateway base URL' && row.value === account.baseUrl), 'Restarted native editor could not read its managed configuration')
    await ax(restarted.pid, 'press', 'AXButton', 'Appearance')
    await waitUI(restarted.pid, rows => rows.some(row => row.description === 'Deployment display name' && row.value === marker), 'Native editor custom field did not survive manager preparation and restart')
    await axSnapshot(restarted.pid, join(evidence, 'restarted-configuration.ax.json'))
    await screenshot(restarted.pid, join(evidence, 'restarted-configuration'))
    report.customFieldRetainedAfterRestart = true
    assert.ok(requests.some(request => request.path === '/v1/messages' && request.authenticated), 'Native client must reach only the synthetic Messages fixture')
    assert.ok(proxyRequests.length > 0, 'The explicit rejecting proxy must handle external network attempts')
    report.configuredProxyUsed = true
    assert.equal(errors.length, 0)

  } catch (error) { failure = error; report.error = error instanceof Error ? error.message : 'Configuration acceptance failed' }
  finally {
    await runtime.stop(plan).catch(error => { failure ??= error })
    try { state.preserveFixture = Boolean(await runtime.find(plan)); report.processRemaining = state.preserveFixture }
    catch (error) { state.preserveFixture = true; failure ??= error; report.ownershipUncertain = true }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    if (!state.preserveFixture) {
      try { report.ownedUpdatersStopped = await cleanupOwnedUpdaters(application.path, root) }
      catch (error) { state.preserveFixture = true; failure ??= error; report.updaterCleanupUncertain = true }
    }
    const log = join(instance, 'desktop-home', 'Library', 'Logs', 'Claude-3p', 'main.log')
    if (existsSync(log)) writeFileSync(join(evidence, 'startup.log'), readFileSync(log), { mode: 0o600 })
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  }
  if (failure) throw failure
  assert.equal(state.preserveFixture, false, 'Disposable native process must exit')
  assert.equal(errors.length, 0)
  console.log(`Native Desktop configuration acceptance passed. Evidence: ${evidence}`)
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Native configuration acceptance failed'); process.exitCode = 1 })
