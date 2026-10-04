<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { theme, message, Modal } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { AppstoreOutlined, UserOutlined, DesktopOutlined, ApiOutlined, FileTextOutlined, SettingOutlined, PlusOutlined, ImportOutlined, ReloadOutlined, ThunderboltOutlined, SearchOutlined, DeleteOutlined, SafetyCertificateOutlined } from '@ant-design/icons-vue'
import { settingsSchema, type Account, type AppSnapshot, type Settings, type TierMode } from '../../shared/types'
import { useManager } from './store'
import type { InstanceLoginRequest, InstanceLoginResult } from './instanceOnboarding'
import brandUrl from '../../../resources/brand.svg'
import LoginDialog from './components/LoginDialog.vue'
import LocalDataMigrationDialog from './components/LocalDataMigrationDialog.vue'
import AccountCard from './components/AccountCard.vue'
import AccountProxyDialog from './components/AccountProxyDialog.vue'
import UpstreamProxyPanel from './components/UpstreamProxyPanel.vue'
import DataBackupPanel from './components/DataBackupPanel.vue'
import HistoryView from './components/HistoryView.vue'
import AccountEditor from './components/AccountEditor.vue'
import ImportDialog from './components/ImportDialog.vue'
import GroupsDialog from './components/GroupsDialog.vue'
import ClientConfigPanel from './components/ClientConfigPanel.vue'
import ProviderLibraryView from './components/ProviderLibraryView.vue'
import InstancesView from './components/InstancesView.vue'
import LocalAccessPanel from './components/LocalAccessPanel.vue'
import SessionsView from './components/SessionsView.vue'
import AccountRecyclePanel from './components/AccountRecyclePanel.vue'
import WakeupPanel from './components/WakeupPanel.vue'
import SshServersPanel from './components/SshServersPanel.vue'
import OverviewAssets from './components/OverviewAssets.vue'

const manager = useManager()
const page = ref('instances')
const contentElement = ref<HTMLElement>()
watch(page,()=>{void nextTick(()=>contentElement.value?.scrollTo({top:0}))})
const search = ref('')
const kind = ref('all')
const selected = ref<string[]>([])
const addOpen = ref(false)
const importOpen = ref(false)
const loginOpen = ref(false)
const localDataOpen = ref(false)
const loginRequest = ref<InstanceLoginRequest>()
const loginResult = ref<InstanceLoginResult>()
let migrationAccountIds = new Set<string>()
function openAccountLogin(request?:InstanceLoginRequest) {
  loginRequest.value = request
  loginOpen.value = true
}
function accountLoginCompleted(id?:string) {
  const request = loginRequest.value
  loginOpen.value = false
  if (request && id) loginResult.value = {...request, accountId:id}
  loginRequest.value = undefined
}
function openMigration(fromLogin = false) {
  if (!fromLogin) loginRequest.value = undefined
  migrationAccountIds = new Set(accounts.value.map(account => account.id))
  localDataOpen.value = true
}
async function migrationChanged(snapshot:AppSnapshot) {
  await manager.execute(async()=>snapshot)
  const id = snapshot.accounts.find(account => !migrationAccountIds.has(account.id) && account.kind !== 'api_key')?.id
  if (loginRequest.value && id) accountLoginCompleted(id)
}
watch(page, value => { if (value !== 'instances') loginRequest.value = undefined })
const editingAccount = ref<Account>()
const proxyAccount = ref<Account>()
const accountProxyOpen = ref(false)
const groupsOpen = ref(false), tagsOpen = ref(false)
const groupFilter = ref('all'), tagFilter = ref<string>()
const batchTagValues = ref<string[]>([]), batchTagMode = ref<'add' | 'remove' | 'replace'>('add')
const gatewayAccountId = ref<string>()
const settings = reactive<Settings>(settingsSchema.parse({}))
// Settings form is a draft. Immediate Fast controls below read only the saved
// snapshot, so a failed write or an unsaved form cannot claim to have applied it.
watch(() => JSON.stringify(manager.data?.settings), (value, previous) => {
  if (!value) return
  const next = JSON.parse(value) as Settings, before = previous ? JSON.parse(previous) as Settings : undefined
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (!before || Object.is(settings[key], before[key])) Object.assign(settings, { [key]: next[key] })
  }
})
const settingsSaving = ref(false)
const settingsDirty = computed(() => !!manager.data && (Object.keys(settings) as (keyof Settings)[]).some(key => !Object.is(settings[key], manager.data!.settings[key])))
const settingsValid = computed(() => settingsSchema.safeParse({...settings}).success)
const activeConnections = computed(() => !!manager.data?.gateway?.running || !!manager.data?.localAccess?.starting || !!manager.data?.localAccess?.singleStarting || manager.data?.instances?.some(instance => ['preparing','starting','running','stopping'].includes(instance.status)))
function discardSettings() { if (manager.data) Object.assign(settings, manager.data.settings) }
const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => { systemDark.value = event.matches })
const dark = computed(() => settings.theme === 'dark' || settings.theme === 'system' && systemDark.value)
const accounts = computed(() => manager.data?.accounts ?? [])
const identityAccounts = computed(() => accounts.value.filter(a => a.kind !== 'api_key'))
const pageAccounts = computed(() => page.value === 'connections' ? accounts.value.filter(a=>a.kind==='api_key') : identityAccounts.value)
watch(page,()=>{kind.value='all';selected.value=[];offset.value=1})
const apiAccountCount = computed(() => accounts.value.length - identityAccounts.value.length)
const providers = computed(() => manager.data?.providers ?? [])
const providerKeyCount = computed(() => providers.value.reduce((count, provider) => count + provider.keys.length, 0))
const runningInstanceCount = computed(() => manager.data?.instances?.filter(instance => instance.status === 'running').length ?? 0)
const providerLibrary = ref<InstanceType<typeof ProviderLibraryView>>()
const groups = computed(() => manager.data?.groups ?? [])
const allTags = computed(() => [...new Set(pageAccounts.value.flatMap(a => a.tags))].sort())
const memberships = computed(() => new Map(accounts.value.map(a => [a.id, groups.value.filter(g => g.accountIds.includes(a.id))])))
const filtered = computed(() => pageAccounts.value.filter(a => (kind.value === 'all' || a.kind === kind.value)
  && (groupFilter.value === 'all' || groupFilter.value === 'none' && !memberships.value.get(a.id)?.length || memberships.value.get(a.id)?.some(g => g.id === groupFilter.value))
  && (!tagFilter.value || a.tags.includes(tagFilter.value))
  && [a.name, a.email, a.note, ...a.tags, ...(page.value === 'connections' ? [connectionContext(a), a.baseUrl] : [])].join(' ').toLowerCase().includes(search.value.toLowerCase())))
