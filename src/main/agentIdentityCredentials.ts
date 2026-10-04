import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { nonempty, object } from './network'

export interface AgentIdentity {
  agent_runtime_id: string; agent_private_key: string; task_id?: string
  account_id: string; chatgpt_user_id: string; email?: string; plan_type?: string
  chatgpt_account_is_fedramp: boolean
}

export function privateKey(encoded: string): KeyObject {
  if (encoded.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Agent Identity 私钥不是有效 Base64')
  const der = Buffer.from(encoded, 'base64')
  let key: KeyObject
  // Check ring's embedded public key ourselves: OpenSSL versions differ in
  // accepting this shape, and accepting DER does not prove the key pair matches.
  const prefix = der.subarray(0, 16).toString('hex')
  const suffix = der.subarray(48, der.length - 32).toString('hex')
  if (der.length === 85 && prefix === '3053020101300506032b657004220420' && suffix === 'a123032100'
    || der.length === 83 && prefix === '3051020101300506032b657004220420' && suffix === '812100') {
    key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), der.subarray(16, 48)]), format: 'der', type: 'pkcs8' })
    const publicBytes = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
    if (!publicBytes.equals(der.subarray(-32))) throw new Error('Agent Identity 私钥与公钥不匹配')
  } else {
    try { key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) }
    catch { throw new Error('Agent Identity 私钥不是有效 PKCS#8 Ed25519') }
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Agent Identity 需要 Ed25519 私钥')
  return key
}

function field(source: Record<string, unknown>, names: string[], required = false): string | undefined {
  let value: string | undefined
  for (const name of names) { value = nonempty(source[name]); if (value) break }
  if (value && (value.length > 4096 || /[\r\n\0]/.test(value)) || required && !value) throw new Error(`Agent Identity ${names[0]} 无效或缺失`)
  return value
}

export function parseAgentIdentity(value: unknown): AgentIdentity | undefined {
  const root = object(value), credentials = object(root.credentials)
  const nested = root.agent_identity ?? root.agentIdentity ?? credentials.agent_identity ?? credentials.agentIdentity
  const mode = (nonempty(root.auth_mode) ?? nonempty(root.authMode) ?? nonempty(credentials.auth_mode) ?? nonempty(credentials.authMode))?.toLowerCase()
  const direct = nonempty(credentials.agent_runtime_id ?? credentials.agentRuntimeId) && nonempty(credentials.agent_private_key ?? credentials.agentPrivateKey)
  if (nested === undefined && mode !== 'agentidentity' && !direct) return
  const source = object(nested ?? (Object.keys(credentials).length ? credentials : root))
  const encoded = nonempty(source.agent_private_key ?? source.agentPrivateKey)
  if (!encoded) throw new Error('Agent Identity 缺少 agent_private_key')
  const normalizedKey = privateKey(encoded).export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const fedramp = source.chatgpt_account_is_fedramp ?? source.chatgptAccountIsFedramp ?? false
  if (typeof fedramp !== 'boolean') throw new Error('Agent Identity FedRAMP 字段必须是布尔值')
  return {
    agent_runtime_id: field(source, ['agent_runtime_id', 'agentRuntimeId'], true)!, agent_private_key: normalizedKey,
    account_id: field(source, ['account_id', 'accountId', 'chatgpt_account_id', 'chatgptAccountId'], true)!,
    chatgpt_user_id: field(source, ['chatgpt_user_id', 'chatgptUserId'], true)!,
    task_id: field(source, ['task_id', 'taskId']), email: field(source, ['email']), plan_type: field(source, ['plan_type', 'planType']),
    chatgpt_account_is_fedramp: fedramp
  }
}

export function sameAgentKey(a?: AgentIdentity, b?: AgentIdentity): boolean {
  return Boolean(a && b && a.agent_runtime_id === b.agent_runtime_id && a.agent_private_key === b.agent_private_key
    && a.account_id === b.account_id && a.chatgpt_user_id === b.chatgpt_user_id)
}

export function signAgentTask(identity: AgentIdentity, now = Date.now()): { timestamp: string; signature: string } {
  const timestamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return { timestamp, signature: sign(null, Buffer.from(`${identity.agent_runtime_id}:${timestamp}`), privateKey(identity.agent_private_key)).toString('base64') }
}

export function agentAssertion(identity: AgentIdentity, now = Date.now()): string {
  if (!identity.task_id) throw new Error('Agent Identity 缺少 task_id')
  const timestamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const signature = sign(null, Buffer.from(`${identity.agent_runtime_id}:${identity.task_id}:${timestamp}`), privateKey(identity.agent_private_key)).toString('base64')
  return `AgentAssertion ${Buffer.from(JSON.stringify({ agent_runtime_id: identity.agent_runtime_id, task_id: identity.task_id, timestamp, signature })).toString('base64url')}`
}
