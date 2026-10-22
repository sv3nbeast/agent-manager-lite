<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted} from 'vue'
import {message} from 'ant-design-vue'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {SessionPage,SessionRecord,SessionTokenResult,SessionLocation,SessionSource} from '../../../shared/sessions'
import SessionTransferPanel from './SessionTransferPanel.vue'
import SessionArchivePanel from './SessionArchivePanel.vue'
import SessionSyncPanel from './SessionSyncPanel.vue'
import SessionTrashPanel from './SessionTrashPanel.vue'
import SessionVisibilityRepairPanel from './SessionVisibilityRepairPanel.vue'
import SessionContentPanel from './SessionContentPanel.vue'
import SessionResumePanel from './SessionResumePanel.vue'
import DefaultClaudeResumePanel from './DefaultClaudeResumePanel.vue'
import {useManager} from '../store'

const emit=defineEmits<{showInstances:[]}>()
const manager=useManager()
const targets=ref<ClientConfigTarget[]>([]),targetId=ref<string>(),clientType=ref<'all'|'codex'|'claude_code'>('all'),projectQuery=ref(''),title=ref(''),content=ref(''),kind=ref<'all'|'conversation'|'external'|'subagent'>('all')
const reader=ref<{record:SessionRecord;targetId:string}>(),resuming=ref<{record:SessionRecord;targetId:string}>(),defaultResuming=ref<{record:SessionRecord;targetId:string}>(),resumedInstanceId=ref<string>(),defaultResumeNotice=ref('')
const resumedInstance=computed(()=>manager.data?.instances?.find(instance=>instance.id===resumedInstanceId.value))
const resumedStatus=computed(()=>{const instance=resumedInstance.value;if(!instance)return '';return instance.error?'会话恢复失败':instance.status==='running'?'会话已在原实例启动':instance.status==='stopped'?'会话实例已退出':'正在准备会话实例…'})
const result=ref<SessionPage>(),busy=ref(false),readingTokens=ref(false),error=ref(''),tokens=ref<Record<string,SessionTokenResult>>({}),knownRecords=ref<Record<string,SessionRecord>>({}),visibilityRepairOpen=ref(false)
const choosing=ref<{record:SessionRecord;action:'location'|'file'}>(),selectedTarget=ref<string>()
const selectedIds=ref<string[]>([])
const sourceCounts=ref<Record<string,number>>({})
const catalogSources=ref<SessionSource[]>()
const sources=computed(()=>catalogSources.value??targets.value.map(target=>({...target,clientType:'codex' as const})))
const sourceOptions=computed(()=>sources.value.filter(target=>(clientType.value==='all'||target.clientType===clientType.value)&&(target.id===targetId.value||target.role!=='default'||sourceCounts.value[target.id]!==0)).map(target=>({value:target.id,label:target.name,...sourceCounts.value[target.id]===undefined?{}:{count:sourceCounts.value[target.id]},directory:target.directory,description:target.description})))
const sourceDescription=computed(()=>sources.value.find(target=>target.id===targetId.value)?.description)
const claudeOnly=computed(()=>clientType.value==='claude_code'||sources.value.find(target=>target.id===targetId.value)?.clientType==='claude_code')
const hasClaude=computed(()=>claudeOnly.value||result.value?.items.some(record=>record.clientType==='claude_code'))
const clientName=(record:SessionRecord)=>record.clientType==='claude_code'?(record.launchMode==='desktop'?'Claude Desktop · Code':'Claude Code CLI'):'Codex'
const canResume=(record:SessionRecord)=>record.resumeMode==='managed'&&record.capabilities?.resume===true&&!record.locations.some(location=>location.running)&&!['preparing','starting','running','stopping'].includes(manager.data?.instances?.find(instance=>record.locations.some(location=>location.targetId===instance.id))?.status??'')
const canDefaultFork=(record:SessionRecord)=>record.resumeMode==='default_fork'&&record.capabilities?.resume===true
const resumeReason=(record:SessionRecord)=>!canResume(record)&&record.resumeMode==='managed'&&record.capabilities?.resume?'实例正在运行或准备启动，请在对应实例终端中使用 /resume 恢复会话。':record.resumeBlockedReason
const codexSelectedIds=computed(()=>selectedIds.value.filter(id=>knownRecords.value[id]?.clientType!=='claude_code'))
const tokenIds=computed(()=>(selectedIds.value.length?selectedIds.value:result.value?.items.map(item=>item.id)??[]).filter(id=>knownRecords.value[id]?.capabilities?.tokens!==false))
const locationExplanation=(location:SessionLocation,record?:SessionRecord)=>record?.clientType==='claude_code'?'同一实例存在多个相同 ID 的 Claude 会话文件，已按来源分别展示。恢复前请先核对文件。':location.ambiguous?'此目录有多个同 ID 记录，客户端索引未能明确当前文件。保留全部文件，避免打开或复制错误版本。':location.historyMode==='paginated'?'Codex 将这段长对话分段保存。按客户端索引打开当前分段，其他分段仍完整保留；复制完整对话请从实例页面复制。':'按客户端索引打开当前文件，其他历史版本仍完整保留。'
function selectRows(keys:(string|number)[]){if(keys.length>1000)message.warning('每次最多选择 1000 个会话');selectedIds.value=keys.slice(0,1000).map(String).filter(id=>knownRecords.value[id]?.clientType!=='claude_code')}
function remember(items:SessionRecord[]){for(const item of items)knownRecords.value[item.id]=item}
watch(clientType,()=>{const selected=sources.value.find(source=>source.id===targetId.value);if(selected&&clientType.value!=='all'&&selected.clientType!==clientType.value)targetId.value=undefined;selectedIds.value=[]})
let runId:string|undefined,generation=0,alive=true
const kindNames={conversation:'对话',external:'外部',subagent:'子代理'}
const date=(value?:number)=>value?new Date(value).toLocaleString():'未知'
const amount=(value?:number)=>value===undefined?'未知':value.toLocaleString()
async function reload(){
  const current=++generation,id=crypto.randomUUID();runId=id;busy.value=true;error.value='';result.value=undefined;tokens.value={};knownRecords.value={};choosing.value=undefined;selectedIds.value=[];reader.value=undefined;resuming.value=undefined
  try{const next=await window.manager.scanSessions({runId:id,targetId:targetId.value,clientType:clientType.value,projectQuery:projectQuery.value,titleQuery:title.value,contentQuery:content.value,kind:kind.value});if(alive&&current===generation){result.value=next;catalogSources.value=next.sources;sourceCounts.value={...sourceCounts.value,...next.sourceCounts};remember(next.items)}}
  catch(cause){if(alive&&current===generation)error.value=String(cause)}
  finally{if(current===generation){busy.value=false;runId=undefined}}
}
async function cancel(){if(runId)await window.manager.cancelSessionScan(runId)}
async function page(number:number){
  if(!result.value)return
  const current=++generation;busy.value=true;error.value=''
  try{const next=await window.manager.sessionPage({snapshotId:result.value.snapshotId,page:number,pageSize:25});if(alive&&current===generation){result.value=next;catalogSources.value=next.sources;remember(next.items)}}
  catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(current===generation)busy.value=false}
}
async function chooseDirectory(){clientType.value='all';try{const target=await window.manager.chooseClientConfig();if(target){targets.value=await window.manager.listClientConfigs();targetId.value=target.id;await reload()}}catch(cause){error.value=String(cause)}}
async function readTokens(){
  const snapshot=result.value;if(!snapshot?.items.length)return
  const ids=[...new Set(tokenIds.value)];if(!ids.length)return
  readingTokens.value=true;error.value=''
  try{const values=await window.manager.sessionTokenStats({snapshotId:snapshot.snapshotId,sessionIds:ids});if(alive&&result.value?.snapshotId===snapshot.snapshotId)for(const value of values)tokens.value[value.id]=value}
  catch(cause){if(alive&&result.value?.snapshotId===snapshot.snapshotId)error.value=String(cause)}finally{readingTokens.value=false}
}
async function cancelTokens(){if(result.value)await window.manager.cancelSessionTokens(result.value.snapshotId)}
function viewContent(record:SessionRecord){if(!result.value||!record.capabilities?.content||record.locations.length!==1)return;reader.value={record,targetId:record.locations[0].targetId}}
function resume(record:SessionRecord){if(!result.value||!canResume(record)||record.locations.length!==1)return;reader.value=undefined;resuming.value={record,targetId:record.locations[0].targetId}}
function forkDefault(record:SessionRecord){if(!result.value||!canDefaultFork(record)||record.locations.length!==1)return;reader.value=undefined;defaultResumeNotice.value='';defaultResuming.value={record,targetId:record.locations[0].targetId}}
function defaultResumeStarted(){defaultResuming.value=undefined;defaultResumeNotice.value='已将新分叉会话交给 Terminal。它使用本机默认 Claude Code 身份；管理器不会控制该终端进程。'}
function resumeStarted(instanceId:string){resumedInstanceId.value=instanceId;void reload()}
function open(record:SessionRecord,action:'location'|'file'){
  choosing.value={record,action};selectedTarget.value=record.locations.length===1?record.locations[0].targetId:undefined
  if(record.locations.length===1&&(!record.locations[0].ambiguous||record.clientType==='claude_code'))void confirmOpen()
}
async function copyId(record:SessionRecord){
  const snapshot=result.value,targetId=record.locations[0]?.targetId
  if(!snapshot||!targetId)return
  try{await window.manager.copySessionId({snapshotId:snapshot.snapshotId,sessionId:record.id,targetId});message.success({content:'会话 ID 已复制',key:'session-copy-id'})}
  catch(cause){error.value=String(cause)}
}
async function confirmOpen(){
  if(!result.value||!choosing.value||!selectedTarget.value)return
  const choice=choosing.value
  try{await window.manager.openSession({snapshotId:result.value.snapshotId,sessionId:choice.record.id,targetId:selectedTarget.value,action:choice.action});if(choosing.value===choice)choosing.value=undefined}
  catch(cause){error.value=String(cause);choosing.value=undefined}
}
onMounted(async()=>{try{targets.value=await window.manager.listClientConfigs();if(alive)await reload()}catch(cause){if(alive)error.value=String(cause)}})
onUnmounted(()=>{alive=false;generation++;if(runId)void window.manager.cancelSessionScan(runId);if(result.value)void window.manager.cancelSessionTokens(result.value.snapshotId)})
const reportIds=computed(()=>selectedIds.value.length?[...new Set(selectedIds.value)]:result.value?.items.map(item=>item.id)??[])
type ReportRow={id:string;title:string;project:string;total:number|undefined;input:number|undefined;output:number|undefined;error:string|undefined}
const reportRows=computed<ReportRow[]>(()=>reportIds.value.flatMap(id=>{const record=knownRecords.value[id]??result.value?.items.find(item=>item.id===id);const value=tokens.value[id];return record&&value?[{id,title:record.title,project:record.projectName||record.cwd,total:value.tokens?.total,input:value.tokens?.input,output:value.tokens?.output,error:value.error}]:[]}))
const projectReport=computed(()=>{const grouped=new Map<string,{project:string;sessions:number;known:number;input:number;output:number;total:number}>();for(const row of reportRows.value){const current=grouped.get(row.project)??{project:row.project,sessions:0,known:0,input:0,output:0,total:0};current.sessions++;if(row.total!==undefined){current.known++;current.input+=row.input??0;current.output+=row.output??0;current.total+=row.total}grouped.set(row.project,current)}return [...grouped.values()].sort((a,b)=>b.total-a.total||a.project.localeCompare(b.project))})
const reportScope=computed(()=>selectedIds.value.length?`已选 ${selectedIds.value.length} 个会话`:`当前页 ${result.value?.items.length??0} 个会话`)
</script>

