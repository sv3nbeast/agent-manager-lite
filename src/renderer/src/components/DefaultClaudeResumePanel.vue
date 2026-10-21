<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch} from 'vue'
import type {SessionRecord,DefaultClaudeSessionResumePreview} from '../../../shared/sessions'

const props=defineProps<{snapshotId:string;record:SessionRecord;targetId:string}>()
const emit=defineEmits<{close:[];started:[]}>()
const preview=ref<DefaultClaudeSessionResumePreview>(),loading=ref(false),starting=ref(false),error=ref('')
let generation=0,alive=true
async function discard(ticket?:string){if(!ticket)return;try{await window.manager.discardDefaultClaudeSessionResume(ticket)}catch(cause){if(alive)error.value=String(cause)}}
async function prepare(){
  const current=++generation,old=preview.value?.ticket;preview.value=undefined;loading.value=true;error.value='';await discard(old);if(!alive||current!==generation)return
  try{const next=await window.manager.previewDefaultClaudeSessionResume({snapshotId:props.snapshotId,sessionId:props.record.id,targetId:props.targetId});if(!alive||current!==generation){await discard(next.ticket);return}preview.value=next}
  catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive&&current===generation)loading.value=false}
}
async function close(){if(starting.value)return;generation++;const ticket=preview.value?.ticket;preview.value=undefined;await discard(ticket);if(alive)emit('close')}
async function start(){if(!preview.value||starting.value)return;starting.value=true;error.value='';const ticket=preview.value.ticket;try{await window.manager.startDefaultClaudeSessionResume(ticket);if(!alive)return;preview.value=undefined;emit('started');emit('close')}catch(cause){if(alive)error.value=String(cause)}finally{if(alive)starting.value=false}}
watch(()=>[props.snapshotId,props.record.id,props.targetId],()=>void prepare())
onMounted(()=>void prepare())
onUnmounted(()=>{alive=false;generation++;void discard(preview.value?.ticket)})
</script>

<template>
  <a-modal open title="在 Terminal 中继续 Claude 会话" :width="700" :closable="!starting" :mask-closable="!starting" :keyboard="!starting" @cancel="close">
    <a-alert type="info" message="此操作会使用本机默认 Claude Code 身份，并通过 --fork-session 创建新会话，不修改原对话。它不使用管理器实例账号、隔离配置或代理；Terminal 启动后由你在终端继续使用，管理器无法停止或恢复该进程。" class="resume-boundary" />
    <a-alert v-if="error" type="error" :message="error" class="error-banner" />
    <a-spin :spinning="loading"><h3>{{record.title}}</h3><a-descriptions v-if="preview" :column="1" bordered size="small"><a-descriptions-item label="CLI">{{preview.cliApplication}}</a-descriptions-item><a-descriptions-item label="项目目录">{{preview.cwd}}</a-descriptions-item><a-descriptions-item label="会话 ID">{{preview.sessionId}}</a-descriptions-item><a-descriptions-item label="操作">新建分叉，不修改原会话</a-descriptions-item></a-descriptions></a-spin>
    <template #footer><a-button :disabled="starting" @click="close">取消</a-button><a-button v-if="!preview&&!loading" :disabled="starting" @click="prepare">重新预览</a-button><a-button type="primary" :loading="starting" :disabled="loading||!preview" @click="start">在 Terminal 中分叉继续</a-button></template>
  </a-modal>
</template>

<style scoped>
.resume-boundary{margin-bottom:16px}.resume-boundary :deep(.ant-alert-description){line-height:1.8}.session-resume-preview h3{overflow-wrap:anywhere}
</style>
