<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {useFormFeedback} from '../formFeedback'
import {message} from 'ant-design-vue'
import type {SessionVisibilityRepairInstance,SessionVisibilityRepairPreview,SessionVisibilityRepairProvider} from '../../../shared/sessionVisibility'

const props=defineProps<{open:boolean;sessionIds:string[]}>()
const emit=defineEmits<{(event:'update:open',value:boolean):void;(event:'completed'):void}>()
const instances=ref<SessionVisibilityRepairInstance[]>([]),providers=ref<SessionVisibilityRepairProvider[]>([]),selectedInstances=ref<string[]>([]),provider=ref(''),preview=ref<SessionVisibilityRepairPreview>(),loading=ref(false),applying=ref(false),error=ref('')
useFormFeedback(()=>error.value,{active:()=>props.open})
const selectedSessionNote=computed(()=>props.sessionIds.length?`仅修复当前选择的 ${props.sessionIds.length} 个会话`:'修复所选目录中侧边栏可见的会话')
const selectedTargets=computed(()=>selectedInstances.value.length?selectedInstances.value:instances.value.map(value=>value.id))
const runningCount=computed(()=>preview.value?.runningInstanceCount??0)
async function load(){loading.value=true;error.value='';try{const [instanceList,providerList]=await Promise.all([window.manager.listSessionVisibilityRepairInstances(),window.manager.listSessionVisibilityRepairProviders()]);instances.value=instanceList.instances;providers.value=providerList.providers;provider.value=providerList.defaultProvider}catch(cause){error.value=String(cause)}finally{loading.value=false}}
async function discard(){const ticket=preview.value?.ticket;preview.value=undefined;if(ticket)await window.manager.discardSessionVisibilityRepair(ticket).catch(()=>{})}
async function close(){if(applying.value)return;await discard();emit('update:open',false)}
async function makePreview(){loading.value=true;error.value='';try{await discard();preview.value=await window.manager.previewSessionVisibilityRepair({
  // `selectedTargets` and `props.sessionIds` can be Vue reactive proxies.
  // Electron's IPC boundary uses structured clone, which rejects proxies;
  // copy both arrays before handing the request to the main process.
  targetIds:[...selectedTargets.value],sessionIds:[...props.sessionIds],targetProvider:provider.value||undefined
})}catch(cause){error.value=String(cause)}finally{loading.value=false}}
async function apply(){const value=preview.value;if(!value)return;applying.value=true;error.value='';try{const result=await window.manager.applySessionVisibilityRepair({ticket:value.ticket,confirmed:true});message.success(result.message);preview.value=undefined;emit('completed');emit('update:open',false)}catch(cause){error.value=String(cause)}finally{applying.value=false}}
function reset(){preview.value=undefined;error.value='';selectedInstances.value=[]}
watch(()=>props.open,open=>{if(open){reset();void load()}else void discard()})
</script>

<template>
  <a-modal :open="props.open" title="修复会话可见性" :width="900" :footer="null" :mask-closable="false" destroy-on-close @cancel="close">
    <a-spin :spinning="loading">
      <a-alert type="info" show-icon message="Quick 修复只更新官方侧边栏所需的 SQLite 元数据，以及被引用 rollout 文件的首条 session_meta。" description="写入前会检查 Codex 客户端和 CLI daemon；检测到正在运行时会拒绝写入。每个目录都会先创建可恢复备份。" />
      <a-alert v-if="error" type="error" class="repair-error" :message="error" />
      <a-form layout="vertical" class="repair-form">
        <a-form-item label="修复目录"><a-select v-model:value="selectedInstances" mode="multiple" allow-clear placeholder="全部已登记目录" :options="instances.map(value=>({value:value.id,label:`${value.name} · ${value.currentProvider}${value.running?'（运行中）':''}`}))" /></a-form-item>
        <a-form-item label="目标 Provider"><a-select v-model:value="provider" :options="providers.map(value=>({value:value.id,label:`${value.id}${value.isDefault?'（当前默认）':''}`}))" /> <span class="muted">{{selectedSessionNote}}</span></a-form-item>
      </a-form>
      <a-alert v-if="runningCount" type="warning" class="repair-error" :message="`预览发现 ${runningCount} 个目录正在运行；确认前请完全退出对应客户端。`" />
      <template v-if="preview">
        <a-divider>变更预览</a-divider>
        <a-descriptions bordered size="small" :column="2">
          <a-descriptions-item label="目录数">{{preview.instanceCount}}</a-descriptions-item>
          <a-descriptions-item label="SQLite 记录">{{preview.updatedSqliteRowCount}}</a-descriptions-item>
          <a-descriptions-item label="rollout 文件">{{preview.changedRolloutFileCount}}</a-descriptions-item>
          <a-descriptions-item label="跳过数据库">{{preview.skippedSqliteFileCount}}</a-descriptions-item>
        </a-descriptions>
        <a-table class="repair-table" size="small" row-key="instanceId" :data-source="preview.items" :pagination="false">
          <a-table-column title="目录" key="instanceName"><template #default="{record}">{{record.instanceName}}</template></a-table-column>
          <a-table-column title="Provider" key="targetProvider"><template #default="{record}">{{record.targetProvider}}</template></a-table-column>
          <a-table-column title="SQLite" key="updatedSqliteRowCount" data-index="updatedSqliteRowCount" />
          <a-table-column title="rollout" key="changedRolloutFileCount" data-index="changedRolloutFileCount" />
          <a-table-column title="状态" key="running"><template #default="{record}"><a-tag v-if="record.running" color="orange">运行中</a-tag><a-tag v-else color="green">可写入</a-tag></template></a-table-column>
        </a-table>
        <a-alert v-if="preview.warnings.length" type="warning" class="repair-error" message="部分文件已跳过" :description="preview.warnings.join('；')" />
      </template>
      <div class="repair-footer"><span class="muted">{{preview?.message||'先生成预览，再确认写入。'}}</span><a-space><a-button :disabled="loading||applying" @click="close">取消</a-button><a-button v-if="preview" :loading="applying" type="primary" :disabled="runningCount>0" @click="apply">确认修复</a-button><a-button v-else type="primary" :loading="loading" @click="makePreview">生成预览</a-button></a-space></div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.repair-form{margin-top:18px}.repair-error{margin-top:14px}.repair-table{margin-top:14px}.repair-footer{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--border,#e5e7eb)}
</style>
