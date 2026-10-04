<script setup lang="ts">
import { integrationTypeOptions } from '../../../shared/providerUsage'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, ApiOutlined, KeyOutlined, DownOutlined } from '@ant-design/icons-vue'
import type { Account } from '../../../shared/types'
import { providerEndpoint, type ProviderDetails, type ProviderMutation, type ProviderSummary, type ProviderKeySummary } from '../../../shared/providerLibrary'
import { providerPresets, providerPreset } from '../../../shared/providerPresets'
import { useManager } from '../store'
import ProviderProbePanel from './ProviderProbePanel.vue'
import ProviderUsageDetails from './ProviderUsageDetails.vue'
import ProviderModelsField from './ProviderModelsField.vue'
import ModelContextWindowsField from './ModelContextWindowsField.vue'

const emit=defineEmits<{'manage-connections':[accountId?:string]}>()
const manager = useManager()
const providers = computed(() => manager.data?.providers ?? [])
const selectedId = ref<string>(), search = ref(''), page = ref(1)
const filtered = computed(() => providers.value.filter(p => `${p.name} ${p.baseUrl}`.toLowerCase().includes(search.value.toLowerCase())))
const visible = computed(() => filtered.value.slice((page.value - 1) * 12, page.value * 12))
const selected = computed(() => providers.value.find(p => p.id === selectedId.value))
const keyPage = ref(1), focusedKeyId = ref<string>()
watch(selectedId, () => { keyPage.value = 1; focusedKeyId.value = undefined })
watch(() => selected.value?.keys.length ?? 0, count => {
  keyPage.value = Math.min(keyPage.value, Math.max(1, Math.ceil(count / 10)))
  if (!selected.value?.keys.some(key => key.id === focusedKeyId.value)) focusedKeyId.value = undefined
})
async function showKey(providerId:string, keyId:string):Promise<boolean> {
  const index=providers.value.findIndex(provider=>provider.id===providerId)
  const keyIndex=providers.value[index]?.keys.findIndex(key=>key.id===keyId) ?? -1
  if(index<0 || keyIndex<0)return false
  search.value=''; selectedId.value=providerId
  await nextTick()
  page.value=Math.floor(index/12)+1;keyPage.value=Math.floor(keyIndex/10)+1;focusedKeyId.value=keyId
  await nextTick()
  document.querySelector(`.provider-detail [data-row-key="${keyId}"]`)?.scrollIntoView({block:'center'})
  return true
}
function editProvider(providerId:string):boolean {
  const provider=providers.value.find(item=>item.id===providerId)
  if(!provider)return false
  openEditor(provider)
  return true
}
defineExpose({showKey,editProvider})
watch(search, () => { page.value = 1 })
watch(providers, value => {
  if (!value.some(p => p.id === selectedId.value)) selectedId.value = value[0]?.id
  page.value = Math.min(page.value, Math.max(1, Math.ceil(filtered.value.length / 12)))
}, { immediate: true })
const tierOptions = [{label:'继承全局设置',value:'inherit'}, {label:'跟随请求',value:'follow'},
  {label:'Standard',value:'standard'}, {label:'Fast',value:'fast'}, {label:'Auto',value:'auto'}, {label:'Flex',value:'flex'}]
