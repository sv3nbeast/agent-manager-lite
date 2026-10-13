<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import { accountInputSchema, type StagedImport } from '../../../shared/types'
import { useManager } from '../store'
import { focusFirstInvalidField, validationErrors } from '../formFeedback'

const props = defineProps<{ mode: 'token' | 'json' | 'api'; active: boolean; clientType?: 'codex' | 'claude_code' }>()
const emit = defineEmits<{ busy: [value: boolean]; imported: [accountIds: string[]] }>()
const manager = useManager()
const raw = ref(''), error = ref(''), busy = ref(false), committing = ref(false)
const staged = ref<StagedImport>()
const showCredentials = ref(false)
const apiName = ref(''), apiBaseUrl = ref('https://api.anthropic.com'), apiSecret = ref(''), apiModels = ref<string[]>([])
const apiCredentialKind = ref<'api_key' | 'bearer'>('api_key')
const fieldErrors = ref<Record<string, string>>({})
const isClaude = computed(() => props.clientType === 'claude_code')
let generation = 0
let mounted = true
let fileSelectionId: string | undefined
const unsupportedImport = computed(() => isClaude.value && !!staged.value?.preview.entries.some(entry => entry.kind !== 'api_key'))
const canConfirm = computed(() => !!staged.value?.preview.entries.length && !staged.value.preview.errors.length && !unsupportedImport.value && !busy.value && !committing.value)
const kindLabels = { oauth: '登录身份', agent_identity: 'Agent Identity', api_key: 'API 连接' }

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
  fieldErrors.value = {}
  if (clearDraft) {
    raw.value = ''; showCredentials.value = false
    apiName.value = ''; apiBaseUrl.value = 'https://api.anthropic.com'; apiSecret.value = ''; apiModels.value = []; apiCredentialKind.value = 'api_key'
  }
}
watch(() => [props.active, props.mode, props.clientType], () => clearPreview(true), { flush: 'sync' })
watch(() => [apiName.value, apiBaseUrl.value, apiSecret.value, apiCredentialKind.value, JSON.stringify(apiModels.value)], () => clearPreview(), { flush: 'sync' })
watch(() => busy.value || committing.value, value => emit('busy', value), { immediate: true })
onUnmounted(() => { mounted = false; clearPreview(true); emit('busy', false) })

