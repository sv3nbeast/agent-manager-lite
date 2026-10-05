<script setup lang="ts">
import {ref,watch,onBeforeUnmount} from 'vue'
import {useManager} from '../store'
import {useFormFeedback} from '../formFeedback'
import type {ProxyImportOptions,ProxyImportPreview} from '../../../shared/proxyBatch'
const props=defineProps<{open:boolean}>(),emit=defineEmits<{'update:open':[boolean]}>(),manager=useManager()
const input=ref(''),protocol=ref<ProxyImportOptions['protocol']>('socks5'),format=ref<ProxyImportOptions['format']>('auto'),skipInvalid=ref(false),skipDuplicates=ref(true)
const preview=ref<ProxyImportPreview>(),page=ref(1),busy=ref(false),error=ref(''),applyError=ref('');let generation=0
useFormFeedback(()=>error.value,{active:()=>props.open})
const displayError=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'')
async function discard(){const ticket=preview.value?.ticket;preview.value=undefined;if(ticket)await window.manager.discardProxyBatch(ticket).catch(()=>{})}
function clear(){generation++;void discard();input.value='';busy.value=false;error.value='';applyError.value=''}
watch(()=>props.open,()=>{clear();page.value=1})
onBeforeUnmount(clear)
function close(){clear();emit('update:open',false)}
async function prepare(){
  const version=++generation;busy.value=true;error.value='';applyError.value='';await discard()
  try{const result=await window.manager.previewProxyImport({input:input.value,options:{protocol:protocol.value,format:format.value,skipInvalid:skipInvalid.value,skipDuplicates:skipDuplicates.value}})
    if(version!==generation){if(result.ticket)await window.manager.discardProxyBatch(result.ticket);return}
    preview.value=result;page.value=1
  }catch(e){if(version===generation)error.value=displayError(e)}finally{if(version===generation)busy.value=false}
}
async function apply(){
  const ticket=preview.value?.ticket;if(!ticket)return
  busy.value=true;error.value='';applyError.value=''
  if(await manager.execute(()=>window.manager.applyProxyBatch({ticket,confirmed:true})))close()
  else{applyError.value=displayError(manager.error)||'代理导入失败，请重试。';busy.value=false}
}
const formats=[{value:'auto',label:'自动识别（歧义时手动指定）'},{value:'host_auth',label:'主机:端口:用户:密码'},{value:'auth_at_host',label:'用户:密码@主机:端口'},{value:'host_at_auth',label:'主机:端口@用户:密码'}]
</script>
<template>
  <a-modal :open="open" title="批量导入代理" :width="820" :footer="null" destroy-on-close @cancel="close">
    <div class="proxy-import-dialog">
      <template v-if="!preview">
        <p class="muted">每行一个代理，支持完整 URL、六种节点分享链接、主机与凭据格式、Base64 地址列表。带协议的地址保持原协议；IPv6 使用方括号。</p>
        <a-form layout="vertical" @submit.prevent="prepare">
          <div class="proxy-import-options"><a-form-item label="无协议地址默认使用"><a-select class="proxy-import-protocol" v-model:value="protocol" :disabled="busy" :options="['http','https','socks5','socks5h'].map(value=>({value,label:value.toUpperCase()}))" /></a-form-item><a-form-item label="凭据格式"><a-select class="proxy-import-format" v-model:value="format" :disabled="busy" :options="formats" /></a-form-item></div>
          <a-form-item label="代理列表"><a-textarea v-model:value="input" :disabled="busy" :rows="7" :maxlength="2097152" autocomplete="off" spellcheck="false" placeholder="http://用户:密码@主机:端口&#10;[2001:db8::1]:1080:用户:密码" /></a-form-item>
          <a-space wrap><a-checkbox v-model:checked="skipDuplicates" :disabled="busy">跳过重复代理</a-checkbox><a-checkbox v-model:checked="skipInvalid" :disabled="busy">跳过无效或歧义行</a-checkbox></a-space>
          <p class="muted">最多 2 MiB / 4096 行，手动资源总数不超过 500。解析不会联网，也不会自动分配给账号。</p>
          <a-button type="primary" html-type="submit" :disabled="!input.trim()" :loading="busy">预览导入</a-button>
        </a-form>
      </template>
      <template v-else>
        <p class="proxy-import-summary">新增候选 {{preview.valid}} · 重复 {{preview.duplicates}} · 无效 {{preview.invalid}} · 计划导入 {{preview.added}}</p>
        <a-alert v-if="preview.blocked" type="warning" :message="preview.blocked" />
        <a-table size="small" :data-source="preview.rows" row-key="line" :pagination="{current:page,pageSize:5,showSizeChanger:false,onChange:(p:number)=>page=p}">
          <a-table-column title="行" key="line" data-index="line" :width="55" />
          <a-table-column title="资源" key="name"><template #default="{record}"><span class="proxy-import-name">{{record.name||'—'}}</span></template></a-table-column>
          <a-table-column title="出口" key="address"><template #default="{record}">{{record.address?`${record.address.protocol} · ${record.address.server}:${record.address.port}`:'—'}}</template></a-table-column>
          <a-table-column title="结果" key="status"><template #default="{record}">{{record.error==='ambiguous'?'格式有歧义':record.error?'地址无效':record.duplicate?(record.included?'重复，保留':'重复，跳过'):'新增'}}<small v-if="record.address?.authenticated"> · 需认证</small></template></a-table-column>
        </a-table>
        <a-space><a-button type="primary" :disabled="!preview.ticket" :loading="busy" @click="apply">确认导入</a-button><a-button :disabled="busy" @click="discard">返回修改</a-button><a-button :disabled="busy" @click="close">取消</a-button></a-space>
      </template>
      <a-alert v-if="error||applyError" type="error" :message="error||applyError" class="error-banner" />
    </div>
  </a-modal>
</template>
<style scoped>
.proxy-import-options{display:grid;grid-template-columns:1fr 2fr;gap:16px}.proxy-import-dialog>.muted{margin-bottom:18px}.proxy-import-name{overflow-wrap:anywhere}.proxy-import-dialog{max-height:calc(100vh - 220px);overflow:auto}.proxy-import-summary{margin:12px 0 18px}
</style>
