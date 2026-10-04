<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {strategyKinds,strategyLabels,strategyHints,strategyFields,strategyChangeSchema,type StrategyKind,type StrategyOptions,type StrategyEditorMember,type StrategyCandidate,type StrategyCandidates} from '../../../shared/proxyStrategy'
import type {CatalogSourceView,CatalogPreview} from '../../../shared/proxyCatalog'
const props=defineProps<{open:boolean;source?:CatalogSourceView;sources:CatalogSourceView[]}>(),emit=defineEmits<{'update:open':[boolean];prepared:[CatalogPreview]}>()
const name=ref(''),kind=ref<StrategyKind>('fallback'),options=ref<StrategyOptions>({lazy:true}),members=ref<StrategyEditorMember[]>([]),candidates=ref<StrategyCandidates>(),sourceFilter=ref<string>(),query=ref(''),memberPage=ref(1),loading=ref(false),saving=ref(false),error=ref('')
const sourceOptions=computed(()=>props.sources.filter(s=>s.kind!=='strategy').map(s=>({value:s.id,label:s.name}))),fields=computed(()=>strategyFields[kind.value])
let generation=0,candidateGeneration=0,revision:number|undefined
const key=(m:{sourceId:string;itemId:string})=>`${m.sourceId}:${m.itemId}`
const included=(m:StrategyCandidate)=>members.value.some(v=>key(v)===key(m))
const displayError=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'').replace(/^Error: /,'')
async function loadCandidates(page=1){const version=++candidateGeneration;loading.value=true;try{const value=await window.manager.proxyStrategyCandidates({sourceId:sourceFilter.value,query:query.value,page});if(props.open&&version===candidateGeneration)candidates.value=value}catch(cause){if(version===candidateGeneration)error.value=displayError(cause)}finally{if(version===candidateGeneration)loading.value=false}}
function toggle(row:StrategyCandidate){const index=members.value.findIndex(m=>key(m)===key(row));if(index>=0)members.value.splice(index,1);else if(members.value.length<64)members.value.push({sourceId:row.sourceId,itemId:row.itemId,name:row.name,sourceName:row.sourceName,available:true,savedCopy:false})}
function remove(row:StrategyEditorMember){members.value=members.value.filter(m=>key(m)!==key(row));memberPage.value=Math.min(memberPage.value,Math.max(1,Math.ceil(members.value.length/5)))}
function move(row:StrategyEditorMember,step:number){const i=members.value.findIndex(m=>key(m)===key(row)),to=i+step;if(i<0||to<0||to>=members.value.length)return;[members.value[i],members.value[to]]=[members.value[to],members.value[i]];memberPage.value=Math.floor(to/5)+1}
function draft(){return {action:'strategy' as const,...props.source?{sourceId:props.source.id,revision}:{},name:name.value,kind:kind.value,members:members.value.map(({sourceId,itemId})=>({sourceId,itemId})),options:Object.fromEntries(Object.entries(options.value).filter(([key,value])=>fields.value.includes(key)&&value!==undefined&&value!==null))}}
const invalid=computed(()=>{const parsed=strategyChangeSchema.safeParse(draft());if(!parsed.success){const issue=parsed.error.issues[0];return issue.path[0]==='options'?'健康检查地址或数值范围不正确':!name.value.trim()?'请输入策略名称':!members.value.length?'请选择至少一个节点':'请检查策略名称与成员'}if(members.value.some(m=>!m.available))return '请移除或重新选择已失效的成员';if(members.value.some(m=>m.name===name.value.trim()))return '策略名称不能与成员节点同名';return ''})
async function prepare(){if(invalid.value)return;const version=generation;saving.value=true;error.value='';try{const result=await window.manager.previewProxyCatalog(draft());if(version!==generation||!props.open){await window.manager.discardProxyCatalog(result.ticket);return}emit('prepared',result);emit('update:open',false)}catch(cause){if(version===generation)error.value=displayError(cause)}finally{if(version===generation)saving.value=false}}
function close(){generation++;candidateGeneration++;saving.value=false;emit('update:open',false)}
watch(()=>props.open,async open=>{const version=++generation;candidateGeneration++;error.value='';saving.value=false;loading.value=false;members.value=[];candidates.value=undefined;if(!open)return;name.value='';kind.value='fallback';options.value={lazy:true};sourceFilter.value=undefined;query.value='';memberPage.value=1;revision=undefined
 if(props.source){saving.value=true;try{const value=await window.manager.proxyStrategyEditor({sourceId:props.source.id,revision:props.source.revision});if(version!==generation)return;name.value=value.name;kind.value=value.kind;options.value={lazy:true,...value.options};members.value=value.members;revision=value.revision}catch(cause){if(version===generation)error.value=displayError(cause)}finally{if(version===generation)saving.value=false}}
 if(version===generation)await loadCandidates()
})
onBeforeUnmount(()=>{generation++;candidateGeneration++})
</script>
<template>
 <a-modal :open="open" :title="source?'编辑自建策略':'新建代理策略'" :width="1060" :style="{maxWidth:'calc(100vw - 48px)'}" :footer="null" :mask-closable="false" destroy-on-close @cancel="close">
  <div class="proxy-strategy-editor">
   <div class="strategy-body">
    <p class="muted">从不同来源选择节点，保存为独立副本。原来源更新或删除不会自动改写策略；编辑保存时会重新读取仍存在的来源。</p>
    <a-alert v-if="error" type="error" :message="error" />
    <a-form layout="vertical" @submit.prevent="prepare">
     <div class="strategy-basics"><a-form-item label="策略名称"><a-input class="strategy-name" v-model:value="name" :maxlength="80" :disabled="saving" /></a-form-item><a-form-item label="运行方式"><a-select class="strategy-kind" v-model:value="kind" :disabled="saving" :options="strategyKinds.map(value=>({value,label:strategyLabels[value]}))" /></a-form-item></div>
     <p class="muted">{{members.length===1?'只有一个节点时是固定出口，不具备多节点切换能力。':strategyHints[kind]}}</p>
     <div v-if="kind!=='select'" class="strategy-options">
      <a-form-item label="健康检查地址" extra="留空使用 https://www.gstatic.com/generate_204"><a-input class="strategy-url" v-model:value="options.url" :maxlength="2048" :disabled="saving" /></a-form-item>
      <a-form-item label="检测间隔（秒）"><a-input-number class="strategy-interval" v-model:value="options.interval" :min="30" :max="3600" :precision="0" placeholder="30" :disabled="saving" /></a-form-item>
      <a-form-item v-if="fields.includes('timeout')" label="检测超时（秒）"><a-input-number class="strategy-timeout" v-model:value="options.timeout" :min="1" :max="30" :precision="0" placeholder="5" :disabled="saving" /></a-form-item>
      <a-form-item v-if="fields.includes('tolerance')" label="切换容差（毫秒）"><a-input-number class="strategy-tolerance" v-model:value="options.tolerance" :min="0" :max="1000" :precision="0" placeholder="50" :disabled="saving" /></a-form-item>
      <a-form-item label="按需检测"><a-switch v-model:checked="options.lazy" :disabled="saving" /></a-form-item>
     </div>
    </a-form>
    <h3>已选成员 · {{members.length}} / 64</h3>
    <p class="muted">成员顺序就是故障转移的优先顺序。同名节点只保留排在最前面的定义，确认页会列出重复项。</p>
    <a-table class="strategy-members" size="small" :data-source="members" :row-key="key" :pagination="{current:memberPage,pageSize:5,showSizeChanger:false,onChange:(p:number)=>memberPage=p}">
     <a-table-column title="节点 / 来源" key="name"><template #default="{record}">{{record.name}}<small> · {{record.sourceName}}</small><a-tag v-if="record.savedCopy" color="blue">原来源已删除，保留副本</a-tag><a-tag v-else-if="!record.available" color="red">原成员不可用，请重新选择</a-tag></template></a-table-column>
     <a-table-column title="顺序" key="order" :width="220"><template #default="{record}"><a-space><a-button size="small" :disabled="saving||key(members[0])===key(record)" @click="move(record,-1)">上移</a-button><a-button size="small" :disabled="saving||key(members.at(-1)!)===key(record)" @click="move(record,1)">下移</a-button><a-button size="small" danger :disabled="saving" @click="remove(record)">移除</a-button></a-space></template></a-table-column>
    </a-table>
    <h3>添加节点</h3>
    <div class="strategy-search"><a-select class="strategy-source" v-model:value="sourceFilter" :options="sourceOptions" allow-clear placeholder="全部来源" :disabled="saving" @change="loadCandidates()" /><a-input-search class="strategy-query" v-model:value="query" placeholder="搜索节点名、主机或端口；多个词同时匹配" :disabled="saving" @search="loadCandidates()" /></div>
    <a-table class="strategy-candidates" size="small" :loading="loading" :data-source="candidates?.rows??[]" :row-key="key" :pagination="{current:candidates?.page??1,total:candidates?.total??0,pageSize:25,showSizeChanger:false,onChange:loadCandidates}">
     <a-table-column title="选择" key="select" :width="60"><template #default="{record}"><a-checkbox :checked="included(record)" :disabled="saving||members.length>=64&&!included(record)" @change="toggle(record)" /></template></a-table-column>
     <a-table-column title="节点" key="name"><template #default="{record}">{{record.name}}<a-tag v-if="record.notice">可能是订阅提示，仍可选择</a-tag></template></a-table-column>
     <a-table-column title="来源" data-index="sourceName" key="source" />
     <a-table-column title="地址" key="address"><template #default="{record}">{{record.protocol.toUpperCase()}} · {{record.server}}:{{record.port}}</template></a-table-column>
    </a-table>
   </div>
   <div class="strategy-footer"><span class="muted">{{invalid||'下一步查看影响并确认保存。'}}</span><a-space><a-button @click="close">取消</a-button><a-button type="primary" :disabled="!!invalid" :loading="saving" @click="prepare">预览策略</a-button></a-space></div>
  </div>
 </a-modal>
</template>
<style scoped>
.strategy-body{max-height:65vh;overflow:auto;padding-right:8px}.strategy-basics{display:grid;grid-template-columns:2fr 1fr;gap:16px}.strategy-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.strategy-options .ant-form-item:first-child{grid-column:1/-1}.strategy-options .ant-form-item{min-width:0}.strategy-search{display:flex;gap:12px;margin:12px 0}.strategy-source{min-width:200px}.strategy-footer{display:flex;justify-content:space-between;gap:16px;align-items:center;border-top:1px solid var(--border,#e5e7eb);padding-top:16px;margin-top:16px}.proxy-strategy-editor .ant-alert{margin:12px 0}.strategy-members small{color:var(--text-secondary)}
</style>
