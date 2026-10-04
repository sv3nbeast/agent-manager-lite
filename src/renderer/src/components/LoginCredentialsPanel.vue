<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import type { StagedImport } from '../../../shared/types'
import { useManager } from '../store'

const props = defineProps<{ mode: 'token' | 'json'; active: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; imported: [accountIds: string[]] }>()
const manager = useManager()
const raw = ref(''), error = ref(''), busy = ref(false), committing = ref(false)
const staged = ref<StagedImport>()
const showCredentials = ref(false)
let generation = 0
let mounted = true
let fileSelectionId: string | undefined
const canConfirm = computed(() => !!staged.value?.preview.entries.length && !staged.value.preview.errors.length && !busy.value && !committing.value)
const kindLabels = { oauth: 'ChatGPT', agent_identity: 'ChatGPT 登录身份', api_key: '供应商连接' }

function discard(ticket?: string): void {
  if (ticket) void window.manager.discardImport(ticket).catch(() => undefined)
}
function clearPreview(clearDraft = false): void {
  generation++
  const selection = fileSelectionId
  fileSelectionId = undefined
  if (selection) void window.manager.cancelImportFileSelection(selection).catch(() => undefined)
  discard(staged.value?.ticket)
  staged.value = undefined
  error.value = ''
  if (clearDraft) { raw.value = ''; showCredentials.value = false }
}
watch(() => [props.active, props.mode], () => clearPreview(true))
watch(() => busy.value || committing.value, value => emit('busy', value), { immediate: true })
onUnmounted(() => { mounted = false; clearPreview(true); emit('busy', false) })

async function inspect(file: boolean): Promise<void> {
  if (busy.value || committing.value || !props.active) return
  clearPreview()
  const started = generation
  const selectionId = file ? crypto.randomUUID() : undefined
  fileSelectionId = selectionId
  busy.value = true
  try {
    const result = file ? await window.manager.chooseImportFile(selectionId) : await window.manager.stageImport(raw.value)
    if (mounted && props.active && started === generation) staged.value = result
    else discard(result?.ticket)
  } catch (cause) {
    if (mounted && props.active && started === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (fileSelectionId === selectionId) fileSelectionId = undefined
    if (mounted) busy.value = false
  }
}
async function confirm(): Promise<void> {
  if (!canConfirm.value || !props.active) return
  const ticket = staged.value!.ticket
  const started = generation
  committing.value = true
  error.value = ''
  try {
    let result: Awaited<ReturnType<typeof window.manager.commitImport>> | undefined
    const saved = await manager.execute(async () => {
      result = await window.manager.commitImport(ticket)
      return result.snapshot
    })
    if (!saved || !result) throw new Error(manager.error || '导入未完成，请重试。')
    if (!mounted || !props.active || started !== generation) return
    message.success(`已导入 ${result.added} 个账号，跳过 ${result.duplicates} 个已有账号${result.skipped ? `及 ${result.skipped} 个其他平台账号` : ''}`)
    staged.value = undefined
    raw.value = ''
    emit('imported', result.accountIds ?? [])
  } catch (cause) {
    if (mounted && props.active && started === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (mounted) committing.value = false }
}
</script>

<template>
  <section class="credential-import-panel">
    <template v-if="mode === 'token'">
      <p class="muted">粘贴已有的 ChatGPT 登录令牌，每行一个。支持 access_token、at-… 个人访问令牌或 refresh_token，也可粘贴包含完整 tokens 的 JSON。</p>
      <a-alert type="info" message="仅有 refresh_token 的账号会保存为待验证；刷新用量或使用账号时再完成验证。" show-icon class="error-banner" />
    </template>
    <template v-else>
      <p class="muted">选择 auth.json、账号 JSON / JSONL 文件，或粘贴导出的账号数据。可以一次导入多个账号，已有账号不会被覆盖。</p>
      <a-button :disabled="busy || committing || !active" @click="inspect(true)">选择账号文件</a-button>
      <p v-if="staged?.fileName" class="muted import-file-name">已选择：{{ staged.fileName }}</p>
    </template>
    <a-textarea v-model:value="raw" class="credential-draft" :class="{ 'credential-hidden': !showCredentials }" :rows="7" :disabled="busy || committing || !active" autocomplete="off" spellcheck="false" :placeholder="mode === 'token' ? '每行一个登录令牌，或粘贴完整 tokens JSON' : '粘贴 auth.json、账号数组或每行一个账号对象的 JSONL'" @change="clearPreview()" />
    <div class="credential-options"><a-checkbox v-model:checked="showCredentials" :disabled="busy || committing">显示粘贴内容</a-checkbox><span class="muted">关闭窗口后清空内容</span></div>
    <a-alert v-if="error" type="error" :message="error" show-icon class="error-banner" />
    <div v-if="staged" class="credential-preview">
      <a-alert v-for="item in staged.preview.errors" :key="item" type="error" :message="item" class="error-banner" />
      <p><strong>识别到 {{ staged.preview.entries.length }} 个账号</strong><span v-if="staged.preview.skipped" class="muted">，跳过 {{ staged.preview.skipped }} 个其他平台账号</span></p>
      <div v-for="entry in staged.preview.entries.slice(0, 20)" :key="entry.index" class="credential-preview-row"><a-tag>{{ kindLabels[entry.kind] }}</a-tag><span>{{ entry.name }}</span><a-tag v-if="entry.needsVerification" color="orange">待验证</a-tag></div>
      <p v-if="staged.preview.entries.length > 20" class="muted">其余 {{ staged.preview.entries.length - 20 }} 个账号也已识别</p>
      <p v-if="staged.preview.entries.some(entry => entry.kind === 'api_key')" class="muted">API Key 连接导入后在供应商页管理。</p>
    </div>
    <a-space class="credential-actions"><a-button :loading="busy" :disabled="!raw.trim() || committing || !active" @click="inspect(false)">预览粘贴内容</a-button><a-button type="primary" :loading="committing" :disabled="!canConfirm || !active" @click="confirm">确认导入</a-button></a-space>
  </section>
</template>

<style scoped>
.credential-import-panel > .muted { line-height: 1.7; }
.credential-draft { margin-top: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.credential-draft.credential-hidden { -webkit-text-security: disc; }
.credential-options { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0 16px; }
.credential-options .muted { font-size: 12px; }
.credential-preview { padding: 4px 0 8px; }
.credential-preview-row { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
.credential-preview-row > span { overflow-wrap: anywhere; }
.credential-actions { margin: 14px 0 8px; }
.import-file-name { margin: 10px 0 0; overflow-wrap: anywhere; }
</style>
