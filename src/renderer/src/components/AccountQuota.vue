<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarOutlined } from '@ant-design/icons-vue'
import type { Account } from '../../../shared/types'
import { providerUsageNames } from '../../../shared/providerUsage'
import {
  availableResetCount, creditSummary, formatQuotaAmount, formatQuotaDate, primaryQuotaWindows,
  providerWindowPresentation, quotaWindowPresentation, sanitizedCredits, validQuotaTimestamp
} from '../accountQuotaPresentation'
import CreditQuota from './CreditQuota.vue'
import ProviderUsageDetails from './ProviderUsageDetails.vue'

const props = defineProps<{ account: Account; refreshing: boolean }>()
defineEmits<{ refresh: []; refreshSubscription: []; refreshResetCredits: []; consumeResetCredit: [] }>()
const detailsOpen = ref(false)
const openDetails = () => { detailsOpen.value = true }
defineExpose({ openDetails })
// Inherit the app's light/dark variables without covering only the card itself.
const drawerContainer = () => document.querySelector('.app-shell') ?? document.body
const provider = computed(() => props.account.providerUsage?.summary)
const windows = computed(() => props.account.kind === 'api_key'
  ? (provider.value?.windows ?? []).map(providerWindowPresentation)
  : (props.account.quota?.windows ?? []).map(quotaWindowPresentation))
const highlightedWindows = computed(() => props.account.kind === 'api_key' ? windows.value.slice(0, 2)
  : primaryQuotaWindows(props.account.quota?.windows ?? []).map(quotaWindowPresentation))
const additionalWindowCount = computed(() => windows.value.length - highlightedWindows.value.length)
const updatedAt = computed(() => props.account.kind === 'api_key' ? provider.value?.updatedAt : props.account.quota?.updatedAt)
const hasHistory = computed(() => props.account.kind === 'api_key' ? !!provider.value : !!props.account.quota)
const queryError = computed(() => props.account.kind === 'api_key' ? props.account.providerUsage?.error : props.account.error)
const hasSupplement = computed(() => props.account.kind !== 'api_key' && (props.account.kind === 'oauth'
  || props.account.quota?.spendLimit || props.account.quota?.credits || props.account.quota?.resetCreditsAvailable !== undefined))
const notice = computed(() => {
  if (props.account.kind === 'api_key') {
    if (provider.value?.isValid === false) return provider.value.windows?.length ? '服务商报告用量已耗尽'
      : provider.value.source === 'deepseek' ? '服务商报告余额不足' : '服务商报告密钥不可用'
    return ''
  }
  if (props.account.quota?.limitReached) return props.account.quota.hasUsableCredits
    ? '套餐用量已耗尽，附加额度仍可用' : '当前额度已耗尽'
  if (props.account.quota?.allowed === false) return '上游暂不允许使用'
  return ''
})
const providerBalance = computed(() => {
  if (provider.value?.unlimited) return '不限量'
  const remaining = provider.value?.remaining
  const amount = typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : provider.value?.balance
  return typeof amount === 'number' && Number.isFinite(amount)
    ? `${formatQuotaAmount(amount)} ${provider.value?.unit || '（单位未知）'}` : '未知'
})
const subscriptionSummary = computed(() => validQuotaTimestamp(props.account.subscriptionActiveUntil)
  ? `${formatQuotaDate(props.account.subscriptionActiveUntil).split(' ')[0]} 到期`
  : props.account.subscriptionQueryLastError ? '查询失败' : props.account.subscriptionQueryLastSuccessAt ? '到期时间未知' : '未查询')
const resetStatus = (status: string | undefined) => ({ available: '可使用', redeemed: '已使用', used: '已使用', expired: '已过期' }[status ?? ''] ?? status ?? '状态未知')
</script>

