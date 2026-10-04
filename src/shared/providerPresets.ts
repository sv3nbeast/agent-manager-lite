export interface ProviderPreset {
  id: string
  name: string
  baseUrls: string[]
  modelCatalog?: string[]
  visionModelCatalog?: string[]
  website?: string
  apiKeyUrl?: string
  isOfficial?: boolean
}

// Frozen, offline presets adapted from Cockpit's codexProviderPresets.ts. The
// list is deliberately small and stable: selecting a preset never performs a
// network request or silently creates an account.
export const providerPresets: readonly ProviderPreset[] = [
  { id: 'openai_official', name: 'OpenAI 官方', baseUrls: ['https://api.openai.com/v1'], website: 'https://chatgpt.com/codex', apiKeyUrl: 'https://platform.openai.com/api-keys', isOfficial: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrls: ['https://api.deepseek.com', 'https://api.deepseek.com/v1'], modelCatalog: ['deepseek-flash', 'deepseek-v4-pro'], visionModelCatalog: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], website: 'https://platform.deepseek.com/', apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', baseUrls: ['https://openrouter.ai/api/v1'], modelCatalog: ['openai/gpt-5.6-luna-pro'], website: 'https://openrouter.ai/', apiKeyUrl: 'https://openrouter.ai/keys' },
  { id: 'opencode_go', name: 'OpenCode Go', baseUrls: ['https://opencode.ai/zen/go/v1'], modelCatalog: ['minimax-m3', 'kimi-k3', 'glm-5.2', 'deepseek-v4-pro', 'grok-4.5'], website: 'https://opencode.ai/', apiKeyUrl: 'https://opencode.ai/auth' },
  { id: 'zhipu_glm', name: '智谱 GLM', baseUrls: ['https://open.bigmodel.cn/api/coding/paas/v4'], modelCatalog: ['glm-5.1'], website: 'https://open.bigmodel.cn', apiKeyUrl: 'https://www.bigmodel.cn/claude-code' },
  { id: 'custom', name: '自定义服务商', baseUrls: [] }
]

export function providerPreset(id: string | undefined): ProviderPreset | undefined {
  return providerPresets.find(value => value.id === id)
}

export function providerPresetForBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.replace(/\/+$/, '').toLowerCase()
  return providerPresets.find(preset => preset.baseUrls.some(value => value.replace(/\/+$/, '').toLowerCase() === normalized))
}
