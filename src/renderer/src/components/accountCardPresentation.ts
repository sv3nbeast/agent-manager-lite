import type { Account } from '../../../shared/types'

export interface AccountCardStatus {
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'error'
  detail: string
}

export function accountCardIdentity(account: Account, connectionLabel?: string) {
  const name = account.name.trim() || account.email?.trim() || '未命名账号'
  const email = account.email?.trim()
  const type = account.kind === 'oauth' ? 'ChatGPT · OAuth' : account.kind === 'agent_identity' ? 'Agent Identity' : 'API 连接'
  const subtitle = account.kind === 'api_key'
    ? connectionLabel?.trim() || account.baseUrl || type
    : email && email.toLocaleLowerCase() !== name.toLocaleLowerCase() ? email : ''
  const words = name.split(/\s+/).filter(Boolean)
  const initials = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]].join('')
    : Array.from(name.split('@')[0]).slice(0, 2).join('')
  return { name, subtitle, type, initials: initials.toLocaleUpperCase() }
}

export function accountCardPlan(account: Account): string {
  if (account.kind === 'api_key') return account.providerId ? '共享供应商' : '独立配置'
  const plan = account.plan?.trim()
  if (!plan) return '套餐未查询'
  return ({ free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise' } as Record<string, string>)[plan.toLowerCase()] || plan
}

export function accountCardStatus(account: Account): AccountCardStatus {
  if (account.needsTokenExchange) return { label: '待验证', tone: 'warning', detail: '刷新令牌尚待验证，刷新用量或启动本地 API 时交换凭据。' }
  if (!account.credentialConfigured) return { label: '缺少凭据', tone: 'error', detail: '尚未保存可用凭据，请编辑账号。' }
  if (account.kind === 'api_key') {
    const usage = account.providerUsage
    if (usage?.error) return { label: '查询失败', tone: usage.unavailable ? 'neutral' : 'error', detail: `${usage.error}${usage.summary ? '；用量区域保留上次成功结果。' : ''}` }
    if (usage?.summary?.isValid === false) return { label: '额度不可用', tone: 'warning', detail: '服务商报告当前密钥或额度不可用，具体原因见用量详情。' }
    return usage?.summary
      ? { label: '额度已同步', tone: 'success', detail: '已取得服务商额度信息；此状态不代表所有模型都可调用。' }
      : { label: usage ? '额度未知' : '尚未查询', tone: 'neutral', detail: '尚未取得可展示的服务商额度。' }
  }
  if (account.error) return { label: '查询失败', tone: 'error', detail: `${account.error}${account.quota ? '；用量区域保留上次成功结果。' : ''}` }
  const quota = account.quota
  if (!quota) return { label: '尚未查询', tone: 'neutral', detail: '凭据已保存，尚未查询上游用量。' }
  if (quota.limitReached) return quota.hasUsableCredits
    ? { label: '附加额度可用', tone: 'warning', detail: '套餐窗口已用尽，上游报告附加额度仍可用。' }
    : { label: '用量已耗尽', tone: 'error', detail: '上游报告当前额度已用尽。' }
  if (quota.allowed === false) return { label: '暂不可用', tone: 'warning', detail: '上游当前暂不允许使用。' }
  if (quota.windows.some(window => window.limitReached || window.allowed === false)) return { label: '窗口受限', tone: 'warning', detail: '部分用量窗口已用尽或暂不可用，请查看具体窗口。' }
  if (quota.windows.some(window => Number.isFinite(window.usedPercent) && window.usedPercent! >= 90)) return { label: '用量较高', tone: 'warning', detail: '至少一个窗口已用达到 90%，请留意剩余用量。' }
  const observedUsage = quota.windows.some(window => Number.isFinite(window.usedPercent) && window.usedPercent! >= 0)
    || [quota.credits, quota.spendLimit].some(credit => credit?.unlimited === true || credit && [credit.remaining, credit.balance, credit.used, credit.limit, credit.remainingPercent].some(Number.isFinite))
    || quota.allowed === true || quota.hasUsableCredits === true
  if (!observedUsage) return { label: '额度未知', tone: 'neutral', detail: '已查询上游，但尚未返回可判定的用量、额度或可用状态。' }
  return { label: '用量已同步', tone: 'success', detail: '已取得上游用量信息；未知窗口不会按 0% 显示。' }
}

export function accountCardTier(account: Account): string {
  return ({ inherit: '继承全局默认', follow: '跟随请求', standard: '普通 · Standard', fast: 'Fast', auto: 'Auto', flex: 'Flex' } as const)[account.defaultTier]
}

export function accountCardDate(value: number): string {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}
