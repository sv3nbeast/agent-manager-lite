<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getAgentClient, type AgentClientType } from '../../../shared/agentClients'
import { providerDetailsSchema, providerKeySettingsSchema, providerEndpoint } from '../../../shared/providerLibrary'
import { accountInputSchema, type AccountProtocol } from '../../../shared/types'
import { useManager } from '../store'
import ProviderModelsField from './ProviderModelsField.vue'
import ModelContextWindowsField from './ModelContextWindowsField.vue'
import FormFeedback from './FormFeedback.vue'
import { focusFirstInvalidField, useFormFeedback, validationErrors } from '../formFeedback'

const open = defineModel<boolean>('open', { required:true })
const props = defineProps<{clientType:AgentClientType}>()
const emit = defineEmits<{created:[accountId:string]}>()
const manager=useManager(),client=computed(()=>getAgentClient(props.clientType))
const isClaude=computed(()=>props.clientType==='claude_code')
const name=ref(''),baseUrl=ref(''),apiKey=ref(''),models=ref<string[]>([])
const protocol=ref<AccountProtocol>('openai_responses'),credentialKind=ref<'openai_api_key'|'anthropic_api_key'|'anthropic_bearer'>('openai_api_key')
const contexts=ref<Record<string,number>>(),advanced=ref<string[]>([]),saving=ref(false),error=ref('')
const fieldErrors=ref<Record<string,string>>({})
const protocolOptions=computed(()=>isClaude.value?[{label:'Anthropic Messages',value:'anthropic_messages'}]:[{label:'OpenAI Responses',value:'openai_responses'},{label:'OpenAI Chat Completions',value:'openai_chat_completions'}])
const existingProvider=computed(()=>{
  try{return manager.data?.providers?.find(provider=>providerEndpoint(provider.baseUrl)===providerEndpoint(baseUrl.value))}catch{return undefined}
})
useFormFeedback(error,{active:open})
watch(()=>[open.value,name.value,baseUrl.value,apiKey.value,JSON.stringify(models.value),JSON.stringify(contexts.value)],()=>{error.value='';fieldErrors.value={}},{flush:'sync'})
watch(open,value=>{
  if(value){name.value='';baseUrl.value=isClaude.value?'https://api.anthropic.com':'https://api.openai.com/v1';apiKey.value='';models.value=[];protocol.value=isClaude.value?'anthropic_messages':'openai_responses';credentialKind.value=isClaude.value?'anthropic_api_key':'openai_api_key';contexts.value=undefined;advanced.value=[];error.value=''}
  else apiKey.value=''
})
async function save(){
  if(saving.value||manager.loading)return
  error.value=''
  const keySettings={models:[...models.value],protocol:protocol.value,credentialKind:credentialKind.value}
  const values={name:name.value,baseUrl:baseUrl.value,models:[],wireApi:'responses',defaultTier:'inherit',...(!existingProvider.value&&contexts.value?{modelContextWindows:{...contexts.value}}:{})}
  const validation=providerDetailsSchema.safeParse(values),keyValidation=accountInputSchema.shape.apiKey.safeParse(apiKey.value)
  const settingsValidation=providerKeySettingsSchema.safeParse(keySettings)
  const issues=[...(validation.success?[]:validation.error.issues),...(keyValidation.success?[]:keyValidation.error.issues.map(issue=>({...issue,path:['apiKey']}))),...(settingsValidation.success?[]:settingsValidation.error.issues)]
  if(issues.length||!models.value.length){
    fieldErrors.value=validationErrors(issues,{name:'名称',baseUrl:'API 地址',apiKey:'API Key',models:'密钥模型',modelContextWindows:'模型上下文'})
    if(!models.value.length)fieldErrors.value.models='请先为此密钥添加至少一个模型'
    error.value=Object.values(fieldErrors.value)[0]||'请检查供应商配置';void focusFirstInvalidField('.instance-provider-dialog');return
  }
  saving.value=true
  const previous=new Set((manager.data?.accounts??[]).map(account=>account.id))
  try{
    const details=providerDetailsSchema.parse(values),provider=existingProvider.value
    const ok=await manager.execute(()=>window.manager.mutateProvider(provider?
      {action:'addKey',id:provider.id,revision:provider.revision,name:name.value.trim(),apiKey:apiKey.value.trim(),createConnection:true,...keySettings}:
      {action:'create',details,initialKey:{name:'默认密钥',apiKey:apiKey.value.trim(),createConnection:true,...keySettings}}))
    if(!ok){error.value=manager.error;return}
    const saved=manager.data?.providers?.find(item=>providerEndpoint(item.baseUrl)===providerEndpoint(details.baseUrl))
    const account=manager.data?.accounts.find(account=>!previous.has(account.id)&&account.providerId===saved?.id)
    if(!account){error.value='供应商已保存，请返回实例选择已有密钥。';return}
    emit('created',account.id);open.value=false
  }catch(cause){error.value=cause instanceof Error?cause.message:'添加失败，请检查配置。'}finally{saving.value=false}
}
function cancel(){if(!saving.value)open.value=false}
</script>

