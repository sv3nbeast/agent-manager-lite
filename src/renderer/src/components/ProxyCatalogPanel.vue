<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {useManager} from '../store'
import ProxyStrategyEditor from './ProxyStrategyEditor.vue'
import {strategyLabels} from '../../../shared/proxyStrategy'
import {catalogErrors,type CatalogChange,type CatalogPage,type CatalogPreview,type CatalogResolution,type CatalogRow,type CatalogSourceView,type SubscriptionJob} from '../../../shared/proxyCatalog'
const props=defineProps<{open:boolean;sourceId?:string;resourceId?:string}>(),emit=defineEmits<{'update:open':[boolean]}>(),manager=useManager()
const sources=ref<CatalogSourceView[]>([]),current=ref<CatalogSourceView>(),sourcePage=ref(1),rows=ref<CatalogPage>(),kind=ref<'nodes'|'groups'|'issues'>('nodes'),issueId=ref(''),query=ref(''),error=ref(''),busy=ref(false)
const editor=ref<'import'|'subscription'|'replace'|'rename'>(),name=ref(''),input=ref(''),preview=ref<CatalogPreview>(),selected=ref(''),selections=ref<Record<string,string>>({}),resolution=ref<CatalogResolution>(),choiceQuery=ref(''),resourceName=ref(''),resourceId=ref<string>(),impactPage=ref(1)
const subscriptionId=ref(''),subscriptionJob=ref<SubscriptionJob>(),url=ref('')
const resources=computed(()=>(manager.data?.proxyResources?.resources??[]).filter(r=>r.catalogSourceId===current.value?.id)),target=computed(()=>resources.value.find(r=>r.id===resourceId.value))
const message=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'').replace(/^Error: /,'')
const problem=(code?:string)=>code?catalogErrors[code]??'资源配置无效':''
const strategyOpen=ref(false),strategySource=ref<CatalogSourceView>()
function editStrategy(source?:CatalogSourceView){strategySource.value=source;strategyOpen.value=true}
function preparedStrategy(value:CatalogPreview){generation++;preview.value=value;editor.value=undefined;rows.value=undefined;clearChoice();impactPage.value=1}
const titles={strategy:'保存自建策略',import:'导入来源',replace:'替换目录内容',rename:'重命名来源',remove:'删除来源',default:'保存默认项','clear-default':'清除默认项',bind:'保存代理资源',tls:'修改证书例外许可','auto-update':'修改订阅自动更新'}
let generation=0
let polling=false,lastSources=0,timer:ReturnType<typeof setInterval>|undefined
const bytes=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:n>=1024**2?`${(n/1024**2).toFixed(1)} MiB`:`${(n/1024).toFixed(1)} KiB`
async function cancelDownload(){const id=subscriptionId.value;subscriptionId.value='';subscriptionJob.value=undefined;if(id)await window.manager.cancelProxySubscription(id).catch(()=>{});busy.value=false}
async function download(refresh=false){
 const version=++generation;await discard();if(version!==generation||!props.open)return
 const id=crypto.randomUUID();subscriptionId.value=id;subscriptionJob.value=undefined;busy.value=true;error.value='';rows.value=undefined;clearChoice()
 try{const job=await window.manager.startProxySubscription(refresh?{action:'refresh',requestId:id,...reference()}:{action:'import',requestId:id,...name.value.trim()?{name:name.value.trim()}:{},url:url.value});url.value='';if(version!==generation||!props.open){await window.manager.cancelProxySubscription(id);return}subscriptionJob.value=job;await poll()}
 catch(cause){if(version===generation){subscriptionId.value='';busy.value=false;error.value=message(cause)}}
}
async function poll(){
 if(polling||!props.open)return
 if(!subscriptionId.value){if(busy.value||strategyOpen.value||preview.value||editor.value||selected.value||Date.now()-lastSources<2000)return;lastSources=Date.now();polling=true;try{const version=generation,revision=current.value?.revision;await refreshSources(version);if(version!==generation)return;if(current.value&&current.value.revision!==revision)await loadPage(rows.value?.page??1);else if(revision!==undefined&&!current.value){rows.value=undefined;clearChoice()}}catch{/* Explicit actions retain visible errors. */}finally{polling=false}return}
 const id=subscriptionId.value,version=generation;polling=true
 try{const job=(await window.manager.proxySubscriptionJobs()).find(j=>j.id===id);if(!job||id!==subscriptionId.value||version!==generation)return;subscriptionJob.value=job
  if(job.phase==='fetching')return
  subscriptionId.value='';busy.value=false
  if(job.phase==='preview'){preview.value=job.preview;impactPage.value=1;input.value=''}
  else{error.value=job.error??'';await refreshSources(version);if(version!==generation)return;await manager.execute(()=>window.manager.load());if(job.phase==='completed'&&current.value)await loadPage()}
 }catch(cause){if(version===generation)error.value=message(cause)}finally{polling=false}
}
const reference=()=>{if(!current.value)throw new Error('请先选择来源');return {sourceId:current.value.id,revision:current.value.revision}}
async function discard(){const old=preview.value;preview.value=undefined;if(old)await window.manager.discardProxyCatalog(old.ticket).catch(()=>{})}
function clearChoice(){selected.value='';resolution.value=undefined;selections.value={};choiceQuery.value=''}
async function refreshSources(version=generation){const list=await window.manager.listProxyCatalogs();if(version!==generation)return;sources.value=list;if(current.value)current.value=sources.value.find(s=>s.id===current.value!.id)}
async function loadPage(page=1){
 const version=++generation;busy.value=true;error.value=''
 try{const result=await window.manager.proxyCatalogPage({...(preview.value?{ticket:preview.value.ticket}:reference()),kind:kind.value,itemId:issueId.value||undefined,page,query:query.value});if(version===generation)rows.value=result}
 catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation)busy.value=false}
}
async function browse(source:CatalogSourceView){const version=++generation;await discard();if(version!==generation||!props.open)return;editor.value=undefined;current.value=source;kind.value=source.groups?'groups':'nodes';query.value='';issueId.value='';clearChoice();await loadPage()}
async function reorder(id:string,step:number){
 const version=++generation;busy.value=true;error.value=''
 try{const ids=sources.value.map(s=>s.id),index=ids.indexOf(id),to=index+step;if(index<0||to<0||to>=ids.length)return;[ids[index],ids[to]]=[ids[to],ids[index]];const list=await window.manager.reorderProxyCatalogs(ids);if(version===generation)sources.value=list}
 catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation)busy.value=false}
}
async function tab(next:'nodes'|'groups'){if(!preview.value)clearChoice();kind.value=next;issueId.value='';query.value='';await loadPage()}
async function issues(row:CatalogRow){kind.value='issues';issueId.value=row.id;query.value='';await loadPage()}
function edit(action:'import'|'subscription'|'replace'|'rename'){generation++;clearChoice();rows.value=undefined;editor.value=action;name.value=action==='import'||action==='subscription'?'':current.value?.name??'';input.value='';url.value='';subscriptionJob.value=undefined;error.value=''}
async function prepare(action:CatalogChange){
 const version=++generation;busy.value=true;error.value='';await discard()
 try{const plain={...action,...('selections' in action?{selections:{...action.selections}}:{})};const result=await window.manager.previewProxyCatalog(plain);if(version!==generation){await window.manager.discardProxyCatalog(result.ticket);return}preview.value=result;input.value='';impactPage.value=1;rows.value=undefined}
 catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation)busy.value=false}
}
async function prepareEditor(){if(editor.value==='subscription')await download();else if(editor.value==='import')await prepare({action:'import',name:name.value,input:input.value});else if(editor.value==='replace')await prepare({action:'replace',...reference(),input:input.value});else if(editor.value==='rename')await prepare({action:'rename',...reference(),name:name.value})}
async function apply(){
 const value=preview.value;if(!value)return
 const version=++generation;busy.value=true;error.value=''
 try{
  if(await manager.execute(()=>window.manager.applyProxyCatalog({ticket:value.ticket,confirmed:true}))){
   if(version!==generation)return
   preview.value=undefined;editor.value=undefined;rows.value=undefined;clearChoice();await refreshSources(version)
  }else error.value=message(manager.error)
 }finally{if(version===generation)busy.value=false}
}
async function resolveChoice(page=1){
 const version=++generation;busy.value=true;error.value=''
 try{const result=await window.manager.resolveProxyCatalog({...reference(),itemId:selected.value,selections:{...selections.value},page,query:choiceQuery.value});if(version===generation){resolution.value=result;if(!resourceName.value)resourceName.value=result.name.slice(0,80)}}
 catch(cause){if(version===generation){resolution.value=undefined;error.value=message(cause)}}finally{if(version===generation)busy.value=false}
}
async function choose(row:CatalogRow){clearChoice();selected.value=row.id;resourceName.value=target.value?.name??row.name.slice(0,80);await resolveChoice()}
async function member(name:string){const value=resolution.value?.selection;if(!value)return;selections.value={...selections.value,[value.id]:name};choiceQuery.value='';await resolveChoice()}
async function resetChoices(){selections.value={};choiceQuery.value='';await resolveChoice()}
async function useDefault(){const value=current.value?.default;if(!value)return;selected.value=value.itemId;selections.value={...value.selections};resourceName.value=target.value?.name??'';choiceQuery.value='';await resolveChoice()}
async function bind(){await prepare({action:'bind',...reference(),itemId:selected.value,selections:selections.value,name:resourceName.value,...target.value?{resourceId:target.value.id,resourceRevision:target.value.revision}:{}})}
watch(resourceId,()=>{resourceName.value=target.value?.name??resolution.value?.name.slice(0,80)??''})
watch(()=>props.open,async open=>{
 const version=++generation;clearInterval(timer);timer=undefined;await cancelDownload();await discard();if(version!==generation)return;input.value='';url.value='';editor.value=undefined;current.value=undefined;rows.value=undefined;clearChoice();error.value='';busy.value=false
 if(!open){strategyOpen.value=false;return}
 timer=setInterval(()=>{void poll()},300)
 busy.value=true
 try{const list=await window.manager.listProxyCatalogs();if(version!==generation)return;sources.value=list;resourceId.value=props.resourceId;sourcePage.value=1;const source=list.find(s=>s.id===props.sourceId);if(source){busy.value=false;await browse(source)}}
 catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation)busy.value=false}
})
async function close(){generation++;input.value='';url.value='';emit('update:open',false);await cancelDownload();await discard()}
onBeforeUnmount(()=>{generation++;clearInterval(timer);void cancelDownload();void discard()})
</script>
<template>
 <a-modal :open="open" title="代理来源目录" :width="1000" :style="{maxWidth:'calc(100vw - 48px)'}" :footer="null" :closable="!busy||!!subscriptionId" :mask-closable="false" destroy-on-close @cancel="close">
  <div class="proxy-catalog-panel">
   <p class="muted">导入节点列表或 Clash YAML / JSON，保留原生协议和分组关系。选定出口后保存为代理资源，可用于账号独立代理或统一出口。</p>
   <a-alert v-if="error" type="error" :message="error" class="catalog-error" />
   <div v-if="subscriptionId" class="subscription-progress"><a-spin size="small" /> 正在获取订阅 · {{bytes(subscriptionJob?.receivedBytes??0)}}<span v-if="subscriptionJob?.totalBytes"> / {{bytes(subscriptionJob.totalBytes)}}</span><a-button @click="cancelDownload">取消下载</a-button></div>
   <template v-if="!preview">
    <a-space class="catalog-toolbar"><a-button :disabled="busy" @click="edit('import')">导入目录</a-button><a-button :disabled="busy" @click="edit('subscription')">添加订阅</a-button><a-button :disabled="busy" @click="editStrategy()">新建策略</a-button><a-button v-if="current?.kind==='strategy'" :disabled="busy" @click="editStrategy(current)">编辑策略</a-button><a-button v-if="current?.kind==='manual'" :disabled="busy" @click="edit('replace')">替换内容</a-button><a-button v-if="current" :disabled="busy" @click="edit('rename')">重命名来源</a-button><a-button v-if="current" danger :disabled="busy" @click="prepare({action:'remove',...reference()})">删除来源</a-button></a-space>
    <a-table v-if="!editor&&!current" size="small" :data-source="sources" row-key="id" :pagination="{current:sourcePage,pageSize:5,showSizeChanger:false,onChange:(p:number)=>sourcePage=p}">
     <a-table-column title="来源" key="name"><template #default="{record}"><a-button type="link" :disabled="busy" @click="browse(record)">{{record.name}}</a-button></template></a-table-column>
     <a-table-column title="内容" key="counts"><template #default="{record}"><a-tag v-if="record.kind==='subscription'">订阅 · {{record.autoUpdate?'自动更新':'手动更新'}}</a-tag><a-tag v-if="record.kind==='strategy'">策略 · {{strategyLabels[record.strategyKind as keyof typeof strategyLabels]}}</a-tag>{{record.nodes}} 个节点 · {{record.groups}} 个分组 · {{record.resources}} 个已保存资源<a-tag v-if="record.invalid" color="orange">{{record.invalid}} 项不可用</a-tag><span v-if="record.error" class="catalog-problem">{{record.error}}</span></template></a-table-column>
     <a-table-column title="顺序" key="order" :width="140"><template #default="{record}"><a-space><a-button size="small" :disabled="busy||sources[0]?.id===record.id" @click="reorder(record.id,-1)">上移</a-button><a-button size="small" :disabled="busy||sources.at(-1)?.id===record.id" @click="reorder(record.id,1)">下移</a-button></a-space></template></a-table-column>
    </a-table>
    <a-form v-if="editor" layout="vertical" class="catalog-editor" @submit.prevent="prepareEditor">
     <a-form-item v-if="editor!=='replace'" :label="editor==='subscription'?'来源名称（选填）':'来源名称'"><a-input v-model:value="name" :maxlength="80" :disabled="busy" /></a-form-item>
     <a-form-item v-if="editor==='subscription'" label="订阅地址" extra="HTTPS 地址加密保存。订阅使用直连下载，不发送账号凭据。"><a-input-password class="subscription-url" v-model:value="url" :disabled="busy" autocomplete="off" placeholder="https://…" /></a-form-item>
     <a-form-item v-else-if="editor!=='rename'" label="目录内容" extra="最多 2 MiB。无法执行的节点与分组会保留，并显示原因。"><a-textarea v-model:value="input" :rows="8" :disabled="busy" spellcheck="false" autocomplete="off" placeholder="粘贴 Clash YAML / JSON、节点链接或 Base64 节点列表" /></a-form-item>
     <a-space><a-button type="primary" html-type="submit" :loading="busy" :disabled="editor==='subscription'?!url.trim():(editor!=='replace'&&!name.trim())||(editor!=='rename'&&!input.trim())">{{editor==='subscription'?'获取并预览':'预览目录'}}</a-button><a-button :disabled="busy" @click="editor=undefined;input='';url=''">取消编辑</a-button></a-space>
    </a-form>
    <div v-if="current&&!editor" class="catalog-current">
     <a-space><h3>{{current.name}}</h3><a-button size="small" :disabled="busy" @click="current=undefined;rows=undefined;clearChoice()">返回来源列表</a-button><a-button v-if="selected" size="small" :disabled="busy" @click="clearChoice">返回目录</a-button></a-space>
     <a-alert v-if="current.defaultInvalidated" type="warning" message="原默认项已经失效，请重新选择；不会自动换成其他节点。" />
     <div v-if="current.kind==='subscription'" class="subscription-details">
      <p>上次成功更新：{{new Date(current.updatedAt).toLocaleString()}}<span v-if="current.lastAttemptAt"> · 上次尝试：{{new Date(current.lastAttemptAt).toLocaleString()}}</span></p>
      <p v-if="current.usage">流量：{{bytes(current.usage.upload+current.usage.download)}} / {{current.usage.total?bytes(current.usage.total):'总量未知'}}<span v-if="current.usage.expireAt"> · 到期：{{new Date(current.usage.expireAt).toLocaleString()}}</span> · 用量更新：{{new Date(current.usage.at).toLocaleString()}}</p>
      <p v-else class="muted">订阅未提供流量信息。</p>
      <a-alert v-if="current.error" type="error" :message="current.error" />
      <a-space><a-button :disabled="busy" @click="download(true)">刷新订阅</a-button><a-button :disabled="busy" @click="prepare({action:'auto-update',...reference(),enabled:!current.autoUpdate})">{{current.autoUpdate?'关闭自动更新':'开启自动更新'}}</a-button></a-space>
      <p class="muted">{{current.autoUpdate?'自动更新已开启，每 6 小时尝试一次。':'自动更新未开启。'}}刷新保留独立资源快照；统一出口跟随更新，使用中等待空闲，原选择失效时保留旧出口。</p>
     </div>
     <a-space class="catalog-toolbar"><a-button :disabled="busy" @click="tab('groups')">分组 {{current.groups}}</a-button><a-button :disabled="busy" @click="tab('nodes')">节点 {{current.nodes}}</a-button><a-button v-if="current.default" :disabled="busy" @click="useDefault">选用默认项</a-button><a-button v-if="current.default||current.defaultInvalidated" :disabled="busy" @click="prepare({action:'clear-default',...reference()})">清除默认项</a-button></a-space>
    </div>
   </template>
   <div v-if="preview" class="catalog-confirm">
    <h3>{{titles[preview.action]}} · {{preview.name}}</h3>
    <p v-if="preview.action==='auto-update'">{{preview.autoUpdate?'开启后每 6 小时获取一次订阅，下载失败保留原目录；独立资源保留快照，统一出口空闲后更新。':'关闭后不再定时获取订阅，保留当前目录与出口，可随时手动刷新。'}}</p>
    <p v-if="preview.action==='strategy'" class="muted">独立资源保留原快照；统一出口沿用原选择更新，使用中会等待空闲。保存后可在来源目录选择出口并绑定。</p>
    <a-alert v-if="preview.duplicateNames?.length" type="warning" :message="`以下同名节点仅保留首个：${preview.duplicateNames.join('、')}`" />
    <a-alert v-if="preview.deferredUnified" type="info" message="统一出口正在使用，策略可保存，出口将在空闲后更新。" />
    <a-alert v-if="preview.strategyNames?.length" type="info" :message="`以下策略保留已保存的节点副本：${preview.strategyNames.join('、')}`" />
    <p>{{preview.nodes}} 个节点、{{preview.groups}} 个分组，其中 {{preview.invalid}} 项不可用。涉及 {{preview.resourceCount}} 个已保存资源、{{preview.affected.length}} 个账号出口。</p>
    <a-alert v-if="preview.invalidResources" type="warning" :message="`${preview.invalidResources} 个已保存资源将失效，相关请求会被阻止，请重新选择出口。`" />
    <a-alert v-if="preview.clearsBindings||preview.disablesUnified" type="warning" :message="`将移除 ${preview.clearsBindings} 个独立绑定，账号恢复继承；${preview.disablesUnified?'同时关闭统一代理。':'其余统一设置保留。'}`" />
    <div v-if="preview.tlsNames"><a-alert type="warning" :message="preview.tlsAllow?'将明确许可下列节点跳过来源指定的证书校验。':'将撤销下列节点的证书例外许可，相关资源可能失效。'" /><a-table size="small" :data-source="preview.tlsNames.map(name=>({name}))" row-key="name" :columns="[{title:'节点',dataIndex:'name'}]" :pagination="{pageSize:5,showSizeChanger:false}" /></div>
    <a-table v-if="preview.affected.length" size="small" :data-source="preview.affected" row-key="id" :columns="[{title:'受影响账号',dataIndex:'name'}]" :pagination="{current:impactPage,pageSize:5,showSizeChanger:false,onChange:(p:number)=>impactPage=p}" />
    <a-alert v-if="preview.busy.length" type="warning" :message="`${preview.busy.length} 个账号正在使用，请停止相关服务或刷新后重新预览。`" />
    <a-space class="catalog-toolbar"><a-button :disabled="busy" @click="tab('groups')">查看分组</a-button><a-button :disabled="busy" @click="tab('nodes')">查看节点</a-button><a-button type="primary" :danger="preview.action==='remove'" :loading="busy" :disabled="!!preview.busy.length" @click="apply">确认应用</a-button><a-button :disabled="busy" @click="discard();rows=undefined">取消预览</a-button></a-space>
   </div>
   <template v-if="rows&&((!editor&&!selected)||preview)">
    <a-input-search v-model:value="query" :disabled="busy" placeholder="筛选名称" @search="loadPage(1)" />
    <a-table class="catalog-items" size="small" :scroll="{y:260}" :data-source="rows!.rows" row-key="id" :loading="busy" :pagination="{current:rows!.page,total:rows!.total,pageSize:rows!.pageSize,showSizeChanger:false,onChange:loadPage}">
     <a-table-column title="名称" key="name"><template #default="{record}"><span class="catalog-name">{{record.name}}</span></template></a-table-column>
     <a-table-column title="类型 / 状态" key="state"><template #default="{record}"><a-tag v-if="record.protocol">{{record.protocol}}</a-tag><span v-if="record.memberCount!==undefined">{{record.memberCount}} 个成员</span><span v-if="record.error" class="catalog-problem">{{problem(record.error)}}</span><a-tag v-else-if="record.tlsAllowed" color="orange">证书例外已许可</a-tag></template></a-table-column>
     <a-table-column title="操作" key="actions" :width="300"><template #default="{record}"><a-space wrap><a-button v-if="!preview&&record.kind!=='issue'" size="small" :disabled="busy||!!record.error" @click="choose(record)">选择</a-button><a-button v-if="record.issueCount" size="small" :disabled="busy" @click="issues(record)">原因 {{record.issueCount}}</a-button><template v-if="!preview&&record.insecure"><a-button size="small" :disabled="busy" @click="prepare({action:'tls',...reference(),itemId:record.id,group:record.kind==='group',allow:!record.tlsAllowed})">{{record.tlsAllowed?'撤销证书例外':'许可证书例外'}}</a-button></template></a-space></template></a-table-column>
    </a-table>
   </template>
   <div v-if="selected&&!preview&&!editor" class="catalog-selection">
    <h3>{{resolution?.name??'选择出口'}}</h3>
    <p v-if="Object.keys(selections).length">已明确选择：{{Object.values(selections).join(' → ')}}</p>
    <a-button v-if="Object.keys(selections).length" :disabled="busy" @click="resetChoices">重新选择成员</a-button>
    <template v-if="resolution?.selection">
     <p>请为手选组「{{resolution.selection.name}}」选择成员：</p>
     <a-input-search v-model:value="choiceQuery" placeholder="筛选候选名称" :disabled="busy" @search="resolveChoice(1)" />
     <a-table class="catalog-choices" size="small" :scroll="{y:260}" :data-source="resolution.selection.options" row-key="name" :pagination="{current:resolution.selection.page,total:resolution.selection.total,pageSize:25,showSizeChanger:false,onChange:resolveChoice}">
      <a-table-column title="候选" key="name"><template #default="{record}">{{record.name}}</template></a-table-column><a-table-column title="状态" key="error"><template #default="{record}">{{problem(record.error)||'可选择'}}</template></a-table-column><a-table-column title="操作" key="action"><template #default="{record}"><a-button size="small" :disabled="busy||!!record.error" @click="member(record.name)">选用</a-button></template></a-table-column>
     </a-table>
    </template>
    <a-form v-if="resolution?.ready" class="catalog-binding" layout="vertical" @submit.prevent="bind">
     <p>{{resolution.nodes}} 个节点、{{resolution.groups}} 个分组；自动策略保留全部候选。</p>
     <a-form-item label="保存到资源"><a-select v-model:value="resourceId" allow-clear placeholder="创建新代理资源" :disabled="busy" :options="resources.map(r=>({value:r.id,label:r.name}))" /></a-form-item>
     <a-form-item label="资源名称"><a-input v-model:value="resourceName" :maxlength="80" :disabled="busy" /></a-form-item>
     <a-space><a-button type="primary" html-type="submit" :disabled="!resourceName.trim()" :loading="busy">预览保存资源</a-button><a-button :disabled="busy" @click="prepare({action:'default',...reference(),itemId:selected,selections})">保存为来源默认项</a-button><a-button :disabled="busy" @click="clearChoice">取消选择</a-button></a-space>
    </a-form>
   </div>
  </div>
 </a-modal>
 <ProxyStrategyEditor v-model:open="strategyOpen" :source="strategySource" :sources="sources" @prepared="preparedStrategy" />
</template>
<style scoped>
.catalog-toolbar{margin:14px 0;display:flex;flex-wrap:wrap}.catalog-current,.catalog-confirm,.catalog-selection,.catalog-editor{margin-top:16px;padding:16px;border:1px solid var(--border,#e5e7eb);border-radius:12px}.catalog-name{overflow-wrap:anywhere}.catalog-problem{display:block;color:#b45309;margin-top:4px}.catalog-error,.catalog-confirm .ant-alert{margin-bottom:12px}.catalog-items,.catalog-choices{margin-top:10px}
</style>
