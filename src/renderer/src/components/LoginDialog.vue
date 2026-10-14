<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import { DesktopOutlined, GlobalOutlined, KeyOutlined, CodeOutlined, ScanOutlined } from '@ant-design/icons-vue'
import { useManager } from '../store'
import { implementedAgentClients, getAgentClient, type AgentClientType } from '../../../shared/agentClients'
import type { AppSnapshot, ClaudeSubscriptionLoginStatus } from '../../../shared/types'
import { shouldCompleteClaudeSubscription } from '../claudeSubscriptionFlow'
import TempLoginPanel from './TempLoginPanel.vue'
import LoginCredentialsPanel from './LoginCredentialsPanel.vue'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{clientType?:AgentClientType; subscriptionOnly?: boolean}>()
const emit = defineEmits<{ 'scan-local': []; completed:[id?:string] }>()
const selectedClient = ref<AgentClientType>('codex')
const effectiveClientType = computed<AgentClientType>(() => props.subscriptionOnly ? 'claude_code' : (props.clientType ?? selectedClient.value))
const client = computed(() => getAgentClient(effectiveClientType.value))
const isClaude = computed(() => effectiveClientType.value === 'claude_code')
let previousLoginSuccess: string | undefined
let previousTemporarySuccess: string | undefined
let completionSent = false
const pendingImportIds = ref<string[]>([])
const manager = useManager()
type Method = 'official' | 'oauth' | 'subscription' | 'token' | 'json' | 'local'
const method = ref<Method>('official')
const callback = ref('')
const importing = ref(false)
const starting = ref(false)
const login = computed(() => manager.data?.login)
type ClaudeSubscriptionManager = {
  startClaudeLogin: () => Promise<AppSnapshot>
  cancelClaudeLogin: () => Promise<AppSnapshot>
  openClaudeLogin: () => Promise<void>
  completeClaudeLogin: (code: string) => Promise<AppSnapshot>
}
const claudeManager = () => window.manager as unknown as ClaudeSubscriptionManager
const claudeLogin = computed<ClaudeSubscriptionLoginStatus | undefined>(() => manager.data?.claudeLogin)
const active = computed(() => ['starting', 'waiting', 'exchanging'].includes(login.value?.status ?? ''))
const claudeActive = computed(() => ['starting', 'waiting', 'exchanging'].includes(claudeLogin.value?.status ?? ''))
const temporaryRunning = computed(() => !!manager.data?.tempLogin?.running)
// The importer has two transport modes. Claude's API-specific parsing is
// selected by clientType; it still uses the token textarea rather than a
// third UI mode, so the component contract remains shared with Codex.
const credentialMode = computed(() => method.value === 'json' ? 'json' : isClaude.value ? 'api' : 'token')
const locked = computed(() => active.value || claudeActive.value || starting.value || temporaryRunning.value || importing.value)
let cancelledOAuthId: string | undefined
let cancelledClaudeOAuthId: string | undefined
let cancelledTemporaryId: string | undefined
let cancelledStarting = false
// Account IDs are stable across relogins. Track the OAuth run ID so a
// successful relogin of the same subscription account still closes the modal.
let previousClaudeLoginId: string | undefined

