<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { configKeys, type ClientConfigChanges, type ClientConfigPreview, type ClientConfigTarget, type ClientConfigView, type ConfigKey, type QuickConfigKey } from '../../../shared/clientConfig'
import ModelCatalogEditor from './ModelCatalogEditor.vue'
import ProviderConfigEditor from './ProviderConfigEditor.vue'
import ClientIdentityPanel from './ClientIdentityPanel.vue'
import ClientSwitchPanel from './ClientSwitchPanel.vue'
import {providerChangeLabel} from '../../../shared/providerConfig'
import { useFormFeedback } from '../formFeedback'
import FormFeedback from './FormFeedback.vue'

const targets = ref<ClientConfigTarget[]>([]), selected = ref<string>()
const identityVersion=ref(0)
const view = ref<ClientConfigView>(), preview = ref<ClientConfigPreview>()
const busy = ref(false), error = ref(''), backup = ref<string>()
useFormFeedback(error)
const form = reactive<Record<QuickConfigKey, string | number | null>>({ model: null, model_provider: null, model_reasoning_effort: null, service_tier: null, model_context_window: null, model_auto_compact_token_limit: null })
let initial = { ...form }
const labels: Record<ConfigKey, string> = { model: '默认模型', model_provider: 'Provider', model_reasoning_effort: '推理档位', service_tier: '服务等级', model_context_window: '上下文窗口', model_auto_compact_token_limit: '压缩阈值', model_catalog_json: '模型目录文件',cli_auth_credentials_store:'凭据存储',forced_login_method:'登录方式' }
const tierOptions = [{ label: 'Fast', value: 'fast' }, { label: 'Standard', value: 'default' }, { label: 'Auto', value: 'auto' }, { label: 'Flex', value: 'flex' }, { label: 'Priority（保留已有值）', value: 'priority' }]
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (cause) { error.value = String(cause) } finally { busy.value = false }
}
function accept(value: ClientConfigView) {
  view.value = value; selected.value = value.target.id; backup.value = value.revisions[0]?.id
  for (const key of configKeys) {
    const value = view.value.values[key]
    form[key] = typeof value === 'string' || typeof value === 'number' ? value : null
  }
  initial = { ...form }
}
function changes(): ClientConfigChanges {
  const normalized = Object.fromEntries(configKeys.map(key => [key, form[key] === '' || form[key] === undefined ? null : form[key]]))
  const changed = Object.fromEntries(configKeys.filter(key => normalized[key] !== (initial[key] === '' ? null : initial[key])).map(key => [key, normalized[key]]))
  if ('model_context_window' in changed || 'model_auto_compact_token_limit' in changed) {
    changed.model_context_window = normalized.model_context_window
    changed.model_auto_compact_token_limit = normalized.model_context_window === null ? null : normalized.model_auto_compact_token_limit
  }
  return changed as ClientConfigChanges
}
async function reload() { await run(async () => { if (selected.value) accept(await window.manager.readClientConfig(selected.value)) }) }
async function afterChildSave() {await run(async()=>{if(!selected.value)return;const draft=changes();accept(await window.manager.readClientConfig(selected.value));Object.assign(form,draft)})}
async function afterSwitchSave(){identityVersion.value++;await afterChildSave()}
async function choose() {
  await run(async () => {
    const target = await window.manager.chooseClientConfig()
    if (target) { targets.value = await window.manager.listClientConfigs(); accept(await window.manager.readClientConfig(target.id)) }
  })
}
async function stage() {
  await run(async () => {
    if (!view.value) return
    preview.value = await window.manager.previewClientConfig({ id: view.value.target.id, revision: view.value.revision, changes: changes() })
  })
}
async function restore() {
  await run(async () => {
    if (view.value && backup.value) preview.value = await window.manager.previewRestoreClientConfig({ id: view.value.target.id, backup: backup.value })
  })
}
async function apply() {
  await run(async () => {
    if (!preview.value) return
    accept(await window.manager.applyClientConfig(preview.value.ticket)); preview.value = undefined
    message.success('配置已保存，客户端下次读取配置时生效')
  })
}
async function cancelPreview() { preview.value = undefined; await window.manager.discardClientConfig() }
onMounted(() => run(async () => { targets.value = await window.manager.listClientConfigs(); selected.value = targets.value[0]?.id; if (selected.value) accept(await window.manager.readClientConfig(selected.value)) }))
</script>

