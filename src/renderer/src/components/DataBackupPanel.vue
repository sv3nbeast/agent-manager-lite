<script setup lang="ts">
import {computed,onBeforeUnmount,ref} from 'vue'
import type {BackupCounts,BackupPreview,BackupRestoreResult} from '../../../shared/dataBackup'
import {useManager} from '../store'

const manager=useManager(),open=ref(false),mode=ref<'export'|'restore'>('export'),password=ref(''),repeat=ref('')
const operation=ref(''),error=ref(''),preview=ref<BackupPreview>(),result=ref<BackupRestoreResult>(),exportPath=ref(''),confirmed=ref(false)
let generation=0
const valid=computed(()=>password.value.length>=8&&password.value.length<=1024&&(mode.value==='restore'||password.value===repeat.value))
const counts:{key:keyof BackupCounts;label:string}[]=[{key:'accounts',label:'账号'},{key:'groups',label:'分组'},{key:'providers',label:'供应商'},{key:'localKeys',label:'本地 API 密钥'},{key:'instances',label:'实例定义'},{key:'recycledAccounts',label:'回收站账号'}]
const message=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'')
function begin(next:'export'|'restore'){
  generation++;mode.value=next;password.value='';repeat.value='';error.value='';preview.value=undefined;result.value=undefined;exportPath.value='';confirmed.value=false;open.value=true
}
async function discard(){const value=preview.value;preview.value=undefined;if(value)await window.manager.discardDataBackup(value.ticket).catch(()=>{})}
async function cancel(){const id=operation.value;if(id)await window.manager.cancelDataBackup(id)}
async function close(){
  generation++;open.value=false;password.value='';repeat.value='';confirmed.value=false
  await cancel().catch(()=>{});await discard()
}
onBeforeUnmount(()=>{void close()})
async function choose(){
  if(!valid.value||operation.value)return
  const id=crypto.randomUUID(),version=generation,input={requestId:id,password:password.value}
  operation.value=id;error.value=''
  try{
    if(mode.value==='export'){
      const value=await window.manager.exportDataBackup(input)
      if(version===generation&&open.value&&value)exportPath.value=value.path
    }else{
      const value=await window.manager.previewDataBackup(input)
      if(version!==generation||!open.value){if(value)await window.manager.discardDataBackup(value.ticket);return}
      preview.value=value
    }
  }catch(cause){if(version===generation)error.value=message(cause)}
  finally{input.password='';password.value='';repeat.value='';if(operation.value===id)operation.value=''}
}
async function apply(){
  if(!preview.value||!confirmed.value||operation.value)return
  const id=crypto.randomUUID(),version=generation,ticket=preview.value.ticket;operation.value=id;error.value=''
  try{
    const value=await window.manager.restoreDataBackup({ticket,requestId:id,confirmed:true})
    // Refresh even if this component was closed after the atomic commit: the
    // application-wide restart banner must remain visible on every page.
    await manager.refresh()
    if(version===generation){result.value=value;preview.value=undefined}
  }catch(cause){if(version===generation){error.value=message(cause);preview.value=undefined;confirmed.value=false}}
  finally{if(operation.value===id)operation.value=''}
}
async function restart(){try{await window.manager.restartAfterBackup()}catch(cause){error.value=message(cause)}}
</script>

<template>
  <div class="data-backup-panel">
    <p>备份账号凭据、分组、供应商、模型与 Fast 设置、本地 API 配置和实例定义。</p>
    <p class="muted">客户端目录文件、会话和调用记录不包含在配置备份中；本地目录绑定不会迁移。已有密钥的累计用量会保留。</p>
    <a-space><a-button :disabled="!!operation||manager.data?.backupRestartRequired" @click="begin('export')">导出加密备份</a-button><a-button :disabled="!!operation||manager.data?.backupRestartRequired" @click="begin('restore')">从备份恢复</a-button></a-space>
    <a-modal :open="open" :title="mode==='export'?'导出配置备份':'恢复配置备份'" :width="660" :footer="null" :mask-closable="false" destroy-on-close @cancel="close">
      <div class="data-backup-dialog">
        <template v-if="!preview&&!result&&!exportPath">
          <p>{{mode==='export'?'备份使用你设置的密码加密，可在另一台电脑的管理器中恢复。':'选择备份后先查看内容数量，确认后替换当前管理配置。'}}</p>
          <a-form layout="vertical" @submit.prevent="choose">
            <a-form-item label="备份密码" extra="8–1024 个字符；恢复时需要相同密码。"><a-input-password class="backup-password" v-model:value="password" :disabled="!!operation" autocomplete="off" :maxlength="1024" /></a-form-item>
            <a-form-item v-if="mode==='export'" label="再次输入密码"><a-input-password class="backup-repeat" v-model:value="repeat" :disabled="!!operation" autocomplete="off" :maxlength="1024" /></a-form-item>
          </a-form>
          <a-button type="primary" :loading="!!operation" :disabled="!valid||!!operation" @click="choose">{{mode==='export'?'选择位置并导出':'选择文件并预览'}}</a-button>
        </template>
        <template v-if="preview">
          <p><strong>{{preview.fileName}}</strong> · {{new Date(preview.exportedAt).toLocaleString()}}</p>
          <table class="backup-counts"><thead><tr><th>内容</th><th>当前</th><th>恢复后</th></tr></thead><tbody><tr v-for="row in counts" :key="row.key"><td>{{row.label}}</td><td>{{preview.current[row.key]}}</td><td>{{preview.incoming[row.key]}}</td></tr></tbody></table>
          <p>恢复将替换当前账号和管理设置。恢复前会自动保存一份回滚备份，密码与本次导入的备份相同。</p>
          <p class="muted">实例仅恢复定义，不复制客户端文件。源备份中的 {{preview.sourceDirectories}} 个目录登记、{{preview.sourceConnections}} 个客户端关联不迁移；目标本机已有目录登记保留。</p>
          <a-checkbox class="backup-confirm" v-model:checked="confirmed" :disabled="!!operation">确认替换当前管理配置，恢复成功后重启应用</a-checkbox>
          <div class="backup-actions"><a-button type="primary" danger :loading="!!operation" :disabled="!confirmed||!!operation" @click="apply">确认恢复</a-button></div>
        </template>
        <a-alert v-if="exportPath" type="success" show-icon message="加密备份已导出"><template #description><code>{{exportPath}}</code></template></a-alert>
        <template v-if="result">
          <a-alert type="success" show-icon message="配置已恢复，重启后生效" />
          <p>恢复前的配置保存在：</p><code class="backup-path">{{result.rollbackPath}}</code>
          <div class="backup-actions"><a-button type="primary" @click="restart">立即重启</a-button></div>
        </template>
        <a-alert v-if="error" type="error" show-icon :message="error" class="backup-error" />
        <a-button v-if="operation" class="backup-cancel" @click="cancel">取消操作</a-button>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.data-backup-panel{margin-top:18px}.data-backup-panel p,.data-backup-dialog p{line-height:1.7}
.backup-counts{border-collapse:collapse;width:100%;margin:20px 0}.backup-counts th,.backup-counts td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border,#e5e7eb)}
.backup-actions,.backup-cancel,.backup-error{margin-top:16px}.backup-path,.data-backup-dialog code{display:block;overflow-wrap:anywhere;font-size:12px;line-height:1.8}
</style>
