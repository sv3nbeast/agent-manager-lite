import { z } from 'zod'
import type { AccountProxyView } from './accountProxy'

export const upstreamProxyModeSchema = z.enum(['inherit', 'direct', 'custom'])
export const upstreamProxyInputSchema = z.object({
  revision: z.number().int().nonnegative(), mode: upstreamProxyModeSchema,
  url: z.string().max(8192).optional()
}).strict()
export const upstreamProxyProbeSchema = upstreamProxyInputSchema.extend({
  requestId: z.string().uuid(), mode: z.enum(['saved', 'inherit', 'direct', 'custom'])
}).strict()
export type UpstreamProxyInput = z.infer<typeof upstreamProxyInputSchema>
export type UpstreamProxyProbeInput = z.infer<typeof upstreamProxyProbeSchema>
export interface UpstreamProxyView extends Omit<AccountProxyView, 'mode'> {
  revision: number; mode: z.infer<typeof upstreamProxyModeSchema>
}
