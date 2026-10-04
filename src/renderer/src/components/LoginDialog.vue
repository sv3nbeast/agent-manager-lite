<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import { DesktopOutlined, GlobalOutlined, KeyOutlined, CodeOutlined, ScanOutlined } from '@ant-design/icons-vue'
import { useManager } from '../store'
import { implementedAgentClients, getAgentClient, type AgentClientType } from '../../../shared/agentClients'
import TempLoginPanel from './TempLoginPanel.vue'
import LoginCredentialsPanel from './LoginCredentialsPanel.vue'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{clientType?:AgentClientType}>()
const emit = defineEmits<{ 'scan-local': []; completed:[id?:string] }>()
const selectedClient = ref<AgentClientType>('codex')
const client = computed(() => getAgentClient(props.clientType ?? selectedClient.value))
let previousLoginSuccess: string | undefined
let previousTemporarySuccess: string | undefined
let completionSent = false
const pendingImportIds = ref<string[]>([])
const manager = useManager()
type Method = 'official' | 'oauth' | 'token' | 'json' | 'local'
const method = ref<Method>('official')
const callback = ref('')
const importing = ref(false)
const starting = ref(false)
const login = computed(() => manager.data?.login)
const active = computed(() => ['starting', 'waiting', 'exchanging'].includes(login.value?.status ?? ''))
const temporaryRunning = computed(() => !!manager.data?.tempLogin?.running)
const credentialMode = computed(() => method.value === 'json' ? 'json' : 'token')
const locked = computed(() => active.value || starting.value || temporaryRunning.value || importing.value)
let cancelledOAuthId: string | undefined
let cancelledTemporaryId: string | undefined
let cancelledStarting = false

