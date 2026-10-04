import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store, type VaultCodec } from '../src/main/store'
import { createAPIAccount } from '../src/main/accounts'
import { WakeupScheduler } from '../src/main/wakeupScheduler'
import { Gateway } from '../src/main/gateway'
import { dueWakeupAt, nextWakeupRunAt } from '../src/shared/wakeup'

function codec(): VaultCodec {
  const key = randomBytes(32)
  return {
    encrypt(value) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]) },
    decrypt(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') }
  }
}

test('wakeup schedule calculation handles daily, weekly and interval deadlines', () => {
  // Daily and weekly schedules use the system's local wall clock.
  const now = new Date(2026, 9, 2, 8).getTime()
  const base = { createdAt: now - 5 * 3600_000, lastRunAt: now - 5 * 3600_000 }
  assert.equal(dueWakeupAt({ ...base, schedule: { kind: 'daily', dailyTime: '07:00', weeklyDays: [] } }, now), new Date(2026, 9, 2, 7).getTime())
  assert.equal(dueWakeupAt({ ...base, schedule: { kind: 'weekly', weeklyDays: [5], weeklyTime: '07:00' } }, now), new Date(2026, 9, 2, 7).getTime())
  assert.equal(nextWakeupRunAt({ ...base, schedule: { kind: 'interval', intervalHours: 4, weeklyDays: [] } }, now), now - 1 * 3600_000)
})

test('wakeup runs a bounded real loopback Responses request and persists history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cml-wakeup-'))
  const store = new Store(root, codec())
  let body = ''
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'fixture-response', output_text: 'fixture reply', status: 'completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }))
  })
  await new Promise<void>(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const account = createAPIAccount({ name: 'Wakeup fixture', apiKey: 'fixture-upstream', baseUrl: `http://127.0.0.1:${address.port}`, models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
  store.transaction(state => state.accounts.push(account))
  const scheduler = new WakeupScheduler(store, runId => new Gateway(resolve('resources/bin/codex-proxy'), join(root, 'runtime'), () => { void runId }), async id => store.read().accounts.find(value => value.id === id)!)
  try {
    scheduler.save({ name: 'fixture task', enabled: true, accountIds: [account.id], prompt: 'health check', schedule: { kind: 'interval', intervalHours: 1, weeklyDays: [] } })
    const task = scheduler.view().tasks[0]
    assert.ok(task)
    await scheduler.runNow(task.id)
    const result = scheduler.view()
    assert.equal(result.history.length, 1)
    assert.equal(result.history[0].success, true)
    assert.equal(result.history[0].reply, 'fixture reply')
    assert.equal(JSON.parse(body).input, 'health check')
    assert.equal(result.tasks[0].lastSuccessCount, 1)
  } finally {
    await scheduler.stop(); upstream.closeAllConnections(); await new Promise<void>(resolveClose => upstream.close(() => resolveClose())); rmSync(root, { recursive: true, force: true })
  }
})

test('wakeup cancellation aborts the in-flight loopback request and records cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cml-wakeup-cancel-'))
  const store = new Store(root, codec())
  const upstream = createServer(async (req, res) => { for await (const _chunk of req) {} await delay(1_000); res.end('{}') })
  await new Promise<void>(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const account = createAPIAccount({ name: 'Cancel fixture', apiKey: 'fixture-upstream', baseUrl: `http://127.0.0.1:${address.port}`, models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
  store.transaction(state => state.accounts.push(account))
  const scheduler = new WakeupScheduler(store, runId => new Gateway(resolve('resources/bin/codex-proxy'), join(root, 'runtime'), () => { void runId }), async id => store.read().accounts.find(value => value.id === id)!)
  try {
    scheduler.save({ name: 'cancel task', enabled: true, accountIds: [account.id], prompt: 'cancel me', schedule: { kind: 'interval', intervalHours: 1, weeklyDays: [] } })
    const task = scheduler.view().tasks[0]; assert.ok(task)
    const running = scheduler.runNow(task.id)
    await delay(250)
    scheduler.cancel(task.id)
    await running
    assert.equal(scheduler.view().history[0].success, false)
    assert.equal(scheduler.view().history[0].error, '任务已取消')
  } finally {
    await scheduler.stop(); upstream.closeAllConnections(); await new Promise<void>(resolveClose => upstream.close(() => resolveClose())); rmSync(root, { recursive: true, force: true })
  }
})
