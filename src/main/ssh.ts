import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { State, Store, StoredAccount } from './store'
import { authFor } from './nativeAccountProjection'
import { sshServerInputSchema, type SshServerInput, type SshServerView, type SshServersView, type SshSyncInput, type SshSyncResult, type SshTestResult, type SshSyncStatus } from '../shared/ssh'
import { z } from 'zod'

const TEST_TIMEOUT_MS = 20_000
const SYNC_TIMEOUT_MS = 45_000
const TEST_MARKER = 'cml-ssh-ok'

export type SshProcessRunner = (file: string, args: string[], input: string | undefined, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>

interface StoredSshServer extends SshServerView {}

function now(): number { return Date.now() }

function processRunner(file: string, args: string[], input: string | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ stdout, stderr }) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('SSH 命令超时')) }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value; if (stdout.length > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('SSH 输出超过限制')) } })
    child.stderr.on('data', value => { stderr += value; if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024) })
    child.once('error', error => finish(new Error(`SSH 程序不可用：${error.message}`)))
    child.once('close', code => code === 0 ? finish() : finish(new Error(safeSshError(stderr, code))))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function safeSshError(stderr: string, code: number | null): string {
  const value = stderr.replace(/[\r\n\t ]+/g, ' ').trim()
  if (/permission denied/i.test(value)) return 'SSH 认证失败，请检查 Agent 或私钥文件'
  if (/could not resolve|name or service not known|no route|connection refused|timed out/i.test(value)) return 'SSH 无法连接到远端服务器'
  return value.slice(0, 400) || `SSH 命令失败（退出码 ${code ?? '未知'}）`
}

function remotePath(value: string): string {
  const path = value.trim() || '~/.codex'
  if (!/^(?:~|~\/|\/)[A-Za-z0-9._/~+-]*$/.test(path)) throw new Error('远端 Codex 目录只能使用绝对路径或 ~/ 路径')
  return path
}

export function buildSshArgs(server: Pick<SshServerView, 'host' | 'port' | 'username' | 'auth'>, remoteArgs: string[]): string[] {
  const args = ['-p', String(server.port), '-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2']
  if (server.auth.kind === 'private_key_file') args.push('-o', 'IdentitiesOnly=yes', '-i', server.auth.path)
  args.push(`${server.username}@${server.host}`, ...remoteArgs)
  return args
}

function serverView(server: StoredSshServer): SshServerView { return structuredClone(server) }
function serversView(state: State): SshServersView { return { ...(state.sshServers?.selectedId ? { selectedId: state.sshServers.selectedId } : {}), servers: (state.sshServers?.servers ?? []).map(serverView) } }

function accountAuth(account: StoredAccount): string {
  if (account.kind === 'agent_identity') throw new Error('Agent Identity 暂不支持同步到远端 Codex')
  return authFor(account, null, {})
}

function syncStatus(account: StoredAccount, hash: string, verified: boolean, error?: string): SshSyncStatus {
  return { accountId: account.id, ...(account.email ? { accountEmail: account.email } : {}), ...(account.generation ? { tokenGeneration: account.generation } : {}), bundleHash: hash, syncedAt: now(), verified, ...(error ? { error } : {}) }
}

export class SshServers {
  constructor(private readonly store: Store, private readonly clock: () => number = now, private readonly run: SshProcessRunner = processRunner) {}

  view(): SshServersView { return serversView(this.store.read()) }

  save(raw: unknown): SshServersView {
    const input = sshServerInputSchema.parse(raw)
    const state = this.store.read()
    const existing = input.id ? state.sshServers?.servers.find(server => server.id === input.id) : undefined
    const server: StoredSshServer = { ...input, id: input.id ?? randomUUID(), port: input.port ?? 22, codexHome: remotePath(input.codexHome ?? '~/.codex'), syncOnCodexSwitch: input.syncOnCodexSwitch ?? false, createdAt: existing?.createdAt ?? this.clock(), updatedAt: this.clock(), ...(existing?.lastSync ? { lastSync: existing.lastSync } : {}) }
    this.store.transaction(next => {
      const servers = next.sshServers?.servers ? [...next.sshServers.servers] : []
      const index = servers.findIndex(value => value.id === server.id)
      if (index < 0) servers.push(server)
      else servers[index] = server
      next.sshServers = { servers, selectedId: next.sshServers?.selectedId }
    })
    return this.view()
  }

