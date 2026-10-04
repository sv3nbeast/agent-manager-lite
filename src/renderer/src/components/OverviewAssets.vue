<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowRightOutlined, KeyOutlined, UserOutlined } from '@ant-design/icons-vue'
import type { Account, CreditUsage, QuotaWindow } from '../../../shared/types'
import type { ProviderKeySummary, ProviderSummary } from '../../../shared/providerLibrary'

const props = defineProps<{ accounts: Account[]; providers: ProviderSummary[] }>()
const emit = defineEmits<{
  'manage-accounts': []
  'manage-providers': []
  'view-account': [accountId: string]
  'view-key': [providerId: string, keyId: string]
}>()
const pageSize = 12
const accountPage = ref(1), keyPage = ref(1)
const keys = computed(() => props.providers.flatMap(provider => provider.keys.map(key => ({ provider, key }))))
const visibleAccounts = computed(() => props.accounts.slice((accountPage.value - 1) * pageSize, accountPage.value * pageSize))
const visibleKeys = computed(() => keys.value.slice((keyPage.value - 1) * pageSize, keyPage.value * pageSize))
watch(() => props.accounts.length, count => { accountPage.value = Math.min(accountPage.value, Math.max(1, Math.ceil(count / pageSize))) })
watch(() => keys.value.length, count => { keyPage.value = Math.min(keyPage.value, Math.max(1, Math.ceil(count / pageSize))) })

function number(value: number): string { return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }
function percent(value: number | undefined): string { return value === undefined || !Number.isFinite(value) ? '用量未知' : `已用 ${number(value)}%` }
function barWidth(value: number): string { return `${Math.min(100, Math.max(0, value))}%` }
function windowName(window: QuotaWindow): string {
  if (!window.durationSeconds) return window.name
  const hours = window.durationSeconds / 3600
  return `${window.name} · ${hours >= 24 ? `${number(hours / 24)} 天` : `${number(hours)} 小时`}`
}
function creditText(credits: CreditUsage): string {
  if (credits.unlimited) return '不限额度'
  const value = credits.remaining ?? credits.balance
  return value === undefined || !Number.isFinite(value) ? '剩余额度未知' : `剩余 ${number(value)} Credits`
}
function accountState(account: Account): string {
  if (!account.credentialConfigured) return '待配置凭据'
  if (account.needsTokenExchange) return '待验证凭据'
  if (account.error) return '查询失败'
  if (account.quota?.limitReached) return account.quota.hasUsableCredits ? '附加额度可用' : '额度已用尽'
  if (account.quota?.allowed === false) return '暂不可用'
  return ''
}
function keyUsage(key: ProviderKeySummary): string {
  const usage = key.usage, summary = usage?.summary
  if (!summary) return usage?.unavailable ? '接口不支持额度查询' : usage?.error ? '额度查询失败' : usage ? '当前额度未知' : '额度尚未查询'
  if (summary.unlimited) return '不限额度'
  const value = summary.remaining ?? summary.balance
  return value === undefined || !Number.isFinite(value) ? '当前额度未知' : `剩余 ${number(value)} ${summary.unit || '（单位未知）'}`
}
</script>

