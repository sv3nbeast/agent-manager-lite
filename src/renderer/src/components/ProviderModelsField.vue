<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ProviderSummary } from '../../../shared/providerLibrary'
import type { ProbeModel } from '../../../shared/providerProbe'

const props=defineProps<{modelValue:string[];baseUrl:string;apiKey?:string;provider?:ProviderSummary;active:boolean;keyManaged?:boolean;keyLoading?:boolean;savedKey?:{providerId:string;revision:number;keyId:string}}>()
const emit=defineEmits<{'update:modelValue':[models:string[]]}>()
const fetched=ref<ProbeModel[]>([]), selectedKey=ref<string>(), busy=ref(false), error=ref(''), status=ref('')
const selectedModels=ref<string[]>([])
let requestId:string|undefined
let cancellation:Promise<void>|undefined
const options=computed(()=>fetched.value.map(model=>({label:model.name ? `${model.id} · ${model.name}` : model.id,value:model.id})))
const target=computed(()=>JSON.stringify([props.active,props.baseUrl,props.apiKey,props.provider?.id,props.provider?.revision,selectedKey.value,props.savedKey]))
watch(()=>props.provider?.id,()=>{selectedKey.value=props.provider?.keys[0]?.id},{immediate:true})
async function cancel() {
  const id=requestId;requestId=undefined
  if(id){
    status.value='正在取消获取…'
    const task=window.manager.cancelProviderModels(id).catch(()=>{})
    cancellation=task
    await task
    if(cancellation===task)cancellation=undefined
  } else if(cancellation) await cancellation
  if(!requestId && !cancellation){busy.value=false;status.value='已取消获取'}
}
watch(target,()=>{void cancel();fetched.value=[];selectedModels.value=[];status.value='';error.value=''},{flush:'sync'})
onBeforeUnmount(()=>{void cancel()})
async function fetchModels() {
  if(busy.value || props.keyLoading)return
  const id=crypto.randomUUID();requestId=id;busy.value=true;error.value='';status.value=''
  try {
    const provider=props.provider,apiKey=props.apiKey?.trim()
    const result=await window.manager.fetchProviderModels({requestId:id,baseUrl:props.baseUrl.trim(),
      ...(props.savedKey ? {savedKey:props.savedKey} : apiKey ? {apiKey} : !props.keyManaged && provider && selectedKey.value ? {savedKey:{providerId:provider.id,revision:provider.revision,keyId:selectedKey.value}} : {})})
    if(requestId!==id)return
    fetched.value=result.models;selectedModels.value=[]
    status.value=result.models.length ? `已获取 ${result.models.length} 个模型${result.modelsTruncated ? '（目录较大，仅显示前 1000 个）' : ''}，选择后加入下方列表。` : '接口返回空模型列表，可手动填写模型 ID。'
  }catch(e){if(requestId===id)error.value=e instanceof Error?e.message:'获取失败，请重试'}
  finally{if(requestId===id){requestId=undefined;busy.value=false}}
}
function addModels(all=false) {
  const next=[...new Set([...props.modelValue,...(all?fetched.value.map(m=>m.id):selectedModels.value)])]
  if(next.length>500){error.value='最多保存 500 个模型，请缩小选择范围';return}
  emit('update:modelValue',next);selectedModels.value=[];error.value=''
}
</script>

<template>
  <section class="model-discovery">
    <div class="model-discovery-actions">
      <a-select v-if="!keyManaged && provider?.keys.length && !apiKey?.trim()" v-model:value="selectedKey" :options="provider.keys.map(k=>({label:k.name||'已保存密钥',value:k.id}))" placeholder="选择获取模型的密钥" aria-label="获取模型的密钥" style="flex:1;min-width:150px" />
      <a-button v-if="!busy" :disabled="!baseUrl.trim() || keyLoading" @click="fetchModels">从 API 获取模型</a-button>
      <a-button v-else @click="cancel">取消获取</a-button>
    </div>
    <p class="muted">{{ busy ? '正在读取模型目录…' : '读取此地址的 /models，不发送对话请求。' }}</p>
    <a-alert v-if="error" type="error" show-icon :message="error" />
    <a-alert v-if="status" type="info" :message="status" />
    <div v-if="fetched.length" class="discovered-models">
      <a-select v-model:value="selectedModels" mode="multiple" show-search option-filter-prop="label" :options="options" :max-tag-count="3" placeholder="搜索并选择模型" aria-label="API 返回的模型" style="width:100%" />
      <a-space><a-button size="small" :disabled="!selectedModels.length" @click="addModels()">加入所选</a-button><a-button size="small" :disabled="fetched.length>500" @click="addModels(true)">全部加入</a-button></a-space>
    </div>
    <a-select :value="modelValue" mode="tags" :token-separators="[',','\n']" :max-tag-count="5" :options="modelValue.map(id=>({label:id,value:id}))" placeholder="选择模型，或输入模型 ID 后回车" aria-label="供应商模型" style="width:100%" @change="emit('update:modelValue',[...new Set(($event as string[]).map(v=>v.trim()).filter(Boolean))])" />
    <small class="muted">已选 {{ modelValue.length }} / 500 · 支持手动补充；获取结果不会覆盖已选模型。</small>
  </section>
</template>

<style scoped>
.model-discovery{display:grid;gap:12px}.model-discovery-actions{display:flex;gap:8px;align-items:center}.model-discovery p{margin:0;font-size:12px}.discovered-models{display:grid;gap:8px;padding:12px;background:#7c3aed08;border-radius:10px}.model-discovery small{font-size:11px}
</style>
