<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {useFormFeedback} from '../formFeedback'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {InstanceApplication} from '../../../shared/instances'
import type {SyncPreview,SyncView,SyncRecovery,SyncConflictSession} from '../../../shared/sessionSync'
import type {SessionRecord} from '../../../shared/sessions'
import type {SessionSource} from '../../../shared/sessions'
const props=defineProps<{targets:ClientConfigTarget[];sources:SessionSource[];snapshotId?:string;selectedIds:string[];selectedSessions:SessionRecord[];reading:boolean}>(),emit=defineEmits<{completed:[]}>()
const sync=ref<SyncView>(),recoveries=ref<SyncRecovery[]>([]),applications=ref<InstanceApplication[]>([]),open=ref(false),sourceIds=ref<string[]>([]),targetId=ref<string>(),scope=ref<'all'|'selected'>('all'),applicationId=ref<string>(),preview=ref<SyncPreview>(),retryId=ref<string>(),clientsClosed=ref(false),loading=ref(false),error=ref('')
const sourceId=computed({get:()=>sourceIds.value[0],set:(value:string|undefined)=>{sourceIds.value=value?[value]:[]}})
const sourceVersionSelections=ref<Record<string,string>>({})
useFormFeedback(()=>error.value,{active:()=>open.value})
const sourceOptions=computed(()=>props.sources.filter(source=>(source.role==='instance'||source.role==='source'&&source.enabled!==false&&source.available!==false)&&source.id!==targetId.value).map(source=>({value:source.id,label:source.name+(source.role==='source'?' · 只读':'')+' · '+source.directory})))
const targetOptions=computed(()=>props.targets.filter(target=>target.role==='instance').map(target=>({value:target.id,label:target.name+' · '+target.directory})))
const eligibleSelected=computed(()=>[...new Set(props.selectedIds)].slice(0,1000))
const selectedSessionsWithSourceConflicts=computed(()=>props.selectedSessions.filter(record=>record.locations.some(location=>sourceIds.value.includes(location.targetId)&&location.ambiguous)))
const allConflictSessions=ref<SyncConflictSession[]>([]),conflictLoading=ref(false),conflictError=ref('')
const relevantConflicts=computed(()=>scope.value==='all'?allConflictSessions.value:selectedSessionsWithSourceConflicts.value)
const unresolvedConflicts=computed(()=>relevantConflicts.value.some(record=>record.locations.some(location=>sourceIds.value.includes(location.targetId)&&location.ambiguous&&!sourceVersionSelections.value[record.id+'|'+location.targetId])))
const running=computed(()=>!!sync.value&&['preparing','running'].includes(sync.value.status)),labels={preparing:'正在准备导入',ready:'导入预览已就绪',running:'正在导入',completed:'会话导入已完成',cancelled:'导入已取消',failed:'导入未完成'}
const progress=computed(()=>sync.value?.totalBytes?Math.min(100,Math.floor(sync.value.bytes/sync.value.totalBytes*100)):0)
const bytes=(value:number)=>value<1024**2?(value/1024).toFixed(1)+' KiB':value<1024**3?(value/1024**2).toFixed(1)+' MiB':(value/1024**3).toFixed(2)+' GiB'
const sourceNames=computed(()=>sourceIds.value.map(id=>props.sources.find(source=>source.id===id)?.name??id))
const targetName=computed(()=>targetOptions.value.find(target=>target.value===targetId.value)?.label??targetId.value??'')
let alive=true,generation=0,polling=false,timer:ReturnType<typeof setInterval>|undefined,observed=false
let activeConflictRequest:string|undefined
function apply(state:{sync?:SyncView;recoveries:SyncRecovery[]}){if(!alive)return;sync.value=state.sync;recoveries.value=state.recoveries;if(sync.value?.status==='running')observed=true;else if(observed){observed=false;emit('completed')}}
async function poll(){if(polling)return;polling=true;try{apply(await window.manager.sessionSyncState())}catch(cause){if(alive)error.value=String(cause)}finally{polling=false}}
function invalidate(){generation++;preview.value=undefined;clientsClosed.value=false;void window.manager.discardSessionSync().catch(cause=>{if(alive)error.value=String(cause)})}
let conflictGeneration=0
function cancelConflictRequest(){conflictGeneration++;const request=activeConflictRequest;activeConflictRequest=undefined;if(request)void window.manager.cancelSessionSyncConflicts(request).catch(()=>{})}
async function loadAllConflicts(){
  cancelConflictRequest();const current=conflictGeneration,sources=[...sourceIds.value],target=targetId.value,requestId=crypto.randomUUID()
  allConflictSessions.value=[];conflictError.value=''
  if(!open.value||retryId.value||scope.value!=='all'||!sources.length||!target)return
  activeConflictRequest=requestId;conflictLoading.value=true
  try{
    const result=await window.manager.sessionSyncConflicts({requestId,sourceIds:sources,targetId:target})
    if(!alive||current!==conflictGeneration||!open.value||scope.value!=='all'||targetId.value!==target||JSON.stringify([...sourceIds.value].sort())!==JSON.stringify([...sources].sort()))return
    allConflictSessions.value=result
  }catch(cause){if(alive&&current===conflictGeneration)conflictError.value=String(cause)}
  finally{if(activeConflictRequest===requestId)activeConflictRequest=undefined;if(alive&&current===conflictGeneration)conflictLoading.value=false}
}
function close(){open.value=false;retryId.value=undefined;sourceVersionSelections.value={};invalidate()}
async function begin(id?:string){error.value='';retryId.value=id;sourceIds.value=[];sourceVersionSelections.value={};targetId.value=undefined;scope.value='all';preview.value=undefined;clientsClosed.value=false;open.value=true;generation++;try{await window.manager.discardSessionSync();const data=await window.manager.load();if(alive){applications.value=(data.instanceApplications??[]).filter(app=>app.clientType===undefined||app.clientType==='codex');applicationId.value=applications.value.find(app=>app.kind==='cli')?.id??applications.value[0]?.id}}catch(cause){if(alive)error.value=String(cause)}}
async function choose(kind:'cli'|'desktop'){const current=generation;try{const choice=kind==='cli'?await window.manager.chooseInstanceCli():await window.manager.chooseInstanceApplication();if(!alive||current!==generation||!choice.application)return;const items=(choice.snapshot.instanceApplications??[]).filter(app=>app.clientType===undefined||app.clientType==='codex'),selected=items.find(app=>app.id===choice.application?.id&&(app.kind==='cli')===(kind==='cli'));if(!selected)throw new Error('请选择用于更新会话列表的 Codex 程序');applications.value=items;applicationId.value=selected.id;invalidate()}catch(cause){if(alive&&current===generation)error.value=String(cause)}}
async function prepare(){if(!targetId.value||!applicationId.value||!sourceIds.value.length)return;if(scope.value==='selected'&&(!props.snapshotId||!eligibleSelected.value.length)){error.value='请先在会话列表中勾选要导入的 Codex 会话';return}if(scope.value==='all'&&(conflictLoading.value||conflictError.value)){error.value=conflictError.value||'正在检查全部来源中的同 ID 冲突，请稍候。';return}if(unresolvedConflicts.value){error.value='请为同步范围中的每个同 ID 冲突选择具体文件版本';return}const current=++generation;loading.value=true;error.value='';try{const sourceSelections=relevantConflicts.value.flatMap(record=>record.locations.filter(location=>sourceIds.value.includes(location.targetId)&&location.ambiguous).map(location=>({sessionId:record.id,targetId:location.targetId,versionId:sourceVersionSelections.value[record.id+'|'+location.targetId]})));const input={sourceIds:[...sourceIds.value],targetId:targetId.value,scope:scope.value,sessionIds:scope.value==='selected'?eligibleSelected.value:[],...(sourceSelections.length?{sourceSelections}:{}),applicationId:applicationId.value};const value=await window.manager.previewSessionSync(input);if(alive&&open.value&&current===generation)preview.value=value;await poll()}catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive)loading.value=false}}
async function confirm(){if(!clientsClosed.value||!applicationId.value)return;loading.value=true;error.value='';try{observed=true;if(retryId.value){const task=window.manager.retrySessionSync({id:retryId.value,applicationId:applicationId.value,clientsClosed:true});open.value=false;apply(await task)}else if(preview.value?.canStart&&preview.value.ticket){apply(await window.manager.startSessionSync({ticket:preview.value.ticket,clientsClosed:true}));open.value=false;preview.value=undefined}}catch(cause){if(alive){error.value=String(cause);await poll()}}finally{if(alive)loading.value=false}}
async function cancel(){if(!sync.value)return;try{apply(await window.manager.cancelSessionSync(sync.value.id));preview.value=undefined}catch(cause){if(alive)error.value=String(cause)}}
async function backup(id:string){try{await window.manager.openSessionSyncBackup(id)}catch(cause){error.value=String(cause)}}
watch(()=>[...props.selectedIds],()=>{if(open.value&&scope.value==='selected'&&!retryId.value)invalidate()})
watch(()=>[open.value,retryId.value,scope.value,targetId.value,[...sourceIds.value].sort().join('|')],()=>{cancelConflictRequest();allConflictSessions.value=[];sourceVersionSelections.value={};conflictError.value='';conflictLoading.value=false;if(open.value&&!retryId.value&&scope.value==='all')void loadAllConflicts()})
watch(()=>props.snapshotId,()=>{if(open.value&&!retryId.value){invalidate();if(scope.value==='all')void loadAllConflicts()}})
watch(targetId,value=>{const next=sourceIds.value.filter(id=>id!==value);if(next.length!==sourceIds.value.length)sourceIds.value=next})
onMounted(()=>{void poll();timer=setInterval(()=>void poll(),750)})
onUnmounted(()=>{alive=false;generation++;cancelConflictRequest();clearInterval(timer);void window.manager.discardSessionSync().catch(()=>{})})
</script>
<template>
  <div class="session-sync">
    <div class="sync-toolbar"><a-button :disabled="reading||running||loading||targetOptions.length===0||sourceOptions.length===0" @click="begin()">同步其他来源的 Codex 会话</a-button><span class="muted">可从已登记实例或外部只读来源单向导入；目标必须是管理器实例。</span></div>
    <a-alert v-if="error&&!open" type="error" :message="error" class="error-banner" />
    <a-card v-if="sync&&sync.status!=='ready'" size="small" class="sync-progress">
      <div class="sync-toolbar"><strong>{{labels[sync.status]}}</strong><span class="toolbar-spacer" /><a-button v-if="running" @click="cancel">取消导入</a-button></div>
      <a-progress v-if="running" :percent="progress" />
      <p class="muted">已完成 {{sync.completedTargets.length}} / {{sync.targets.length}} 个目标 · 已处理 {{bytes(sync.bytes)}}<template v-if="sync.currentTarget"> · {{sync.targets.find(target=>target.id===sync?.currentTarget)?.name}}</template></p>
      <a-alert v-if="sync.error" :type="sync.status==='cancelled'?'info':'error'" :message="sync.error" />
      <p v-if="['failed','cancelled'].includes(sync.status)&&sync.completedTargets.length" class="muted">已提交的目标结果保留；未提交的改动会恢复。需要处理的恢复记录列在下方。</p>
      <div v-if="sync.backups.length" class="sync-backups"><span class="muted">目标原文件备份：</span><a-button v-for="entry in sync.backups" :key="entry.id" type="link" size="small" @click="backup(entry.id)">{{sync?.targets.find(target=>target.id===entry.targetId)?.name??'打开备份'}}</a-button></div>
    </a-card>
    <a-alert v-for="entry in recoveries" :key="entry.id" type="warning" class="sync-recovery"><template #message>{{entry.targetName}} · 导入操作待恢复</template><template #description><p>{{entry.message}}</p><a-space><a-button :disabled="running||loading||!entry.targetId" @click="begin(entry.id)">恢复导入</a-button><a-button @click="backup(entry.id)">打开备份</a-button></a-space></template></a-alert>
    <a-modal :open="open" :width="820" :title="retryId?'恢复会话导入':'从其他实例导入 Codex 会话'" :body-style="{maxHeight:'62vh',overflowY:'auto'}" @cancel="close">
      <div class="session-sync-editor">
        <a-alert v-if="error" type="error" :message="error" class="error-banner" />
        <p v-if="!retryId" class="muted sync-explanation">这是单向导入：仅从所选来源读取，只有目标实例会写入。目标中已有的同 ID 会话会与来源内容合并，替换前保存目标原文件备份。来源与目标 Codex 客户端需先关闭。同步前会检查所选范围内的同 ID 文件冲突，并要求逐条指定来源版本；分段历史会被安全检查拦截并说明原因。</p>
        <a-form layout="vertical">
          <a-form-item v-if="!retryId" label="来源目录（可多选）"><a-checkbox-group v-model:value="sourceIds" class="sync-source-options" aria-label="会话同步来源目录" :disabled="loading" @change="invalidate"><a-checkbox v-for="source in sourceOptions" :key="source.value" :value="source.value" class="sync-source-option"><span>{{source.label.split(' · ')[0]}}</span><small class="muted sync-path">{{source.label.slice(source.label.indexOf(' · ')+3)}}</small></a-checkbox></a-checkbox-group></a-form-item>
          <a-form-item v-if="!retryId" label="目标实例"><a-select v-model:value="targetId" aria-label="会话同步目标实例" :options="targetOptions" placeholder="选择接收会话的 Codex 实例" :disabled="loading" @change="invalidate" /></a-form-item>
          <a-form-item v-if="!retryId" label="同步范围"><a-radio-group v-model:value="scope" @change="invalidate"><a-radio value="all">所选来源实例中的全部会话</a-radio><a-radio value="selected">会话列表中当前勾选的会话（{{eligibleSelected.length}}）</a-radio></a-radio-group><div v-if="scope==='selected'&&!eligibleSelected.length" class="muted">先关闭此窗口，在会话列表中勾选 Codex 会话，再重新打开。</div></a-form-item>
          <a-alert v-if="scope==='all'&&conflictLoading" type="info" message="正在检查所选来源中的同 ID 会话文件冲突…" />
          <a-alert v-if="scope==='all'&&conflictError" type="error" :message="conflictError" />
          <a-alert v-if="scope==='all'&&!conflictLoading&&!conflictError&&allConflictSessions.length" type="warning" :message="'发现 '+allConflictSessions.length+' 个同 ID 冲突会话，请为每个来源选择一个版本'" />
          <a-alert v-if="scope==='all'&&!conflictLoading&&!conflictError&&!allConflictSessions.length&&sourceIds.length&&targetId" type="success" message="所选来源没有同 ID 文件冲突。" />
          <template v-if="scope==='selected'||scope==='all'"><a-form-item v-for="record in relevantConflicts" :key="record.id" :label="record.title"><div v-for="location in record.locations.filter(item=>sourceIds.includes(item.targetId)&&item.ambiguous)" :key="location.targetId" class="sync-conflict-choice"><div class="muted">{{location.name}} · {{location.directory}}</div><a-select v-model:value="sourceVersionSelections[record.id+'|'+location.targetId]" aria-label="同步来源会话文件版本" placeholder="选择要同步的文件版本" :options="location.versions!.map(version=>({value:version.id,label:version.label+(version.archived?' · 已归档':'' )}))" :disabled="loading||conflictLoading" @change="invalidate" /></div></a-form-item></template>
          <a-form-item label="用于更新目标会话列表的 Codex 程序"><a-select v-model:value="applicationId" aria-label="同步索引程序" :options="applications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" placeholder="选择 Codex 桌面应用或 CLI" :disabled="loading" @change="invalidate" /><a-space><a-button type="link" :disabled="loading" @click="choose('cli')">选择 CLI 程序</a-button><a-button type="link" :disabled="loading" @click="choose('desktop')">选择桌面应用</a-button></a-space></a-form-item>
        </a-form>
        <template v-if="preview">
          <a-alert type="info" :message="`来源：${sourceNames.join('、')} → 目标：${targetName}`" :description="`${preview.sessionCount} 个可导入会话 · ${preview.sourceFiles} 份来源文件 · ${bytes(preview.totalBytes)}`" />
          <a-alert v-if="preview.unsupportedSessions?.length" type="warning" :message="preview.unsupportedSessions.length+' 个会话暂不支持导入，已从本次同步中跳过'" />
          <a-table v-if="preview.unsupportedSessions?.length" :data-source="preview.unsupportedSessions" row-key="id" size="small" :pagination="preview.unsupportedSessions.length>10?{pageSize:10,showSizeChanger:false}:false" class="sync-preview-table"><a-table-column key="title" title="跳过的会话"><template #default="{record}"><div class="sync-path">{{record.title}}</div><small class="muted">{{record.id}}</small></template></a-table-column><a-table-column key="source" title="涉及实例"><template #default="{record}"><span v-for="id in record.sourceIds" :key="id">{{preview?.directional?.sources.find(source=>source.id===id)?.name??id}} </span></template></a-table-column><a-table-column key="reason" title="跳过原因" data-index="reason" /></a-table>
          <a-alert v-if="!preview.canStart" type="info" message="本次范围没有可导入的普通 JSONL 会话，因此不能启动同步。" />
          <a-table v-if="preview.directional?.sessions.length" :data-source="preview.directional.sessions" row-key="id" size="small" :pagination="preview.directional.sessions.length>10?{pageSize:10,showSizeChanger:false}:false" class="sync-preview-table"><a-table-column key="title" title="会话"><template #default="{record}"><div class="sync-path">{{record.title}}</div><small class="muted">{{record.id}}</small></template></a-table-column><a-table-column key="source" title="读取来源"><template #default="{record}"><div v-for="id in record.sourceIds" :key="id">{{preview?.directional?.sources.find(source=>source.id===id)?.name??id}}</div><span class="muted">{{record.sourceFiles}} 个来源文件<template v-if="record.targetFiles"> · {{record.targetFiles}} 个目标原文件参与合并</template></span></template></a-table-column><a-table-column key="action" title="目标处理" :width="120"><template #default="{record}"><a-tag :color="record.action==='add'?'blue':record.action==='merge'?'purple':undefined">{{record.action==='add'?'新增':record.action==='merge'?'合并并更新':'无变化'}}</a-tag></template></a-table-column></a-table>
          <a-table :data-source="preview.targets" row-key="id" size="small" :pagination="false" class="sync-preview-table"><a-table-column key="target" title="目标处理"><template #default="{record}"><strong>{{record.name}}</strong><div class="muted sync-path">{{record.directory}}</div></template></a-table-column><a-table-column key="added" data-index="added" title="新增" :width="58" /><a-table-column key="updated" data-index="updated" title="合并更新" :width="82" /><a-table-column key="unchanged" data-index="unchanged" title="不变" :width="58" /><a-table-column key="repair" title="其他处理" :width="150"><template #default="{record}"><div v-if="record.duplicates">合并 {{record.duplicates}} 个目标副本</div><div v-if="record.repairsWorkspace">补全项目目录</div><div v-if="record.repairsIndex">更新会话索引</div><span v-if="!record.duplicates&&!record.repairsWorkspace&&!record.repairsIndex" class="muted">—</span></template></a-table-column></a-table>
        </template>
        <template v-if="preview?.canStart||retryId"><a-checkbox v-model:checked="clientsClosed" class="sync-closed">我已关闭所选来源和目标实例的 Codex 客户端及 CLI</a-checkbox><p class="muted">更新会话列表会短暂启动所选 Codex 后台进程，不发起模型对话。</p></template>
      </div>
      <template #footer><div class="sync-actions"><a-button @click="close">返回</a-button><a-button v-if="loading&&sync?.status==='preparing'" @click="cancel">取消准备</a-button><a-button v-if="!preview&&!retryId" type="primary" :disabled="!targetId||!sourceIds.length||!applicationId||scope==='selected'&&!eligibleSelected.length||scope==='all'&&conflictLoading||!!conflictError||unresolvedConflicts" :loading="loading" @click="prepare">预览导入</a-button><a-button v-else-if="preview||retryId" type="primary" :disabled="!clientsClosed||!applicationId||!!preview&&!preview.canStart" :loading="loading" @click="confirm">{{retryId?'开始恢复':'确认单向导入'}}</a-button></div></template>
    </a-modal>
  </div>
