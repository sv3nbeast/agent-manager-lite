import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { captureClaudeExecutableIdentity, validateClaudeExecutableIdentity } from '../src/main/claudeCodeCapability'
import { claudeCodeEnvironment, detectClaudeCodeApplications } from '../src/main/claudeCodeInstanceAdapter'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { prepareClaudeSubscriptionCredentials, releaseClaudeSubscriptionCredentials, updateClaudeSubscriptionCredentials } from '../src/main/claudeCodeSubscription'

// Native-client acceptance using synthetic subscription material and a local
// mock. sandbox-exec denies all non-loopback networking, including telemetry.
// This verifies credential selection/rotation, not a real paid subscription.
const exec = promisify(execFile)
const sandbox = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))'
const isolation = ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
const firstToken = 'sk-ant-oat01-synthetic-subscription-a', nextToken = 'sk-ant-oat01-synthetic-subscription-rotated', peerToken = 'sk-ant-oat01-synthetic-subscription-b'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
function fileMetadata(path: string): unknown {
  try { const stat = lstatSync(path); return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs] }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function defaultMetadata(): unknown[] {
  return ['.claude.json', '.claude/settings.json', '.claude/.credentials.json', '.claude/projects', '.config/anthropic/active_config'].map(path => fileMetadata(join(homedir(), path)))
}
function message(response: ServerResponse, model: string, answer: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events: [string, Record<string, unknown>][] = [
    ['message_start', { message: { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } }],
    ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }], ['message_stop', {}],
  ]
  for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  response.end()
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Native subscription acceptance currently supports macOS')
  const selected = option('--executable'), executable = selected ? realpathSync(resolve(selected)) : detectClaudeCodeApplications()[0]?.path
  if (!executable) throw new Error('No native Claude CLI was found')
  const identity = captureClaudeExecutableIdentity(executable), before = defaultMetadata()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-subscription-smoke-')))
  const home = join(root, 'shell-home'), project = join(root, 'project')
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 }); mkdirSync(project, { mode: 0o700 })
  // A hostile shell/default config must not win over the chosen instance.
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'foreign-default-token', scopes: ['user:inference'], expiresAt: Date.now() + 3600_000 } }), { mode: 0o600 })
  const accounts = [firstToken, peerToken].map(accessToken => {
    const account = parseClaudeCodeAccountImport(JSON.stringify({ accessToken, refreshToken: 'synthetic-refresh-never-projected', expiresAt: Date.now() + 3600_000, scopes: ['user:inference', 'user:profile'] })).accounts[0]
    account.plan = 'pro'; return account
  })
  const plans = accounts.map((_account, index) => ({ directory: join(root, `instance-${index}`), nonce: `subscription-smoke-${index}` }))
  for (let index = 0; index < plans.length; index++) {
    mkdirSync(plans[index].directory, { mode: 0o700 })
    writeFileSync(join(plans[index].directory, '.claude.json'), '{"hasCompletedOnboarding":true}', { mode: 0o600 })
    prepareClaudeSubscriptionCredentials(plans[index], accounts[index])
    assert.equal(readFileSync(join(plans[index].directory, '.credentials.json'), 'utf8').includes('synthetic-refresh-never-projected'), false)
  }
  let failure: unknown
  const requests: { instance: number; rotated: boolean; model: string; oauthBeta: boolean }[] = []
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(403).end(); return }
      let raw = ''
      for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 4 * 1024 * 1024) throw new Error('Mock body exceeded its limit') }
      const token = request.headers.authorization, instance = token === `Bearer ${peerToken}` ? 1 : token === `Bearer ${firstToken}` || token === `Bearer ${nextToken}` ? 0 : -1
      assert.notEqual(instance, -1, 'CLI used another credential source'); assert.equal(request.headers['x-api-key'], undefined)
      if (request.url.includes('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}'); return }
      const body = JSON.parse(raw)
      assert.equal(body.stream, true)
      requests.push({ instance, rotated: token === `Bearer ${nextToken}`, model: body.model, oauthBeta: String(request.headers['anthropic-beta'] ?? '').includes('oauth') })
      message(response, body.model, 'synthetic-subscription-response')
    } catch (error) { failure = error; if (!response.headersSent) response.writeHead(500); response.end() }
  })
  server.on('connection', socket => socket.on('error', () => {}))
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const environments = plans.map(plan => claudeCodeEnvironment({
    PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token-must-not-win', ANTHROPIC_AUTH_TOKEN: 'inherited-bearer-must-not-win',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: baseUrl, HTTPS_PROXY: baseUrl, ALL_PROXY: baseUrl, NO_PROXY: '127.0.0.1,localhost',
  }, { environment: { CLAUDE_CONFIG_DIR: plan.directory, ANTHROPIC_CONFIG_DIR: join(plan.directory, 'anthropic'), ANTHROPIC_BASE_URL: baseUrl } }))
  const children = new Set<ChildProcess>()
  const owned = async (index: number, pid: number) => {
    const [command, files] = await Promise.all([exec('/bin/ps', ['-p', String(pid), '-o', 'command=']), exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'])])
    assert.ok(command.stdout.includes(`--cml-instance=${plans[index].nonce}`))
    assert.ok(files.stdout.split('\n').includes(`n${identity.path}`))
  }
  const start = (index: number) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, '/bin/bash', '-c', 'exec -a "$1" "$2" "${@:3}"', 'bash', `--cml-instance=${plans[index].nonce}`, executable,
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', ...isolation, '--model', 'claude-sonnet-4-5'],
    { cwd: project, env: environments[index], stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let buffer = '', stderr = '', count = 0
    let resolveResult: (() => void) | undefined, rejectResult: ((error: Error) => void) | undefined
    const completion = new Promise<number | null>((resolveExit, reject) => { child.once('close', code => { children.delete(child); resolveExit(code) }); child.once('error', reject) })
    // A pending process rejection is observed immediately, even before close is awaited.
    void completion.catch(error => { failure = error })
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 2 * 1024 * 1024) { failure = new Error('CLI output exceeded its limit'); child.kill('SIGKILL'); return }
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let value: Record<string, unknown>; try { value = JSON.parse(line) } catch { continue }
        if (value.type === 'result') {
          count++
          if (value.is_error) rejectResult?.(new Error('Native Claude rejected the synthetic request'))
          else resolveResult?.()
          resolveResult = undefined; rejectResult = undefined
        }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 128 * 1024) child.kill('SIGKILL') })
    child.stdin!.on('error', error => rejectResult?.(error))
    return { child, completion, count: () => count, ask: () => new Promise<void>((resolveResultCall, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native subscription request timed out')) }, 30_000)
      resolveResult = () => { clearTimeout(timer); resolveResultCall() }; rejectResult = error => { clearTimeout(timer); reject(error) }
      child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: `Synthetic isolation turn ${count + 1}` } }) + '\n')
    }) }
  }
  try {
    const versions = await exec('/usr/bin/sandbox-exec', ['-p', sandbox, executable, '--version'], { env: environments[0], cwd: project, timeout: 15_000 })
    const version = versions.stdout.match(/\d+\.\d+\.\d+/)?.[0]; assert.ok(version)
    for (const env of environments) {
      const result = await exec('/usr/bin/sandbox-exec', ['-p', sandbox, executable, 'auth', 'status', '--json'], { env, cwd: project, timeout: 15_000 })
      const status = JSON.parse(result.stdout)
      assert.equal(status.loggedIn, true); assert.equal(status.authMethod, 'claude.ai'); assert.equal(status.subscriptionType, 'pro')
    }
    const first = start(0), peer = start(1)
    await Promise.all([first.ask(), peer.ask()]); await Promise.all([owned(0, first.child.pid!), owned(1, peer.child.pid!)])
    accounts[0].credentials.accessToken = nextToken
    updateClaudeSubscriptionCredentials(plans[0], accounts[0])
    await first.ask()
    assert.equal(requests.filter(request => request.instance === 0).at(-1)?.rotated, true)
    assert.equal(requests.filter(request => request.instance === 1).every(request => !request.rotated), true)
    first.child.stdin!.end(); assert.equal(await first.completion, 0)
    assert.equal(releaseClaudeSubscriptionCredentials(plans[0]), true); assert.equal(existsSync(join(plans[0].directory, '.credentials.json')), false)
    await peer.ask(); peer.child.stdin!.end(); assert.equal(await peer.completion, 0)
    assert.equal(releaseClaudeSubscriptionCredentials(plans[1]), true)
    let unsigned: string
    try { unsigned = (await exec('/usr/bin/sandbox-exec', ['-p', sandbox, executable, 'auth', 'status', '--json'], { env: environments[0], cwd: project, timeout: 15_000 })).stdout }
    catch (error) { const result = error as { code?: number; stdout?: string }; assert.equal(result.code, 1); assert.ok(result.stdout); unsigned = result.stdout }
    assert.equal(JSON.parse(unsigned).loggedIn, false, 'An exited instance must not fall back to the shell login')
    if (failure) throw failure
    validateClaudeExecutableIdentity(identity); assert.deepEqual(defaultMetadata(), before)
    const report = { status: 'passed', version, nativeBinarySha256: identity.sha256, concurrentInstances: 2, liveRotation: true, refreshTokenStayedInVault: true,
      credentialCleanup: true, defaultStateUnchanged: true, network: 'loopback-only sandbox', requests }
    const evidence = option('--evidence-dir')
    if (evidence) { if (!isAbsolute(evidence)) throw new Error('--evidence-dir must be absolute'); mkdirSync(evidence, { recursive: true, mode: 0o700 }); writeFileSync(join(evidence, 'claude-subscription-native.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } finally {
    for (const child of children) child.kill('SIGKILL')
    server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Native subscription acceptance failed') + '\n'); process.exitCode = 1 })
