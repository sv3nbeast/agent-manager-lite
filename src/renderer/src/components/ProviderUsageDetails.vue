<script setup lang="ts">
import {providerUsageNames,type ProviderUsageState} from '../../../shared/providerUsage'
defineProps<{usage?:ProviderUsageState}>()
function amount(value:number|undefined,unit:string|undefined):string{return value===undefined?'未知':`${value.toLocaleString('zh-CN',{maximumFractionDigits:4})} ${unit||'（单位未知）'}`}
</script>
<template>
    <div class="provider-usage">
      <a-alert v-if="usage?.error" :type="usage.unavailable ? 'info' : 'error'" :message="usage.error" class="quota-error" />
      <p v-if="!usage?.summary" class="muted">{{ usage ? '当前额度未知' : '尚未查询' }}</p>
      <template v-else>
        <p v-if="usage.summary.isValid === false" class="quota-limited">{{ usage.summary.windows?.length ? '服务商报告用量窗口已用尽' : usage.summary.source === 'deepseek' ? '服务商报告余额不足' : '服务商报告此密钥不可用' }}</p>
        <div class="quota-row"><span>{{ (usage.summary.windows?.length ?? 0) > 1 ? '最低窗口剩余' : '剩余额度' }}</span><strong>{{ amount(usage.summary.remaining ?? usage.summary.balance, usage.summary.unit) }}</strong></div>
        <p v-if="usage.summary.unlimited" class="muted">密钥不设额度上限</p>
        <div v-if="!usage.summary.windows?.length && usage.summary.limit !== undefined" class="quota-row"><span>额度上限</span><span>{{ amount(usage.summary.limit, usage.summary.unit) }}</span></div>
        <div v-if="!usage.summary.windows?.length && usage.summary.used !== undefined" class="quota-row"><span>已用额度</span><span>{{ amount(usage.summary.used, usage.summary.unit) }}</span></div>
        <div v-for="window in usage.summary.windows" :key="window.id" class="quota-window provider-plan-window">
          <div class="quota-row"><span>{{ window.name }}</span><strong>{{ window.remainingPercent === undefined ? '用量未知' : `已用 ${Number((100-window.remainingPercent).toFixed(2))}%` }}</strong></div>
          <a-progress v-if="window.remainingPercent !== undefined" :percent="100-window.remainingPercent" :show-info="false" size="small" :stroke-color="window.remainingPercent <= 10 ? '#ef6c65' : '#8372ef'" />
          <small class="muted">{{ window.resetsAt === undefined ? '重置时间未知' : `${new Date(window.resetsAt).toLocaleString()} 重置` }}</small>
        </div>
        <div v-if="usage.summary.todayRequests !== undefined" class="quota-row"><span>今日请求</span><span>{{ usage.summary.todayRequests.toLocaleString() }}</span></div>
        <div v-if="usage.summary.todayTokens !== undefined" class="quota-row"><span>今日 Token</span><span>{{ usage.summary.todayTokens.toLocaleString() }}</span></div>
        <details class="provider-usage-details">
          <summary>用量详情</summary>
          <template v-if="usage.summary.source === 'deepseek'">
            <div class="quota-row"><span>赠送余额</span><span>{{ amount(usage.summary.grantedBalance, usage.summary.unit) }}</span></div>
            <div class="quota-row"><span>充值余额</span><span>{{ amount(usage.summary.toppedUpBalance, usage.summary.unit) }}</span></div>
          </template>
          <template v-else-if="usage.summary.windows?.length">
            <div v-if="usage.summary.planName" class="quota-row"><span>套餐</span><span>{{ usage.summary.planName }}</span></div>
            <div v-if="usage.summary.modelName" class="quota-row"><span>模型</span><span>{{ usage.summary.modelName }}</span></div>
            <div v-for="window in usage.summary.windows" :key="window.id" class="quota-window">
              <div>{{ window.name }}</div>
              <div class="quota-row"><span>剩余数量</span><span>{{ window.remaining?.toLocaleString() ?? '未知' }}</span></div>
              <div class="quota-row"><span>总量</span><span>{{ window.limit?.toLocaleString() ?? '未知' }}</span></div>
              <div v-if="window.used !== undefined" class="quota-row"><span>已用数量</span><span>{{ window.used.toLocaleString() }}</span></div>
            </div>
          </template>
          <template v-else>
            <div class="quota-row"><span>今日费用</span><span>{{ amount(usage.summary.todayCost, usage.summary.unit) }}</span></div>
            <div class="quota-row"><span>累计请求</span><span>{{ usage.summary.totalRequests?.toLocaleString() ?? '未知' }}</span></div>
            <div class="quota-row"><span>累计 Token</span><span>{{ usage.summary.totalTokens?.toLocaleString() ?? '未知' }}</span></div>
            <div class="quota-row"><span>累计费用</span><span>{{ amount(usage.summary.totalCost, usage.summary.unit) }}</span></div>
          </template>
          <template v-if="usage.summary.source === 'new_api'">
            <div class="quota-row"><span>密钥到期</span><span>{{ usage.summary.expiresAt === undefined ? '未知' : new Date(usage.summary.expiresAt).toLocaleString() }}</span></div>
            <div class="quota-row"><span>服务访问截止</span><span>{{ usage.summary.accessUntil === undefined ? '未知' : new Date(usage.summary.accessUntil).toLocaleString() }}</span></div>
          </template>
        </details>
        <small class="muted">{{ providerUsageNames[usage.summary.source] }} · 更新于 {{ new Date(usage.summary.updatedAt).toLocaleString() }}{{ usage.error ? ' · 上次成功结果' : '' }}</small>
      </template>
    </div>
</template>
<style scoped>
.quota-row { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
.quota-window { margin:10px 0; }
.quota-error { margin:8px 0; font-size:12px; }
.quota-limited { color:#d95055; font-size:12px; }
.provider-usage .quota-row { margin:8px 0; }
.provider-usage-details { margin:10px 0; font-size:12px; }
.provider-usage-details summary { cursor:pointer; color:var(--muted); }
.provider-usage-details .quota-row > :last-child { min-width:0; overflow-wrap:anywhere; text-align:right; }
</style>
