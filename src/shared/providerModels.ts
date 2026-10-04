import { z } from 'zod'
import { accountInputSchema } from './types'
import type { ProbeModel } from './providerProbe'

export const providerModelsInputSchema = z.object({
  requestId: z.string().uuid(),
  baseUrl: accountInputSchema.shape.baseUrl,
  apiKey: accountInputSchema.shape.apiKey.optional(),
  savedKey: z.object({providerId:z.string().uuid(),keyId:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().optional()
}).strict().refine(value => !(value.apiKey && value.savedKey), '只能选择一种密钥来源')
export type ProviderModelsInput = z.infer<typeof providerModelsInputSchema>
export interface ProviderModelsResult { requestId:string; models:ProbeModel[]; modelsTruncated:boolean }
