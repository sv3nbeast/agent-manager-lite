import { z } from 'zod'
import { accountInputSchema, accountProtocolSchema, defaultTierSchema, type Account, type AccountProtocol } from './types'
import type {ProviderUsageState} from './providerUsage'
import { modelContextWindowsSchema } from './modelContextWindows'

export const providerDetailsSchema = z.object({
  name: accountInputSchema.shape.name,
  baseUrl: accountInputSchema.shape.baseUrl,
  // Read compatibility for earlier provider-wide catalogues. New editors save
  // the catalogue on the selected key and never fan it out across a supplier.
  models: accountInputSchema.shape.models.min(0).default([]),
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
export const providerKeySettingsSchema = z.object({
  models: accountInputSchema.shape.models.min(0).optional(),
  protocol: accountProtocolSchema.optional(),
  credentialKind: z.enum(['openai_api_key','anthropic_api_key','anthropic_bearer','gateway']).optional()
}).strict()
export type ProviderKeySettings = z.infer<typeof providerKeySettingsSchema>
export interface ProviderKeySummary extends ProviderKeySettings {
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
    initialKey:z.object({...providerKeySettingsSchema.shape,name:keyName,apiKey:secret,createConnection:z.boolean()}).strict().optional() }).strict(),
  z.object({ action: z.literal('update'), ...identity, changes: providerDetailsSchema.partial(),
    clearModelContextWindows: z.boolean().optional(),
    keyChange: z.object({ ...providerKeySettingsSchema.shape,keyId, apiKey: secret.optional() }).strict().optional() }).strict(),
  z.object({ action: z.literal('delete'), ...identity }).strict(),
  z.object({ action: z.literal('addKey'), ...identity, ...providerKeySettingsSchema.shape, name: keyName, apiKey: secret, createConnection:z.boolean().optional() }).strict(),
  z.object({ action: z.literal('editKey'), ...identity, ...providerKeySettingsSchema.shape, keyId, name: keyName.optional(), apiKey: secret.optional() }).strict(),
  z.object({ action: z.literal('removeKey'), ...identity, keyId }).strict(),
  z.object({ action: z.literal('moveKey'), ...identity, keyId, targetId: keyId, targetRevision: identity.revision }).strict(),
  z.object({ action: z.literal('createAccount'), ...identity, keyId, name: accountInputSchema.shape.name }).strict(),
  z.object({ action: z.literal('linkAccount'), ...identity, keyId, accountId: keyId, accountRevision: identity.revision }).strict(),
  z.object({ action: z.literal('unlinkAccount'), accountId: keyId, accountRevision: identity.revision }).strict(),
  z.object({ action: z.literal('reconcile') }).strict()
])
export type ProviderMutation = z.infer<typeof providerMutationSchema>

type ProviderDefaults = Pick<ProviderDetails,'models'|'wireApi'>
/** An explicitly empty key catalogue stays empty; only legacy missing fields inherit. */
export function providerKeyModels(provider:ProviderDefaults,key:ProviderKeySettings):string[] {
  return [...(key.models ?? provider.models)]
}
export function providerKeyProtocol(provider:ProviderDefaults,key:ProviderKeySettings):AccountProtocol {
  return key.protocol ?? (provider.wireApi==='chat_completions'?'openai_chat_completions':'openai_responses')
}
export function providerKeyCredentialKind(provider:ProviderDefaults,key:ProviderKeySettings):NonNullable<ProviderKeySettings['credentialKind']> {
  return key.credentialKind ?? (providerKeyProtocol(provider,key)==='anthropic_messages'?'anthropic_api_key':'openai_api_key')
}
export function providerKeyConnection(provider:ProviderDefaults,key:ProviderKeySettings):Pick<Account,'models'|'protocol'|'wireApi'|'identityService'|'credentialKind'> {
  const protocol=providerKeyProtocol(provider,key)
  return {models:providerKeyModels(provider,key),protocol,
    wireApi:protocol==='openai_responses'?'responses':'chat_completions',
    identityService:protocol==='anthropic_messages'?'anthropic':'openai',
    credentialKind:providerKeyCredentialKind(provider,key)}
}

// URL hostnames are case insensitive; provider paths and model names are not.
export function providerEndpoint(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