<template>
  <section class="account-quota-summary" :aria-label="account.kind === 'api_key' ? '服务商额度摘要' : '账号用量摘要'">
    <div class="quota-main-panel">
      <div class="quota-summary-heading">
        <span>{{ account.kind === 'api_key' ? '服务商额度' : '用量' }}</span>
        <small v-if="validQuotaTimestamp(updatedAt)" :title="`${formatQuotaDate(updatedAt, true)} 更新${queryError ? ' · 上次成功结果' : ''}`">{{ formatQuotaDate(updatedAt) }} 更新</small>
      </div>
      <p v-if="account.needsTokenExchange" class="quota-notice quota-info">凭据待验证，刷新用量后确认</p>
      <button v-if="queryError" type="button" class="quota-query-error" :title="queryError" @click="openDetails">
        {{ hasHistory ? '查询失败 · 显示上次成功结果' : account.providerUsage?.unavailable ? '此服务商暂不支持额度查询' : '用量查询失败 · 查看原因' }}
      </button>
      <p v-if="notice" class="quota-notice">{{ notice }}</p>
      <div v-if="highlightedWindows.length" class="quota-window-grid">
        <div v-for="window in highlightedWindows" :key="window.id" class="compact-quota-window" :class="`quota-tone-${window.tone}`">
          <div class="quota-window-heading">
            <div class="quota-window-label"><span :title="window.fullLabel">{{ window.label }}</span><small class="quota-window-state">{{ window.state }}</small></div>
            <strong class="quota-percentage"><template v-if="window.usedPercent !== undefined">{{ window.percentage.slice(0, -1) }}<small>%</small></template><template v-else>{{ window.percentage }}</template></strong>
          </div>
          <div v-if="window.progress !== undefined" class="quota-progress" role="progressbar" :aria-label="`${window.fullLabel}已用`" :aria-valuenow="window.progress" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="`已用 ${window.percentage}${window.state !== '已用' ? `，${window.state}` : ''}`"><span :style="{ width: `${window.progress}%` }" /></div>
          <div v-else class="quota-progress quota-progress-unknown" aria-label="用量未知" />
          <small class="quota-reset-time" :title="window.resetFull"><CalendarOutlined aria-hidden="true" />{{ window.reset }}</small>
        </div>
      </div>
      <p v-else-if="account.kind !== 'api_key'" class="quota-empty">{{ account.quota ? '上游未返回用量窗口' : '尚未查询用量' }}</p>
      <template v-if="account.kind === 'api_key'">
        <div v-if="provider" class="quota-supplement-row provider-balance"><span>{{ (provider.windows?.length ?? 0) > 1 ? '最低窗口剩余' : '剩余额度' }}</span><strong>{{ providerBalance }}</strong></div>
        <p v-else class="quota-empty">{{ account.providerUsage ? '当前额度未知' : '尚未查询额度' }}</p>
      </template>
      <button v-if="additionalWindowCount > 0" class="quota-more-windows" type="button" @click="openDetails">另 {{ additionalWindowCount }} 个用量窗口 · 查看详情</button>
    </div>
    <div v-if="hasSupplement" class="quota-supplement">
      <div v-if="account.quota?.spendLimit" class="quota-supplement-row quota-credit-summary"><span>月度 Credits</span><strong>{{ creditSummary(account.quota.spendLimit) }}</strong></div>
      <div v-if="account.quota?.credits" class="quota-supplement-row quota-credit-summary"><span>附加 Credits</span><strong>{{ creditSummary(account.quota.credits) }}</strong></div>
      <div v-if="account.kind === 'oauth'" class="quota-supplement-row quota-subscription-summary"><span>订阅</span><strong :title="validQuotaTimestamp(account.subscriptionActiveUntil) ? formatQuotaDate(account.subscriptionActiveUntil, true) : account.subscriptionQueryLastError">{{ subscriptionSummary }}</strong></div>
      <div v-if="account.quota?.resetCreditsAvailable !== undefined" class="quota-supplement-row quota-reset-summary"><span>可重置次数</span><strong>{{ availableResetCount(account.quota.resetCreditsAvailable) }}</strong></div>
    </div>
  </section>

  <a-drawer :open="detailsOpen" :width="480" title="账号与用量详情" :get-container="drawerContainer" destroy-on-close @close="detailsOpen = false">
    <div class="account-quota-details">
      <div class="quota-detail-title"><h3>{{ account.kind === 'api_key' ? '服务商额度' : '用量窗口' }}</h3><a-button size="small" :loading="refreshing" @click="$emit('refresh')">刷新用量</a-button></div>
      <ProviderUsageDetails v-if="account.kind === 'api_key'" :usage="account.providerUsage" />
      <template v-else>
        <a-alert v-if="account.needsTokenExchange" type="info" message="刷新令牌待验证：刷新用量或启动本地 API 时交换凭据" show-icon />
        <a-alert v-if="account.error" type="error" :message="account.error" show-icon />
        <p v-if="notice" class="quota-notice">{{ notice }}</p>
        <p v-if="!account.quota" class="quota-empty">尚未查询用量</p>
        <p v-else-if="!windows.length" class="quota-empty">上游未返回用量窗口</p>
        <div v-for="window in windows" :key="window.id" class="quota-detail-window" :class="`quota-tone-${window.tone}`">
          <div class="quota-supplement-row"><span>{{ window.fullLabel }}</span><strong>{{ window.usedPercent === undefined ? '用量未知' : `已用 ${window.percentage}` }}</strong></div>
          <div v-if="window.progress !== undefined" class="quota-progress" role="progressbar" :aria-label="`${window.fullLabel}已用`" :aria-valuenow="window.progress" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="`已用 ${window.percentage}`"><span :style="{ width: `${window.progress}%` }" /></div>
          <div class="quota-supplement-row quota-detail-window-meta"><small>{{ window.resetFull }}</small><small class="quota-window-state">{{ window.state === '已用' ? '' : window.state }}</small></div>
        </div>
        <CreditQuota v-if="account.quota?.spendLimit" :value="sanitizedCredits(account.quota.spendLimit)" label="月度 Credits" />
        <CreditQuota v-if="account.quota?.credits" :value="sanitizedCredits(account.quota.credits)" label="附加 Credits" />
        <small v-if="account.quota" class="quota-detail-updated">更新于 {{ formatQuotaDate(account.quota.updatedAt, true) }}{{ account.error ? ' · 上次成功结果' : '' }}</small>
        <section v-if="account.kind === 'oauth'" class="quota-detail-section">
          <div class="quota-detail-title"><h3>订阅信息</h3><a-button size="small" :disabled="refreshing" @click="$emit('refreshSubscription')">刷新订阅</a-button></div>
          <div class="quota-supplement-row"><span>套餐</span><strong>{{ account.plan || '未查询' }}</strong></div>
          <div class="quota-supplement-row"><span>订阅有效期</span><span>{{ validQuotaTimestamp(account.subscriptionActiveUntil) ? formatQuotaDate(account.subscriptionActiveUntil, true) : '未知' }}</span></div>
          <small v-if="account.subscriptionQueryLastSuccessAt" class="quota-detail-updated">最近查询 {{ formatQuotaDate(account.subscriptionQueryLastSuccessAt, true) }}</small>
          <a-alert v-if="account.subscriptionQueryLastError" type="error" :message="account.subscriptionQueryLastError" show-icon />
        </section>
        <section v-if="account.kind === 'oauth'" class="quota-detail-section">
          <div class="quota-detail-title"><h3>主动重置额度</h3><a-button size="small" :disabled="refreshing" @click="$emit('refreshResetCredits')">查询重置明细</a-button></div>
          <div class="quota-supplement-row"><span>可重置次数</span><strong>{{ availableResetCount(account.quota?.resetCreditsAvailable) }}</strong></div>
          <p class="quota-detail-updated">最近重置额度有效期：{{ formatQuotaDate(account.quota?.resetCreditsNextExpiresAt, true) }}</p>
          <div v-for="(credit, index) in account.quota?.resetCredits" :key="`${credit.id ?? 'credit'}-${index}`" class="reset-credit-detail">
            <div class="quota-supplement-row"><span>{{ credit.resetType || '重置额度' }}</span><strong>{{ resetStatus(credit.status) }}</strong></div>
            <small v-if="credit.expiresAt !== undefined">{{ formatQuotaDate(credit.expiresAt, true) }} 到期</small>
            <small v-if="credit.grantedAt !== undefined">{{ formatQuotaDate(credit.grantedAt, true) }} 发放</small>
            <small v-if="credit.redeemedAt !== undefined">{{ formatQuotaDate(credit.redeemedAt, true) }} 使用</small>
          </div>
          <a-popconfirm v-if="(account.quota?.resetCreditsAvailable ?? 0) > 0" title="使用一次主动重置额度？该操作会消耗上游额度。" ok-text="确认使用" cancel-text="取消" @confirm="$emit('consumeResetCredit')"><a-button danger :disabled="refreshing" class="consume-reset-credit">使用一次重置</a-button></a-popconfirm>
        </section>
      </template>
      <p v-if="account.kind === 'api_key' && provider" class="quota-detail-updated">{{ providerUsageNames[provider.source] }}</p>
      <slot name="details" />
    </div>
  </a-drawer>