const offset = ref(1)
const visible = computed(() => filtered.value.slice((offset.value - 1) * 24, offset.value * 24))
watch([search, kind, groupFilter, tagFilter], () => { offset.value = 1 })
watch(() => filtered.value.length, count => { offset.value = Math.min(offset.value, Math.max(1, Math.ceil(count / 24))) })
watch(pageAccounts, value => { const ids = new Set(value.map(a => a.id)); selected.value = selected.value.filter(id => ids.has(id)) })
watch(groups, value => { if (!['all', 'none'].includes(groupFilter.value) && !value.some(g => g.id === groupFilter.value)) groupFilter.value = 'all' })
const tiers = [{ label: '跟随请求', value: 'follow' }, { label: 'Standard', value: 'standard' }, { label: 'Fast', value: 'fast' }]
const names: Record<string, string> = { overview: '概览', accounts: '账号管理', connections:'API 连接', providers: '供应商与密钥', config: '客户端配置', instances:'实例',sessions:'会话管理',wakeup:'唤醒任务',gateway: '本地 API', history: '调用记录', settings: '设置' }
let refreshTimer: ReturnType<typeof setInterval>
onMounted(async () => { await manager.load(); refreshTimer = setInterval(() => { if (!manager.loading) void manager.refresh() }, 2000) })
onUnmounted(() => clearInterval(refreshTimer))
async function refreshQuotas(ids: string[]) { await manager.execute(() => window.manager.refreshQuotas(ids)) }
async function refreshSubscription(id: string) { await manager.execute(() => window.manager.refreshSubscription(id)) }
async function refreshResetCredits(id: string) { await manager.execute(() => window.manager.refreshResetCredits(id)) }
async function consumeResetCredit(id: string) { await manager.execute(() => window.manager.consumeResetCredit(id)) }
async function refreshSelected() {
  if (!selected.value.length) { if(pageAccounts.value.length) await refreshQuotas(pageAccounts.value.map(a=>a.id)); return }
  const ids = accounts.value.filter(a => selected.value.includes(a.id)).map(a => a.id)
  if (!ids.length) { message.info('请选择账号'); return }
  await refreshQuotas(ids)
}
async function cancelQuotaRefresh() { await manager.execute(() => window.manager.cancelQuotaRefresh()) }
async function persistSettings(next: Settings): Promise<boolean> {
  if (settingsSaving.value || manager.loading) return false
  const previous = manager.data?.settings
  const requestChanged = (['defaultTier','port','streamOpenTimeoutSeconds','streamIdleTimeoutSeconds','imageStreamOpenTimeoutSeconds','imageStreamIdleTimeoutSeconds'] as const).some(key => previous?.[key] !== next[key])
  settingsSaving.value = true
  try {
    const saved = await manager.execute(() => window.manager.saveSettings(next))
    if (saved) message.success({ key: 'settings-save', content: requestChanged && activeConnections.value ? '设置已保存，运行中的服务需重启后应用请求配置' : '设置已保存' })
    return saved
  } finally { settingsSaving.value = false }
}
async function saveSettings() {
  if (!settingsValid.value) return
  if (await persistSettings({ ...settings })) discardSettings()
}
async function saveDefaultTier(value: string | number) {
  if (!manager.data || !['follow','standard','fast'].includes(String(value))) return
  // Change only the persisted tier; do not commit unrelated settings form edits.
  await persistSettings({ ...manager.data.settings, defaultTier: value as TierMode })
}
function openAccount(account: Account) { editingAccount.value = account; addOpen.value = true }
function openAccountProxy(account: Account) { proxyAccount.value = account; accountProxyOpen.value = true }
const connectionProvider = (account: Account) => providers.value.find(provider => provider.id === account.providerId)
const connectionKey = (account: Account) => connectionProvider(account)?.keys.find(key => key.accountIds.includes(account.id))
function connectionContext(account: Account): string {
  const provider = connectionProvider(account), key = connectionKey(account)
  return provider ? `${provider.name} · ${key?.name || '未命名密钥'}` : '独立连接'
}
async function editConnectionProvider(id: string) {
  page.value = 'providers'
  await nextTick()
  if (!providerLibrary.value?.editProvider(id)) message.info('供应商已变化，请查看最新列表')
}
async function viewConnections(accountId?: string) {
  page.value = 'connections'; search.value = ''; groupFilter.value = 'all'; tagFilter.value = undefined
  await nextTick()
  if (accountId) {
    const index = pageAccounts.value.findIndex(account => account.id === accountId)
    if (index < 0) { message.info('连接已变化，请查看最新列表'); return }
    offset.value = Math.floor(index / 24) + 1
    await nextTick()
    document.querySelector(`[data-account-id="${accountId}"]`)?.scrollIntoView({block:'center'})
  }
}
async function providerViewKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 'providers' : event.key === 'End' ? 'connections' : page.value === 'providers' ? 'connections' : 'providers'
  if (next === 'connections') await viewConnections()
  else page.value = 'providers'
  await nextTick()
  document.getElementById(next === 'providers' ? 'provider-library-tab' : 'api-connections-tab')?.focus()
}
async function viewOverviewAccount(id: string) {
  if (!identityAccounts.value.some(account => account.id === id)) { message.info('账号已变化，请查看最新列表'); return }
  page.value = 'accounts'; search.value = ''; kind.value = 'all'; groupFilter.value = 'all'; tagFilter.value = undefined
  await nextTick()
  offset.value = Math.floor(identityAccounts.value.findIndex(account => account.id === id) / 24) + 1
  await nextTick()
  document.querySelector(`[data-account-id="${id}"]`)?.scrollIntoView({block:'center'})
}
async function viewOverviewKey(providerId: string, keyId: string) {
  page.value = 'providers'
  await nextTick()
  if (!await providerLibrary.value?.showKey(providerId, keyId)) message.info('密钥已变化，请查看最新列表')
}
async function applyTags() {
  if (await manager.execute(() => window.manager.batchTags({ ids: [...selected.value], mode: batchTagMode.value, tags: [...batchTagValues.value] }))) {
    tagsOpen.value = false; batchTagValues.value = []; message.success('标签已更新')
  }
}
async function exportAccounts() {
  const ids = selected.value.length ? [...selected.value] : filtered.value.map(a => a.id)
  try { const result = await window.manager.exportAccounts(ids); if (!result.cancelled) message.success(`已导出 ${result.count} 个账号`) }
  catch (error) { message.error(String(error)) }
}
function selectVisible() { selected.value = [...new Set([...selected.value, ...visible.value.map(a => a.id)])] }
function deleteSelected() {
  const ids=[...selected.value]
  Modal.confirm({ title: `将选中的 ${ids.length} 个账号移入回收站？`, content: '保存加密备份后移出账号列表，并清理本地 API 账号范围；之后可在账号回收站恢复。', okText: '移入回收站', okType: 'danger', cancelText: '取消',
    async onOk() { if (await manager.execute(() => window.manager.deleteAccounts(ids))) selected.value = [] }
  })
}
function toggleAccount(id: string, checked: boolean) { selected.value = checked ? [...selected.value, id] : selected.value.filter(value => value !== id) }
async function copyGatewayKey() {
  try { await window.manager.copyGatewayKey(); message.success('本地 API Key 已复制') }
  catch (error) { message.error(String(error)) }
}
async function startGateway() {
  if (gatewayAccountId.value) await manager.execute(() => window.manager.startGateway(gatewayAccountId.value!))
}
async function stopGateway() { await manager.execute(() => window.manager.stopGateway()) }
async function retryCredentialRecovery() { await manager.execute(() => window.manager.recoverCredentials()) }
async function restartAfterBackup() { try { await window.manager.restartAfterBackup() } catch(error) { message.error(String(error)) } }
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: '#7c3aed', borderRadius: 10, fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,sans-serif' } }">
    <div class="app-shell" :class="{ dark }">
      <aside class="sidebar">
        <div class="brand"><img class="brand-mark" :src="brandUrl" alt="Agent Manager Lite" /><div><strong>Agent</strong><small>MANAGER LITE</small></div></div>
        <div class="nav-label">工作空间</div>
        <a-menu :selected-keys="[page === 'connections' ? 'providers' : page]" mode="inline" class="navigation" @click="page = String($event.key)">
          <a-menu-item key="overview"><span class="nav-item-content"><AppstoreOutlined />概览</span></a-menu-item>
          <a-menu-item key="instances"><span class="nav-item-content"><DesktopOutlined />实例</span></a-menu-item>
          <a-menu-item key="accounts"><span class="nav-item-content"><UserOutlined />账号管理 <span class="nav-count">{{ identityAccounts.length }}</span></span></a-menu-item>
          <a-menu-item key="providers"><span class="nav-item-content"><ApiOutlined />供应商与密钥 <span class="nav-count">{{ providerKeyCount }}</span></span></a-menu-item>
          <a-menu-item key="config"><span class="nav-item-content"><SettingOutlined />客户端配置</span></a-menu-item>
          <a-menu-item key="gateway"><span class="nav-item-content"><ApiOutlined />本地 API</span></a-menu-item>
          <a-menu-item key="sessions"><span class="nav-item-content"><FileTextOutlined />会话管理</span></a-menu-item>
          <a-menu-item key="wakeup"><span class="nav-item-content"><ThunderboltOutlined />唤醒任务</span></a-menu-item>
          <a-menu-item key="history"><span class="nav-item-content"><FileTextOutlined />调用记录</span></a-menu-item>
        </a-menu>
        <div class="sidebar-bottom"><a-button type="text" block @click="page = 'settings'"><span class="nav-item-content"><SettingOutlined /><span>设置</span></span></a-button><div class="version">v0.1.0 · 本地数据</div></div>
      </aside>
      <section class="body">
        <header class="titlebar"><span>{{ names[page] }}</span><div class="status"><span class="status-dot" :style="{ background: manager.data?.gateway?.running ? '#52c41a' : undefined }" />{{ manager.data?.gateway?.running ? `本地 API · ${manager.data.gateway.port}` : '本地 API 未启动' }}</div></header>
        <main ref="contentElement" class="content">
          <a-alert v-if="manager.error" type="error" show-icon :message="manager.error" closable @close="manager.error = ''" class="error-banner" />
          <a-alert v-if="manager.data?.gateway?.error" type="error" show-icon :message="manager.data.gateway.error" class="error-banner"><template #action><a-button size="small" :loading="manager.loading" @click="stopGateway">重试保存并停止</a-button></template></a-alert>
          <a-alert v-if="manager.data?.gateway?.quotaSyncError" type="error" show-icon :message="manager.data.gateway.quotaSyncError" class="error-banner" />
          <a-alert v-if="manager.data?.credentialRecovery?.retained" type="warning" show-icon :message="`有 ${manager.data.credentialRecovery.retained} 份中断运行的登录状态尚未恢复，文件已保留。`" class="error-banner"><template #action><a-button size="small" :loading="manager.loading" @click="retryCredentialRecovery">重试恢复</a-button></template></a-alert>
          <a-alert v-if="manager.data?.backupRestartRequired" type="info" show-icon message="配置已恢复，请重启应用后继续使用。" class="error-banner"><template #action><a-button @click="restartAfterBackup">立即重启</a-button></template></a-alert>
          <a-spin :spinning="manager.loading">
            <template v-if="page === 'providers' || page === 'connections'">
              <div class="page-heading provider-workspace-heading"><div><h1>供应商与密钥</h1><p>维护上游配置和密钥，管理可供实例与本地 API 使用的连接。</p></div><a-button v-if="page === 'connections'" @click="importOpen = true"><ImportOutlined />导入连接</a-button></div>
              <div class="provider-workspace-tabs" role="tablist" aria-label="供应商管理视图" @keydown="providerViewKeydown">
                <button id="provider-library-tab" type="button" role="tab" :tabindex="page === 'providers' ? 0 : -1" :aria-selected="page === 'providers'" aria-controls="provider-library-panel" :class="{ active: page === 'providers' }" @click="page = 'providers'">供应商库 <span>{{ providers.length }}</span></button>
                <button id="api-connections-tab" type="button" role="tab" :tabindex="page === 'connections' ? 0 : -1" :aria-selected="page === 'connections'" aria-controls="api-connections-panel" :class="{ active: page === 'connections' }" @click="viewConnections()">API 连接 <span>{{ apiAccountCount }}</span></button>
              </div>
            </template>
            <section v-if="page === 'accounts' || page === 'connections'" :id="page === 'connections' ? 'api-connections-panel' : undefined" :role="page === 'connections' ? 'tabpanel' : undefined" :aria-labelledby="page === 'connections' ? 'api-connections-tab' : undefined">
              <div v-if="page === 'accounts'" class="page-heading"><div><h1>你的账号</h1><p>管理登录身份、套餐用量与兼容的客户端。</p></div><a-space><a-button @click="page = 'providers'">管理供应商</a-button><a-button @click="importOpen = true"><ImportOutlined />导入</a-button><a-button type="primary" @click="openAccountLogin()"><PlusOutlined />添加账号</a-button></a-space></div>
              <p v-else class="connection-view-description">连接保留独立名称、分组、标签和服务等级；绑定供应商后共享其地址、模型与密钥。</p>
              <a-alert v-if="manager.data?.quotaRefresh?.running" type="info" class="error-banner"><template #message>正在刷新用量 {{ manager.data.quotaRefresh.completed }} / {{ manager.data.quotaRefresh.total }} <a-button type="link" size="small" @click="cancelQuotaRefresh">取消刷新</a-button></template></a-alert>
              <div v-if="page === 'accounts' && apiAccountCount" class="account-provider-notice">{{ apiAccountCount }} 个 API 连接在供应商工作区管理<a-button type="link" size="small" @click="viewConnections()">查看 API 连接</a-button></div>
              <div v-if="page === 'accounts'" class="tier-strip"><div class="tier-description"><ThunderboltOutlined /><div><strong>默认服务等级</strong><small>请求未指定等级时使用；保留客户端的明确选择</small></div></div><a-segmented :value="manager.data?.settings.defaultTier ?? 'follow'" :options="tiers" :disabled="settingsSaving || manager.loading || !manager.data" @change="saveDefaultTier" /></div>
              <a-alert v-if="activeConnections" type="info" class="error-banner tier-runtime-notice" message="运行中的服务仍使用启动时的等级。更改默认值后，请停止并重启相关服务或实例；账号和供应商的独立设置仍优先。" />
              <div class="toolbar"><a-input v-model:value="search" :placeholder="page === 'connections' ? '搜索连接名称、标签或备注' : '搜索名称、邮箱或备注'" allow-clear class="search" @change="offset = 1"><template #prefix><SearchOutlined /></template></a-input><a-select v-if="page === 'accounts'" v-model:value="kind" style="width: 150px" @change="offset = 1" :options="[{ label: '全部类型', value: 'all' }, { label: 'ChatGPT OAuth', value: 'oauth' }, { label: 'Agent Identity', value: 'agent_identity' }]" /><a-button :disabled="manager.data?.quotaRefresh?.running" @click="refreshSelected">{{ selected.length ? '刷新所选用量' : '刷新全部用量' }}</a-button><span class="toolbar-spacer" /><span class="muted">{{ filtered.length }} 个{{ page === 'connections' ? '连接' : '账号' }}</span><a-button aria-label="重新加载账号" @click="manager.load"><ReloadOutlined /></a-button><a-button v-if="selected.length" danger @click="deleteSelected"><DeleteOutlined />移入回收站 {{ selected.length }} 项</a-button></div>
              <div class="toolbar account-filters">
                <a-select v-model:value="groupFilter" style="width: 170px" :options="[{ label: '全部分组', value: 'all' }, { label: '未分组', value: 'none' }, ...groups.map(g => ({ label: g.name, value: g.id }))]" />
                <a-select v-model:value="tagFilter" placeholder="全部标签" allow-clear style="width: 140px" :options="allTags.map(tag => ({ label: tag, value: tag }))" />
                <a-button @click="groupsOpen = true">管理分组</a-button>
                <AccountRecyclePanel />
                <a-button v-if="visible.length" @click="selectVisible">选择本页</a-button>
                <a-button v-if="selected.length" @click="selected = []">取消选择</a-button>
                <a-button v-if="selected.length" @click="tagsOpen = true">批量标签</a-button>
                <a-button v-if="filtered.length || selected.length" @click="exportAccounts">导出{{ selected.length ? '所选' : '筛选结果' }}（含凭据）</a-button>
              </div>
              <a-empty v-if="page === 'connections' && !pageAccounts.length" description="还没有 API 连接"><a-button @click="page = 'providers'">前往供应商库添加</a-button></a-empty>
              <div v-else-if="!pageAccounts.length" class="empty-panel"><div class="empty-icon"><UserOutlined /></div><h2>添加你的第一个账号</h2><p>登录 ChatGPT，或导入已有的登录凭据。<br>账号凭据保存在本机系统加密存储中。</p><a-space><a-button v-if="page === 'accounts'" type="primary" @click="openAccountLogin()"><PlusOutlined />添加账号</a-button><a-button @click="importOpen = true">导入账号</a-button><a-button @click="openMigration()">扫描本机数据</a-button></a-space><div class="empty-footnote"><SafetyCertificateOutlined />独立存储，不自动改写现有客户端</div></div>
              <a-empty v-else-if="!filtered.length" description="没有匹配的账号" />
              <div v-else class="account-grid">
                <AccountCard v-for="account in visible" :key="account.id" :account="account"
                  :selected="selected.includes(account.id)" :groups="memberships.get(account.id) ?? []"
                  :client-maintained="!!manager.data?.clientAuthorities?.some(entry => entry.accountId === account.id)"
                  :connection-label="account.kind === 'api_key' ? connectionContext(account) : undefined"
                  :refreshing="!!manager.data?.quotaRefresh?.running"
                  @select="toggleAccount(account.id, $event)" @edit="openAccount(account)" @proxy="openAccountProxy(account)"
                  @refresh="refreshQuotas([account.id])" @refresh-subscription="refreshSubscription(account.id)"
                  @refresh-reset-credits="refreshResetCredits(account.id)" @consume-reset-credit="consumeResetCredit(account.id)" />
                <button v-if="page === 'accounts'" class="account-add-card" type="button" @click="openAccountLogin()">
                  <PlusOutlined aria-hidden="true" /><strong>添加账号</strong><span>登录或导入已有账号</span>
                </button>
              </div>
              <a-pagination v-if="filtered.length > 24" v-model:current="offset" :total="filtered.length" :page-size="24" :show-size-changer="false" class="pagination" />
            </section>
            <template v-else-if="page === 'overview'">
              <div class="page-heading"><div><h1>工作空间概览</h1><p>查看账号、供应商密钥与独立实例。</p></div><a-button @click="page = 'instances'"><DesktopOutlined />管理实例</a-button></div>
              <div class="stats-grid"><a-card><a-statistic title="账号总数" :value="identityAccounts.length" /></a-card><a-card><a-statistic title="供应商密钥" :value="providerKeyCount" /></a-card><a-card><a-statistic title="运行中实例" :value="runningInstanceCount" /></a-card></div>
              <OverviewAssets :accounts="identityAccounts" :providers="providers" @manage-accounts="page = 'accounts'" @manage-providers="page = 'providers'" @view-account="viewOverviewAccount" @view-key="viewOverviewKey" />
            </template>
            <template v-else-if="page === 'gateway'">
              <div class="page-heading"><div><h1>本地 API</h1><p>通过本机地址使用账号，默认服务等级由管理器应用。</p></div><a-tag :color="manager.data?.gateway?.running ? 'green' : undefined">{{ manager.data?.gateway?.running ? '运行中' : '已停止' }}</a-tag></div>
              <a-tabs><a-tab-pane key="pool" tab="账号池与密钥"><LocalAccessPanel /></a-tab-pane><a-tab-pane key="single" tab="单账号连接">
              <a-card title="连接配置" class="settings-card"><a-form layout="vertical"><a-form-item label="使用账号"><a-select v-model:value="gatewayAccountId" placeholder="选择已保存的账号" :disabled="manager.data?.gateway?.running" :options="accounts.map(a => ({ label: a.name, value: a.id }))" /></a-form-item><a-form-item label="默认服务等级"><a-segmented :value="manager.data?.settings.defaultTier ?? 'follow'" :options="tiers" :disabled="settingsSaving || manager.loading || !manager.data" @change="saveDefaultTier" /><p class="muted">账号设置优先于供应商默认，供应商默认优先于全局。服务运行期间的配置修改，在停止并重新启动后应用。</p></a-form-item><a-space><a-button v-if="!manager.data?.gateway?.running && !manager.data?.localAccess?.singleStarting" type="primary" :disabled="!gatewayAccountId || manager.data?.localAccess?.starting" :loading="manager.loading" @click="startGateway">启动本地 API</a-button><a-button v-else danger :loading="manager.loading" @click="stopGateway">{{manager.data?.localAccess?.singleStarting?'取消启动':'停止服务'}}</a-button><a-button @click="manager.load"><ReloadOutlined />刷新状态</a-button></a-space></a-form></a-card>
              <a-card v-if="manager.data?.gateway?.running" title="客户端接入" class="settings-card"><a-descriptions :column="1"><a-descriptions-item label="Base URL"><code>http://127.0.0.1:{{ manager.data.gateway.port }}/v1</code></a-descriptions-item><a-descriptions-item label="API Key"><a-button size="small" @click="copyGatewayKey">复制本地密钥</a-button></a-descriptions-item><a-descriptions-item label="已应用的默认等级">{{ manager.data.gateway.defaultTier || '跟随请求（不补充）' }}</a-descriptions-item><a-descriptions-item label="请求协议">Responses · /v1/responses</a-descriptions-item></a-descriptions><p class="muted">仅监听 127.0.0.1。实际请求可以显式选择 Standard / Fast；API Key 账号的网关路径当前使用 HTTP / SSE。</p></a-card>
              </a-tab-pane></a-tabs>
            </template>
            <HistoryView v-else-if="page === 'history'" />
            <ClientConfigPanel v-else-if="page === 'config'" />
            <ProviderLibraryView id="provider-library-panel" role="tabpanel" aria-labelledby="provider-library-tab" ref="providerLibrary" v-else-if="page === 'providers'" @manage-connections="viewConnections" />
            <InstancesView v-else-if="page === 'instances'" :login-result="loginResult" @add-account="openAccountLogin" />
            <SessionsView v-else-if="page === 'sessions'" />
            <WakeupPanel v-else-if="page === 'wakeup'" :accounts="accounts" />
            <template v-else-if="page === 'settings'">
              <div class="page-heading">
                <div><h1>设置</h1><p>本机配置，独立保存。</p></div>
                <a-space class="settings-actions">
                  <span v-if="settingsDirty" class="muted settings-unsaved">有未保存的更改</span>
                  <a-button :disabled="!settingsDirty || settingsSaving" @click="discardSettings">放弃更改</a-button>
                  <a-button type="primary" :loading="settingsSaving" :disabled="!settingsDirty || !settingsValid || manager.loading" @click="saveSettings">保存设置</a-button>
                </a-space>
              </div>
              <a-card title="外观与请求" class="settings-card settings-draft">
                <a-form layout="vertical">
                  <a-form-item label="主题"><a-segmented v-model:value="settings.theme" :options="[{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]" /></a-form-item>
                  <a-form-item label="默认服务等级" extra="保存后使用。仅补充未指定的请求等级；Fast 对应 priority。运行中的服务或实例需重启后应用。"><a-segmented v-model:value="settings.defaultTier" :options="tiers" /></a-form-item>
                  <a-form-item label="本地 API 端口"><a-input-number v-model:value="settings.port" :min="1024" :max="65535" /></a-form-item>
                  <a-form-item label="自动刷新间隔（分钟）" extra="0 表示关闭。应用运行期间自动刷新登录账号及已手动查询成功的 API 账号，最多同时查询 3 个账号。"><a-input-number v-model:value="settings.refreshMinutes" :min="0" :max="1440" /></a-form-item>
                  <a-form-item label="开机启动" extra="保存后由系统登录项生效；桌面系统不支持时会保留设置并提示错误。"><a-checkbox v-model:checked="settings.launchAtLogin">登录系统后自动启动 Agent Manager Lite</a-checkbox></a-form-item>
                  <a-form-item label="关闭窗口行为" extra="启用后点击窗口关闭按钮只隐藏到系统托盘；从托盘选择“退出”才会结束应用。"><a-checkbox v-model:checked="settings.closeToTray">关闭主窗口时隐藏到系统托盘</a-checkbox></a-form-item>
                </a-form>
              </a-card>
              <UpstreamProxyPanel />
              <a-card title="流式请求超时" class="settings-card stream-timeouts">
                <p class="muted">适用于 HTTP 和 WebSocket。按秒设置等待响应与流式空闲时限；WebSocket 每轮等待首个事件也受此限制。已经返回内容的请求不会重新发送。保存后需重启本地服务或实例。</p>
                <a-form layout="vertical">
                  <a-form-item label="等待上游响应（秒）"><a-input-number v-model:value="settings.streamOpenTimeoutSeconds" :min="1" :max="600" /></a-form-item>
                  <a-form-item label="流式空闲（秒）"><a-input-number v-model:value="settings.streamIdleTimeoutSeconds" :min="1" :max="600" /></a-form-item>
                  <a-form-item label="图片请求等待响应（秒）"><a-input-number v-model:value="settings.imageStreamOpenTimeoutSeconds" :min="1" :max="600" /></a-form-item>
                  <a-form-item label="图片流式空闲（秒）"><a-input-number v-model:value="settings.imageStreamIdleTimeoutSeconds" :min="1" :max="600" /></a-form-item>
                </a-form>
              </a-card>
              <a-card title="数据" class="settings-card"><p class="muted">凭据由操作系统加密；编辑窗口按需读取已保存的 API Key。</p><code>{{ manager.data?.dataDirectory }}</code><DataBackupPanel /></a-card>
              <SshServersPanel />
            </template>
          </a-spin>
        </main>
      </section>
      <LoginDialog v-model:open="loginOpen" :client-type="loginRequest?.clientType" @completed="accountLoginCompleted" @scan-local="openMigration(true)" />
      <LocalDataMigrationDialog :open="localDataOpen" @close="localDataOpen = false" @changed="migrationChanged" />
      <AccountEditor v-model:open="addOpen" :account="editingAccount" @edit-provider="editConnectionProvider" />
      <AccountProxyDialog v-model:open="accountProxyOpen" :account="proxyAccount" />
      <ImportDialog v-model:open="importOpen" />
      <GroupsDialog v-model:open="groupsOpen" :selected="selected" />
      <a-modal v-model:open="tagsOpen" title="批量修改标签" ok-text="应用标签" cancel-text="取消" :confirm-loading="manager.loading" @ok="applyTags">
        <p>将修改所选 {{ selected.length }} 个账号。</p>
        <a-radio-group v-model:value="batchTagMode" :options="[{ label: '添加', value: 'add' }, { label: '移除', value: 'remove' }, { label: '替换全部标签', value: 'replace' }]" />
        <a-select v-model:value="batchTagValues" mode="tags" placeholder="输入标签后按回车" :options="allTags.map(tag => ({ label: tag, value: tag }))" style="width: 100%; margin-top: 20px" />
        <a-alert v-if="manager.error" type="error" :message="manager.error" style="margin-top: 16px" />
      </a-modal>
    </div>
  </a-config-provider>
</template>
