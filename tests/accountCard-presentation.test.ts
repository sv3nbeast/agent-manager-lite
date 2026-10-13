import test from 'node:test'
import assert from 'node:assert/strict'
import type { Account } from '../src/shared/types'
import { accountCardDate, accountCardIdentity, accountCardPlan, accountCardStatus, accountCardTier, accountCardType, isSupportedAnthropicAPIAccount } from '../src/renderer/src/components/accountCardPresentation'

function account(changes: Partial<Account> = {}): Account {
  return { id: 'fixture', name: 'alex@example.com', email: 'alex@example.com', kind: 'oauth', baseUrl: 'https://fixture.invalid/v1', models: [], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [], createdAt: Date.parse('2026-10-03T01:20:00Z'), credentialConfigured: true, ...changes }
}
const windows = [{ id: 'short', name: '短周期', durationSeconds: 18_000, usedPercent: 3 }]

test('identity does not repeat an identical email but retains different names and provider context', () => {
  const repeated = accountCardIdentity(account({ name: 'Alex@Example.com' }))
  assert.equal(repeated.name, 'Alex@Example.com')
  assert.equal(repeated.subtitle, '')
  assert.equal(repeated.initials, 'AL')
  assert.equal(accountCardIdentity(account({ name: 'Alex Chen' })).subtitle, 'alex@example.com')
  assert.equal(accountCardIdentity(account({ name: 'Alex Chen' })).initials, 'AC')
  assert.equal(accountCardIdentity(account({ kind: 'api_key' }), '供应商 A · Key 1').subtitle, '供应商 A · Key 1')
  assert.equal(accountCardIdentity(account({ name: '小明', email: undefined })).initials, '小明')
})

test('unqueried accounts and verified credentials never manufacture normal or zero usage', () => {
  const status = accountCardStatus(account())
  assert.equal(status.label, '尚未查询')
  assert.equal(status.tone, 'neutral')
  assert.equal(accountCardStatus(account({ credentialConfigured: false })).label, '缺少凭据')
  assert.equal(accountCardStatus(account({ needsTokenExchange: true })).label, '待验证')
  assert.equal(accountCardStatus(account({ kind: 'api_key' })).label, '尚未查询')
})

test('quota failure with historical data stays a failure and explicitly marks previous success', () => {
  const a = account({ quota: { updatedAt: 100, windows }, error: 'network timeout' })
  assert.equal(accountCardStatus(a).label, '查询失败')
  assert.match(accountCardStatus(a).detail, /network timeout.*上次成功结果/)
  assert.deepEqual(a.quota?.windows, windows)
  assert.doesNotMatch(accountCardStatus(account({ error: 'network timeout' })).detail, /上次成功结果/)
})

test('exhausted plan with usable additional credits is distinguished from fully exhausted use', () => {
  const exhausted = account({ quota: { updatedAt: 100, windows, limitReached: true } })
  assert.equal(accountCardStatus(exhausted).label, '用量已耗尽')
  assert.equal(accountCardStatus(exhausted).tone, 'error')
  assert.equal(accountCardStatus({ ...exhausted, quota: { ...exhausted.quota!, hasUsableCredits: true } }).label, '附加额度可用')
  assert.equal(accountCardStatus(account({ quota: { updatedAt: 100, windows, allowed: false } })).label, '暂不可用')
})

test('one unavailable window does not claim the entire account is exhausted', () => {
  const state = accountCardStatus(account({ quota: { updatedAt: 100, windows: [...windows, { id: 'week', name: '周周期', limitReached: true }] } }))
  assert.equal(state.label, '窗口受限')
  assert.match(state.detail, /部分/)
})

test('high reported usage is advisory and unknown usage stays unknown', () => {
  const high = accountCardStatus(account({ quota: { updatedAt: 100, windows: [{ id: 'week', name: '周周期', usedPercent: 100 }] } }))
  assert.equal(high.label, '用量较高')
  assert.notEqual(high.label, '用量已耗尽')
  const unknown = account({ quota: { updatedAt: 100, windows: [{ id: 'week', name: '周周期' }] } })
  assert.equal(accountCardStatus(unknown).label, '额度未知')
  assert.equal(accountCardStatus(unknown).tone, 'neutral')
  assert.equal(unknown.quota?.windows[0].usedPercent, undefined)
})

test('empty quota metadata cannot imply healthy use, while reported zero remains known data', () => {
  const unknown = account({ quota: { updatedAt: 100, windows: [], credits: {}, spendLimit: {}, resetCreditsAvailable: 2 } })
  assert.equal(accountCardStatus(unknown).label, '额度未知')
  assert.equal(accountCardStatus(unknown).tone, 'neutral')
  assert.equal(accountCardStatus(account({ quota: { updatedAt: 100, windows: [], credits: { remaining: 0 } } })).label, '用量已同步')
  assert.equal(accountCardStatus(account({ quota: { updatedAt: 100, windows: [], allowed: true } })).label, '用量已同步')
  for (const usedPercent of [-5, NaN, Infinity]) {
    assert.equal(accountCardStatus(account({ quota: { updatedAt: 100, windows: [{ id: 'invalid', name: '窗口', usedPercent }] } })).label, '额度未知')
  }
})