const tierLabel = (value: string) => tierOptions.find(option => option.value === value)?.label ?? value
const editorOpen = ref(false), editing = ref<ProviderSummary>()
const editorSections = ref<string[]>([])
const quickFillSections = ref<string[]>([])
const details = reactive<ProviderDetails>({name:'',baseUrl:'https://api.openai.com/v1',models:[],wireApi:'responses',defaultTier:'inherit'})
const models = ref('')
const modelValues = computed({get:()=>[...new Set(models.value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean))],set:(value:string[])=>{models.value=value.join('\n')}})
const draftKey = ref(''), createConnection=ref(true)
const editorKeyId = ref<string>(), loadedEditorKey = ref(''), editorKeyLoading = ref(false), editorKeyError = ref('')
let editorKeyRead = 0, operationKeyRead = 0
const savedKeyAddress = computed(() => {
  try { return !!editing.value && providerEndpoint(details.baseUrl) === providerEndpoint(editing.value.baseUrl) }
  catch { return false }
})
function clearEditorKey() {
  editorKeyRead++; editorKeyLoading.value=false; draftKey.value=''; loadedEditorKey.value=''; editorKeyId.value=undefined; editorKeyError.value=''
}
async function selectEditorKey(id?:string) {
  clearEditorKey()
  const provider=editing.value
  if (!id || !provider || !savedKeyAddress.value || !editorOpen.value) return
  const request=++editorKeyRead
  editorKeyId.value=id;editorKeyLoading.value=true
  try {
    const value=await window.manager.readProviderKey({id:provider.id,revision:provider.revision,keyId:id})
    if (request!==editorKeyRead || !editorOpen.value || editing.value?.id!==provider.id || editing.value.revision!==provider.revision || editorKeyId.value!==id || !savedKeyAddress.value) return
    if (providers.value.find(item=>item.id===provider.id)?.revision!==provider.revision) { editorKeyError.value='供应商已变化，请重新打开编辑窗口。';return }
    draftKey.value=value;loadedEditorKey.value=value
  } catch {
    if (request===editorKeyRead) editorKeyError.value='无法读取所选密钥，供应商或密钥可能已变化，请重新打开编辑窗口。'
  } finally { if (request===editorKeyRead) editorKeyLoading.value=false }
}
watch(()=>details.baseUrl,(value,previous)=>{
  let changed=value!==previous
  try { changed=providerEndpoint(value)!==providerEndpoint(previous) } catch {}
  if (editorOpen.value && editing.value && changed) clearEditorKey()
},{flush:'sync'})
watch(editorOpen,open=>{if(!open)clearEditorKey()},{flush:'sync'})
onBeforeUnmount(()=>{clearEditorKey();closeOperation()})
const presetOptions = providerPresets.map(preset => ({label:preset.name,value:preset.id}))
const clone = <T,>(value:T):T => JSON.parse(JSON.stringify(value))
function openEditor(provider?:ProviderSummary) {
  editing.value = provider ? clone(provider) : undefined
  Object.assign(details, {name:provider?.name ?? '',baseUrl:provider?.baseUrl ?? 'https://api.openai.com/v1',
    wireApi:provider?.wireApi ?? 'responses',defaultTier:provider?.defaultTier ?? 'inherit',integrationType:provider?.integrationType ?? 'auto',
    presetId:provider?.presetId,
    modelContextWindows:provider?.modelContextWindows ? clone(provider.modelContextWindows) : undefined,
    supportsVision:provider?.supportsVision, visionRoutingModel:provider?.visionRoutingModel,
    supportsWebsockets:provider?.supportsWebsockets, enableModePreference:provider?.enableModePreference})
  models.value = provider?.models.join('\n') ?? ''
  editorSections.value = Object.keys(provider?.modelContextWindows ?? {}).length ? ['context'] : []
  quickFillSections.value = []
  clearEditorKey();createConnection.value=true
  manager.error = ''; editorOpen.value = true
  if (provider?.keys[0]) void selectEditorKey(provider.keys[0].id)
}
function applyPreset(id:string) {
  const preset = providerPreset(id)
  if (!preset) return
  details.presetId = id
  if (preset.baseUrls[0]) details.baseUrl = preset.baseUrls[0]
  if (preset.modelCatalog?.length) models.value = [...new Set([...preset.modelCatalog, ...(preset.visionModelCatalog ?? [])])].join('\n')
}
async function mutate(input:ProviderMutation) {
  // Vue's nested draft objects are proxies; Electron IPC accepts plain data only.
  return manager.execute(() => window.manager.mutateProvider(clone(input)))
}
async function saveProvider() {
  if (editorKeyLoading.value || editorKeyError.value) return
  if (editorKeyId.value && !draftKey.value.trim()) { message.info('密钥不能为空；移除密钥请使用供应商详情中的移除操作'); return }
  const values:ProviderDetails = {
    name:details.name, baseUrl:details.baseUrl,
    models:[...new Set(models.value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean))],
    wireApi:details.wireApi, defaultTier:details.defaultTier,
    ...(details.integrationType ? {integrationType:details.integrationType} : {}),
    ...(details.presetId ? {presetId:details.presetId} : {}),
    ...(details.modelContextWindows ? {modelContextWindows:details.modelContextWindows} : {}),
    ...(details.supportsVision === undefined ? {} : {supportsVision:details.supportsVision}),
    ...(details.visionRoutingModel?.trim() ? {visionRoutingModel:details.visionRoutingModel.trim()} : {}),
    ...(details.supportsWebsockets === undefined ? {} : {supportsWebsockets:details.supportsWebsockets}),
    ...(details.enableModePreference ? {enableModePreference:details.enableModePreference} : {})
  }
  const provider = editing.value
  if (await mutate(provider ? {action:'update',id:provider.id,revision:provider.revision,changes:values,
    ...(!details.modelContextWindows && provider.modelContextWindows ? {clearModelContextWindows:true} : {}),
    ...(editorKeyId.value && draftKey.value.trim()!==loadedEditorKey.value ? {keyChange:{keyId:editorKeyId.value,apiKey:draftKey.value.trim()}} : {})
  } : {action:'create',details:values,...(draftKey.value.trim()?{initialKey:{name:'',apiKey:draftKey.value.trim(),createConnection:createConnection.value}}:{})})) {
    editorOpen.value = false
    selectedId.value = provider?.id ?? providers.value.at(-1)?.id
    message.success({key:'provider-operation',content:'供应商已保存'})
  }
}
type Operation = 'addKey' | 'editKey' | 'moveKey' | 'createAccount' | 'linkAccount'
const operation = ref<Operation>(), owner = ref<ProviderSummary>(), key = ref<ProviderKeySummary>()
const keyForm = reactive({name:'',apiKey:'',createConnection:true})
const operationKeyLoading = ref(false), operationKeyError=ref('')
const target = ref<ProviderSummary>(), account = ref<Account>()
const operationTitle:Record<Operation,string> = {addKey:'添加密钥',editKey:'编辑密钥',moveKey:'移动密钥',createAccount:'启用 API 连接',linkAccount:'关联已有 API 连接'}
async function openOperation(action:Operation, provider:ProviderSummary, item?:ProviderKeySummary) {
  closeOperation()
  owner.value = clone(provider); key.value = item ? clone(item) : undefined
  keyForm.name = action === 'createAccount' ? item?.name || provider.name : item?.name ?? ''
  keyForm.apiKey = ''; keyForm.createConnection=true; target.value = undefined; account.value = undefined
  manager.error = ''; operation.value = action
  if (action==='editKey' && item) {
    const request=++operationKeyRead;operationKeyLoading.value=true
    try {
      const value=await window.manager.readProviderKey({id:provider.id,revision:provider.revision,keyId:item.id})
      if (request===operationKeyRead && operation.value==='editKey' && owner.value?.id===provider.id && owner.value.revision===provider.revision && key.value?.id===item.id) {
        if (providers.value.find(value=>value.id===provider.id)?.revision!==provider.revision) { operationKeyError.value='供应商已变化，请重新打开编辑窗口。';return }
        keyForm.apiKey=value
      }
    } catch { if (request===operationKeyRead) operationKeyError.value='无法读取密钥，请重新打开编辑窗口。' }
    finally { if (request===operationKeyRead) operationKeyLoading.value=false }
  }
}
function closeOperation() { operationKeyRead++; operation.value = undefined; keyForm.apiKey = ''; operationKeyLoading.value=false;operationKeyError.value='' }
function selectTarget(id:string) { const value=providers.value.find(p=>p.id===id); target.value=value ? clone(value) : undefined }
function selectAccount(id:string) { const value=manager.data?.accounts.find(a=>a.id===id); account.value=value ? clone(value) : undefined }
async function saveOperation() {
  if (operationKeyLoading.value || operationKeyError.value) return
  const provider = owner.value!, action = operation.value!
  const identity = {id:provider.id,revision:provider.revision}, keyId = key.value?.id ?? ''
  let input:ProviderMutation
  if (action === 'addKey') input = {action,...identity,name:keyForm.name,apiKey:keyForm.apiKey,createConnection:keyForm.createConnection}
  else if (action === 'editKey') {
    if (!keyForm.apiKey.trim()) { message.info('密钥不能为空；如需删除请使用移除操作'); return }
    input = {action,...identity,keyId,name:keyForm.name,apiKey:keyForm.apiKey}
  }
  else if (action === 'moveKey') {
    if (!target.value) { message.info('请选择目标供应商'); return }
    input = {action,...identity,keyId,targetId:target.value.id,targetRevision:target.value.revision}
  } else if (action === 'createAccount') input = {action,...identity,keyId,name:keyForm.name}
  else {
    if (!account.value) { message.info('请选择 API 连接'); return }
    input = {action,...identity,keyId,accountId:account.value.id,accountRevision:account.value.revision ?? 0}
  }
  if (await mutate(input)) { closeOperation(); message.success({key:'provider-operation',content:'已保存'}) }
}
function remove(provider:ProviderSummary, item?:ProviderKeySummary) {
  const snapshot = clone(provider), keyId = item?.id
  Modal.confirm({title:keyId ? '移除此密钥？' : `删除供应商「${snapshot.name}」？`,
    content:'已有 API 连接会保留当前配置和服务等级，并解除关联。移除的密钥不会被连接同步重新加入。',
    okText:'删除',okType:'danger',cancelText:'取消',
    async onOk() {
      if (!await mutate(keyId ? {action:'removeKey',id:snapshot.id,revision:snapshot.revision,keyId}
        : {action:'delete',id:snapshot.id,revision:snapshot.revision})) {
        message.error({key:'provider-operation',content:manager.error}); throw new Error('保存失败')
      }
    }
  })
}
async function reconcile() { if (await mutate({action:'reconcile'})) message.success({key:'provider-operation',content:'已从 API 连接同步密钥，保留供应商配置和已移除项'}) }
const accountNames = (ids:string[]) => ids.map(id=>manager.data?.accounts.find(a=>a.id===id)?.name ?? id).join('、')
const connectionCount = (provider:ProviderSummary) => provider.keys.reduce((count,key)=>count+key.accountIds.length,0)
const keyMenuTarget=ref<{provider:ProviderSummary;key:ProviderKeySummary}>()
function captureKeyMenu(open:boolean,provider:ProviderSummary,item:ProviderKeySummary) {
  if(open)keyMenuTarget.value={provider:clone(provider),key:clone(item)}
}
function handleKeyMenu(action:string,providerId:string,keyId:string) {
  const target=keyMenuTarget.value
  if(!target || target.provider.id!==providerId || target.key.id!==keyId)return
  keyMenuTarget.value=undefined
  if(action==='test')openProbe(target.provider,target.key.id)
  else if(action==='move')void openOperation('moveKey',target.provider,target.key)
  else if(action==='link')void openOperation('linkAccount',target.provider,target.key)
  else if(action==='remove')remove(target.provider,target.key)
}
const probeOpen=ref(false),probeTarget=ref<{providerId:string;keyId:string}>()
function openProbe(provider?:ProviderSummary,keyId?:string) {probeTarget.value=provider && keyId ? {providerId:provider.id,keyId} : undefined;probeOpen.value=true}
async function cancelProbe() {if(manager.data?.providerProbe?.runId)await manager.execute(()=>window.manager.cancelProviderProbe(manager.data!.providerProbe!.runId!))}
const usageRefresh=computed(()=>manager.data?.providerUsageRefresh)
const usageTarget=ref<{providerId:string;keyId:string}>()
const usageDetail=computed(()=>{
  const provider=providers.value.find(p=>p.id===usageTarget.value?.providerId)
  const key=provider?.keys.find(k=>k.id===usageTarget.value?.keyId)
  return provider&&key?{provider,key}:undefined
})
async function refreshUsage(provider:ProviderSummary,keyIds=provider.keys.map(key=>key.id)) {
  await manager.execute(()=>window.manager.refreshProviderUsage({providerId:provider.id,revision:provider.revision,keyIds}))
}
async function cancelUsage(){if(usageRefresh.value?.runId)await manager.execute(()=>window.manager.cancelProviderUsage(usageRefresh.value!.runId!))}
function usageText(key:ProviderKeySummary):string {
  const summary=key.usage?.summary
  if(!summary)return key.usage?'当前额度未知':'尚未查询'
  if(summary.unlimited)return '不限额度'
  const value=summary.remaining??summary.balance
  return value===undefined?'当前额度未知':`${value.toLocaleString('zh-CN',{maximumFractionDigits:4})} ${summary.unit||'（单位未知）'}`
}
</script>

