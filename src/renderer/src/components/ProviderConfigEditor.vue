<script setup lang="ts">
import {onUnmounted,reactive,ref,watch} from 'vue'
import {message} from 'ant-design-vue'
import {providerIdSchema,providerChangeLabel,type ProviderConfigView,type ProviderConfigEntry,type ProviderChanges,type ProviderConfigInput} from '../../../shared/providerConfig'
import type {ClientConfigPreview} from '../../../shared/clientConfig'

const props=defineProps<{targetId:string;configRevision:string}>()
const emit=defineEmits<{'saved':[]}>()
const view=ref<ProviderConfigView>(),busy=ref(false),error=ref(''),open=ref(false),preview=ref<ClientConfigPreview>(),creating=ref(false)
const expanded=ref<string[]>([])
const defaults=()=>({name:'',base_url:'',wire_api:'responses',supports_websockets:null as boolean|null,supports_standalone_web_search:null as boolean|null,
  request_max_retries:null as number|null,stream_max_retries:null as number|null,stream_idle_timeout_ms:null as number|null})
const form=reactive({...defaults(),providerId:'',authMode:'keep',envKey:'',token:'',accountId:undefined as string|undefined,makeDefault:false,serviceTier:'keep'})
let initial=defaults(),generation=0
const reserved=(id:string)=>['openai','ollama','lmstudio','amazon-bedrock'].includes(id.toLowerCase())||!providerIdSchema.safeParse(id).success
const authLabels:Record<string,string>={none:'无需鉴权',environment:'环境变量',token:'Bearer 密钥',openai:'OpenAI 登录态',custom:'自定义鉴权'}
async function run(action:()=>Promise<void>) {if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(cause){error.value=String(cause)}finally{busy.value=false}}
async function load(){const current=++generation;busy.value=true;error.value='';try{const result=await window.manager.readClientProviders(props.targetId);if(current===generation)view.value=result}catch(cause){if(current===generation)error.value=String(cause)}finally{if(current===generation)busy.value=false}}
watch(()=>props.configRevision,()=>{if(open.value||preview.value)error.value='配置已发生变化，草稿已保留；请关闭编辑并重新读取，再预览改动';else void load()},{immediate:true})
onUnmounted(()=>{generation++;form.token='';form.envKey=''})
function edit(provider?:ProviderConfigEntry){
  creating.value=!provider;initial={...defaults(),...provider?.values,wire_api:provider?.wireApi??'responses'};Object.assign(form,initial,{providerId:provider?.id??'',authMode:'keep',envKey:provider?.envKey??'',token:'',accountId:undefined,makeDefault:!provider,serviceTier:'keep'})
  open.value=true;error.value=''
}
function useAccount(id:string){const account=view.value?.accounts.find(account=>account.id===id);if(account){form.base_url=account.baseUrl;form.wire_api='responses';if(!form.name)form.name=account.name}}
async function stage(){await run(async()=>{
  if(!view.value)return
  const changes:ProviderChanges={}
  for(const key of Object.keys(initial) as (keyof ProviderChanges)[]) {
    const value=form[key as keyof typeof initial]??null
    if(creating.value || value!==initial[key as keyof typeof initial])Object.assign(changes,{[key]:value})
  }
  const auth:ProviderConfigInput['auth']=form.authMode==='account'?{mode:'account',accountId:form.accountId??''}
    :form.authMode==='token'?{mode:'token',token:form.token}:form.authMode==='environment'?{mode:'environment',envKey:form.envKey}
    :{mode:form.authMode as 'keep'|'none'|'openai'}
  preview.value=await window.manager.previewClientProvider({id:props.targetId,revision:view.value.revision,providerId:form.providerId,create:creating.value,changes,auth,makeDefault:form.makeDefault,
    ...(form.makeDefault&&form.serviceTier!=='keep'?{serviceTier:form.serviceTier==='clear'?null:form.serviceTier as 'fast'|'default'|'auto'|'flex'}:{})})
  open.value=false
})}
async function apply(){await run(async()=>{
  if(!preview.value)return
  await window.manager.applyClientConfig(preview.value.ticket);preview.value=undefined;form.token=''
  view.value=await window.manager.readClientProviders(props.targetId)
  emit('saved');message.success('Provider 配置已保存，客户端重新读取后生效')
})}
async function cancelPreview(){preview.value=undefined;await window.manager.discardClientConfig();open.value=true}
</script>

