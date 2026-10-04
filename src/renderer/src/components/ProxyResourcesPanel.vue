<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {useManager} from '../store'
import ProxyImportDialog from './ProxyImportDialog.vue'
import ProxyEnginePanel from './ProxyEnginePanel.vue'
import ProxyCatalogPanel from './ProxyCatalogPanel.vue'
import type {ProxyChangePreview,ProxyResourceChange,ProxyResourceView} from '../../../shared/proxyResources'
const props=defineProps<{open:boolean}>(),emit=defineEmits<{'update:open':[boolean]}>(),manager=useManager()
const state=computed(()=>manager.data?.proxyResources),editor=ref(false),editing=ref<ProxyResourceView>(),name=ref(''),url=ref(''),error=ref(''),busy=ref(false),preview=ref<ProxyChangePreview>()
const page=ref(1),search=ref(''),impactPage=ref(1),resources=computed(()=>(state.value?.resources??[]).filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase())))
const importOpen=ref(false),engineOpen=ref(false)
const catalogOpen=ref(false),catalogSource=ref<string>(),catalogResource=ref<string>()
function openCatalog(resource?:ProxyResourceView){catalogSource.value=resource?.catalogSourceId;catalogResource.value=resource?.id;catalogOpen.value=true}
watch(()=>props.open,open=>{if(!open){importOpen.value=false;engineOpen.value=false;catalogOpen.value=false}})
const displayError=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'').replace(/^Error: /,'')
let generation=0
async function discard(){const old=preview.value;preview.value=undefined;if(old)await window.manager.discardProxyChange(old.ticket).catch(()=>{})}
async function close(){generation++;await discard();url.value='';editor.value=false;emit('update:open',false)}
watch(()=>props.open,open=>{if(open){error.value='';search.value='';page.value=1}else{generation++;void discard();url.value='';editor.value=false;busy.value=false}})
watch(search,()=>{page.value=1})
onBeforeUnmount(()=>{generation++;void discard()})
function edit(resource?:ProxyResourceView){if(resource?.catalogSourceId){openCatalog(resource);return}editing.value=resource;name.value=resource?.name??'';url.value='';editor.value=true;error.value='';void discard()}
async function prepare(input:ProxyResourceChange){
  const version=++generation;busy.value=true;error.value='';await discard()
  try{
    const value=await window.manager.previewProxyChange(input)
    if(version!==generation){await window.manager.discardProxyChange(value.ticket);return}
    preview.value=value;impactPage.value=1
  }catch(cause){if(version===generation)error.value=displayError(cause)}finally{if(version===generation)busy.value=false}
}
async function prepareEditor(){
  if(editing.value)await prepare({action:'update',id:editing.value.id,revision:editing.value.revision,name:name.value,...(url.value.trim()?{url:url.value.trim()}:{})})
  else await prepare({action:'create',name:name.value,url:url.value.trim()})
}
async function apply(){
  const value=preview.value;if(!value)return
  busy.value=true;error.value=''
  try{if(await manager.execute(()=>window.manager.applyProxyChange({ticket:value.ticket,confirmed:true}))){preview.value=undefined;editor.value=false;url.value=''}}finally{busy.value=false}
}
const titles={create:'添加代理资源',update:'更新代理资源',remove:'删除代理资源',enable:'启用统一出口',disable:'关闭统一出口'}
</script>
<template>
  <a-modal :open="open" title="代理资源与统一出口" :width="850" :footer="null" destroy-on-close @cancel="close">
    <div class="proxy-resources-panel">
      <a-alert v-if="state?.unified.error" type="error" :message="state.unified.error" />
      <a-alert v-if="state?.unified.staleError" class="proxy-unified-pending" type="warning" :message="state.unified.staleError" />
      <div class="proxy-unified-status"><strong>统一出口：{{state?.unified.mode==='all_accounts'?state.unified.name:state?.unified.mode==='invalid'?'配置异常':'未启用'}}</strong><a-button v-if="state?.unified.mode!=='off'" :disabled="busy" @click="prepare({action:'disable'})">关闭统一代理</a-button></div>
      <p class="muted">账号独立设置优先，其次统一出口；显式直连不继承。关闭统一出口保留各账号原有设置。仅作用于普通 ChatGPT 登录账号。</p>
      <p class="muted">可用账号 {{state?.eligible??0}} · 跟随统一 {{state?.inherited??0}} · 独立代理 {{state?.independent??0}} · 显式直连 {{state?.direct??0}}</p>
      <a-space v-if="!preview&&!editor" class="proxy-resource-toolbar"><a-input v-model:value="search" placeholder="搜索代理名称" allow-clear /><a-button class="proxy-engine-trigger" :disabled="busy" @click="engineOpen=true">代理引擎</a-button><a-button class="proxy-catalog-trigger" :disabled="busy" @click="openCatalog()">来源目录</a-button><a-button :disabled="busy" @click="importOpen=true">批量导入</a-button><a-button :disabled="busy" @click="edit()">添加手动代理</a-button></a-space>
      <a-table v-if="!preview&&!editor" size="small" :data-source="resources" row-key="id" :pagination="{current:page,pageSize:5,showSizeChanger:false,onChange:(p:number)=>page=p}">
        <a-table-column title="名称" key="name"><template #default="{record}"><span class="proxy-resource-name">{{record.name}}</span><a-tag v-if="record.unified" color="purple">统一</a-tag></template></a-table-column>
        <a-table-column title="出口" key="address"><template #default="{record}">{{record.address.invalid?'配置无效':record.address.catalog?`${record.address.protocol} · ${record.address.name}`:`${record.address.protocol} · ${record.address.server}:${record.address.port}`}}<small v-if="record.accountCount"> · {{record.accountCount}} 个独立绑定</small></template></a-table-column>
        <a-table-column title="操作" key="actions" :width="240"><template #default="{record}"><a-space><a-button size="small" :disabled="busy||record.address.invalid||record.unified" @click="prepare({action:'enable',id:record.id,revision:record.revision})">设为统一</a-button><a-button size="small" :disabled="busy" @click="edit(record)">编辑</a-button><a-button size="small" danger :disabled="busy" @click="prepare({action:'remove',id:record.id,revision:record.revision})">删除</a-button></a-space></template></a-table-column>
      </a-table>
      <a-form v-if="editor&&!preview" layout="vertical" class="proxy-resource-editor" @submit.prevent="prepareEditor">
        <a-form-item label="名称"><a-input v-model:value="name" :maxlength="80" :disabled="busy" /></a-form-item>
        <a-form-item label="代理地址" :extra="editing?'留空保留原地址及密码。':'支持 HTTP / SOCKS 代理与 SS、VMess、VLESS、Trojan、Hysteria2、TUIC 分享链接；节点需要安装代理引擎。'"><a-input-password v-model:value="url" :disabled="busy" autocomplete="off" placeholder="http://用户名:密码@主机:端口" /></a-form-item>
        <a-space><a-button type="primary" html-type="submit" :disabled="!name.trim()||(!editing&&!url.trim())" :loading="busy">预览变更</a-button><a-button :disabled="busy" @click="editor=false;url=''">取消编辑</a-button></a-space>
      </a-form>
      <div v-if="preview" class="proxy-change-preview">
        <h3>{{titles[preview.action]}}<span v-if="preview.name"> · {{preview.name}}</span></h3>
        <p v-if="preview.address&&!preview.address.invalid">{{preview.address.protocol}} · {{preview.address.catalog?preview.address.name:`${preview.address.server}:${preview.address.port}`}}</p>
        <p>将改变 {{preview.affected.length}} 个账号的出口。修改前需停止这些账号的服务和刷新。</p>
        <a-alert v-if="preview.disablesUnified||preview.clearsBindings" type="warning" :message="`此操作${preview.disablesUnified?'会关闭统一代理；':''}将移除 ${preview.clearsBindings} 个资源绑定，相关账号恢复继承。`" />
        <a-alert v-if="preview.busy.length" type="warning" :message="`${preview.busy.length} 个受影响账号正在使用，请停止后重新预览。`" />
        <a-table v-if="preview.affected.length" size="small" :data-source="preview.affected" row-key="id" :columns="[{title:'受影响账号',dataIndex:'name'}]" :pagination="{current:impactPage,pageSize:5,showSizeChanger:false,onChange:(p:number)=>impactPage=p}" />
        <a-space><a-button type="primary" :danger="preview.action==='remove'" :loading="busy" :disabled="!!preview.busy.length" @click="apply">确认应用</a-button><a-button :disabled="busy" @click="discard">取消预览</a-button></a-space>
      </div>
      <a-alert v-if="error||manager.error" class="error-banner" type="error" :message="displayError(error||manager.error)" />
      <p class="muted">地址和密码加密保存，界面只显示出口摘要。</p>
    </div>
  </a-modal>
  <ProxyImportDialog v-model:open="importOpen" />
  <ProxyEnginePanel v-model:open="engineOpen" />
  <ProxyCatalogPanel v-model:open="catalogOpen" :source-id="catalogSource" :resource-id="catalogResource" />
</template>
<style scoped>
.proxy-unified-status,.proxy-resource-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0}.proxy-resource-editor,.proxy-change-preview{margin:16px 0;padding:16px;border:1px solid var(--border,#e5e7eb);border-radius:12px}.proxy-resource-name{overflow-wrap:anywhere}.proxy-change-preview .ant-alert{margin-bottom:12px}.proxy-resources-panel>.muted{margin-top:14px}
</style>
