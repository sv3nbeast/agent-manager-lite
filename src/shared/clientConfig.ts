import { z } from 'zod'

export const configKeys = ['model', 'model_provider', 'model_reasoning_effort', 'service_tier', 'model_context_window', 'model_auto_compact_token_limit'] as const
export type QuickConfigKey = typeof configKeys[number]
export type ConfigKey = QuickConfigKey | 'model_catalog_json' | 'cli_auth_credentials_store' | 'forced_login_method' | 'sqlite_home' | `model_providers.${string}` | `profiles.${string}.sqlite_home`
const optionalText = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
export const clientConfigChangesSchema = z.object({
  model: optionalText.nullable().optional(),
  model_provider: optionalText.nullable().optional(),
  model_reasoning_effort: optionalText.nullable().optional(),
  service_tier: z.enum(['fast', 'default', 'auto', 'flex', 'priority']).nullable().optional(),
  model_context_window: z.number().int().min(2).max(100_000_000).nullable().optional(),
  model_auto_compact_token_limit: z.number().int().min(1).max(100_000_000).nullable().optional()
}).strict().superRefine((value, context) => {
  const window = value.model_context_window, threshold = value.model_auto_compact_token_limit
  if (threshold !== undefined && window === undefined) context.addIssue({code: 'custom', path: ['model_context_window'], message: '请同时指定上下文窗口'})
  if (window === null && threshold != null || window != null && threshold != null && threshold >= window) context.addIssue({code: 'custom', path: ['model_auto_compact_token_limit'], message: '压缩阈值必须小于上下文窗口'})
})
export type ClientConfigChanges = z.infer<typeof clientConfigChangesSchema>
export interface ClientConfigTarget { id: string; name: string; directory: string; managed: boolean }
export interface StoredConfigTarget extends ClientConfigTarget { device: number; inode: number }
export interface ConfigRevision { id: string; createdAt: number; kind: 'apply' | 'restore' }
export interface ClientConfigView {
  target: ClientConfigTarget; exists: boolean; revision: string
  values: Partial<Record<ConfigKey, string | number | boolean | null>>
  providers: string[]; activeProfile?: string; revisions: ConfigRevision[]
}
export interface ConfigDiff { key: ConfigKey; before: string; after: string }
export interface ClientConfigPreview { ticket: string; target: ClientConfigTarget; changes: ConfigDiff[]; conflicts: ConfigKey[]; kind: 'apply' | 'restore'; catalogModels?: string[] }
export const previewClientConfigSchema = z.object({ id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/), changes: clientConfigChangesSchema }).strict()
export const restoreClientConfigSchema = z.object({ id: z.string().uuid(), backup: z.string().regex(/^\d{13}-[a-f0-9-]{36}$/) }).strict()
