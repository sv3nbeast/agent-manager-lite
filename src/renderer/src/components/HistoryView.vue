<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import type { HistoryFilter, HistoryPage } from '../../../shared/history'
import { useManager } from '../store'

const manager = useManager()
const filter = ref<HistoryFilter>({ search: '', outcome: 'all' })
const dates = ref<[string, string] | null>(null)
const page = ref(1), loading = ref(false), exporting = ref(false), error = ref('')
const result = ref<HistoryPage>({ entries: [], total: 0, succeeded: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, report: { models: [], accounts: [], tiers: [] } })
let sequence = 0, timer: ReturnType<typeof setInterval>
const tierLabel = (value: string | null, response = false) => value === null ? (response ? '未回显' : '未观测') : !value ? '未指定' : ['priority','fast'].includes(value) ? 'Fast' : ['default','standard'].includes(value) ? 'Standard' : value
const sourceLabel: Record<string, string> = { request: '客户端', instance: '实例默认', account: '账号默认', provider: '供应商/账号默认', global: '全局默认', follow: '跟随上游', transformed: '转发规则', unknown: '未观测' }
const accountReport = computed(() => result.value.report.accounts.map(row => ({ ...row, label: manager.data?.accounts.find(account => account.id === row.key)?.name || row.key || '未选择账号' })))
const reportColumns = [{ title: '维度', key: 'label' }, { title: '请求', dataIndex: 'requests', key: 'requests', width: 90 }, { title: '成功', dataIndex: 'succeeded', key: 'succeeded', width: 90 }, { title: '总 Token', dataIndex: 'totalTokens', key: 'totalTokens', width: 120 }]
function currentFilter(): HistoryFilter {
  return { ...filter.value, from: dates.value ? new Date(`${dates.value[0]}T00:00:00`).getTime() : undefined,
    to: dates.value ? new Date(`${dates.value[1]}T23:59:59.999`).getTime() : undefined }
}
async function load(reset = false) {
  if (reset) page.value = 1
  const current = ++sequence; loading.value = true
  try {
    const data = await window.manager.queryHistory({ filter: currentFilter(), page: page.value, pageSize: 25 })
    if (sequence === current) { result.value = data; error.value = '' }
  } catch (cause) { if (sequence === current) error.value = String(cause) }
  finally { if (sequence === current) loading.value = false }
}
async function cancelExport() { await window.manager.cancelHistoryExport() }
async function exportCSV() {
  exporting.value = true
  try {
    const output = await window.manager.exportHistory(currentFilter())
    message.info(output.cancelled ? '已取消导出' : `已导出 ${output.count} 条记录`)
  } catch (cause) { message.error(String(cause)) }
  finally { exporting.value = false }
}
onMounted(() => { void load(); timer = setInterval(() => { if (!loading.value) void load() }, 5000) })
onUnmounted(() => { ++sequence; clearInterval(timer) })
const columns = [
  { title: '时间 / 请求', key: 'request', width: 158 }, { title: '模型 / 账号', key: 'model', width: 155 },
  { title: '结果 / 耗时', key: 'status', width: 94 }, { title: 'Token', key: 'tokens', width: 95 },
  { title: '入站等级', key: 'inbound', width: 88 }, { title: '出站等级', key: 'outbound', width: 88 },
  { title: '上游回显', key: 'response', width: 88 }, { title: '等级来源', key: 'source', width: 88 }
]
</script>