</template>
<style scoped>
.sync-toolbar{display:flex;align-items:center;gap:14px;margin-bottom:12px}.sync-toolbar>.muted{font-size:12px}.sync-progress,.sync-recovery{margin-bottom:16px}.sync-progress p{margin:6px 0;font-size:12px}.session-sync-editor :deep(.ant-select){width:100%}.sync-source-options{display:flex;flex-direction:column;gap:8px;width:100%}.sync-source-option{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--border-color,#e5e7eb);border-radius:8px}.sync-source-option :deep(.ant-checkbox){margin-top:3px}.sync-source-option :deep(.ant-checkbox+span){display:flex;flex-direction:column;gap:4px;min-width:0}.sync-explanation{font-size:13px;line-height:1.8}.sync-path{font-size:11px;overflow-wrap:anywhere}.sync-closed{margin:20px 0 8px}.sync-actions{display:flex;justify-content:flex-end;gap:12px}.sync-backups{display:flex;align-items:center;flex-wrap:wrap;font-size:12px}.session-sync-editor>.muted{font-size:12px;line-height:1.7}.sync-conflict-choice{padding:10px 12px;margin:8px 0 12px;border:1px solid var(--border-color,#e5e7eb);border-radius:8px}.sync-conflict-choice .muted{margin:8px 0;overflow-wrap:anywhere}
</style>
