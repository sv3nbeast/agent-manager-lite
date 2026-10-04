import test from 'node:test'
import assert from 'node:assert/strict'
import {
  availableResetCount, creditSummary, formatQuotaAmount, formatQuotaDate, primaryQuotaWindows,
  providerWindowPresentation, quotaWindowPresentation, sanitizedCredits, validQuotaTimestamp
} from '../src/renderer/src/accountQuotaPresentation'

test('unqueried, invalid, and zero quota values remain distinct', () => {
  for (const usedPercent of [undefined, NaN, Infinity, -Infinity, -5]) {
    const result = quotaWindowPresentation({ id: 'main.primary_window', name: '短周期', usedPercent })
    assert.equal(result.percentage, '未知')
    assert.equal(result.progress, undefined)
    assert.equal(result.tone, 'unknown')
    assert.equal(result.state, '待查询')
  }
  const zero = quotaWindowPresentation({ id: 'main.primary_window', name: '短周期', usedPercent: 0 })
  assert.equal(zero.percentage, '0%')
  assert.equal(zero.progress, 0)
  assert.equal(zero.state, '已用')
})

test('quota warning and exhausted state have text, even without a numeric percentage', () => {
  assert.equal(quotaWindowPresentation({ id: 'x', name: '窗口', usedPercent: 95 }).state, '接近上限')
  const exhausted = quotaWindowPresentation({ id: 'x', name: '窗口', limitReached: true })
  assert.equal(exhausted.percentage, '未知')
  assert.equal(exhausted.state, '已耗尽')
  assert.equal(exhausted.progress, undefined)
  assert.equal(quotaWindowPresentation({ id: 'x', name: '窗口', usedPercent: 4, allowed: false }).state, '暂不可用')
  const overLimit = quotaWindowPresentation({ id: 'x', name: '窗口', usedPercent: 102.4 })
  assert.equal(overLimit.percentage, '102.4%')
  assert.equal(overLimit.progress, 100)
  assert.equal(overLimit.state, '已耗尽')
})

test('main short and weekly windows are prioritized without mutating or discarding others', () => {
  const windows = [
    { id: 'review.primary_window', name: '代码审查 · 短周期', durationSeconds: 18000 },
    { id: 'main.secondary_window', name: '周周期', durationSeconds: 604800 },
    { id: 'extra.primary_window', name: '特殊窗口', durationSeconds: 3600 },
    { id: 'main.primary_window', name: '短周期', durationSeconds: 18000 }
  ]
  const original = structuredClone(windows)
  assert.deepEqual(primaryQuotaWindows(windows).map(entry => entry.id), ['main.primary_window', 'main.secondary_window'])
  assert.deepEqual(windows, original)
  assert.equal(quotaWindowPresentation(windows[3]).label, '5 小时')
  assert.equal(quotaWindowPresentation(windows[1]).label, '7 天')
  assert.equal(quotaWindowPresentation(windows[0]).label, '代码审查 · 短周期（5 小时）')
  assert.deepEqual(primaryQuotaWindows(windows.slice(0, 1)), windows.slice(0, 1))
})

test('Chinese quota dates use a predictable 24 hour clock and reject invalid timestamps', () => {
  const timestamp = Date.parse('2026-10-03T22:14:00Z')
  assert.equal(formatQuotaDate(timestamp, false, 'UTC'), '10月3日 22:14')
  assert.equal(formatQuotaDate(timestamp, true, 'UTC'), '2026年10月3日 22:14')
  assert.equal(formatQuotaDate(timestamp, false, 'Asia/Shanghai'), '10月4日 06:14')
  assert.equal(validQuotaTimestamp(0), true)
  for (const value of [undefined, null, NaN, Infinity, -1, 1e308, '2026-10-03']) {
    assert.equal(formatQuotaDate(value), '时间未知')
    assert.equal(validQuotaTimestamp(value), false)
  }
})

test('credit summaries preserve unknown, real zero, unlimited, balance fallback and precision', () => {
  assert.equal(creditSummary({}), '剩余 未知')
  assert.equal(creditSummary({ remaining: 0 }), '剩余 0')
  assert.equal(creditSummary({ balance: 42 }), '剩余 42')
  assert.equal(creditSummary({ remaining: NaN, balance: 8.125 }), '剩余 8.125')
  assert.equal(creditSummary({ unlimited: true, remaining: 0 }), '不限量')
  assert.equal(creditSummary({ remaining: 17000 }), '剩余 17,000')
  assert.equal(formatQuotaAmount(Infinity), '未知')
  assert.deepEqual(sanitizedCredits({ remaining: NaN, balance: 0, used: Infinity, resetsAt: 1e308 }), { balance: 0 })
})

test('provider percentages do not turn missing remaining data into a false zero usage', () => {
  for (const remainingPercent of [undefined, NaN, Infinity, -1, 101]) {
    assert.equal(providerWindowPresentation({ id: 'provider', name: '额度', remainingPercent }).percentage, '未知')
  }
  assert.equal(providerWindowPresentation({ id: 'provider', name: '额度', remainingPercent: 100 }).percentage, '0%')
  assert.equal(providerWindowPresentation({ id: 'provider', name: '额度', remainingPercent: 0 }).state, '已耗尽')
  assert.equal(providerWindowPresentation({ id: 'provider', name: '额度', remainingPercent: 15.5 }).percentage, '84.5%')
})

test('reset count distinguishes queried zero from unknown and malformed counts', () => {
  assert.equal(availableResetCount(0), '0 次')
  assert.equal(availableResetCount(2), '2 次')
  for (const value of [undefined, NaN, Infinity, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(availableResetCount(value), '未知')
})
