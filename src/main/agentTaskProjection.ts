import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { parseAgentIdentity, sameAgentKey, type AgentIdentity } from './agentIdentityCredentials'
import type { StoredAccount } from './store'

export type AdoptAgentTask = (id: string, identity: AgentIdentity, expectedTask?: string,expectedGeneration?:string) => StoredAccount | undefined

// All reconciliation is synchronous with the vault transaction. An older disk
// observation cannot overwrite a task registered by the main process meanwhile.
export class AgentTaskProjection {
  private baseline: AgentIdentity
  constructor(private readonly accountId: string, private readonly path: string, identity: AgentIdentity,
    private readonly adopt: AdoptAgentTask,
    private readonly onBaseline: (identity: AgentIdentity) => void = () => {}) { this.baseline = structuredClone(identity) }

  checkpoint(): void { this.onBaseline(this.baseline) }
  projected(identity: AgentIdentity): void { this.baseline = structuredClone(identity); this.checkpoint() }
  sync(): StoredAccount | undefined {
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let observed: AgentIdentity | undefined
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 65536) throw new Error('Agent Identity 运行凭据格式无效')
      observed = parseAgentIdentity(JSON.parse(readFileSync(fd, 'utf8')))
    } catch { throw new Error('Agent Identity 运行凭据读取失败') }
    finally { closeSync(fd) }
    if (!sameAgentKey(this.baseline, observed)) throw new Error('Agent Identity 运行凭据身份发生变化')
    if (!observed?.task_id) return
    const account = this.adopt(this.accountId, observed, this.baseline.task_id)
    if (account?.credentials.agentIdentity?.task_id === observed.task_id && this.baseline.task_id !== observed.task_id) this.projected(observed)
    return account
  }
}