async function start(kind: 'browser' | 'device') {
  if (locked.value || manager.loading) return
  callback.value = ''
  starting.value = true
  cancelledStarting = false
  try { await manager.execute(() => window.manager.startLogin(kind)) }
  finally { starting.value = false; if (!open.value) cancelPending() }
}
async function cancel() { await manager.execute(() => window.manager.cancelLogin()) }
async function openBrowser() {
  try { await window.manager.openLogin() }
  catch (error) { message.error(String(error)) }
}
async function complete() {
  if (await manager.execute(() => window.manager.completeLogin(callback.value))) callback.value = ''
}
function cancelPending() {
  const id = login.value?.id
  if (active.value && id !== cancelledOAuthId || starting.value && !cancelledStarting) {
    cancelledOAuthId = id
    cancelledStarting = true
    void cancel()
  }
  const temporary = manager.data?.tempLogin
  if (temporary?.running && temporary.id && temporary.id !== cancelledTemporaryId) {
    cancelledTemporaryId = temporary.id
    void manager.execute(() => window.manager.cancelTempLogin(temporary.id!))
  }
}
function scanLocal() {
  if (locked.value || manager.loading) return
  open.value = false
  emit('scan-local')
}
watch(open, value => {
  callback.value = ''
  pendingImportIds.value = []
  if (value) {
    selectedClient.value = props.clientType ?? 'codex'
    previousLoginSuccess = login.value?.status === 'success' ? login.value.id : undefined
    previousTemporarySuccess = manager.data?.tempLogin?.phase === 'completed' ? manager.data.tempLogin.id : undefined
    completionSent = false
    method.value = temporaryRunning.value ? 'official' : active.value ? 'oauth' : 'official'
    cancelledOAuthId = undefined
    cancelledTemporaryId = undefined
  } else cancelPending()
})
// A start response can arrive after the modal closes. Cancel that login too.
watch(() => [login.value?.id, login.value?.status, manager.data?.tempLogin?.id, temporaryRunning.value], () => {
  if (!open.value) cancelPending()
})
function completed(id?:string) {
  if (!open.value || completionSent) return
  completionSent = true
  emit('completed', id)
  open.value = false
}
function finishImport() {
  if(!open.value||!pendingImportIds.value.length)return
  const visible=manager.data?.accounts??[]
  if(pendingImportIds.value.some(id=>!visible.some(account=>account.id===id)))return
  const account = pendingImportIds.value.map(id=>visible.find(account=>account.id===id&&account.kind!=='api_key')).find(Boolean)
  pendingImportIds.value=[]
  if(props.clientType&&!account){message.info('导入已完成，请返回实例选择已保存的兼容账号或供应商密钥。');return}
  completed(account?.id)
}
function imported(accountIds:string[]) {
  if(!accountIds.length){message.info('导入已完成，请选择已有账号。');return}
  pendingImportIds.value=[...accountIds]
  finishImport()
}
watch(()=>manager.data?.accounts,finishImport)
watch(() => [login.value?.status, login.value?.accountId, manager.data?.tempLogin?.phase, manager.data?.tempLogin?.accountId], () => {
  if (!open.value) return
  if (login.value?.status === 'success' && login.value.id !== previousLoginSuccess && login.value.accountId) completed(login.value.accountId)
  const temporary = manager.data?.tempLogin
  if (temporary?.phase === 'completed' && temporary.id !== previousTemporarySuccess && temporary.accountId) completed(temporary.accountId)
})
onUnmounted(cancelPending)
</script>
<template>
  <a-modal v-model:open="open" title="添加账号" :footer="null" :width="760" :body-style="{ maxHeight: '75vh', overflowY: 'auto' }">
    <div class="login-client-purpose">
      <a-form-item v-if="!clientType" label="客户端用途"><a-select v-model:value="selectedClient" aria-label="账号用途" :disabled="locked" :options="implementedAgentClients.map(item=>({value:item.id,label:item.name}))" /></a-form-item>
      <p v-else class="muted">用于 {{ client.name }} · 添加完成后回到实例配置</p>
    </div>
    <p class="muted login-introduction">为 {{ client.name }} 登录 ChatGPT 账号。选择一种添加方式；供应商密钥在供应商页管理。</p>
    <a-tabs v-model:active-key="method" class="login-methods" :animated="false">
      <a-tab-pane key="official" :disabled="locked && method !== 'official'"><template #tab><span class="method-label"><DesktopOutlined />官方客户端</span></template></a-tab-pane>
      <a-tab-pane key="oauth" :disabled="locked && method !== 'oauth'"><template #tab><span class="method-label"><GlobalOutlined />浏览器授权</span></template></a-tab-pane>
      <a-tab-pane key="token" :disabled="locked && method !== 'token'"><template #tab><span class="method-label"><KeyOutlined />Token</span></template></a-tab-pane>
      <a-tab-pane key="json" :disabled="locked && method !== 'json'"><template #tab><span class="method-label"><CodeOutlined />JSON / 文件</span></template></a-tab-pane>
      <a-tab-pane key="local" :disabled="locked && method !== 'local'"><template #tab><span class="method-label"><ScanOutlined />扫描本机</span></template></a-tab-pane>
    </a-tabs>

    <template v-if="method === 'official'">
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
      <TempLoginPanel :disabled="active || starting || !open" />
    </template>

    <section v-if="method === 'oauth'" class="oauth-panel">
      <p class="muted">通过 ChatGPT 官方授权页面登录。浏览器授权会自动打开页面；设备码适合在其他浏览器或设备上完成登录。</p>
      <a-alert v-if="login?.status === 'error'" type="error" :message="login.error" show-icon class="error-banner" />
      <a-alert v-if="login?.status === 'success'" type="success" message="登录成功，账号已保存。可在账号卡片刷新用量。" show-icon class="error-banner" />
      <a-alert v-if="login?.status === 'cancelled'" type="info" message="本次登录已取消" class="error-banner" />
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
      <template v-if="active || starting">
        <div class="login-status"><a-spin v-if="starting || login?.status !== 'waiting'" /><strong>{{ login?.status === 'exchanging' ? '正在完成授权' : login?.status === 'waiting' ? login.method === 'device' ? '等待设备码授权' : '等待浏览器授权' : '正在准备登录' }}</strong></div>
        <template v-if="login?.userCode"><p>在授权页面输入以下设备码：</p><div class="device-code">{{ login.userCode }}</div><p class="muted">{{ login.verificationUrl }}</p></template>
        <p v-if="login?.expiresAt" class="muted">本次授权有效至 {{ new Date(login.expiresAt).toLocaleTimeString() }}</p>
        <a-space><a-button v-if="login?.status === 'waiting'" type="primary" @click="openBrowser">{{ login?.method === 'device' ? '打开设备授权页面' : '重新打开授权页面' }}</a-button><a-button @click="cancel">取消登录</a-button></a-space>
        <a-collapse v-if="login?.method === 'browser' && login.status === 'waiting'" ghost class="manual-callback"><a-collapse-panel key="manual" header="浏览器未自动回到应用"><p class="muted">粘贴本次登录的完整 localhost 回调链接，然后完成登录。</p><a-input-password v-model:value="callback" autocomplete="off" placeholder="http://localhost:1455/auth/callback?..." /><a-button class="callback-submit" :disabled="!callback.trim() || manager.loading" @click="complete">完成登录</a-button></a-collapse-panel></a-collapse>
      </template>
      <div v-else class="oauth-choices">
        <div class="oauth-choice"><strong>在本机浏览器登录</strong><p class="muted">授权后自动返回并保存账号。</p><a-button type="primary" :disabled="temporaryRunning || manager.loading || !open" @click="start('browser')">浏览器登录</a-button></div>
        <div class="oauth-choice"><strong>使用设备码登录</strong><p class="muted">输入设备码即可授权，无需本机回调。</p><a-button :disabled="temporaryRunning || manager.loading || !open" @click="start('device')">设备码登录</a-button></div>
      </div>
    </section>

    <LoginCredentialsPanel v-if="method === 'token' || method === 'json'" :mode="credentialMode" :active="open" @busy="importing = $event" @imported="imported" />

    <section v-if="method === 'local'" class="local-import-panel">
      <div class="local-import-mark"><ScanOutlined /></div>
      <h3>发现本机已有账号与供应商</h3>
      <p class="muted">扫描兼容客户端和账号管理工具的本地数据。先查看识别结果，再选择迁入本应用的账号与供应商。</p>
      <a-button type="primary" :disabled="locked || manager.loading || !open" @click="scanLocal">扫描本机登录数据</a-button>
    </section>
  </a-modal>
