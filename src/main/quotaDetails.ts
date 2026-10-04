// Numeric projection of Cockpit ee816002 src/types/codex.ts monthly credits.
// Keep spend-control and credits separate: they can coexist with different limits.
import type { CreditUsage } from '../shared/types'
import { object } from './network'

export function quotaField(raw: unknown, key: string): unknown {
  return Object.entries(object(raw)).find(([name]) => name.toLowerCase() === key)?.[1]
}
export function quotaNumber(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return Number.isFinite(value) ? value : undefined
}
function quotaBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0
  if (typeof raw === 'string') {
    if (['true', '1', 'yes'].includes(raw.trim().toLowerCase())) return true
    if (['false', '0', 'no'].includes(raw.trim().toLowerCase())) return false
  }
}
function dateMillis(raw: number | undefined): number | undefined {
  return raw !== undefined && raw > 0 && raw <= 8_640_000_000_000_000 ? raw : undefined
}
export function parseCreditUsage(raw: unknown, spendLimit: boolean, now: number): CreditUsage | undefined {
  const read = (key: string) => quotaNumber(quotaField(raw, key))
  const unlimited = quotaBoolean(quotaField(raw, 'unlimited'))
  const balance = spendLimit ? undefined : read('balance')
  const limit = spendLimit ? read('limit') : undefined
  const used = spendLimit ? read('used') : undefined
  const remaining = read('remaining') ?? balance ?? (limit !== undefined && used !== undefined ? quotaNumber(Math.max(0, limit - used)) : undefined)
  const percentage = spendLimit ? read('remaining_percent') ?? (limit !== undefined && limit > 0 && remaining !== undefined ? quotaNumber(remaining / limit * 100) : undefined) : undefined
  if ([unlimited, balance, limit, used, remaining, percentage].every(value => value === undefined)) return
  const absolute = spendLimit ? read('reset_at') : undefined
  const relative = spendLimit ? read('reset_after_seconds') : undefined
  const resetsAt = dateMillis(absolute !== undefined && absolute > 0 ? (absolute > 10_000_000_000 ? absolute : absolute * 1000) : undefined)
    ?? dateMillis(relative !== undefined && relative >= 0 ? now + relative * 1000 : undefined)
  return { unlimited, balance, limit, used, remaining, remainingPercent: percentage === undefined ? undefined : Math.max(0, Math.min(100, percentage)), resetsAt }
}