  remove(raw: unknown): SshServersView {
    const id = z.string().uuid().parse(raw)
    this.store.transaction(state => {
      const servers = (state.sshServers?.servers ?? []).filter(server => server.id !== id)
      state.sshServers = { servers, ...(state.sshServers?.selectedId && state.sshServers.selectedId !== id ? { selectedId: state.sshServers.selectedId } : {}) }
    })
    return this.view()
  }

  select(raw: unknown): SshServersView {
    const id = raw === undefined || raw === null || raw === '' ? undefined : z.string().uuid().parse(raw)
    if (id && !(this.store.read().sshServers?.servers ?? []).some(server => server.id === id)) throw new Error('SSH 服务器不存在')
    this.store.transaction(state => { state.sshServers = { servers: state.sshServers?.servers ?? [], ...(id ? { selectedId: id } : {}) } })
    return this.view()
  }

  async test(raw: unknown): Promise<SshTestResult> {
    const id = z.string().uuid().parse(raw), server = this.find(id)
    const result = await this.run(this.binary(), buildSshArgs(server, ['printf', TEST_MARKER]), undefined, TEST_TIMEOUT_MS)
    if (result.stdout.trim() !== TEST_MARKER) throw new Error('SSH 连接测试返回了无法识别的结果')
    return { serverId: id, ok: true, message: 'SSH 连接正常' }
  }

  async sync(raw: unknown): Promise<SshSyncResult> {
    const input = z.object({ serverId: z.string().uuid().optional(), accountId: z.string().uuid() }).strict().parse(raw) as SshSyncInput
    const state = this.store.read(), server = input.serverId ? this.find(input.serverId, state) : this.find(state.sshServers?.selectedId, state)
    const account = state.accounts.find(value => value.id === input.accountId)
    if (!account) throw new Error('账号不存在')
    const auth = accountAuth(account), bytes = Buffer.from(auth), encoded = bytes.toString('base64'), hash = createHash('sha256').update(bytes).digest('hex')
    bytes.fill(0)
    const script = `set -eu\nhome=\"$1\"\ncase \"$home\" in\n  \"~\") home=\"$HOME\" ;;\n  \"~/\"*) home=\"$HOME/${'${home#~/}'}\" ;;\n  /*) ;;\n  *) printf 'invalid remote home\\n' >&2; exit 4 ;;\nesac\nmkdir -p \"$home\"\ntmp=\"$home/.codex-auth.$$.tmp\"\ntrap 'rm -f \"$tmp\"' EXIT INT TERM\nprintf '%s' '${encoded}' | (base64 -d 2>/dev/null || base64 -D) > \"$tmp\"\nchmod 600 \"$tmp\"\nmv \"$tmp\" \"$home/auth.json\"\nactual=\"$(sha256sum \"$home/auth.json\" 2>/dev/null | awk '{print $1}' || shasum -a 256 \"$home/auth.json\" | awk '{print $1}')\"\n[ \"$actual\" = '${hash}' ]\nprintf 'cml-sync-ok\\t%s\\n' \"$actual\"\n`
    let verified = false, error: string | undefined
    try {
      const result = await this.run(this.binary(), buildSshArgs(server, ['sh', '-s', '--', server.codexHome]), script, SYNC_TIMEOUT_MS)
      verified = result.stdout.split(/\r?\n/).some(line => line.trim() === `cml-sync-ok\t${hash}`)
      if (!verified) throw new Error('远端文件校验失败')
    } catch (cause) { error = safeSshError(cause instanceof Error ? cause.message : String(cause), -1) }
    const status = syncStatus(account, verified ? hash : '', verified, error)
    this.store.transaction(next => {
      const target = next.sshServers?.servers.find(value => value.id === server.id)
      if (target) target.lastSync = status
    })
    if (!verified) throw new Error(error ?? 'SSH 同步失败')
    return { serverId: server.id, serverName: server.name, ...status }
  }

  private binary(): string { return process.env.CML_TEST_SSH_BINARY?.trim() || 'ssh' }
  private find(id: string | undefined, state = this.store.read()): StoredSshServer {
    if (!id) throw new Error('请先选择 SSH 服务器')
    const value = state.sshServers?.servers.find(server => server.id === id)
    if (!value) throw new Error('SSH 服务器不存在')
    return value
  }
}
