import { claudeCodeClient, claudeCodeClientType, claudeCodeDesktopClient, type ClaudeCodeApplicationKind } from '../shared/claudeCode'
import { implementedAgentClients, type AgentClientType } from '../shared/agentClients'

/**
 * Registry metadata is intentionally separate from the implemented-client
 * schema.  A planned client can be inspected by diagnostics without becoming
 * selectable by instance creation or being passed to Codex lifecycle code.
 */
export type RegisteredClientType = AgentClientType | typeof claudeCodeClientType
export type ClientRegistrationStatus = 'implemented' | 'planned'

export interface ClientAdapterRegistration {
  clientType: RegisteredClientType
  name: string
  status: ClientRegistrationStatus
  applicationKinds: readonly ('desktop' | 'cli')[]
  identityService: string
  protocol: string
  /** All evidence gates must be verified before this can become implemented. */
  readiness: 'verified' | 'pending'
  reason?: string
}

const codex = implementedAgentClients[0]

const registrations: readonly ClientAdapterRegistration[] = [
  {
    clientType: codex.id,
    name: codex.name,
    status: 'implemented',
    applicationKinds: codex.capabilities.launchModes,
    identityService: codex.identityService,
    protocol: 'openai_responses',
    readiness: 'verified',
  },
  {
    clientType: claudeCodeClientType,
    name: `${claudeCodeClient.name}（CLI）`,
    status: claudeCodeClient.status,
    applicationKinds: ['cli'],
    identityService: claudeCodeClient.identityService,
    protocol: claudeCodeClient.protocol,
    readiness: 'pending',
    reason: 'Claude CLI 的登录凭据、全局状态、协议和会话索引尚未完成实测',
  },
  {
    clientType: claudeCodeClientType,
    name: claudeCodeDesktopClient.name,
    status: claudeCodeDesktopClient.status,
    applicationKinds: ['desktop'],
    identityService: claudeCodeDesktopClient.identityService,
    protocol: claudeCodeDesktopClient.protocol,
    readiness: 'pending',
    reason: 'Claude Desktop 的 Electron profile、Keychain/cookie、Code 模式和会话边界尚未完成实测',
  },
]

export function listClientAdapterRegistrations(): ClientAdapterRegistration[] {
  return registrations.map(item => ({ ...item, applicationKinds: [...item.applicationKinds] }))
}

export function getClientAdapterRegistration(clientType: unknown, applicationKind?: 'desktop' | 'cli'): ClientAdapterRegistration | undefined {
  return registrations.find(item => item.clientType === clientType && (applicationKind === undefined || item.applicationKinds.includes(applicationKind)))
}

export function assertImplementedClient(clientType: unknown, applicationKind?: 'desktop' | 'cli'): ClientAdapterRegistration {
  const registration = getClientAdapterRegistration(clientType, applicationKind)
  if (!registration) throw new Error('客户端尚未建立适配器')
  if (registration.status !== 'implemented' || registration.readiness !== 'verified') throw new Error(`${registration.name} 尚未通过登录、配置、隔离和会话边界验收`)
  return registration
}

/** Ensure desktop/CLI are treated as app variants, never as agent types. */
export function isClaudeCodeApplicationKind(value: unknown): value is ClaudeCodeApplicationKind {
  return value === 'cli' || value === 'desktop'
}
