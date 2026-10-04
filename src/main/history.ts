import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { historyFilterSchema, historyQuerySchema, type HistoryBreakdownRow, type HistoryEntry, type HistoryFilter, type HistoryPage, type HistoryQuery } from '../shared/history'

const text = (v: unknown, max = 256) => typeof v === 'string' ? v.slice(0, max) : ''
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
const tier = (v: unknown): string | null => typeof v === 'string' && ['', 'priority', 'fast', 'default', 'standard', 'auto', 'flex', 'scale', 'ultrafast'].includes(v) ? v : null

export function csvCell(value: unknown): string {
  let cell = value == null ? '' : String(value)
  if (/^[\s]*[=+\-@\t\r\n]/.test(cell)) cell = `'${cell}`
  return `"${cell.replaceAll('"', '""')}"`
}
function where(filter: HistoryFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []; const params: (string | number)[] = []
  if (filter.search) {
    clauses.push('(instr(requestId, ?) > 0 OR instr(model, ?) > 0 OR instr(upstreamModel, ?) > 0 OR instr(accountId, ?) > 0 OR instr(apiKeyId, ?) > 0 OR instr(apiKeyLabel, ?) > 0)')
    params.push(...Array(6).fill(filter.search))
  }
  if (filter.outcome !== 'all') { clauses.push('success = ?'); params.push(filter.outcome === 'success' ? 1 : 0) }
  if (filter.from !== undefined) { clauses.push('requestedAt >= ?'); params.push(filter.from) }
  if (filter.to !== undefined) { clauses.push('requestedAt <= ?'); params.push(filter.to) }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', params }
}
const columns = ['requestId','requestedAt','model','upstreamModel','accountId','success','status','latencyMs','inputTokens','outputTokens','cachedTokens','inboundTier','outboundTier','responseTier','tierSource','apiKeyId','apiKeyLabel','totalTokens'] as const

