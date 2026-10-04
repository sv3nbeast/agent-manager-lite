<script setup lang="ts">
import { computed, ref } from 'vue'
import { EditOutlined, GlobalOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import type { Account } from '../../../shared/types'
import AccountQuota from './AccountQuota.vue'
import AccountIconAction from './AccountIconAction.vue'
import { accountCardDate, accountCardIdentity, accountCardPlan, accountCardStatus, accountCardTier } from './accountCardPresentation'

const props = defineProps<{
  account: Account
  selected: boolean
  refreshing: boolean
  groups: Array<{ id: string; name: string }>
  clientMaintained: boolean
  connectionLabel?: string
}>()
defineEmits<{ select: [checked: boolean]; edit: []; proxy: []; refresh: []; refreshSubscription: []; refreshResetCredits: []; consumeResetCredit: [] }>()
const quota = ref<{ openDetails(): void }>()
const identity = computed(() => accountCardIdentity(props.account, props.connectionLabel))
const status = computed(() => accountCardStatus(props.account))
const labels = computed(() => [
  ...props.groups.map(group => ({ key: `group:${group.id}`, name: group.name, type: '分组' })),
  ...props.account.tags.map(tag => ({ key: `tag:${tag}`, name: tag, type: '标签' }))
])
function openDetails() { quota.value?.openDetails() }
</script>

<template>
  <article class="account-card" :class="{ selected }" :data-account-id="account.id">
    <div class="account-header">
      <a-checkbox class="account-select" :checked="selected" :aria-label="`选择账号 · ${account.name}`" @change="$emit('select', $event.target.checked)" />
      <div class="account-identity">
        <strong :title="identity.name">{{ identity.name }}</strong>
        <small v-if="identity.subtitle" :title="identity.subtitle">{{ identity.subtitle }}</small>
        <p v-if="account.note" class="account-note" :title="account.note">备注：{{ account.note }}</p>
      </div>
      <a-tooltip :title="status.detail" :trigger="['hover', 'focus']"><span class="account-status" :class="`status-${status.tone}`" tabindex="0">{{ status.label }}</span></a-tooltip>
    </div>

    <div class="account-tags">
      <div class="account-plan-tags">
        <span class="account-plan">{{ accountCardPlan(account) }}</span>
        <span v-if="account.kind === 'oauth'" class="account-type">ChatGPT · OAuth</span>
        <span v-else-if="account.kind === 'agent_identity'" class="account-type">Agent Identity</span>
        <span v-else class="account-type">API 连接</span>
      </div>
      <div v-if="clientMaintained || labels.length" class="account-labels">
        <span v-if="clientMaintained" class="account-label client-maintained" title="在客户端配置中同步凭据或解除关联">客户端维护</span>
        <span v-for="label in labels.slice(0, clientMaintained ? 1 : 2)" :key="label.key" class="account-label" :title="`${label.type}：${label.name}`">{{ label.name }}</span>
        <a-button v-if="labels.length > (clientMaintained ? 1 : 2)" class="account-label-more" type="text" size="small" :aria-label="`查看全部分组与标签 · ${account.name}`" @click="openDetails">+{{ labels.length - (clientMaintained ? 1 : 2) }}</a-button>
      </div>
    </div>

    <AccountQuota ref="quota" :account="account" :refreshing="refreshing" @refresh="$emit('refresh')" @refresh-subscription="$emit('refreshSubscription')" @refresh-reset-credits="$emit('refreshResetCredits')" @consume-reset-credit="$emit('consumeResetCredit')">
      <template #details>
        <section class="account-detail-section" aria-label="账号信息">
          <h3>账号信息</h3>
          <dl class="account-detail-list">
            <div><dt>名称</dt><dd>{{ account.name || '未命名账号' }}</dd></div>
            <div v-if="account.email"><dt>邮箱</dt><dd>{{ account.email }}</dd></div>
            <div><dt>接入类型</dt><dd>{{ identity.type }}</dd></div>
            <div><dt>套餐 / 配置</dt><dd>{{ accountCardPlan(account) }}</dd></div>
            <div v-if="connectionLabel"><dt>供应商连接</dt><dd>{{ connectionLabel }}</dd></div>
            <div><dt>API 地址</dt><dd>{{ account.baseUrl || '未配置' }}</dd></div>
            <div><dt>接口协议</dt><dd>{{ account.wireApi === 'responses' ? 'Responses' : 'Chat Completions' }}</dd></div>
            <div><dt>默认速度</dt><dd>{{ accountCardTier(account) }}</dd></div>
            <div><dt>凭据状态</dt><dd>{{ account.needsTokenExchange ? '刷新令牌待验证' : account.credentialConfigured ? '凭据已保存' : '缺少凭据' }}{{ clientMaintained ? ' · 客户端维护登录' : '' }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ accountCardDate(account.createdAt) }}</dd></div>
            <div><dt>分组</dt><dd>{{ groups.map(group => group.name).join(' · ') || '未分组' }}</dd></div>
            <div><dt>标签</dt><dd>{{ account.tags.join(' · ') || '无标签' }}</dd></div>
            <div><dt>备注</dt><dd class="account-detail-note">{{ account.note || '无备注' }}</dd></div>
          </dl>
          <div class="account-models" :class="{ 'connection-models': account.kind === 'api_key' }"><h4>模型目录 <span>{{ account.models.length }} 个</span></h4><p>{{ account.models.join(' · ') || '模型目录尚未同步' }}</p></div>
        </section>
      </template>
    </AccountQuota>

    <footer class="account-actions" aria-label="账号操作">
      <AccountIconAction action-class="account-refresh" :label="refreshing ? '正在刷新用量' : '刷新用量'" :accessible-label="`刷新用量 · ${account.name}`" :loading="refreshing" @click="$emit('refresh')"><ReloadOutlined /></AccountIconAction>
      <AccountIconAction action-class="account-edit" label="编辑账号" :accessible-label="`编辑账号 · ${account.name}`" @click="$emit('edit')"><EditOutlined /></AccountIconAction>
      <AccountIconAction action-class="account-proxy" label="网络代理" :accessible-label="`网络代理 · ${account.name}`" @click="$emit('proxy')"><GlobalOutlined /></AccountIconAction>
      <AccountIconAction action-class="account-details" label="查看详情" :accessible-label="`查看详情 · ${account.name}`" @click="openDetails"><InfoCircleOutlined /></AccountIconAction>
    </footer>
  </article>
