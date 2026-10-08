// Adapted from Cockpit ee816002: codex_protocol.rs and
// codex_account_model_catalog.rs. Source/attribution: THIRD_PARTY_NOTICES.md.
import embedded from '../../sidecars/codex-proxy/third_party/CLIProxyAPI/internal/registry/models/codex_client_models.json'
import { z } from 'zod'
import { modelDefinitionsSchema, modelDefinitionSchema, type ModelDefinition, type ModelCapability } from '../shared/modelCatalog'

export type NativeModel = Record<string, unknown> & { slug: string }
export interface NativeCatalog extends Record<string, unknown> { models: NativeModel[] }
const nativeModelsSchema = z.array(z.object({ slug: z.string().min(1).max(128) }).passthrough()).min(1).max(512)
const nativeSchema = z.object({ models: nativeModelsSchema, model_overrides: z.array(z.object({ slug: z.string().min(1).max(128) }).passthrough()).max(512).optional() }).passthrough()
const clientEntrySchema = z.object({
  slug:z.string().min(1),display_name:z.string().min(1),description:z.string().min(1),base_instructions:z.string().min(1),
  minimal_client_version:z.string().min(1),visibility:z.string().min(1),default_reasoning_level:z.string().min(1),
  context_window:z.number().int().positive(),max_context_window:z.number().int().positive(),priority:z.number().int().nonnegative(),
  supported_reasoning_levels:z.array(z.object({effort:z.string().min(1)}).passthrough()).min(1)
}).passthrough().superRefine((model,ctx)=>{
  if(model.context_window>model.max_context_window || !model.supported_reasoning_levels.some(level=>level.effort===model.default_reasoning_level)
    || new Set(model.supported_reasoning_levels.map(level=>level.effort)).size!==model.supported_reasoning_levels.length) ctx.addIssue({code:'custom',message:'模型能力声明不一致'})
})
export const builtInCatalog: NativeCatalog = structuredClone(embedded)
const reserveId = 'gpt-reserve'
const metadataSchema = z.object({ version: z.literal(1), customized: z.literal(true), definitions: modelDefinitionsSchema,
  previousModel: z.string().max(4096).nullable(), managedModel: z.string().max(4096).nullable(), basis: nativeSchema, recoveryId:z.string().uuid().optional() }).strict()