<template>
  <div class="overview-assets">
    <section class="asset-section" aria-labelledby="overview-accounts-heading">
      <div class="asset-heading">
        <div><h2 id="overview-accounts-heading">ChatGPT 账号 <span class="asset-count">{{ accounts.length }}</span></h2><p>查看已保存的账号与最近查询的用量。</p></div>
        <a-button type="link" @click="emit('manage-accounts')">管理账号 <ArrowRightOutlined /></a-button>
      </div>
      <div v-if="!accounts.length" class="asset-empty"><span class="asset-empty-icon"><UserOutlined /></span><strong>还没有 ChatGPT 账号</strong><p>登录账号或迁移本机账号后，在这里查看用量。</p><a-button @click="emit('manage-accounts')">添加账号</a-button></div>
      <div v-else class="asset-grid">
        <button v-for="account in visibleAccounts" :key="account.id" type="button" class="asset-card account-thumbnail" :data-account-id="account.id" :aria-label="`查看账号 ${account.name}`" @click="emit('view-account', account.id)">
          <span class="asset-identity"><span class="asset-icon"><UserOutlined /></span><span class="asset-names"><strong :title="account.name">{{ account.name }}</strong><small :title="account.email">{{ account.email || '未提供邮箱' }}</small></span><ArrowRightOutlined class="asset-open" /></span>
          <span class="asset-meta"><span class="asset-chip">{{ account.kind === 'agent_identity' ? 'Agent 身份' : 'ChatGPT 登录' }}</span><span v-if="account.plan" class="asset-plan" :title="account.plan">{{ account.plan }}</span><span v-else class="asset-plan">套餐未查询</span></span>
          <span class="asset-quota">
            <span v-if="!account.quota" class="asset-unknown">用量尚未查询</span>
            <template v-else>
              <span v-if="!account.quota.windows.length" class="asset-unknown">上游未返回用量窗口</span>
              <span v-for="window in account.quota.windows.slice(0, 2)" :key="window.id" class="asset-window"><span class="asset-quota-row"><span class="asset-window-name" :title="windowName(window)">{{ windowName(window) }}</span><strong>{{ percent(window.usedPercent) }}</strong></span><span v-if="window.usedPercent !== undefined && Number.isFinite(window.usedPercent)" class="asset-progress" aria-hidden="true"><span :class="{ exhausted: window.usedPercent >= 90 }" :style="{ width: barWidth(window.usedPercent) }" /></span></span>
              <span v-if="account.quota.windows.length > 2" class="asset-quota-note">另有 {{ account.quota.windows.length - 2 }} 个用量窗口</span>
              <span v-if="account.quota.credits" class="asset-credit">附加额度 · {{ creditText(account.quota.credits) }}</span>
              <span v-else-if="account.quota.spendLimit" class="asset-credit">月度额度 · {{ creditText(account.quota.spendLimit) }}</span>
            </template>
          </span>
          <span class="asset-footer"><span :class="{ 'asset-attention': !!accountState(account) }">{{ accountState(account) || (account.quota ? '已查询用量' : '本机已保存') }}</span><span v-if="account.error && account.quota">上次查询结果</span><span v-else>查看详情</span></span>
        </button>
      </div>
      <a-pagination v-if="accounts.length > pageSize" v-model:current="accountPage" :total="accounts.length" :page-size="pageSize" :show-size-changer="false" class="asset-pagination" :show-total="(total: number) => `共 ${total} 个账号`" />
    </section>

    <section class="asset-section" aria-labelledby="overview-keys-heading">
      <div class="asset-heading">
        <div><h2 id="overview-keys-heading">供应商密钥 <span class="asset-count">{{ keys.length }}</span></h2><p>每把密钥独立展示，包含尚未启用连接的密钥。</p></div>
        <a-button type="link" @click="emit('manage-providers')">管理供应商与密钥 <ArrowRightOutlined /></a-button>
      </div>
      <div v-if="!keys.length" class="asset-empty"><span class="asset-empty-icon"><KeyOutlined /></span><strong>还没有供应商密钥</strong><p>添加供应商与密钥后，在这里查看模型和额度。</p><a-button @click="emit('manage-providers')">添加供应商与密钥</a-button></div>
      <div v-else class="asset-grid">
        <button v-for="item in visibleKeys" :key="`${item.provider.id}:${item.key.id}`" type="button" class="asset-card key-thumbnail" :data-provider-id="item.provider.id" :data-key-id="item.key.id" :aria-label="`查看 ${item.provider.name} 的密钥 ${item.key.name || '未命名密钥'}`" @click="emit('view-key', item.provider.id, item.key.id)">
          <span class="asset-identity"><span class="asset-icon"><KeyOutlined /></span><span class="asset-names"><strong :title="item.provider.name">{{ item.provider.name }}</strong><small :title="item.key.name || '未命名密钥'">{{ item.key.name || '未命名密钥' }}</small></span><ArrowRightOutlined class="asset-open" /></span>
          <span class="asset-meta"><span class="asset-chip">{{ item.provider.models.length }} 个模型</span><span class="asset-plan">{{ item.key.accountIds.length ? `${item.key.accountIds.length} 个已启用连接` : '未启用连接' }}</span></span>
          <span class="asset-quota key-quota"><span class="asset-quota-label">密钥额度</span><strong class="asset-balance" :title="keyUsage(item.key)">{{ keyUsage(item.key) }}</strong><span v-if="item.key.usage?.summary?.planName" class="asset-quota-note" :title="item.key.usage.summary.planName">{{ item.key.usage.summary.planName }}</span></span>
          <span class="asset-footer"><span :class="{ 'asset-attention': !!item.key.usage?.error }">{{ item.key.usage?.error ? item.key.usage.summary ? '刷新失败 · 上次结果' : '查询未成功' : item.key.usage?.summary?.isValid === false ? '密钥已失效' : '密钥已保存' }}</span><span>查看详情</span></span>
        </button>
      </div>
      <a-pagination v-if="keys.length > pageSize" v-model:current="keyPage" :total="keys.length" :page-size="pageSize" :show-size-changer="false" class="asset-pagination" :show-total="(total: number) => `共 ${total} 把密钥`" />
    </section>
  </div>