</template>

<style scoped>
.account-quota-summary,.account-quota-details { --quota-muted: color-mix(in srgb, var(--muted, #858897) 72%, var(--text, #23242c)); --quota-accent: #338c30; --quota-panel: #f6f7f8; --quota-track: #dfe1e4; }
.account-quota-summary { margin: 0; color: var(--text, #23242c); }
.quota-main-panel { padding: 8px 12px; border-radius: 9px; background: var(--quota-panel); }
.quota-summary-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--quota-muted, #696d7d); font-size: 11px; line-height: 1.4; }
.quota-summary-heading small { font-size: 10px; white-space: nowrap; }
.quota-window-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.compact-quota-window { min-width: 0; }
.quota-window-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
.quota-window-label { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.quota-window-label > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.quota-window-state { font-size: 10px; white-space: nowrap; color: var(--quota-muted, #696d7d); }
.quota-percentage { display: block; flex-shrink: 0; font-size: 20px; line-height: 1; letter-spacing: -.3px; font-weight: 650; margin: 0; font-variant-numeric: tabular-nums; color: var(--quota-accent); }
.quota-percentage small { font-size: 11px; margin-left: 1px; }
.quota-progress { height: 10px; border-radius: 2px; overflow: hidden; background: var(--quota-track); mask-image: repeating-linear-gradient(90deg, #000 0 6px, transparent 6px 8px); }
.quota-progress > span { height: 100%; display: block; background: var(--quota-accent); }
.compact-quota-window .quota-progress { margin-top: 4px; }
.quota-progress-unknown { opacity: .65; }
.quota-reset-time { display: flex; align-items: center; gap: 4px; color: var(--quota-muted, #696d7d); font-size: 10px; line-height: 1.4; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.quota-reset-time :deep(.anticon) { flex-shrink: 0; font-size: 11px; }
.quota-tone-warning { --quota-accent: var(--quota-warning, #c27916); }
.quota-tone-exhausted,.quota-tone-blocked { --quota-accent: var(--quota-danger, #cf454a); }
.quota-tone-warning .quota-percentage,.quota-tone-warning .quota-window-state { color: var(--quota-warning, #a5680d); }
.quota-tone-exhausted .quota-percentage,.quota-tone-exhausted .quota-window-state,.quota-tone-blocked .quota-window-state { color: var(--quota-danger, #cf454a); }
.quota-tone-unknown .quota-percentage { color: var(--quota-muted, #696d7d); font-size: 15px; }
.quota-supplement { margin-top: 6px; padding: 6px 12px; border-radius: 9px; background: var(--quota-panel); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; }
.quota-supplement > .quota-supplement-row { gap: 6px; }
.quota-supplement > .quota-supplement-row > span { display: inline-flex; align-items: center; gap: 5px; }
.quota-supplement > .quota-supplement-row > span::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #4386d7; flex-shrink: 0; }
.quota-supplement > .quota-subscription-summary > span::before { background: #d48a2c; }
.quota-supplement > .quota-reset-summary > span::before { background: var(--quota-muted); }
.quota-supplement-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; min-width: 0; font-size: 11px; line-height: 1.5; }
.quota-supplement-row > :first-child { color: var(--quota-muted, #696d7d); flex-shrink: 0; }
.quota-supplement-row > :last-child { min-width: 0; text-align: right; overflow-wrap: anywhere; font-weight: 500; }
.quota-notice,.quota-query-error { font-size: 11px; line-height: 1.5; color: var(--quota-danger, #c6454b); margin: 0 0 8px; }
.quota-info { color: var(--quota-muted, #696d7d); }
.quota-query-error { cursor: pointer; padding: 0; text-align: left; background: none; border: 0; font: inherit; font-size: 11px; color: var(--quota-muted, #696d7d); }
.quota-query-error:hover { text-decoration: underline; }
.quota-empty { margin: 0; min-height: 60px; display: flex; align-items: center; justify-content: center; color: var(--quota-muted, #696d7d); font-size: 12px; }
.quota-more-windows { margin-top: 8px; cursor: pointer; font: inherit; font-size: 11px; color: var(--quota-link, #416b9c); background: none; border: 0; padding: 1px 0; }
.quota-more-windows:hover { text-decoration: underline; }
.provider-balance { margin-top: 12px; }
.provider-balance strong { font-size: 16px; }
.account-quota-details { color: var(--text, #23242c); }
.account-quota-details .ant-alert { margin: 10px 0; }
.quota-detail-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.quota-detail-title h3 { margin: 0; font-size: 14px; font-weight: 600; }
.quota-detail-window { padding: 13px; border: 1px solid var(--border, #e9eaf0); background: var(--subtle, #fafafd); border-radius: 10px; margin: 10px 0; }
.quota-detail-window .quota-progress { margin-top: 9px; }
.quota-detail-window-meta { margin-top: 9px; color: var(--quota-muted, #696d7d); }
.quota-detail-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border, #e9eaf0); }
.quota-detail-section > .quota-supplement-row { margin: 9px 0; font-size: 12px; }
.quota-detail-updated { display: block; font-size: 11px; color: var(--quota-muted, #696d7d); margin: 10px 0; }
.reset-credit-detail { border: 1px solid var(--border, #e9eaf0); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
.reset-credit-detail small { display: block; font-size: 11px; color: var(--quota-muted, #696d7d); margin-top: 5px; }
.consume-reset-credit { margin-top: 8px; }
:is(.quota-query-error,.quota-more-windows):focus-visible { outline: 2px solid var(--quota-link, #416b9c); outline-offset: 3px; border-radius: 2px; }
:global(.app-shell.dark .account-quota-summary),:global(.app-shell.dark .account-quota-details) { --quota-panel: #25272d; --quota-track: #3b3f47; --quota-accent: #7ac967; --quota-danger: #f08088; --quota-warning: #e8b056; --quota-link: #8eb8e9; }
@media (max-width: 620px) { .quota-summary-heading { flex-wrap: wrap; } }
</style>
