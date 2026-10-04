import { z } from 'zod'

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), '不能包含控制字符')

export const sshAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent') }).strict(),
  z.object({ kind: z.literal('private_key_file'), path: text(4096) }).strict()
])
export type SshAuth = z.infer<typeof sshAuthSchema>

export const sshServerInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: text(120),
  host: text(255).refine(value => !/[\s'"`$;&|<>]/.test(value), '主机名包含不支持的字符'),
  port: z.number().int().min(1).max(65535).default(22),
  username: text(120).refine(value => !/[\s'"`$;&|<>]/.test(value), '用户名包含不支持的字符'),
  codexHome: text(1024).default('~/.codex').refine(value => /^(?:~|~\/|\/)[A-Za-z0-9._/~+-]*$/.test(value), '远端 Codex 目录只能使用绝对路径或 ~/ 路径'),
  auth: sshAuthSchema,
  syncOnCodexSwitch: z.boolean().default(false)
}).strict()
export type SshServerInput = z.infer<typeof sshServerInputSchema>

export interface SshSyncStatus {
  accountId: string
  accountEmail?: string
  tokenGeneration?: string
  bundleHash: string
  syncedAt: number
  verified: boolean
  error?: string
}

export interface SshServerView extends SshServerInput {
  id: string
  createdAt: number
  updatedAt: number
  lastSync?: SshSyncStatus
}

export interface SshServersView {
  selectedId?: string
  servers: SshServerView[]
}

export interface SshSyncInput {
  serverId?: string
  accountId: string
}

export interface SshSyncResult extends SshSyncStatus {
  serverId: string
  serverName: string
}

export interface SshTestResult {
  serverId: string
  ok: true
  message: string
}
