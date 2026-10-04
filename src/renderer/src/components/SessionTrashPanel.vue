<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue'
import type {InstanceApplication} from '../../../shared/instances'
import type {TrashPage,TrashPreview,TrashState,TrashRecovery} from '../../../shared/sessionTrash'
import LegacyTrashImportPanel from './LegacyTrashImportPanel.vue'
const props=defineProps<{snapshotId?:string;selectedIds:string[];reading:boolean}>(),emit=defineEmits<{completed:[]}>()
const state=ref<TrashState>({recoveries:[]}),list=ref<TrashPage>(),listOpen=ref(false),selected=ref<string[]>([]),editor=ref(false),preview=ref<TrashPreview>(),action=ref<'trash'|'restore'|'purge'|'recover'>('trash'),all=ref(false)
const recovery=ref<{record:TrashRecovery;mode:'resume'|'restore'|'discard'}>(),applications=ref<InstanceApplication[]>([]),applicationId=ref<string>(),closed=ref(false),confirmed=ref(false),loading=ref(false),error=ref('')
const running=computed(()=>!!state.value.job&&['preparing','running'].includes(state.value.job.status)),needsProgram=computed(()=>action.value!=='purge'&&recovery.value?.mode!=='discard')
const titles={trash:'移到废纸篓',restore:'恢复所选会话',purge:'永久删除',recover:'处理恢复任务',import:'导入旧废纸篓'},statuses={preparing:'正在准备预览',ready:'预览已就绪',running:'正在处理',completed:'已完成',cancelled:'已取消',failed:'未完成'}
const bytes=(n:number)=>n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB'
const progress=computed(()=>state.value.job?.totalBytes?Math.min(100,Math.floor(state.value.job.bytes/state.value.job.totalBytes*100)):0)
let alive=true,polling=false,observed=false,generation=0,timer:ReturnType<typeof setInterval>|undefined
function apply(next:TrashState){if(!alive)return;state.value=next;if(next.job?.status==='running')observed=true;else if(observed&&next.job&&['completed','failed','cancelled'].includes(next.job.status)){observed=false;emit('completed');if(listOpen.value)void refresh()}}
async function poll(){if(polling)return;polling=true;try{apply(await window.manager.sessionTrashState())}catch(cause){if(alive)error.value=String(cause)}finally{polling=false}}
async function refresh(){try{const next=await window.manager.listSessionTrash();if(alive){list.value=next;selected.value=[];apply(await window.manager.sessionTrashState())}}catch(cause){if(alive)error.value=String(cause)}}
async function openList(){listOpen.value=true;error.value='';await refresh()}
async function page(number:number){if(!list.value)return;try{list.value=await window.manager.sessionTrashPage({snapshotId:list.value.snapshotId,page:number,pageSize:25})}catch(cause){error.value=String(cause)}}
function selectRows(keys:(string|number)[]){if(keys.length>1000){error.value='每次最多选择 1000 个会话；清空废纸篓可处理全部。';return}selected.value=keys.map(String)}
function invalidate(){generation++;loading.value=false;preview.value=undefined;confirmed.value=false;void window.manager.discardSessionTrash().catch(cause=>{if(alive)error.value=String(cause)})}
async function begin(kind:typeof action.value,empty=false,item?:TrashRecovery,mode:'resume'|'restore'|'discard'='restore'){
  error.value='';action.value=kind;all.value=empty;recovery.value=item?{record:item,mode}:undefined;closed.value=false;editor.value=true;invalidate()
  try{const data=await window.manager.load();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.find(app=>app.kind==='cli')?.id??applications.value[0]?.id}}catch(cause){error.value=String(cause)}
}
async function choose(kind:'cli'|'desktop'){try{const data=kind==='cli'?await window.manager.chooseInstanceCli():await window.manager.chooseInstanceApplication();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>(app.kind==='cli')===(kind==='cli')).at(-1)?.id;invalidate()}}catch(cause){error.value=String(cause)}}
function closeEditor(){editor.value=false;invalidate()}
async function prepare(){
  const current=++generation;loading.value=true;error.value=''
  try{
    let result:TrashPreview
    if(action.value==='trash'){if(!props.snapshotId||!applicationId.value||!closed.value)return;result=await window.manager.previewSessionTrash({snapshotId:props.snapshotId,sessionIds:[...props.selectedIds],applicationId:applicationId.value,clientsClosed:true})}
    else{if(!list.value)return;result=await window.manager.previewSessionTrashAction({snapshotId:list.value.snapshotId,...all.value?{all:true as const}:{sessionIds:[...selected.value]},action:action.value as 'restore'|'purge',...action.value==='restore'?{applicationId:applicationId.value,clientsClosed:true as const}:{}})}
    if(alive&&generation===current)preview.value=result
  }catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive&&current===generation)loading.value=false}
}
async function start(){
  loading.value=true;error.value=''
  try{
    if(recovery.value){const item=recovery.value;observed=true;apply(await window.manager.recoverSessionTrash({id:item.record.id,mode:item.mode,applicationId:applicationId.value,clientsClosed:true}))}
    else if(preview.value&&confirmed.value){observed=true;apply(await window.manager.startSessionTrash({ticket:preview.value.ticket,confirmed:true}))}
    editor.value=false;preview.value=undefined;generation++;await poll()
  }catch(cause){error.value=String(cause)}finally{loading.value=false;await poll()}
}
async function cancel(){if(state.value.job)try{apply(await window.manager.cancelSessionTrash(state.value.job.id))}catch(cause){error.value=String(cause)}}
async function backup(id:string){try{await window.manager.openSessionTrashBackup(id)}catch(cause){error.value=String(cause)}}
onMounted(()=>{void poll();timer=setInterval(()=>{void poll()},500)})
onUnmounted(()=>{alive=false;generation++;clearInterval(timer);void window.manager.discardSessionTrash()})
</script>

