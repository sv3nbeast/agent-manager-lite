import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { detectClaudeCodeDesktopApplications } from '../src/main/claudeCodeDesktopAdapter'
import { sendClaudeDesktopLoginUrl } from '../src/main/claudeDesktopLogin'
import { MacDesktopRuntime, type DesktopPlan, type DesktopProcess } from '../src/main/instanceRuntime'
import { NativeProxy, type NativeProxyLease } from '../src/main/nativeProxy'

// Real macOS Desktop acceptance. Only disposable blank profiles are opened.
// No existing login, Keychain value, conversation or model request is copied.
// This checks local ownership and persistence, not a completed upstream login.
const exec = promisify(execFile)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sqlValue = (value: string) => `'${value.replaceAll("'", "''")}'`
const within = (root: string, path: string) => path === root || (!relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)))

interface Fixture { name: string; root: string; home: string; marker: string; plan: DesktopPlan }
interface FilesEvidence { pid: number; processCount: number; profileFiles: number; logFiles: number; profilePaths: string[]; logPaths: string[]; unexpectedPaths: string[] }
interface Snapshot { deviceIdHash: string; configMarker: string; cookieDatabase: string }

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function upstreamProxy(): string | undefined {
  const file = argument('--upstream-proxy-file')
  if (!file) return process.env.CML_CLAUDE_DESKTOP_PROXY?.trim() || undefined
  assert.ok(!process.env.CML_CLAUDE_DESKTOP_PROXY, 'Choose a proxy file or environment value, not both')
  const stat = lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === userInfo().uid && (stat.mode & 0o077) === 0 && stat.size < 4096, 'The proxy input must be a private, current-user-owned regular file')
  const value = readFileSync(file, 'utf8').trim()
  assert.ok(value, 'The proxy input file must not be empty')
  return value
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeout = 25_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function fixture(root: string, name: string, application: string, executable: string): Fixture {
  const directory = join(root, `instance ${name}`), home = join(directory, 'desktop-home')
  const config = join(directory, 'home'), desktop = join(directory, 'desktop'), workspace = join(directory, 'workspace')
  for (const path of [directory, home, join(home, 'tmp'), config, desktop, workspace]) mkdirSync(path, { mode: 0o700 })
  const marker = `aml-desktop-smoke-${name}-${randomUUID()}`
  writeFileSync(join(desktop, 'config.json'), JSON.stringify({ amlSmokeMarker: marker }), { mode: 0o600 })
  return { name, root: directory, home, marker, plan: {
    clientType: 'claude_code', mode: 'desktop', application, executable,
    directory: config, desktopDirectory: desktop, workingDirectory: workspace,
    nonce: marker, args: [], launchEnvironment: { HOME: home, CFFIXED_USER_HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: join(home, 'tmp') },
  } }
}

async function descendantPids(pid: number): Promise<number[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  const rows = stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2)
  const owned = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of rows) if (owned.has(parent) && !owned.has(child)) { owned.add(child); changed = true }
  }
  return [...owned]
}

