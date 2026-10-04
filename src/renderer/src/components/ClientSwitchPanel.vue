<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {message} from 'ant-design-vue'
import type {ClientSwitchPreview} from '../../../shared/clientSwitch'
import {providerChangeLabel} from '../../../shared/providerConfig'
import {useManager} from '../store'
const props=defineProps<{targetId:string;configRevision:string}>()
const emit=defineEmits<{changed:[]}>()
const manager=useManager(),selected=ref<string>(),preview=ref<ClientSwitchPreview>(),busy=ref(false),error=ref(''),closed=ref(false)
const record=computed(()=>manager.data?.clientSwitches?.find(value=>value.targetId===props.targetId))
const accounts=computed(()=>manager.data?.accounts.filter(a=>a.kind!=='agent_identity'&&a.credentialConfigured&&(a.kind!=='api_key'||a.wireApi==='responses'))??[])
let generation=0
const displayError=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'').replace(/^Error: /,'')
async function stage(restore=false){
  if(busy.value||!restore&&!selected.value)return
  const current=++generation;busy.value=true;error.value='';closed.value=false
  try{
    const result=restore?await window.manager.previewRestoreClientSwitch({targetId:props.targetId}):await window.manager.previewClientSwitch({targetId:props.targetId,accountId:selected.value!})
    if(current===generation)preview.value=result
  }catch(cause){if(current===generation)error.value=displayError(cause)}finally{if(current===generation)busy.value=false}
}
async function apply(){
  if(busy.value||!preview.value||!closed.value)return
  const current=++generation,ticket=preview.value.ticket,restore=preview.value.kind==='restore';busy.value=true;error.value=''
  try{
    await window.manager.applyClientSwitch({ticket,clientClosed:true})
    if(current===generation){preview.value=undefined;message.success(restore?'已恢复原登录，请重新打开客户端':'已切换登录，请重新打开客户端')}
  }catch(cause){if(current===generation){error.value=displayError(cause);preview.value=undefined}}
  finally{await manager.refresh();if(current===generation){busy.value=false;emit('changed')}}
}
async function cancel(){preview.value=undefined;await window.manager.discardClientSwitch(props.targetId)}
watch(()=>[props.targetId,props.configRevision],(_value,old)=>{
  generation++;busy.value=false;preview.value=undefined;closed.value=false;selected.value=undefined
  if(old?.[0])void window.manager.discardClientSwitch(old[0])
})
onBeforeUnmount(()=>{generation++;void window.manager.discardClientSwitch(props.targetId)})
</script>
<template>
  <a-card title="切换此客户端账号" class="settings-card client-switch-panel">
    <p class="muted">将账号写入所选目录，重新打开客户端后生效。支持文件模式的 ChatGPT、PAT 和 Responses API 账号；现有账号须先读取并导入账号库。</p>
    <a-alert v-if="error" type="error" :message="error" class="switch-notice" />
    <template v-if="record">
      <a-alert :type="record.status==='committed'?'info':'warning'" :message="record.status==='committed'?`已切换为 ${record.accountName}`:'上次切换未完整提交，请保持客户端关闭并恢复'" :description="record.previousAccountName?`可恢复原账号：${record.previousAccountName}`:'恢复后移除此应用写入的登录。'" class="switch-notice" />
      <p v-if="record.instanceOwned" class="muted">此登录由实例维护，请从实例页面停止并恢复。</p>
      <template v-else><a-button :disabled="busy" @click="stage(true)">预览恢复原账号</a-button>
      <p class="muted">保留 {{record.historyDepth}} 次切换，可按顺序逐次恢复。</p></template>
    </template>
    <a-space v-if="!record||record.status==='committed'&&!record.instanceOwned" wrap>
      <a-select v-model:value="selected" aria-label="切换目标账号" placeholder="选择账号" :disabled="busy" :options="accounts.map(a=>({value:a.id,label:`${a.name} · ${a.id.slice(0,8)}`}))" style="width:300px" />
      <a-button :disabled="busy||!selected" @click="stage(false)">预览账号切换</a-button>
    </a-space>
    <a-modal class="client-switch-modal" :open="!!preview" :title="preview?.kind==='restore'?'恢复原账号':'确认账号切换'" ok-text="确认写入" cancel-text="取消" :confirm-loading="busy" :ok-button-props="{disabled:busy||!closed}" :cancel-button-props="{disabled:busy}" :closable="!busy" :mask-closable="!busy" @ok="apply" @cancel="cancel">
      <template v-if="preview">
        <p class="switch-path">{{preview.target.directory}}</p>
        <p>{{preview.before?.email||preview.before?.name||'未登录'}} → {{preview.after?.email||preview.after?.name||'未登录'}}</p>
        <p v-if="preview.after?.accountId" class="muted">目标工作区：{{preview.after.accountId}}</p>
        <ul v-if="preview.changes.length"><li v-for="change in preview.changes" :key="change.key">{{providerChangeLabel(change.key)}}：{{change.before}} → {{change.after}}</li></ul>
        <p>请关闭使用此目录的桌面客户端、CLI 和后台 daemon，完成后重新打开。此操作会保存加密恢复记录，保留其他配置；不会自动结束正在工作的进程。</p>
        <a-checkbox v-model:checked="closed">已关闭使用此目录的客户端和后台进程</a-checkbox>
      </template>
    </a-modal>
  </a-card>
</template>
<style scoped>
.switch-notice{margin-bottom:16px}.switch-path{overflow-wrap:anywhere;font-size:12px}.client-switch-panel :deep(.ant-alert-description){overflow-wrap:anywhere}
</style>
<style>
.client-switch-modal .ant-modal-body{max-height:calc(100vh - 290px);overflow-y:auto;overflow-wrap:anywhere}
</style>
