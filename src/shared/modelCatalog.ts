import { z } from 'zod'

export const modelIdSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/)
export const modelDefinitionSchema = z.object({
  modelId: modelIdSchema,
  displayName: z.string().trim().min(1).max(100),
  reasoningEfforts: z.array(z.string().trim().min(1).max(40)).max(16).nullable().default(null),
  contextWindow: z.number().int().min(2).max(100_000_000).nullable().default(null),
  autoCompactTokenLimit: z.number().int().min(1).max(100_000_000).nullable().default(null),
  supportsVision: z.boolean().nullable().default(null)
}).strict().superRefine((model, ctx) => {
  if (model.autoCompactTokenLimit !== null && (model.contextWindow === null || model.autoCompactTokenLimit >= model.contextWindow)) {
    ctx.addIssue({ code: 'custom', path: ['autoCompactTokenLimit'], message: '压缩阈值需要上下文窗口，且必须小于窗口' })
  }
})
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>
export const modelDefinitionsSchema = z.array(modelDefinitionSchema).min(1).max(500).superRefine((models, ctx) => {
  const ids = new Set<string>()
  models.forEach((model, index) => {
    const id = model.modelId.toLowerCase()
    if (ids.has(id)) ctx.addIssue({ code: 'custom', path: [index, 'modelId'], message: '模型 ID 重复' })
    ids.add(id)
  })
})
const target = { id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) }
export const previewModelCatalogSchema = z.discriminatedUnion('enabled', [
  z.object({ ...target, enabled: z.literal(true), models: modelDefinitionsSchema, defaultModelId: modelIdSchema.nullable(), reset: z.boolean().default(false), importTicket: z.string().uuid().optional() }).strict(),
  // Stale editor fields are deliberately ignored on explicit opt-out.
  z.object({ ...target, enabled: z.literal(false), models: z.unknown().optional(), defaultModelId: z.unknown().optional() }).strict()
])
export type ModelCatalogInput = z.input<typeof previewModelCatalogSchema>
export interface ModelCapability {
  modelId: string; reasoningEfforts: string[]; contextWindow?: number; autoCompactTokenLimit?: number
  supportsVision: boolean; fast: boolean; source: 'catalog' | 'template'
}
export interface ModelCatalogView {
  revision: string; source: 'official' | 'external' | 'managed'; reference?: string; models: ModelDefinition[]
  capabilities: ModelCapability[]; defaults: ModelDefinition[]; defaultCapabilities: ModelCapability[]; defaultModelId: string | null
  customized: boolean; error?: string
}
export interface CatalogImport { ticket: string; models: ModelDefinition[]; capabilities: ModelCapability[]; fileName: string }
