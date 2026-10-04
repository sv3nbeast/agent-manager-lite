<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {InstanceApplication} from '../../../shared/instances'
import type {SyncPreview,SyncView,SyncRecovery} from '../../../shared/sessionSync'
const props=defineProps<{targets:ClientConfigTarget[];reading:boolean}>(),emit=defineEmits<{completed:[]}>()
const sync=ref<SyncView>(),recoveries=ref<SyncRecovery[]>([]),applications=ref<InstanceApplication[]>([]),open=ref(false),targetIds=ref<string[]>([]),applicationId=ref<string>(),preview=ref<SyncPreview>(),retryId=ref<string>(),clientsClosed=ref(false),loading=ref(false),error=ref('')
const running=computed(()=>!!sync.value&&['preparing','running'].includes(sync.value.status)),labels={preparing:'正在准备同步',ready:'同步预览已就绪',running:'正在同步',completed:'同步已完成',cancelled:'同步已取消',failed:'同步未完成'}
const progress=computed(()=>sync.value?.totalBytes?Math.min(100,Math.floor(sync.value.bytes/sync.value.totalBytes*100)):0)
const bytes=(value:number)=>value<1024**2?(value/1024).toFixed(1)+' KiB':value<1024**3?(value/1024**2).toFixed(1)+' MiB':(value/1024**3).toFixed(2)+' GiB'
let alive=true,generation=0,polling=false,timer:ReturnType<typeof setInterval>|undefined,observed=false
function apply(state:{sync?:SyncView;recoveries:SyncRecovery[]}){if(!alive)return;sync.value=state.sync;recoveries.value=state.recoveries;if(sync.value?.status==='running')observed=true;else if(observed){observed=false;emit('completed')}}
async function poll(){if(polling)return;polling=true;try{apply(await window.manager.sessionSyncState())}catch(cause){if(alive)error.value=String(cause)}finally{polling=false}}
function invalidate(){generation++;preview.value=undefined;clientsClosed.value=false;void window.manager.discardSessionSync().catch(cause=>{if(alive)error.value=String(cause)})}
function close(){open.value=false;retryId.value=undefined;invalidate()}
async function begin(id?:string){error.value='';retryId.value=id;targetIds.value=props.targets.map(target=>target.id);preview.value=undefined;clientsClosed.value=false;open.value=true;generation++;try{await window.manager.discardSessionSync();const data=await window.manager.load();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.find(app=>app.kind==='cli')?.id??applications.value[0]?.id}}catch(cause){if(alive)error.value=String(cause)}}
async function choose(kind:'cli'|'desktop'){try{const data=kind==='cli'?await window.manager.chooseInstanceCli():await window.manager.chooseInstanceApplication();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>(app.kind==='cli')===(kind==='cli')).at(-1)?.id;invalidate()}}catch(cause){error.value=String(cause)}}
async function prepare(){if(!applicationId.value)return;const current=++generation;loading.value=true;error.value='';try{const value=await window.manager.previewSessionSync({targetIds:[...targetIds.value],applicationId:applicationId.value});if(alive&&open.value&&current===generation)preview.value=value;await poll()}catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive)loading.value=false}}
async function confirm(){if(!clientsClosed.value||!applicationId.value)return;loading.value=true;error.value='';try{observed=true;if(retryId.value){const task=window.manager.retrySessionSync({id:retryId.value,applicationId:applicationId.value,clientsClosed:true});open.value=false;apply(await task)}else if(preview.value){apply(await window.manager.startSessionSync({ticket:preview.value.ticket,clientsClosed:true}));open.value=false;preview.value=undefined}}catch(cause){if(alive){error.value=String(cause);await poll()}}finally{if(alive)loading.value=false}}
async function cancel(){if(!sync.value)return;try{apply(await window.manager.cancelSessionSync(sync.value.id));preview.value=undefined}catch(cause){if(alive)error.value=String(cause)}}
async function backup(id:string){try{await window.manager.openSessionSyncBackup(id)}catch(cause){error.value=String(cause)}}
onMounted(()=>{void poll();timer=setInterval(()=>void poll(),750)})
onUnmounted(()=>{alive=false;generation++;clearInterval(timer);void window.manager.discardSessionSync().catch(()=>{})})
</script>
<template>
  <div class="session-sync">
    <div class="sync-toolbar"><a-button :disabled="reading||running||loading||targets.length<2" @click="begin()">同步所有会话</a-button><span class="muted">合并所选目录的全部会话，不受列表筛选或勾选影响。</span></div>
    <a-alert v-if="error&&!open" type="error" :message="error" class="error-banner" />
    <a-card v-if="sync&&sync.status!=='ready'" size="small" class="sync-progress">
      <div class="sync-toolbar"><strong>{{labels[sync.status]}}</strong><span class="toolbar-spacer" /><a-button v-if="running" @click="cancel">取消同步</a-button></div>
      <a-progress v-if="running" :percent="progress" />
      <p class="muted">已完成 {{sync.completedTargets.length}} / {{sync.targets.length}} 个目录 · 已处理 {{bytes(sync.bytes)}}<template v-if="sync.currentTarget"> · {{sync.targets.find(target=>target.id===sync?.currentTarget)?.name}}</template></p>
      <a-alert v-if="sync.error" :type="sync.status==='cancelled'?'info':'error'" :message="sync.error" />
      <p v-if="['failed','cancelled'].includes(sync.status)&&sync.completedTargets.length" class="muted">已完成目录的同步结果保留；未提交的改动会恢复。需要处理的恢复记录列在下方。</p>
      <div v-if="sync.backups.length" class="sync-backups"><span class="muted">原文件备份：</span><a-button v-for="entry in sync.backups" :key="entry.id" type="link" size="small" @click="backup(entry.id)">{{sync?.targets.find(target=>target.id===entry.targetId)?.name??'打开备份'}}</a-button></div>
    </a-card>
    <a-alert v-for="entry in recoveries" :key="entry.id" type="warning" class="sync-recovery"><template #message>{{entry.targetName}} · 同步有待恢复</template><template #description><p>{{entry.message}}</p><a-space><a-button :disabled="running||loading||!entry.targetId" @click="begin(entry.id)">恢复同步</a-button><a-button @click="backup(entry.id)">打开同步备份</a-button></a-space></template></a-alert>
    <a-modal :open="open" :width="820" :title="retryId?'恢复会话同步':'同步所有会话'" :body-style="{maxHeight:'62vh',overflowY:'auto'}" @cancel="close">
      <div class="session-sync-editor">
        <a-alert v-if="error" type="error" :message="error" class="error-banner" />
        <p v-if="!retryId" class="muted sync-explanation">相同 ID 的会话按事件去重合并，保留各分支内容。每个目录都会收到合并后的会话，替换前保留原文件备份。逐目录保存，取消不会撤销已完成目录。</p>
        <a-form layout="vertical">
          <a-form-item v-if="!retryId" label="参与同步的目录"><a-select v-model:value="targetIds" mode="multiple" :max-tag-count="2" aria-label="会话同步目录" :options="targets.map(target=>({value:target.id,label:target.name+' · '+target.directory}))" :disabled="loading" @change="invalidate" /></a-form-item>
          <a-form-item label="用于更新会话列表的 Codex 程序"><a-select v-model:value="applicationId" aria-label="同步索引程序" :options="applications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" placeholder="选择 Codex 桌面应用或 CLI" :disabled="loading" @change="invalidate" /><a-space><a-button type="link" :disabled="loading" @click="choose('cli')">选择 CLI 程序</a-button><a-button type="link" :disabled="loading" @click="choose('desktop')">选择桌面应用</a-button></a-space></a-form-item>
        </a-form>
        <template v-if="preview">
          <p>{{preview.sessionCount}} 个会话 · {{preview.sourceFiles}} 份来源文件 · {{bytes(preview.totalBytes)}}</p>
          <a-table :data-source="preview.targets" row-key="id" size="small" :pagination="preview.targets.length>8?{pageSize:8,showSizeChanger:false}:false" class="sync-preview-table">
            <a-table-column key="target" title="目录"><template #default="{record}"><strong>{{record.name}}</strong><div class="muted sync-path">{{record.directory}}</div></template></a-table-column>
            <a-table-column key="added" data-index="added" title="新增" :width="58" />
            <a-table-column key="updated" data-index="updated" title="更新" :width="58" />
            <a-table-column key="unchanged" data-index="unchanged" title="不变" :width="58" />
            <a-table-column key="repair" title="其他处理" :width="132"><template #default="{record}"><div v-if="record.duplicates">归并 {{record.duplicates}} 份重复副本</div><div v-if="record.repairsWorkspace">补全项目目录</div><div v-if="record.repairsIndex">更新会话索引</div><span v-if="!record.duplicates&&!record.repairsWorkspace&&!record.repairsIndex" class="muted">—</span></template></a-table-column>
          </a-table>
        </template>
        <template v-if="preview||retryId"><a-checkbox v-model:checked="clientsClosed" class="sync-closed">我已关闭使用这些目录的 Codex 客户端及 CLI</a-checkbox><p class="muted">更新会话列表会短暂启动所选 Codex 后台进程，不发起模型对话。</p></template>
      </div>
      <template #footer><div class="sync-actions"><a-button @click="close">返回</a-button><a-button v-if="loading&&sync?.status==='preparing'" @click="cancel">取消准备</a-button><a-button v-if="!preview&&!retryId" type="primary" :disabled="targetIds.length<2||!applicationId" :loading="loading" @click="prepare">预览同步</a-button><a-button v-else type="primary" :disabled="!clientsClosed||!applicationId" :loading="loading" @click="confirm">{{retryId?'开始恢复':'确认同步'}}</a-button></div></template>
    </a-modal>
  </div>
</template>
<style scoped>
.sync-toolbar{display:flex;align-items:center;gap:14px;margin-bottom:12px}.sync-toolbar>.muted{font-size:12px}.sync-progress,.sync-recovery{margin-bottom:16px}.sync-progress p{margin:6px 0;font-size:12px}.session-sync-editor :deep(.ant-select){width:100%}.sync-explanation{font-size:13px;line-height:1.8}.sync-path{font-size:11px;overflow-wrap:anywhere}.sync-closed{margin:20px 0 8px}.sync-actions{display:flex;justify-content:flex-end;gap:12px}.sync-backups{display:flex;align-items:center;flex-wrap:wrap;font-size:12px}.session-sync-editor>.muted{font-size:12px;line-height:1.7}
</style>