<template>
  <a-modal :open="open" title="添加供应商密钥" :width="680" :closable="!saving" :mask-closable="!saving" :keyboard="!saving" ok-text="添加并使用" cancel-text="取消" :confirm-loading="saving" :ok-button-props="{disabled:saving||manager.loading}" :body-style="{maxHeight:'70vh',overflowY:'auto'}" @ok="save" @cancel="cancel">
    <a-form layout="vertical" class="instance-provider-dialog">
      <p class="muted">为 {{client.name}} 添加连接。每把密钥分别配置模型和协议，可供兼容实例复用。</p>
      <a-form-item :label="existingProvider?'密钥名称':'供应商名称'" required :validate-status="fieldErrors.name ? 'error' : undefined" :help="fieldErrors.name"><a-input v-model:value="name" aria-label="供应商名称" :maxlength="120" /></a-form-item>
      <a-form-item label="API 地址" required :validate-status="fieldErrors.baseUrl ? 'error' : undefined" :help="fieldErrors.baseUrl"><a-input v-model:value="baseUrl" aria-label="供应商地址" placeholder="https://example.com/v1" /></a-form-item>
      <p v-if="existingProvider" class="muted">此地址已属于 {{existingProvider.name}}，新密钥将加入该供应商。</p>
      <a-form-item label="API 协议"><a-select v-model:value="protocol" :options="protocolOptions" aria-label="密钥协议" /></a-form-item>
      <a-form-item v-if="isClaude" label="认证方式"><a-select v-model:value="credentialKind" :options="[{label:'API Key',value:'anthropic_api_key'},{label:'Bearer Token',value:'anthropic_bearer'}]" aria-label="密钥认证方式" /></a-form-item>
      <a-form-item label="API Key / Token" required :validate-status="fieldErrors.apiKey ? 'error' : undefined" :help="fieldErrors.apiKey"><a-input v-model:value="apiKey" aria-label="供应商密钥" autocomplete="off" spellcheck="false" /></a-form-item>
      <a-form-item label="密钥模型" required :validate-status="fieldErrors.models ? 'error' : undefined" :help="fieldErrors.models"><ProviderModelsField v-model="models" :base-url="baseUrl" :api-key="apiKey" :protocol="protocol" :credential-kind="credentialKind" :active="open" /></a-form-item>
      <a-collapse v-if="client.capabilities.contextWindow&&!existingProvider" v-model:active-key="advanced" ghost><a-collapse-panel key="advanced" header="高级设置">
        <ModelContextWindowsField v-model="contexts" :models="models" :active="open" />
      </a-collapse-panel></a-collapse>
      <FormFeedback :error="error" />
    </a-form>
  </a-modal>
</template>