test('API provider summaries keep unsupported, historical and invalid states distinct', () => {
  const summary = { source: 'deepseek' as const, updatedAt: 100, balance: 0, isValid: false }
  assert.equal(accountCardStatus(account({ kind: 'api_key', providerUsage: { checkedAt: 100, summary } })).label, '额度不可用')
  const historical = accountCardStatus(account({ kind: 'api_key', providerUsage: { checkedAt: 100, summary, error: '查询受限' } }))
  assert.equal(historical.label, '查询失败')
  assert.match(historical.detail, /上次成功结果/)
  assert.equal(accountCardStatus(account({ kind: 'api_key', providerUsage: { checkedAt: 100 } })).label, '额度未知')
  assert.equal(accountCardStatus(account({ kind: 'api_key', providerUsage: { checkedAt: 100, error: '不支持查询', unavailable: true } })).tone, 'neutral')
})

test('display names preserve custom plans, tier choices and unknown dates', () => {
  assert.equal(accountCardPlan(account({ plan: 'plus' })), 'Plus')
  assert.equal(accountCardPlan(account({ plan: '自定义套餐' })), '自定义套餐')
  assert.equal(accountCardPlan(account()), '套餐未查询')
  assert.equal(accountCardTier(account({ defaultTier: 'fast' })), 'Fast')
  assert.equal(accountCardTier(account({ defaultTier: 'follow' })), '跟随请求')
  assert.equal(accountCardDate(Number.NaN), '未知')
  assert.equal(accountCardDate(-1), '未知')
  assert.match(accountCardDate(Date.parse('2026-10-03T01:20:00Z')), /2026.*10.*03/)
  assert.notEqual(accountCardDate(0), '未知')
})

test('configured Claude API and Bearer resources describe saved configuration without claiming upstream authentication or usage', () => {
  for (const credentialKind of ['anthropic_api_key', 'anthropic_bearer', 'gateway'] as const) {
    const connection = account({ kind: 'api_key', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind,
      models: ['gateway-model'], providerUsage: { checkedAt: 100, summary: { source: 'deepseek', updatedAt: 100, isValid: true, balance: 100 } } })
    const status = accountCardStatus(connection)
    assert.equal(isSupportedAnthropicAPIAccount(connection), true)
    assert.equal(status.label, 'API 连接已配置')
    assert.equal(status.tone, 'neutral')
    assert.match(status.detail, /已保存.*实际访问权限以首次请求结果为准/)
    assert.doesNotMatch(status.detail, /鉴权成功|登录成功|已同步|待适配器/)
  }
})

test('incomplete Claude API connections do not claim a configured connection', () => {
  const connection = account({ kind: 'api_key', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind: 'anthropic_bearer', models: ['gateway-model'] })
  assert.equal(accountCardStatus({ ...connection, credentialConfigured: false }).label, '缺少凭据')
  for (const changes of [{ models: [] }, { models: [''] }, { models: ['invalid\nmodel'] }, { baseUrl: '' }, { baseUrl: 'https://gateway.invalid?key=invalid' }, { baseUrl: 'https://gateway.invalid/\npath' }]) {
    assert.equal(accountCardStatus({ ...connection, ...changes }).label, '待完善配置')
  }
})

test('Claude OAuth, profile and cloud credentials remain pending without suggesting OpenAI refresh or local API exchange', () => {
  for (const credentialKind of ['claude_ai_oauth', 'anthropic_profile', 'bedrock', 'vertex', 'foundry'] as const) {
    const connection = account({ kind: credentialKind === 'claude_ai_oauth' ? 'oauth' : 'api_key', identityService: 'anthropic', protocol: 'anthropic_messages', credentialKind,
      models: ['gateway-model'], needsTokenExchange: credentialKind === 'claude_ai_oauth' })
    assert.equal(isSupportedAnthropicAPIAccount(connection), false)
    const status = accountCardStatus(connection)
    assert.equal(status.label, '待适配器验证')
    assert.equal(status.tone, 'warning')
    assert.doesNotMatch(status.detail, /刷新用量|启动本地 API|API 连接已配置/)
    assert.match(status.detail, /独立验证/)
    assert.doesNotMatch(accountCardType(connection), /API Key/)
  }
  const inconsistent = account({ kind: 'api_key', identityService: 'anthropic', protocol: 'openai_responses', credentialKind: 'anthropic_api_key', models: ['model'] })
  assert.equal(accountCardStatus(inconsistent).label, '待适配器验证')
})
