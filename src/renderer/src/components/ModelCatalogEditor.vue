<script setup lang="ts">
import {computed,onUnmounted,reactive,ref,watch} from 'vue'
import {message} from 'ant-design-vue'
import type {ModelDefinition,ModelCatalogView} from '../../../shared/modelCatalog'
import type {ClientConfigPreview} from '../../../shared/clientConfig'

const props=defineProps<{targetId:string;configRevision:string}>()
const emit=defineEmits<{'saved':[];'loaded':[view:ModelCatalogView]}>()
const view=ref<ModelCatalogView>(),models=ref<ModelDefinition[]>([]),enabled=ref(false),defaultModelId=ref<string>()
const busy=ref(false),error=ref(''),preview=ref<ClientConfigPreview>(),expanded=ref<string[]>([])
const importTicket=ref<string>(),importName=ref(''),resetBasis=ref(false),editOpen=ref(false),editing=ref<number>()
const empty=():ModelDefinition=>({modelId:'',displayName:'',reasoningEfforts:null,contextWindow:null,autoCompactTokenLimit:null,supportsVision:null})
const form=reactive(empty())
let generation=0
const initialDraft=ref('')
const signature=()=>JSON.stringify([enabled.value,models.value,defaultModelId.value??null,importTicket.value??null,resetBasis.value])
const dirty=computed(()=>!!view.value && signature()!==initialDraft.value)
const capabilities=computed(()=>new Map((resetBasis.value?view.value?.defaultCapabilities:view.value?.capabilities)?.map(model=>[model.modelId.toLowerCase(),model])))
const capability=(modelId:string)=>capabilities.value.get(modelId.toLowerCase())
const labels:Record<string,string>={model:'默认模型',model_catalog_json:'模型目录文件'}
async function run(action:()=>Promise<void>) {
  if(busy.value)return
  busy.value=true;error.value=''
  try{await action()}catch(cause){error.value=String(cause)}finally{busy.value=false}
}
function accept(value:ModelCatalogView) {
  view.value=value;models.value=structuredClone(value.models);enabled.value=value.source!=='official'
  defaultModelId.value=value.defaultModelId??undefined;importTicket.value=undefined;importName.value='';resetBasis.value=false
  initialDraft.value=signature()
  emit('loaded',value)
}
async function load() {
  const current=++generation,target=props.targetId
  error.value='';busy.value=true
  try {const value=await window.manager.readModelCatalog(target);if(current===generation)accept(value)}
  catch(cause){if(current===generation)error.value=String(cause)}
  finally{if(current===generation)busy.value=false}
}
watch(()=>[props.targetId,props.configRevision],(value,previous)=>{
  if(!previous || value[0]!==previous[0] || !dirty.value){preview.value=undefined;editOpen.value=false;void load()}
  else error.value='客户端配置已有其他修改，目录草稿已保留；请记录草稿后重新读取，再预览改动'
},{immediate:true})
onUnmounted(()=>{generation++})
function edit(index?:number) {editing.value=index;Object.assign(form,index===undefined?empty():JSON.parse(JSON.stringify(models.value[index])));editOpen.value=true}
function saveModel() {
  const model=JSON.parse(JSON.stringify(form)) as ModelDefinition
  if(!model.modelId.trim() || !model.displayName.trim()){message.error('请填写模型 ID 和显示名称');return}
  if(models.value.some((value,index)=>index!==editing.value && value.modelId.toLowerCase()===model.modelId.trim().toLowerCase())){message.error('模型 ID 已存在');return}
  model.modelId=model.modelId.trim();model.displayName=model.displayName.trim()
  if(model.contextWindow===null)model.autoCompactTokenLimit=null
  if(editing.value===undefined)models.value.push(model);else models.value[editing.value]=model
  editOpen.value=false
}
function move(index:number,direction:number) {const next=index+direction;if(next<0||next>=models.value.length)return;[models.value[index],models.value[next]]=[models.value[next],models.value[index]]}
function reset() {if(view.value){models.value=JSON.parse(JSON.stringify(view.value.defaults));defaultModelId.value=models.value[0]?.modelId;resetBasis.value=true;importTicket.value=undefined;importName.value='';enabled.value=true}}
async function importFile() {await run(async()=>{
  const imported=await window.manager.chooseModelCatalog(props.targetId)
  if(!imported)return
  models.value=imported.models;importTicket.value=imported.ticket;importName.value=imported.fileName;resetBasis.value=false;enabled.value=true
  if(view.value)view.value={...view.value,capabilities:imported.capabilities}
  if(!models.value.some(model=>model.modelId===defaultModelId.value))defaultModelId.value=undefined
})}
async function stage() {await run(async()=>{
  if(!view.value)return
  preview.value=await window.manager.previewModelCatalog(enabled.value?{id:props.targetId,revision:view.value.revision,enabled:true,models:JSON.parse(JSON.stringify(models.value)),defaultModelId:defaultModelId.value??null,reset:resetBasis.value,importTicket:importTicket.value}:{id:props.targetId,revision:view.value.revision,enabled:false})
})}
async function apply() {await run(async()=>{
  if(!preview.value)return
  const current=generation,target=props.targetId
  await window.manager.applyClientConfig(preview.value.ticket);preview.value=undefined
  const value=await window.manager.readModelCatalog(target)
  if(current!==generation)return
  accept(value);emit('saved');message.success('模型目录已保存，客户端重新加载后生效')
})}
async function cancelPreview(){preview.value=undefined;await window.manager.discardClientConfig()}
</script>

