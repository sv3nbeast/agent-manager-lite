<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { SessionRecord } from '../../../shared/sessions'
import type { InstanceLaunchPreview } from '../../../shared/instances'
import { useManager } from '../store'

const props = defineProps<{ snapshotId: string; record: SessionRecord; targetId: string }>()
const emit = defineEmits<{ close: []; started: [instanceId: string] }>()
const manager = useManager()
const preview = ref<InstanceLaunchPreview & { sessionId: string }>(), selectedCwd=ref(''), loading = ref(false), starting = ref(false), error = ref('')
let generation = 0, alive = true
async function discard(ticket?: string): Promise<void> {
  if (!ticket) return
  try { await window.manager.discardClaudeSessionResume(ticket) } catch (cause) { if (alive) error.value = String(cause) }
}
async function prepare(): Promise<void> {
  const current = ++generation, previous = preview.value?.ticket
  preview.value = undefined; loading.value = true; error.value = ''
  await discard(previous)
  if (!alive || current !== generation) return
  try {
    const sourceId=props.record.resumeSourceId
    if(!sourceId)throw new Error('Claude 会话来源已失效，请刷新列表')
    const candidates=props.record.cwdAvailableCandidates??[]
    const cwd=candidates.includes(selectedCwd.value)?selectedCwd.value:candidates[0]
    if(!cwd)throw new Error('会话记录中的项目目录当前不可用，请恢复项目目录后重试')
    selectedCwd.value=cwd
    const next = await window.manager.previewClaudeSessionResume({ snapshotId: props.snapshotId, sessionId: props.record.id, targetId: props.targetId, sourceId, cwd })
    if (!alive || current !== generation) { await discard(next.ticket); return }
    preview.value = next
  } catch (cause) { if (alive && current === generation) error.value = String(cause) }
  finally { if (alive && current === generation) loading.value = false }
}
async function close(): Promise<void> {
  if (starting.value) return
  generation++; const ticket = preview.value?.ticket; preview.value = undefined
  await discard(ticket); if (alive) emit('close')
}
async function start(): Promise<void> {
  if (!preview.value || starting.value) return
  const selected = preview.value
  starting.value = true; error.value = ''
  try {
    const started = await manager.execute(() => window.manager.startInstance(selected.ticket))
    if (!alive) return
    if (!started) { preview.value = undefined; await discard(selected.ticket); error.value = manager.error || '会话恢复未能开始，请刷新后重试'; return }
    preview.value = undefined; emit('started', selected.instanceId); emit('close')
  } finally { if (alive) starting.value = false }
}
watch(() => [props.snapshotId, props.record.id, props.targetId], () => { selectedCwd.value='';void prepare() })
onMounted(() => { void prepare() })
onUnmounted(() => { alive = false; generation++; void discard(preview.value?.ticket) })
</script>

<template>
  <a-modal open title="恢复 Claude 会话" :width="700" :closable="!starting" :mask-closable="!starting" :keyboard="!starting" @cancel="close">
    <div class="session-resume-preview">
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
      <a-spin :spinning="loading">
        <h3>{{record.title}}</h3>
        <p class="muted">从原项目目录启动此会话所属的 CLI 实例，继续已有对话。</p>
        <a-alert v-if="record.resumeIncludesAncestors" type="warning" message="此会话的消息父链连接到较早记录" description="继续时官方 CLI 会沿原生消息父链带入可达的祖先上下文，其中可能包含较早会话的消息；原会话和 transcript 文件不会被管理器改写。" class="resume-ancestor-note" />
        <a-form-item v-if="(props.record.cwdAvailableCandidates?.length??0)>1" label="选择项目目录"><a-select v-model:value="selectedCwd" aria-label="选择 Claude 会话项目目录" :disabled="loading||starting" :options="props.record.cwdAvailableCandidates!.map(path=>({value:path,label:path}))" @change="prepare" /></a-form-item>
        <a-alert v-if="(props.record.cwdCandidates?.length??0)>(props.record.cwdAvailableCandidates?.length??0)" type="warning" message="部分记录中的工作目录当前不可用，已从候选项中排除；请先恢复相应目录后刷新。" />
        <a-descriptions v-if="preview" :column="1" bordered size="small">
          <a-descriptions-item label="实例">{{preview.name}}</a-descriptions-item>
          <a-descriptions-item label="客户端">Claude Code CLI · {{preview.application}}</a-descriptions-item>
          <a-descriptions-item label="项目目录">{{preview.workingDirectory}}</a-descriptions-item>
          <a-descriptions-item label="账号 / 连接">{{preview.accountName}}</a-descriptions-item>
          <a-descriptions-item label="默认模型">{{preview.model}}</a-descriptions-item>
          <a-descriptions-item label="独立配置目录">{{preview.directory}}</a-descriptions-item>
          <a-descriptions-item label="会话 ID">{{preview.sessionId}}</a-descriptions-item>
        </a-descriptions>
      </a-spin>
    </div>
    <template #footer><a-button :disabled="starting" @click="close">取消</a-button><a-button v-if="!preview && !loading" :disabled="starting" @click="prepare">重新预览</a-button><a-button type="primary" :loading="starting" :disabled="loading || !preview" @click="start">在原实例恢复</a-button></template>
  </a-modal>
</template>

<style scoped>
.session-resume-preview h3{overflow-wrap:anywhere}.session-resume-preview>p{font-size:12px;line-height:1.7}.session-resume-preview :deep(.ant-descriptions-item-content){overflow-wrap:anywhere}.session-resume-preview :deep(.ant-descriptions-item-label){white-space:nowrap}.resume-ancestor-note{margin:12px 0}
</style>