<template>
  <div class="client-config-panel">
    <div class="page-heading"><div><h1>客户端配置</h1><p>管理模型、服务等级与上下文设置，保存前查看改动。</p></div><a-button :disabled="busy" @click="choose">选择已有配置目录</a-button></div>
    <a-alert v-if="error" type="error" show-icon :message="error" class="error-banner" />
    <a-card title="配置位置" class="settings-card">
      <a-space wrap><a-select v-model:value="selected" aria-label="配置目录" :disabled="busy" :options="targets.map(target => ({ value: target.id, label: target.managed ? target.name : target.directory }))" style="width: 360px" @change="reload" /><a-button :loading="busy" @click="reload">重新读取</a-button></a-space>
      <p class="config-path"><code>{{ view?.target.directory }}/config.toml</code></p>
      <p class="muted">{{ view?.target.managed ? '独立的受管配置目录，可供受管实例使用。' : '此目录由你选择，预览并确认后才会写入。' }}{{ view?.exists ? '' : '文件尚未创建。' }}</p>
      <a-alert v-if="view?.activeProfile" type="info" show-icon :message="`当前默认 Profile：${view.activeProfile}，其中的设置可能覆盖下面的默认值。`" />
    </a-card>
    <ClientIdentityPanel v-if="view" :key="`identity-${view.target.id}-${identityVersion}`" :target-id="view.target.id" :config-revision="view.revision" />
    <ClientSwitchPanel v-if="view" :key="`switch-${view.target.id}`" :target-id="view.target.id" :config-revision="view.revision" @changed="afterSwitchSave" />
    <a-card v-if="view" title="默认请求设置" class="settings-card">
      <a-form layout="vertical" :model="form" :disabled="busy" @finish="stage">
        <div class="config-form-grid">
          <a-form-item label="默认模型"><a-input v-model:value="form.model" aria-label="默认模型" allow-clear placeholder="留空使用客户端默认值" /></a-form-item>
          <a-form-item label="Provider"><a-select v-model:value="form.model_provider" aria-label="Provider" allow-clear placeholder="客户端默认 Provider" :options="view.providers.map(id => ({ value: id, label: id }))" /></a-form-item>
          <a-form-item label="推理档位" extra="填写所选模型支持的档位；留空使用客户端默认值。"><a-input v-model:value="form.model_reasoning_effort" aria-label="推理档位" allow-clear placeholder="例如 high" /></a-form-item>
          <a-form-item label="服务等级" extra="Fast 写入 fast；Codex 发出请求时转换为 priority。"><a-select v-model:value="form.service_tier" aria-label="服务等级" allow-clear placeholder="使用客户端默认值" :options="tierOptions" /></a-form-item>
          <a-form-item label="上下文窗口（Token）" extra="留空时，同时移除自定义窗口和压缩阈值。"><a-input-number v-model:value="form.model_context_window" aria-label="上下文窗口" :min="2" :max="100000000" :precision="0" style="width: 100%" placeholder="跟随模型默认值" /></a-form-item>
          <a-form-item label="自动压缩阈值（Token）" extra="必须小于上下文窗口；修改窗口时留空将取窗口的 90%。"><a-input-number v-model:value="form.model_auto_compact_token_limit" aria-label="自动压缩阈值" :disabled="!form.model_context_window" :min="1" :max="100000000" :precision="0" style="width: 100%" /></a-form-item>
        </div>
        <p class="muted">这里修改默认配置。客户端已打开的会话、Profile、项目设置和启动参数可能有各自的覆盖值。</p>
        <a-button type="primary" html-type="submit" :loading="busy">预览改动</a-button>
      </a-form>
    </a-card>
    <ProviderConfigEditor v-if="view" :key="`providers-${view.target.id}`" :target-id="view.target.id" :config-revision="view.revision" @saved="afterChildSave" />
    <ModelCatalogEditor v-if="view" :key="view.target.id" :target-id="view.target.id" :config-revision="view.revision" @saved="afterChildSave" />
    <a-card v-if="view?.revisions.length" title="配置恢复" class="settings-card">
      <p class="muted">每次保存都有原文件备份。恢复只撤销选定改动，保留之后手工修改的字段。</p>
      <a-space wrap><a-select v-model:value="backup" aria-label="配置备份" :disabled="busy" style="width: 340px" :options="view.revisions.map(revision => ({value:revision.id,label:`${new Date(revision.createdAt).toLocaleString()} · ${revision.kind === 'apply' ? '保存配置' : '恢复配置'}`}))" /><a-button :disabled="busy || !backup" @click="restore">预览恢复</a-button></a-space>
    </a-card>
    <a-modal :open="!!preview" :title="preview?.kind === 'restore' ? '确认恢复配置' : '确认配置改动'" :width="720" ok-text="应用改动" cancel-text="取消" :confirm-loading="busy" :ok-button-props="{disabled:!preview?.changes.length}" :body-style="{maxHeight:'70vh',overflowY:'auto'}" @ok="apply" @cancel="cancelPreview">
      <p class="config-path"><code>{{ preview?.target.directory }}/config.toml</code></p>
      <a-alert v-if="preview?.conflicts.length" type="warning" show-icon :message="`以下字段已有其他修改，将保留：${preview.conflicts.map(key => labels[key]??providerChangeLabel(key)).join('、')}`" style="margin-bottom: 16px" />
      <a-table :data-source="preview?.changes" :pagination="false" row-key="key" size="small" table-layout="fixed" :columns="[{title:'设置',dataIndex:'key',width:200},{title:'当前值',dataIndex:'before'},{title:'保存后',dataIndex:'after'}]">
        <template #bodyCell="{column,record,text}"><span v-if="column.dataIndex === 'key'" class="config-value">{{ labels[record.key as ConfigKey]??providerChangeLabel(record.key) }}</span><code v-else class="config-value">{{ text }}</code></template>
        <template #emptyText>没有需要修改的配置</template>
      </a-table>
      <template #footer><FormFeedback :error="error" /><a-space><a-button :disabled="busy" @click="cancelPreview">取消</a-button><a-button type="primary" :loading="busy" :disabled="busy || !preview?.changes.length" @click="apply">应用改动</a-button></a-space></template>
    </a-modal>
  </div>
</template>

<style scoped>
.config-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 28px; }
.config-path { margin: 16px 0 8px; overflow-wrap: anywhere; font-size: 12px; }
.config-value { overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 1050px) { .config-form-grid { grid-template-columns: 1fr; } }
</style>