<template>
  <section class="sessions-panel">
    <div class="page-heading"><div><h1>会话</h1><p>按客户端、项目和来源查找会话，查看 Claude 对话并继续 CLI 会话。</p></div><a-space><a-button v-if="!claudeOnly" :disabled="busy" @click="chooseDirectory">选择会话目录</a-button><a-button v-if="!claudeOnly" :disabled="busy" @click="visibilityRepairOpen=true">修复可见性</a-button><a-button v-if="busy&&runId" @click="cancel">取消读取</a-button><a-button v-else type="primary" :loading="busy" @click="reload">刷新会话</a-button></a-space></div>
    <a-alert v-if="error" type="error" :message="error" class="error-banner" />
    <a-alert v-if="resumedInstance" :type="resumedInstance.error?'error':resumedInstance.status==='running'?'success':'info'" :message="resumedStatus" class="error-banner session-resume-status"><template #description><span>{{resumedInstance.name}}<template v-if="resumedInstance.error"> · {{resumedInstance.error}}</template></span><a-button type="link" @click="emit('showInstances')">查看实例</a-button></template></a-alert>
    <a-alert v-if="defaultResumeNotice" type="success" :message="defaultResumeNotice" class="error-banner" />
    <a-card class="session-filters" size="small">
      <a-form layout="vertical" :model="{targetId,clientType,projectQuery,title,content,kind}" @finish="reload"><div class="session-filter-grid">
        <a-form-item label="客户端"><a-select v-model:value="clientType" aria-label="会话客户端" :disabled="busy" :options="[{value:'all',label:'全部客户端'},{value:'codex',label:'Codex'},{value:'claude_code',label:'Claude'}]" /></a-form-item>
        <a-form-item label="来源目录" :extra="sourceDescription"><a-select v-model:value="targetId" aria-label="会话来源" allow-clear placeholder="全部会话来源" :disabled="busy" :options="sourceOptions" :dropdown-match-select-width="480"><template #option="option"><div class="session-source-name">{{option.label}}<span v-if="option.count!==undefined" class="muted">{{option.count}} 个会话</span></div><div v-if="option.description" class="muted session-source-detail">{{option.description}}</div><div class="muted session-source-path" :title="option.directory">{{option.directory}}</div></template></a-select></a-form-item>
        <a-form-item label="类型"><a-select v-model:value="kind" aria-label="会话类型" :disabled="busy" :options="[{value:'all',label:'全部'},{value:'conversation',label:'对话'},{value:'external',label:'外部'},{value:'subagent',label:'子代理'}]" /></a-form-item>
        <a-form-item label="项目目录"><a-input v-model:value="projectQuery" aria-label="会话项目搜索" placeholder="按项目名称或路径筛选" :maxlength="4096" :disabled="busy" allow-clear /></a-form-item>
        <a-form-item label="标题 / 会话 ID"><a-input v-model:value="title" aria-label="会话标题搜索" placeholder="按会话标题或 ID 搜索" :maxlength="200" :disabled="busy" allow-clear /></a-form-item>
        <a-form-item label="文件内容"><a-input v-model:value="content" aria-label="会话内容搜索" placeholder="搜索会话中的文本" :maxlength="200" :disabled="busy" allow-clear /></a-form-item>
      </div><a-button html-type="submit" :disabled="busy">应用筛选</a-button><span class="muted session-filter-note">可组合客户端、来源、项目与文本筛选。Codex 类型按标题和工作目录识别。</span></a-form>
    </a-card>
    <a-alert v-if="result?.warnings.length" type="warning" class="error-banner"><template #message>会话读取提示</template><template #description><ul><li v-for="warning in result.warnings" :key="warning">{{warning}}</li></ul></template></a-alert>
    <a-alert v-if="hasClaude" type="info" message="Claude CLI 支持本地对话浏览。受管实例停止后可在原配置中恢复；本机默认目录可在 Terminal 中创建新分叉。Desktop 仅展示本地 Code 记录，Chat / Cowork 历史请在客户端查看。" class="error-banner" />
    <template v-if="!claudeOnly">
      <p v-if="hasClaude" class="muted session-codex-tools-note">以下批量管理与用量功能适用于 Codex，会话选择框仅选择 Codex 记录。</p>
      <SessionTransferPanel :targets="targets" :snapshot-id="result?.snapshotId" :selected-ids="codexSelectedIds" :reading="busy" @completed="reload" />
      <SessionArchivePanel :targets="targets" :snapshot-id="result?.snapshotId" :selected-ids="codexSelectedIds" :reading="busy" @completed="reload" />
      <SessionSyncPanel :targets="targets" :reading="busy" @completed="reload" />
      <SessionTrashPanel :snapshot-id="result?.snapshotId" :selected-ids="codexSelectedIds" :reading="busy" @completed="reload" />
    </template>
    <div class="toolbar"><span>{{result?.total??0}} 个会话</span><span class="muted">{{result?'读取于 '+date(result.scannedAt):busy?'正在读取目录…':'尚未读取'}}</span><span class="toolbar-spacer" /><a-button v-if="readingTokens" @click="cancelTokens">取消用量读取</a-button><a-button v-else-if="!claudeOnly" :disabled="busy||!tokenIds.length" @click="readTokens">{{selectedIds.length?'读取所选用量':'读取本页用量'}}</a-button></div>
    <a-card v-if="reportRows.length" title="会话用量报表" class="session-report"><template #extra><span class="muted">{{reportScope}} · 已读取 {{reportRows.length}} 个</span></template><a-tabs><a-tab-pane key="sessions" tab="逐会话"><a-table size="small" :data-source="reportRows" :pagination="false" row-key="id" :scroll="{x:760}"><a-table-column key="title" title="会话" :width="260"><template #default="{record}"><div>{{record.title}}</div><small class="muted">{{record.project}}</small></template></a-table-column><a-table-column key="input" title="输入 Token"><template #default="{record}">{{record.input===undefined?'未知':record.input.toLocaleString()}}</template></a-table-column><a-table-column key="output" title="输出 Token"><template #default="{record}">{{record.output===undefined?'未知':record.output.toLocaleString()}}</template></a-table-column><a-table-column key="total" title="总 Token"><template #default="{record}">{{record.total===undefined?'未知':record.total.toLocaleString()}}</template></a-table-column></a-table></a-tab-pane><a-tab-pane key="projects" tab="按项目"><a-table size="small" :data-source="projectReport" :pagination="false" row-key="project"><a-table-column key="project" title="项目"><template #default="{record}">{{record.project}}</template></a-table-column><a-table-column key="sessions" title="会话数" data-index="sessions" /><a-table-column key="known" title="已知用量" data-index="known" /><a-table-column key="total" title="总 Token"><template #default="{record}">{{record.known?record.total.toLocaleString():'未知'}}</template></a-table-column></a-table></a-tab-pane></a-tabs></a-card>
    <a-spin :spinning="busy"><a-empty v-if="!busy&&!result?.items.length" description="没有找到会话。启动实例产生历史后刷新，或调整来源与筛选条件。" />
      <a-table v-else row-key="id" class="sessions-table" :data-source="result?.items??[]" :row-selection="claudeOnly?undefined:{selectedRowKeys:selectedIds,onChange:selectRows,preserveSelectedRowKeys:true,getCheckboxProps:(record:SessionRecord)=>({disabled:busy||record.capabilities?.transfer===false})}" :pagination="false" :scroll="{x:1020}" size="middle">
        <a-table-column key="title" title="会话 / 项目" :width="360"><template #default="{record}"><a-button v-if="record.capabilities?.content" type="link" class="session-title session-title-link" @click="viewContent(record)">{{record.title}}</a-button><div v-else class="session-title">{{record.title}}</div><div class="muted session-meta">{{record.projectName||record.cwd}} <a-tag>{{kindNames[record.kind as keyof typeof kindNames]}}</a-tag><a-tag>{{clientName(record)}}</a-tag></div><div class="muted session-id">{{record.sourceSessionId||record.id}}</div><div v-if="record.messageCount!==undefined" class="muted session-meta">{{record.messageCount}} 条消息<template v-if="record.model"> · {{record.model}}</template></div></template></a-table-column>
        <a-table-column key="locations" title="来源 / 所在目录" :width="220"><template #default="{record}"><div v-for="location in record.locations" :key="location.targetId" class="session-location" :title="location.directory">{{location.name}}<a-tag v-if="location.archived">已归档</a-tag><a-tag v-if="location.running" color="green">运行中</a-tag><a-tooltip v-if="location.ambiguous" :title="locationExplanation(location,record)"><a-tag color="orange">多个版本待核对</a-tag></a-tooltip><a-tooltip v-else-if="location.historyMode==='paginated'||location.historicalCopies" :title="locationExplanation(location,record)"><a-tag>{{location.historyMode==='paginated'?'分段记录 · '+((location.historicalCopies??0)+1):'历史副本 · '+location.historicalCopies}}</a-tag></a-tooltip></div></template></a-table-column>
        <a-table-column key="time" title="最近活动" :width="165"><template #default="{record}">{{date(record.updatedAt)}}</template></a-table-column>
        <a-table-column v-if="!claudeOnly" key="tokens" title="Token 用量" :width="170"><template #default="{record}"><span v-if="record.capabilities?.tokens===false" class="muted">暂不支持</span><template v-else-if="tokens[record.id]?.tokens"><strong>{{amount(tokens[record.id].tokens?.total)}}</strong><div class="muted session-meta">输入 {{amount(tokens[record.id].tokens?.input)}}<br>输出 {{amount(tokens[record.id].tokens?.output)}}</div></template><span v-else class="muted" :title="tokens[record.id]?.error">{{tokens[record.id]?.error?'读取失败':tokens[record.id]?'未知':'未读取'}}</span></template></a-table-column>
        <a-table-column key="actions" title="操作" :width="180"><template #default="{record}"><a-button v-if="record.capabilities?.content" type="link" size="small" @click="viewContent(record)">查看对话</a-button><a-button v-if="canResume(record)" type="link" size="small" @click="resume(record)">恢复到原实例</a-button><a-button v-else-if="canDefaultFork(record)" type="link" size="small" @click="forkDefault(record)">在 Terminal 中分叉</a-button><div v-else-if="resumeReason(record)" class="muted session-resume-reason">{{resumeReason(record)}}</div><a-button type="link" size="small" @click="open(record,'location')">打开位置</a-button><a-button type="link" size="small" @click="open(record,'file')">打开会话文件</a-button><a-button type="link" size="small" @click="copyId(record)">复制 ID</a-button></template></a-table-column>
      </a-table>
    </a-spin>
    <a-pagination v-if="result&&result.total>25" :current="result.page" :total="result.total" :page-size="25" :show-size-changer="false" :disabled="busy" class="pagination" @change="page" />
    <p v-if="!claudeOnly" class="muted session-note">扫描已登记目录和本机默认 ~/.codex；默认目录仅用于浏览、搜索、打开和读取用量，不会作为配置、复制、同步、删除或修复目标。Codex 长对话可能分段保存；客户端索引能确认当前文件时显示“分段记录”，保留其他分段。只有多个不同版本且无法确认当前文件时，才显示“多个版本待核对”。复制与 ZIP 导入保留目标已有会话；分页历史请从实例页面复制完整会话。Token 来自当前会话文件的累计记录；未记录时显示未知。全目录同步保留原文件备份；可用“修复可见性”检查历史会话不显示的问题。</p>
    <a-modal :open="!!choosing" title="选择会话所在目录" ok-text="继续" cancel-text="取消" :ok-button-props="{disabled:!selectedTarget||choosing?.record.clientType!=='claude_code'&&choosing?.record.locations.find(value=>value.targetId===selectedTarget)?.ambiguous}" @ok="confirmOpen" @cancel="choosing=undefined">
      <p>{{choosing?.record.title}}</p><a-radio-group v-model:value="selectedTarget" class="session-location-picker"><a-radio v-for="location in choosing?.record.locations??[]" :key="location.targetId" :value="location.targetId" :disabled="location.ambiguous">{{location.name}}<div class="muted session-meta">{{location.directory}}</div><small v-if="location.ambiguous||location.historyMode==='paginated'">{{locationExplanation(location)}}</small></a-radio></a-radio-group>
    </a-modal>
    <SessionContentPanel v-if="reader&&result" :snapshot-id="result.snapshotId" :record="reader.record" :target-id="reader.targetId" :initial-query="content" :can-resume="canResume(reader.record)" :can-fork-default="canDefaultFork(reader.record)" :resume-reason="resumeReason(reader.record)" @close="reader=undefined" @resume="resume" @fork-default="forkDefault" />
    <SessionResumePanel v-if="resuming&&result" :snapshot-id="result.snapshotId" :record="resuming.record" :target-id="resuming.targetId" @close="resuming=undefined" @started="resumeStarted" />
    <DefaultClaudeResumePanel v-if="defaultResuming&&result" :snapshot-id="result.snapshotId" :record="defaultResuming.record" :target-id="defaultResuming.targetId" @close="defaultResuming=undefined" @started="defaultResumeStarted" />
    <SessionVisibilityRepairPanel v-model:open="visibilityRepairOpen" :session-ids="codexSelectedIds" @completed="reload" />
  </section>
