export const modelContextWindowPresets = [
  { label: '32K · 32,000 tokens', value: 32_000 },
  { label: '64K · 64,000 tokens', value: 64_000 },
  { label: '128K · 128,000 tokens', value: 128_000 },
  { label: '200K · 200,000 tokens', value: 200_000 },
  { label: '256K · 256,000 tokens', value: 256_000 },
  { label: '400K · 400,000 tokens', value: 400_000 },
  { label: '512K · 512,000 tokens', value: 512_000 },
  { label: '1M · 1,000,000 tokens', value: 1_000_000 }
] as const

export type ModelContextChoice = number | 'default' | 'custom'
export interface ModelContextDefault {
  modelId: string
  contextWindow: number
  source: 'catalog' | 'template'
}

export function formatModelContextWindow(value: number): string {
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return `${value.toLocaleString('en-US')} tokens`
}

export function getModelContextWindow(current: Record<string, number> | undefined, model: string): number | undefined {
  return current && Object.hasOwn(current, model) ? current[model] : undefined
}

export function modelContextChoice(value: number | undefined): ModelContextChoice {
  if (value === undefined) return 'default'
  return modelContextWindowPresets.some(preset => preset.value === value) ? value : 'custom'
}

/** Updating visible models preserves declarations for models outside the selection. */
export function setModelContextWindow(current: Record<string, number> | undefined, models: string[], value: number | undefined): Record<string, number> | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 2 || value > 10_000_000)) throw new Error('上下文窗口需为 2 至 10,000,000 的整数')
  const next = { ...(current ?? {}) }
  for (const model of models) {
    if (value === undefined) delete next[model]
    else Object.defineProperty(next, model, {value, enumerable: true, configurable: true, writable: true})
  }
  return Object.keys(next).length ? next : undefined
}
