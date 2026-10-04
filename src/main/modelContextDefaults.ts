import { z } from 'zod'
import type { ModelContextDefault } from '../shared/modelContextWindows'
import { templateFor } from './modelCatalog'

const modelsSchema = z.array(z.string().trim().min(1).max(200)).max(500)

/** Use the same client catalog templates used when generating Codex model entries. */
export function readModelContextDefaults(raw: unknown): ModelContextDefault[] {
  return [...new Set(modelsSchema.parse(raw))].map(modelId => {
    const { model, known } = templateFor(modelId)
    const contextWindow = model.context_window
    if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 1) {
      throw new Error('模型目录缺少有效的上下文默认值')
    }
    return { modelId, contextWindow, source: known ? 'catalog' : 'template' }
  })
}
