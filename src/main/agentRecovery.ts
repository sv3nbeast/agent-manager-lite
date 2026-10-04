import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { parseAgentIdentity, sameAgentKey, type AgentIdentity } from './agentIdentityCredentials'
import { AgentIdentityService } from './agentIdentity'
import { Store } from './store'
import type { CredentialRecoveryStatus } from '../shared/types'

const markerName = 'agent-recovery.json'
const recoverySchema = z.object({
  kind: z.literal('codex-manager-lite-agent-recovery'), version: z.literal(1),
  accountId: z.string().uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expectedTask: z.string().min(1).max(4096).optional(),
  accountGeneration:z.string().uuid().optional(),
  ownerPid: z.number().int().positive(), sidecarPid: z.number().int().positive().optional(),
  updatedAt: z.number().finite().positive()
}).strict()
export function agentFingerprint(identity: AgentIdentity): string {
  return createHash('sha256').update(JSON.stringify([identity.agent_runtime_id, identity.agent_private_key, identity.account_id, identity.chatgpt_user_id])).digest('hex')
}
export function writeAgentRecovery(directory: string, accountId: string, identity: AgentIdentity, sidecarPid?: number, multiple = false,accountGeneration?:string): void {
  const marker = recoverySchema.parse({ kind: 'codex-manager-lite-agent-recovery', version: 1,
    accountId, accountGeneration, fingerprint: agentFingerprint(identity), expectedTask: identity.task_id,
    ownerPid: process.pid, sidecarPid, updatedAt: Date.now() })
  const target = join(directory, multiple ? `agent-recovery-${accountId}.json` : markerName), temporary = `${target}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' }); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
}
function readBounded(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65536) throw new Error('invalid recovery file')
    const buffer = Buffer.alloc(65537)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > 65536) throw new Error('oversized recovery file')
    return JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } finally { closeSync(fd) }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

// Reconcile only dead, owned runtime directories. A stale task cannot replace a
// newer vault task; removed/replaced accounts are never reimported. Unknown or
// failed records stay in place for retry rather than being silently discarded.
export function recoverAgentTasks(root: string, store: Store, agents: AgentIdentityService,
  options: { isAlive?: (pid: number) => boolean; now?: () => number; activeDirectory?: string } = {}): CredentialRecoveryStatus {
  const result = { recovered: 0, retained: 0 }
  if (!existsSync(root)) return result
  let entries: import('node:fs').Dirent[]
  // An unreadable/corrupt runtime root must not prevent the rest of the desktop
  // application from opening. Preserve it and expose the retry state instead.
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return { recovered: 0, retained: 1 }
    entries = readdirSync(root, { withFileTypes: true })
  } catch { return { recovered: 0, retained: 1 } }
  const isAlive = options.isAlive ?? alive, now = options.now ?? Date.now
  for (const entry of entries) {
    if (!entry.name.startsWith('gateway-')) continue
    const directory = join(root, entry.name)
    if (directory === options.activeDirectory) continue
    try {
      if (!entry.isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('not owned directory')
      // Older/API-key runtime directories have no Agent Identity checkpoint.
      // They are outside this recovery operation's deletion authority.
      const markers=readdirSync(directory).filter(name=>name===markerName || /^agent-recovery-[a-f0-9-]{36}\.json$/.test(name))
      if(!markers.length)continue
      let keep=false
      for(const name of markers) {
        try {
          const marker = recoverySchema.parse(readBounded(join(directory, name)))
          if (isAlive(marker.ownerPid) || marker.sidecarPid && isAlive(marker.sidecarPid)
            || !marker.sidecarPid && now() - marker.updatedAt < 5000) { result.retained++; keep=true; continue }
          const authDirectory = join(directory, 'auth')
          if (!lstatSync(authDirectory).isDirectory() || lstatSync(authDirectory).isSymbolicLink()) throw new Error('invalid auth directory')
          const observed = parseAgentIdentity(readBounded(join(authDirectory, `${marker.accountId}.json`)))
          if (!observed || agentFingerprint(observed) !== marker.fingerprint) throw new Error('identity changed')
          const current = store.read().accounts.find(a => a.id === marker.accountId)
          if (current?.kind === 'agent_identity' && current.generation===marker.accountGeneration && sameAgentKey(current.credentials.agentIdentity, observed) && observed.task_id) {
            const saved = agents.adopt(marker.accountId, observed, marker.expectedTask,marker.accountGeneration)
            if (!saved) throw new Error('unable to save recovered task')
            if (saved.credentials.agentIdentity!.task_id !== current.credentials.agentIdentity!.task_id) result.recovered++
          }
        } catch { result.retained++; keep=true }
      }
      if(!keep)rmSync(directory, { recursive: true, force: true })
    } catch { result.retained++ }
  }
  return result
}