async function lsof(args: string[]): Promise<string> {
  try {
    return (await exec('/usr/sbin/lsof', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  } catch (error) {
    const result = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string }
    // Chromium startup workers can exit between ps and lsof. Exit 1 can still
    // carry a valid partial snapshot; ownership is checked again by the caller.
    if (result.code === 1) return result.stdout ?? ''
    throw new Error(`Unable to inspect owned Desktop files (code=${result.code ?? 'unknown'}, signal=${result.signal ?? 'none'}, timeout=${Boolean(result.killed)})`)
  }
}

async function openedFiles(runtime: MacDesktopRuntime, own: Fixture, other: Fixture): Promise<FilesEvidence> {
  const child = await runtime.find(own.plan)
  assert.ok(child, `Instance ${own.name} must still be owned by its nonce`)
  const pids = await descendantPids(child.pid)
  const stdout = await lsof(['-nP', '-p', pids.join(','), '-Fpn'])
  const current = await runtime.find(own.plan)
  assert.deepEqual(current, child, `Instance ${own.name} changed while inspecting its files`)
  const paths = [...new Set(stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1).replace(/ \(deleted\)$/, '')))]
  const realHome = userInfo().homedir
  const realStores = [
    join(realHome, 'Library/Application Support/Claude'), join(realHome, 'Library/Application Support/Claude-3p'),
    join(realHome, 'Library/Logs/Claude'), join(realHome, 'Library/Caches/com.anthropic.claudefordesktop'),
    join(realHome, '.claude'), join(realHome, '.claude.json'),
  ]
  const unexpected = paths.filter(path => within(other.root, path) || realStores.some(root => within(root, path)))
  assert.equal(unexpected.length, 0, `Instance ${own.name} opened another instance or the real Claude store`)
  const profilePaths = paths.filter(path => within(own.plan.desktopDirectory, path)).map(path => relative(own.root, path))
  const logPaths = paths.filter(path => within(join(own.home, 'Library/Logs'), path)).map(path => relative(own.root, path))
  return { pid: child.pid, processCount: pids.length, profileFiles: profilePaths.length, logFiles: logPaths.length, profilePaths, logPaths, unexpectedPaths: [] }
}

async function filesReady(runtime: MacDesktopRuntime, own: Fixture, other: Fixture): Promise<FilesEvidence> {
  return waitFor(`instance ${own.name} profile and log handles`, async () => {
    const files = await openedFiles(runtime, own, other)
    return files.profileFiles > 0 && files.logFiles > 0 ? files : undefined
  })
}

function cookieDatabase(value: Fixture): string | undefined {
  return [join(value.plan.desktopDirectory, 'Cookies'), join(value.plan.desktopDirectory, 'Network', 'Cookies')].find(existsSync)
}

async function snapshot(value: Fixture): Promise<Snapshot> {
  return waitFor(`instance ${value.name} persistent profile`, async () => {
    const idPath = join(value.plan.desktopDirectory, 'ant-did'), configPath = join(value.plan.desktopDirectory, 'config.json')
    const database = cookieDatabase(value)
    if (!existsSync(idPath) || !existsSync(configPath) || !database) return
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { amlSmokeMarker?: string }
      assert.equal(config.amlSmokeMarker, value.marker, `Instance ${value.name} must retain its own synthetic config marker`)
      return { deviceIdHash: digest(readFileSync(idPath)), configMarker: config.amlSmokeMarker, cookieDatabase: relative(value.root, database) }
    } catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
  })
}