</template>
<style scoped>
.login-introduction { line-height: 1.7; margin-bottom: 10px; }
.method-label { display: inline-flex; align-items: center; gap: 7px; }
.login-methods :deep(.ant-tabs-nav) { margin-bottom: 12px; }
.login-methods :deep(.ant-tabs-tab) { padding: 12px 0; }
.login-methods :deep(.ant-tabs-tab + .ant-tabs-tab) { margin-left: 23px; }
.login-methods :deep(.ant-tabs-content-holder) { display: none; }
.login-status { display: flex; gap: 12px; align-items: center; padding: 20px 0 12px; }
.device-code { font-size: 28px; letter-spacing: 4px; font-family: monospace; padding: 16px; text-align: center; background: var(--surface-alt, rgba(128,128,128,.08)); border-radius: 10px; user-select: all; }
.oauth-panel > .muted { line-height: 1.7; }
.oauth-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 18px 0 12px; }
.oauth-choice { border: 1px solid var(--border-color, rgba(128,128,128,.2)); border-radius: 12px; padding: 20px; }
.oauth-choice p { line-height: 1.7; min-height: 44px; }
.manual-callback { margin-top: 16px; }
.callback-submit { margin-top: 10px; }
.local-import-panel { padding: 16px 30px 28px; text-align: center; }
.local-import-panel .muted { max-width: 510px; margin: 0 auto 20px; line-height: 1.8; }
.local-import-mark { font-size: 30px; color: var(--accent, #7c3aed); margin-bottom: 10px; }
@media (max-width: 640px) { .oauth-choices { grid-template-columns: 1fr; } .login-methods :deep(.ant-tabs-tab + .ant-tabs-tab) { margin-left: 16px; } }
</style>
