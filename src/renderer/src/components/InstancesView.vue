<script setup lang="ts">
import { computed, reactive, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { PlusOutlined, DesktopOutlined, CopyOutlined, FolderOpenOutlined, CheckCircleFilled, LoadingOutlined } from '@ant-design/icons-vue'
import type { InstanceInput, InstanceLaunchPreview, InstanceView, InstanceWorkingDirectory, InstanceCopySource, InstanceHistorySummary } from '../../../shared/instances'
import { accountCompatibility, getAgentClient, implementedAgentClients, resolveAgentClientType } from '../../../shared/agentClients'
import { instanceInputSchema } from '../../../shared/instances'
import type { ModelContextDefault } from '../../../shared/modelContextWindows'
import type { InstanceLoginRequest, InstanceLoginResult } from '../instanceOnboarding'
import InstanceProviderDialog from './InstanceProviderDialog.vue'
import InstanceHistoryOverview from './InstanceHistoryOverview.vue'
import { formatModelContextWindow, getModelContextWindow } from '../../../shared/modelContextWindows'
import { useManager } from '../store'
import { useFormFeedback, validationErrors } from '../formFeedback'
import FormFeedback from './FormFeedback.vue'

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
const sourceMode=ref<'copy'|'attach'>('copy'),editorFlow=ref<'wizard'|'direct'>('wizard')
const historyMode=ref<'empty'|'copy'>('empty'),historySourceKind=ref<'instance'|'directory'>('instance')
const sourceHistory=ref<InstanceHistorySummary>(),historyLoading=ref(false),historyError=ref('')
const pendingCopyPreview=ref<string>()
let historyRequest=0,launchRequest=0
const emptyHistory:InstanceHistorySummary={sessions:0,archived:0,projects:[],unassigned:0,issues:[]}
const chosenHistory=computed(()=>historyMode.value==='empty'&&!copySource.value&&!externalSource.value?emptyHistory:externalSource.value?.history??sourceHistory.value)
const compatibleSources=computed(()=>instances.value.filter(instance=>{try{return resolveAgentClientType(instance.clientType)===form.clientType}catch{return false}}))
const historySourceLabel=computed(()=>copySource.value?.name??externalSource.value?.name??'空白会话')
const historyChoice=computed(()=>historyMode.value==='empty'?'empty':historySourceKind.value)
const historyChoices=[
  {value:'empty' as const,title:'空白会话',description:'从新对话开始',icon:PlusOutlined},
  {value:'instance' as const,title:'从实例复制',description:'沿用已有工作空间',icon:CopyOutlined},
  {value:'directory' as const,title:'从目录复制',description:'导入其他工具的历史',icon:FolderOpenOutlined}
]
const sourceReady=computed(()=>!!chosenHistory.value&&!historyLoading.value&&!historyError.value&&(!!copySource.value||!!externalSource.value))
function clearHistorySource(){historyRequest++;historyLoading.value=false;historyError.value='';sourceHistory.value=undefined;copySource.value=undefined;externalSource.value=undefined;sourceClosed.value=false}
function changeHistoryMode(){clearHistorySource()}
function changeHistorySourceKind(){clearHistorySource()}
async function selectHistoryChoice(choice:'empty'|'instance'|'directory'){
  if(committing.value||busy.value||historyChoice.value===choice)return
  clearHistorySource();error.value=''
  historyMode.value=choice==='empty'?'empty':'copy'
  if(choice!=='empty')historySourceKind.value=choice
  if(choice==='instance'){
    const sources=compatibleSources.value.filter(item=>item.status==='stopped'&&!item.copying)
    if(sources.length===1)await chooseHistoryInstance(sources[0].id)
  }
}
async function chooseHistoryInstance(id:string){
  clearHistorySource()
  const instance=compatibleSources.value.find(item=>item.id===id)
  if(!instance||instance.status!=='stopped'||instance.copying){historyError.value='请选择已停止的实例；运行中的会话不能直接复制。';return}
  copySource.value={...instance,extraArgs:[...instance.extraArgs]}
  const request=++historyRequest,generation=draftGeneration
  historyLoading.value=true
  try{const history=await window.manager.previewInstanceHistory({id:instance.id,revision:instance.revision});if(request===historyRequest&&generation===draftGeneration&&open.value)sourceHistory.value=history}
  catch(cause){if(request===historyRequest&&generation===draftGeneration)historyError.value=String(cause)}
  finally{if(request===historyRequest)historyLoading.value=false}
}
async function chooseHistoryDirectory(){
  const generation=draftGeneration,request=++historyRequest
  busy.value=true;error.value=''
  try{
    const source=await window.manager.chooseInstanceCopySource()
    if(!open.value||generation!==draftGeneration||request!==historyRequest||historyMode.value!=='copy'||historySourceKind.value!=='directory')return
    if(source){copySource.value=undefined;sourceHistory.value=undefined;historyError.value='';externalSource.value=source;sourceClosed.value=false;sourceMode.value='copy'}
  }catch(cause){if(generation===draftGeneration&&request===historyRequest)error.value=String(cause)}finally{if(generation===draftGeneration)busy.value=false}
}
function validHistorySource():boolean{
  if(historyLoading.value){error.value='正在读取来源会话，请稍候。';return false}
  if(historyError.value){error.value='无法核对来源会话，请重新选择来源。';return false}
  if(wizard.value&&historyMode.value==='copy'&&!copySource.value&&!externalSource.value){error.value='请选择要复制的会话来源。';return false}
  if(copySource.value){const current=instances.value.find(item=>item.id===copySource.value!.id);if(!current||current.status!=='stopped'||current.copying||current.revision!==copySource.value.revision){error.value='来源实例已变化或正在运行，请重新选择已停止的实例。';return false}}
  if((copySource.value||externalSource.value)&&!attachingForm.value&&!chosenHistory.value){error.value='无法核对来源会话，请重新选择来源。';return false}
  if(externalSource.value&&!sourceClosed.value){error.value='请先关闭使用来源目录的客户端，并确认已关闭。';return false}
  if((copySource.value||externalSource.value)&&!attachingForm.value&&copyRunning.value){error.value='请等待当前复制完成，或先取消当前复制。';return false}
  return true
}
function cancelCopyPreview(){pendingCopyPreview.value=undefined;launchRequest++}
function closePreview(){launchRequest++;preview.value=undefined;busy.value=false}
const attachingForm=computed(()=>!!externalSource.value&&sourceMode.value==='attach')
const copyingForm=computed(()=>!!copySource.value||!!externalSource.value&&!attachingForm.value)
const copySourceName=computed(()=>copySource.value?.name??externalSource.value?.name)
const copyJob=computed(()=>manager.data?.instanceCopy),copyRunning=computed(()=>!!copyJob.value&&['scanning','copying'].includes(copyJob.value.status))
watch(()=>[pendingCopyPreview.value,copyJob.value?.id,copyJob.value?.status,copyJob.value?.targetId,instances.value.find(item=>item.id===copyJob.value?.targetId)?.revision],async()=>{
  const id=pendingCopyPreview.value,job=copyJob.value
  if(!id||job?.id!==id)return
  if(job.status==='failed'||job.status==='cancelled'){pendingCopyPreview.value=undefined;return}
  if(job.status!=='completed'||!job.targetId)return
  const target=instances.value.find(item=>item.id===job.targetId)
  if(!target)return
  pendingCopyPreview.value=undefined
  await launch(target)
})
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024**2).toFixed(1)} MiB`
const form=reactive<InstanceInput>({clientType:'codex',name:'',applicationId:'',accountId:'',connectionMode:'local_api',defaultTier:'inherit',model:'',extraArgs:[]}),args=ref('')
const fieldErrors=reactive<Record<string,string>>({})
let generatedName=''
useFormFeedback(()=>error.value||historyError.value)
function nextInstanceName(){
  const base=getAgentClient(form.clientType).name
  const names=new Set(instances.value.map(instance=>instance.name.trim().toLowerCase()))
  let index=1
  while(names.has(`${base} ${index}`.toLowerCase()))index++
  return `${base} ${index}`
}
function prepareName(){
  if(!editing.value&&(!form.name.trim()||form.name===generatedName&&instances.value.some(instance=>instance.name.trim().toLowerCase()===form.name.trim().toLowerCase()))){
    generatedName=nextInstanceName();form.name=generatedName
  }
}
function clearValidation(){error.value='';for(const key of Object.keys(fieldErrors))delete fieldErrors[key]}
async function focusField(field:string){
  if(wizard.value)step.value=field==='applicationId'?0:field==='accountId'?1:2
  if(field==='extraArgs')advanced.value=['advanced']
  await nextTick();await nextTick()
  const item=document.querySelector<HTMLElement>(`.instance-editor [data-field="${field}"]`)
  item?.scrollIntoView({block:'center',behavior:'smooth'})
  item?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea,button,[tabindex="0"]')?.focus({preventScroll:true})
}
function rejectField(field:string,content:string){fieldErrors[field]=content;error.value=content;void focusField(field)}
function validateDetails(draft:InstanceInput){
  const parsed=instanceInputSchema.safeParse(draft)
  if(!parsed.success){
    Object.assign(fieldErrors,validationErrors(parsed.error.issues,{name:'实例名称',model:'默认模型',applicationId:'客户端程序',accountId:'账号或供应商',extraArgs:'附加启动参数',workingDirectoryId:'项目目录',defaultTier:'服务等级',connectionMode:'接入方式'}))
    const field=Object.keys(fieldErrors)[0];error.value=fieldErrors[field];void focusField(field)
    return parsed
  }
  if(instances.value.some(instance=>instance.id!==editing.value?.id&&instance.name.trim().toLowerCase()===parsed.data.name.toLowerCase())){
    rejectField('name','实例名称已存在，请换一个名称。');return undefined
  }
  return parsed
}
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
watch(()=>[form.name,form.model,form.applicationId,form.accountId,supplierSelection.value,args.value],(values,previous)=>{
  const fields=['name','model','applicationId','accountId','accountId','extraArgs']
  values.forEach((value,index)=>{if(value!==previous[index]){const field=fields[index];if(error.value===fieldErrors[field])error.value='';delete fieldErrors[field]}})
},{flush:'sync'})
const step=ref(0),advanced=ref<string[]>([])
const wizard=computed(()=>!editing.value&&editorFlow.value==='wizard')
watch(step,async()=>{
  await nextTick()
  document.querySelector('.instance-editor')?.closest('.ant-modal-body')?.scrollTo({top:0})
})
let pendingLogin:string|undefined
let draftGeneration=0
const committing=ref(false),savingDraft=ref(false)
const supplierChoices=computed(()=>{
  const providers=manager.data?.providers??[]
  const apiAccounts=new Map(accounts.value.filter(account=>account.kind==='api_key').map(account=>[account.id,account]))
  return [
    ...providers.flatMap(provider=>provider.keys.map(key=>{
      const ids=[...new Set([...key.accountIds,...(key.reusableAccountIds??[])])]
      const candidates=ids.flatMap(id=>{const account=apiAccounts.get(id);return account?[account]:[]})
      const account=candidates.find(account=>accountCompatibility(form.clientType,account,{connectionMode:form.connectionMode}).compatible)
      const reusingStandalone=!!account&&!key.accountIds.includes(account.id)
      const incompatible=candidates.length>0&&!account
      return {value:provider.id+':'+key.id,label:provider.name+' · '+(key.name||'默认密钥')+(reusingStandalone?' · 已有连接':''),provider,key,account,reusingStandalone,
        disabled:incompatible||(!account&&form.connectionMode==='native'&&provider.wireApi!=='responses'),
        reason:incompatible?'此密钥已有 API 连接，但不支持当前接入方式。请改用本地 API，或在「API 连接」中调整该连接。':undefined}
    })),
    ...availableAccounts.value.filter(account=>account.kind==='api_key'&&!account.providerId).map(account=>({value:'account:'+account.id,label:account.name+' · 独立连接',account,provider:undefined,key:undefined,reusingStandalone:false,disabled:false,reason:undefined}))
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
function closeEditor(){if(committing.value)return;draftGeneration++;historyRequest++;historyLoading.value=false;busy.value=false;open.value=false;pendingLogin=undefined;providerOpen.value=false;cancelCopyPreview()}
async function ensureResource(generation=draftGeneration):Promise<boolean>{
  const selection=supplierSelection.value,mode=form.connectionMode,clientType=form.clientType,kind=resourceKind.value
  if(!open.value||generation!==draftGeneration)return false
  if(resourceKind.value==='provider'){
    const choice=selectedSupplier.value
    if(!choice||choice.disabled){rejectField('accountId',choice?.reason??'请选择兼容的供应商密钥。');return false}
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
  if(!selectedAccount.value){rejectField('accountId','请选择兼容的账号或供应商。');return false}
  return true
}
async function nextStep(){
  if(manager.loading||busy.value||savingDraft.value)return
  const generation=draftGeneration,currentStep=step.value
  clearValidation()
  if(step.value===0&&!availableApplications.value.some(app=>app.id===form.applicationId)){rejectField('applicationId','请先选择已安装的客户端程序。');return}
  if(step.value===1&&!await ensureResource(generation))return
  if(!open.value||generation!==draftGeneration||currentStep!==step.value)return
  if(step.value===2){
    if(!validHistorySource()){void focusField('history');return}
    prepareName()
    const parsed=validateDetails({...form,extraArgs:args.value.split('\n').map(value=>value.trim()).filter(Boolean)})
    if(!parsed?.success)return
    const compatible=selectedAccount.value&&accountCompatibility(form.clientType,selectedAccount.value,{connectionMode:form.connectionMode,model:parsed.data.model})
    if(!compatible?.compatible){rejectField('accountId',compatible?.reason??'所选账号已变化。');return}
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
onBeforeUnmount(()=>{contextRequest++;historyRequest++;draftGeneration++;launchRequest++;pendingCopyPreview.value=undefined;pendingLogin=undefined})
const contextLabel=computed(()=>{
  const connectionValue=getModelContextWindow(selectedAccount.value?.modelContextWindows,form.model)
  if(connectionValue!==undefined)return formatModelContextWindow(connectionValue)+' · API 连接设置'
  const provider=(manager.data?.providers??[]).find(value=>value.id===selectedAccount.value?.providerId)
  const value=getModelContextWindow(provider?.modelContextWindows,form.model)
  if(value!==undefined)return formatModelContextWindow(value)+' · 供应商设置'
  return contextDefault.value?formatModelContextWindow(contextDefault.value.contextWindow)+(contextDefault.value.source==='template'?' · 模板默认值':' · 目录默认值'):contextLoading.value?'读取中…':'启动预览时核对'
})
const labels:Record<string,string>={stopped:'已停止',preparing:'准备连接',starting:'启动应用',running:'运行中',stopping:'停止中',error:'需要处理'}
const tierName=(value?:string)=>value==='priority' || value==='fast' ? 'Fast' : value==='default' || value==='standard' ? 'Standard' : value==='auto'?'Auto':value==='flex'?'Flex':value==='inherit'?'继承账号与全局':'跟随请求'
const initialSpeedName=(value?:string)=>value===undefined?'普通':tierName(value)==='Standard'?'普通':tierName(value)
const contextSourceName=(value?:string)=>value==='connection'?'API 连接设置':value==='provider'?'供应商设置':value==='config'?'实例配置':value==='catalog'?'模型目录':'默认模板'
function edit(instance?:InstanceView) {
  draftGeneration++;cancelCopyPreview();closePreview()
  let clientType:'codex'
  try{clientType=resolveAgentClientType(instance?.clientType)}catch(cause){error.value=String(cause);return}
  step.value=0;advanced.value=[];pendingLogin=undefined
  clearHistorySource();historyMode.value='empty';historySourceKind.value='instance';editorFlow.value='wizard'
  sourceMode.value='copy'
  editing.value=instance;clearValidation();manager.error='';generatedName='';launchMode.value=instance?.launchMode??'desktop'
  Object.assign(form,instance ? {clientType,name:instance.name,applicationId:instance.applicationId,accountId:instance.accountId,connectionMode:instance.connectionMode??'local_api',workingDirectoryId:instance.workingDirectoryId,defaultTier:instance.defaultTier,model:instance.model,extraArgs:instance.extraArgs} :
    {clientType,name:'',applicationId:availableApplications.value[0]?.id ?? '',accountId:accounts.value[0]?.id ?? '',connectionMode:'local_api',workingDirectoryId:undefined,defaultTier:'inherit',model:accounts.value[0]?.models[0] ?? '',extraArgs:[]})
  resourceKind.value=accounts.value.find(account=>account.id===form.accountId)?.kind==='api_key'?'provider':'account'
  if(resourceKind.value==='provider')supplierSelection.value=supplierChoices.value.find(choice=>choice.account?.id===form.accountId)?.value??''
  else supplierSelection.value=''
  if(!instance){resetResource();prepareName()}
  args.value=form.extraArgs.join('\n');open.value=true
}
async function duplicate(instance:InstanceView){
  edit(instance);editing.value=undefined;editorFlow.value='direct';historyMode.value='copy'
  form.name=copyName(instance.name);generatedName=''
  await chooseHistoryInstance(instance.id)
}
function copyName(source:string){
  const base=source.slice(0,100)+' 副本';let name=base,index=2
  while(instances.value.some(value=>value.name.toLowerCase()===name.toLowerCase()))name=base+' '+index++
  return name
}
async function chooseExternal(mode:'copy'|'attach'){
  const generation=draftGeneration
  busy.value=true;error.value=''
  try{
    const source=await (mode==='attach'?window.manager.chooseExistingInstanceDirectory():window.manager.chooseInstanceCopySource())
    if(source&&generation===draftGeneration){edit();editorFlow.value='direct';historyMode.value='copy';historySourceKind.value='directory';externalSource.value=source;sourceMode.value=mode;form.name=mode==='attach'?source.name.slice(0,120):copyName(source.name);generatedName=''}
  }catch(cause){error.value=String(cause)}finally{busy.value=false}
}
async function cancelCopy(){cancelCopyPreview();if(copyJob.value)await manager.execute(()=>window.manager.cancelInstanceCopy(copyJob.value!.id))}
async function chooseApplication() {
  if(await manager.execute(()=>window.manager.chooseInstanceApplication()))form.applicationId=availableApplications.value.at(-1)?.id ?? form.applicationId
}
function changeLaunchMode(){form.applicationId=availableApplications.value[0]?.id??'';form.workingDirectoryId=undefined}
async function chooseCli(){if(await manager.execute(()=>window.manager.chooseInstanceCli()))form.applicationId=availableApplications.value.at(-1)?.id??form.applicationId}
async function chooseWorkingDirectory(){
  try{const target=await window.manager.chooseInstanceWorkingDirectory();if(target){workingDirectories.value=await window.manager.listInstanceWorkingDirectories();form.workingDirectoryId=target.id}}catch(cause){error.value=String(cause)}
}
async function save(previewAfter=false) {
  if(manager.loading||busy.value||savingDraft.value)return
  savingDraft.value=true
  try{
  clearValidation();prepareName()
  const generation=draftGeneration,draft={...form,extraArgs:args.value.split('\n').map(value=>value.trim()).filter(Boolean)}
  if(!validHistorySource()){void focusField('history');return}
  if(!await ensureResource(generation)||!open.value||generation!==draftGeneration)return
  if(!validHistorySource()){void focusField('history');return}
  const parsed=validateDetails({...draft,accountId:form.accountId})
  if(!parsed?.success)return
  const details=parsed.data
  const source=copySource.value,external=externalSource.value
  if(external&&!sourceClosed.value)return
  const previousJobId=copyJob.value?.id
  const attach=attachingForm.value,previousIds=new Set(instances.value.map(instance=>instance.id)),editingId=editing.value?.id
  committing.value=true
  let savedOk=false
  try{savedOk=await manager.execute(()=>external?(attach?window.manager.attachExistingInstance({ticket:external.ticket,sourceClosed:true,details}):window.manager.copyExternalInstance({ticket:external.ticket,sourceClosed:true,details})):source?window.manager.copyInstance({id:source.id,revision:source.revision,details}):window.manager.saveInstance({id:editingId,revision:editing.value?.revision,details}))}
  finally{committing.value=false}
  if(savedOk&&open.value&&generation===draftGeneration) {
    closeEditor();message.success(attach?'已有目录已登记':source||external?'正在复制实例':'实例已保存')
    if(previewAfter&&(source||external)&&!attach){
      const job=copyJob.value
      if(job&&job.id!==previousJobId&&job.name===details.name&&(source?job.sourceId===source.id:job.sourceDirectory===external!.directory))pendingCopyPreview.value=job.id
      else error.value='复制已开始；完成后请在实例卡片中查看启动预览。'
    }else if(previewAfter&&!source&&!external){
      const saved=instances.value.find(instance=>editingId?instance.id===editingId:!previousIds.has(instance.id)&&instance.name===details.name)
      if(saved)await launch(saved)
    }
  }
  }finally{savingDraft.value=false}
}
async function launch(instance:InstanceView) {
  pendingCopyPreview.value=undefined
  const request=++launchRequest
  busy.value=true;error.value=''
  try {const result=await window.manager.previewInstanceLaunch({id:instance.id,revision:instance.revision});if(request===launchRequest)preview.value=result}catch(cause){if(request===launchRequest)error.value=String(cause)}finally{if(request===launchRequest)busy.value=false}

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
    <a-alert v-if="error&&!open&&!preview" type="error" :message="error" class="error-banner" />
    <a-card v-if="copyJob" class="instance-copy-job" size="small"><strong>{{copyJob.sourceName}} → {{copyJob.name}}</strong><p>{{copyJob.status==='scanning'?'正在检查来源':copyJob.status==='copying'?'正在复制文件':copyJob.status==='completed'?'副本已创建':copyJob.status==='cancelled'?'复制已取消':'复制未完成'}} · {{copyJob.files}} / {{copyJob.totalFiles}} 个文件 · {{size(copyJob.bytes)}} / {{size(copyJob.totalBytes)}}</p><a-progress v-if="copyRunning" :percent="copyJob.totalBytes?Math.min(99,Math.floor(copyJob.bytes/copyJob.totalBytes*100)):0" :show-info="false" /><p v-if="copyJob.skipped" class="muted">已排除 {{copyJob.skipped}} 项登录文件、后台状态或链接等非普通文件。</p><a-alert v-if="copyJob.error" :message="copyJob.error" type="error" /><a-space><a-button v-if="copyRunning" @click="cancelCopy">取消复制</a-button><template v-if="pendingCopyPreview===copyJob.id"><span class="muted">完成后打开启动预览</span><a-button type="link" @click="cancelCopyPreview">取消自动预览</a-button></template></a-space></a-card>
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
    <a-modal :open="open" class="instance-editor-dialog" :closable="!committing" :mask-closable="!committing" :keyboard="!committing" centered :width="740" :body-style="{maxHeight:`calc(100vh - ${wizard?(error||manager.error||historyError?320:240):(error||manager.error||historyError?260:180)}px)`,overflowY:'auto'}" @cancel="closeEditor">
      <template #title>
        <div class="instance-editor-title"><span>{{wizard?'创建实例':attachingForm?'使用已有目录':copyingForm?'复制实例':'编辑实例'}}</span><span v-if="wizard" class="instance-step-count">{{step+1}} / 4</span></div>
        <a-steps v-if="wizard" class="instance-wizard-steps" :current="step" size="small" :items="[{title:'客户端'},{title:'账号或供应商'},{title:'项目与配置'},{title:'确认'}]" />
      </template>
      <template #footer>
        <FormFeedback :error="error||manager.error||historyError" class="instance-form-feedback" />
        <div class="instance-footer-actions">
        <a-button :disabled="committing" @click="closeEditor">取消</a-button>
        <template v-if="wizard">
          <a-button v-if="step>0" :disabled="manager.loading||busy||historyLoading" @click="step--;clearValidation()">返回</a-button>
          <a-button v-if="step<3" type="primary" :loading="manager.loading||historyLoading" :disabled="busy||savingDraft" @click="nextStep">下一步</a-button>
          <template v-else><a-button :loading="manager.loading||savingDraft" :disabled="busy||copyingForm&&copyRunning" @click="save()">仅创建</a-button><a-button type="primary" :loading="manager.loading||savingDraft" :disabled="busy||copyingForm&&copyRunning" @click="save(true)">创建并预览</a-button></template>
        </template>
        <a-button v-else type="primary" :loading="manager.loading||savingDraft" :disabled="busy" @click="save()">{{editing?'保存':attachingForm?'登记实例':'创建副本'}}</a-button>
        </div>
      </template>
      <a-form layout="vertical" class="instance-editor" :class="{'instance-wizard':wizard}">
        <a-alert v-if="copyingForm&&!wizard" type="info" :message="'从“'+copySourceName+'”复制配置、会话和技能，并将副本内部的会话与模型目录路径指向新目录。文件登录令牌不复制，启动时使用下方绑定账号。项目分组与会话会复制，项目文件不会复制。'" class="instance-copy-explanation error-banner" />
        <a-alert v-if="attachingForm" class="instance-attach-explanation error-banner" type="info" message="直接使用所选目录，不复制文件。登记不会改写配置；启动时应用绑定账号和设置，停止后回收登录状态并恢复配置。移除实例会保留此目录。" />
        <div v-if="externalSource&&!wizard" class="external-copy-source"><p class="instance-path">{{attachingForm?'已有目录':'来源'}}：{{externalSource.directory}}</p><p class="muted">{{attachingForm?'请先关闭使用此目录的客户端；此实例运行时，不要再由其他客户端同时使用该目录。':'请先关闭使用此目录的客户端。来源保持不变；配置中的其他 API 密钥会随配置复制，链接会跳过。'}}</p><a-checkbox v-model:checked="sourceClosed" aria-label="来源客户端已关闭">我已关闭使用此目录的客户端</a-checkbox></div>
        <template v-if="copyingForm&&!wizard"><p v-if="historyLoading" class="muted">正在读取项目与会话概况…</p><a-alert v-if="historyError" type="error" :message="historyError" /><InstanceHistoryOverview v-if="chosenHistory" :history="chosenHistory" aria-label="所选会话概况" /></template>
        <section v-show="!wizard||step===0" class="instance-step" data-step="0">
          <a-form-item label="客户端"><a-select v-model:value="form.clientType" aria-label="实例客户端" :disabled="!!editing||copyingForm||attachingForm" :options="implementedAgentClients.map(item=>({value:item.id,label:item.name}))" /></a-form-item>
          <a-form-item label="运行方式"><a-segmented v-model:value="launchMode" aria-label="实例运行方式" :options="client.capabilities.launchModes.map(mode=>({value:mode,label:mode==='desktop'?'桌面应用':'CLI 终端'}))" @change="changeLaunchMode" /></a-form-item>
          <a-form-item data-field="applicationId" :validate-status="fieldErrors.applicationId?'error':undefined" :help="fieldErrors.applicationId" :label="launchMode==='cli'?'CLI 程序':'已安装应用'"><a-select v-model:value="form.applicationId" aria-label="实例应用" :options="availableApplications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" placeholder="选择已安装的程序" /><a-button v-if="launchMode==='desktop'" type="link" @click="chooseApplication">选择应用文件</a-button><a-button v-else type="link" @click="chooseCli">选择 CLI 程序</a-button></a-form-item>
          <p class="muted">当前已接入 Codex。新增客户端会沿用这套实例和资源管理流程。</p>
        </section>
        <section v-show="!wizard||step===1" class="instance-step" data-step="1">
          <a-form-item label="使用的资源"><a-radio-group v-model:value="resourceKind" aria-label="资源类型" :options="[{label:'账号',value:'account'},{label:'供应商密钥',value:'provider'}]" @change="resetResource" /></a-form-item>
          <template v-if="resourceKind==='account'">
            <a-form-item data-field="accountId" :validate-status="fieldErrors.accountId?'error':undefined" :help="fieldErrors.accountId" label="绑定账号"><a-select v-model:value="form.accountId" aria-label="实例账号" :options="identityAccounts.map(account=>({value:account.id,label:account.name}))" placeholder="选择兼容账号" @change="selectAccount" /><a-button class="instance-add-account" type="link" @click="addAccount"><PlusOutlined />添加账号</a-button></a-form-item>
            <p v-if="!identityAccounts.length" class="muted">没有兼容的登录账号，可在此添加后继续。</p>
          </template>
          <template v-else>
            <a-form-item data-field="accountId" :validate-status="fieldErrors.accountId?'error':undefined" :help="fieldErrors.accountId" label="供应商密钥"><a-select :value="supplierSelection||undefined" aria-label="实例供应商密钥" :options="supplierChoices.map(item=>({value:item.value,label:item.label,disabled:item.disabled}))" placeholder="选择兼容密钥" @change="selectSupplier(String($event))" /><a-button class="instance-add-provider" type="link" @click="providerOpen=true"><PlusOutlined />添加供应商</a-button></a-form-item>
            <p class="muted">引用已保存的密钥，多个兼容实例可复用。尚未启用的密钥会在继续时建立共享连接。</p>
            <p v-if="selectedSupplier?.reusingStandalone" class="muted instance-reused-connection">使用已有 API 连接「{{selectedSupplier.account?.name}}」，保留它的模型、上下文、服务等级和网络代理配置。</p>
          </template>
          <a-collapse ghost class="instance-connection-options"><a-collapse-panel key="connection" header="接入方式">
            <a-form-item label="账号接入方式"><a-select v-model:value="form.connectionMode" aria-label="实例接入方式" :options="[{value:'local_api',label:'本地 API'},{value:'native',label:'原生账号登录'}]" @change="resetResource" /></a-form-item>
            <p class="muted">{{form.connectionMode==='native'?'客户端使用此实例独立文件中的凭据。Agent Identity及非Responses密钥不支持此方式。':'管理器保管凭据，为此实例提供独立本地连接。支持兼容的Chat Completions供应商。'}}</p>
          </a-collapse-panel></a-collapse>
        </section>
        <section v-show="!wizard||step===2" class="instance-step" data-step="2">
          <div class="instance-basics-grid">
            <a-form-item data-field="name" :validate-status="fieldErrors.name?'error':undefined" :help="fieldErrors.name" label="实例名称"><a-input v-model:value="form.name" aria-label="实例名称" :maxlength="120" placeholder="自动生成，也可自行修改" /></a-form-item>
            <a-form-item v-if="client.capabilities.models" data-field="model" :validate-status="fieldErrors.model?'error':undefined" :help="fieldErrors.model" label="默认模型"><a-auto-complete v-model:value="form.model" :options="(selectedAccount?.models??[]).map(value=>({value}))"><a-input aria-label="实例模型" :maxlength="200" placeholder="选择模型或填写模型 ID" /></a-auto-complete></a-form-item>
          </div>
          <a-form-item v-if="client.capabilities.projectDirectoryModes.some(mode=>mode===launchMode)" label="项目目录"><a-select v-model:value="form.workingDirectoryId" aria-label="实例工作目录" allow-clear placeholder="使用实例的独立工作目录" :options="workingDirectories.map(item=>({value:item.id,label:item.path}))" /><a-button type="link" @click="chooseWorkingDirectory">选择工作目录</a-button></a-form-item>
          <section v-if="wizard" data-field="history" class="instance-history-choice" aria-label="会话来源选择">
            <div class="instance-section-heading"><strong>会话起点</strong><span>选择这次工作从哪里开始</span></div>
            <div class="instance-history-options" role="group" aria-label="实例会话来源">
              <button v-for="choice in historyChoices" :key="choice.value" type="button" :data-history-option="choice.value" :aria-label="choice.title" :aria-pressed="historyChoice===choice.value" :disabled="committing||busy" class="instance-history-option" :class="{selected:historyChoice===choice.value}" @click="selectHistoryChoice(choice.value)">
                <component :is="choice.icon" class="instance-choice-icon" aria-hidden="true" />
                <span><strong>{{choice.title}}</strong><small>{{choice.description}}</small></span>
                <CheckCircleFilled v-if="historyChoice===choice.value" class="instance-choice-check" aria-hidden="true" />
              </button>
            </div>
            <div v-if="historyMode==='empty'" class="instance-history-empty-note"><span>新实例将从空白会话开始，已有对话保持原样。</span></div>
            <div v-else class="instance-history-source-panel">
              <template v-if="historySourceKind==='instance'">
                <div class="instance-source-heading"><label for="instance-history-source">来源实例</label><span v-if="sourceReady" class="instance-source-status"><CheckCircleFilled />已读取</span></div>
                <a-select id="instance-history-source" :value="copySource?.id" aria-label="来源实例" class="instance-source-select" placeholder="选择已停止的实例" :disabled="committing" :options="compatibleSources.map(item=>({value:item.id,label:item.name+' · '+labels[item.status],disabled:item.status!=='stopped'||!!item.copying}))" @change="chooseHistoryInstance(String($event))" />
                <p v-if="!compatibleSources.length" class="instance-source-note">还没有可复制的实例，可以改选「从目录复制」。</p>
                <p v-else-if="!copySource" class="instance-source-note">选择一个已停止的实例，查看它的历史概况。</p>
              </template>
              <template v-else>
                <div class="instance-directory-picker">
                  <FolderOpenOutlined aria-hidden="true" />
                  <div><strong>{{externalSource?.name??'选择会话目录'}}</strong><p :title="externalSource?.directory">{{externalSource?.directory??'从其他工具的 Codex 会话目录导入'}}</p></div>
                  <a-button :loading="busy" :disabled="committing" @click="chooseHistoryDirectory">{{externalSource?'更换':'选择目录'}}</a-button>
                </div>
                <div v-if="externalSource" class="instance-source-closure"><a-checkbox v-model:checked="sourceClosed" aria-label="来源客户端已关闭">来源客户端已关闭，可以复制</a-checkbox><span>目录选择 5 分钟内有效，过期后需重新选择。</span></div>
              </template>
              <div v-if="historyLoading" class="instance-history-loading" role="status"><LoadingOutlined />正在读取项目与会话概况…</div>
              <a-alert v-if="historyError" type="error" :message="historyError" :show-icon="true" />
              <InstanceHistoryOverview v-if="chosenHistory&&!historyLoading" :history="chosenHistory" aria-label="所选会话概况" />
              <p class="instance-copy-retained"><CopyOutlined />复制后各自保存后续对话，原实例和原目录保留。</p>
            </div>
          </section>
          <p v-else-if="editing" class="muted instance-history-retained">此实例保留原有会话。要使用其他会话来源，请复制为新实例；编辑不会覆盖历史。</p>
          <div class="instance-config-hints">
            <span v-if="client.capabilities.contextWindow">上下文 {{contextLabel}}</span>
            <span v-if="launchMode==='desktop'">项目在 Codex 内选择</span>
            <span v-if="client.capabilities.fast&&launchMode==='desktop'&&form.connectionMode==='local_api'">速度在 Codex 内切换</span>
          </div>
          <a-collapse v-model:active-key="advanced" ghost class="instance-advanced"><a-collapse-panel key="advanced" header="高级设置">
            <a-form-item v-if="client.capabilities.fast" :label="launchMode==='desktop'&&form.connectionMode==='local_api'?'首次启动速度':'默认服务等级'"><a-select v-model:value="form.defaultTier" aria-label="实例服务等级" :options="[{value:'inherit',label:'继承账号与全局'},{value:'follow',label:'跟随请求'},{value:'standard',label:'普通 · Standard'},{value:'fast',label:'Fast'},{value:'auto',label:'Auto'},{value:'flex',label:'Flex'}]" /><p class="muted">显式请求等级优先；桌面模式后续保留客户端选择。原生模式取决于客户端是否发送。</p></a-form-item>
            <a-form-item data-field="extraArgs" :validate-status="fieldErrors.extraArgs?'error':undefined" :help="fieldErrors.extraArgs" label="附加启动参数" extra="每行一个参数；实例隔离由管理器负责。"><a-textarea v-model:value="args" :rows="3" aria-label="实例附加参数" /></a-form-item>
          </a-collapse-panel></a-collapse>
        </section>
        <section v-if="wizard&&step===3" class="instance-step instance-confirm" data-step="3">
          <a-descriptions :column="1" bordered size="small"><a-descriptions-item label="客户端">{{client.name}} · {{launchMode==='cli'?'CLI 终端':'桌面应用'}}</a-descriptions-item><a-descriptions-item label="资源">{{resourceLabel}}</a-descriptions-item><a-descriptions-item label="实例">{{form.name}}</a-descriptions-item><a-descriptions-item label="会话来源">{{historyMode==='copy'?'复制 · '+historySourceLabel:'空白会话'}}</a-descriptions-item><a-descriptions-item label="项目">{{launchMode==='cli'?(workingDirectories.find(item=>item.id===form.workingDirectoryId)?.path??'独立工作目录'):'启动后在 Codex 中选择'}}</a-descriptions-item><a-descriptions-item label="模型">{{form.model}}</a-descriptions-item><a-descriptions-item v-if="client.capabilities.contextWindow" label="上下文默认值">{{contextLabel}}</a-descriptions-item><a-descriptions-item label="接入方式">{{modeName(form.connectionMode)}}</a-descriptions-item></a-descriptions>
<InstanceHistoryOverview v-if="chosenHistory" :history="chosenHistory" aria-label="所选会话概况" />
          <p class="muted">{{historyMode==='copy'?'复制完成后查看项目分组与实际启动预览，确认后才启动客户端。':'创建后查看实际启动预览，确认后才启动客户端。'}}</p>
        </section>
      </a-form>
    </a-modal>
    <InstanceProviderDialog v-model:open="providerOpen" :client-type="form.clientType" @created="providerCreated" />
    <a-modal :open="!!preview" centered :body-style="{maxHeight:'calc(100vh - 220px)',overflowY:'auto'}" title="确认实例启动" :width="700" ok-text="启动实例" cancel-text="取消" @ok="start" @cancel="closePreview">
      <a-alert v-if="preview?.externalHome" class="error-banner" type="info" message="此实例直接使用已有目录。启动会更新该目录的账号连接与配置，停止后恢复；请确认其他客户端已关闭。" />
      <InstanceHistoryOverview v-if="preview?.history" :history="preview.history" aria-label="启动会话概况" />
      <p v-if="preview?.history" class="muted instance-history-launch-note">统计目录内已保存的主会话，包含归档；客户端可能根据当前连接筛选会话。要使用其他历史，请取消并创建实例，选择「从实例复制」或「从目录复制」；当前实例的历史保持不变。</p>
      <a-descriptions v-if="preview" :column="1" bordered size="small" class="instance-launch-preview"><a-descriptions-item label="实例">{{ preview.name }}</a-descriptions-item><a-descriptions-item label="客户端">{{preview.clientType==='codex'?'Codex':'尚未接入'}}</a-descriptions-item><a-descriptions-item label="应用">{{ preview.application }}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode==='cli' && preview.executable!==preview.application" label="实际程序">{{preview.executable}}</a-descriptions-item><a-descriptions-item label="配置与会话">{{ preview.directory }}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode!=='cli'" label="桌面数据">{{ preview.desktopDirectory }}</a-descriptions-item><a-descriptions-item v-else label="CLI 工作目录">{{preview.workingDirectory}}</a-descriptions-item><a-descriptions-item label="账号与模型">{{ preview.accountName }} · {{ preview.model }}</a-descriptions-item><a-descriptions-item label="供应商名称">{{preview.providerName}}</a-descriptions-item><a-descriptions-item v-if="preview.effectiveContextWindow" label="默认模型上下文">{{formatModelContextWindow(preview.effectiveContextWindow)}}<span class="muted"> · {{contextSourceName(preview.contextWindowSource)}}</span></a-descriptions-item><a-descriptions-item v-if="preview.effectiveAutoCompactTokenLimit" label="自动压缩阈值">{{formatModelContextWindow(preview.effectiveAutoCompactTokenLimit)}}</a-descriptions-item><a-descriptions-item v-if="preview.launchMode!=='cli'" label="语言偏好">{{localeLabel(preview.desktopLocale,preview.desktopLocaleSource,preview.desktopEffectiveLocale)}}<span v-if="preview.desktopLocale" class="muted"> · 保留已有选择</span></a-descriptions-item><a-descriptions-item v-if="preview.desktopLocaleCompatibilityAvailable!==undefined" label="页面语言">{{preview.desktopLocaleCompatibilityAvailable?'使用 Codex 内置翻译':preview.desktopLocaleCompatibilityReason}}</a-descriptions-item><a-descriptions-item :label="preview.speedMenuAvailable?'启动时速度':'默认服务等级'">{{ preview.speedMenuAvailable?initialSpeedName(preview.tier):tierName(preview.tier) }}</a-descriptions-item><a-descriptions-item v-if="preview.speedMenuAvailable!==undefined" label="对话速度">{{preview.speedMenuAvailable?'在 Codex 中选择普通 / Fast':preview.speedMenuReason}}<span v-if="preview.speedMenuAvailable" class="muted"> · 由客户端适配提供，实际是否支持由上游响应决定</span></a-descriptions-item><a-descriptions-item v-if="preview.args.length" label="附加参数"><pre>{{ preview.args.join('\n') }}</pre></a-descriptions-item></a-descriptions>
      <p class="muted" v-if="preview && preview.launchMode!=='cli'">新实例默认自动检测电脑语言，之后保留你在 Codex 中的选择。已适配客户端使用内置翻译；未知版本保留原界面。</p>
      <p class="muted" v-if="preview?.launchMode==='cli'">将在 macOS Terminal 中打开独立 CLI 会话。附加参数可覆盖默认模型或窗口；上方窗口值对应实例默认模型。停止实例或退出管理器会结束此会话；工作目录中的文件保留。</p>
      <p class="muted" v-if="preview?.connectionMode==='native'">原生账号登录：凭据仅写入此实例的独立文件目录，客户端维护登录。停止后先保存最新令牌，再恢复原登录和配置；会话保留。此模式不生成本地网关调用记录，配置等级不代表上游已收到。</p>
      <p class="muted" v-else>本地 API：启动会创建独立连接，并备份、应用模型与连接配置。停止后恢复原配置；会话和工作文件保留。请求中的显式等级优先。</p>
      <a-alert v-if="manager.error" type="error" :message="manager.error" />
    </a-modal>
  </section>
</template>

<style scoped>
.instance-footer-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.instance-form-feedback{text-align:left}
.instance-copy-job{margin-bottom:18px}.instance-copy-job p{margin:8px 0}.instance-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:18px}.instance-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:20px}.instance-name{display:flex;align-items:center;gap:10px;font-size:17px;min-width:0}.instance-name strong{overflow-wrap:anywhere}.instance-path{font-size:12px;opacity:.65;overflow-wrap:anywhere;margin:10px 0}.instance-note{font-size:12px;margin-top:24px;line-height:1.8}.instance-launch-preview{overflow-wrap:anywhere}.instance-launch-preview pre{white-space:pre-wrap}
 .instance-editor-title{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-right:28px;font-size:19px;font-weight:650;letter-spacing:-.02em}
.instance-step-count{font-size:12px;font-weight:500;letter-spacing:0;opacity:.5}
.instance-basics-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.instance-section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;font-size:14px}
.instance-section-heading>span{font-size:12px;opacity:.55}
.instance-history-choice{margin:2px 0 16px}
.instance-history-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.instance-history-option{position:relative;display:flex;align-items:center;gap:10px;min-height:74px;padding:12px;appearance:none;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;transition:border-color 120ms,background-color 120ms}
.instance-history-option>span:not(.instance-choice-icon){min-width:0;display:grid;gap:5px}
.instance-history-option strong{font-size:13px;font-weight:600;line-height:1.3;white-space:nowrap}
.instance-history-option small{font-size:12px;line-height:1.35;opacity:.55;white-space:nowrap}
.instance-history-option:hover:not(:disabled){background:color-mix(in srgb,currentColor 3%,transparent);border-color:#a78bfa}
.instance-history-option.selected{border-color:#8b5cf6;background:rgba(124,58,237,.055)}
.instance-history-option:focus-visible{outline:2px solid #8b5cf6;outline-offset:3px}
.instance-history-option:active:not(:disabled){background:rgba(124,58,237,.1)}
.instance-history-option:disabled{opacity:.5;cursor:default}
.instance-choice-icon{font-size:18px;opacity:.58;flex-shrink:0}
.instance-history-option.selected .instance-choice-icon{color:#8b5cf6;opacity:1}
.instance-choice-check{position:absolute;top:8px;right:8px;color:#8b5cf6;font-size:12px}
.instance-history-source-panel{margin-top:16px}
.instance-history-overview{margin:12px 0}
.instance-source-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:7px}
.instance-source-heading label{font-weight:550}
.instance-source-status{display:flex;align-items:center;gap:5px;color:#38966b;font-size:12px}
.instance-source-select{width:100%}
.instance-source-note,.instance-copy-retained,.instance-history-empty-note{font-size:12px;line-height:1.55;opacity:.65}
.instance-source-note{margin:9px 0 0}
.instance-copy-retained{display:flex;align-items:center;gap:7px;margin:10px 0 0}
.instance-history-empty-note{padding:12px 1px 0}
.instance-history-loading{display:flex;align-items:center;justify-content:center;gap:8px;min-height:90px;font-size:13px;opacity:.65}
.instance-directory-picker{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:10px}
.instance-directory-picker>.anticon{font-size:22px;color:#8b5cf6}
.instance-directory-picker>div{flex:1;min-width:0}
.instance-directory-picker strong{font-size:13px;font-weight:550}
.instance-directory-picker p{margin:4px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.6}
.instance-source-closure{display:flex;flex-direction:column;gap:5px;margin-top:12px}
.instance-source-closure>span{padding-left:24px;font-size:12px;opacity:.6}
.instance-config-hints{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;opacity:.65;margin:12px 0 4px}
.instance-config-hints>span+span:before{content:'·';margin-right:14px;opacity:.5}
.instance-history-launch-note{font-size:12px;line-height:1.6;opacity:.65}
@media(max-width:660px){.instance-basics-grid{grid-template-columns:1fr;gap:0}.instance-history-options{gap:7px}.instance-history-option{padding:12px 9px;gap:7px}.instance-history-option small{white-space:normal}.instance-section-heading{align-items:flex-start;flex-direction:column;gap:3px}}
@media(prefers-reduced-motion:reduce){.instance-history-option{transition:none}}

</style>

<style scoped>
.instance-launch-preview :deep(.ant-descriptions-item-label){min-width:128px;white-space:nowrap}
.instance-editor .ant-form-item:last-of-type{margin-bottom:0}
.external-copy-source{margin-bottom:20px}
</style>

<style scoped>
.instance-wizard-steps{margin:16px 0 8px;padding-right:6px}.instance-step{min-width:0}.instance-step>.muted{font-size:12px;line-height:1.8}.instance-step .ant-form-item{margin-bottom:18px}.instance-confirm{margin:12px 0}.instance-confirm :deep(.ant-descriptions-item-content){overflow-wrap:anywhere}.instance-advanced{margin-top:14px}.instance-context-default{padding:10px 12px;border-radius:8px;background:var(--subtle)}.instance-connection-options :deep(.ant-collapse-header){padding-inline:0}.instance-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))}
</style>
