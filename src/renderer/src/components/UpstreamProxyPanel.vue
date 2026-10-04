<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { GlobalOutlined } from '@ant-design/icons-vue'
import type { ProxyProbeResult } from '../../../shared/accountProxy'
import { useManager } from '../store'

type Mode = 'inherit' | 'direct' | 'custom'
const manager = useManager()
const saved = computed(() => manager.data?.upstreamProxy)
const mode = ref<Mode>('inherit'), initialMode = ref<Mode>('inherit')
const url = ref(''), revision = ref(0), error = ref('')
const result = ref<ProxyProbeResult>(), requestId = ref(''), saveId = ref('')
const saving = computed(() => !!saveId.value)
const busy = computed(() => saving.value || !!requestId.value)
const dirty = computed(() => mode.value !== initialMode.value || !!url.value.trim())
const options = [{ value: 'inherit', label: '默认网络' }, { value: 'direct', label: '直连' }, { value: 'custom', label: '指定代理' }]
const hasSavedCustom = computed(() => saved.value?.mode === 'custom' && !saved.value.invalid)
const incomplete = computed(() => mode.value === 'custom' && !url.value.trim() && !hasSavedCustom.value)
const summary = computed(() => {
  const value = saved.value
  if (!value || value.mode === 'inherit') return '默认网络'
  if (value.mode === 'direct') return '直连'
  if (value.invalid || !value.server || !value.port) return '已保存地址无效'
  const host = value.server.includes(':') && !value.server.startsWith('[') ? `[${value.server}]` : value.server
  return `${host}:${value.port}`
})
let generation = 0, alive = true
function displayError(cause: unknown, inputUrl = url.value.trim()): string {
  let text = (cause instanceof Error ? cause.message : String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/, '').replace(/^Error: /, '')
  if (inputUrl) text = text.split(inputUrl).join('[代理地址]')
  return text.replace(/(?:https?|socks5h?):\/\/[^\s]+/gi, '[代理地址]')
}
function resetDraft() {
  mode.value = saved.value?.mode ?? 'inherit'; initialMode.value = mode.value
  revision.value = saved.value?.revision ?? 0
  url.value = ''; error.value = ''; result.value = undefined
}
watch(() => saved.value?.revision, () => { if (!dirty.value && !busy.value) resetDraft() }, { immediate: true })
watch([mode, url], () => { result.value = undefined; error.value = '' })
async function cancelTest() {
  generation++
  const id = requestId.value; requestId.value = ''
  if (id) await window.manager.cancelUpstreamProxyProbe(id).catch(() => {})
}
async function discard() { await cancelTest(); resetDraft() }
async function probe() {
  if (!saved.value || busy.value || incomplete.value) return
  const id = crypto.randomUUID(), version = ++generation, inputUrl = url.value.trim()
  requestId.value = id; error.value = ''; result.value = undefined
  try {
    const value = await window.manager.probeUpstreamProxy({ requestId: id, revision: revision.value,
      mode: mode.value === 'custom' ? (inputUrl ? 'custom' : 'saved') : mode.value,
      ...(mode.value === 'custom' && inputUrl ? { url: inputUrl } : {}) })
    if (alive && version === generation && requestId.value === id) result.value = value
  } catch (cause) {
    if (alive && version === generation && requestId.value === id) error.value = displayError(cause, inputUrl)
  } finally { if (requestId.value === id) requestId.value = '' }
}
async function save() {
  if (!saved.value || busy.value || incomplete.value || manager.loading) return
  const id = crypto.randomUUID(), version = ++generation, inputUrl = url.value.trim()
  const input = { revision: revision.value, mode: mode.value, ...(mode.value === 'custom' && inputUrl ? { url: inputUrl } : {}) }
  saveId.value = id; error.value = ''; result.value = undefined
  let failure = ''
  try {
    const confirmed = await manager.execute(async () => {
      try { return await window.manager.saveUpstreamProxy(input) }
      catch (cause) { failure = displayError(cause, inputUrl); throw new Error(failure) }
    })
    if (!alive || version !== generation || saveId.value !== id) return
    if (confirmed) { resetDraft(); message.success('默认网络代理已保存') }
    else error.value = failure || '代理保存失败，请重试'
  } finally { if (saveId.value === id) saveId.value = '' }
}
onBeforeUnmount(() => { alive = false; saveId.value = ''; void cancelTest() })
</script>

<template>
  <a-card class="settings-card upstream-proxy-panel">
    <template #title><span class="proxy-panel-title"><GlobalOutlined />默认网络代理</span></template>
    <p class="proxy-help">用于管理器发起的登录交换、令牌刷新、用量查询和本地 API，账号可单独覆盖。外部浏览器与官方临时客户端登录沿用自身网络；原生模式目前请通过本地 API 接入。</p>
    <div class="proxy-saved-summary"><span>当前设置</span><strong>{{ summary }}</strong></div>
    <a-alert v-if="saved?.invalid" type="warning" message="已保存的代理配置无效，请填写新地址或更换连接方式。" class="proxy-alert" />
    <a-form layout="vertical">
      <a-form-item label="连接方式"><a-segmented v-model:value="mode" aria-label="默认网络代理连接方式" :options="options" :disabled="busy" /></a-form-item>
      <a-form-item v-if="mode === 'custom'" label="代理地址" :extra="saved?.mode === 'custom' ? '留空保留已保存地址；填写新地址后保存替换。' : '支持 HTTP、HTTPS、SOCKS5、SOCKS5H，可在地址中填写用户名和密码。'">
        <a-input-password v-model:value="url" aria-label="默认网络代理地址" :disabled="busy" :maxlength="8192" autocomplete="off" placeholder="http://用户名:密码@主机:端口" />
      </a-form-item>
    </a-form>
    <p class="proxy-help">代理地址加密保存在本机。检测仅查询出口 IP，不发送账号令牌；检测成功不会自动保存。</p>
    <p v-if="mode === 'inherit'" class="proxy-help">选择默认网络且没有显式代理时，检测仅查询直连出口，不能据此判断系统或环境代理。</p>
    <a-alert v-if="error" type="error" :message="error" class="proxy-alert" />
    <a-alert v-if="result" type="success" :message="`出口 ${result.ip} · ${result.latencyMs} ms`" class="proxy-alert" />
    <div class="proxy-panel-actions">
      <a-button v-if="requestId" @click="cancelTest">取消测试</a-button>
      <a-button v-else :disabled="saving || incomplete || !saved || manager.loading" @click="probe">检测出口</a-button>
      <span class="proxy-actions-spacer" />
      <a-button :disabled="saving || !!requestId || !dirty" @click="discard">放弃更改</a-button>
      <a-button type="primary" :loading="saving" :disabled="!!requestId || incomplete || !saved || !dirty || manager.loading" @click="save">保存代理</a-button>
    </div>
  </a-card>
</template>

<style scoped>
.proxy-panel-title { display: inline-flex; align-items: center; gap: 8px; }
.proxy-help { color: var(--muted); font-size: 12px; line-height: 1.7; margin: 0 0 18px; }
.proxy-saved-summary { display: flex; align-items: baseline; gap: 16px; margin: 0 0 20px; font-size: 12px; }
.proxy-saved-summary > span { color: var(--muted); flex-shrink: 0; }
.proxy-saved-summary strong { font-weight: 550; overflow-wrap: anywhere; }
.proxy-alert { margin: 0 0 16px; }
.proxy-panel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.proxy-actions-spacer { flex: 1; }
</style>
