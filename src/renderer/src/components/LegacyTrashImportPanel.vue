<script setup lang="ts">
import {computed,onUnmounted,ref} from 'vue'
import type {ClientConfigTarget} from '../../../shared/clientConfig'
import type {LegacyTrashPage,TrashPreview,TrashState} from '../../../shared/sessionTrash'
const props=defineProps<{state:TrashState}>(),emit=defineEmits<{update:[state:TrashState]}>()
const open=ref(false),loading=ref(false),error=ref(''),source=ref<LegacyTrashPage>(),targets=ref<ClientConfigTarget[]>([]),selected=ref<string[]>([]),mappings=ref<Record<string,string>>({}),groupsById=ref<Record<string,string[]>>({}),preview=ref<TrashPreview>(),confirmed=ref(false)
const running=computed(()=>!!props.state.job&&['preparing','running'].includes(props.state.job.status))
const groupIds=computed(()=>new Set(selected.value.flatMap(id=>groupsById.value[id]??[])))
const ready=computed(()=>!!source.value&&!!selected.value.length&&[...groupIds.value].every(id=>!!mappings.value[id]))
const bytes=(n:number)=>n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB'
let alive=true,generation=0,invalidating=Promise.resolve()
function cache(value:LegacyTrashPage){source.value=value;for(const row of value.items)groupsById.value[row.id]=row.groupIds}
function invalidate(){generation++;preview.value=undefined;confirmed.value=false;invalidating=invalidating.then(()=>window.manager.discardSessionTrash()).catch(cause=>{if(alive)error.value=String(cause)})}
async function begin(){open.value=true;error.value='';try{targets.value=await window.manager.listClientConfigs()}catch(cause){error.value=String(cause)}}
async function choose(){
  invalidate();const current=generation;loading.value=true;error.value=''
  try{
    await invalidating;const value=await window.manager.chooseLegacySessionTrash()
    if(alive&&generation===current&&value){cache(value);selected.value=[];mappings.value={};for(const group of value.groups){const target=targets.value.find(row=>row.directory===group.originalRoot);if(target)mappings.value[group.id]=target.id}}
  }catch(cause){if(alive&&generation===current)error.value=String(cause)}finally{if(alive&&generation===current)loading.value=false}
}
async function page(number:number){if(!source.value)return;loading.value=true;try{cache(await window.manager.legacySessionTrashPage({snapshotId:source.value.snapshotId,page:number}))}catch(cause){error.value=String(cause)}finally{loading.value=false}}
function select(keys:(string|number)[]){if(keys.length>1000){error.value='每次最多选择 1000 个不同会话，请分批导入。';return};selected.value=keys.map(String);invalidate()}
async function prepare(){
  if(!source.value||!ready.value)return;const current=generation;loading.value=true;error.value=''
  try{await invalidating;const result=await window.manager.previewLegacySessionTrash({snapshotId:source.value.snapshotId,sessionIds:[...selected.value],mappings:[...groupIds.value].map(id=>({sourceId:id,targetId:mappings.value[id]}))});if(alive&&generation===current)preview.value=result}
  catch(cause){if(alive&&generation===current)error.value=String(cause)}finally{if(alive&&generation===current)loading.value=false}
}
async function start(){
  if(!preview.value||!confirmed.value)return;loading.value=true;error.value=''
  try{emit('update',await window.manager.startSessionTrash({ticket:preview.value.ticket,confirmed:true}));open.value=false;source.value=undefined;preview.value=undefined;groupsById.value={};selected.value=[];generation++;await window.manager.discardLegacySessionTrash()}
  catch(cause){error.value=String(cause)}finally{loading.value=false}
}
async function close(){generation++;open.value=false;loading.value=false;source.value=undefined;preview.value=undefined;groupsById.value={};selected.value=[];await invalidating;await window.manager.discardLegacySessionTrash().catch(()=>{})}
async function cancel(){if(props.state.job)try{emit('update',await window.manager.cancelSessionTrash(props.state.job.id))}catch(cause){error.value=String(cause)}}
onUnmounted(()=>{alive=false;if(open.value)void close()})
</script>

