<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {useFormFeedback} from '../formFeedback'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {InstanceApplication} from '../../../shared/instances'
import type {SessionCopyPreview,SessionTransferView,SessionTransferRecovery} from '../../../shared/sessions'

const props=defineProps<{targets:ClientConfigTarget[];snapshotId?:string;selectedIds:string[];reading:boolean}>()
const emit=defineEmits<{completed:[]}>()
const transfer=ref<SessionTransferView>(),recoveries=ref<SessionTransferRecovery[]>([]),applications=ref<InstanceApplication[]>([])
const open=ref(false),targetId=ref<string>(),applicationId=ref<string>(),preview=ref<SessionCopyPreview>(),retryId=ref<string>(),clientsClosed=ref(false),loading=ref(false),error=ref('')
useFormFeedback(()=>error.value,{active:()=>open.value})
const running=computed(()=>!!transfer.value&&['copying','committing','indexing'].includes(transfer.value.status))
const labels={copying:'正在复制',committing:'正在保存文件',indexing:'正在更新 Codex 会话列表',completed:'复制已完成',cancelled:'操作已取消',failed:'复制失败',recovery_required:'需要处理恢复记录'}
const bytes=(value:number)=>value<1024?value+' B':value<1024**2?(value/1024).toFixed(1)+' KiB':value<1024**3?(value/1024**2).toFixed(1)+' MiB':(value/1024**3).toFixed(2)+' GiB'
const progress=computed(()=>transfer.value?.totalBytes?Math.min(100,Math.floor(transfer.value.bytes/transfer.value.totalBytes*100)):0)
let alive=true,generation=0,polling=false,timer:ReturnType<typeof setInterval>|undefined,observedActive=false
function apply(state:{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}){
  if(!alive)return
  transfer.value=state.transfer;recoveries.value=state.recoveries
  if(running.value)observedActive=true
  else if(observedActive){observedActive=false;emit('completed')}
}
async function poll(){if(polling)return;polling=true;try{apply(await window.manager.sessionTransferState())}catch(cause){if(alive)error.value=String(cause)}finally{polling=false}}
function invalidate(){generation++;preview.value=undefined;clientsClosed.value=false;void window.manager.discardSessionCopy().catch(cause=>{if(alive)error.value=String(cause)})}
function close(){open.value=false;retryId.value=undefined;invalidate()}
function begin(id?:string){invalidate();error.value='';retryId.value=id;targetId.value=undefined;applicationId.value=applications.value[0]?.id;open.value=true}
async function chooseCli(){try{const data=await window.manager.chooseInstanceCli();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>app.kind==='cli').at(-1)?.id;invalidate()}}catch(cause){error.value=String(cause)}}
async function chooseApp(){try{const data=await window.manager.chooseInstanceApplication();if(alive){applications.value=data.instanceApplications??[];applicationId.value=applications.value.filter(app=>app.kind!=='cli').at(-1)?.id;invalidate()}}catch(cause){error.value=String(cause)}}
async function prepare(){
  if(!props.snapshotId||!targetId.value||!applicationId.value)return
  const current=++generation;loading.value=true;error.value=''
  try{const result=await window.manager.previewSessionCopy({snapshotId:props.snapshotId,sessionIds:[...props.selectedIds],targetId:targetId.value,applicationId:applicationId.value});if(alive&&open.value&&current===generation)preview.value=result}
  catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive)loading.value=false}
}
async function confirm(){
  if(!clientsClosed.value||!applicationId.value)return
  loading.value=true;error.value=''
  try{
    if(retryId.value){const task=window.manager.retrySessionTransfer({id:retryId.value,applicationId:applicationId.value,clientsClosed:true});open.value=false;observedActive=true;apply(await task)}
    else if(preview.value){observedActive=true;apply(await window.manager.startSessionCopy({ticket:preview.value.ticket,clientsClosed:true}));open.value=false;preview.value=undefined}
  }catch(cause){if(alive){error.value=String(cause);await poll()}}finally{if(alive)loading.value=false}
}
async function cancel(){if(!transfer.value)return;try{apply(await window.manager.cancelSessionTransfer(transfer.value.id))}catch(cause){if(alive)error.value=String(cause)}}
async function backup(id:string){try{await window.manager.openSessionTransferBackup(id)}catch(cause){error.value=String(cause)}}
watch(()=>[props.snapshotId,...props.selectedIds],()=>{if(open.value&&!retryId.value)close()})
onMounted(async()=>{try{const [data,state]=await Promise.all([window.manager.load(),window.manager.sessionTransferState()]);if(alive){applications.value=data.instanceApplications??[];apply(state);timer=setInterval(()=>void poll(),750)}}catch(cause){if(alive)error.value=String(cause)}})
onUnmounted(()=>{alive=false;generation++;clearInterval(timer);void window.manager.discardSessionCopy().catch(()=>{})})
</script>

