<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch} from 'vue'
import {message} from 'ant-design-vue'
import type {SessionRecord,CodexResumeSelection} from '../../../shared/sessions'
import {useManager} from '../store'
type Preview={ticket:string;sessionId:string;cwd:string;path:string;root:string;instanceId:string;instanceRevision:number;profileFingerprint:string;targetId:string;cwdCanonicalPath:string;cwdDevice:number;cwdInode:number;name:string;application:string;executable:string;directory:string;desktopDirectory:string;workingDirectory:string;args:string[];accountName:string;model:string;connectionMode:'native'|'local_api'}
const props=defineProps<{snapshotId:string;record:SessionRecord;targetId:string}>()
const emit=defineEmits<{close:[];started:[instanceId:string]}>()
const manager=useManager(),preview=ref<Preview>(),loading=ref(false),starting=ref(false),error=ref('')
let generation=0,alive=true
async function discard(ticket?:string){if(ticket)try{await window.manager.discardCodexSessionResume(ticket)}catch(cause){if(alive)error.value=String(cause)}}
async function prepare(){const current=++generation,previous=preview.value?.ticket;preview.value=undefined;loading.value=true;error.value='';await discard(previous);try{const selection:CodexResumeSelection={snapshotId:props.snapshotId,sessionId:props.record.id,targetId:props.targetId};const next=await window.manager.previewCodexSessionResume(selection) as unknown as Preview;if(!alive||current!==generation){await discard(next.ticket);return}preview.value=next}catch(cause){if(alive&&current===generation)error.value=String(cause)}finally{if(alive&&current===generation)loading.value=false}}
async function close(){if(starting.value)return;generation++;await discard(preview.value?.ticket);preview.value=undefined;if(alive)emit('close')}
async function start(){if(!preview.value||starting.value)return;const selected=preview.value;starting.value=true;error.value='';try{const started=await manager.execute(()=>window.manager.startInstance(selected.ticket));if(!alive)return;if(!started){preview.value=undefined;await discard(selected.ticket);error.value=manager.error||'会话恢复未能开始，请刷新后重试';return}preview.value=undefined;message.success('Codex 会话已在原 CLI 实例启动');emit('started',selected.instanceId);emit('close')}finally{if(alive)starting.value=false}}
watch(()=>[props.snapshotId,props.record.id,props.targetId],()=>void prepare())
onMounted(()=>void prepare())
onUnmounted(()=>{alive=false;generation++;void discard(preview.value?.ticket)})
</script>
<template><a-modal open title="恢复 Codex 会话" :width="700" :closable="!starting" :mask-closable="!starting" :keyboard="!starting" @cancel="close"><div class="codex-resume-preview"><a-alert v-if="error" type="error" :message="error"/><a-spin :spinning="loading"><h3>{{record.title}}</h3><p>仅在原受管 Codex CLI 实例中，使用本机 CLI 的 resume 命令继续此当前会话。</p><a-descriptions v-if="preview" bordered size="small" :column="1"><a-descriptions-item label="实例">{{preview.name}}</a-descriptions-item><a-descriptions-item label="程序">{{preview.executable}}</a-descriptions-item><a-descriptions-item label="工作目录">{{preview.workingDirectory}}</a-descriptions-item><a-descriptions-item label="会话 ID">{{preview.sessionId}}</a-descriptions-item><a-descriptions-item label="命令">codex resume {{preview.sessionId}}</a-descriptions-item></a-descriptions></a-spin></div><template #footer><a-button :disabled="starting" @click="close">取消</a-button><a-button v-if="!preview&&!loading" :disabled="starting" @click="prepare">重新预览</a-button><a-button type="primary" :loading="starting" :disabled="loading||!preview" @click="start">在原实例恢复</a-button></template></a-modal></template>
<style scoped>.codex-resume-preview h3{overflow-wrap:anywhere}.codex-resume-preview p{font-size:12px;line-height:1.7}.codex-resume-preview :deep(.ant-descriptions-item-content){overflow-wrap:anywhere}</style>
