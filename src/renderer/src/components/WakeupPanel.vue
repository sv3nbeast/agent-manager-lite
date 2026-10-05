<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, PlayCircleOutlined, StopOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useManager } from '../store'
import { useFormFeedback } from '../formFeedback'
import FormFeedback from './FormFeedback.vue'
import type { Account } from '../../../shared/types'
import type { WakeupScheduleKind, WakeupTask, WakeupTaskInput } from '../../../shared/wakeup'

const props = defineProps<{ accounts: Account[] }>()
const manager = useManager()
const editing = ref<WakeupTask>()
const open = ref(false)
const error = ref(''), saveError = ref('')
useFormFeedback(() => error.value, { active: () => open.value })
const kinds: { label: string; value: WakeupScheduleKind }[] = [
  { label: '启动时', value: 'startup' }, { label: '每天', value: 'daily' }, { label: '每周', value: 'weekly' },
  { label: '固定间隔', value: 'interval' }, { label: '额度窗口重置', value: 'quota_reset' }
]
const week = [{ label: '日', value: 0 }, { label: '一', value: 1 }, { label: '二', value: 2 }, { label: '三', value: 3 }, { label: '四', value: 4 }, { label: '五', value: 5 }, { label: '六', value: 6 }]
const draft = reactive<WakeupTaskInput>({ name: '', enabled: true, accountIds: [], prompt: '请发送一条简短的健康检查回复。', model: undefined, modelReasoningEffort: undefined, schedule: { kind: 'interval', intervalHours: 4, weeklyDays: [] } })
const tasks = computed(() => manager.data?.wakeup?.tasks ?? [])
const history = computed(() => manager.data?.wakeup?.history ?? [])
const running = computed(() => new Set(manager.data?.wakeup?.runningTaskIds ?? []))
const accountOptions = computed(() => props.accounts.map(account => ({ label: account.email ? `${account.name} · ${account.email}` : account.name, value: account.id })))
function reset(task?: WakeupTask) {
  error.value = ''; saveError.value = ''
  editing.value = task
  Object.assign(draft, task ? JSON.parse(JSON.stringify(task)) : { name: '', enabled: true, accountIds: props.accounts[0] ? [props.accounts[0].id] : [], prompt: '请发送一条简短的健康检查回复。', model: undefined, modelReasoningEffort: undefined, schedule: { kind: 'interval', intervalHours: 4, weeklyDays: [] } })
  open.value = true
}
async function save() {
  error.value = ''; saveError.value = ''
  if (!draft.accountIds.length) { error.value = '至少选择一个账号'; return }
  try {
    const payload: WakeupTaskInput = { ...JSON.parse(JSON.stringify(draft)), ...(editing.value ? { id: editing.value.id, revision: editing.value.revision } : {}) }
    if (await manager.execute(() => window.manager.wakeupSave(payload))) { open.value = false; message.success(editing.value ? '任务已更新' : '任务已创建') }
    else saveError.value = manager.error || '任务保存失败，请检查配置后重试。'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
async function toggle(enabled: boolean) { await manager.execute(() => window.manager.wakeupSetEnabled(enabled)) }
async function run(task: WakeupTask) { await manager.execute(() => window.manager.wakeupRunNow(task.id)); message.info('任务已开始，可在此页面取消') }
async function cancel(task: WakeupTask) { await manager.execute(() => window.manager.wakeupCancel(task.id)) }
function remove(task: WakeupTask) {
  Modal.confirm({ title: `删除任务“${task.name}”？`, content: '已保存的执行历史会保留，计划本身会被移除。', okType: 'danger', okText: '删除', cancelText: '取消', async onOk() { await manager.execute(() => window.manager.wakeupDelete(task.id)) } })
}
function scheduleSummary(task: WakeupTask) {
  const value = task.schedule
  if (value.kind === 'startup') return `启动后 ${value.startupDelayMinutes ?? 0} 分钟`
  if (value.kind === 'daily') return `每天 ${value.dailyTime}`
  if (value.kind === 'weekly') return `每周 ${value.weeklyDays.map(day => week.find(item => item.value === day)?.label).join('、')} ${value.weeklyTime}`
  if (value.kind === 'quota_reset') return `额度窗口重置（${value.quotaResetWindow === 'primary_window' ? '主窗口' : value.quotaResetWindow === 'secondary_window' ? '次窗口' : '任一窗口'}）`
  return `每 ${value.intervalHours} 小时`
}
function accountNames(ids: string[]) { return ids.map(id => props.accounts.find(account => account.id === id)?.name ?? '已删除账号').join('、') }
</script>

<template>
  <div class="wakeup-panel">
    <div class="page-heading"><div><h1>唤醒与计划任务</h1><p>按计划使用独立账号执行一次 Codex 健康检查，不占用正在运行的本地 API。</p></div><a-space><a-switch :checked="manager.data?.wakeup?.enabled ?? false" checked-children="自动运行" un-checked-children="已暂停" @change="toggle" /><a-button type="primary" @click="reset()"><PlusOutlined />新建任务</a-button></a-space></div>
    <a-alert v-if="manager.data?.wakeup?.lastError" type="warning" show-icon :message="manager.data.wakeup.lastError" class="error-banner" />
    <a-card v-if="!tasks.length" class="empty-panel"><a-empty description="还没有计划任务"><a-button type="primary" @click="reset()"><PlusOutlined />创建第一个任务</a-button></a-empty></a-card>
    <div v-else class="wakeup-list">
      <a-card v-for="task in tasks" :key="task.id" class="settings-card wakeup-card">
        <div class="wakeup-card-head"><div><strong>{{ task.name }}</strong><a-tag :color="task.enabled ? 'green' : undefined">{{ task.enabled ? '已启用' : '已停用' }}</a-tag><span class="muted">{{ scheduleSummary(task) }}</span></div><a-space><a-button v-if="running.has(task.id)" danger size="small" @click="cancel(task)"><StopOutlined />取消</a-button><a-button v-else size="small" @click="run(task)"><PlayCircleOutlined />立即运行</a-button><a-button size="small" @click="reset(task)">编辑</a-button><a-button size="small" danger type="text" @click="remove(task)"><DeleteOutlined /></a-button></a-space></div>
        <div class="wakeup-meta"><span>账号：{{ accountNames(task.accountIds) }}</span><span>模型：{{ task.model || '账号首选模型' }}</span><span v-if="task.nextRunAt">下次：{{ new Date(task.nextRunAt).toLocaleString() }}</span><span v-if="task.lastMessage">上次：{{ task.lastMessage }}</span></div>
        <p class="wakeup-prompt">{{ task.prompt }}</p>
      </a-card>
    </div>
    <a-card title="最近执行记录" class="settings-card"><template #extra><a-button size="small" @click="manager.load"><ReloadOutlined />刷新</a-button></template><a-table :data-source="history" :pagination="{ pageSize: 8, hideOnSinglePage: true }" row-key="id" size="small">
      <a-table-column key="timestamp" title="时间" data-index="timestamp"><template #default="{ record }">{{ new Date(record.timestamp).toLocaleString() }}</template></a-table-column>
      <a-table-column key="taskName" title="任务" data-index="taskName" />
      <a-table-column key="accountName" title="账号" data-index="accountName" />
      <a-table-column key="success" title="结果"><template #default="{ record }"><a-tag :color="record.success ? 'green' : 'red'">{{ record.success ? '成功' : record.error || '失败' }}</a-tag></template></a-table-column>
      <a-table-column key="reply" title="回复"><template #default="{ record }"><span class="history-reply">{{ record.reply || '—' }}</span></template></a-table-column>
    </a-table></a-card>
  </div>
  <a-modal v-model:open="open" :title="editing ? '编辑计划任务' : '新建计划任务'" :body-style="{maxHeight:'calc(100vh - 240px)',overflowY:'auto'}" ok-text="保存" cancel-text="取消" :confirm-loading="manager.loading" @ok="save">
    <a-form layout="vertical"><a-form-item label="名称"><a-input v-model:value="draft.name" maxlength="120" /></a-form-item><a-form-item label="账号"><a-select v-model:value="draft.accountIds" mode="multiple" :options="accountOptions" placeholder="选择要执行的账号" style="width: 100%" /></a-form-item><a-form-item label="模型（可选）"><a-input v-model:value="draft.model" placeholder="使用账号首选模型" /></a-form-item><a-form-item label="任务提示词"><a-textarea v-model:value="draft.prompt" :rows="4" maxlength="16000" show-count /></a-form-item><a-form-item label="计划类型"><a-select v-model:value="draft.schedule.kind" :options="kinds" /></a-form-item><template v-if="draft.schedule.kind === 'daily'"><a-form-item label="时间"><a-time-picker v-model:value="draft.schedule.dailyTime" value-format="HH:mm" format="HH:mm" /></a-form-item></template><template v-else-if="draft.schedule.kind === 'weekly'"><a-form-item label="星期"><a-checkbox-group v-model:value="draft.schedule.weeklyDays" :options="week" /></a-form-item><a-form-item label="时间"><a-time-picker v-model:value="draft.schedule.weeklyTime" value-format="HH:mm" format="HH:mm" /></a-form-item></template><template v-else-if="draft.schedule.kind === 'interval'"><a-form-item label="间隔（小时）"><a-input-number v-model:value="draft.schedule.intervalHours" :min="1" :max="744" /></a-form-item></template><template v-else-if="draft.schedule.kind === 'startup'"><a-form-item label="启动后延迟（分钟）"><a-input-number v-model:value="draft.schedule.startupDelayMinutes" :min="0" :max="1440" /></a-form-item></template><template v-else><a-form-item label="触发窗口"><a-select v-model:value="draft.schedule.quotaResetWindow" :options="[{ label: '任一窗口', value: 'either' }, { label: '主窗口', value: 'primary_window' }, { label: '次窗口', value: 'secondary_window' }]" /></a-form-item></template><a-form-item label="任务状态"><a-switch v-model:checked="draft.enabled" checked-children="启用" un-checked-children="停用" /></a-form-item></a-form>
    <template #footer><FormFeedback :error="saveError || error" /><a-space><a-button @click="open=false">取消</a-button><a-button type="primary" :loading="manager.loading" @click="save">保存</a-button></a-space></template>
  </a-modal>
</template>
