<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {message} from 'ant-design-vue'
import type {ClientIdentityView} from '../../../shared/clientIdentity'
import {useManager} from '../store'
const props=defineProps<{targetId:string;configRevision:string}>()
const manager=useManager(),view=ref<ClientIdentityView>(),busy=ref(false),error=ref('')
const reading=ref(false)
const authority=computed(()=>manager.data?.clientAuthorities?.find(entry=>entry.targetId===props.targetId))
const action=ref<'bind'|'release'>(),clientClosed=ref(false)
const canBind=computed(()=>!authority.value&&view.value?.source==='file'&&view.value.mode==='file'&&view.value.identity?.kind==='oauth'&&view.value.matchedAccountIds.length===1&&!!view.value.ticket)
let generation=0
const modes={file:'本地文件',keyring:'系统凭据库',auto:'优先系统凭据库',ephemeral:'仅当前进程',unknown:'未知'}
const kinds={oauth:'ChatGPT / Token',api_key:'API Key',agent_identity:'Agent Identity'}
const sources={keyring:'系统凭据库',file:'auth.json',config:'config.toml Provider'}
async function read(includeKeyring=false){
  if(busy.value)return
  const current=++generation,id=props.targetId
  busy.value=true;reading.value=true;error.value=''
  try{const result=await window.manager.readClientIdentity({id,includeKeyring});if(current===generation)view.value=result}
  catch(cause){if(current===generation)error.value=String(cause)}
  finally{if(current===generation){busy.value=false;reading.value=false}}
}
async function importIdentity(){
  if(busy.value||!view.value?.ticket)return
  const current=++generation,ticket=view.value.ticket
  view.value.ticket=undefined
  busy.value=true;error.value=''
  try{
    const result=await window.manager.importClientIdentity(ticket)
    if(current===generation)message.success(result.added?'已导入账号库':'账号库中已存在此身份，保留已有凭据')
    await manager.refresh()
  }catch(cause){if(current===generation)error.value=String(cause)}finally{if(current===generation)busy.value=false}
}
async function cancel(){await window.manager.cancelClientIdentity(props.targetId)}
async function syncAuthority(){
  if(busy.value||!authority.value)return
  const current=++generation,id=authority.value.accountId;busy.value=true;error.value=''
  try{await window.manager.syncClientAuthority(id);if(current===generation)message.success('已同步客户端保存的凭据')}
  catch(cause){if(current===generation)error.value=String(cause)}
  finally{await manager.refresh();if(current===generation)busy.value=false}
}
async function changeAuthority(){
  if(busy.value||!action.value)return
  const current=++generation,operation=action.value,id=props.targetId;busy.value=true;error.value=''
  try{
    if(operation==='bind'){
      if(!canBind.value||!view.value?.ticket)throw new Error('请重新读取并匹配此身份')
      const ticket=view.value.ticket,accountId=view.value.matchedAccountIds[0];view.value.ticket=undefined
      await window.manager.bindClientAuthority({ticket,accountId})
    }else{
      if(!clientClosed.value)throw new Error('请先确认已关闭客户端')
      await window.manager.releaseClientAuthority({targetId:id,clientClosed:true})
    }
    if(current===generation){action.value=undefined;message.success(operation==='bind'?'已由客户端维护登录':'已解除客户端凭据关联')}
  }catch(cause){if(current===generation)error.value=String(cause)}
  finally{await manager.refresh();if(current===generation)busy.value=false}
}
watch(()=>[props.targetId,props.configRevision],(_value,old)=>{
  generation++;busy.value=false;reading.value=false;view.value=undefined;error.value='';action.value=undefined;clientClosed.value=false
  if(old?.[0])void window.manager.cancelClientIdentity(old[0])
})
onBeforeUnmount(()=>{generation++;void window.manager.cancelClientIdentity(props.targetId)})
</script>
<template>
  <a-card title="本地登录身份" class="settings-card client-identity-panel">
    <p class="muted">读取所选目录保存的身份，预览后导入账号库。身份识别不代表已完成在线登录验证。</p>
    <a-space wrap>
      <a-button :loading="busy" :disabled="busy" @click="read(false)">读取登录身份</a-button>
      <a-button v-if="view?.status==='needs_keyring'||view?.status==='error'&&view.keyringRetry" :disabled="busy" @click="read(true)">读取系统凭据</a-button>
      <a-button v-if="reading" @click="cancel">取消读取</a-button>
    </a-space>
    <a-alert v-if="error" type="error" :message="error" class="identity-message" />
    <a-alert v-if="view?.notice" :type="view.status==='error'?'error':'info'" :message="view.notice" class="identity-message" />
    <div v-if="authority" class="identity-authority">
      <a-alert type="info" :message="`登录由此客户端维护 · ${authority.accountName}`" description="本地服务及用量刷新会先同步此目录的凭据，管理器不并行轮换该账号的刷新令牌。" />
      <p class="muted">{{authority.lastSyncedAt?`上次同步：${new Date(authority.lastSyncedAt).toLocaleString()}`:'尚未同步；使用账号前会检查客户端文件。'}}</p>
      <a-alert v-if="authority.error" type="error" :message="authority.error" class="identity-message" />
      <a-space class="identity-actions"><a-button :disabled="busy" @click="syncAuthority">同步客户端凭据</a-button><a-button :disabled="busy" @click="action='release';clientClosed=false">解除关联</a-button></a-space>
    </div>
    <a-descriptions v-if="view" :column="2" size="small" class="identity-details">
      <a-descriptions-item label="凭据存储">{{modes[view.mode]}}</a-descriptions-item>
      <a-descriptions-item label="本次来源">{{view.source?sources[view.source]:'未取得凭据'}}</a-descriptions-item>
      <template v-if="view.identity">
        <a-descriptions-item label="类型">{{kinds[view.identity.kind]}}</a-descriptions-item>
        <a-descriptions-item label="名称">{{view.identity.name}}</a-descriptions-item>
        <a-descriptions-item v-if="view.identity.email" label="邮箱">{{view.identity.email}}</a-descriptions-item>
        <a-descriptions-item v-if="view.identity.plan" label="套餐">{{view.identity.plan}}</a-descriptions-item>
        <a-descriptions-item v-if="view.identity.accountId" label="工作区">{{view.identity.accountId}}</a-descriptions-item>
        <a-descriptions-item label="账号库">{{view.matchedAccountIds.length?`已匹配 ${view.matchedAccountIds.length} 个账号`:'未找到明确匹配'}}</a-descriptions-item>
      </template>
    </a-descriptions>
    <template v-if="view?.ticket">
      <p class="muted identity-help">导入本次读取的副本，不改写客户端。已存在的身份保留账号库原凭据。系统凭据不会在确认导入时再次读取。</p>
      <a-button type="primary" :disabled="busy" @click="importIdentity">导入账号库</a-button>
      <a-button v-if="canBind" :disabled="busy" style="margin-left:12px" @click="action='bind'">由客户端维护登录</a-button>
    </template>
    <a-modal :open="!!action" :title="action==='bind'?'由此客户端维护登录':'解除客户端凭据关联'" ok-text="确认" cancel-text="取消" :confirm-loading="busy" :ok-button-props="{disabled:busy||(action==='release'&&!clientClosed)}" :cancel-button-props="{disabled:busy}" :closable="!busy" :mask-closable="!busy" @ok="changeAuthority" @cancel="action=undefined">
      <p v-if="action==='bind'">将所选目录作为此账号的凭据来源。客户端负责刷新登录，管理器同步新凭据供用量查询和本地服务使用；客户端未刷新或已退出时会暂停使用，不自行轮换旧令牌。</p>
      <template v-else><p>先在此客户端退出当前账号或切换到其他账号，再关闭客户端。管理器会检查文件；仍保存原身份时不能解除关联。</p><a-checkbox v-model:checked="clientClosed">已关闭使用此身份的客户端</a-checkbox></template>
      <a-alert v-if="error" type="error" :message="error" />
    </a-modal>
  </a-card>
</template>
<style scoped>
.identity-message,.identity-details,.identity-authority{margin-top:18px}.identity-actions{margin-top:12px}.identity-help{margin-top:12px;font-size:12px;line-height:1.8}.identity-details :deep(.ant-descriptions-item-content){overflow-wrap:anywhere}
</style>