</template>

<style scoped>
.account-card { --card-muted: color-mix(in srgb, var(--muted) 76%, var(--text)); display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 14px 14px 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: none; transition: border-color 160ms ease, box-shadow 160ms ease; }
.account-card.selected { border-color: #8254e8; box-shadow: 0 0 0 1px #8254e8, 0 3px 12px rgb(124 58 237 / 5%); }
.account-header { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.account-identity { flex: 1; min-width: 0; }
.account-identity strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 1.6; font-weight: 650; color: var(--text); }
.account-identity small { display: block; margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1.5; color: var(--card-muted); }
.account-select { flex: 0 0 auto; align-self: flex-start; padding-top: 3px; }
.account-tags { display: flex; align-items: center; gap: 6px; margin: 0; flex-wrap: wrap; }
.account-plan-tags { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.account-plan,.account-type { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border-radius: 6px; font-size: 11px; line-height: 1.4; }
.account-plan { color: var(--text); background: var(--subtle); font-weight: 550; }
.account-type { color: #4269b4; background: color-mix(in srgb, #4269b4 7%, var(--surface)); }
.account-status { display: inline-flex; align-items: center; flex: 0 0 auto; margin-top: 1px; padding: 3px 7px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 5%, var(--surface)); white-space: nowrap; font-size: 10px; line-height: 1.4; color: var(--card-muted); }
.status-success { color: #247a52; }
.status-warning { color: #9c650e; }
.status-error { color: #c14952; }
:global(.app-shell.dark .account-card .status-success) { color: #81c8a5; }
:global(.app-shell.dark .account-card .status-warning) { color: #e8b569; }
:global(.app-shell.dark .account-card .status-error) { color: #ed9096; }
:global(.app-shell.dark .account-card .account-type) { color: #9bbaf2; background: color-mix(in srgb, #9bbaf2 8%, var(--surface)); }
.account-labels { display: flex; align-items: center; gap: 5px; min-width: 0; }
.account-label { display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 95px; border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; color: var(--card-muted); font-size: 10px; line-height: 1.7; }
.client-maintained { color: color-mix(in srgb, #3d7abd 80%, var(--text)); }
.account-label-more { height: 22px; padding: 0 5px; font-size: 11px; color: var(--card-muted); }
.account-note { min-width: 0; margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--card-muted); font-size: 11px; line-height: 1.65; }
.account-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: auto; padding: 3px 0; border-top: 1px solid var(--border); }
.account-actions :deep(.ant-btn) { padding: 0; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; font-size: 16px; color: var(--card-muted); }
.account-actions :deep(.ant-btn:not(:disabled):hover) { color: #8052e5; background: color-mix(in srgb, #8254e8 7%, var(--surface)); }
:global(.app-shell.dark .account-card .account-actions .ant-btn:not(:disabled):hover) { color: #c4a8ff; }
.account-actions :deep(.ant-btn:disabled) { opacity: .6; }
.account-actions :deep(.ant-btn .anticon + span) { margin-inline-start: 0; }
.account-actions :deep(.ant-btn:focus-visible),.account-label-more:focus-visible,.account-status:focus-visible { outline: 2px solid #8254e8; outline-offset: 2px; }
.account-detail-section { --card-muted: color-mix(in srgb, var(--muted) 72%, var(--text)); margin-top: 24px; }
.account-detail-section h3 { font-size: 14px; font-weight: 650; margin: 0 0 15px; color: var(--text); }
.account-detail-list { margin: 0; }
.account-detail-list > div { display: grid; grid-template-columns: 94px minmax(0,1fr); gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12px; line-height: 1.7; }
.account-detail-list dt { color: var(--card-muted); }
.account-detail-list dd { margin: 0; color: var(--text); overflow-wrap: anywhere; }
.account-detail-note { white-space: pre-wrap; }
.account-models { margin-top: 22px; min-height: 0; font-size: 12px; }
.account-models h4 { font-size: 13px; color: var(--text); margin: 0 0 10px; font-weight: 600; }
.account-models h4 span { font-size: 11px; color: var(--card-muted); font-weight: 400; margin-left: 5px; }
.account-models p { margin: 0; color: var(--card-muted); overflow-wrap: anywhere; line-height: 1.8; }
@media (prefers-reduced-motion: reduce) { .account-card { transition: none; } }
</style>