async function inspect(file: boolean): Promise<void> {
  if (busy.value || committing.value || !props.active) return
  clearPreview()
  let importText = raw.value
  if (props.mode === 'api') {
    const input = accountInputSchema.pick({ name: true, apiKey: true, baseUrl: true, models: true }).safeParse({ name: apiName.value, apiKey: apiSecret.value, baseUrl: apiBaseUrl.value.trim(), models: [...new Set(apiModels.value.map(value => value.trim()).filter(Boolean))] })
    if (!input.success) {
      fieldErrors.value = validationErrors(input.error.issues, { name: '连接名称', apiKey: apiCredentialKind.value === 'bearer' ? 'Bearer Token' : 'API Key', baseUrl: 'API 地址', models: '模型' })
      error.value = Object.values(fieldErrors.value)[0] || '请检查 API 连接'
      void focusFirstInvalidField('.claude-api-connection')
      return
    }
    const url = new URL(input.data.baseUrl)
    if (url.search || url.hash) { fieldErrors.value.baseUrl = 'API 地址不能包含查询参数或片段'; error.value = fieldErrors.value.baseUrl; return }
    importText = JSON.stringify({ identityService: 'anthropic', name: input.data.name, baseUrl: input.data.baseUrl, models: input.data.models,
      [apiCredentialKind.value === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: input.data.apiKey })
  }
  const started = generation
  const selectionId = file ? crypto.randomUUID() : undefined
  fileSelectionId = selectionId
  busy.value = true
  try {
    const result = file
      ? await window.manager.chooseImportFile(selectionId, props.clientType ?? 'codex')
      : await window.manager.stageImport(importText, props.clientType ?? 'codex')
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
    apiSecret.value = ''
    emit('imported', result.accountIds ?? [])
  } catch (cause) {
    if (mounted && props.active && started === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (mounted) committing.value = false }
}
</script>

<template>
  <section class="credential-import-panel">
    <a-form v-if="mode === 'api'" layout="vertical" class="claude-api-connection">
      <p class="muted">为 Claude Code CLI 添加 Anthropic Messages 连接。填写供应商提供的地址、密钥和模型，保存后可供多个实例复用。</p>
      <a-form-item label="连接名称" required :validate-status="fieldErrors.name ? 'error' : undefined" :help="fieldErrors.name"><a-input v-model:value="apiName" aria-label="Claude 连接名称" :maxlength="120" :disabled="busy || committing" /></a-form-item>
      <a-form-item label="API 地址" required :validate-status="fieldErrors.baseUrl ? 'error' : undefined" :help="fieldErrors.baseUrl"><a-input v-model:value="apiBaseUrl" aria-label="Claude API 地址" placeholder="https://api.anthropic.com" :disabled="busy || committing" /></a-form-item>
      <a-form-item label="认证方式"><a-select v-model:value="apiCredentialKind" aria-label="Claude 认证方式" :disabled="busy || committing" :options="[{value:'api_key',label:'API Key（x-api-key）'},{value:'bearer',label:'Bearer Token（Authorization）'}]" /></a-form-item>
      <a-form-item :label="apiCredentialKind === 'bearer' ? 'Bearer Token' : 'API Key'" required :validate-status="fieldErrors.apiKey ? 'error' : undefined" :help="fieldErrors.apiKey"><a-input-password v-model:value="apiSecret" aria-label="Claude API 凭据" autocomplete="off" spellcheck="false" :disabled="busy || committing" /></a-form-item>
      <a-form-item label="模型" required :validate-status="fieldErrors.models ? 'error' : undefined" :help="fieldErrors.models"><a-select v-model:value="apiModels" mode="tags" aria-label="Claude 连接模型" :token-separators="[',','\n']" :disabled="busy || committing" placeholder="填写供应商支持的模型 ID，按回车添加" /><p class="muted">第一个模型作为默认值；模型名称以供应商实际支持为准。</p></a-form-item>
    </a-form>
    <template v-else-if="mode === 'token'">
      <p class="muted">粘贴已有的 {{ props.clientType === 'claude_code' ? 'Claude' : 'ChatGPT' }} 登录令牌，每行一个。支持对应客户端的 Token 或完整 JSON。</p>
      <a-alert v-if="!isClaude" type="info" message="仅有 refresh_token 的账号会保存为待验证；刷新用量或使用账号时再完成验证。" show-icon class="error-banner" />
    </template>
    <template v-else>
      <p class="muted">选择 {{ isClaude ? 'Anthropic API Key / Bearer 连接 JSON 文件' : 'auth.json、账号 JSON / JSONL 文件' }}，或粘贴导出的账号数据。可以一次导入多个账号，已有账号不会被覆盖。</p>
      <a-button :disabled="busy || committing || !active" @click="inspect(true)">选择账号文件</a-button>
      <p v-if="staged?.fileName" class="muted import-file-name">已选择：{{ staged.fileName }}</p>
    </template>
    <a-textarea v-if="mode !== 'api'" v-model:value="raw" class="credential-draft" :class="{ 'credential-hidden': !showCredentials }" :rows="7" :disabled="busy || committing || !active" autocomplete="off" spellcheck="false" :placeholder="isClaude ? '包含 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN、baseUrl、models 的 JSON' : mode === 'token' ? '每行一个登录令牌，或粘贴完整 tokens JSON' : '粘贴 auth.json、账号数组或每行一个账号对象的 JSONL'" @change="clearPreview()" />
    <div v-if="mode !== 'api'" class="credential-options"><a-checkbox v-model:checked="showCredentials" :disabled="busy || committing">显示粘贴内容</a-checkbox><span class="muted">关闭窗口后清空内容</span></div>
    <a-alert v-if="error" type="error" :message="error" show-icon class="error-banner" />
    <div v-if="staged" class="credential-preview">
      <a-alert v-for="item in staged.preview.errors" :key="item" type="error" :message="item" class="error-banner" />
      <a-alert v-if="unsupportedImport" type="warning" message="Claude CLI 当前只支持 API Key 与 Bearer 连接。订阅 OAuth 登录仍待验收，请从本次导入中移除。" class="error-banner" />
      <p><strong>识别到 {{ staged.preview.entries.length }} 个账号</strong><span v-if="staged.preview.skipped" class="muted">，跳过 {{ staged.preview.skipped }} 个其他平台账号</span></p>
      <div v-for="entry in staged.preview.entries.slice(0, 20)" :key="entry.index" class="credential-preview-row"><a-tag>{{ props.clientType === 'claude_code' ? (entry.kind === 'oauth' ? 'Claude OAuth' : 'Anthropic API') : kindLabels[entry.kind] }}</a-tag><span>{{ entry.name }}</span><a-tag v-if="entry.needsVerification" color="orange">待验证</a-tag></div>
      <p v-if="staged.preview.entries.length > 20" class="muted">其余 {{ staged.preview.entries.length - 20 }} 个账号也已识别</p>
      <p v-if="staged.preview.entries.some(entry => entry.kind === 'api_key')" class="muted">{{ isClaude ? '连接加密保存在本应用，可在创建 Claude 实例时重复选择。' : 'API Key 连接导入后在供应商页管理。' }}</p>
    </div>
    <a-space class="credential-actions"><a-button :loading="busy" :disabled="(mode !== 'api' && !raw.trim()) || committing || !active" @click="inspect(false)">{{ mode === 'api' ? '检查连接配置' : '预览粘贴内容' }}</a-button><a-button type="primary" :loading="committing" :disabled="!canConfirm || !active" @click="confirm">{{ mode === 'api' ? '保存连接' : '确认导入' }}</a-button></a-space>
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