<template>
  <section class="provider-library">
    <a-alert v-if="usageRefresh?.running || usageRefresh?.error || usageRefresh?.cancelled" class="provider-usage-progress" :type="usageRefresh.error?'warning':'info'" :message="usageRefresh.error || (usageRefresh.running ? `正在查询额度：${usageRefresh.completed} / ${usageRefresh.total}` : `额度查询已取消，已完成 ${usageRefresh.completed} / ${usageRefresh.total}`)"><template v-if="usageRefresh.running" #action><a-button size="small" @click="cancelUsage">取消额度查询</a-button></template></a-alert>
    <div class="toolbar provider-library-toolbar">
      <a-input v-model:value="search" placeholder="搜索供应商或接口地址" allow-clear style="max-width: 360px" />
      <a-button @click="openProbe()">接口测试</a-button>
      <span class="toolbar-spacer" /><span class="muted">{{ providers.length }} 个供应商</span>
      <a-dropdown :trigger="['click']"><a-button aria-label="供应商更多操作">更多 <DownOutlined /></a-button><template #overlay><a-menu><a-menu-item key="reconcile" @click="reconcile">同步旧连接</a-menu-item></a-menu></template></a-dropdown>
      <a-button type="primary" @click="openEditor()"><PlusOutlined />添加供应商</a-button>
    </div>
    <a-alert v-if="manager.data?.providerProbe?.runId" type="info" class="error-banner" :message="`接口测试：${manager.data.providerProbe.completed} / ${manager.data.providerProbe.total}${manager.data.providerProbe.running ? '，进行中' : '，已结束'}`"><template #action><a-space><a-button size="small" @click="openProbe()">查看结果</a-button><a-button v-if="manager.data.providerProbe.running" size="small" :loading="manager.data.providerProbe.cancelling" @click="cancelProbe">取消测试</a-button></a-space></template></a-alert>
    <div v-if="!providers.length" class="empty-panel"><div class="empty-icon"><ApiOutlined /></div><h2>添加你的第一个供应商</h2><p>填写接口和密钥，获取模型后即可保存使用。<br>密钥加密保存在本机，编辑时可查看和修改。</p><a-button type="primary" @click="openEditor()">添加供应商</a-button></div>
    <a-empty v-else-if="!filtered.length" description="没有匹配的供应商" />
    <div v-else class="provider-grid"><button v-for="provider in visible" :key="provider.id" type="button" class="provider-card" :class="{active:provider.id===selectedId}" :aria-pressed="provider.id===selectedId" @click="selectedId=provider.id">
      <div class="provider-card-top"><span class="provider-icon"><ApiOutlined /></span><strong>{{ provider.name }}</strong><a-tag :color="provider.defaultTier==='fast' ? 'purple' : undefined">{{ tierLabel(provider.defaultTier) }}</a-tag></div>
      <p>{{ provider.baseUrl }}</p><div class="provider-card-bottom"><span><KeyOutlined /> {{ provider.keys.length }} 把密钥</span><span>{{ connectionCount(provider) }} 个 API 连接</span><span>{{ provider.models.length }} 个模型</span></div>
    </button></div>
    <a-pagination v-if="filtered.length>12" v-model:current="page" :total="filtered.length" :page-size="12" :show-size-changer="false" class="pagination" />
    <a-card v-if="selected" class="provider-detail" :title="selected.name">
      <template #extra><a-space><a-button @click="openEditor(selected)">编辑供应商</a-button><a-button danger @click="remove(selected)">删除</a-button></a-space></template>
      <div class="provider-detail-top"><div><strong>已保存的密钥</strong><p class="muted">启用 API 连接后，实例和本地 API 即可选用此密钥。</p></div><a-space><a-button :disabled="!selected.keys.length || usageRefresh?.running || manager.loading" @click="refreshUsage(selected)">刷新全部密钥额度</a-button><a-button type="primary" @click="openOperation('addKey',selected)"><PlusOutlined />添加密钥</a-button></a-space></div>
      <a-table :data-source="selected.keys" row-key="id" :pagination="{current:keyPage,pageSize:10,showSizeChanger:false,hideOnSinglePage:true,onChange:(value:number)=>keyPage=value}" :row-class-name="(record:ProviderKeySummary)=>record.id===focusedKeyId ? 'overview-focused-key' : ''" :columns="[{title:'名称',key:'name'},{title:'API 连接',key:'accounts'},{title:'额度',key:'usage',width:220},{title:'操作',key:'actions',width:230}]" :scroll="{x:800}" class="provider-key-table">
        <template #bodyCell="{column,record}">
          <template v-if="column.key==='name'"><strong>{{ record.name || '未命名密钥' }}</strong><small class="key-status">密钥已加密保存</small></template>
          <template v-else-if="column.key==='accounts'"><span class="account-names">{{ accountNames(record.accountIds) || '未启用' }}</span></template>
          <template v-else-if="column.key==='usage'"><div class="provider-key-usage"><strong>{{ usageText(record) }}</strong><small v-if="record.usage?.error" class="key-usage-error">{{ record.usage.unavailable?'接口不支持':record.usage.summary?'刷新失败 · 上次结果':'查询失败' }}</small><a-space :size="0"><a-button type="link" size="small" :loading="usageRefresh?.activeKeyIds.includes(record.id)" :disabled="usageRefresh?.running || manager.loading" @click="refreshUsage(selected,[record.id])">查询额度</a-button><a-button v-if="record.usage" type="link" size="small" @click="usageTarget={providerId:selected.id,keyId:record.id}">详情</a-button></a-space></div></template>
          <template v-else><a-space :size="0" class="provider-key-actions">
            <a-button type="link" size="small" @click="openOperation('editKey',selected,record)">编辑</a-button>
            <a-button v-if="!record.accountIds.length" type="link" size="small" @click="openOperation('createAccount',selected,record)">启用连接</a-button>
            <a-button v-else type="link" size="small" @click="emit('manage-connections',record.accountIds[0])">查看连接</a-button>
            <a-dropdown :key="`${selected.id}:${record.id}`" :trigger="['click']" @open-change="captureKeyMenu($event,selected,record)">
              <a-button type="link" size="small" :aria-label="`密钥更多操作 · ${record.name || '未命名密钥'}`">更多 <DownOutlined /></a-button>
              <template #overlay><a-menu @click="handleKeyMenu(String($event.key),selected.id,record.id)"><a-menu-item key="test">测试</a-menu-item><a-menu-item key="move">移动到其他供应商</a-menu-item><a-menu-item key="link">关联已有 API 连接</a-menu-item><a-menu-divider /><a-menu-item key="remove" danger>移除密钥</a-menu-item></a-menu></template>
            </a-dropdown>
          </a-space></template>
        </template>
      </a-table>
    </a-card>
    <a-modal :open="!!usageDetail" :title="`密钥额度 · ${usageDetail?.key.name || '未命名密钥'}`" :footer="null" @cancel="usageTarget=undefined"><template v-if="usageDetail"><p class="muted">{{ usageDetail.provider.name }} · {{ usageDetail.provider.baseUrl }}</p><ProviderUsageDetails :usage="usageDetail.key.usage" /><a-button :disabled="usageRefresh?.running || manager.loading" @click="refreshUsage(usageDetail.provider,[usageDetail.key.id])">刷新额度</a-button></template></a-modal>
    <a-drawer :open="editorOpen" :width="600" :title="editing ? '编辑供应商' : '添加供应商'" destroy-on-close @close="editorOpen=false">
      <a-form layout="vertical" class="provider-details-form" @finish="saveProvider">
        <a-collapse v-model:active-key="quickFillSections" ghost class="provider-quick-fill">
          <a-collapse-panel key="preset" header="快速填充（可选）">
            <a-form-item label="离线预设" extra="只填充地址和模型，可继续修改，不会联网或发送密钥。"><a-select v-model:value="details.presetId" allow-clear placeholder="选择供应商预设" :options="presetOptions" @change="applyPreset" /></a-form-item>
          </a-collapse-panel>
        </a-collapse>
        <a-form-item label="供应商名称" required><a-input v-model:value="details.name" aria-label="供应商名称" :maxlength="120" /></a-form-item>
        <a-form-item label="Base URL" required><a-input v-model:value="details.baseUrl" aria-label="供应商地址" /></a-form-item>
        <a-form-item v-if="editing?.keys.length && savedKeyAddress" label="选择密钥"><a-select :value="editorKeyId" allow-clear :options="editing.keys.map(item=>({label:item.name || '未命名密钥',value:item.id}))" placeholder="临时密钥（仅用于获取模型）" aria-label="编辑供应商密钥选择" @change="selectEditorKey($event as string | undefined)" /></a-form-item>
        <a-form-item label="API Key" :extra="!editing ? '密钥加密保存在本机；可留空，稍后添加。' : editorKeyId ? '修改后随供应商保存，并同步到关联 API 连接。' : savedKeyAddress ? '临时密钥仅用于获取模型，不会替换已保存密钥。' : '地址已更改，原密钥已清空。新密钥仅用于获取模型。'"><a-input v-model:value="draftKey" :disabled="editorKeyLoading || !!editorKeyError" aria-label="供应商初始密钥" autocomplete="off" :placeholder="editorKeyLoading ? '正在读取密钥…' : ''" /></a-form-item>
        <a-alert v-if="editorKeyError" type="error" :message="editorKeyError" />
        <a-form-item v-if="!editing && draftKey.trim()"><a-checkbox v-model:checked="createConnection">保存后用于 Codex 实例与本地 API</a-checkbox></a-form-item>
        <a-form-item label="模型列表" required><ProviderModelsField v-model="modelValues" :base-url="details.baseUrl" :api-key="draftKey" :active="editorOpen" :key-managed="true" :key-loading="editorKeyLoading || !!editorKeyError" :saved-key="editing && editorKeyId && savedKeyAddress && draftKey===loadedEditorKey ? {providerId:editing.id,revision:editing.revision,keyId:editorKeyId} : undefined" /></a-form-item>
        <a-form-item label="默认服务等级" extra="请求和 API 连接的明确设置优先；运行中的服务需重启后应用。"><a-select v-model:value="details.defaultTier" aria-label="供应商服务等级" :options="tierOptions" /></a-form-item>
        <a-collapse v-model:active-key="editorSections" ghost :destroy-inactive-panel="false" class="provider-advanced-settings">
          <a-collapse-panel key="context" :header="`模型上下文窗口${Object.keys(details.modelContextWindows ?? {}).length ? ` · ${Object.keys(details.modelContextWindows ?? {}).length} 个自定义` : ' · 使用默认值'}`">
            <ModelContextWindowsField v-model="details.modelContextWindows" :models="modelValues" :active="editorOpen && editorSections.includes('context')" />
          </a-collapse-panel>
          <a-collapse-panel key="advanced" header="高级设置 · 协议、额度与模型能力">
            <a-form-item label="上游协议"><a-select v-model:value="details.wireApi" :options="[{label:'Responses',value:'responses'},{label:'Chat Completions',value:'chat_completions'}]" /></a-form-item>
            <a-form-item label="额度查询方式" extra="同步到关联 API 连接；更改后请重新刷新额度。官方服务商使用专用接口。"><a-select v-model:value="details.integrationType" aria-label="供应商额度查询方式" :options="integrationTypeOptions" /></a-form-item>
            <div class="provider-capability-grid">
              <a-form-item label="图片输入"><a-select v-model:value="details.supportsVision" allow-clear placeholder="未声明" :options="[{label:'支持图片',value:true},{label:'仅文本',value:false}]" /></a-form-item>
              <a-form-item label="WebSocket"><a-select v-model:value="details.supportsWebsockets" allow-clear placeholder="未声明" :options="[{label:'支持',value:true},{label:'不支持',value:false}]" /></a-form-item>
              <a-form-item label="图片路由模型"><a-input v-model:value="details.visionRoutingModel" placeholder="留空表示使用请求模型" :maxlength="200" /></a-form-item>
              <a-form-item label="模式偏好"><a-select v-model:value="details.enableModePreference" allow-clear placeholder="自动" :options="[{label:'自动',value:'auto'},{label:'直连',value:'direct'},{label:'网关',value:'gateway'}]" /></a-form-item>
            </div>
          </a-collapse-panel>
        </a-collapse>
        <a-alert v-if="editing" type="info" show-icon message="修改会同步到关联 API 连接，无需重复配置。" />
        <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
      </a-form>
      <template #footer><a-space><a-button @click="editorOpen=false">取消</a-button><a-button type="primary" :loading="manager.loading" :disabled="!details.name.trim() || !modelValues.length || modelValues.length>500 || editorKeyLoading || !!editorKeyError" @click="saveProvider">保存供应商</a-button></a-space></template>
    </a-drawer>
    <a-modal :open="!!operation" :title="operation ? operationTitle[operation] : ''" ok-text="保存" cancel-text="取消" :confirm-loading="manager.loading" destroy-on-close @cancel="closeOperation" @ok="saveOperation">
      <a-form layout="vertical" class="provider-key-form">
        <p class="muted">{{ owner?.name }} · {{ owner?.baseUrl }}</p>
        <a-form-item v-if="['addKey','editKey','createAccount'].includes(operation ?? '')" :label="operation==='createAccount' ? 'API 连接名称' : '密钥名称'"><a-input v-model:value="keyForm.name" aria-label="密钥或账号名称" :maxlength="120" /></a-form-item>
        <a-form-item v-if="operation==='addKey' || operation==='editKey'" label="API Key" :extra="operation==='editKey' ? '显示已保存密钥的实际内容；修改会同步到关联连接，取消不会保存。' : undefined"><a-input v-model:value="keyForm.apiKey" :disabled="operationKeyLoading || !!operationKeyError" aria-label="供应商密钥" autocomplete="off" :placeholder="operationKeyLoading ? '正在读取密钥…' : ''" /></a-form-item>
        <a-alert v-if="operationKeyError" type="error" :message="operationKeyError" />
        <a-form-item v-if="operation==='addKey'"><a-checkbox v-model:checked="keyForm.createConnection">同时启用 API 连接</a-checkbox></a-form-item>
        <template v-if="operation==='moveKey'"><a-form-item label="目标供应商"><a-select :value="target?.id" placeholder="选择目标供应商" :options="providers.filter(p=>p.id!==owner?.id).map(p=>({label:p.name,value:p.id}))" @change="selectTarget" /></a-form-item><p>原 API 连接保留接口和密钥并解除关联，移动不会改变请求地址。</p></template>
        <template v-if="operation==='linkAccount'"><a-form-item label="关联 API 连接"><a-select :value="account?.id" placeholder="选择 API 连接" :options="(manager.data?.accounts ?? []).filter(a=>a.kind==='api_key').map(a=>({label:a.name,value:a.id}))" @change="selectAccount" /></a-form-item><p>该连接将使用此供应商的地址、协议、模型和所选密钥，保留独立服务等级。</p></template>
        <p v-if="operation==='createAccount'">API 连接继承供应商默认服务等级，可在「API 连接」页单独调整。</p>
        <a-alert v-if="manager.error" type="error" :message="manager.error" />
      </a-form>
    </a-modal>
    <ProviderProbePanel v-model:open="probeOpen" :initial="probeTarget" />
  </section>
