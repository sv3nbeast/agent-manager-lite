<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { accountInputSchema, type Account, type AccountInput } from '../../../shared/types'
import { integrationTypeOptions } from '../../../shared/providerUsage'
import { providerEndpoint } from '../../../shared/providerLibrary'
import ModelContextWindowsField from './ModelContextWindowsField.vue'
import { useManager } from '../store'
import { focusFirstInvalidField, useFormFeedback, validationErrors } from '../formFeedback'
import FormFeedback from './FormFeedback.vue'

const props = defineProps<{ open: boolean; account?: Account }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'edit-provider': [providerId: string] }>()
const manager = useManager()
const managedConnection = computed(() => props.account?.kind === 'api_key' && !!props.account.providerId)
const linkedProvider = computed(() => manager.data?.providers?.find(provider => provider.id === props.account?.providerId))
const linkedKey = computed(() => linkedProvider.value?.keys.find(key => key.id === props.account?.providerKeyId))
const inheritedModels = computed(() => linkedProvider.value?.models ?? props.account?.models ?? [])
const inheritedProtocol = computed(() => (linkedProvider.value?.wireApi ?? props.account?.wireApi) === 'chat_completions' ? 'Chat Completions' : 'Responses')
const inheritedIntegration = computed(() => integrationTypeOptions.find(option => option.value === (linkedProvider.value?.integrationType ?? props.account?.integrationType ?? 'auto'))?.label ?? '自动识别')
const models = ref('gpt-5.5')
const connectionModels = computed(() => managedConnection.value ? inheritedModels.value : models.value.split(/[\n,]/).map(model => model.trim()).filter(Boolean))
const form = reactive<AccountInput>({ name: '', apiKey: '', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
const editingAccount = ref<Account>()
const keyLoading = ref(false), keyError = ref(''), loadedKey = ref(''), keyNeedsEntry = ref(false)
const formError = ref(''), fieldErrors = ref<Record<string, string>>({})
useFormFeedback(() => keyError.value || formError.value, { active: () => props.open })
watch(() => [props.open, form.name, form.apiKey, form.baseUrl, models.value, form.note, JSON.stringify(form.tags), JSON.stringify(form.modelContextWindows)], () => {
  formError.value = ''; fieldErrors.value = {}
}, { flush: 'sync' })
let keyRead = 0, initializing = false
function clearKey() {
  keyRead++; form.apiKey = ''; loadedKey.value = ''; keyLoading.value = false; keyError.value = ''
}
function close() { clearKey(); emit('update:open', false) }
async function loadKey(account: Account) {
  const request = ++keyRead
  keyLoading.value = true
  try {
    const value = await window.manager.readAccountKey({ id: account.id, revision: account.revision ?? 0 })
    if (request !== keyRead || !props.open || props.account?.id !== account.id) return
    const current = manager.data?.accounts.find(item => item.id === account.id)
    if ((props.account.revision ?? 0) !== (account.revision ?? 0)
      || manager.data && (!current || (current.revision ?? 0) !== (account.revision ?? 0))) {
      keyError.value = '账号已变化，请重新打开编辑窗口。'; return
    }
    if (!value.trim()) { keyError.value = '此连接未配置 API Key，请重新打开或重新添加连接。'; return }
    loadedKey.value = value
    if (!form.apiKey) form.apiKey = value
  } catch {
    if (request === keyRead) keyError.value = '无法读取 API Key，请重新打开编辑窗口。'
  } finally { if (request === keyRead) keyLoading.value = false }
}
// Invalidate immediately, but initialize after Vue has patched both props.
// Opening the same account can update `open` before its newer revision arrives.
watch([() => props.open, () => props.account?.id], clearKey, { flush: 'sync' })
watch([() => props.open, () => props.account?.id], ([open]) => {
  clearKey(); keyNeedsEntry.value = false
  if (!open) { editingAccount.value = undefined; return }
  const account = props.account ? JSON.parse(JSON.stringify(props.account)) as Account : undefined
  editingAccount.value = account
  initializing = true
  Object.assign(form, { name: account?.name ?? '', apiKey: '', baseUrl: account?.baseUrl ?? 'https://api.openai.com/v1',
    models: [...(account?.models ?? ['gpt-5.5'])], wireApi: account?.wireApi ?? 'responses',
    modelContextWindows: account?.modelContextWindows ? { ...account.modelContextWindows } : undefined,
    defaultTier: account?.defaultTier ?? 'inherit', integrationType: account?.integrationType ?? 'auto', note: account?.note ?? '', tags: [...(account?.tags ?? [])] })
  models.value = form.models.join('\n')
  initializing = false
  manager.error = ''
  if (account?.kind === 'api_key' && !account.providerId) void loadKey(account)
}, { immediate: true })
watch(() => form.baseUrl, (value, previous) => {
  if (initializing || !props.open || editingAccount.value?.kind !== 'api_key' || managedConnection.value) return
  let changed = value !== previous
  try { changed = providerEndpoint(value) !== providerEndpoint(previous) } catch {}
  if (changed) { clearKey(); keyNeedsEntry.value = true }
}, { flush: 'sync' })
onBeforeUnmount(clearKey)
async function save() {
  if (!props.open || keyLoading.value || keyError.value || manager.loading) return
  const original = editingAccount.value, request = keyRead
  const values = { ...form, tags: [...form.tags], models: [...connectionModels.value], modelContextWindows: form.modelContextWindows ? { ...form.modelContextWindows } : undefined }
  formError.value = ''
  const metadataOnly = original && (original.kind !== 'api_key' || original.providerId)
  const schema = metadataOnly
    ? accountInputSchema.pick({ name: true, note: true, tags: true, defaultTier: true, modelContextWindows: true }) : accountInputSchema
  const validation = schema.safeParse(metadataOnly ? { name: values.name, note: values.note, tags: values.tags, defaultTier: values.defaultTier, modelContextWindows: values.modelContextWindows } : values)
  if (!validation.success) {
    fieldErrors.value = validationErrors(validation.error.issues, { name: managedConnection.value ? '连接名称' : '账号名称', baseUrl: 'API 地址', apiKey: 'API Key', models: '模型', modelContextWindows: '模型上下文', tags: '标签', note: '备注' })
    formError.value = Object.values(fieldErrors.value)[0] || '请检查账号配置'
    void focusFirstInvalidField('.account-editor-form')
    return
  }
  const action = original ? () => {
    const changes: Partial<AccountInput> = {}
    for (const key of ['name', 'note', 'tags', 'defaultTier'] as const) {
      if (JSON.stringify(values[key]) !== JSON.stringify(original[key])) Object.assign(changes, { [key]: values[key] })
    }
    if (original.kind === 'api_key') {
      if (JSON.stringify(values.modelContextWindows ?? {}) !== JSON.stringify(original.modelContextWindows ?? {})) {
        changes.modelContextWindows = values.modelContextWindows ?? {}
      }
      if (!original.providerId) {
        for (const key of ['baseUrl', 'models', 'wireApi'] as const) {
          if (JSON.stringify(values[key]) !== JSON.stringify(original[key])) Object.assign(changes, { [key]: values[key] })
        }
        if (values.apiKey.trim() && values.apiKey.trim() !== loadedKey.value) changes.apiKey = values.apiKey
        if (values.integrationType !== (original.integrationType ?? 'auto')) changes.integrationType = values.integrationType
      }
    }
    return window.manager.editAccount({ id: original.id, revision: original.revision ?? 0, changes })
  } : () => window.manager.addAccount(values)
  if (await manager.execute(action) && request === keyRead && props.open) { close(); message.success(original ? '账号已更新' : '账号已添加') }
}
async function unlink() {
  const account = editingAccount.value, request = keyRead
  if (account && await manager.execute(() => window.manager.mutateProvider({action:'unlinkAccount',accountId:account.id,accountRevision:account.revision ?? 0})) && request === keyRead && props.open) {
    close(); message.success('已解除关联，原连接和服务等级已保留')
  }
}
function editProvider() {
  const provider = linkedProvider.value
  if (!provider) return
  close()
  emit('edit-provider', provider.id)
}
</script>

<template>
  <a-drawer :open="open" :title="managedConnection ? '编辑连接' : account ? '编辑账号' : '添加 API 账号'" :width="500" destroy-on-close @close="close">
    <a-form layout="vertical" class="account-editor-form" @finish="save">
      <section v-if="managedConnection" class="connection-shared-config" aria-label="供应商共享配置">
        <div class="connection-source-heading"><span><small>共享配置来源</small><strong>{{ linkedProvider?.name ?? '未知供应商' }}</strong></span><a-button v-if="linkedProvider" type="link" size="small" @click="editProvider">编辑供应商配置</a-button></div>
        <p v-if="linkedProvider">使用密钥「{{ linkedKey?.name || '已关联密钥' }}」· {{ inheritedModels.length }} 个模型 · {{ inheritedProtocol }}</p>
        <p v-else>当前找不到关联的供应商。此连接仍保留已保存的配置，可解除关联后独立编辑。</p>
        <details class="connection-inherited-details">
          <summary>查看继承配置</summary>
          <dl>
            <div><dt>Base URL</dt><dd>{{ linkedProvider?.baseUrl ?? account?.baseUrl }}</dd></div>
            <div><dt>API Key</dt><dd>{{ linkedKey?.name || '已关联密钥' }} · {{ account?.credentialConfigured ? '凭据已保存' : '凭据未配置' }}</dd></div>
            <div><dt>上游协议</dt><dd>{{ inheritedProtocol }}</dd></div>
            <div><dt>额度查询</dt><dd>{{ inheritedIntegration }}</dd></div>
            <div><dt>模型列表</dt><dd class="connection-inherited-models"><span v-for="model in inheritedModels" :key="model">{{ model }}</span><span v-if="!inheritedModels.length">未配置模型</span></dd></div>
          </dl>
        </details>
        <div class="connection-source-footer"><small>{{ linkedProvider ? '地址、密钥和模型在供应商处统一维护。' : '解除关联后保留现有连接配置。' }}</small><a-button type="link" size="small" @click="unlink">解除关联</a-button></div>
      </section>
      <a-form-item :label="managedConnection ? '连接名称' : '账号名称'" required :validate-status="fieldErrors.name ? 'error' : undefined" :help="fieldErrors.name"><a-input v-model:value="form.name" :maxlength="120" /></a-form-item>
      <template v-if="(!account || account.kind === 'api_key') && !managedConnection">
        <a-form-item label="Base URL" required :validate-status="fieldErrors.baseUrl ? 'error' : undefined" :help="fieldErrors.baseUrl"><a-input v-model:value="form.baseUrl" /></a-form-item>
        <a-form-item label="API Key" required :validate-status="fieldErrors.apiKey ? 'error' : undefined" :help="fieldErrors.apiKey" :extra="keyNeedsEntry ? '地址已更改，请填写用于此地址的 API Key' : undefined"><a-input v-model:value="form.apiKey" aria-label="账号 API Key" autocomplete="off" :disabled="keyLoading" :placeholder="keyLoading ? '正在读取已保存的 API Key…' : '请输入 API Key'" /></a-form-item>
        <a-form-item label="模型列表" extra="多个模型用逗号或换行分隔" required :validate-status="fieldErrors.models ? 'error' : undefined" :help="fieldErrors.models"><a-textarea v-model:value="models" :rows="3" /></a-form-item>
        <a-form-item label="上游协议"><a-select v-model:value="form.wireApi" :options="[{ label: 'Responses', value: 'responses' }, { label: 'Chat Completions', value: 'chat_completions' }]" /></a-form-item>
      </template>
      <a-form-item v-if="!account || account.kind === 'api_key'" label="模型上下文窗口" :validate-status="fieldErrors.modelContextWindows ? 'error' : undefined" :help="fieldErrors.modelContextWindows" :extra="managedConnection ? '仅覆盖此连接；未设置的模型继承供应商配置。保存后重新启动使用此连接的实例生效。' : '按模型单独配置，仅作用于此连接。保存后重新启动使用此连接的实例生效。'">
        <ModelContextWindowsField :key="account?.id ?? 'new-api'" v-model="form.modelContextWindows" :models="connectionModels" :inherited-windows="managedConnection ? linkedProvider?.modelContextWindows : undefined" :active="open" />
      </a-form-item>
      <a-form-item label="服务等级" extra="服务运行期间保存的等级修改，在停止并重新启动后应用。"><a-select v-model:value="form.defaultTier" :options="[{ label: account?.providerId ? '继承供应商设置' : '继承全局设置', value: 'inherit' }, { label: '跟随请求', value: 'follow' }, { label: 'Standard', value: 'standard' }, { label: 'Fast', value: 'fast' }, {label:'Auto',value:'auto'}, {label:'Flex',value:'flex'}]" /></a-form-item>
      <a-form-item v-if="(!account || account.kind === 'api_key') && !managedConnection" label="额度查询方式" extra="仅影响自定义服务商的额度查询；官方服务商仍使用专用接口。更改后请重新刷新用量。"><a-select v-model:value="form.integrationType" aria-label="账号额度查询方式" :options="integrationTypeOptions" /></a-form-item>
      <a-form-item label="标签" extra="输入后按回车，可添加多个标签"><a-select v-model:value="form.tags" mode="tags" :token-separators="[',']" /></a-form-item>
      <a-form-item label="备注"><a-textarea v-model:value="form.note" :maxlength="2000" :rows="3" /></a-form-item>
    </a-form>
    <template #footer><FormFeedback :error="keyError || formError || manager.error" /><a-space><a-button @click="close">取消</a-button><a-button type="primary" :loading="manager.loading" :disabled="keyLoading || !!keyError" @click="save">{{ managedConnection ? '保存连接' : '保存账号' }}</a-button></a-space></template>
  </a-drawer>
</template>

<style scoped>
.connection-shared-config { padding: 15px; margin-bottom: 22px; border: 1px solid #7c3aed26; border-radius: 11px; background: #7c3aed06; }
.connection-source-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.connection-source-heading > span { min-width: 0; }
.connection-source-heading small { display: block; font-size: 11px; opacity: .6; margin-bottom: 4px; }
.connection-source-heading strong { display: block; overflow-wrap: anywhere; font-size: 14px; }
.connection-source-heading > button { flex-shrink: 0; padding-right: 0; font-size: 12px; }
.connection-shared-config > p { margin: 10px 0 13px; font-size: 12px; opacity: .7; line-height: 1.7; overflow-wrap: anywhere; }
.connection-inherited-details { border-top: 1px solid #88888822; padding-top: 10px; font-size: 12px; }
.connection-inherited-details > summary { cursor: pointer; width: fit-content; }
.connection-inherited-details > summary:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 3px; border-radius: 3px; }
.connection-inherited-details dl { margin: 12px 0 0; display: grid; gap: 10px; }
.connection-inherited-details dl > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; align-items: start; }
.connection-inherited-details dt { opacity: .6; }
.connection-inherited-details dd { margin: 0; overflow-wrap: anywhere; }
.connection-inherited-models { display: flex; flex-wrap: wrap; gap: 5px; max-height: 180px; overflow-y: auto; }
.connection-inherited-models > span { background: #88888812; padding: 2px 6px; border-radius: 4px; max-width: 100%; }
.connection-source-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.connection-source-footer small { font-size: 11px; opacity: .6; line-height: 1.6; }
.connection-source-footer > button { flex-shrink: 0; padding-right: 0; font-size: 11px; }
</style>
