<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {useFormFeedback} from '../formFeedback'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {InstanceApplication} from '../../../shared/instances'
import type {ArchivePreview,ArchiveImportPreview,ArchiveProgress} from '../../../shared/sessionArchives'
const props=defineProps<{targets:ClientConfigTarget[];snapshotId?:string;selectedIds:string[];reading:boolean}>()
const emit=defineEmits<{completed:[]}>()
const open=ref(false),mode=ref<'export'|'import'>('export'),preview=ref<ArchivePreview>(),importPreview=ref<ArchiveImportPreview>(),state=ref<ArchiveProgress>(),applications=ref<InstanceApplication[]>([])
const targetId=ref<string>(),applicationId=ref<string>(),importIds=ref<string[]>([]),closed=ref(false),loading=ref(false),error=ref('')
useFormFeedback(()=>error.value,{active:()=>open.value})
const running=computed(()=>state.value&&['preparing','running'].includes(state.value.status)),percent=computed(()=>state.value?.totalBytes?Math.min(100,Math.floor(state.value.bytes/state.value.totalBytes*100)):0)
const labels={preparing:'正在准备',ready:'预览已就绪',running:'正在处理',completed:'已完成',failed:'操作失败',cancelled:'已取消'}
const bytes=(n:number)=>n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB'
let alive=true,generation=0,polling=false,timer:ReturnType<typeof setInterval>|undefined,seenRunning=false
function apply(value?:ArchiveProgress){if(!alive)return;state.value=value;if(value?.status==='running')seenRunning=true;else if(seenRunning){seenRunning=false;if(value?.operation==='import')emit('completed')}}
async function poll(){if(polling)return;polling=true;try{apply(await window.manager.sessionArchiveState())}catch(cause){if(alive)error.value=String(cause)}finally{polling=false}}
function invalidate(){generation++;importPreview.value=undefined;closed.value=false}
async function hide(){open.value=false;generation++;preview.value=undefined;importPreview.value=undefined;try{await window.manager.discardSessionArchive();await poll()}catch(cause){if(alive)error.value=String(cause)}}
async function begin(kind:'export'|'import'){
  const current=++generation;mode.value=kind;open.value=true;preview.value=undefined;importPreview.value=undefined;targetId.value=undefined;applicationId.value=applications.value[0]?.id;closed.value=false;loading.value=true;error.value=''
  try{
    const result=kind==='export'?await window.manager.previewSessionExport({snapshotId:props.snapshotId!,sessionIds:[...props.selectedIds]}):await window.manager.chooseSessionArchive()
    if(alive&&current===generation){preview.value=result;importIds.value=result?.items.map(item=>item.id)??[];if(!result)open.value=false;await poll()}
  }catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive)loading.value=false}
}
async function chooseCli(){try{const data=await window.manager.chooseInstanceCli();applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>app.kind==='cli').at(-1)?.id;invalidate()}catch(cause){error.value=String(cause)}}
async function chooseApp(){try{const data=await window.manager.chooseInstanceApplication();applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>app.kind!=='cli').at(-1)?.id;invalidate()}catch(cause){error.value=String(cause)}}
async function prepareImport(){
  if(!preview.value||!targetId.value||!applicationId.value)return
  const current=++generation;loading.value=true;error.value=''
  try{const result=await window.manager.previewSessionImport({ticket:preview.value.ticket,targetId:targetId.value,applicationId:applicationId.value,sessionIds:[...importIds.value]});if(alive&&current===generation)importPreview.value=result}
  catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive){loading.value=false;await poll()}}
}
async function confirm(){
  loading.value=true;error.value=''
  try{
    const result=mode.value==='export'?await window.manager.startSessionExport(preview.value!.ticket):await window.manager.startSessionImport({ticket:importPreview.value!.ticket,clientsClosed:true})
    if(result){seenRunning=true;apply(result);open.value=false;preview.value=undefined;importPreview.value=undefined}
  }catch(cause){if(alive)error.value=String(cause)}finally{if(alive)loading.value=false}
}
async function cancel(){if(state.value){try{apply(await window.manager.cancelSessionArchive(state.value.id))}catch(cause){error.value=String(cause)}}}
function selected(keys:(string|number)[]){importIds.value=keys.map(String);invalidate()}
watch(()=>[props.snapshotId,...props.selectedIds],()=>{if(open.value&&mode.value==='export')void hide()})
onMounted(async()=>{try{applications.value=(await window.manager.load()).instanceApplications??[];await poll();if(alive)timer=setInterval(()=>void poll(),750)}catch(cause){if(alive)error.value=String(cause)}})
onUnmounted(()=>{alive=false;generation++;clearInterval(timer);void window.manager.discardSessionArchive().catch(()=>{})})
</script>
<template>
  <div class="session-archives">
    <div class="archive-toolbar"><a-button :disabled="reading||running||loading||!selectedIds.length||!snapshotId" @click="begin('export')">导出 ZIP</a-button><a-button :disabled="running||loading" @click="begin('import')">导入 ZIP</a-button><span class="muted">兼容 Cockpit 会话包，保留完整对话和工具记录。</span></div>
    <a-alert v-if="error&&!open" type="error" :message="error" class="error-banner" />
    <a-card v-if="state&&state.status!=='ready'" size="small" class="archive-progress"><div class="archive-toolbar"><strong>{{state.operation==='export'?'会话导出':'会话导入'}} · {{labels[state.status]}}</strong><span class="toolbar-spacer" /><a-button v-if="running" @click="cancel">取消</a-button></div><a-progress v-if="running" :percent="percent" /><p class="muted">{{state.files}} / {{state.totalFiles}} 个文件 · {{bytes(state.bytes)}} / {{bytes(state.totalBytes)}}</p><p v-if="state.path" class="archive-path">已保存到 {{state.path}}</p><a-alert v-if="state.error" :type="state.status==='completed'?'warning':state.status==='cancelled'?'info':'error'" :message="state.error" /></a-card>
    <a-modal :open="open" :width="760" :title="mode==='export'?'导出选中会话':'导入会话 ZIP'" :body-style="{maxHeight:'60vh',overflowY:'auto'}" @cancel="hide">
      <div class="session-archive-editor"><a-alert v-if="error" type="error" :message="error" class="error-banner" /><a-spin :spinning="loading">
        <template v-if="preview"><p class="archive-path">{{mode==='import'?preview.fileName:'导出包包含完整对话正文、工具结果和会话元数据。'}}<template v-if="mode==='import'"><br />导出时间：{{preview.exportedAt}}</template></p><p class="muted">{{preview.items.length}} 个会话 · {{bytes(preview.totalBytes)}}</p>
          <template v-if="mode==='import'"><a-form layout="vertical"><a-form-item label="导入目标目录"><a-select v-model:value="targetId" aria-label="ZIP 导入目标" :disabled="loading" :options="targets.map(t=>({value:t.id,label:t.name+' · '+t.directory}))" @change="invalidate" /></a-form-item><a-form-item label="用于更新会话列表的 Codex 程序"><a-select v-model:value="applicationId" aria-label="ZIP 索引程序" :disabled="loading" :options="applications.map(a=>({value:a.id,label:a.name+' · '+a.path}))" @change="invalidate" /><a-space><a-button type="link" :disabled="loading" @click="chooseCli">选择 CLI 程序</a-button><a-button type="link" :disabled="loading" @click="chooseApp">选择桌面应用</a-button></a-space></a-form-item></a-form></template>
          <a-table class="archive-items" :data-source="preview.items" row-key="id" size="small" :pagination="preview.items.length>8?{pageSize:8,showSizeChanger:false}:false" :row-selection="mode==='import'?{selectedRowKeys:importIds,onChange:selected,preserveSelectedRowKeys:true,getCheckboxProps:()=>({disabled:loading})}:undefined"><a-table-column key="title" title="会话"><template #default="{record}"><div class="archive-title">{{record.title||record.id}}</div><small class="muted">{{record.id}}</small></template></a-table-column><a-table-column key="source" title="来源"><template #default="{record}">{{record.sourceName}}<a-tag v-if="record.archived">已归档</a-tag></template></a-table-column><a-table-column key="size" title="大小"><template #default="{record}">{{bytes(record.bytes)}}</template></a-table-column><a-table-column v-if="importPreview" key="status" title="处理"><template #default="{record}"><a-tag v-if="importPreview.existing[record.id]" :color="importPreview.existing[record.id]==='conflict'?'orange':undefined">{{importPreview.existing[record.id]==='duplicate'?'相同，跳过':'冲突，保留目标'}}</a-tag><a-tag v-else-if="importIds.includes(record.id)" color="purple">导入</a-tag><span v-else>未选中</span></template></a-table-column></a-table>
          <template v-if="importPreview"><p class="muted">已校验所选文件。{{importPreview.items.filter(i=>i.status==='ready').length}} 个新会话将导入；同 ID 会话不覆盖。确认后会短暂启动所选 Codex 更新会话列表。</p><a-checkbox v-model:checked="closed" class="archive-closed">我已关闭使用目标目录的 Codex 客户端及 CLI</a-checkbox></template>
        </template><p v-else class="muted">正在准备会话包预览…</p>
      </a-spin></div><template #footer><a-button @click="hide">返回</a-button><a-button v-if="loading&&running" @click="cancel">取消校验</a-button><a-button v-else-if="mode==='import'&&!importPreview" type="primary" :disabled="!preview||!targetId||!applicationId||!importIds.length" @click="prepareImport">校验并预览导入</a-button><a-button v-else type="primary" :loading="loading" :disabled="!preview||mode==='import'&&!closed" @click="confirm">{{mode==='export'?'选择位置并导出':'确认导入'}}</a-button></template>
    </a-modal>
  </div>
</template>
<style scoped>
.archive-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}.archive-toolbar>.muted,.archive-progress p{font-size:12px}.archive-progress{margin-bottom:16px}.archive-path,.archive-title{overflow-wrap:anywhere}.archive-items small{font-size:10px;overflow-wrap:anywhere}.session-archive-editor :deep(.ant-select){width:100%}.archive-closed{margin:12px 0}.archive-items :deep(td){max-width:260px}
</style>