<template>
  <div class="session-trash">
    <div class="trash-toolbar"><a-button danger :disabled="reading||running||!snapshotId||!selectedIds.length" @click="begin('trash')">移到废纸篓</a-button><a-button :disabled="running" @click="openList">打开废纸篓</a-button><LegacyTrashImportPanel :state="state" @update="apply" /><span class="muted">删除前保留完整备份，包含派生会话。</span></div>
    <a-alert v-if="error&&!editor&&!listOpen" type="error" :message="error" class="error-banner" />
    <a-card v-if="state.job&&!['ready','preparing'].includes(state.job.status)" size="small" class="trash-progress"><strong>{{state.job.action==='recover'?'会话恢复任务':titles[state.job.action]}} · {{statuses[state.job.status]}}</strong><span class="muted"> · {{state.job.completedTargets.length}} / {{state.job.targets}} 个目录</span><a-progress v-if="state.job.status==='running'&&state.job.totalBytes" :percent="progress" /><p v-if="state.job.fallbackTargets" class="muted">{{state.job.fallbackTargets}} 个目录使用文件方式移除，索引异常会单独列为恢复任务。</p><p v-if="state.job.error">{{state.job.error}}</p><a-button v-if="running" @click="cancel">取消操作</a-button></a-card>
    <a-alert v-for="item in state.recoveries" :key="item.id" type="warning" class="trash-recovery"><template #message>{{item.targetName}} · {{item.message}}</template><template #description><a-space wrap><a-button v-if="item.canRestore" :disabled="running" @click="begin('recover',false,item,'restore')">恢复原文件</a-button><a-button v-if="item.canResume" :disabled="running" @click="begin('recover',false,item,'resume')">继续删除或索引</a-button><a-button v-if="['preparing','backed_up'].includes(item.phase)" :disabled="running" @click="begin('recover',false,item,'discard')">清理未使用备份</a-button><a-button @click="backup(item.id)">打开备份位置</a-button></a-space></template></a-alert>
    <a-modal :open="listOpen&&!editor" title="会话废纸篓" :width="1000" :footer="null" @cancel="listOpen=false">
      <div class="trash-list"><p class="muted">同 ID 会话合并展示，恢复或删除会处理所选会话的全部废纸篓副本。未完成的操作显示在页面恢复任务中。</p><a-alert v-if="error" type="error" :message="error" class="error-banner" />
        <div class="toolbar"><span>{{list?.total??0}} 个会话 · 已选 {{selected.length}}</span><span class="toolbar-spacer" /><a-button :disabled="running" @click="refresh">刷新</a-button><a-button :disabled="running||!selected.length" @click="begin('restore')">恢复所选</a-button><a-button danger :disabled="running||!selected.length" @click="begin('purge')">永久删除所选</a-button><a-button danger :disabled="running||!list?.total" @click="begin('purge',true)">清空废纸篓</a-button></div>
        <a-table row-key="id" class="trash-table" :data-source="list?.items??[]" size="small" :pagination="false" :row-selection="{selectedRowKeys:selected,onChange:selectRows,preserveSelectedRowKeys:true,getCheckboxProps:()=>({disabled:running})}" :scroll="{y:380}">
          <a-table-column key="title" title="会话" :width="350"><template #default="{record}"><strong>{{record.title}}</strong><div class="muted trash-meta">{{record.cwd}}</div><div class="muted trash-meta">{{record.id}}</div></template></a-table-column>
          <a-table-column key="locations" title="原目录"><template #default="{record}"><div v-for="location in record.locations" :key="location.id" :title="location.directory">{{location.name}}</div><span class="muted">{{record.copies}} 份副本</span></template></a-table-column>
          <a-table-column key="bytes" title="文件大小" :width="110"><template #default="{record}">{{bytes(record.bytes)}}</template></a-table-column>
          <a-table-column key="deleted" title="移入时间" :width="160"><template #default="{record}">{{record.deletedAt?new Date(record.deletedAt).toLocaleString():'未知'}}</template></a-table-column>
        </a-table><a-pagination v-if="list&&list.total>25" :current="list.page" :total="list.total" :page-size="25" :show-size-changer="false" :disabled="running" @change="page" />
      </div>
    </a-modal>
    <a-modal :open="editor" :title="recovery?recovery.mode==='restore'?'恢复原会话':recovery.mode==='resume'?'继续未完成的删除':'清理未使用备份':all?'清空废纸篓':titles[action]" :width="860" :footer="null" @cancel="closeEditor">
      <div class="trash-editor"><a-alert v-if="error" type="error" :message="error" class="error-banner" />
        <p v-if="action==='trash'" class="muted">将处理全部已登记目录中的同 ID 副本，包括当前筛选未显示的副本和派生子会话。先关闭相关 Codex 客户端，预览后再确认删除。</p>
        <p v-else-if="action==='restore'" class="muted">恢复到原目录，保留原始会话内容。原位置存在不同内容时保留双方文件并报告冲突。</p>
        <p v-else-if="action==='purge'" class="muted">{{all?'清空全部已列出的废纸篓会话，不受当前分页限制。':'永久删除所选会话的全部废纸篓副本。'}} 原目录内的会话文件不会被改动。</p>
        <p v-else class="muted">{{recovery?.record.targetName}} · {{recovery?.record.message}}</p>
        <a-form v-if="needsProgram" layout="vertical"><a-form-item label="Codex 程序"><a-select v-model:value="applicationId" aria-label="废纸篓索引程序" :disabled="running" :options="applications.map(app=>({value:app.id,label:app.name+' · '+(app.kind==='cli'?'CLI':'桌面程序')}))" @change="invalidate" /></a-form-item><a-space><a-button :disabled="running" @click="choose('cli')">选择 CLI 程序</a-button><a-button :disabled="running" @click="choose('desktop')">选择桌面程序</a-button></a-space></a-form>
        <a-checkbox v-if="action!=='purge'" v-model:checked="closed" class="trash-closed" :disabled="running" @change="invalidate">我已关闭使用相关目录的 Codex 客户端</a-checkbox>
        <div v-if="preview" class="trash-preview"><p><strong>{{preview.sessions}} 个会话 · {{preview.copies}} 份副本 · {{bytes(preview.bytes)}}</strong></p><a-table class="trash-preview-table" size="small" :data-source="preview.targets" row-key="id" :pagination="false" :scroll="{y:240}"><a-table-column key="name" title="目录"><template #default="{record}">{{record.name}}<div class="muted trash-meta">{{record.directory}}</div></template></a-table-column><a-table-column key="sessions" title="会话" data-index="sessions" :width="65" /><a-table-column v-if="action==='trash'" key="children" title="含派生" data-index="descendants" :width="80" /><a-table-column key="copies" title="副本" data-index="copies" :width="65" /></a-table>
          <a-alert v-if="preview.targets.some(target=>!target.officialPlan)" type="warning" message="部分目录无法读取官方索引；将按已核对的会话文件准备备份，删除后单独确认索引状态。" />
          <a-checkbox v-model:checked="confirmed" class="trash-confirm" :disabled="running">{{action==='purge'?'我确认永久删除上述备份，删除后无法通过本应用恢复':'我已核对上述目录和会话范围，确认执行'}}</a-checkbox>
        </div>
        <div class="trash-actions"><a-button @click="closeEditor">关闭</a-button><a-button v-if="running" @click="cancel">取消操作</a-button><a-button v-else-if="recovery" type="primary" :loading="loading" :disabled="!closed||(needsProgram&&!applicationId)" @click="start">开始处理</a-button><a-button v-else-if="!preview" type="primary" :loading="loading" :disabled="action!=='purge'&&(!closed||!applicationId)" @click="prepare">预览范围</a-button><a-button v-else type="primary" :danger="action==='purge'||action==='trash'" :disabled="!confirmed" :loading="loading" @click="start">{{action==='purge'?'确认永久删除':action==='restore'?'确认恢复':'确认移到废纸篓'}}</a-button></div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.session-trash{margin:10px 0 20px}.trash-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.trash-toolbar>.muted{font-size:12px}.trash-progress,.trash-recovery{margin-top:12px}.trash-progress p{margin:8px 0 0}.trash-editor>.muted,.trash-list>.muted{font-size:12px;line-height:1.8}.trash-closed,.trash-confirm{display:flex;margin:20px 0;line-height:1.7}.trash-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.trash-meta{font-size:11px;overflow-wrap:anywhere;margin-top:4px}.trash-preview{margin-top:20px}.trash-list .toolbar{flex-wrap:wrap;margin:18px 0}.trash-list .ant-pagination{margin-top:18px;text-align:right}.trash-editor .ant-form-item{margin-bottom:10px}.trash-recovery .ant-space{margin-top:8px}
</style>
