<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import type { StagedImport } from '../../../shared/types'
import { useManager } from '../store'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const manager = useManager()
const raw = ref(''), error = ref(''), busy = ref(false)
const staged = ref<StagedImport>()
let generation = 0
let mounted = true
let selectionId: string | undefined
function discard(ticket?: string) { if (ticket) void window.manager.discardImport(ticket).catch(() => {}) }
function clear() {
  generation++
  discard(staged.value?.ticket)
  const pendingSelection = selectionId
  selectionId = undefined
  if (pendingSelection) void window.manager.cancelImportFileSelection(pendingSelection).catch(() => {})
  staged.value = undefined
  error.value = ''
  busy.value = false
}
watch(() => props.open, () => { clear(); raw.value = '' })
onUnmounted(() => { mounted = false; clear(); raw.value = '' })
async function inspect(file: boolean) {
  if (busy.value || manager.loading || !props.open) return
  clear(); busy.value = true
  const started = generation
  const fileSelection = file ? crypto.randomUUID() : undefined
  selectionId = fileSelection
  try {
    const result = file ? await window.manager.chooseImportFile(fileSelection) : await window.manager.stageImport(raw.value)
    if (mounted && props.open && started === generation) staged.value = result
    else discard(result?.ticket)
  } catch (e) { if (mounted && props.open && started === generation) error.value = String(e) }
  finally {
    if (selectionId === fileSelection) selectionId = undefined
    if (mounted && started === generation) busy.value = false
  }
}
async function confirm() {
  if (!staged.value || busy.value || manager.loading || !props.open || !staged.value.preview.entries.length || staged.value.preview.errors.length) return
  const ticket = staged.value.ticket
  const started = generation
  if (await manager.execute(async () => {
    const result = await window.manager.commitImport(ticket)
    if (mounted && props.open && started === generation) message.success(`已导入 ${result.added} 个账号，跳过 ${result.duplicates} 个重复账号${result.skipped ? `及 ${result.skipped} 个其他平台账号` : ''}`)
    return result.snapshot
  }) && mounted && props.open && started === generation) { staged.value = undefined; emit('update:open', false); raw.value = '' }
}
</script>

<template>
  <a-modal class="account-import-modal" :open="open" title="导入 Codex 账号" :width="660" :footer="null" @cancel="emit('update:open', false)">
    <p class="muted">支持 auth.json、兼容账号库导出、登录身份 JSON、JSONL 和登录令牌。先预览后导入；已有账号不会被覆盖。导入的 API Key 连接在供应商页管理。</p>
    <a-button :loading="busy" :disabled="manager.loading" @click="inspect(true)">选择本机账号文件</a-button>
    <p v-if="staged?.fileName" class="muted">文件：{{ staged.fileName }}</p>
    <a-textarea v-model:value="raw" placeholder="或粘贴账号 JSON / 每行一个 access_token、at-… 或 refresh_token" :rows="7" style="margin-top: 14px" :disabled="busy || manager.loading" @change="clear" />
    <a-alert v-if="error || manager.error" type="error" :message="error || manager.error" class="error-banner" />
    <div v-if="staged" class="import-preview">
      <a-alert v-for="item in staged.preview.errors" :key="item" type="error" :message="item" />
      <p>识别到 {{ staged.preview.entries.length }} 个账号<span v-if="staged.preview.skipped">，跳过 {{ staged.preview.skipped }} 个其他平台账号</span></p>
      <a-alert v-if="staged.preview.entries.some(entry => entry.needsVerification)" type="info" message="仅含 refresh_token 的账号会先保存为待验证，刷新用量或启动本地 API 时再交换令牌。" />
      <div v-for="entry in staged.preview.entries.slice(0, 20)" :key="entry.index"><a-tag>{{ entry.kind }}</a-tag>{{ entry.name }}<a-tag v-if="entry.needsVerification" color="orange">待验证</a-tag></div>
      <p v-if="staged.preview.entries.length > 20" class="muted">其余 {{ staged.preview.entries.length - 20 }} 项已识别</p>
    </div>
    <div class="modal-actions"><a-button :loading="busy" :disabled="!raw.trim() || manager.loading" @click="inspect(false)">预览粘贴内容</a-button><a-button type="primary" :disabled="!staged?.preview.entries.length || !!staged.preview.errors.length || busy" :loading="manager.loading" @click="confirm">确认导入</a-button></div>
  </a-modal>
</template>
