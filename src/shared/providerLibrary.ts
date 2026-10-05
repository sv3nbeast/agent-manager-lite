import { z } from 'zod'
import { accountInputSchema, defaultTierSchema } from './types'
import type {ProviderUsageState} from './providerUsage'
import { modelContextWindowsSchema } from './modelContextWindows'

export const providerDetailsSchema = z.object({
  name: accountInputSchema.shape.name,
  baseUrl: accountInputSchema.shape.baseUrl,
  models: accountInputSchema.shape.models,
  wireApi: accountInputSchema.shape.wireApi,
  integrationType: accountInputSchema.shape.integrationType,
  defaultTier: defaultTierSchema.default('inherit'),
  presetId: z.string().trim().max(80).optional(),
  modelContextWindows: modelContextWindowsSchema.optional(),
  supportsVision: z.boolean().optional(),
  modelCapabilities: z.record(z.string().trim().min(1).max(200), z.object({ supportsVision: z.boolean().optional() }).strict()).optional(),
  visionRoutingModel: z.string().trim().max(200).optional(),
  supportsWebsockets: z.boolean().optional(),
  enableModePreference: z.enum(['auto', 'direct', 'gateway']).optional()
}).strict()
export type ProviderDetails = z.infer<typeof providerDetailsSchema>
export interface ProviderKeySummary {
  id: string; name: string; createdAt: number; updatedAt: number; accountIds: string[]
  // Credential matches are reusable connections, not supplier-managed links.
  // Optional for older snapshots; credentials never leave the encrypted store.
  reusableAccountIds?: string[]; usage?:ProviderUsageState
}
export interface ProviderSummary extends ProviderDetails {
  id: string; revision: number; createdAt: number; updatedAt: number; keys: ProviderKeySummary[]
}
const identity = { id: z.string().uuid(), revision: z.number().int().nonnegative() }
const keyId = z.string().uuid()
const keyName = z.string().trim().max(120)
const secret = accountInputSchema.shape.apiKey
export const providerKeyReadSchema = z.object({ ...identity, keyId }).strict()
export type ProviderKeyRead = z.infer<typeof providerKeyReadSchema>
export const providerMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), details: providerDetailsSchema,
    initialKey:z.object({name:keyName,apiKey:secret,createConnection:z.boolean()}).strict().optional() }).strict(),
  z.object({ action: z.literal('update'), ...identity, changes: providerDetailsSchema.partial(),
    clearModelContextWindows: z.boolean().optional(),
    keyChange: z.object({ keyId, apiKey: secret }).strict().optional() }).strict(),
  z.object({ action: z.literal('delete'), ...identity }).strict(),
  z.object({ action: z.literal('addKey'), ...identity, name: keyName, apiKey: secret, createConnection:z.boolean().optional() }).strict(),
  z.object({ action: z.literal('editKey'), ...identity, keyId, name: keyName.optional(), apiKey: secret.optional() }).strict(),
  z.object({ action: z.literal('removeKey'), ...identity, keyId }).strict(),
  z.object({ action: z.literal('moveKey'), ...identity, keyId, targetId: keyId, targetRevision: identity.revision }).strict(),
  z.object({ action: z.literal('createAccount'), ...identity, keyId, name: accountInputSchema.shape.name }).strict(),
  z.object({ action: z.literal('linkAccount'), ...identity, keyId, accountId: keyId, accountRevision: identity.revision }).strict(),
  z.object({ action: z.literal('unlinkAccount'), accountId: keyId, accountRevision: identity.revision }).strict(),
  z.object({ action: z.literal('reconcile') }).strict()
])
export type ProviderMutation = z.infer<typeof providerMutationSchema>

// URL hostnames are case insensitive; provider paths and model names are not.
export function providerEndpoint(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
