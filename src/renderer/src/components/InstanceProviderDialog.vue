<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getAgentClient, type AgentClientType } from '../../../shared/agentClients'
import { providerDetailsSchema } from '../../../shared/providerLibrary'
import { useManager } from '../store'
import ProviderModelsField from './ProviderModelsField.vue'
import ModelContextWindowsField from './ModelContextWindowsField.vue'

const open = defineModel<boolean>('open', { required:true })
const props = defineProps<{clientType:AgentClientType}>()
const emit = defineEmits<{created:[accountId:string]}>()
const manager=useManager(),client=computed(()=>getAgentClient(props.clientType))
const name=ref(''),baseUrl=ref(''),apiKey=ref(''),models=ref<string[]>([])
const wireApi=ref<'responses'|'chat_completions'>('responses'),contexts=ref<Record<string,number>>()
const advanced=ref<string[]>([]),saving=ref(false),error=ref('')
watch(open,value=>{
  if(value){name.value='';baseUrl.value='https://api.openai.com/v1';apiKey.value='';models.value=[];wireApi.value='responses';contexts.value=undefined;advanced.value=[];error.value=''}
  else apiKey.value=''
})
const valid=computed(()=>!!apiKey.value.trim()&&providerDetailsSchema.safeParse({name:name.value,baseUrl:baseUrl.value,models:models.value,wireApi:wireApi.value,defaultTier:'inherit',modelContextWindows:contexts.value}).success)
async function save(){
  if(saving.value||!valid.value)return
  saving.value=true;error.value=''
  const previous=new Set((manager.data?.providers??[]).map(provider=>provider.id))
  try{
    const details=providerDetailsSchema.parse({name:name.value,baseUrl:baseUrl.value,models:[...models.value],wireApi:wireApi.value,defaultTier:'inherit',...(contexts.value?{modelContextWindows:{...contexts.value}}:{})})
    if(!await manager.execute(()=>window.manager.mutateProvider({action:'create',details,initialKey:{name:'默认密钥',apiKey:apiKey.value.trim(),createConnection:true}})))return
    const provider=manager.data?.providers?.find(provider=>!previous.has(provider.id)&&provider.name===details.name&&provider.baseUrl===details.baseUrl)
    const accountId=provider?.keys[0]?.accountIds[0]
    if(!accountId){error.value='供应商已保存，请刷新资源后选择密钥。';return}
    emit('created',accountId);open.value=false
  }catch(cause){error.value=cause instanceof Error?cause.message:'添加失败，请检查配置。'}finally{saving.value=false}
}
function cancel(){if(!saving.value)open.value=false}
</script>

<template>
  <a-modal :open="open" title="添加供应商" :width="680" :closable="!saving" :mask-closable="!saving" :keyboard="!saving" ok-text="添加并使用" cancel-text="取消" :confirm-loading="saving" :ok-button-props="{disabled:!valid}" :body-style="{maxHeight:'70vh',overflowY:'auto'}" @ok="save" @cancel="cancel">
    <a-form layout="vertical" class="instance-provider-dialog">
      <p class="muted">为 {{client.name}} 添加连接。密钥保存一次，可供兼容实例复用。</p>
      <a-form-item label="供应商名称"><a-input v-model:value="name" aria-label="供应商名称" :maxlength="120" /></a-form-item>
      <a-form-item label="API 地址"><a-input v-model:value="baseUrl" aria-label="供应商地址" placeholder="https://example.com/v1" /></a-form-item>
      <a-form-item label="API Key"><a-input v-model:value="apiKey" aria-label="供应商密钥" autocomplete="off" spellcheck="false" /></a-form-item>
      <a-form-item v-if="client.capabilities.models" label="模型"><ProviderModelsField v-model="models" :base-url="baseUrl" :api-key="apiKey" :active="open" /></a-form-item>
      <a-collapse v-model:active-key="advanced" ghost><a-collapse-panel key="advanced" header="高级设置">
        <a-form-item label="接口协议"><a-select v-model:value="wireApi" aria-label="供应商协议" :options="[{value:'responses',label:'Responses'},{value:'chat_completions',label:'Chat Completions'}]" /></a-form-item>
        <a-form-item v-if="client.capabilities.contextWindow" label="模型上下文"><ModelContextWindowsField v-model="contexts" :models="models" :active="open" /></a-form-item>
      </a-collapse-panel></a-collapse>
      <a-alert v-if="error||manager.error" type="error" :message="error||manager.error" class="error-banner" />
    </a-form>
  </a-modal>
</template>