</template>

<style scoped>
.provider-usage-progress{margin-bottom:16px}.provider-key-usage strong,.key-usage-error{display:block;overflow-wrap:anywhere}.key-usage-error{font-size:11px;color:#d95055;margin-top:4px}.provider-key-usage .ant-btn{padding-inline:0;margin-right:12px}
.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.provider-card{text-align:left;border:1px solid var(--border);border-radius:14px;background:var(--surface);color:inherit;padding:20px;cursor:pointer;font:inherit;transition:border-color .15s,box-shadow .15s}.provider-card:hover,.provider-card.active{border-color:#9b70ef}.provider-card.active{box-shadow:0 0 0 2px #7c3aed18}.provider-card-top{display:flex;align-items:center;gap:10px}.provider-card-top strong{flex:1;overflow-wrap:anywhere}.provider-icon{color:#7c3aed;font-size:22px}.provider-card p{margin:12px 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.provider-card-bottom{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:12px}.provider-detail{margin-top:24px}.provider-detail-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.provider-detail-top p{margin:6px 0 0;font-size:12px}.key-status{display:block;color:var(--muted);margin-top:5px;font-size:11px}.account-names{overflow-wrap:anywhere}.provider-details-form .ant-alert{margin-top:16px}.provider-capability-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px}.provider-key-form{padding-top:8px}.provider-key-form p{line-height:1.7}
.provider-key-actions{white-space:nowrap}.provider-key-actions .ant-btn{padding-inline:6px}.provider-library-toolbar{flex-wrap:wrap}.provider-quick-fill{margin:-4px 0 14px;border:1px solid var(--border);border-radius:10px}.provider-advanced-settings{border-top:1px solid var(--border);margin-top:6px}.provider-details-form :deep(.ant-collapse-header){font-weight:500}.provider-details-form :deep(.ant-collapse-content-box){padding-top:4px;padding-bottom:14px}.provider-quick-fill .ant-form-item{margin-bottom:0}.provider-advanced-settings :deep(.ant-collapse-item + .ant-collapse-item){border-top:1px solid var(--border)}
@media(max-width:1080px){.provider-grid{grid-template-columns:1fr}.provider-detail-top{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){.provider-card{transition:none}}
</style>

<style scoped>
.provider-key-table :deep(.overview-focused-key > td){background:var(--subtle);box-shadow:inset 0 2px #7c3aed33,inset 0 -2px #7c3aed33}
</style>