async function start(kind: 'browser' | 'device') {
  if (locked.value || manager.loading) return
  callback.value = ''
  starting.value = true
  cancelledStarting = false
  try { await manager.execute(() => window.manager.startLogin(kind)) }
  finally { starting.value = false; if (!open.value) cancelPending() }
}
async function cancel() { await manager.execute(() => window.manager.cancelLogin()) }
async function startClaudeSubscription() {
  if (!isClaude.value || !props.subscriptionOnly && props.clientType || locked.value || manager.loading) return
  callback.value = ''
  await manager.execute(() => claudeManager().startClaudeLogin())
}
async function cancelClaudeSubscription() {
  if (!claudeActive.value && claudeLogin.value?.status !== 'starting') return
  await manager.execute(() => claudeManager().cancelClaudeLogin())
}
async function openBrowser() {
  try { await window.manager.openLogin() }
  catch (error) { message.error(String(error)) }
}
async function openClaudeBrowser() {
  try { await claudeManager().openClaudeLogin() }
  catch (error) { message.error(String(error)) }
}
async function complete() {
  if (await manager.execute(() => window.manager.completeLogin(callback.value))) callback.value = ''
}
async function completeClaudeSubscription() {
  const value = callback.value.trim()
  if (!value || manager.loading) return
  if (await manager.execute(() => claudeManager().completeClaudeLogin(value))) callback.value = ''
}
function cancelPending() {
  const id = login.value?.id
  if (active.value && id !== cancelledOAuthId || starting.value && !cancelledStarting) {
    cancelledOAuthId = id
    cancelledStarting = true
    void cancel()
  }
  const claudeId = claudeLogin.value?.id
  if (claudeActive.value && claudeId !== cancelledClaudeOAuthId) {
    cancelledClaudeOAuthId = claudeId
    void cancelClaudeSubscription()
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
watch([open, () => props.clientType], ([value]) => {
  callback.value = ''
  pendingImportIds.value = []
  if (value) {
    selectedClient.value = props.clientType ?? 'codex'
    previousLoginSuccess = login.value?.status === 'success' ? login.value.id : undefined
    previousClaudeLoginId = claudeLogin.value?.status === 'success' ? claudeLogin.value.id : undefined
    previousTemporarySuccess = manager.data?.tempLogin?.phase === 'completed' ? manager.data.tempLogin.id : undefined
    completionSent = false
    method.value = isClaude.value ? props.subscriptionOnly || !props.clientType ? 'subscription' : 'token' : temporaryRunning.value ? 'official' : active.value ? 'oauth' : 'official'
    cancelledOAuthId = undefined
    cancelledClaudeOAuthId = undefined
    cancelledTemporaryId = undefined
  } else cancelPending()
})
watch(selectedClient, () => {
  pendingImportIds.value = []
  completionSent = false
  method.value = isClaude.value ? props.subscriptionOnly || !props.clientType ? 'subscription' : 'token' : 'official'
})
// A start response can arrive after the modal closes. Cancel that login too.
watch(() => [login.value?.id, login.value?.status, claudeLogin.value?.id, claudeLogin.value?.status, manager.data?.tempLogin?.id, temporaryRunning.value], () => {
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
watch(() => [claudeLogin.value?.id, claudeLogin.value?.status, claudeLogin.value?.accountId], () => {
  if (!open.value || method.value !== 'subscription') return
  const accountId = claudeLogin.value?.accountId
  if (accountId && shouldCompleteClaudeSubscription(claudeLogin.value, previousClaudeLoginId)) completed(accountId)
})
onUnmounted(cancelPending)
</script>
<template>
  <a-modal v-model:open="open" title="添加账号" :footer="null" :width="760" :body-style="{ maxHeight: '75vh', overflowY: 'auto' }">
    <div class="login-client-purpose">
      <a-form-item v-if="!clientType && !subscriptionOnly" label="客户端用途"><a-select v-model:value="selectedClient" aria-label="账号用途" :disabled="locked" :options="implementedAgentClients.map(item=>({value:item.id,label:item.name}))" /></a-form-item>
      <p v-else-if="subscriptionOnly" class="muted">用于 Claude 订阅账号 · 完成验证后仍需单独完成 Desktop 实例隔离验收</p>
      <p v-else class="muted">用于 {{ client.name }} · 添加完成后回到实例配置</p>
    </div>
    <p class="muted login-introduction">{{ isClaude ? method === 'subscription' ? '添加 Claude 订阅账号。授权只用于读取经过验证的账号身份，Desktop 和受管实例仍需单独完成隔离验收。' : '为 Claude Code CLI 添加 API Key 或 Bearer 连接。Claude 订阅账号可在账号管理中单独验证。' : `为 ${client.name} 添加登录身份或连接。选择一种添加方式；供应商密钥在供应商页管理。` }}</p>
    <a-tabs v-model:active-key="method" class="login-methods" :animated="false">
      <a-tab-pane v-if="!isClaude" key="official" :disabled="locked && method !== 'official'"><template #tab><span class="method-label"><DesktopOutlined />官方客户端</span></template></a-tab-pane>
      <a-tab-pane v-if="!isClaude" key="oauth" :disabled="locked && method !== 'oauth'"><template #tab><span class="method-label"><GlobalOutlined />浏览器授权</span></template></a-tab-pane>
      <a-tab-pane v-if="isClaude && (!props.clientType || props.subscriptionOnly)" key="subscription" :disabled="locked && method !== 'subscription'"><template #tab><span class="method-label"><GlobalOutlined />Claude 订阅</span></template></a-tab-pane>
      <a-tab-pane v-if="!props.subscriptionOnly" key="token" :disabled="locked && method !== 'token'"><template #tab><span class="method-label"><KeyOutlined />{{ isClaude ? 'API 连接' : 'Token' }}</span></template></a-tab-pane>
      <a-tab-pane v-if="!props.subscriptionOnly" key="json" :disabled="locked && method !== 'json'"><template #tab><span class="method-label"><CodeOutlined />JSON / 文件</span></template></a-tab-pane>
      <a-tab-pane v-if="!props.subscriptionOnly" key="local" :disabled="locked && method !== 'local'"><template #tab><span class="method-label"><ScanOutlined />扫描本机</span></template></a-tab-pane>
    </a-tabs>

    <template v-if="method === 'official' && !isClaude">
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
      <TempLoginPanel :disabled="active || starting || !open" />
    </template>

    <section v-if="method === 'oauth' && !isClaude" class="oauth-panel">
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

    <section v-if="method === 'subscription' && isClaude" class="oauth-panel claude-subscription-panel">
      <p class="muted">通过 Claude 官方授权页面完成订阅登录。授权页面会显示一次性代码；粘贴回调链接、<code>code#state</code> 或代码本身即可完成交换。</p>
      <a-alert v-if="claudeLogin?.status === 'error'" type="error" :message="claudeLogin.error || 'Claude 订阅登录失败'" show-icon class="error-banner" />
      <a-alert v-if="claudeLogin?.status === 'success'" type="success" message="Claude 订阅账号已保存，正在显示安全身份摘要。" show-icon class="error-banner" />
      <a-alert v-if="claudeLogin?.status === 'cancelled'" type="info" message="Claude 订阅登录已取消" class="error-banner" />
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
      <template v-if="claudeActive">
        <div class="login-status"><a-spin /><strong>{{ claudeLogin?.status === 'exchanging' ? '正在验证 Claude 订阅' : claudeLogin?.status === 'waiting' ? '等待 Claude 授权' : '正在准备 Claude 授权' }}</strong></div>
        <p v-if="claudeLogin?.expiresAt" class="muted">本次授权有效至 {{ new Date(claudeLogin.expiresAt).toLocaleTimeString() }}</p>
        <p v-if="claudeLogin?.redirectUri" class="muted">回调地址：<code>{{ claudeLogin.redirectUri }}</code></p>
        <a-space><a-button v-if="claudeLogin?.status === 'waiting'" type="primary" @click="openClaudeBrowser">打开 Claude 授权页面</a-button><a-button @click="cancelClaudeSubscription">取消登录</a-button></a-space>
        <a-collapse v-if="claudeLogin?.status === 'waiting'" ghost class="manual-callback"><a-collapse-panel key="manual" header="粘贴授权结果"><p class="muted">粘贴完整回调 URL，或输入 <code>code#state</code> / 一次性代码。</p><a-input-password v-model:value="callback" autocomplete="off" placeholder="https://platform.claude.com/oauth/code/callback?..." /><a-button class="callback-submit" :disabled="!callback.trim() || manager.loading" @click="completeClaudeSubscription">完成 Claude 登录</a-button></a-collapse-panel></a-collapse>
      </template>
      <div v-else class="oauth-choices">
        <div class="oauth-choice"><strong>登录 Claude 订阅</strong><p class="muted">保存邮箱、组织、套餐和验证时间等安全摘要，不展示访问令牌。</p><a-button type="primary" :disabled="manager.loading || !open" @click="startClaudeSubscription">开始订阅登录</a-button></div>
      </div>
      <dl v-if="claudeLogin?.metadata?.profile" class="claude-subscription-preview">
        <div v-if="claudeLogin.metadata.profile.email"><dt>邮箱</dt><dd>{{ claudeLogin.metadata.profile.email }}</dd></div>
        <div v-if="claudeLogin.metadata.profile.organizationName"><dt>组织</dt><dd>{{ claudeLogin.metadata.profile.organizationName }}</dd></div>
        <div v-if="claudeLogin.metadata.profile.plan"><dt>套餐</dt><dd>{{ claudeLogin.metadata.profile.plan }}</dd></div>
      </dl>
    </section>

    <LoginCredentialsPanel v-if="!props.subscriptionOnly && (method === 'token' || method === 'json')" :mode="credentialMode" :active="open" :client-type="props.clientType ?? selectedClient" @busy="importing = $event" @imported="imported" />

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
.claude-subscription-preview { margin: 18px 0 0; padding: 12px 14px; border: 1px solid var(--border-color, rgba(128,128,128,.2)); border-radius: 10px; }
.claude-subscription-preview > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 5px 0; font-size: 12px; line-height: 1.6; }
.claude-subscription-preview dt { color: var(--muted); }
.claude-subscription-preview dd { margin: 0; overflow-wrap: anywhere; }
.local-import-panel { padding: 16px 30px 28px; text-align: center; }
.local-import-panel .muted { max-width: 510px; margin: 0 auto 20px; line-height: 1.8; }
.local-import-mark { font-size: 30px; color: var(--accent, #7c3aed); margin-bottom: 10px; }
@media (max-width: 640px) { .oauth-choices { grid-template-columns: 1fr; } .login-methods :deep(.ant-tabs-tab + .ant-tabs-tab) { margin-left: 16px; } }
</style>
