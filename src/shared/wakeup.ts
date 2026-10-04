import { z } from 'zod'

export const wakeupScheduleKindSchema = z.enum(['startup', 'daily', 'weekly', 'interval', 'quota_reset'])
export type WakeupScheduleKind = z.infer<typeof wakeupScheduleKindSchema>

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间必须为 HH:mm')
export const wakeupScheduleSchema = z.object({
  kind: wakeupScheduleKindSchema,
  dailyTime: clock.optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  weeklyTime: clock.optional(),
  intervalHours: z.number().int().min(1).max(24 * 31).optional(),
  quotaResetWindow: z.enum(['either', 'primary_window', 'secondary_window']).optional(),
  startupDelayMinutes: z.number().int().min(0).max(24 * 60).optional()
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'daily' && !value.dailyTime) ctx.addIssue({ code: 'custom', path: ['dailyTime'], message: '每日任务需要时间' })
  if (value.kind === 'weekly' && (!value.weeklyTime || !value.weeklyDays.length)) ctx.addIssue({ code: 'custom', path: ['weeklyTime'], message: '每周任务需要日期和时间' })
  if (value.kind === 'interval' && !value.intervalHours) ctx.addIssue({ code: 'custom', path: ['intervalHours'], message: '间隔任务需要小时数' })
  if (value.kind === 'startup' && value.startupDelayMinutes === undefined) ctx.addIssue({ code: 'custom', path: ['startupDelayMinutes'], message: '启动任务需要延迟分钟数' })
})
export type WakeupSchedule = z.infer<typeof wakeupScheduleSchema>

export const wakeupReasoningSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional()
export const wakeupTaskInputSchema = z.object({
  id: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  accountIds: z.array(z.string().uuid()).min(1).max(100),
  prompt: z.string().trim().min(1).max(16000),
  model: z.string().trim().min(1).max(200).optional(),
  modelReasoningEffort: wakeupReasoningSchema,
  schedule: wakeupScheduleSchema
}).strict()
export type WakeupTaskInput = z.infer<typeof wakeupTaskInputSchema>

export interface WakeupTask extends WakeupTaskInput {
  id: string
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastStatus?: 'running' | 'success' | 'error' | 'cancelled'
  lastMessage?: string
  lastSuccessCount?: number
  lastFailureCount?: number
  lastDurationMs?: number
  nextRunAt?: number
}

export interface WakeupHistoryItem {
  id: string
  runId: string
  timestamp: number
  triggerType: 'startup' | 'scheduled' | 'quota_reset' | 'manual_task'
  taskId: string
  taskName: string
  accountId: string
  accountName: string
  accountEmail?: string
  success: boolean
  model?: string
  modelReasoningEffort?: string
  reply?: string
  error?: string
  durationMs: number
}

export interface WakeupView {
  enabled: boolean
  tasks: WakeupTask[]
  history: WakeupHistoryItem[]
  runningTaskIds: string[]
  lastError?: string
}

export interface StoredWakeupState {
  enabled: boolean
  tasks: WakeupTask[]
  history: WakeupHistoryItem[]
}

const minutes = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function localDateAt(date: Date, minute: number): number {
  const candidate = new Date(date)
  candidate.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
  return candidate.getTime()
}

export function nextWakeupRunAt(task: Pick<WakeupTask, 'schedule' | 'lastRunAt' | 'createdAt'>, now = Date.now(), resetTimes: number[] = []): number | undefined {
  const schedule = task.schedule
  const current = new Date(now)
  if (schedule.kind === 'startup') return undefined
  if (schedule.kind === 'interval') return (task.lastRunAt ?? task.createdAt) + (schedule.intervalHours ?? 1) * 3600_000
  if (schedule.kind === 'quota_reset') return resetTimes.filter(value => value > now).sort((a, b) => a - b)[0]
  const target = minutes(schedule.kind === 'daily' ? schedule.dailyTime : schedule.weeklyTime)
  if (target === undefined) return undefined
  const maxDays = schedule.kind === 'weekly' ? 14 : 8
  for (let offset = 0; offset <= maxDays; offset++) {
    const date = new Date(current)
    date.setDate(current.getDate() + offset)
    if (schedule.kind === 'weekly' && !schedule.weeklyDays.includes(date.getDay())) continue
    const candidate = localDateAt(date, target)
    if (candidate > now) return candidate
  }
  return undefined
}

export function dueWakeupAt(task: Pick<WakeupTask, 'schedule' | 'lastRunAt' | 'createdAt'>, now = Date.now(), resetTimes: number[] = []): number | undefined {
  const schedule = task.schedule
  if (schedule.kind === 'startup') return undefined
  if (schedule.kind === 'interval') {
    const due = (task.lastRunAt ?? task.createdAt) + (schedule.intervalHours ?? 1) * 3600_000
    return due <= now ? due : undefined
  }
  if (schedule.kind === 'quota_reset') {
    const previous = task.lastRunAt ?? task.createdAt
    return resetTimes.filter(value => value > previous && value <= now).sort((a, b) => b - a)[0]
  }
  const target = minutes(schedule.kind === 'daily' ? schedule.dailyTime : schedule.weeklyTime)
  if (target === undefined) return undefined
  const date = new Date(now)
  const candidate = localDateAt(date, target)
  if (schedule.kind === 'weekly' && !schedule.weeklyDays.includes(date.getDay())) return undefined
  if (candidate <= now && (task.lastRunAt ?? 0) < candidate) return candidate
  return undefined
}

export function normalizeWakeupTask(input: WakeupTaskInput, now = Date.now()): WakeupTask {
  const parsed = wakeupTaskInputSchema.parse(input)
  return { ...parsed, id: parsed.id ?? crypto.randomUUID(), createdAt: now, updatedAt: now }
}
