<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getAgentClient, type AgentClientType } from '../../../shared/agentClients'
import { providerDetailsSchema } from '../../../shared/providerLibrary'
import { accountInputSchema } from '../../../shared/types'
import { useManager } from '../store'
import ProviderModelsField from './ProviderModelsField.vue'
import ModelContextWindowsField from './ModelContextWindowsField.vue'
import FormFeedback from './FormFeedback.vue'
import LoginCredentialsPanel from './LoginCredentialsPanel.vue'
import { focusFirstInvalidField, useFormFeedback, validationErrors } from '../formFeedback'

const open = defineModel<boolean>('open', { required:true })
const props = defineProps<{clientType:AgentClientType}>()
const emit = defineEmits<{created:[accountId:string]}>()
const manager=useManager(),client=computed(()=>getAgentClient(props.clientType))
const isClaude=computed(()=>props.clientType==='claude_code')
const name=ref(''),baseUrl=ref(''),apiKey=ref(''),models=ref<string[]>([])
const wireApi=ref<'responses'|'chat_completions'>('responses'),contexts=ref<Record<string,number>>()
const advanced=ref<string[]>([]),saving=ref(false),error=ref('')
const fieldErrors=ref<Record<string,string>>({})
useFormFeedback(error,{active:open})
watch(()=>[open.value,name.value,baseUrl.value,apiKey.value,JSON.stringify(models.value),JSON.stringify(contexts.value)],()=>{error.value='';fieldErrors.value={}},{flush:'sync'})
watch(open,value=>{
  if(value){name.value='';baseUrl.value='https://api.openai.com/v1';apiKey.value='';models.value=[];wireApi.value='responses';contexts.value=undefined;advanced.value=[];error.value=''}
  else apiKey.value=''
})
async function save(){
  if(isClaude.value||saving.value||manager.loading)return
  error.value=''
  const validation=providerDetailsSchema.safeParse({name:name.value,baseUrl:baseUrl.value,models:models.value,wireApi:wireApi.value,defaultTier:'inherit',...(contexts.value?{modelContextWindows:contexts.value}:{})})
  const keyValidation=accountInputSchema.shape.apiKey.safeParse(apiKey.value)
  const issues=[...(validation.success?[]:validation.error.issues),...(keyValidation.success?[]:keyValidation.error.issues.map(issue=>({...issue,path:['apiKey']})))]
  if(issues.length){
    fieldErrors.value=validationErrors(issues,{name:'供应商名称',baseUrl:'API 地址',apiKey:'API Key',models:'模型',modelContextWindows:'模型上下文'})
    error.value=Object.values(fieldErrors.value)[0]||'请检查供应商配置';void focusFirstInvalidField('.instance-provider-dialog');return
  }
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
function claudeImported(accountIds:string[]){
  const accountId=accountIds.find(id=>manager.data?.accounts.some(account=>account.id===id&&account.identityService==='anthropic'&&account.kind==='api_key'))
  if(!accountId){error.value='连接已保存，请返回实例选择已有连接。';return}
  emit('created',accountId);open.value=false
}
</script>

<template>
  <a-modal :open="open" :title="isClaude?'添加 Claude API 连接':'添加供应商'" :footer="isClaude?null:undefined" :width="680" :closable="!saving" :mask-closable="!saving" :keyboard="!saving" ok-text="添加并使用" cancel-text="取消" :confirm-loading="saving" :ok-button-props="{disabled:saving||manager.loading}" :body-style="{maxHeight:'70vh',overflowY:'auto'}" @ok="save" @cancel="cancel">
    <LoginCredentialsPanel v-if="isClaude" mode="api" client-type="claude_code" :active="open" @busy="saving=$event" @imported="claudeImported" />
    <a-alert v-if="isClaude&&error" type="error" :message="error" />
    <a-form v-if="!isClaude" layout="vertical" class="instance-provider-dialog">
      <p class="muted">为 {{client.name}} 添加连接。密钥保存一次，可供兼容实例复用。</p>
      <a-form-item label="供应商名称" required :validate-status="fieldErrors.name ? 'error' : undefined" :help="fieldErrors.name"><a-input v-model:value="name" aria-label="供应商名称" :maxlength="120" /></a-form-item>
      <a-form-item label="API 地址" required :validate-status="fieldErrors.baseUrl ? 'error' : undefined" :help="fieldErrors.baseUrl"><a-input v-model:value="baseUrl" aria-label="供应商地址" placeholder="https://example.com/v1" /></a-form-item>
      <a-form-item label="API Key" required :validate-status="fieldErrors.apiKey ? 'error' : undefined" :help="fieldErrors.apiKey"><a-input v-model:value="apiKey" aria-label="供应商密钥" autocomplete="off" spellcheck="false" /></a-form-item>
      <a-form-item v-if="client.capabilities.models" label="模型" required :validate-status="fieldErrors.models ? 'error' : undefined" :help="fieldErrors.models"><ProviderModelsField v-model="models" :base-url="baseUrl" :api-key="apiKey" :active="open" /></a-form-item>
      <a-collapse v-model:active-key="advanced" ghost><a-collapse-panel key="advanced" header="高级设置">
        <a-form-item label="接口协议"><a-select v-model:value="wireApi" aria-label="供应商协议" :options="[{value:'responses',label:'Responses'},{value:'chat_completions',label:'Chat Completions'}]" /></a-form-item>
        <a-form-item v-if="client.capabilities.contextWindow" label="模型上下文"><ModelContextWindowsField v-model="contexts" :models="models" :active="open" /></a-form-item>
      </a-collapse-panel></a-collapse>
    </a-form>
    <template v-if="!isClaude" #footer><FormFeedback :error="error||manager.error" /><a-space><a-button :disabled="saving" @click="cancel">取消</a-button><a-button type="primary" :loading="saving" :disabled="saving||manager.loading" @click="save">添加并使用</a-button></a-space></template>
  </a-modal>
</template>