export function parseNativeCatalog(content: string): NativeCatalog {
  try {
    const catalog = nativeSchema.parse(JSON.parse(content))
    const ids = new Set<string>()
    for (const model of catalog.models) {
      if (ids.has(model.slug.toLowerCase())) throw new Error('duplicate')
      ids.add(model.slug.toLowerCase())
    }
    const overrideIds = new Set<string>()
    for (const override of catalog.model_overrides ?? []) {
      if (overrideIds.has(override.slug.toLowerCase())) throw new Error('duplicate override')
      overrideIds.add(override.slug.toLowerCase())
      const existing = catalog.models.find(model => model.slug.toLowerCase() === override.slug.toLowerCase())
      if (existing) Object.assign(existing, override)
      else catalog.models.push(override)
    }
    if (catalog.models.length > 512) throw new Error('too many models')
    for (const model of catalog.models) clientEntrySchema.parse(model)
    return catalog
  } catch { throw new Error('模型目录 JSON 无效或包含重复模型，原文件已保留') }
}
export function catalogMetadata(catalog: NativeCatalog) { return catalog._codex_manager_lite ? metadataSchema.safeParse(catalog._codex_manager_lite).data : undefined }
function levels(model: NativeModel): Record<string, unknown>[] {
  return Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter((level): level is Record<string,unknown> => !!level && typeof level === 'object' && typeof level.effort === 'string') : []
}
function builtin(modelId: string): { model: NativeModel; known: boolean } {
  const id = modelId.toLowerCase()
  const match = builtInCatalog.models.find(model => model.slug.toLowerCase() === (id === reserveId ? 'gpt-5.6-luna' : id))
  return { model: structuredClone(match ?? builtInCatalog.models.find(model => model.slug === 'gpt-5.5')!), known: !!match }
}
export function templateFor(modelId: string, base: NativeCatalog = builtInCatalog): { model: NativeModel; known: boolean } {
  const existing = base.models.find(model => model.slug.toLowerCase() === modelId.toLowerCase())
  if (existing) return {model:structuredClone(existing),known:true}
  const template = builtin(modelId), model = template.model
  if (!template.known) {
    Object.assign(model, { context_window: 272000, max_context_window: 272000, auto_compact_token_limit: 244800, additional_speed_tiers: [], service_tiers: [] })
    const parts = modelId.split('/')
    if (parts.length === 2 && parts[0] && parts[1].startsWith('gpt-')) {
      const routed = builtin(parts[1])
      if (routed.known) for (const field of ['supported_reasoning_levels','default_reasoning_level','service_tiers','additional_speed_tiers','context_window','max_context_window','auto_compact_token_limit']) {
        if (routed.model[field] !== undefined) model[field] = structuredClone(routed.model[field])
      }
    }
  }
  return { model, known: template.known }
}
function compact(model: NativeModel): void {
  const window = model.context_window, threshold = model.auto_compact_token_limit
  if (typeof window === 'number' && Number.isSafeInteger(window) && window > 1 && !(typeof threshold === 'number' && threshold > 0 && threshold < window)) model.auto_compact_token_limit = Math.floor(window * 0.9)
}
export function summarizeCatalog(catalog: NativeCatalog): ModelDefinition[] {
  const metadata = catalogMetadata(catalog)
  if (metadata) return structuredClone(metadata.definitions)
  return modelDefinitionsSchema.parse(catalog.models.filter(model => model.visibility !== 'hide').map(model => {
    return { modelId: model.slug, displayName: typeof model.display_name === 'string' ? model.display_name : model.slug,
      reasoningEfforts: null, contextWindow: null, autoCompactTokenLimit: null, supportsVision: null }
  }))
}
export function catalogCapabilities(models: ModelDefinition[], base: NativeCatalog): ModelCapability[] {
  base = catalogMetadata(base)?.basis ?? base
  return models.map(definition => {
    const { model, known } = templateFor(definition.modelId, base)
    return { modelId: definition.modelId, reasoningEfforts: levels(model).map(level => String(level.effort)),
      contextWindow: typeof model.context_window === 'number' ? model.context_window : undefined,
      autoCompactTokenLimit: typeof model.auto_compact_token_limit === 'number' ? model.auto_compact_token_limit : undefined,
      supportsVision: Array.isArray(model.input_modalities) && model.input_modalities.includes('image'),
      fast: Array.isArray(model.service_tiers) && model.service_tiers.some(tier => !!tier && typeof tier === 'object' && 'id' in tier && tier.id === 'priority'), source: known ? 'catalog' : 'template' }
  })
}
export function defaultModelDefinitions(): ModelDefinition[] {
  const order = ['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna']
  const definitions = summarizeCatalog(builtInCatalog).sort((a,b) => (order.indexOf(a.modelId) < 0 ? 99 : order.indexOf(a.modelId)) - (order.indexOf(b.modelId) < 0 ? 99 : order.indexOf(b.modelId)))
  definitions.push(modelDefinitionSchema.parse({modelId:reserveId,displayName:'GPT-5.6 Reserve'}))
  return definitions
}
// Native identities have no provider model list. Use only visible entries in
// the client catalog; generated routing templates such as Reserve are not
// native account recommendations.
export function nativeModelDefinitions(): ModelDefinition[] {
  const catalog = { ...builtInCatalog, models: builtInCatalog.models.filter(model=>model.visibility==='list').sort((a,b) => Number(a.priority) - Number(b.priority)) }
  return summarizeCatalog(catalog)
}
export function buildModelCatalog(input: ModelDefinition[], base: NativeCatalog, previousModel: string | null, managedModel: string | null): NativeCatalog {
  base = structuredClone(catalogMetadata(base)?.basis ?? base)
  delete base._codex_manager_lite
  const definitions = modelDefinitionsSchema.parse(input).map(model => ({...model,
    reasoningEfforts: model.reasoningEfforts?.length ? [...new Set(model.reasoningEfforts.map(effort => effort.trim().toLowerCase()))] : null,
    autoCompactTokenLimit: model.contextWindow === null ? null : model.autoCompactTokenLimit ?? Math.floor(model.contextWindow * 0.9) }))
  if (!definitions.some(model => model.modelId.toLowerCase() === reserveId)) {
    if (definitions.length >= 500) throw new Error('目录最多包含 500 个可见模型（含 Reserve）')
    definitions.push(modelDefinitionSchema.parse({modelId:reserveId,displayName:'GPT-5.6 Reserve'}))
  }
  const models = definitions.map((definition, index) => {
    const {model} = templateFor(definition.modelId, base)
    Object.assign(model, {slug:definition.modelId, display_name:definition.displayName, description:definition.displayName,
      visibility:'list', supported_in_api:true, availability_nux:null, upgrade:null, comp_hash:'3000'})
    // This editor exposes explicit ordering; priorities must match the saved
    // order for known models as well as generic/routed templates.
    model.priority = 1000 + index
    const providerModelId = definition.modelId.split('/').at(-1)?.toLowerCase()
    if (['deepseek-flash','deepseek-v4-flash','deepseek-v4-pro'].includes(providerModelId ?? '')) model.multi_agent_version = 'v2'
    if (['grok-4.6','grok-4.5','grok-4.3'].includes(definition.modelId.toLowerCase())) Object.assign(model,{multi_agent_version:'v2',minimal_client_version:'0.144.0'})
    if (definition.reasoningEfforts) {
      const supported = levels(model), selected = definition.reasoningEfforts.map(effort => supported.find(level => level.effort === effort))
      if (selected.some(level => !level)) throw new Error(`模型 ${definition.modelId} 的推理档位不在目录声明中`)
      model.supported_reasoning_levels = selected
      if (!definition.reasoningEfforts.includes(String(model.default_reasoning_level))) model.default_reasoning_level = definition.reasoningEfforts[0]
    }
    if (definition.contextWindow !== null) Object.assign(model, {context_window:definition.contextWindow,max_context_window:definition.contextWindow,auto_compact_token_limit:definition.autoCompactTokenLimit})
    if (definition.supportsVision !== null) {
      const modalities = Array.isArray(model.input_modalities) ? model.input_modalities.filter(mode => mode !== 'image') : ['text']
      model.input_modalities = definition.supportsVision ? [...modalities,'image'] : modalities
    }
    compact(model)
    return model
  })
  for (const hidden of base.models.filter(model => model.visibility === 'hide')) if (!models.some(model => model.slug.toLowerCase() === hidden.slug.toLowerCase())) models.push(structuredClone(hidden))
  if (models.length>512) throw new Error('模型目录总条目超过 512（含隐藏模型）')
  const result = {...structuredClone(base),models,_codex_manager_lite:{version:1,customized:true,definitions,previousModel,managedModel,basis:base}}
  // Keep clients that read model_overrides on the same curated catalog, after
  // preserving the source override fields in each generated entry.
  if (base.model_overrides) (result as NativeCatalog).model_overrides = structuredClone(models)
  for (const model of result.models) clientEntrySchema.parse(model)
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) throw new Error('生成的模型目录超过 16 MiB，请减少条目或使用更小的模型模板')
  return result
}
export function parseCatalogImport(content: string): NativeCatalog {
  let input: unknown
  try { input = JSON.parse(content) } catch { throw new Error('模型目录 JSON 格式错误') }
  const models = Array.isArray(input) ? input : input && typeof input === 'object' && 'models' in input ? input.models : undefined
  if (Array.isArray(models) && models.length && models.every(model => model && typeof model === 'object' && 'model_id' in model)) {
    const definitions = modelDefinitionsSchema.parse(models.map(model => ({modelId:model.model_id,displayName:model.display_name,
      reasoningEfforts:model.reasoning_efforts ?? null,contextWindow:model.context_window ?? null,autoCompactTokenLimit:model.auto_compact_token_limit ?? null,supportsVision:null})))
    return buildModelCatalog(definitions,builtInCatalog,null,null)
  }
  return parseNativeCatalog(content)
}
