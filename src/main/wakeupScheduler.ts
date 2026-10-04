import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Gateway } from './gateway'
import type { StoredAccount } from './store'
import { Store } from './store'
import { dueWakeupAt, nextWakeupRunAt, normalizeWakeupTask, wakeupTaskInputSchema, type StoredWakeupState, type WakeupHistoryItem, type WakeupTask, type WakeupTaskInput, type WakeupView } from '../shared/wakeup'

type GatewayFactory = (runId: string) => Gateway
type AccountPreparation = (accountId: string) => Promise<StoredAccount>

const defaultState = (): StoredWakeupState => ({ enabled: false, tasks: [], history: [] })
const publicTask = (task: WakeupTask): WakeupTask => structuredClone(task)
const safeMessage = (value: unknown): string => value instanceof Error ? value.message.slice(0, 240) : '任务执行失败'

/**
 * Electron adaptation of Cockpit's Codex wakeup scheduler.
 *
 * Each account run gets a private Gateway runtime and loopback port. This keeps
 * scheduled work independent from the user's long-running local API and makes
 * cancellation/cleanup deterministic. Only bounded response text and allow
 * listed status metadata are persisted; upstream bodies and credentials never
 * enter task history.
 */
export class WakeupScheduler {
  private timer?: NodeJS.Timeout
  private readonly startupTimers = new Set<NodeJS.Timeout>()
  private readonly runs = new Map<string, { controller: AbortController; task: Promise<void>; automatic: boolean }>()
  private stopped = false
  private lastError?: string

  constructor(
    private readonly store: Store,
    private readonly createGateway: GatewayFactory,
    private readonly prepareAccount: AccountPreparation,
    private readonly now: () => number = Date.now
  ) {}

  private state(): StoredWakeupState {
    const value = this.store.read().wakeup
    return value ? structuredClone(value) : defaultState()
  }

  private resetTimes(task: WakeupTask): number[] {
    const wanted = new Set(task.accountIds)
    const state = this.store.read()
    const values: number[] = []
    for (const account of state.accounts) {
      if (!wanted.has(account.id)) continue
      for (const window of account.quota?.windows ?? []) if (typeof window.resetsAt === 'number' && window.resetsAt > 0) values.push(window.resetsAt)
    }
    return [...new Set(values)]
  }

  private withNext(task: WakeupTask): WakeupTask {
    const next = nextWakeupRunAt(task, this.now(), this.resetTimes(task))
    return next === undefined ? (() => { const copy = structuredClone(task); delete copy.nextRunAt; return copy })() : { ...task, nextRunAt: next }
  }

  view(): WakeupView {
    const state = this.state()
    return { enabled: state.enabled, tasks: state.tasks.map(publicTask), history: structuredClone(state.history), runningTaskIds: [...this.runs.keys()], lastError: this.lastError }
  }

  running(): boolean { return this.runs.size > 0 }
  usesAccount(id: string): boolean {
    for (const taskId of this.runs.keys()) {
      if (this.state().tasks.find(task => task.id === taskId)?.accountIds.includes(id)) return true
    }
    return false
  }

  setEnabled(enabled: boolean): void {
    if (this.stopped) throw new Error('任务服务正在退出')
    this.store.transaction(state => { const current = state.wakeup ?? defaultState(); current.enabled = Boolean(enabled); state.wakeup = current })
    if (!enabled) for (const run of this.runs.values()) if (run.automatic) run.controller.abort()
    this.scheduleStartup()
  }

  save(raw: unknown): void {
    const input = wakeupTaskInputSchema.parse(raw)
    const state = this.store.read()
    const known = new Set(state.accounts.map(account => account.id))
    if (input.accountIds.some(id => !known.has(id))) throw new Error('任务引用了不存在的账号')
    this.store.transaction(next => {
      const current = next.wakeup ?? defaultState()
      if (input.id) {
        const task = current.tasks.find(value => value.id === input.id)
        if (!task) throw new Error('任务不存在')
        if (input.revision !== task.revision) throw new Error('任务已被修改，请重新读取')
        const updated: WakeupTask = this.withNext({ ...task, ...input, id: task.id, createdAt: task.createdAt, updatedAt: this.now(), revision: (task.revision ?? 0) + 1 })
        current.tasks = current.tasks.map(value => value.id === task.id ? updated : value)
      } else {
        const created = this.withNext({ ...normalizeWakeupTask(input, this.now()), revision: 0 })
        current.tasks.push(created)
      }
      next.wakeup = current
    })
    this.scheduleStartup()
  }