<template>
  <div class="page-heading"><div><h1>调用记录</h1><p>查看实际转发结果与服务等级，记录保存在本机。</p></div><a-space><a-button v-if="exporting" @click="cancelExport">取消导出</a-button><a-button :loading="exporting" :disabled="exporting" @click="exportCSV">导出 CSV</a-button></a-space></div>
  <a-alert v-if="error || manager.data?.historyError" type="error" :message="error || manager.data?.historyError" class="error-banner" />
  <div class="stats-grid"><a-card><a-statistic title="筛选内请求" :value="result.total" /><small class="muted">成功 {{ result.succeeded }} · 失败 {{ result.total - result.succeeded }}</small></a-card><a-card><a-statistic title="输入 / 输出 Token" :value="result.inputTokens"><template #suffix> / {{ result.outputTokens.toLocaleString() }}</template></a-statistic></a-card><a-card><a-statistic title="缓存读取 Token" :value="result.cachedTokens" /></a-card></div>
  <a-card title="筛选汇总" class="history-report"><a-tabs><a-tab-pane key="models" tab="模型"><a-table size="small" :columns="reportColumns" :data-source="result.report.models" row-key="key" :pagination="false"><template #bodyCell="{ column, record }"><template v-if="column.key === 'label'">{{ record.key }}</template></template></a-table></a-tab-pane><a-tab-pane key="accounts" tab="账号"><a-table size="small" :columns="reportColumns" :data-source="accountReport" row-key="key" :pagination="false"><template #bodyCell="{ column, record }"><template v-if="column.key === 'label'">{{ record.label }}</template></template></a-table></a-tab-pane><a-tab-pane key="tiers" tab="出站等级"><a-table size="small" :columns="reportColumns" :data-source="result.report.tiers" row-key="key" :pagination="false"><template #bodyCell="{ column, record }"><template v-if="column.key === 'label'">{{ tierLabel(record.key, true) }}</template></template></a-table></a-tab-pane></a-tabs></a-card>
  <div class="history-filters"><a-input-search v-model:value="filter.search" placeholder="模型、账号、密钥名称或请求 ID" @search="load(true)" /><a-select v-model:value="filter.outcome" :options="[{label:'全部结果',value:'all'},{label:'成功',value:'success'},{label:'失败',value:'error'}]" @change="load(true)" /><a-range-picker v-model:value="dates" value-format="YYYY-MM-DD" @change="load(true)" /><a-button @click="load()">刷新</a-button></div>
  <a-table class="history-table" size="middle" row-key="seq" :columns="columns" :data-source="result.entries" :loading="loading" :pagination="false" :scroll="{ x: 900 }">
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'request'"><div>{{ new Date(record.requestedAt).toLocaleString() }}</div><a-tooltip :title="record.requestId"><code class="history-id">{{ record.requestId }}</code></a-tooltip><small v-if="record.apiKeyLabel" class="history-account muted">密钥：{{record.apiKeyLabel}}</small></template>
      <template v-else-if="column.key === 'model'"><div>{{ record.model }}</div><small v-if="record.upstreamModel !== record.model" class="muted">→ {{ record.upstreamModel }}</small><small class="history-account muted">{{ manager.data?.accounts.find(a => a.id === record.accountId)?.name || record.accountId || '未选择账号' }}</small></template>
      <template v-else-if="column.key === 'status'"><a-tag :color="record.success ? 'green' : 'red'">{{ record.success ? '成功' : '失败' }} {{ record.status || '' }}</a-tag><small class="history-account muted">{{ (record.latencyMs / 1000).toFixed(2) }} s</small></template>
      <template v-else-if="column.key === 'tokens'"><div>{{ record.inputTokens }} / {{ record.outputTokens }}</div><small class="muted">缓存 {{ record.cachedTokens }}</small></template>
      <template v-else-if="column.key === 'inbound'">{{ tierLabel(record.inboundTier) }}</template>
      <template v-else-if="column.key === 'outbound'">{{ tierLabel(record.outboundTier) }}</template>
      <template v-else-if="column.key === 'response'"><a-tag :color="['priority','fast'].includes(record.responseTier) ? 'purple' : undefined">{{ tierLabel(record.responseTier, true) }}</a-tag></template>
      <template v-else-if="column.key === 'source'">{{ sourceLabel[record.tierSource] }}</template>
    </template>
  </a-table>
  <a-pagination v-if="result.total > 25" v-model:current="page" :total="result.total" :page-size="25" :show-size-changer="false" class="pagination" @change="load()" />
  <p class="muted history-note">出站 Fast 表示请求已携带 priority；上游未回显时无法确认处理等级。Token 来自已报告用量，失败或中断的请求可能不含完整用量。</p>
</template>

<style scoped>
.history-filters { display: flex; gap: 12px; margin: 22px 0 16px; flex-wrap: wrap }
.history-filters .ant-input-search { max-width: 300px }.history-filters .ant-select { min-width: 110px }
.history-id { display: block; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted) }
.history-account { display: block; overflow-wrap: anywhere }.history-note { margin-top: 20px; font-size: 12px }.history-table { border: 1px solid var(--border); border-radius: 12px; overflow: hidden }
.history-report { margin-bottom: 18px }.history-report :deep(.ant-table-wrapper) { overflow-x: auto }
</style>