</template>

<style scoped>
.overview-assets { --asset-accent: #7c3aed; margin-top: 30px; display: grid; gap: 30px; }
:global(.dark) .overview-assets { --asset-accent: #b195ee; }
.asset-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 15px; }
.asset-heading h2 { display: flex; align-items: center; gap: 9px; font-size: 16px; margin: 0; letter-spacing: -.2px; }
.asset-heading p { color: var(--muted); font-size: 12px; margin: 7px 0 0; }
.asset-count { background: #7c3aed12; color: var(--asset-accent); font-size: 11px; font-weight: 600; min-width: 23px; padding: 2px 7px; border-radius: 6px; text-align: center; }
.asset-heading > .ant-btn { flex-shrink: 0; padding-right: 0; font-size: 12px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(245px, 1fr)); gap: 14px; }
.asset-card { display: flex; flex-direction: column; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 17px; text-align: left; color: var(--text); cursor: pointer; transition: border-color .16s, box-shadow .16s; }
.asset-card:hover { border-color: #9b72e5; box-shadow: 0 3px 14px #7c3aed0c; }
.asset-card:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 3px; }
.asset-identity { display: flex; align-items: center; gap: 10px; min-width: 0; width: 100%; }
.asset-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: #7c3aed10; color: #9370de; font-size: 17px; flex-shrink: 0; }
.asset-names { min-width: 0; flex: 1; }
.asset-names strong, .asset-names small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-names strong { font-size: 13px; }
.asset-names small { color: var(--muted); font-size: 11px; margin-top: 4px; }
.asset-open { color: var(--muted); font-size: 12px; flex-shrink: 0; }
.asset-meta { display: flex; align-items: center; gap: 7px; margin-top: 14px; min-width: 0; }
.asset-chip { padding: 3px 7px; border-radius: 5px; background: var(--subtle); color: var(--muted); font-size: 10px; white-space: nowrap; }
.asset-plan { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-quota { display: flex; flex-direction: column; gap: 9px; background: var(--subtle); border-radius: 8px; padding: 11px; margin-top: 13px; min-height: 69px; flex: 1; justify-content: center; }
.asset-unknown, .asset-quota-label { color: var(--muted); font-size: 11px; }
.asset-window { display: block; }
.asset-quota-row { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 10px; }
.asset-window-name { color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
.asset-quota-row strong { font-weight: 500; flex-shrink: 0; }
.asset-progress { display: block; height: 4px; border-radius: 4px; background: var(--border); overflow: hidden; margin-top: 6px; }
.asset-progress > span { display: block; height: 100%; background: #9372e7; border-radius: inherit; }
.asset-progress > span.exhausted { background: #e27678; }
.asset-quota-note, .asset-credit { font-size: 10px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.key-quota { gap: 6px; }
.asset-balance { font-size: 14px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.asset-footer { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--muted); margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border); }
.asset-attention { color: #c48036; }
.asset-pagination { margin-top: 18px; text-align: right; }
.asset-empty { display: flex; flex-direction: column; align-items: center; border: 1px dashed var(--border); border-radius: 12px; background: var(--surface); padding: 24px 16px; text-align: center; }
.asset-empty-icon { font-size: 21px; color: #9370de; margin-bottom: 10px; }
.asset-empty strong { font-size: 13px; }
.asset-empty p { font-size: 12px; color: var(--muted); margin: 7px 0 16px; }
@media (max-width: 760px) {
  .asset-heading { align-items: flex-start; flex-wrap: wrap; gap: 6px; }
  .asset-heading > .ant-btn { padding-left: 0; }
  .asset-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .asset-card { transition: none; } }
</style>