<template>
  <a-button :disabled="running||loading" @click="begin">导入旧废纸篓</a-button>
  <a-modal :open="open" title="导入 Cockpit 会话废纸篓" :width="940" :body-style="{maxHeight:'65vh',overflowY:'auto'}" @cancel="close">
    <div class="legacy-trash-editor">
      <p class="muted">选择 Cockpit 的会话废纸篓根目录、日期批次或单个条目。主废纸篓与旧版 ~/.Trash 中的备份均支持。导入将保留旧备份，之后可在本应用废纸篓中恢复。</p>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
      <a-button :disabled="running||loading" @click="choose">选择旧废纸篓目录</a-button>
      <p v-if="loading" class="muted">正在校验备份，请稍候…</p>
      <template v-if="source">
        <p class="legacy-source">{{source.root}}</p><p>{{source.total}} 个会话 · {{source.copies}} 份备份 · {{bytes(source.bytes)}} · 已选 {{selected.length}}</p>
        <a-table class="legacy-trash-items" row-key="id" :data-source="source.items" size="small" :pagination="false" :scroll="{y:260}" :row-selection="{selectedRowKeys:selected,onChange:select,preserveSelectedRowKeys:true,getCheckboxProps:()=>({disabled:loading||running})}">
          <a-table-column key="title" title="会话"><template #default="{record}"><strong>{{record.title||record.id}}</strong><div class="muted legacy-meta">{{record.id}}</div></template></a-table-column>
          <a-table-column key="copies" title="备份" data-index="copies" :width="65" />
          <a-table-column key="bytes" title="大小" :width="100"><template #default="{record}">{{bytes(record.bytes)}}</template></a-table-column>
          <a-table-column key="deletedAt" title="原删除时间" :width="160"><template #default="{record}">{{record.deletedAt?new Date(record.deletedAt).toLocaleString():'未知'}}</template></a-table-column>
        </a-table>
        <a-pagination v-if="source.total>25" :current="source.page" :total="source.total" :page-size="25" :show-size-changer="false" :disabled="loading||running" @change="page" />
        <div v-if="selected.length" class="legacy-mappings"><h3>确认恢复目标</h3><p class="muted">这里只登记备份的恢复位置。导入完成后，会话仍留在废纸篓；需要时另行点击“恢复所选”。可先在客户端配置中登记其他目标目录。尚未创建的受管目录将在确认导入时建立为空目录。</p>
          <a-form layout="vertical"><a-form-item v-for="group in source.groups.filter(row=>groupIds.has(row.id))" :key="group.id" :label="group.name||'原目录'"><div class="muted legacy-meta">{{group.originalRoot}}</div><a-select v-model:value="mappings[group.id]" :aria-label="'旧备份目标 '+group.name" :disabled="loading||running" :options="targets.map(target=>({value:target.id,label:target.name+' · '+target.directory}))" @change="invalidate" /></a-form-item></a-form>
        </div>
        <div v-if="preview" class="legacy-trash-preview"><p><strong>{{preview.copies}} 份备份将导入 · {{preview.skippedCopies??0}} 份已有备份跳过 · {{bytes(preview.bytes)}}</strong></p><div v-for="target in preview.targets" :key="target.id" class="legacy-target">{{target.name}} · {{target.copies}} 份<div class="muted legacy-meta">{{target.directory}}</div></div><a-checkbox v-model:checked="confirmed" class="legacy-confirm" :disabled="loading||running">我已核对恢复目录和导入范围</a-checkbox></div>
      </template>
    </div>
    <template #footer><a-button @click="close">关闭</a-button><a-button v-if="running" @click="cancel">取消操作</a-button><a-button v-else-if="!preview" type="primary" :disabled="!ready" :loading="loading" @click="prepare">预览导入</a-button><a-button v-else type="primary" :disabled="!confirmed" :loading="loading" @click="start">确认导入备份</a-button></template>
  </a-modal>
</template>

<style scoped>
.legacy-trash-editor>.muted,.legacy-mappings>.muted{font-size:12px;line-height:1.8}.legacy-source,.legacy-meta{overflow-wrap:anywhere;font-size:11px}.legacy-trash-editor .ant-pagination{text-align:right;margin:14px 0}.legacy-mappings{margin-top:24px}.legacy-mappings .ant-select{width:100%}.legacy-target{margin:12px 0}.legacy-confirm{margin-top:16px}.legacy-trash-preview{padding:16px;border-radius:12px;background:var(--surface-soft,#faf7ff)}
</style>
