<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useManager } from '../store'
import type { Account } from '../../../shared/types'
import type { ProxyMode, ProxyProbeResult } from '../../../shared/accountProxy'

const props = defineProps<{ open: boolean; account?: Account }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const manager = useManager()
const mode = ref<ProxyMode>('inherit'), initialMode = ref<ProxyMode>('inherit')
const url = ref(''), revision = ref(0), error = ref('')
const resourceId = ref(''), initialResourceId = ref(''), legacyResource = ref(false)
const result = ref<ProxyProbeResult>(), requestId = ref(''), saveId = ref('')
const saving = computed(() => !!saveId.value)
const busy = computed(() => saving.value || !!requestId.value)
const current = computed(() => manager.data?.accounts.find(account => account.id === props.account?.id))
const resources = computed(() => manager.data?.proxyResources?.resources ?? [])
const resource = computed(() => resources.value.find(value => value.id === resourceId.value))
const resourceOptions = computed(() => {
  const options = resources.value.map(value => ({ value: value.id, label: value.name, disabled: !!value.address.invalid }))
  if (initialResourceId.value && !options.some(option => option.value === initialResourceId.value)) options.push({ value: initialResourceId.value, label: '已保存代理资源（不可用）', disabled: true })
  return options
})
const options = computed(() => [
  { value: 'inherit', label: '默认网络' }, { value: 'direct', label: '直连' }, { value: 'custom', label: '指定代理' },
  ...(legacyResource.value ? [{ value: 'resource', label: '已保存代理资源' }] : [])
])
const hasSavedCustom = computed(() => current.value?.egressProxy?.mode === 'custom' && !current.value.egressProxy.invalid)
const incomplete = computed(() => !current.value || mode.value === 'custom' && !url.value.trim() && !hasSavedCustom.value || mode.value === 'resource' && (!resource.value || resource.value.address.invalid))
const dirty = computed(() => mode.value !== initialMode.value || resourceId.value !== initialResourceId.value || !!url.value.trim())
const summary = computed(() => {
  const value = current.value?.egressProxy
  if (!value || value.mode === 'inherit') return '默认网络'
  if (value.mode === 'direct') return '直连'
  if (value.invalid) return '已保存配置无效'
  if (value.server && value.port) {
    const host = value.server.includes(':') && !value.server.startsWith('[') ? `[${value.server}]` : value.server
    return `${host}:${value.port}`
  }
  return value.mode === 'resource' ? '已保存代理资源' : '已保存代理'
})
let generation = 0, alive = true
function displayError(cause: unknown, inputUrl = url.value.trim()): string {
  let text = (cause instanceof Error ? cause.message : String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/, '').replace(/^Error: /, '')
  if (inputUrl) text = text.split(inputUrl).join('[代理地址]')
  return text.replace(/(?:https?|socks5h?):\/\/[^\s]+/gi, '[代理地址]')
}
function resetDraft() {
  const proxy = current.value?.egressProxy
  mode.value = proxy?.mode ?? 'inherit'; initialMode.value = mode.value
  revision.value = current.value?.revision ?? 0
  initialResourceId.value = proxy?.mode === 'resource' ? proxy.resourceId ?? '' : ''
  resourceId.value = initialResourceId.value; legacyResource.value = proxy?.mode === 'resource'
  url.value = ''; error.value = ''; result.value = undefined
}
watch([() => props.open, () => props.account?.id], ([open]) => {
  void cancelTest(); saveId.value = ''
  if (open) resetDraft()
}, { immediate: true })
watch(() => current.value?.revision, () => { if (props.open && !dirty.value && !busy.value) resetDraft() })
watch([mode, url, resourceId], () => { result.value = undefined; error.value = '' })
async function cancelTest() {
  generation++
  const id = requestId.value; requestId.value = ''
  if (id) await window.manager.cancelAccountProxyProbe(id).catch(() => {})
}
function close() { void cancelTest(); saveId.value = ''; emit('update:open', false) }
async function save() {
  const account = current.value
  if (!account || busy.value || incomplete.value || manager.loading) return
  const id = crypto.randomUUID(), version = ++generation, inputUrl = url.value.trim()
  const input = { accountId: account.id, revision: revision.value, mode: mode.value,
    ...(mode.value === 'custom' && inputUrl ? { url: inputUrl } : {}),
    ...(mode.value === 'resource' ? { resourceId: resource.value?.id, resourceRevision: resource.value?.revision } : {}) }
  saveId.value = id; error.value = ''; result.value = undefined
  let failure = ''
  try {
    const confirmed = await manager.execute(async () => {
      try { return await window.manager.saveAccountProxy(input) }
      catch (cause) { failure = displayError(cause, inputUrl); throw new Error(failure) }
    })
    if (!alive || !props.open || props.account?.id !== account.id || version !== generation || saveId.value !== id) return
    if (confirmed) { url.value = ''; message.success('账号网络代理已保存'); emit('update:open', false) }
    else error.value = failure || '代理保存失败，请重试'
  } finally { if (saveId.value === id) saveId.value = '' }
}
async function probe() {
  const account = current.value
  if (!account || busy.value || incomplete.value) return
  const id = crypto.randomUUID(), version = ++generation, inputUrl = url.value.trim()
  requestId.value = id; error.value = ''; result.value = undefined
  try {
    const value = await window.manager.probeAccountProxy({ accountId: account.id, revision: revision.value, requestId: id,
      mode: mode.value === 'custom' ? (inputUrl ? 'custom' : 'saved') : mode.value,
      ...(mode.value === 'custom' && inputUrl ? { url: inputUrl } : {}),
      ...(mode.value === 'resource' ? { resourceId: resource.value?.id, resourceRevision: resource.value?.revision } : {}) })
    if (alive && props.open && props.account?.id === account.id && version === generation && requestId.value === id) result.value = value
  } catch (cause) {
    if (alive && props.open && props.account?.id === account.id && version === generation && requestId.value === id) error.value = displayError(cause, inputUrl)
  } finally { if (requestId.value === id) requestId.value = '' }
}
onBeforeUnmount(() => { alive = false; saveId.value = ''; void cancelTest() })
</script>

