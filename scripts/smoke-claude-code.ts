import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { captureClaudeExecutableIdentity, validateClaudeExecutableIdentity } from '../src/main/claudeCodeCapability'
import { claudeCodeEnvironment, detectClaudeCodeApplications, projectClaudeCodeConfig } from '../src/main/claudeCodeInstanceAdapter'
import { inspectClaudeCodeSessions, probeClaudeCodeCliCapabilities, probeClaudeCodeCliVersion, probeClaudeCodeLoginStatus } from '../src/main/claudeCodeVerification'
import { scanClaudeCodeSessions, readClaudeSessionContent, previewClaudeSessionResume } from '../src/main/claudeCodeSessions'

// A real native CLI acceptance test. All credentials, conversations, project
// files and responses are synthetic. macOS blocks external network traffic
// for every child in addition to the loopback-only mock Messages endpoint.
// It deliberately does not validate subscription login, token refresh or
// Desktop's Keychain/profile boundaries.
const execFileAsync = promisify(execFile)
const isolationArgs = ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
const printArgs = ['--print', '--output-format', 'json', '--tools', '', ...isolationArgs]
const modes = ['api_key', 'bearer'] as const
type Mode = typeof modes[number]
interface CliResult { code: number | null; stdout: string; stderr: string }
interface CapturedRequest { mode: Mode; model: string; text: string; apiKey: boolean; bearer: boolean }

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function fileMetadata(path: string): unknown {
  try {
    const value = lstatSync(path)
    return { device: value.dev, inode: value.ino, mode: value.mode, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function defaultStateMetadata(): unknown[] {
  // Metadata only: never read the user's real credentials or conversations.
  return ['.claude.json', '.claude/settings.json', '.claude/.credentials.json', '.claude/projects', '.config/anthropic/active_config'].map(path => fileMetadata(join(homedir(), path)))
}

function streamMessage(response: ServerResponse, request: CapturedRequest): void {
  const message = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const events: [string, Record<string, unknown>][] = [
    ['message_start', { message }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: `fixture-response-${request.mode}` } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', {}],
  ]
  for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  response.end()
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('This acceptance suite currently verifies the macOS native CLI only')
  const requestedExecutable = argument('--executable')
  const executable = requestedExecutable ? realpathSync(resolve(requestedExecutable)) : detectClaudeCodeApplications()[0]?.path
  if (!executable) throw new Error('No installed Claude Code CLI was found; pass --executable with its path')
  const identity = captureClaudeExecutableIdentity(executable)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-code-smoke-')))
  const requestedEvidence = argument('--evidence-dir')
  if (requestedEvidence && !isAbsolute(requestedEvidence)) throw new Error('--evidence-dir must be an absolute path')
  const evidence = requestedEvidence ? resolve(requestedEvidence) : join(root, 'evidence')
  mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const homeDirectory = join(root, 'home'), project = join(root, 'project'), secondProject = join(root, 'second-project')
  mkdirSync(homeDirectory, { mode: 0o700 }); mkdirSync(join(project, '.claude'), { recursive: true, mode: 0o700 }); mkdirSync(secondProject, { mode: 0o700 })
  const defaultStateBefore = defaultStateMetadata()
  const projectHookMarker = join(root, 'project-hook-ran'), projectMcpMarker = join(root, 'project-mcp-ran')
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const projectSettings = JSON.stringify({
    model: 'project-model-must-not-apply', env: { ANTHROPIC_API_KEY: 'project-key-must-not-apply' },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `/usr/bin/touch ${shellQuote(projectHookMarker)}` }] }] },
  })
  writeFileSync(join(project, '.claude', 'settings.json'), projectSettings, { mode: 0o600 })
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { isolatedSmoke: { command: '/usr/bin/touch', args: [projectMcpMarker] } } }), { mode: 0o600 })

  const requests: CapturedRequest[] = [], children = new Set<ChildProcess>()
  const activeModes = new Map<Mode, ChildProcess>()
  const firstResponses = new Map<Mode, { response: ServerResponse; request: CapturedRequest }>()
  let ownershipVerified = false, serverFailure: unknown
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(403).end(); return }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 4 * 1024 * 1024) throw new Error('Mock request body exceeded its limit')
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; messages?: unknown; stream?: boolean }
      const apiKey = request.headers['x-api-key'], bearer = request.headers.authorization
      const mode: Mode | undefined = apiKey === 'sk-ant-api03-smoke-instance-a' && !bearer ? 'api_key' : bearer === 'Bearer smoke-instance-b' && !apiKey ? 'bearer' : undefined
      if (!mode) throw new Error('A request used unexpected or mixed authentication sources')
      if (request.url.includes('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}'); return }
      assert.equal(body.stream, true, 'The real CLI must exercise Messages streaming')
      const captured = { mode, model: body.model ?? '', text: JSON.stringify(body.messages ?? []), apiKey: Boolean(apiKey), bearer: Boolean(bearer) }
      requests.push(captured)
      if (!ownershipVerified) {
        firstResponses.set(mode, { response, request: captured })
        if (firstResponses.size < 2) return
        // Both independent CLIs are alive and waiting for their own response.
        for (const selectedMode of modes) {
          const pid = activeModes.get(selectedMode)?.pid
          assert.ok(pid)
          const [command, textFiles] = await Promise.all([
            execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command=']),
            execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']),
          ])
          assert.ok(command.stdout.includes(`--cml-instance=claude-smoke-${selectedMode}`), 'Managed CLI ownership marker was lost')
          assert.ok(textFiles.stdout.split('\n').includes(`n${identity.path}`), 'The owned process is not the selected native binary')
        }
        ownershipVerified = true
        for (const item of firstResponses.values()) streamMessage(item.response, item.request)
        firstResponses.clear()
      } else streamMessage(response, captured)
    } catch (error) {
      serverFailure = error
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  server.on('connect', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const sandboxProfile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))'
  const commonEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', HOME: homeDirectory, SHELL: '/bin/bash',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: baseUrl, HTTPS_PROXY: baseUrl, ALL_PROXY: baseUrl, NO_PROXY: '127.0.0.1,localhost',
  }
  const projections = Object.fromEntries(modes.map(mode => [mode, projectClaudeCodeConfig({ instanceHome: join(root, mode), baseUrl, ...(mode === 'api_key' ? { apiKey: 'sk-ant-api03-smoke-instance-a' } : { authToken: 'smoke-instance-b' }) })])) as Record<Mode, ReturnType<typeof projectClaudeCodeConfig>>
  for (const mode of modes) {
    mkdirSync(projections[mode].paths.configDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(projections[mode].paths.settingsFile, JSON.stringify({ model: mode === 'api_key' ? 'claude-sonnet-4-5' : 'claude-haiku-4-5' }), { mode: 0o600 })
  }
  const environments = Object.fromEntries(modes.map(mode => [mode, claudeCodeEnvironment(commonEnvironment, projections[mode])])) as Record<Mode, NodeJS.ProcessEnv>
  const run = (mode: Mode, args: string[], environment = environments[mode], workingDirectory = project): Promise<CliResult> => new Promise((resolveRun, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile, '/bin/bash', '-c', 'exec -a "$1" "$2" "${@:3}"', 'bash', `--cml-instance=claude-smoke-${mode}`, executable, ...args], { cwd: workingDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child); activeModes.set(mode, child)
    let stdout = '', stderr = '', finished = false
    const timeout = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Claude Code smoke process timed out')) }, 30_000)
    const finish = (error?: Error, code?: number | null) => {
      if (finished) return
      finished = true; clearTimeout(timeout); children.delete(child)
      if (error) reject(error); else resolveRun({ code: code ?? null, stdout, stderr })
    }
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Claude Code smoke output exceeded its limit')) }
    }
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk))
    child.once('error', error => finish(error)); child.once('close', code => finish(undefined, code))
  })
  const hashSettings = (mode: Mode) => createHash('sha256').update(readFileSync(projections[mode].paths.settingsFile)).digest('hex')
  const settingsBefore = modes.map(hashSettings)
  try {
    const version = await probeClaudeCodeCliVersion(executable, { runner: async () => (await run('api_key', ['--version'])).stdout })
    const capabilities = await probeClaudeCodeCliCapabilities(executable, { runner: async () => (await run('api_key', ['--help'])).stdout })
    assert.equal(version.state, 'verified'); assert.equal(capabilities.state, 'verified')
    const login = []
    for (const mode of modes) {
      const status = await probeClaudeCodeLoginStatus(executable, projections[mode].paths.configDirectory, { environment: environments[mode], runner: async () => (await run(mode, ['auth', 'status', '--json'])).stdout })
      assert.equal(status.state, 'verified'); assert.equal(status.authenticated, true); assert.equal(status.method, mode)
      login.push({ mode, status })
    }
    const unsignedEnvironment = { ...environments.api_key }; delete unsignedEnvironment.ANTHROPIC_API_KEY
    const unsigned = await run('api_key', ['auth', 'status', '--json'], unsignedEnvironment)
    assert.equal(unsigned.code, 1); assert.equal(JSON.parse(unsigned.stdout).loggedIn, false)
    const sessionIds = { api_key: randomUUID(), bearer: randomUUID() }
    const initial = await Promise.all(modes.map(mode => run(mode, [...printArgs, '--session-id', sessionIds[mode], `fixture-prompt-${mode}`])))
    if (serverFailure) throw serverFailure
    initial.forEach((result, index) => {
      assert.equal(result.code, 0, `Initial ${modes[index]} run failed`)
      const parsed = JSON.parse(result.stdout)
      assert.equal(parsed.session_id, sessionIds[modes[index]])
      assert.equal(parsed.result, `fixture-response-${modes[index]}`)
    })
    assert.equal(ownershipVerified, true)
    for (const mode of modes) {
      const request = requests.find(item => item.mode === mode)
      assert.equal(request?.model, mode === 'api_key' ? 'claude-sonnet-4-5' : 'claude-haiku-4-5')
      const sessions = inspectClaudeCodeSessions(projections[mode].paths.configDirectory)
      assert.equal(sessions.state, 'verified'); assert.deepEqual(sessions.duplicateIds, [])
      assert.ok(sessions.files.some(file => file.sessionId === sessionIds[mode]))
      assert.ok(sessions.files.every(file => file.sessionId !== sessionIds[mode === 'api_key' ? 'bearer' : 'api_key']))
      assert.ok(existsSync(join(projections[mode].paths.configDirectory, '.claude.json')))
    }
    const instanceId=randomUUID(),configDirectory=projections.api_key.paths.configDirectory
    const nativeScan=scanClaudeCodeSessions(configDirectory,{instanceId})
    const nativeRecord=nativeScan.records.find(record=>record.id===sessionIds.api_key)!
    assert.ok(nativeRecord);assert.equal(nativeRecord.conflict,false)
    const nativeLocation=nativeRecord.locations[0],content=readClaudeSessionContent(nativeLocation,{page:1,pageSize:40})
    assert.ok(content.messages.some(message=>message.role==='user'&&message.blocks.some(block=>block.text.includes('fixture-prompt-api_key'))))
    assert.ok(content.messages.some(message=>message.role==='assistant'&&message.blocks.some(block=>block.text.includes('fixture-response-api_key'))))
    const scopedResume=previewClaudeSessionResume(nativeScan,{instanceId,configDirectory,cwd:project,sessionId:nativeRecord.id,sourceId:nativeLocation.sourceId})
    assert.equal(scopedResume.cwd,project)
    const resumed = await run('api_key', [...printArgs, ...scopedResume.args, 'fixture-follow-up-api_key'])
    assert.equal(resumed.code, 0); assert.equal(JSON.parse(resumed.stdout).session_id, sessionIds.api_key)
    const replay = requests.at(-1)
    assert.ok(replay)
    assert.ok(replay.text.includes('fixture-prompt-api_key') && replay.text.includes('fixture-response-api_key') && replay.text.includes('fixture-follow-up-api_key'))
    assert.ok(!replay.text.includes('fixture-prompt-bearer'))
    // Resume the same synthetic session from a second recorded project cwd.
    // sandbox-exec still blocks all external traffic and allows only the mock.
    const secondDirectoryResume = await run('api_key', [...printArgs, '--resume', sessionIds.api_key, 'fixture-follow-up-second-project'], environments.api_key, secondProject)
    assert.equal(secondDirectoryResume.code, 0)
    assert.equal(JSON.parse(secondDirectoryResume.stdout).session_id, sessionIds.api_key)
    const secondDirectoryRequest = requests.at(-1)
    assert.ok(secondDirectoryRequest)
    assert.ok(secondDirectoryRequest.text.includes('fixture-prompt-api_key') && secondDirectoryRequest.text.includes('fixture-response-api_key') && secondDirectoryRequest.text.includes('fixture-follow-up-second-project'))
    const afterSecondDirectoryResume=scanClaudeCodeSessions(configDirectory,{instanceId})
    const afterSecondRecord=afterSecondDirectoryResume.records.find(record=>record.id===sessionIds.api_key)!
    assert.ok(afterSecondRecord.locations[0].cwdCandidates?.includes(project))
    assert.ok(afterSecondRecord.locations[0].cwdCandidates?.includes(secondProject))
    const requestCount = requests.length
    const crossResume = await run('bearer', [...printArgs, '--resume', sessionIds.api_key, 'fixture-cross-instance-must-not-run'])
    assert.equal(crossResume.code, 1); assert.match(crossResume.stderr, /No conversation found/)
    assert.equal(requests.length, requestCount)
    assert.deepEqual(modes.map(hashSettings), settingsBefore)
    assert.equal(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'), projectSettings)
    assert.equal(existsSync(projectHookMarker), false); assert.equal(existsSync(projectMcpMarker), false)
    assert.equal(existsSync(join(homeDirectory, '.claude.json')), false)
    assert.equal(existsSync(join(homeDirectory, '.claude')), false)
    assert.deepEqual(defaultStateMetadata(), defaultStateBefore)
    validateClaudeExecutableIdentity(identity)
    const report = {
      result: 'passed', version: version.version, executableSha256: identity.sha256, executableSize: identity.size,
      platform: process.platform, architecture: process.arch, checkedAt: new Date().toISOString(),
      login, capabilityFlags: capabilities.flags,
      checks: ['two-concurrent-native-processes', 'api-key-header', 'bearer-header', 'per-instance-user-settings', 'per-instance-global-state', 'project-env-and-hooks-excluded', 'project-mcp-excluded', 'transcripts-isolated', 'same-instance-resume', 'same-session-resume-from-second-recorded-cwd', 'cross-instance-resume-rejected-before-request', 'argv0-and-native-binary-ownership', 'default-store-metadata-unchanged', 'external-network-denied-by-os'],
      messagesRequests: requests.length, upstreamRequests: 0,
      notVerified: ['subscription-browser-login', 'subscription-refresh-and-revocation', 'cloud-provider-and-federation-login', 'desktop-profile-cookie-keychain-and-session-isolation'],
    }
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ result: report.result, version: report.version, checks: report.checks, evidence: join(evidence, 'report.json') }, null, 2))
  } finally {
    for (const child of children) child.kill('SIGKILL')
    for (const item of firstResponses.values()) item.response.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    if (requestedEvidence) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch(() => { console.error('Claude Code isolation smoke failed; no credential values or raw CLI output were logged.'); process.exitCode = 1 })
