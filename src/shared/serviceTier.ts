import type { TierMode, DefaultTier } from './types'

const supported = new Set(['priority', 'default', 'auto', 'flex', 'scale', 'ultrafast'])
export interface TierResolution { tier?: string; source: 'request' | 'instance' | 'account' | 'provider' | 'global' | 'follow' }

// Empty values are unspecified; invalid values are rejected rather than silently upgraded.
export function resolveServiceTier(incoming: unknown, global: TierMode, provider?: DefaultTier, instance?: DefaultTier, account?: DefaultTier): TierResolution {
  if (typeof incoming === 'string') incoming = incoming.trim()
  if (incoming !== undefined && incoming !== null && incoming !== '') {
    if (typeof incoming !== 'string') throw new Error('service_tier 必须为字符串')
    const tier = incoming === 'fast' ? 'priority' : incoming
    if (!supported.has(tier)) throw new Error(`不支持的 service_tier: ${tier}`)
    return { tier, source: 'request' }
  }
  const source = instance && instance !== 'inherit' ? 'instance' : account && account !== 'inherit' ? 'account' : provider && provider !== 'inherit' ? 'provider' : 'global'
  const mode = source === 'instance' ? instance : source === 'account' ? account : source === 'provider' ? provider : global
  if (mode === 'follow') return { source: 'follow' }
  return { tier: mode === 'fast' ? 'priority' : mode === 'auto' || mode === 'flex' ? mode : 'default', source }
}