async function sqlite<T>(path: string, statement: string, readOnly = true): Promise<T[]> {
  const { stdout } = await exec('/usr/bin/sqlite3', [...(readOnly ? ['-readonly'] : []), '-json', path, statement], { timeout: 5000, maxBuffer: 256 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) as T[] : []
}

async function seedSyntheticCookie(value: Fixture, name: string): Promise<void> {
  const path = cookieDatabase(value)
  assert.ok(path, 'The blank profile must have its own Chromium cookie store')
  const columns = await sqlite<{ name: string; dflt_value: string | null; notnull: number }>(path, 'PRAGMA table_info(cookies)')
  assert.ok(columns.length > 0, 'The installed Desktop cookie schema must be inspectable')
  const now = (Date.now() + 11_644_473_600_000) * 1000
  const known: Record<string, string> = {
    creation_utc: String(now), host_key: sqlValue('aml-smoke.invalid'), top_frame_site_key: "''",
    name: sqlValue(name), value: sqlValue(value.marker), encrypted_value: "X''", path: "'/'",
    expires_utc: String(now + 86_400_000_000), is_secure: '0', is_httponly: '0', last_access_utc: String(now),
    has_expires: '1', is_persistent: '1', priority: '1', samesite: '-1', source_scheme: '1', source_port: '80',
    last_update_utc: String(now), source_type: '1', has_cross_site_ancestor: '0',
  }
  const values = columns.map(column => {
    assert.match(column.name, /^[a-z_]+$/, 'Unexpected cookie column identifier')
    if (Object.hasOwn(known, column.name)) return known[column.name]
    if (column.dflt_value !== null) return column.dflt_value
    if (!column.notnull) return 'NULL'
    throw new Error(`The installed cookie schema has an unhandled required column: ${column.name}`)
  })
  await sqlite(path, `INSERT INTO cookies (${columns.map(column => column.name).join(',')}) VALUES (${values.join(',')})`, false)
}

async function syntheticCookieCount(value: Fixture, name: string): Promise<number> {
  const path = cookieDatabase(value)
  assert.ok(path)
  const rows = await sqlite<{ count: number }>(path, `SELECT count(*) AS count FROM cookies WHERE host_key='aml-smoke.invalid' AND name=${sqlValue(name)}`)
  return rows[0]?.count ?? 0
}

async function windowScreenshot(pid: number, output: string): Promise<'captured' | 'unavailable'> {
  // CoreGraphics discovery filters by the exact owned PID before exporting a
  // window ID. Screen-wide capture and unrelated window titles are never used.
  try {
    const script = 'ObjC.import("CoreGraphics"); function run(argv) { const pid=Number(argv[0]); const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))); const owned=windows.filter(w=>w.kCGWindowOwnerPID===pid&&w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>200&&w.kCGWindowBounds.Height>150); return JSON.stringify(owned.map(w=>w.kCGWindowNumber)); }'
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(pid)], { timeout: 5000, maxBuffer: 4096 })
    const windows = JSON.parse(stdout) as number[]
    if (!Number.isInteger(windows[0]) || windows[0] <= 0) return 'unavailable'
    await exec('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windows[0]), output], { timeout: 10_000, maxBuffer: 4096 })
    if (!existsSync(output) || lstatSync(output).size === 0) return 'unavailable'
    chmodSync(output, 0o600)
    return 'captured'
  } catch { return 'unavailable' }
}

function assertNoKeychainFailure(value: Fixture): void {
  const path = join(value.home, 'Library', 'Logs', 'Claude', 'main.log')
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  assert.ok(!/safeStorage unavailable on macOS at startup|default keychain could not be found/i.test(content), 'The disposable Desktop profile reported an unavailable system Keychain')
}

