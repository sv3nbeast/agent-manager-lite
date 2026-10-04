import type { CreditUsage, QuotaWindow } from '../../shared/types'
import type { ProviderUsageWindow } from '../../shared/providerUsage'

export type QuotaTone = 'normal' | 'warning' | 'exhausted' | 'blocked' | 'unknown'
export interface QuotaWindowPresentation {
  id: string
  label: string
  fullLabel: string
  usedPercent?: number
  progress?: number
  percentage: string
  tone: QuotaTone
  state: string
  reset: string
  resetFull: string
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export function validQuotaTimestamp(value: unknown): value is number {
  return finite(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
}

/** Keep the system time zone, but never inherit an English renderer date format. */
export function formatQuotaDate(value: unknown, full = false, timeZone?: string): string {
  if (!validQuotaTimestamp(value)) return '时间未知'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', ...(timeZone ? { timeZone } : {})
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value ?? ''
  return `${full ? `${part('year')}年` : ''}${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')}`
}

export function formatQuotaAmount(value: unknown): string {
  return finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '未知'
}

export function sanitizedCredits(value: CreditUsage): CreditUsage {
  const result: CreditUsage = {}
  if (typeof value.unlimited === 'boolean') result.unlimited = value.unlimited
  for (const key of ['remaining', 'balance', 'limit', 'used', 'remainingPercent'] as const) {
    if (finite(value[key])) result[key] = value[key]
  }
  if (validQuotaTimestamp(value.resetsAt)) result.resetsAt = value.resetsAt
  return result
}

export function creditSummary(value: CreditUsage): string {
  const clean = sanitizedCredits(value)
  return clean.unlimited ? '不限量' : `剩余 ${formatQuotaAmount(clean.remaining ?? clean.balance)}`
}

export function quotaWindowPresentation(window: QuotaWindow): QuotaWindowPresentation {
  const known = finite(window.usedPercent) && window.usedPercent >= 0
  const usedPercent = known ? window.usedPercent : undefined
  const duration = finite(window.durationSeconds) && window.durationSeconds > 0 ? window.durationSeconds : undefined
  const hours = duration === undefined ? undefined : duration / 3600
  const durationLabel = hours === undefined ? '' : hours >= 24
    ? `${Number((hours / 24).toFixed(1))} 天`
    : `${Number(hours.toFixed(1))} 小时`
  const fullLabel = durationLabel ? `${window.name}（${durationLabel}）` : window.name
  const isMain = window.id.startsWith('main.') || ['短周期', '周周期'].includes(window.name)
  const label = durationLabel && isMain ? durationLabel : fullLabel
  const tone: QuotaTone = window.limitReached || (usedPercent ?? -1) >= 100 ? 'exhausted'
    : window.allowed === false ? 'blocked'
    : (usedPercent ?? -1) >= 90 ? 'warning'
    : usedPercent === undefined ? 'unknown' : 'normal'
  const state = tone === 'exhausted' ? '已耗尽' : tone === 'blocked' ? '暂不可用'
    : tone === 'warning' ? '接近上限' : tone === 'unknown' ? '待查询' : '已用'
  return {
    id: window.id, label, fullLabel, usedPercent,
    progress: usedPercent === undefined ? undefined : Math.min(100, usedPercent),
    percentage: usedPercent === undefined ? '未知' : `${Number(usedPercent.toFixed(1))}%`,
    tone, state,
    reset: validQuotaTimestamp(window.resetsAt) ? `${formatQuotaDate(window.resetsAt)} 重置` : '重置时间未知',
    resetFull: validQuotaTimestamp(window.resetsAt) ? `${formatQuotaDate(window.resetsAt, true)} 重置` : '重置时间未知'
  }
}

/** Highlight the main short/week windows; retain every other window in details. */
export function primaryQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const selected: QuotaWindow[] = []
  for (const id of ['main.primary_window', 'main.secondary_window']) {
    const window = windows.find(entry => entry.id === id)
    if (window) selected.push(window)
  }
  for (const window of windows) {
    if (selected.length === 2) break
    if (!selected.includes(window)) selected.push(window)
  }
  return selected
}

export function providerWindowPresentation(window: ProviderUsageWindow): QuotaWindowPresentation {
  const remainingKnown = finite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100
  return quotaWindowPresentation({
    id: window.id, name: window.name, resetsAt: window.resetsAt,
    usedPercent: remainingKnown ? Number((100 - window.remainingPercent!).toFixed(4)) : undefined
  })
}

export function availableResetCount(value: unknown): string {
  return finite(value) && Number.isSafeInteger(value) && value >= 0 ? `${value} 次` : '未知'
}
