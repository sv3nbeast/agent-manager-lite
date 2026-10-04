<script setup lang="ts">
import type { CreditUsage } from '../../../shared/types'
defineProps<{ value: CreditUsage; label: string }>()
const number = (value: number | undefined) => value === undefined ? '未知' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
</script>
<template>
  <div class="credit-quota">
    <div class="credit-row"><span>{{ label }}</span><strong>{{ value.unlimited ? '不限量' : `剩余 ${number(value.remaining)}` }}</strong></div>
    <details v-if="value.limit !== undefined || value.used !== undefined || value.remainingPercent !== undefined || value.resetsAt !== undefined || value.balance !== undefined || value.unlimited && value.remaining !== undefined">
      <summary>额度详情</summary>
      <div v-if="value.limit !== undefined" class="credit-row"><span>额度上限</span><span>{{ number(value.limit) }}</span></div>
      <div v-if="value.used !== undefined" class="credit-row"><span>已用额度</span><span>{{ number(value.used) }}</span></div>
      <div v-if="value.unlimited && value.remaining !== undefined" class="credit-row"><span>上游报告剩余</span><span>{{ number(value.remaining) }}</span></div>
      <div v-if="value.balance !== undefined" class="credit-row"><span>余额</span><span>{{ number(value.balance) }}</span></div>
      <div v-if="value.remainingPercent !== undefined" class="credit-row"><span>剩余比例</span><span>{{ number(value.remainingPercent) }}%</span></div>
      <small v-if="value.resetsAt !== undefined" class="muted">{{ new Date(value.resetsAt).toLocaleString() }} 重置</small>
      <p class="muted">Credits 为上游额度单位，不等同于货币或 Token。</p>
    </details>
  </div>
</template>
<style scoped>
.credit-quota { margin: 10px 0; font-size: 12px; }
.credit-row { display: flex; justify-content: space-between; gap: 8px; margin: 6px 0; }
summary { cursor: pointer; color: var(--muted); margin: 6px 0; }
</style>