<template>
  <div class="session-transfers">
    <div class="transfer-toolbar"><span class="muted">已选 {{selectedIds.length}} 个会话</span><a-button :disabled="reading||running||loading||!selectedIds.length||!snapshotId" @click="begin()">复制到其他目录</a-button></div>
    <a-alert v-if="error&&!open" type="error" :message="error" class="error-banner" />
    <a-card v-if="transfer" size="small" class="transfer-progress">
      <div class="transfer-toolbar"><strong>{{labels[transfer.status]}} · {{transfer.targetName}}</strong><span class="toolbar-spacer" /><a-button v-if="running" :disabled="transfer.status==='committing'" @click="cancel">{{transfer.status==='indexing'?'停止索引更新':'取消复制'}}</a-button></div>
      <a-progress v-if="running" :percent="progress" :show-info="transfer.status==='copying'" />
      <p class="muted">{{transfer.files}} / {{transfer.totalFiles}} 个文件 · {{bytes(transfer.bytes)}} / {{bytes(transfer.totalBytes)}}<template v-if="transfer.skipped"> · 跳过 {{transfer.skipped}} 个已有会话</template></p>
      <a-alert v-if="transfer.indexError" type="warning" message="文件已复制，Codex 会话列表更新尚未完成" :description="transfer.indexError" />
      <a-alert v-else-if="transfer.error" :type="transfer.status==='cancelled'?'info':'error'" :message="transfer.error" />
      <p v-if="transfer.status==='indexing'" class="muted">停止更新会保留已复制文件，可稍后重试。</p>
    </a-card>
    <a-alert v-for="entry in recoveries" :key="entry.id" type="warning" class="transfer-recovery"><template #message>{{entry.targetName}} · 有待恢复的会话操作</template><template #description><p>{{entry.message}}</p><p v-if="!entry.targetId">恢复记录无法读取，已暂停新的目录写入。请先打开备份目录检查记录。</p><a-space><a-button :disabled="running||loading||!entry.targetId" @click="begin(entry.id)">重试恢复</a-button><a-button @click="backup(entry.id)">打开备份目录</a-button></a-space></template></a-alert>
    <a-modal :open="open" :width="720" :title="retryId?'恢复会话操作':'复制选中的会话'" :body-style="{maxHeight:'60vh',overflowY:'auto'}" @cancel="close">
      <div class="session-copy-editor">
        <a-alert v-if="error" type="error" :message="error" class="error-banner" />
        <a-form layout="vertical">
          <a-form-item v-if="!retryId" label="目标目录"><a-select v-model:value="targetId" aria-label="会话复制目标" :options="targets.map(target=>({value:target.id,label:target.name+' · '+target.directory}))" placeholder="选择已登记目录" :disabled="loading" @change="invalidate" /></a-form-item>
          <a-form-item label="用于更新会话列表的 Codex 程序"><a-select v-model:value="applicationId" aria-label="会话索引程序" :options="applications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" placeholder="选择 Codex 桌面应用或 CLI" :disabled="loading" @change="invalidate" /><a-space><a-button type="link" :disabled="loading" @click="chooseCli">选择 CLI 程序</a-button><a-button type="link" :disabled="loading" @click="chooseApp">选择桌面应用</a-button></a-space></a-form-item>
        </a-form>
        <template v-if="preview">
          <p class="copy-destination">复制到 {{preview.targetName}}：{{preview.directory}}</p><p class="muted">{{preview.items.filter(item=>item.status==='ready').length}} 个新会话 · {{bytes(preview.totalBytes)}}。保留来源，目标已有的同 ID 会话会跳过。</p>
          <a-table :data-source="preview.items" row-key="id" size="small" :pagination="preview.items.length>10?{pageSize:10,showSizeChanger:false}:false" class="copy-preview-table">
            <a-table-column key="title" title="会话"><template #default="{record}"><div class="copy-title">{{record.title}}</div><small class="muted">{{record.id}}</small></template></a-table-column>
            <a-table-column key="source" title="来源"><template #default="{record}"><span :title="record.sourceDirectory">{{record.sourceName}}</span></template></a-table-column>
            <a-table-column key="status" title="处理"><template #default="{record}"><a-tag :color="record.status==='ready'?'purple':undefined">{{record.status==='ready'?'复制':'已有，跳过'}}</a-tag></template></a-table-column>
          </a-table>
        </template>
        <template v-if="preview||retryId"><a-checkbox v-model:checked="clientsClosed" class="copy-closed">我已关闭使用相关来源和目标目录的 Codex 客户端及 CLI</a-checkbox><p class="muted">更新会话列表会短暂启动所选 Codex 的后台进程。不会启动模型对话。</p></template>
      </div>
      <template #footer><div class="copy-actions"><a-button @click="close">返回</a-button><a-button v-if="!preview&&!retryId" type="primary" :loading="loading" :disabled="!targetId||!applicationId" @click="prepare">预览复制</a-button><a-button v-else type="primary" :disabled="!clientsClosed||!applicationId" :loading="loading" @click="confirm">{{retryId?'开始恢复':'确认复制'}}</a-button></div></template>
    </a-modal>
  </div>
</template>

<style scoped>
.transfer-toolbar{display:flex;align-items:center;gap:14px;margin-bottom:12px}.transfer-progress,.transfer-recovery{margin-bottom:16px}.transfer-progress p{margin:6px 0;font-size:12px}.session-copy-editor :deep(.ant-select){width:100%}.copy-destination,.copy-title{overflow-wrap:anywhere}.copy-preview-table small{overflow-wrap:anywhere;font-size:10px}.copy-closed{margin:20px 0 8px}.copy-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:18px}.session-copy-editor>.muted{font-size:12px;line-height:1.7}
</style>
