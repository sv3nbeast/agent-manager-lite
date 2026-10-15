import { z } from 'zod'
import { accountInputSchema, accountProtocolSchema } from './types'
import type { ProbeModel } from './providerProbe'

export const providerModelsInputSchema = z.object({
  requestId: z.string().uuid(),
  baseUrl: accountInputSchema.shape.baseUrl,
  apiKey: accountInputSchema.shape.apiKey.optional(),
  protocol: accountProtocolSchema.optional(),
  credentialKind: z.enum(['openai_api_key','anthropic_api_key','anthropic_bearer','gateway']).optional(),
  savedKey: z.object({providerId:z.string().uuid(),keyId:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().optional()
}).strict().refine(value => !(value.apiKey && value.savedKey), '只能选择一种密钥来源')
  .refine(value => value.savedKey || !value.protocol || !value.credentialKind || value.credentialKind==='gateway'
    || (value.protocol==='anthropic_messages')===value.credentialKind.startsWith('anthropic_'), '协议与密钥鉴权方式不匹配')
export type ProviderModelsInput = z.infer<typeof providerModelsInputSchema>
export interface ProviderModelsResult { requestId:string; models:ProbeModel[]; modelsTruncated:boolean }