export class History {
  private readonly db: DatabaseSync
  private readonly insert: ReturnType<DatabaseSync['prepare']>
  private pending: unknown[][] = []
  private timer?: ReturnType<typeof setTimeout>
  error?: string
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'history.sqlite')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY, identity TEXT UNIQUE NOT NULL, requestId TEXT NOT NULL, requestedAt INTEGER NOT NULL,
        model TEXT NOT NULL, upstreamModel TEXT NOT NULL, accountId TEXT NOT NULL, success INTEGER NOT NULL,
        status INTEGER NOT NULL, latencyMs INTEGER NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
        cachedTokens INTEGER NOT NULL, inboundTier TEXT, outboundTier TEXT, responseTier TEXT, tierSource TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(requestedAt);
      CREATE INDEX IF NOT EXISTS requests_outcome ON requests(success, seq);`)
    const present=new Set((this.db.prepare('PRAGMA table_info(requests)').all() as {name:string}[]).map(column=>column.name))
    for(const [name,type] of [['apiKeyId',"TEXT NOT NULL DEFAULT ''"],['apiKeyLabel',"TEXT NOT NULL DEFAULT ''"],['totalTokens','INTEGER NOT NULL DEFAULT 0']])if(!present.has(name))this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`)
    if(!present.has('totalTokens'))this.db.exec('UPDATE requests SET totalTokens = inputTokens + outputTokens')
    this.db.exec('CREATE INDEX IF NOT EXISTS requests_api_key ON requests(apiKeyId)')
    this.insert = this.db.prepare(`INSERT OR IGNORE INTO requests (identity, ${columns.join(',')}) VALUES (${Array(columns.length+1).fill('?').join(',')})`)
  }
  // Whitelist metadata. Sidecar error bodies/headers, keys, prompts, and raw
  // diagnostics are never serialized into this database or sent to the UI.
  record(runId: string, event: Record<string, unknown>): void {
    if (event.type !== 'usage' || !text(event.requestId)) return
    const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : {}
    this.pending.push([`${runId}:${text(event.requestId, 512)}`, text(event.requestId, 512), count(event.requestedAtMs) || Date.now(),
      text(event.requestedModel || event.model), text(event.upstreamModel || event.model), text(event.accountId), event.success === true ? 1 : 0,
      count(event.status), count(event.latencyMs), count(usage.inputTokens), count(usage.outputTokens), count(usage.cachedTokens),
      tier(event.inboundServiceTier), tier(event.outboundServiceTier), tier(event.responseServiceTier) || null,
      ['request','instance','account','provider','global','follow','transformed'].includes(String(event.tierSource)) ? event.tierSource : 'unknown',text(event.apiKeyId),text(event.apiKeyLabel),count(usage.totalTokens)||count(usage.inputTokens)+count(usage.outputTokens)])
    if (this.pending.length >= 200 && !this.error) this.flush()
    else if (!this.timer) { this.timer = setTimeout(() => this.flush(), 250); this.timer.unref() }
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined
    if (!this.pending.length) return
    const batch = this.pending; this.pending = []
    try {
      this.db.exec('BEGIN')
      for (const row of batch) this.insert.run(...row as (string | number | null)[])
      this.db.exec('COMMIT'); this.error = undefined
    } catch {
      try { this.db.exec('ROLLBACK') } catch {}
      // Keep uncommitted usage for a later retry; a transient lock must not
      // silently reset a key's lifetime token accounting after the next write.
      this.pending = [...batch, ...this.pending]
      this.error = '调用记录保存失败，请检查本地磁盘空间与权限'
    }
  }
  keyTokenUsage(ids:string[]):Record<string,number> {
    this.flush()
    if(this.error)throw new Error(this.error)
    const query=this.db.prepare('SELECT COALESCE(SUM(totalTokens),0) AS total FROM requests WHERE apiKeyId = ?')
    return Object.fromEntries(ids.map(id=>[id,Number((query.get(id) as {total:number}).total)]))
  }
  query(input: HistoryQuery): HistoryPage {
    const query = historyQuerySchema.parse(input); this.flush()
    const filter = where(query.filter)
    const stats = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(success),0) AS succeeded,
      COALESCE(SUM(inputTokens),0) AS inputTokens, COALESCE(SUM(outputTokens),0) AS outputTokens,
      COALESCE(SUM(cachedTokens),0) AS cachedTokens FROM requests WHERE ${filter.sql}`).get(...filter.params) as unknown as Omit<HistoryPage, 'entries'>
    const rows = this.db.prepare(`SELECT seq, ${columns.join(',')} FROM requests WHERE ${filter.sql} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...filter.params, query.pageSize, (query.page - 1) * query.pageSize) as Record<string, unknown>[]
    const breakdown = (field: 'model'|'accountId'|'outboundTier'): HistoryBreakdownRow[] => {
      const label = field === 'outboundTier' ? "COALESCE(NULLIF(outboundTier, ''), '(未观测)')" : `COALESCE(NULLIF(${field}, ''), '(未指定)')`
      const grouped = this.db.prepare(`SELECT ${label} AS key, COUNT(*) AS requests, COALESCE(SUM(success),0) AS succeeded,
        COALESCE(SUM(inputTokens),0) AS inputTokens, COALESCE(SUM(outputTokens),0) AS outputTokens,
        COALESCE(SUM(cachedTokens),0) AS cachedTokens, COALESCE(SUM(totalTokens),0) AS totalTokens
        FROM requests WHERE ${filter.sql} GROUP BY ${label} ORDER BY totalTokens DESC, requests DESC, key ASC LIMIT 100`).all(...filter.params) as Record<string, unknown>[]
      return grouped.map(row => ({ key: text(row.key, 512), requests: count(row.requests), succeeded: count(row.succeeded),
        inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens), cachedTokens: count(row.cachedTokens), totalTokens: count(row.totalTokens) }))
    }
    return { ...stats, entries: rows.map(row => ({ ...row, success: row.success === 1 })) as unknown as HistoryEntry[],
      report: { models: breakdown('model'), accounts: breakdown('accountId'), tiers: breakdown('outboundTier') } }
  }
  async exportCSV(input: HistoryFilter, destination: string, signal: AbortSignal): Promise<number> {
    const filter = where(historyFilterSchema.parse(input)); this.flush()
    let cursor = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS cursor FROM requests').get() as { cursor: number }).cursor)
    const temporary = `${destination}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    let total = 0
    try {
      await file.writeFile('\uFEFF' + columns.map(csvCell).join(',') + '\r\n')
      const query = this.db.prepare(`SELECT seq, ${columns.join(',')} FROM requests WHERE ${filter.sql} AND seq < ? ORDER BY seq DESC LIMIT 500`)
      while (true) {
        signal.throwIfAborted()
        const rows = query.all(...filter.params, cursor) as Record<string, unknown>[]
        if (!rows.length) break
        await file.writeFile(rows.map(row => columns.map(key => csvCell(row[key])).join(',')).join('\r\n') + '\r\n')
        total += rows.length; cursor = Number(rows.at(-1)!.seq)
        await setImmediate()
      }
      signal.throwIfAborted(); await file.sync(); await file.close(); await rename(temporary, destination)
      return total
    } finally { await file.close(); await rm(temporary, { force: true }) }
  }
  close(): void { this.flush(); this.db.close() }
}
