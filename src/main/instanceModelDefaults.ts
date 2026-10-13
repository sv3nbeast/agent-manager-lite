import { agentClientTypeSchema } from '../shared/agentClients'
import type { InstanceModelDefaults } from '../shared/instances'
import { nativeModelDefinitions } from './modelCatalog'

/** Read-only defaults, independent of account credentials or provider catalogs. */
export function readInstanceModelDefaults(input: unknown): InstanceModelDefaults {
  const clientType = agentClientTypeSchema.parse(input)
  // Anthropic and gateway model IDs come from the selected connection. Never
  // present Codex's catalog as Claude's official or default model inventory.
  if (clientType === 'claude_code') return { models: [], defaultModelId: null }
  const models = nativeModelDefinitions().map(model => model.modelId)
  return { models, defaultModelId: models[0] ?? null }
}
