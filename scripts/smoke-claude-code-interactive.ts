import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureClaudeExecutableIdentity, validateClaudeExecutableIdentity } from '../src/main/claudeCodeCapability'
import { claudeCodeEnvironment, detectClaudeCodeApplications, projectClaudeCodeConfig } from '../src/main/claudeCodeInstanceAdapter'
import { initializeClaudeCodeOnboarding } from '../src/main/claudeCodeOnboarding'

// Real interactive acceptance with synthetic credentials and a private PTY.
// The OS blocks external connections. No model prompt or user Terminal window
// is involved; the only submitted text is Claude's local /exit command.
const modes = ['api_key', 'bearer'] as const
type Mode = typeof modes[number]
interface InteractiveResult { workspaceTrustPrompt: boolean; apiKeyApprovalPrompt: boolean; ready: boolean; exitCode: number | null; failure?: string }

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function defaultStateMetadata(): unknown[] {
  return ['.claude.json', '.claude/settings.json', '.claude/.credentials.json', '.claude/projects', '.config/anthropic/active_config'].map(path => {
    try {
      const value = lstatSync(join(homedir(), path))
      return { device: value.dev, inode: value.ino, mode: value.mode, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })
}

function runPty(config: { mode: Mode; command: string[]; environment: NodeJS.ProcessEnv; project: string; log: string }): Promise<InteractiveResult> {
  return new Promise((resolveRun, reject) => {
    const driver = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-interactive-pty.py')
    const child = spawn('/usr/bin/python3', [driver], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', settled = false
    const timeout = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Private PTY driver timed out')) }, 55_000)
    const finish = (error?: Error, result?: InteractiveResult) => {
      if (settled) return
      settled = true; clearTimeout(timeout)
      if (error) reject(error); else resolveRun(result!)
    }
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
      if (stdout.length > 16 * 1024) { child.kill('SIGTERM'); finish(new Error('Private PTY driver output exceeded its limit')) }
    })
    // Deliberately avoid printing raw child diagnostics or terminal output.
    child.stderr.resume()
    child.once('error', () => finish(new Error('Private PTY driver could not start')))
    child.once('close', () => {
      try { finish(undefined, JSON.parse(stdout) as InteractiveResult) }
      catch { finish(new Error('Private PTY driver returned an invalid result')) }
    })
    child.stdin.end(JSON.stringify(config))
  })
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Interactive acceptance currently verifies the macOS native CLI only')
  const requestedExecutable = argument('--executable')
  const executable = requestedExecutable ? realpathSync(resolve(requestedExecutable)) : detectClaudeCodeApplications()[0]?.path
  if (!executable) throw new Error('No installed Claude Code CLI found; pass --executable')
  const identity = captureClaudeExecutableIdentity(executable)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-interactive-smoke-')))
  const requestedEvidence = argument('--evidence-dir')
  if (requestedEvidence && !isAbsolute(requestedEvidence)) throw new Error('--evidence-dir must be absolute')
  const evidence = requestedEvidence ? resolve(requestedEvidence) : join(root, 'evidence')
  const home = join(root, 'home'), project = join(root, 'project')
  for (const path of [home, project, evidence]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const defaultStateBefore = defaultStateMetadata()
  const requests: { method: string; path: string }[] = []
  let externalConnects = 0
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', path: request.url ?? '' })
    request.resume(); response.writeHead(403).end()
  })
  server.on('connect', (_request, socket) => { externalConnects++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const endpoint = `http://127.0.0.1:${address.port}`
  const sandboxProfile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))'
  const results: { mode: Mode; result: InteractiveResult }[] = []
  try {
    for (const mode of modes) {
      const projection = projectClaudeCodeConfig({ instanceHome: join(root, mode), baseUrl: endpoint, ...(mode === 'api_key' ? { apiKey: 'sk-ant-api03-interactive-fixture-only' } : { authToken: 'interactive-bearer-fixture-only' }) })
      const config = projection.paths.configDirectory, stateFile = join(config, '.claude.json')
      mkdirSync(config, { recursive: true, mode: 0o700 })
      writeFileSync(projection.paths.settingsFile, JSON.stringify({ model: 'claude-sonnet-4-5' }), { mode: 0o600 })
      assert.deepEqual(initializeClaudeCodeOnboarding(config), { initialized: true })
      assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { hasCompletedOnboarding: true })
      const environment = claudeCodeEnvironment({
        PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost',
      }, projection)
      const result = await runPty({ mode, command: ['/usr/bin/sandbox-exec', '-p', sandboxProfile, executable, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], environment, project, log: join(evidence, `${mode}-terminal.bin`) })
      results.push({ mode, result })
      writeFileSync(join(evidence, `${mode}-result.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
      assert.equal(result.failure, undefined, `Interactive ${mode} startup did not reach a verified input screen`)
      assert.equal(result.workspaceTrustPrompt, true)
      assert.equal(result.apiKeyApprovalPrompt, mode === 'api_key')
      assert.equal(result.ready, true); assert.equal(result.exitCode, 0)
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>
      assert.equal(state.hasCompletedOnboarding, true); assert.equal(Object.hasOwn(state, 'oauthAccount'), false)
      const keyResponses = state.customApiKeyResponses as { approved?: unknown[] } | undefined
      assert.equal(keyResponses?.approved?.length ?? 0, mode === 'api_key' ? 1 : 0)
      assert.equal(existsSync(join(home, '.claude.json')), false)
      assert.equal(existsSync(join(home, '.claude')), false)
    }
    assert.equal(externalConnects, 0)
    assert.equal(requests.some(request => request.method === 'POST'), false)
    assert.ok(requests.every(request => request.method === 'GET' && ['/', '/api/health'].includes(request.path)))
    assert.deepEqual(defaultStateMetadata(), defaultStateBefore)
    validateClaudeExecutableIdentity(identity)
    const report = {
      result: 'passed', platform: process.platform, architecture: process.arch, checkedAt: new Date().toISOString(),
      executableSha256: identity.sha256, executableSize: identity.size, modes: results,
      checks: ['real-native-interactive-pty', 'production-onboarding-helper', 'api-key-approval-prompt-retained', 'workspace-trust-retained-per-instance', 'api-and-bearer-reach-input', 'no-oauth-account-fabrication', 'default-store-metadata-unchanged', 'external-network-denied-by-os', 'zero-model-requests', 'clean-cli-exit'],
      localRequests: requests.length, modelRequests: 0, externalConnects,
    }
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ result: report.result, checks: report.checks, evidence: join(evidence, 'report.json') }, null, 2))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    if (requestedEvidence) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch(() => { console.error('Claude interactive acceptance failed; inspect the private evidence directory. No credential values or raw terminal output were logged.'); process.exitCode = 1 })