function mainLog(value: Fixture): string {
  const path = join(value.home, 'Library', 'Logs', 'Claude', 'main.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

async function networkEvidence(value: Fixture, runtime: MacDesktopRuntime): Promise<{ nativePin: true; connectedToOwnRelay: true }> {
  const route = value.plan.networkRoute
  assert.ok(route?.mode === 'proxy')
  await waitFor(`instance ${value.name} native egress pin`, async () => {
    assertNoKeychainFailure(value)
    return mainLog(value).split('\n').some(line => line.includes('[egress-proxy] pinned to fixed proxy at') && line.includes(new URL(route.url).host)) ? true : undefined
  })
  await waitFor(`instance ${value.name} connection to its own relay`, async () => {
    const process = await runtime.find(value.plan)
    assert.ok(process)
    const pids = await descendantPids(process.pid)
    const stdout = await lsof(['-nP', '-a', '-p', pids.join(','), '-iTCP:' + new URL(route.url).port, '-sTCP:ESTABLISHED', '-Fpn'])
    return stdout.split('\n').some(line => line.startsWith('n') && line.includes('->127.0.0.1:' + new URL(route.url).port)) ? true : undefined
  })
  return { nativePin: true, connectedToOwnRelay: true }
}

async function callbackEvidence(a: Fixture, b: Fixture, runtime: MacDesktopRuntime): Promise<{ targetReceivedAndIgnored: true; otherInstanceReceived: false; upstreamLogin: 'not_performed' }> {
  const ignored = 'Google sign-in code does not answer a sign-in this app started; ignoring'
  const count = (value: Fixture) => mainLog(value).split(ignored).length - 1
  const beforeA = count(a), beforeB = count(b), process = await runtime.find(a.plan)
  assert.ok(process)
  // A blank profile has no pending native sign-in. Its own nonce check rejects
  // this synthetic callback before renderer delivery or token exchange.
  await sendClaudeDesktopLoginUrl(process.pid, 'claude://login/google-auth?code=aml-isolation-probe-' + randomUUID() + '&hop_nonce=invalid-aml-isolation-probe')
  await waitFor('the targeted instance to reject its synthetic callback', async () => count(a) === beforeA + 1 ? true : undefined)
  await delay(1000)
  assert.equal(count(b), beforeB, 'The other Desktop instance must not receive the callback')
  assert.deepEqual(await runtime.find(a.plan), process, 'The callback target must remain the same owned process')
  return { targetReceivedAndIgnored: true, otherInstanceReceived: false, upstreamLogin: 'not_performed' }
}

async function holdFixture(seconds: number, signal: AbortSignal, fixtures: Fixture[]): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    for (const value of fixtures) assertNoKeychainFailure(value)
    await delay(Math.min(1000, deadline - Date.now()), undefined, { signal })
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('This acceptance suite requires macOS')
  const requestedApplication = argument('--application') ?? '/Applications/Claude.app'
  const application = detectClaudeCodeDesktopApplications({ platform: 'darwin', roots: [requestedApplication] })[0]
  assert.ok(application, 'No supported installed Claude Desktop bundle was found')
  const evidenceArgument = argument('--evidence-dir')
  const singleInstance = process.argv.includes('--single-instance')
  const testCallback = process.argv.includes('--test-callback'), proxy = upstreamProxy()
  assert.ok(!testCallback || !singleInstance, 'Callback isolation requires two blank instances')
  assert.ok(proxy || singleInstance, 'Two-instance acceptance requires CML_CLAUDE_DESKTOP_PROXY or --upstream-proxy-file')
  const holdSeconds = Number(argument('--hold-seconds') ?? '0')
  if (!Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 120) throw new Error('--hold-seconds must be an integer between 0 and 120')
  if (evidenceArgument && !isAbsolute(evidenceArgument)) throw new Error('--evidence-dir must be an absolute path')
  const evidence = evidenceArgument ? resolve(evidenceArgument) : realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-desktop-evidence-')))
  mkdirSync(evidence, { recursive: true, mode: 0o700 }); chmodSync(evidence, 0o700)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-desktop-smoke-')))
  chmodSync(root, 0o700)
  const a = fixture(root, 'A', application.path, application.executable), b = fixture(root, 'B', application.path, application.executable)
  const runtime = new MacDesktopRuntime(), controller = new AbortController()
  const leases: NativeProxyLease[] = []
  const report: Record<string, unknown> = {
    application: 'Claude Desktop', version: application.version, localProfileIsolation: 'pending',
    login: { upstreamLogin: 'not_performed', credentialsCopied: false, modelRequests: 0,
      boundary: 'Unauthenticated fresh profiles only; upstream login is not asserted. Optional synthetic callback evidence checks exact-PID delivery and rejection without a pending login; it does not complete authentication.' },
  }
  let failure: unknown
  const onInterrupt = () => controller.abort()
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt)
  try {
    if (proxy) {
      const helper = resolve('resources/bin/codex-proxy')
      assert.ok(existsSync(helper), 'Run npm run build:proxy before managed network acceptance')
      const bridge = new NativeProxy(helper)
      for (const value of singleInstance ? [a] : [a, b]) {
        const lease = await bridge.acquire(proxy, value.marker, controller.signal)
        leases.push(lease)
        value.plan.networkRoute = { mode: 'proxy', url: lease.url }
      }
    }
    console.log(`Claude Desktop ${application.version ?? 'unknown'}: opening ${singleInstance ? 'one blank private profile' : 'two blank private profiles'}`)
    const firstA = await runtime.launch(a.plan, controller.signal)
    if (singleInstance) {
      const files = await filesReady(runtime, a, b)
      await runtime.focus(a.plan)
      const screenshot = await waitFor('the owned single-instance window', async () => {
        assertNoKeychainFailure(a)
        return await windowScreenshot(firstA.pid, join(evidence, 'instance-a.png')) === 'captured' ? 'captured' : undefined
      }, 30_000)
      console.log(`Owned blank profile PID: A=${firstA.pid}; holding ${holdSeconds}s for optional directed-window inspection`)
      await holdFixture(holdSeconds || 5, controller.signal, [a])
      await windowScreenshot(firstA.pid, join(evidence, 'instance-a.png'))
      assertNoKeychainFailure(a)
      report.single = { process: firstA, files, screenshot, missingKeychainFailureObserved: false, safeStorageStartupFailureObserved: false }
      if (proxy) report.network = { a: await networkEvidence(a, runtime) }
      report.localProfileIsolation = 'single_instance_passed'
    } else {
      const firstB = await runtime.launch(b.plan, controller.signal)
      assert.notEqual(firstA.pid, firstB.pid, 'Concurrent profiles must use independent main processes')
      const [filesA, filesB] = await Promise.all([filesReady(runtime, a, b), filesReady(runtime, b, a)])
      report.network = { a: await networkEvidence(a, runtime), b: await networkEvidence(b, runtime) }
      // Profile handles become available before the hosted login page renders.
      // Give that page time to settle; screenshots remain evidence for manual
      // review and never imply that upstream service access or login succeeded.
      await delay(5000, undefined, { signal: controller.signal })
      await runtime.focus(a.plan)
      await delay(1000, undefined, { signal: controller.signal })
      const screenshotA = await windowScreenshot(firstA.pid, join(evidence, 'instance-a.png'))
      await runtime.focus(b.plan)
      await delay(1000, undefined, { signal: controller.signal })
      const screenshotB = await windowScreenshot(firstB.pid, join(evidence, 'instance-b.png'))
      report.initial = { a: { process: firstA, files: filesA, screenshot: screenshotA }, b: { process: firstB, files: filesB, screenshot: screenshotB } }
      if (testCallback) report.callback = await callbackEvidence(a, b, runtime)
      if (holdSeconds > 0) {
        console.log(`Owned blank profile PIDs: A=${firstA.pid}, B=${firstB.pid}; holding ${holdSeconds}s for optional directed-window inspection`)
        await holdFixture(holdSeconds, controller.signal, [a, b])
      }
      const [stateA, stateB] = await Promise.all([snapshot(a), snapshot(b)])
      assert.notEqual(stateA.deviceIdHash, stateB.deviceIdHash, 'Blank profiles must not share a device ID')
      controller.signal.throwIfAborted()
      await runtime.stop(a.plan)
      assert.equal(await runtime.find(a.plan), undefined, 'Stopping A must remove only A')
      assert.deepEqual(await runtime.find(b.plan), firstB, 'Stopping A must leave B alive')
      const recovered = new MacDesktopRuntime()
      assert.deepEqual(await recovered.find(b.plan), firstB, 'A new manager runtime must recover B from ownership evidence')
      await recovered.focus(b.plan)
      const cookieName = `aml_smoke_${randomUUID().replaceAll('-', '')}`
      await seedSyntheticCookie(a, cookieName)
      assert.equal(await syntheticCookieCount(a, cookieName), 1)
      assert.equal(await syntheticCookieCount(b, cookieName), 0)
      console.log('Independent processes, profile/log handles, focus and manager recovery passed; checking restart persistence')
      const secondA = await recovered.launch(a.plan, controller.signal)
      assert.notEqual(secondA.pid, firstA.pid, 'Restart must create a new A process')
      assert.notEqual(secondA.pid, firstB.pid, 'Restarted A must remain distinct from B')
      const [restartedFiles, restartedA, retainedB] = await Promise.all([filesReady(recovered, a, b), snapshot(a), snapshot(b)])
      await networkEvidence(a, recovered)
      assert.deepEqual(restartedA, stateA, 'Restarted A must retain its own device, config and cookie store')
      assert.deepEqual(retainedB, stateB, 'Restarting A must preserve B state')
      await delay(1000)
      assert.equal(await syntheticCookieCount(a, cookieName), 1, 'A must retain its synthetic non-authentication cookie after restart')
      assert.equal(await syntheticCookieCount(b, cookieName), 0, 'B must never receive A cookies')
      assert.deepEqual(await recovered.find(b.plan), firstB, 'B must survive A restart')
      await openedFiles(recovered, b, a)
      report.restart = { a: secondA, files: restartedFiles, bRetained: true, deviceIdRetained: true, configMarkerRetained: true, syntheticCookieRetained: true, crossInstanceCookies: 0 }
      assertNoKeychainFailure(a); assertNoKeychainFailure(b)
      report.localProfileIsolation = 'passed'
    }
  } catch (error) {
    failure = error
    report.localProfileIsolation = 'failed'
    report.failure = error instanceof Error ? error.message : 'Unexpected acceptance failure'
    report.persistenceFiles = [a, b].map(value => ({ instance: value.name, files: ['ant-did', 'config.json', 'Cookies', 'Network/Cookies'].map(path => ({ path, exists: existsSync(join(value.plan.desktopDirectory, path)) })) }))
  } finally {
    // Private diagnostic logs belong only to these disposable blank profiles;
    // no actual login or existing client data is used by this acceptance test.
    for (const value of [a, b]) {
      const content = mainLog(value)
      if (content) writeFileSync(join(evidence, `instance-${value.name.toLowerCase()}-startup.log`), content, { mode: 0o600 })
      if (failure) {
        const process = await runtime.find(value.plan)
        if (process) await windowScreenshot(process.pid, join(evidence, `failure-instance-${value.name.toLowerCase()}.png`))
      }
    }
    report.logChecks = [a, b].map(value => {
      const content = mainLog(value), route = value.plan.networkRoute
      return { instance: value.name, logCreated: content.length > 0,
        keychainFailureObserved: /safeStorage unavailable on macOS at startup|default keychain could not be found/i.test(content),
        ownNativeProxyPinObserved: route?.mode === 'proxy' && content.split('\n').some(line => line.includes('[egress-proxy] pinned to fixed proxy at') && line.includes(new URL(route.url).host)),
        ignoredSyntheticCallbacks: content.split('Google sign-in code does not answer a sign-in this app started; ignoring').length - 1 }
    })
    const cleanup = new MacDesktopRuntime()
    const results = await Promise.allSettled([cleanup.stop(a.plan), cleanup.stop(b.plan)])
    const remaining: DesktopProcess[] = []
    for (const value of [a, b]) {
      const process = await cleanup.find(value.plan)
      if (process) remaining.push(process)
    }
    report.cleanup = { ownedProcessesRemaining: remaining.length, errors: results.filter(result => result.status === 'rejected').length }
    const relayCleanup = await Promise.allSettled(leases.map(lease => lease.stop()))
    const relayFailures = relayCleanup.filter(result => result.status === 'rejected').length
    report.relayCleanup = { relaysStopped: leases.filter(lease => !lease.alive()).length, errors: relayFailures }
    if (relayFailures) failure ??= new Error('A disposable network relay could not be stopped')
    if (remaining.length === 0) rmSync(root, { recursive: true, force: true })
    else { failure ??= new Error('An owned smoke process is still running; its private profile was retained'); report.retainedProfileRoot = root }
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt)
  }
  if (failure) throw failure
  console.log(`Claude Desktop smoke passed: ${singleInstance ? 'one isolated window; no system Keychain startup failure observed' : 'two isolated profiles; stop/recovery/restart verified'}. Upstream login was not performed. Evidence: ${evidence}`)
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Claude Desktop acceptance failed'); process.exitCode = 1 })