</template>

<style scoped>
.session-filters{margin-bottom:20px}.session-filter-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr);gap:14px}.session-filter-grid :deep(.ant-form-item){min-width:0}.session-filter-grid :deep(.ant-select){width:100%}.session-filter-note{margin-left:16px;font-size:12px}.session-title{font-weight:600;overflow-wrap:anywhere}.session-meta{font-size:12px;overflow-wrap:anywhere;margin-top:5px}.session-id{font-size:11px;overflow-wrap:anywhere;margin-top:6px}.session-location{font-size:12px;margin:5px 0;overflow-wrap:anywhere}.session-location .ant-tag{font-size:11px;margin-left:5px}.session-note{margin-top:20px;font-size:12px;line-height:1.8}.session-location-picker{display:flex;flex-direction:column;gap:16px;overflow-wrap:anywhere}.sessions-panel .error-banner ul{max-height:150px;overflow:auto;padding-left:18px}@media(max-width:1100px){.session-filter-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.session-report{margin-bottom:18px}.session-report :deep(.ant-table-wrapper){overflow-x:auto}
.session-title-link{padding:0;white-space:normal;height:auto;text-align:left;line-height:1.5}.session-resume-reason{font-size:11px;line-height:1.6;margin:5px 0}.session-codex-tools-note{font-size:12px}.session-source-name{display:flex;align-items:center;justify-content:space-between;gap:12px}.session-source-name .muted{font-size:12px}.session-source-detail{font-size:12px;white-space:normal;line-height:1.5;margin-top:3px}.session-source-path{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
</style>
