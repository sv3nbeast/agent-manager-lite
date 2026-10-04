import { spawn } from 'node:child_process'
import { Store, type StoredAccount } from './store'
import { HTTPError, nonempty, requestJSON, type JSONRequest } from './network'
import { agentAssertion, sameAgentKey, signAgentTask, type AgentIdentity } from './agentIdentityCredentials'

const AUTH_BASE = 'https://auth.openai.com/api/accounts'
export type TaskDecrypt = (privateKey: string, encrypted: string, signal?: AbortSignal) => Promise<string>

export function taskDecryptor(binary: string): TaskDecrypt {
  return async (privateKey, encrypted, signal) => {
    signal?.throwIfAborted()
    const input = JSON.stringify({ privateKey, encryptedTaskId: encrypted })
    if (Buffer.byteLength(input) > 65536) throw new Error('Agent Identity task 响应过大')
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, ['-agent-task-decrypt'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      const chunks: Buffer[] = []
      let size = 0, failed = false
      const fail = () => { failed = true; child.kill('SIGKILL') }
      const timer = setTimeout(fail, 5000)
      signal?.addEventListener('abort', fail, { once: true })
      child.stdin.on('error', fail)
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 16384) fail(); else chunks.push(chunk) })
      child.once('error', () => { failed = true })
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', fail)
        if (code !== 0 || failed || signal?.aborted) { reject(new Error('Agent Identity task 解密失败或已取消')); return }
        try {
          const taskId = JSON.parse(Buffer.concat(chunks).toString('utf8')).taskId
          if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 4096 || /[\r\n\0]/.test(taskId)) throw new Error('format')
          resolve(taskId.trim())
        } catch { reject(new Error('Agent Identity task 解密结果无效')) }
      })
      child.stdin.end(input)
    })
  }
}

// Node owns the encrypted account record. The forwarding executor may recover a
// task too; adopt() uses its projected task as a compare-and-swap baseline.
export class AgentIdentityService {
  private readonly pending = new Map<string, Promise<StoredAccount>>()
  private readonly controller = new AbortController()
  constructor(private readonly store: Store, private readonly decrypt: TaskDecrypt,
    private readonly request: JSONRequest = requestJSON,
    private readonly project: (account: StoredAccount) => void | Promise<void> = () => {}) {}

  busy(id:string):boolean{return this.pending.has(id)}
  ensure(id: string, rejectedTask?: string): Promise<StoredAccount> {
    const account = this.store.read().accounts.find(a => a.id === id)
    if (!account) return Promise.reject(new Error('账号已删除'))
    if (account.kind !== 'agent_identity') return Promise.resolve(account)
    if (this.controller.signal.aborted) return Promise.reject(new Error('应用正在退出'))
    const current = account.credentials.agentIdentity
    if (!current) return Promise.reject(new Error('Agent Identity 凭据缺失'))
    if (current.task_id && (!rejectedTask || current.task_id !== rejectedTask)) return Promise.resolve(account)
    const pending = this.pending.get(id)
    if (pending) return pending
    const operation = this.registerTask(account).finally(() => this.pending.delete(id))
    this.pending.set(id, operation)
    return operation
  }

  private async registerTask(before: StoredAccount): Promise<StoredAccount> {
    const identity = before.credentials.agentIdentity!
    const result = await this.request(`${AUTH_BASE}/v1/agent/${encodeURIComponent(identity.agent_runtime_id)}/task/register`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(signAgentTask(identity)), signal: this.controller.signal
    }, '注册 Agent Identity task', before)
    const plain = nonempty(result.task_id) ?? nonempty(result.taskId)
    const encrypted = nonempty(result.encrypted_task_id) ?? nonempty(result.encryptedTaskId)
    const task = plain ?? (encrypted ? await this.decrypt(identity.agent_private_key, encrypted, this.controller.signal) : undefined)
    if (!task || task.length > 4096 || /[\r\n\0]/.test(task)) throw new Error('Agent Identity task 注册响应无效')
    // Persist a completed registration even if shutdown was requested meanwhile.
    const account = this.adopt(before.id, { ...identity, task_id: task }, identity.task_id,before.generation)
    if (!account) throw new Error('账号或凭据已改变，task 注册结果已丢弃')
    await this.project(account)
    return account
  }

  adopt(id: string, observed: AgentIdentity, expectedTask?: string,expectedGeneration?:string): StoredAccount | undefined {
    const before = this.store.read().accounts.find(a => a.id === id)
    if (!before || before.generation!==expectedGeneration || before.kind !== 'agent_identity' || !sameAgentKey(before.credentials.agentIdentity, observed) || !observed.task_id
      || observed.task_id.length > 4096 || /[\r\n\0]/.test(observed.task_id)) return
    if (before.credentials.agentIdentity!.task_id !== expectedTask || before.credentials.agentIdentity!.task_id === observed.task_id) return before
    let result: StoredAccount | undefined
    this.store.transaction(state => {
      const account = state.accounts.find(a => a.id === id)!
      account.credentials.agentIdentity!.task_id = observed.task_id
      delete account.error; delete account.errorAt
      result = structuredClone(account)
    })
    return result
  }

  async query(id: string, url: string, signal: AbortSignal): Promise<{ value: Record<string, unknown>; account: StoredAccount }> {
    signal = AbortSignal.any([signal, this.controller.signal])
    signal.throwIfAborted()
    let account = await this.ensure(id)
    if (account.kind !== 'agent_identity') throw new Error('此账号不是 Agent Identity')
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      const identity = account.credentials.agentIdentity!
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: agentAssertion(identity),
        'ChatGPT-Account-Id': identity.account_id, originator: 'Codex Desktop', 'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})` }
      if (identity.chatgpt_account_is_fedramp) headers['X-OpenAI-Fedramp'] = 'true'
      try { return { value: await this.request(url, { headers, signal }, '查询 Agent Identity 用量', account), account } }
      catch (error) {
        if (attempt === 0 && error instanceof HTTPError && error.code === 'agent_task_invalid' && !signal.aborted) {
          const current=this.store.read().accounts.find(value=>value.id===id)
          if(!current||current.generation!==account.generation)throw new Error('账号已移入回收站或重新恢复，旧查询已结束')
          account = await this.ensure(id, identity.task_id)
        }
        else throw error
      }
    }
    throw new Error('Agent Identity 用量查询失败')
  }

  async stop(): Promise<void> { this.controller.abort(); await Promise.allSettled([...this.pending.values()]) }
}
