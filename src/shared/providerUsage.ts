import { z } from 'zod'

export const integrationTypeSchema = z.enum(['auto', 'sub2api', 'new_api'])
export type IntegrationType = z.infer<typeof integrationTypeSchema>
export const integrationTypeOptions = [
  { label: '自动识别', value: 'auto' },
  { label: 'Sub2API', value: 'sub2api' },
  { label: 'New API', value: 'new_api' }
]
export const providerUsageInputSchema = z.object({
  providerId:z.string().uuid(),revision:z.number().int().nonnegative(),
  keyIds:z.array(z.string().uuid()).min(1).max(10000)
}).strict()
export type ProviderUsageInput = z.infer<typeof providerUsageInputSchema>
export interface ProviderUsageRefresh {
  runId?:string;providerId?:string;running:boolean;cancelled:boolean
  total:number;completed:number;failed:number;activeKeyIds:string[];error?:string
}

// API-provider balances are separate from ChatGPT rate-limit windows. They must
// not be interpreted as OAuth scheduling eligibility or a guessed currency.
export interface ProviderUsageWindow {
  id: string
  name: string
  remainingPercent?: number
  limit?: number
  remaining?: number
  used?: number
  resetsAt?: number
}
export interface ProviderUsage {
  source: 'sub2api' | 'new_api' | 'deepseek' | 'minimax' | 'zhipu'
  updatedAt: number
  unit?: string
  remaining?: number
  balance?: number
  limit?: number
  used?: number
  unlimited?: boolean
  isValid?: boolean
  expiresAt?: number
  accessUntil?: number
  todayRequests?: number
  todayTokens?: number
  todayCost?: number
  totalRequests?: number
  totalTokens?: number
  totalCost?: number
  grantedBalance?: number
  toppedUpBalance?: number
  planName?: string
  modelName?: string
  windows?: ProviderUsageWindow[]
}
export const providerUsageNames: Record<ProviderUsage['source'], string> = {sub2api:'Sub2API',new_api:'New API',deepseek:'DeepSeek',minimax:'MiniMax',zhipu:'智谱 / Z.ai'}
export interface ProviderUsageState {
  summary?: ProviderUsage
  checkedAt: number
  error?: string
  unavailable?: boolean
}