<template>
  <a-collapse v-model:active-key="expanded" class="settings-card model-catalog-card">
    <a-collapse-panel key="catalog" header="模型目录">
      <p class="muted">选择客户端可见模型，管理每个模型的上下文、推理档位和图片输入。目录声明来自随应用提供的模板或导入文件。</p>
      <a-alert v-if="error || view?.error" type="error" show-icon :message="error || view?.error" style="margin-bottom:16px" />
      <div class="catalog-toolbar"><a-space><a-switch v-model:checked="enabled" :disabled="busy" aria-label="启用自定义模型目录" /><strong>{{ enabled?'使用自定义目录':'跟随客户端官方目录' }}</strong></a-space><a-space wrap><a-button :disabled="busy" @click="importFile">导入目录</a-button><a-button :disabled="busy" @click="reset">重置为内置目录</a-button><a-button :disabled="busy" @click="load">重新读取目录</a-button></a-space></div>
      <template v-if="enabled">
        <a-alert v-if="importName" type="info" :message="`已载入 ${importName}，预览并应用后才会写入`" style="margin-bottom:16px" />
        <div class="catalog-toolbar"><a-space><span>默认模型</span><a-select v-model:value="defaultModelId" aria-label="目录默认模型" allow-clear placeholder="不指定默认模型" style="width:250px" :disabled="busy" :options="models.map(model=>({value:model.modelId,label:model.displayName}))" /></a-space><a-button :disabled="busy || models.length>=500" @click="edit()">添加模型</a-button></div>
        <a-table :data-source="models" row-key="modelId" size="small" :pagination="{pageSize:10,showSizeChanger:false}" :scroll="{x:800}" :columns="[{title:'模型',key:'model',width:200},{title:'上下文',key:'context',width:110},{title:'推理档位',key:'reasoning',width:170},{title:'Fast',key:'fast',width:70},{title:'操作',key:'actions',width:210}]">
          <template #bodyCell="{column,record}">
            <template v-if="column.key==='model'"><strong>{{record.displayName}}</strong><div class="muted model-id">{{record.modelId}}</div></template>
            <template v-else-if="column.key==='context'">{{record.contextWindow??capability(record.modelId)?.contextWindow??'继承模板'}}<div class="muted">{{record.contextWindow?'自定义':'目录默认'}}</div></template>
            <template v-else-if="column.key==='reasoning'"><span class="model-id">{{record.reasoningEfforts?.join(' / ') || capability(record.modelId)?.reasoningEfforts.join(' / ') || '继承模板'}}</span></template>
            <template v-else-if="column.key==='fast'"><a-tag v-if="capability(record.modelId)?.fast" color="purple">支持</a-tag><span v-else class="muted">{{capability(record.modelId)?'未声明':'待生成'}}</span></template>
            <template v-else-if="column.key==='actions'"><a-space :size="0"><a-button type="link" size="small" :disabled="busy" @click="edit(models.findIndex(model=>model.modelId===record.modelId))">编辑</a-button><a-button type="text" size="small" :disabled="busy || models[0].modelId===record.modelId" @click="move(models.findIndex(model=>model.modelId===record.modelId),-1)">↑</a-button><a-button type="text" size="small" :disabled="busy || models.at(-1)?.modelId===record.modelId" @click="move(models.findIndex(model=>model.modelId===record.modelId),1)">↓</a-button><a-button type="link" size="small" danger :disabled="busy || record.modelId.toLowerCase()==='gpt-reserve'" @click="models=models.filter(model=>model.modelId!==record.modelId)">移除</a-button></a-space></template>
          </template>
        </a-table>
        <p class="muted">保存后保留这份清单，不随账号变化自动增删。Reserve 是来源实现保留的备用模型；能否调用仍由账号决定。Fast 标记表示目录声明，未进行在线付费验证。</p>
      </template>
      <p v-else class="muted">应用后移除自定义目录引用，恢复客户端的官方模型列表。原来的目录文件和备份会保留。</p>
      <a-button type="primary" :loading="busy" @click="stage">预览目录改动</a-button>
    </a-collapse-panel>
  </a-collapse>
  <a-modal v-model:open="editOpen" title="编辑目录模型" ok-text="保存到草稿" cancel-text="取消" :width="560" @ok="saveModel">
    <a-form layout="vertical" :model="form">
      <a-form-item label="模型 ID" required><a-input v-model:value="form.modelId" :maxlength="128" :disabled="editing!==undefined && models[editing]?.modelId==='gpt-reserve'" /></a-form-item>
      <a-form-item label="显示名称" required><a-input v-model:value="form.displayName" :maxlength="100" /></a-form-item>
      <a-form-item label="推理档位" extra="清空时继承原始目录。自定义值必须在该模型原始能力声明中。"><a-select v-model:value="form.reasoningEfforts" mode="tags" allow-clear :options="(capability(form.modelId)?.reasoningEfforts??[]).map(value=>({value,label:value}))" /></a-form-item>
      <a-form-item label="上下文窗口（Token）" extra="留空继承原始目录值。"><a-input-number v-model:value="form.contextWindow" :min="2" :max="100000000" :precision="0" style="width:100%" /></a-form-item>
      <a-form-item label="自动压缩阈值（Token）" extra="必须小于窗口；只填窗口时按 90% 派生。"><a-input-number v-model:value="form.autoCompactTokenLimit" :disabled="!form.contextWindow" :min="1" :max="100000000" :precision="0" style="width:100%" /></a-form-item>
      <a-form-item label="图片输入"><a-select v-model:value="form.supportsVision" allow-clear placeholder="继承原始目录" :options="[{value:true,label:'支持图片'},{value:false,label:'仅文本'}]" /></a-form-item>
    </a-form>
  </a-modal>
  <a-modal :open="!!preview" title="确认模型目录改动" :width="740" ok-text="应用目录" cancel-text="取消" :ok-button-props="{disabled:!preview?.changes.length}" :confirm-loading="busy" @ok="apply" @cancel="cancelPreview">
    <p class="muted model-id">{{preview?.target.directory}}/config.toml</p>
    <a-table :data-source="preview?.changes" row-key="key" size="small" table-layout="fixed" :pagination="false" :columns="[{title:'设置',dataIndex:'key',width:110},{title:'当前值',dataIndex:'before',width:200},{title:'保存后',dataIndex:'after'}]"><template #bodyCell="{column,text}"><span v-if="column.dataIndex==='key'">{{labels[text]??text}}</span><code v-else class="model-id">{{text}}</code></template></a-table>
    <p v-if="preview?.catalogModels" class="muted">将保存 {{preview.catalogModels.length}} 个可见模型：</p><div v-if="preview?.catalogModels" class="catalog-preview-models"><a-tag v-for="id in preview.catalogModels" :key="id">{{id}}</a-tag></div>
    <a-alert v-if="error" type="error" :message="error" style="margin-top:16px" />
  </a-modal>
</template>

<style scoped>
.catalog-toolbar{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap;align-items:center;margin:16px 0}
.model-id{font-size:12px;overflow-wrap:anywhere;white-space:normal}
.catalog-preview-models{max-height:180px;overflow:auto;display:flex;gap:5px;flex-wrap:wrap}
</style>