  delete(id: string): void {
    z.string().uuid().parse(id)
    this.runs.get(id)?.controller.abort()
    this.store.transaction(state => {
      const current = state.wakeup ?? defaultState()
      if (!current.tasks.some(task => task.id === id)) throw new Error('任务不存在')
      current.tasks = current.tasks.filter(task => task.id !== id)
      state.wakeup = current
    })
  }

  async runNow(id: string): Promise<void> {
    z.string().uuid().parse(id)
    const task = this.state().tasks.find(value => value.id === id)
    if (!task) throw new Error('任务不存在')
    await this.startRun(task, 'manual_task')
  }

  cancel(id: string): void {
    z.string().uuid().parse(id)
    const run = this.runs.get(id)
    if (!run) return
    run.controller.abort()
  }

  private async responseText(response: Response, signal: AbortSignal): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > 2 * 1024 * 1024) throw new Error('上游回复超过 2 MB')
        chunks.push(item.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (typeof value.output_text === 'string') return value.output_text.slice(0, 4000)
      const output = Array.isArray(value.output) ? value.output : []
      const texts: string[] = []
      for (const item of output) {
        if (!item || typeof item !== 'object') continue
        const content = (item as Record<string, unknown>).content
        if (!Array.isArray(content)) continue
        for (const part of content) if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') texts.push((part as Record<string, unknown>).text as string)
      }
      return texts.join('').slice(0, 4000)
    } catch { return raw.replace(/\s+/g, ' ').slice(0, 4000) }
  }

  private async runAccount(task: WakeupTask, account: StoredAccount, controller: AbortController, runId: string): Promise<WakeupHistoryItem> {
    const started = this.now()
    const gateway = this.createGateway(runId)
    const clientKey = `cml-wakeup-${randomUUID()}`
    try {
      const settings = this.store.read().settings
      const model = task.model || account.models[0] || 'gpt-5.5'
      const status = await gateway.start({ id: `wakeup:${task.id}:${account.id}`, port: 0, account, apiKey: clientKey, defaultTier: account.defaultTier }, settings, controller.signal)
      const response = await fetch(`http://127.0.0.1:${status.port}/v1/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${clientKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: task.prompt, stream: false }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1000, settings.streamOpenTimeoutSeconds * 1000 + settings.streamIdleTimeoutSeconds * 1000))])
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`上游请求失败（HTTP ${response.status}）`) }
      const reply = await this.responseText(response, controller.signal)
      return { id: randomUUID(), runId, timestamp: started, triggerType: 'manual_task', taskId: task.id, taskName: task.name, accountId: account.id, accountName: account.name, accountEmail: account.email, success: true, model, modelReasoningEffort: task.modelReasoningEffort, reply, durationMs: this.now() - started }
    } catch (error) {
      return { id: randomUUID(), runId, timestamp: started, triggerType: 'manual_task', taskId: task.id, taskName: task.name, accountId: account.id, accountName: account.name, accountEmail: account.email, success: false, model: task.model, modelReasoningEffort: task.modelReasoningEffort, error: controller.signal.aborted ? '任务已取消' : safeMessage(error), durationMs: this.now() - started }
    } finally { await gateway.stop().catch(() => {}) }
  }

  private async startRun(task: WakeupTask, trigger: WakeupHistoryItem['triggerType'], dueAt?: number): Promise<void> {
    if (this.runs.has(task.id)) throw new Error('任务正在运行，请先等待或取消当前运行')
    if (trigger !== 'manual_task' && (!this.state().enabled || !this.state().tasks.some(value => value.id === task.id && value.enabled))) return
    const controller = new AbortController(); const runId = randomUUID()
    const work = this.executeRun(task, trigger, dueAt, controller, runId)
    this.runs.set(task.id, { controller, task: work, automatic: trigger !== 'manual_task' })
    await work.finally(() => { if (this.runs.get(task.id)?.task === work) this.runs.delete(task.id) })
  }

  private async executeRun(task: WakeupTask, trigger: WakeupHistoryItem['triggerType'], dueAt: number | undefined, controller: AbortController, runId: string): Promise<void> {
    const claimed = this.store.read().wakeup?.tasks.find(value => value.id === task.id)
    if (!claimed) return
    this.store.transaction(state => {
      const current = state.wakeup ?? defaultState(); const value = current.tasks.find(item => item.id === task.id)
      if (value) { value.lastStatus = 'running'; value.lastRunAt = dueAt ?? this.now(); value.lastMessage = '正在执行'; value.updatedAt = this.now(); value.nextRunAt = undefined }
      state.wakeup = current
    })
    const records: WakeupHistoryItem[] = []
    for (const accountId of task.accountIds) {
      if (controller.signal.aborted) break
      let record: WakeupHistoryItem
      try {
        const account = await this.prepareAccount(accountId)
        record = await this.runAccount(task, account, controller, runId)
      } catch (error) {
        const account = this.store.read().accounts.find(value => value.id === accountId)
        record = { id: randomUUID(), runId, timestamp: this.now(), triggerType: trigger, taskId: task.id, taskName: task.name, accountId, accountName: account?.name ?? '已删除账号', accountEmail: account?.email, success: false, model: task.model, error: controller.signal.aborted ? '任务已取消' : safeMessage(error), durationMs: 0 }
      }
      record.triggerType = trigger; records.push(record)
    }
    const successCount = records.filter(record => record.success).length
    const cancelled = controller.signal.aborted
    this.store.transaction(state => {
      const current = state.wakeup ?? defaultState(); const value = current.tasks.find(item => item.id === task.id)
      current.history = [...records, ...current.history].slice(0, 300)
      if (value) {
        value.lastStatus = cancelled ? 'cancelled' : successCount === records.length && records.length > 0 ? 'success' : 'error'
        value.lastMessage = cancelled ? '已取消' : `完成 ${successCount}/${records.length} 个账号`
        value.lastSuccessCount = successCount; value.lastFailureCount = records.length - successCount; value.lastDurationMs = records.reduce((total, record) => total + record.durationMs, 0)
        value.updatedAt = this.now(); const next = this.withNext(value); value.nextRunAt = next.nextRunAt
      }
      state.wakeup = current
    })
    if (!cancelled && records.some(record => !record.success)) this.lastError = `任务“${task.name}”有账号执行失败`
  }

  private scheduleStartup(): void {
    for (const timer of this.startupTimers) clearTimeout(timer)
    this.startupTimers.clear()
    const state = this.state(); if (!state.enabled || this.stopped) return
    for (const task of state.tasks.filter(value => value.enabled && value.schedule.kind === 'startup')) {
      const timer = setTimeout(() => { this.startupTimers.delete(timer); void this.startRun(task, 'startup').catch(error => { this.lastError = safeMessage(error) }) }, (task.schedule.startupDelayMinutes ?? 0) * 60_000)
      timer.unref(); this.startupTimers.add(timer)
    }
  }

  private tick(): void {
    const state = this.state(); if (!state.enabled || this.stopped) return
    const now = this.now()
    for (const task of state.tasks) {
      if (!task.enabled || task.schedule.kind === 'startup' || this.runs.has(task.id)) continue
      const due = dueWakeupAt(task, now, this.resetTimes(task)); if (due === undefined) continue
      const trigger = task.schedule.kind === 'quota_reset' ? 'quota_reset' : 'scheduled'
      void this.startRun(task, trigger, due).catch(error => { this.lastError = safeMessage(error) })
    }
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => this.tick(), 30_000); this.timer.unref()
    this.scheduleStartup(); this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer); this.timer = undefined
    for (const timer of this.startupTimers) clearTimeout(timer); this.startupTimers.clear()
    for (const run of this.runs.values()) run.controller.abort()
    await Promise.allSettled([...this.runs.values()].map(run => run.task))
    this.runs.clear()
  }
}
