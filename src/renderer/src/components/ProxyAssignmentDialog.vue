<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {useManager} from '../store'
import type {AccountProxyView} from '../../../shared/accountProxy'
import type {ProxyAssignmentInput,ProxyAssignmentPreview} from '../../../shared/proxyBatch'
const props=defineProps<{open:boolean;accountIds:string[]}>(),emit=defineEmits<{'update:open':[boolean]}>(),manager=useManager()
const mode=ref<ProxyAssignmentInput['mode']>('resource'),resourceId=ref(''),preview=ref<ProxyAssignmentPreview>(),page=ref(1),busy=ref(false),error=ref('')
const resources=computed(()=>manager.data?.proxyResources?.resources??[]),resource=computed(()=>resources.value.find(r=>r.id===resourceId.value))
let generation=0
const displayError=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'')
const route=(view?:AccountProxyView)=>!view?'—':view.invalid?'代理失效':view.mode==='direct'?'直连':view.name??(view.server?`${view.protocol} · ${view.server}:${view.port}`:'默认网络')
async function discard(){const ticket=preview.value?.ticket;preview.value=undefined;if(ticket)await window.manager.discardProxyBatch(ticket).catch(()=>{})}
function clear(){generation++;void discard();busy.value=false;error.value=''}
watch(()=>props.open,()=>{clear();page.value=1;mode.value='resource';resourceId.value=''})
watch(()=>props.accountIds.join(','),()=>{clear()})
onBeforeUnmount(clear)
function close(){clear();emit('update:open',false)}
async function prepare(){
  const version=++generation;busy.value=true;error.value='';await discard()
  try{const result=await window.manager.previewProxyAssignment({accountIds:[...props.accountIds],mode:mode.value,...mode.value==='resource'?{resourceId:resource.value?.id,resourceRevision:resource.value?.revision}:{}})
    if(version!==generation){if(result.ticket)await window.manager.discardProxyBatch(result.ticket);return}
    preview.value=result;page.value=1
  }catch(e){if(version===generation)error.value=displayError(e)}finally{if(version===generation)busy.value=false}
}
async function apply(){
  const ticket=preview.value?.ticket;if(!ticket)return
  busy.value=true;error.value=''
  if(await manager.execute(()=>window.manager.applyProxyBatch({ticket,confirmed:true})))close()
  else{error.value=displayError(manager.error);busy.value=false}
}
</script>
<template>
  <a-modal :open="open" title="批量设置账号代理" :width="850" :footer="null" destroy-on-close @cancel="close">
    <div class="proxy-assignment-dialog">
      <p class="muted">仅处理明确选中的 {{accountIds.length}} 个账号。已有独立设置会被覆盖，相同设置与不适用账号会在预览中标明跳过。</p>
      <a-form v-if="!preview" layout="vertical" @submit.prevent="prepare">
        <a-form-item label="连接方式"><a-select class="proxy-assignment-mode" v-model:value="mode" :disabled="busy" :options="[{value:'resource',label:'使用同一代理资源'},{value:'inherit',label:'恢复继承统一 / 默认网络'},{value:'direct',label:'直连（不使用代理）'}]" /></a-form-item>
        <a-form-item v-if="mode==='resource'" label="代理资源"><a-select class="proxy-assignment-resource" v-model:value="resourceId" :disabled="busy" :options="resources.map(r=>({value:r.id,label:r.name,disabled:r.address.invalid}))" /></a-form-item>
        <a-button type="primary" html-type="submit" :disabled="!accountIds.length||(mode==='resource'&&(!resource||resource.address.invalid))" :loading="busy">预览分配</a-button>
      </a-form>
      <template v-else>
        <p class="proxy-assignment-summary">将修改 {{preview.changed}} · 覆盖独立设置 {{preview.overwritten}} · 相同 {{preview.same}} · 不适用 {{preview.ineligible}}</p>
        <a-alert v-if="preview.busy" type="warning" :message="`${preview.busy} 个待修改账号正在使用，请停止后重新预览。`" />
        <a-table size="small" :data-source="preview.rows" row-key="id" :pagination="{current:page,pageSize:5,showSizeChanger:false,onChange:(p:number)=>page=p}">
          <a-table-column title="账号" key="name" data-index="name" />
          <a-table-column title="原出口" key="before"><template #default="{record}">{{route(record.before)}}</template></a-table-column>
          <a-table-column title="新出口" key="after"><template #default="{record}">{{route(record.after)}}</template></a-table-column>
          <a-table-column title="结果" key="status"><template #default="{record}">{{record.status==='same'?'相同，跳过':record.status==='ineligible'?'不适用，跳过':record.busy?'需先停止':record.overwrite?'覆盖':'设置'}}</template></a-table-column>
        </a-table>
        <p class="muted">确认后整批保存。账号或资源变化会使预览失效；保存失败保留原设置。</p>
        <a-space><a-button type="primary" :disabled="!preview.ticket||!!preview.busy" :loading="busy" @click="apply">确认分配</a-button><a-button :disabled="busy" @click="discard">返回修改</a-button><a-button :disabled="busy" @click="close">取消</a-button></a-space>
      </template>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
    </div>
  </a-modal>
</template>
<style scoped>
.proxy-assignment-dialog{max-height:calc(100vh - 220px);overflow:auto}.proxy-assignment-dialog>.muted{margin:14px 0}.proxy-assignment-summary{margin:18px 0}
</style>