<template>
  <a-collapse v-model:active-key="expanded" class="settings-card provider-config-card">
    <a-collapse-panel key="providers" header="Provider 连接">
      <p class="muted">管理此客户端的服务地址与鉴权方式，保存前预览。已有登录凭据不会显示在页面上。</p>
      <a-alert v-if="error&&!open&&!preview" type="error" show-icon :message="error" style="margin-bottom:16px" />
      <div class="provider-toolbar"><a-button type="primary" :disabled="busy" @click="edit()">添加 Provider</a-button><a-button :loading="busy" @click="load">重新读取连接</a-button></div>
      <a-table :data-source="view?.providers" row-key="id" size="small" :pagination="{pageSize:8,showSizeChanger:false}" :scroll="{x:680}" :columns="[{title:'Provider',key:'name',width:160},{title:'连接地址',key:'url'},{title:'鉴权',key:'auth',width:130},{title:'操作',key:'action',width:80}]">
        <template #bodyCell="{column,record}">
          <template v-if="column.key==='name'"><strong>{{record.values.name||record.id}}</strong><div class="muted provider-value">{{record.id}}</div><a-tag v-if="record.selected" color="purple">当前默认</a-tag></template>
          <template v-else-if="column.key==='url'"><span class="provider-value">{{record.values.base_url||'保留自定义配置'}}</span><div v-if="record.invalidFields.length" class="muted">有未识别的原配置值</div></template>
          <template v-else-if="column.key==='auth'">{{authLabels[record.authMode]}}<div v-if="record.bearerConfigured" class="muted">密钥已配置</div></template>
          <template v-else-if="column.key==='action'"><a-button type="link" size="small" :disabled="busy||reserved(record.id)" @click="edit(record)">编辑</a-button></template>
        </template>
        <template #emptyText>尚未定义自定义 Provider</template>
      </a-table>
      <p class="muted">修改只影响这里选择的配置目录。内建 Provider 使用客户端默认实现；自定义请求头和未编辑字段会保留。恢复入口在下方“配置恢复”。</p>
    </a-collapse-panel>
  </a-collapse>
  <a-modal v-model:open="open" :title="creating?'添加 Provider 连接':'编辑 Provider 连接'" :width="740" ok-text="预览连接改动" cancel-text="取消" :confirm-loading="busy" @ok="stage" @cancel="form.token=''">
    <a-form layout="vertical" :model="form" class="provider-form" :disabled="busy">
      <a-alert v-if="error" type="error" :message="error" style="margin-bottom:16px" />
      <div class="provider-grid"><a-form-item label="Provider ID" required><a-input v-model:value="form.providerId" :disabled="!creating" :maxlength="100" placeholder="例如 my_provider" /></a-form-item><a-form-item label="显示名称" required><a-input v-model:value="form.name" :maxlength="200" /></a-form-item></div>
      <a-form-item label="Base URL" required><a-input v-model:value="form.base_url" placeholder="https://api.example.com/v1" :maxlength="2000" /></a-form-item>
      <a-form-item label="客户端协议" extra="直连使用 Responses。Chat Completions 账号应通过本地 API 转换后接入。"><a-select v-model:value="form.wire_api" :options="[{value:'responses',label:'Responses'}]" /></a-form-item>
      <a-form-item label="鉴权方式"><a-select v-model:value="form.authMode" :options="[{value:'keep',label:creating?'使用客户端默认值':'保留现有鉴权'},{value:'account',label:'使用已保存的 API 账号'},{value:'token',label:'填写 Bearer 密钥'},{value:'environment',label:'环境变量'},{value:'openai',label:'使用客户端 OpenAI 登录态'},{value:'none',label:'无需鉴权'}]" /></a-form-item>
      <a-form-item v-if="form.authMode==='account'" label="API 账号" extra="由主进程复制密钥到目标配置；账号以后更新时，需重新预览应用。"><a-select v-model:value="form.accountId" placeholder="选择账号" :options="view?.accounts.map(account=>({value:account.id,label:account.name+(account.wireApi==='responses'?'':' · 需本地 API 转换'),disabled:account.wireApi!=='responses'}))" @change="useAccount" /></a-form-item>
      <a-form-item v-if="form.authMode==='token'" label="新 Bearer 密钥" extra="写入本机 config.toml（文件权限 0600）；保存后页面不回显。"><a-input-password v-model:value="form.token" autocomplete="new-password" :maxlength="10000" /></a-form-item>
      <a-form-item v-if="form.authMode==='environment'" label="环境变量名称" extra="由客户端启动环境提供变量值；这里不读取或保存该环境变量的值。"><a-input v-model:value="form.envKey" placeholder="MY_PROVIDER_API_KEY" :maxlength="128" /></a-form-item>
      <div class="provider-grid"><a-form-item label="WebSocket 支持"><a-select v-model:value="form.supports_websockets" allow-clear placeholder="客户端默认值" :options="[{value:true,label:'启用'},{value:false,label:'禁用'}]" /></a-form-item><a-form-item label="独立网页搜索支持"><a-select v-model:value="form.supports_standalone_web_search" allow-clear placeholder="客户端默认值" :options="[{value:true,label:'声明支持'},{value:false,label:'不声明'}]" /></a-form-item></div>
      <a-collapse ghost><a-collapse-panel key="retry" header="重试与流式超时"><div class="provider-grid"><a-form-item label="HTTP 重试次数"><a-input-number v-model:value="form.request_max_retries" :min="0" :max="100" :precision="0" /></a-form-item><a-form-item label="流式重试次数"><a-input-number v-model:value="form.stream_max_retries" :min="0" :max="100" :precision="0" /></a-form-item><a-form-item label="流式空闲超时（毫秒）"><a-input-number v-model:value="form.stream_idle_timeout_ms" :min="1" :max="3600000" :precision="0" /></a-form-item></div></a-collapse-panel></a-collapse>
      <a-form-item><a-checkbox v-model:checked="form.makeDefault">设为此客户端的默认 Provider</a-checkbox></a-form-item>
      <a-form-item v-if="form.makeDefault" label="默认服务等级" extra="保存到此客户端默认设置；已有会话与 Profile 可有独立覆盖。"><a-select v-model:value="form.serviceTier" :options="[{value:'keep',label:'保留当前设置'},{value:'clear',label:'清除默认设置'},{value:'fast',label:'Fast'},{value:'default',label:'Standard'},{value:'auto',label:'Auto'},{value:'flex',label:'Flex'}]" /></a-form-item>
    </a-form>
  </a-modal>
  <a-modal :open="!!preview" title="确认 Provider 连接改动" :width="740" ok-text="应用连接" cancel-text="返回编辑" :confirm-loading="busy" :ok-button-props="{disabled:!preview?.changes.length}" @ok="apply" @cancel="cancelPreview">
    <p class="muted provider-value">{{preview?.target.directory}}/config.toml</p>
    <a-table :data-source="preview?.changes" row-key="key" size="small" table-layout="fixed" :pagination="false" :columns="[{title:'字段',dataIndex:'key',width:240},{title:'当前值',dataIndex:'before'},{title:'保存后',dataIndex:'after'}]"><template #bodyCell="{column,text}"><span class="provider-value">{{column.dataIndex==='key'?providerChangeLabel(text):text}}</span></template></a-table>
    <p class="muted">密钥内容不会显示在差异中。配置和备份存放在本机；应用后由客户端重新读取生效。</p>
    <a-alert v-if="error" type="error" :message="error" />
  </a-modal>
</template>

<style scoped>
.provider-toolbar{display:flex;justify-content:space-between;gap:16px;margin:16px 0}
.provider-value{overflow-wrap:anywhere;font-size:12px;white-space:pre-wrap}
.provider-form{max-height:62vh;overflow:auto;padding-right:8px}
.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20px}
</style>
