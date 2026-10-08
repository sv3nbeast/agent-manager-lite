import { agentClientTypeSchema } from '../shared/agentClients'
import type { InstanceModelDefaults } from '../shared/instances'
import { nativeModelDefinitions } from './modelCatalog'

/** Read-only defaults, independent of account credentials or provider catalogs. */
export function readInstanceModelDefaults(input: unknown): InstanceModelDefaults {
  agentClientTypeSchema.parse(input)
  const models = nativeModelDefinitions().map(model => model.modelId)
  return { models, defaultModelId: models[0] ?? null }
}