<template>
  <a-modal :open="open" title="账号网络代理" :footer="null" destroy-on-close @cancel="close">
    <div class="account-proxy-dialog">
      <p class="proxy-account-name">{{ current?.name || account?.name }}</p>
      <p class="proxy-help">用于管理器为此账号发起的登录交换、令牌刷新、用量查询和本地 API。外部浏览器与官方临时客户端登录沿用自身网络；原生模式目前请通过本地 API 接入。</p>
      <div class="proxy-saved-summary"><span>当前设置</span><strong>{{ summary }}</strong></div>
      <a-alert v-if="current?.egressProxy?.invalid" type="warning" message="已保存的代理配置无效，请填写新地址或更换连接方式。" class="proxy-alert" />
      <a-alert v-if="!current" type="warning" message="此账号已移出列表，请关闭窗口后重新选择。" class="proxy-alert" />
      <a-form layout="vertical">
        <a-form-item label="连接方式"><a-select v-model:value="mode" class="proxy-mode" aria-label="账号网络代理连接方式" :disabled="busy || !current" :options="options" /></a-form-item>
        <a-form-item v-if="mode === 'resource'" label="已保存代理资源"><a-select v-model:value="resourceId" class="proxy-resource-choice" aria-label="账号已有代理资源" :disabled="busy" :options="resourceOptions" /></a-form-item>
        <a-form-item v-if="mode === 'custom'" label="代理地址" :extra="current?.egressProxy?.mode === 'custom' ? '留空保留已保存地址；填写新地址后保存替换。' : '支持 HTTP、HTTPS、SOCKS5、SOCKS5H，可在地址中填写用户名和密码。'">
          <a-input-password v-model:value="url" aria-label="账号网络代理地址" :disabled="busy" :maxlength="8192" autocomplete="off" placeholder="http://用户名:密码@主机:端口" />
        </a-form-item>
      </a-form>
      <p v-if="mode === 'inherit'" class="proxy-help">跟随设置页的默认网络代理；账号的直连或指定代理优先。</p>
      <p class="proxy-help">代理地址加密保存在本机。检测仅查询出口 IP，不发送账号令牌；检测成功不会自动保存。</p>
      <p v-if="mode === 'inherit'" class="proxy-help">选择默认网络且没有显式代理时，检测仅查询直连出口，不能据此判断系统或环境代理。</p>
      <a-alert v-if="error" type="error" :message="error" class="proxy-alert" />
      <a-alert v-if="result" type="success" :message="`出口 ${result.ip} · ${result.latencyMs} ms`" class="proxy-alert" />
      <div class="proxy-dialog-actions">
        <a-button v-if="requestId" @click="cancelTest">取消测试</a-button>
        <a-button v-else :disabled="saving || incomplete || manager.loading" @click="probe">检测出口</a-button>
        <span class="proxy-actions-spacer" />
        <a-button @click="close">取消</a-button>
        <a-button type="primary" :loading="saving" :disabled="!!requestId || incomplete || !dirty || manager.loading" @click="save">保存代理</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.proxy-account-name { font-weight: 600; overflow-wrap: anywhere; margin: 4px 0 12px; }
.proxy-help { color: var(--muted); font-size: 12px; line-height: 1.7; margin: 0 0 18px; }
.proxy-saved-summary { display: flex; align-items: baseline; gap: 16px; margin: 0 0 20px; font-size: 12px; }
.proxy-saved-summary > span { color: var(--muted); flex-shrink: 0; }
.proxy-saved-summary strong { font-weight: 550; overflow-wrap: anywhere; }
.proxy-alert { margin: 0 0 16px; }
.proxy-dialog-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.proxy-actions-spacer { flex: 1; }
</style>
