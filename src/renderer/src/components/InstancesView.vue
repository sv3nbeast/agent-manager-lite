<script setup lang="ts">
import { computed, reactive, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { PlusOutlined, DesktopOutlined } from '@ant-design/icons-vue'
import type { InstanceInput, InstanceLaunchPreview, InstanceView, InstanceWorkingDirectory, InstanceCopySource } from '../../../shared/instances'
import { accountCompatibility, getAgentClient, implementedAgentClients, resolveAgentClientType } from '../../../shared/agentClients'
import { instanceInputSchema } from '../../../shared/instances'
import type { ModelContextDefault } from '../../../shared/modelContextWindows'
import type { InstanceLoginRequest, InstanceLoginResult } from '../instanceOnboarding'
import InstanceProviderDialog from './InstanceProviderDialog.vue'
import { formatModelContextWindow } from '../../../shared/modelContextWindows'
import { useManager } from '../store'

const props=defineProps<{loginResult?:InstanceLoginResult}>()
const emit=defineEmits<{'add-account':[request:InstanceLoginRequest]}>()
const manager=useManager(),search=ref(''),page=ref(1),open=ref(false),editing=ref<InstanceView>(),preview=ref<InstanceLaunchPreview>(),error=ref(''),busy=ref(false)
const instances=computed(()=>manager.data?.instances ?? []),applications=computed(()=>manager.data?.instanceApplications ?? []),accounts=computed(()=>manager.data?.accounts ?? [])
const filtered=computed(()=>instances.value.filter(value=>[value.name,value.accountName,value.model].join(' ').toLowerCase().includes(search.value.toLowerCase())))
const visible=computed(()=>filtered.value.slice((page.value-1)*12,page.value*12))
const launchMode=ref<'desktop'|'cli'>('desktop'),workingDirectories=ref<InstanceWorkingDirectory[]>([])
const availableApplications=computed(()=>applications.value.filter(app=>{try{return resolveAgentClientType(app.clientType)===form.clientType&&(app.kind??'desktop')===launchMode.value}catch{return false}}))
onMounted(async()=>{try{workingDirectories.value=await window.manager.listInstanceWorkingDirectories()}catch(cause){error.value=String(cause)}})
const copySource=ref<InstanceView>()
const externalSource=ref<InstanceCopySource>(),sourceClosed=ref(false)
const sourceMode=ref<'copy'|'attach'>('copy')
const attachingForm=computed(()=>!!externalSource.value&&sourceMode.value==='attach')
const copyingForm=computed(()=>!!copySource.value||!!externalSource.value&&!attachingForm.value)
const copySourceName=computed(()=>copySource.value?.name??externalSource.value?.name)
const copyJob=computed(()=>manager.data?.instanceCopy),copyRunning=computed(()=>!!copyJob.value&&['scanning','copying'].includes(copyJob.value.status))
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024**2).toFixed(1)} MiB`
const form=reactive<InstanceInput>({clientType:'codex',name:'',applicationId:'',accountId:'',connectionMode:'local_api',defaultTier:'inherit',model:'',extraArgs:[]}),args=ref('')
const modeName=(value?:string)=>value==='native'?'原生账号登录':'本地 API'
function localeLabel(value?:string,source?:string,effectiveLocale?:string) {
  const names:Record<string,string>={'zh-CN':'简体中文','zh-TW':'繁体中文（台湾）','zh-HK':'繁体中文（香港）','en-US':'English'}
  if(!value)return effectiveLocale?`自动检测 · ${names[effectiveLocale]??effectiveLocale}`:source==='existing'||source==='legacy'?'保留已有语言配置':'自动检测'
  return names[value]??value
}
watch(open,async visible=>{
  if(visible){
    await nextTick()
    document.querySelector('.instance-editor')?.closest('.ant-modal-body')?.scrollTo({top:0})
  }
})
const client=computed(()=>getAgentClient(form.clientType))
const availableAccounts=computed(()=>accounts.value.filter(account=>accountCompatibility(form.clientType,account,{connectionMode:form.connectionMode}).compatible))
const identityAccounts=computed(()=>availableAccounts.value.filter(account=>account.kind!=='api_key'))
const resourceKind=ref<'account'|'provider'>('account'),supplierSelection=ref(''),providerOpen=ref(false)
const step=ref(0),advanced=ref<string[]>([])
const wizard=computed(()=>!editing.value&&!copySource.value&&!externalSource.value)
let pendingLogin:string|undefined
let draftGeneration=0
const committing=ref(false)
const supplierChoices=computed(()=>{
  const providers=manager.data?.providers??[]
  return [
    ...providers.flatMap(provider=>provider.keys.map(key=>{
      const account=availableAccounts.value.find(account=>key.accountIds.includes(account.id)&&account.kind==='api_key')
      return {value:provider.id+':'+key.id,label:provider.name+' · '+(key.name||'默认密钥'),provider,key,account,
        disabled:form.connectionMode==='native'&&provider.wireApi!=='responses'}
    })),
    ...availableAccounts.value.filter(account=>account.kind==='api_key'&&!account.providerId).map(account=>({value:'account:'+account.id,label:account.name+' · 独立连接',account,provider:undefined,key:undefined,disabled:false}))
  ]
})
const selectedSupplier=computed(()=>supplierChoices.value.find(item=>item.value===supplierSelection.value))
const selectedAccount=computed(()=>availableAccounts.value.find(account=>account.id===form.accountId))
const resourceLabel=computed(()=>resourceKind.value==='provider'?selectedSupplier.value?.label:selectedAccount.value?.name)
function selectAccount(){form.model=selectedAccount.value?.models[0]??''}
function selectSupplier(value:string){
  supplierSelection.value=value
  form.accountId=selectedSupplier.value?.account?.id??''
  form.model=(selectedSupplier.value?.account?.models??selectedSupplier.value?.provider?.models)?.[0]??''
}
function resetResource(){
  if(resourceKind.value==='account'){form.accountId=identityAccounts.value[0]?.id??'';selectAccount()}
  else selectSupplier(supplierChoices.value.find(item=>!item.disabled)?.value??'')
}
function addAccount(){pendingLogin=crypto.randomUUID();emit('add-account',{requestId:pendingLogin,clientType:form.clientType})}
watch(()=>props.loginResult,result=>{
  if(!result||result.requestId!==pendingLogin||!open.value||result.clientType!==form.clientType)return
  pendingLogin=undefined
  const account=availableAccounts.value.find(account=>account.id===result.accountId&&account.kind!=='api_key')
  if(!account){error.value='账号已保存，但不支持当前接入方式；请选择其他账号或调整接入方式。';return}
  resourceKind.value='account';form.accountId=account.id;selectAccount()
})
function providerCreated(accountId:string){
  resourceKind.value='provider'
  const choice=supplierChoices.value.find(item=>item.account?.id===accountId)
  if(choice)selectSupplier(choice.value)
  else error.value='供应商已保存，请刷新资源后选择密钥。'
}
function closeEditor(){if(committing.value)return;draftGeneration++;open.value=false;pendingLogin=undefined;providerOpen.value=false}
async function ensureResource(generation=draftGeneration):Promise<boolean>{
  const selection=supplierSelection.value,mode=form.connectionMode,clientType=form.clientType,kind=resourceKind.value
  if(!open.value||generation!==draftGeneration)return false
  if(resourceKind.value==='provider'){
    const choice=selectedSupplier.value
    if(!choice||choice.disabled){error.value='请选择兼容的供应商密钥。';return false}
    if(!choice.account&&choice.provider&&choice.key){
      const provider=choice.provider,key=choice.key
      if(!await manager.execute(()=>window.manager.mutateProvider({action:'createAccount',id:provider.id,revision:provider.revision,keyId:key.id,name:(provider.name+' · '+(key.name||'默认密钥')).slice(0,120)})))return false
      if(!open.value||generation!==draftGeneration)return false
      if(kind!==resourceKind.value||selection!==supplierSelection.value||mode!==form.connectionMode||clientType!==form.clientType){error.value='资源选择已变化，请重新继续。';return false}
      const accountId=manager.data?.providers?.find(value=>value.id===provider.id)?.keys.find(value=>value.id===key.id)?.accountIds.find(id=>availableAccounts.value.some(account=>account.id===id))
      if(!accountId){error.value='密钥连接已变化，请重新选择。';return false}
      form.accountId=accountId
      if(!form.model)form.model=selectedAccount.value?.models[0]??''
    }else form.accountId=choice.account?.id??''
  }
  if(!selectedAccount.value){error.value='请选择兼容的账号或供应商。';return false}
  return true
}
async function nextStep(){
  if(manager.loading||busy.value)return
  const generation=draftGeneration,currentStep=step.value
  error.value=''
  if(step.value===0&&!availableApplications.value.some(app=>app.id===form.applicationId)){error.value='请先选择已安装的客户端程序。';return}
  if(step.value===1&&!await ensureResource(generation))return
  if(!open.value||generation!==draftGeneration||currentStep!==step.value)return
  if(step.value===2){
    const parsed=instanceInputSchema.safeParse({...form,extraArgs:args.value.split('\n').map(value=>value.trim()).filter(Boolean)})
    if(!parsed.success){error.value='请填写实例名称和模型，并检查配置。';return}
    const compatible=selectedAccount.value&&accountCompatibility(form.clientType,selectedAccount.value,{connectionMode:form.connectionMode,model:parsed.data.model})
    if(!compatible?.compatible){error.value=compatible?.reason??'所选账号已变化。';return}
  }
  step.value=Math.min(3,step.value+1)
}
const contextDefault=ref<ModelContextDefault>(),contextLoading=ref(false)
let contextRequest=0
watch(()=>[open.value,form.model,form.clientType],async()=>{
  const request=++contextRequest;contextDefault.value=undefined;contextLoading.value=false
  if(!open.value||!form.model.trim()||!client.value.capabilities.contextWindow)return
  contextLoading.value=true
  try{const values=await window.manager.readModelContextDefaults([form.model.trim()]);if(request===contextRequest)contextDefault.value=values[0]}catch{/* Preview remains the authority if catalog lookup fails. */}
  finally{if(request===contextRequest)contextLoading.value=false}
})
onBeforeUnmount(()=>{contextRequest++;draftGeneration++;pendingLogin=undefined})
const contextLabel=computed(()=>{
  const provider=(manager.data?.providers??[]).find(value=>value.id===selectedAccount.value?.providerId)
  const value=provider?.modelContextWindows?.[form.model]
  if(value)return formatModelContextWindow(value)+' · 供应商设置'
  return contextDefault.value?formatModelContextWindow(contextDefault.value.contextWindow)+(contextDefault.value.source==='template'?' · 模板默认值':' · 目录默认值'):contextLoading.value?'读取中…':'启动预览时核对'
})
const labels:Record<string,string>={stopped:'已停止',preparing:'准备连接',starting:'启动应用',running:'运行中',stopping:'停止中',error:'需要处理'}
const tierName=(value?:string)=>value==='priority' || value==='fast' ? 'Fast' : value==='default' || value==='standard' ? 'Standard' : value==='auto'?'Auto':value==='flex'?'Flex':value==='inherit'?'继承账号与全局':'跟随请求'
const initialSpeedName=(value?:string)=>value===undefined?'普通':tierName(value)==='Standard'?'普通':tierName(value)
const contextSourceName=(value?:string)=>value==='provider'?'供应商设置':value==='config'?'实例配置':value==='catalog'?'模型目录':'默认模板'
function edit(instance?:InstanceView) {
  draftGeneration++
  let clientType:'codex'
  try{clientType=resolveAgentClientType(instance?.clientType)}catch(cause){error.value=String(cause);return}
  step.value=0;advanced.value=[];pendingLogin=undefined
  copySource.value=undefined
  externalSource.value=undefined;sourceClosed.value=false;sourceMode.value='copy'
  editing.value=instance;error.value='';launchMode.value=instance?.launchMode??'desktop'
  Object.assign(form,instance ? {clientType,name:instance.name,applicationId:instance.applicationId,accountId:instance.accountId,connectionMode:instance.connectionMode??'local_api',workingDirectoryId:instance.workingDirectoryId,defaultTier:instance.defaultTier,model:instance.model,extraArgs:instance.extraArgs} :
    {clientType,name:'',applicationId:availableApplications.value[0]?.id ?? '',accountId:accounts.value[0]?.id ?? '',connectionMode:'local_api',workingDirectoryId:undefined,defaultTier:'inherit',model:accounts.value[0]?.models[0] ?? '',extraArgs:[]})
  resourceKind.value=accounts.value.find(account=>account.id===form.accountId)?.kind==='api_key'?'provider':'account'
  if(resourceKind.value==='provider')supplierSelection.value=supplierChoices.value.find(choice=>choice.account?.id===form.accountId)?.value??''
  else supplierSelection.value=''
  if(!instance)resetResource()
  args.value=form.extraArgs.join('\n');open.value=true
}
function duplicate(instance:InstanceView){
  edit(instance);editing.value=undefined;copySource.value=instance
  form.name=copyName(instance.name)
}
function copyName(source:string){
  const base=source.slice(0,100)+' 副本';let name=base,index=2
  while(instances.value.some(value=>value.name.toLowerCase()===name.toLowerCase()))name=base+' '+index++
  return name
}
async function chooseExternal(mode:'copy'|'attach'){
  busy.value=true;error.value=''
  try{
    const source=await (mode==='attach'?window.manager.chooseExistingInstanceDirectory():window.manager.chooseInstanceCopySource())
    if(source){edit();externalSource.value=source;sourceMode.value=mode;form.name=mode==='attach'?source.name.slice(0,120):copyName(source.name)}
  }catch(cause){error.value=String(cause)}finally{busy.value=false}
}
async function cancelCopy(){if(copyJob.value)await manager.execute(()=>window.manager.cancelInstanceCopy(copyJob.value!.id))}
async function chooseApplication() {
  if(await manager.execute(()=>window.manager.chooseInstanceApplication()))form.applicationId=availableApplications.value.at(-1)?.id ?? form.applicationId
}
function changeLaunchMode(){form.applicationId=availableApplications.value[0]?.id??'';form.workingDirectoryId=undefined}
async function chooseCli(){if(await manager.execute(()=>window.manager.chooseInstanceCli()))form.applicationId=availableApplications.value.at(-1)?.id??form.applicationId}
async function chooseWorkingDirectory(){
  try{const target=await window.manager.chooseInstanceWorkingDirectory();if(target){workingDirectories.value=await window.manager.listInstanceWorkingDirectories();form.workingDirectoryId=target.id}}catch(cause){error.value=String(cause)}
}
async function save(previewAfter=false) {
  if(manager.loading||busy.value)return
  const generation=draftGeneration,draft={...form,extraArgs:args.value.split('\n').map(value=>value.trim()).filter(Boolean)}
  error.value=''
  if(!await ensureResource(generation)||!open.value||generation!==draftGeneration)return
  const parsed=instanceInputSchema.safeParse({...draft,accountId:form.accountId})
  if(!parsed.success){error.value='请填写有效的实例名称、模型和配置。';return}
  const details=parsed.data
  const source=copySource.value,external=externalSource.value
  if(external&&!sourceClosed.value)return
  const attach=attachingForm.value,previousIds=new Set(instances.value.map(instance=>instance.id)),editingId=editing.value?.id
  committing.value=true
  let savedOk=false
  try{savedOk=await manager.execute(()=>external?(attach?window.manager.attachExistingInstance({ticket:external.ticket,sourceClosed:true,details}):window.manager.copyExternalInstance({ticket:external.ticket,sourceClosed:true,details})):source?window.manager.copyInstance({id:source.id,revision:source.revision,details}):window.manager.saveInstance({id:editingId,revision:editing.value?.revision,details}))}
  finally{committing.value=false}
  if(savedOk&&open.value&&generation===draftGeneration) {
    closeEditor();message.success(attach?'已有目录已登记':source||external?'正在复制实例':'实例已保存')
    if(previewAfter&&!source&&!external){
      const saved=instances.value.find(instance=>editingId?instance.id===editingId:!previousIds.has(instance.id)&&instance.name===details.name)
      if(saved)await launch(saved)
    }
  }
}
async function launch(instance:InstanceView) {
  busy.value=true;error.value=''
  try {preview.value=await window.manager.previewInstanceLaunch({id:instance.id,revision:instance.revision})}catch(cause){error.value=String(cause)}finally{busy.value=false}
}
async function start() {
  if(preview.value && await manager.execute(()=>window.manager.startInstance(preview.value!.ticket)))preview.value=undefined
}
async function stop(instance:InstanceView) {await manager.execute(()=>window.manager.stopInstance(instance.id))}
async function focus(instance:InstanceView) {try{await window.manager.focusInstance(instance.id)}catch(cause){message.error(String(cause))}}
function remove(instance:InstanceView) {
  Modal.confirm({title:`移除实例“${instance.name}”？`,content:instance.externalHome?'仅移除实例登记并归档本管理器的窗口与启动记录。已有目录及其中的配置、登录和会话保持原位；已有配置登记与凭据关联可继续在客户端配置页管理。':'实例文件会移至本应用的 instance-trash 目录保留，账号不受影响。',okText:instance.externalHome?'移除登记':'移除并归档',cancelText:'取消',
    async onOk(){await manager.execute(()=>window.manager.removeInstance({id:instance.id,revision:instance.revision}))}})
}
function stopAll(){Modal.confirm({title:'停止本管理器的所有实例？',content:'各实例的在途任务将中断，工作文件和会话保留。',okText:'停止全部',cancelText:'取消',async onOk(){await manager.execute(()=>window.manager.closeAllInstances())}})}
</script>

<template>
  <section class="instances-panel">
    <div class="page-heading"><div><h1>实例</h1><p>选择客户端和兼容资源，从一个入口启动独立工作空间。</p></div><a-space wrap><a-button v-if="instances.some(value=>value.status!=='stopped')" @click="stopAll">停止全部</a-button><a-button :disabled="copyRunning||busy" @click="chooseExternal('copy')">从已有目录复制</a-button><a-button :disabled="copyRunning||busy" @click="chooseExternal('attach')">使用已有目录</a-button><a-button type="primary" @click="edit()"><PlusOutlined />创建实例</a-button></a-space></div>
    <a-alert v-if="error" type="error" :message="error" class="error-banner" />
    <a-card v-if="copyJob" class="instance-copy-job" size="small"><strong>{{copyJob.sourceName}} → {{copyJob.name}}</strong><p>{{copyJob.status==='scanning'?'正在检查来源':copyJob.status==='copying'?'正在复制文件':copyJob.status==='completed'?'副本已创建':copyJob.status==='cancelled'?'复制已取消':'复制未完成'}} · {{copyJob.files}} / {{copyJob.totalFiles}} 个文件 · {{size(copyJob.bytes)}} / {{size(copyJob.totalBytes)}}</p><a-progress v-if="copyRunning" :percent="copyJob.totalBytes?Math.min(99,Math.floor(copyJob.bytes/copyJob.totalBytes*100)):0" :show-info="false" /><p v-if="copyJob.skipped" class="muted">已排除 {{copyJob.skipped}} 项登录文件、后台状态或链接等非普通文件。</p><a-alert v-if="copyJob.error" :message="copyJob.error" type="error" /><a-button v-if="copyRunning" @click="cancelCopy">取消复制</a-button></a-card>
    <div class="toolbar"><a-input v-model:value="search" allow-clear placeholder="搜索实例、账号或模型" style="max-width:360px" @change="page=1" /><span class="toolbar-spacer" /><span class="muted">{{ instances.length }} 个实例</span><a-button @click="manager.load">刷新状态</a-button></div>
    <div v-if="!instances.length" class="empty-panel"><div class="empty-icon"><DesktopOutlined /></div><h2>创建你的第一个实例</h2><p>选择客户端 → 选择账号或供应商 → 配置项目 → 启动。<br>配置与会话独立保存，供应商密钥可供兼容实例复用。</p><a-button type="primary" @click="edit()">创建实例</a-button></div>
    <a-empty v-else-if="!filtered.length" description="没有匹配的实例" />
    <div v-else class="instance-grid">
      <a-card v-for="instance in visible" :key="instance.id" class="instance-card">
        <div class="instance-heading"><div class="instance-name"><DesktopOutlined /><strong>{{ instance.name }}</strong></div><a-tag :color="instance.status==='running'?'green':instance.status==='error'?'red':['preparing','starting','stopping'].includes(instance.status)?'processing':undefined">{{ labels[instance.status] }}</a-tag></div>
        <a-descriptions :column="1" size="small"><a-descriptions-item label="客户端">{{instance.clientType === 'codex' ? 'Codex' : '尚未接入'}}</a-descriptions-item><a-descriptions-item label="运行方式">{{instance.launchMode==='cli'?'CLI · Terminal':'桌面应用'}}</a-descriptions-item><a-descriptions-item label="账号">{{ instance.accountName || '账号已移除' }} · {{modeName(instance.connectionMode)}}</a-descriptions-item><a-descriptions-item label="默认模型">{{ instance.model }}</a-descriptions-item><a-descriptions-item label="速度"><template v-if="instance.speedMenu==='active'||instance.speedMenu==='pending'">{{instance.speedMenu==='active'?'在 Codex 中选择':'正在启用 Codex 速度菜单'}}<span class="muted"> · 启动时 {{initialSpeedName(instance.initialTier)}}</span></template><template v-else>{{ tierName(instance.defaultTier) }}<span v-if="instance.status==='running'"> · {{instance.connectionMode==='native'?'已写入配置':'启动时'}} {{ initialSpeedName(instance.initialTier??instance.appliedTier) }}</span></template></a-descriptions-item><a-descriptions-item v-if="instance.desktopLocaleCompatibility" label="页面语言">{{instance.desktopLocaleCompatibility==='active'?'跟随 Codex 语言设置':instance.desktopLocaleCompatibility==='pending'?'正在加载内置翻译':'翻译适配未加载'}}</a-descriptions-item><a-descriptions-item v-if="instance.pid" label="进程">{{ instance.pid }}<span v-if="instance.port"> · 本地端口 {{ instance.port }}</span></a-descriptions-item></a-descriptions>
        <p class="instance-path" :title="instance.directory"><a-tag v-if="instance.externalHome">已有目录</a-tag>{{ instance.directory }}</p>
        <a-alert v-if="instance.error" type="error" :message="instance.error" class="error-banner" />
        <a-alert v-if="instance.notice" type="info" :message="instance.notice" class="error-banner" />
        <a-space wrap><a-button v-if="instance.status==='stopped'" type="primary" :loading="busy" :disabled="instance.copying" @click="launch(instance)">预览启动</a-button><a-button v-else danger :loading="instance.status==='stopping'" @click="stop(instance)">{{ ['preparing','starting'].includes(instance.status)?'取消启动':'停止实例' }}</a-button><a-button v-if="instance.status==='running'&&instance.launchMode!=='cli'" @click="focus(instance)">定位窗口</a-button><a-button :disabled="instance.status!=='stopped'||instance.copying" @click="edit(instance)">编辑</a-button><a-button :disabled="instance.status!=='stopped'||copyRunning" @click="duplicate(instance)">复制实例</a-button><a-button type="text" danger :disabled="instance.status!=='stopped'||instance.copying" @click="remove(instance)">移除</a-button></a-space>
      </a-card>
    </div>
    <a-pagination v-if="filtered.length>12" v-model:current="page" :total="filtered.length" :page-size="12" :show-size-changer="false" class="pagination" />
    <p class="muted instance-note">当前支持 macOS 桌面的本地 API 与文件原生账号模式。CLI 支持 macOS Terminal、原生程序及已适配的 npm 入口，会话同步仍在迁移。退出管理器会停止这些实例；其他已打开的客户端保持独立。</p>
    <a-modal :open="open" :closable="!committing" :mask-closable="!committing" :keyboard="!committing" centered :width="720" :body-style="{maxHeight:'calc(100vh - 220px)',overflowY:'auto'}" :title="attachingForm?'使用已有目录':copyingForm?'复制实例':editing?'编辑实例':'创建实例'" :ok-text="attachingForm?'登记实例':copyingForm?'复制并创建':'保存实例'" cancel-text="取消" :confirm-loading="manager.loading" :ok-button-props="{disabled:!availableAccounts.length || !availableApplications.length || !!externalSource&&!sourceClosed}" @ok="save()" @cancel="closeEditor">
      <template v-if="wizard" #footer>
        <a-button :disabled="manager.loading" @click="closeEditor">取消</a-button>
        <a-button v-if="step>0" :disabled="manager.loading" @click="step--;error=''">返回</a-button>
        <a-button v-if="step<3" type="primary" :loading="manager.loading" @click="nextStep">下一步</a-button>
        <template v-else><a-button :loading="manager.loading" @click="save()">仅创建</a-button><a-button type="primary" :loading="manager.loading" @click="save(true)">创建并预览</a-button></template>
      </template>
      <a-form layout="vertical" class="instance-editor" :class="{'instance-wizard':wizard}">
        <a-steps v-if="wizard" class="instance-wizard-steps" :current="step" size="small" :items="[{title:'客户端'},{title:'账号或供应商'},{title:'项目与配置'},{title:'确认'}]" />
        <a-alert v-if="copyingForm" type="info" :message="'从“'+copySourceName+'”复制配置、会话和技能，并将副本内部的会话与模型目录路径指向新目录。文件登录令牌不复制，启动时使用下方绑定账号。桌面窗口状态与项目文件不会复制。'" class="instance-copy-explanation error-banner" />
        <a-alert v-if="attachingForm" class="instance-attach-explanation error-banner" type="info" message="直接使用所选目录，不复制文件。登记不会改写配置；启动时应用绑定账号和设置，停止后回收登录状态并恢复配置。移除实例会保留此目录。" />
        <div v-if="externalSource" class="external-copy-source"><p class="instance-path">{{attachingForm?'已有目录':'来源'}}：{{externalSource.directory}}</p><p class="muted">{{attachingForm?'请先关闭使用此目录的客户端；此实例运行时，不要再由其他客户端同时使用该目录。':'请先关闭使用此目录的客户端。来源保持不变；配置中的其他 API 密钥会随配置复制，链接会跳过。'}}</p><a-checkbox v-model:checked="sourceClosed" aria-label="来源客户端已关闭">我已关闭使用此目录的客户端</a-checkbox></div>
        <section v-show="!wizard||step===0" class="instance-step" data-step="0">
          <a-form-item label="客户端"><a-select v-model:value="form.clientType" aria-label="实例客户端" :disabled="!!editing||copyingForm||attachingForm" :options="implementedAgentClients.map(item=>({value:item.id,label:item.name}))" /></a-form-item>
          <a-form-item label="运行方式"><a-segmented v-model:value="launchMode" aria-label="实例运行方式" :options="client.capabilities.launchModes.map(mode=>({value:mode,label:mode==='desktop'?'桌面应用':'CLI 终端'}))" @change="changeLaunchMode" /></a-form-item>
          <a-form-item :label="launchMode==='cli'?'CLI 程序':'已安装应用'"><a-select v-model:value="form.applicationId" aria-label="实例应用" :options="availableApplications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" placeholder="选择已安装的程序" /><a-button v-if="launchMode==='desktop'" type="link" @click="chooseApplication">选择应用文件</a-button><a-button v-else type="link" @click="chooseCli">选择 CLI 程序</a-button></a-form-item>
          <p class="muted">当前已接入 Codex。新增客户端会沿用这套实例和资源管理流程。</p>
        </section>
        <section v-show="!wizard||step===1" class="instance-step" data-step="1">
          <a-form-item label="使用的资源"><a-radio-group v-model:value="resourceKind" aria-label="资源类型" :options="[{label:'账号',value:'account'},{label:'供应商密钥',value:'provider'}]" @change="resetResource" /></a-form-item>
          <template v-if="resourceKind==='account'">
            <a-form-item label="绑定账号"><a-select v-model:value="form.accountId" aria-label="实例账号" :options="identityAccounts.map(account=>({value:account.id,label:account.name}))" placeholder="选择兼容账号" @change="selectAccount" /><a-button class="instance-add-account" type="link" @click="addAccount"><PlusOutlined />添加账号</a-button></a-form-item>
            <p v-if="!identityAccounts.length" class="muted">没有兼容的登录账号，可在此添加后继续。</p>
          </template>
          <template v-else>
            <a-form-item label="供应商密钥"><a-select :value="supplierSelection||undefined" aria-label="实例供应商密钥" :options="supplierChoices.map(item=>({value:item.value,label:item.label,disabled:item.disabled}))" placeholder="选择兼容密钥" @change="selectSupplier(String($event))" /><a-button class="instance-add-provider" type="link" @click="providerOpen=true"><PlusOutlined />添加供应商</a-button></a-form-item>
            <p class="muted">引用已保存的密钥，多个兼容实例可复用。尚未启用的密钥会在继续时建立共享连接。</p>
          </template>
          <a-collapse ghost class="instance-connection-options"><a-collapse-panel key="connection" header="接入方式">
            <a-form-item label="账号接入方式"><a-select v-model:value="form.connectionMode" aria-label="实例接入方式" :options="[{value:'local_api',label:'本地 API'},{value:'native',label:'原生账号登录'}]" @change="resetResource" /></a-form-item>
            <p class="muted">{{form.connectionMode==='native'?'客户端使用此实例独立文件中的凭据。Agent Identity及非Responses密钥不支持此方式。':'管理器保管凭据，为此实例提供独立本地连接。支持兼容的Chat Completions供应商。'}}</p>
          </a-collapse-panel></a-collapse>
        </section>
        <section v-show="!wizard||step===2" class="instance-step" data-step="2">
          <a-form-item label="实例名称"><a-input v-model:value="form.name" aria-label="实例名称" :maxlength="120" placeholder="例如：日常开发" /></a-form-item>
          <a-form-item v-if="client.capabilities.projectDirectoryModes.some(mode=>mode===launchMode)" label="项目目录"><a-select v-model:value="form.workingDirectoryId" aria-label="实例工作目录" allow-clear placeholder="使用实例的独立工作目录" :options="workingDirectories.map(item=>({value:item.id,label:item.path}))" /><a-button type="link" @click="chooseWorkingDirectory">选择工作目录</a-button></a-form-item>
          <p v-else class="muted">桌面实例的项目在 Codex 中选择；此处管理独立配置与会话。</p>
          <a-form-item v-if="client.capabilities.models" label="默认模型"><a-auto-complete v-model:value="form.model" :options="(selectedAccount?.models??[]).map(value=>({value}))"><a-input aria-label="实例模型" :maxlength="200" placeholder="选择模型或填写模型 ID" /></a-auto-complete></a-form-item>
          <p v-if="client.capabilities.contextWindow" class="instance-context-default muted">上下文默认值：{{contextLabel}}。已有实例的实际配置以启动预览为准。</p>
          <p v-if="client.capabilities.fast&&launchMode==='desktop'&&form.connectionMode==='local_api'" class="muted">启动后在 Codex 对话界面选择普通 / Fast，无需额外配置。</p>
          <a-collapse v-model:active-key="advanced" ghost class="instance-advanced"><a-collapse-panel key="advanced" header="高级设置">
            <a-form-item v-if="client.capabilities.fast" :label="launchMode==='desktop'&&form.connectionMode==='local_api'?'首次启动速度':'默认服务等级'"><a-select v-model:value="form.defaultTier" aria-label="实例服务等级" :options="[{value:'inherit',label:'继承账号与全局'},{value:'follow',label:'跟随请求'},{value:'standard',label:'普通 · Standard'},{value:'fast',label:'Fast'},{value:'auto',label:'Auto'},{value:'flex',label:'Flex'}]" /><p class="muted">显式请求等级优先；桌面模式后续保留客户端选择。原生模式取决于客户端是否发送。</p></a-form-item>
            <a-form-item label="附加启动参数" extra="每行一个参数；实例隔离由管理器负责。"><a-textarea v-model:value="args" :rows="3" aria-label="实例附加参数" /></a-form-item>
          </a-collapse-panel></a-collapse>
        </section>
        <section v-if="wizard&&step===3" class="instance-step instance-confirm" data-step="3">
          <a-descriptions :column="1" bordered size="small"><a-descriptions-item label="客户端">{{client.name}} · {{launchMode==='cli'?'CLI 终端':'桌面应用'}}</a-descriptions-item><a-descriptions-item label="资源">{{resourceLabel}}</a-descriptions-item><a-descriptions-item label="实例">{{form.name}}</a-descriptions-item><a-descriptions-item label="项目">{{launchMode==='cli'?(workingDirectories.find(item=>item.id===form.workingDirectoryId)?.path??'独立工作目录'):'启动后在 Codex 中选择'}}</a-descriptions-item><a-descriptions-item label="模型">{{form.model}}</a-descriptions-item><a-descriptions-item v-if="client.capabilities.contextWindow" label="上下文默认值">{{contextLabel}}</a-descriptions-item><a-descriptions-item label="接入方式">{{modeName(form.connectionMode)}}</a-descriptions-item></a-descriptions>
          <p class="muted">创建后查看实际启动预览，确认后才启动客户端。</p>
        </section>
        <a-alert v-if="error||manager.error" type="error" :message="error||manager.error" class="error-banner" />
      </a-form>
    </a-modal>
    <InstanceProviderDialog v-model:open="providerOpen" :client-type="form.clientType" @created="providerCreated" />
    <a-modal :open="!!preview" centered :body-style="{maxHeight:'calc(100vh - 220px)',overflowY:'auto'}" title="确认实例启动" :width="700" ok-text="启动实例" cancel-text="取消" @ok="start" @cancel="preview=undefined">
      <a-alert v-if="preview?.externalHome" class="error-banner" type="info" message="此实例直接使用已有目录。启动会更新该目录的账号连接与配置，停止后恢复；请确认其他客户端已关闭。" />
      <a-descriptions v-if="preview" :column="1" bordered size="small" class="instance-launch-preview"><a-descriptions-item label="实例">{{ preview.name }}</a-descriptions-item><a-descriptions-item label="客户端">{{preview.clientType==='codex'?'Codex':'尚未接入'}}</a-descriptions-item><a-descriptions-item label="应用">{{ preview.application }}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode==='cli' && preview.executable!==preview.application" label="实际程序">{{preview.executable}}</a-descriptions-item><a-descriptions-item label="配置与会话">{{ preview.directory }}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode!=='cli'" label="桌面数据">{{ preview.desktopDirectory }}</a-descriptions-item><a-descriptions-item v-else label="CLI 工作目录">{{preview.workingDirectory}}</a-descriptions-item><a-descriptions-item label="账号与模型">{{ preview.accountName }} · {{ preview.model }}</a-descriptions-item><a-descriptions-item label="供应商名称">{{preview.providerName}}</a-descriptions-item><a-descriptions-item v-if="preview.effectiveContextWindow" label="默认模型上下文">{{formatModelContextWindow(preview.effectiveContextWindow)}}<span class="muted"> · {{contextSourceName(preview.contextWindowSource)}}</span></a-descriptions-item><a-descriptions-item v-if="preview.effectiveAutoCompactTokenLimit" label="自动压缩阈值">{{formatModelContextWindow(preview.effectiveAutoCompactTokenLimit)}}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode!=='cli'" label="语言偏好">{{localeLabel(preview.desktopLocale,preview.desktopLocaleSource,preview.desktopEffectiveLocale)}}<span v-if="preview.desktopLocale" class="muted"> · 保留已有选择</span></a-descriptions-item><a-descriptions-item v-if="preview.desktopLocaleCompatibilityAvailable!==undefined" label="页面语言">{{preview.desktopLocaleCompatibilityAvailable?'使用 Codex 内置翻译':preview.desktopLocaleCompatibilityReason}}</a-descriptions-item><a-descriptions-item :label="preview.speedMenuAvailable?'启动时速度':'默认服务等级'">{{ preview.speedMenuAvailable?initialSpeedName(preview.tier):tierName(preview.tier) }}</a-descriptions-item><a-descriptions-item v-if="preview.speedMenuAvailable!==undefined" label="对话速度">{{preview.speedMenuAvailable?'在 Codex 中选择普通 / Fast':preview.speedMenuReason}}<span v-if="preview.speedMenuAvailable" class="muted"> · 按模型能力显示，后续保留客户端选择</span></a-descriptions-item><a-descriptions-item v-if="preview.args.length" label="附加参数"><pre>{{ preview.args.join('\n') }}</pre></a-descriptions-item></a-descriptions>
      <p class="muted" v-if="preview && preview.launchMode!=='cli'">新实例默认自动检测电脑语言，之后保留你在 Codex 中的选择。已适配客户端使用内置翻译；未知版本保留原界面。</p>
      <p class="muted" v-if="preview?.launchMode==='cli'">将在 macOS Terminal 中打开独立 CLI 会话。附加参数可覆盖默认模型或窗口；上方窗口值对应实例默认模型。停止实例或退出管理器会结束此会话；工作目录中的文件保留。</p>
      <p class="muted" v-if="preview?.connectionMode==='native'">原生账号登录：凭据仅写入此实例的独立文件目录，客户端维护登录。停止后先保存最新令牌，再恢复原登录和配置；会话保留。此模式不生成本地网关调用记录，配置等级不代表上游已收到。</p>
      <p class="muted" v-else>本地 API：启动会创建独立连接，并备份、应用模型与连接配置。停止后恢复原配置；会话和工作文件保留。请求中的显式等级优先。</p>
      <a-alert v-if="manager.error" type="error" :message="manager.error" />
    </a-modal>
  </section>
</template>

<style scoped>
.instance-copy-job{margin-bottom:18px}.instance-copy-job p{margin:8px 0}.instance-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:18px}.instance-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:20px}.instance-name{display:flex;align-items:center;gap:10px;font-size:17px;min-width:0}.instance-name strong{overflow-wrap:anywhere}.instance-path{font-size:12px;opacity:.65;overflow-wrap:anywhere;margin:10px 0}.instance-note{font-size:12px;margin-top:24px;line-height:1.8}.instance-launch-preview{overflow-wrap:anywhere}.instance-launch-preview pre{white-space:pre-wrap}
</style>

<style scoped>
.instance-launch-preview :deep(.ant-descriptions-item-label){min-width:128px;white-space:nowrap}
.instance-editor .ant-form-item:last-of-type{margin-bottom:0}
.external-copy-source{margin-bottom:20px}
</style>

<style scoped>
.instance-wizard-steps{margin:4px 0 26px}.instance-step{min-width:0}.instance-step>.muted{font-size:12px;line-height:1.8}.instance-step .ant-form-item{margin-bottom:18px}.instance-confirm{margin:12px 0}.instance-confirm :deep(.ant-descriptions-item-content){overflow-wrap:anywhere}.instance-advanced{margin-top:14px}.instance-context-default{padding:10px 12px;border-radius:8px;background:var(--subtle)}.instance-connection-options :deep(.ant-collapse-header){padding-inline:0}.instance-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))}
</style>
