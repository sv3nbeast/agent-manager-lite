<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { ProviderProbeRecord } from '../../../shared/providerProbe'
import { useManager } from '../store'

const props=defineProps<{open:boolean;initial?:{providerId:string;keyId:string}}>()
const emit=defineEmits<{'update:open':[value:boolean]}>()
const manager=useManager(),mode=ref<'models'|'chat'>('models'),selection=ref<string[]>([])
const model=ref(''),prompt=ref('hi'),serviceTier=ref<string>('inherit'),busy=ref(false),error=ref('')
const state=computed(()=>manager.data?.providerProbe)
const providers=computed(()=>manager.data?.providers ?? [])
const options=computed(()=>providers.value.flatMap(provider=>provider.keys.map(key=>({
  value:`${provider.id}/${key.id}`,label:`${provider.name} · ${key.name || '未命名密钥'}`
}))))
watch(()=>props.open,open=>{
  if(!open)return
  error.value=''
  if(!state.value?.running)selection.value=props.initial ? [`${props.initial.providerId}/${props.initial.keyId}`] : options.value.slice(0,1).map(option=>option.value)
})
const labels:Record<string,string>={pending:'等待中',running:'测试中',success:'通过',error:'失败',cancelled:'已取消',stale:'配置已变化'}
const stageLabels:Record<string,string>={queued:'等待',models:'读取模型列表',starting:'启动临时服务',chat:'等待对话回复',cleanup:'清理临时服务',done:'已结束'}
const rowKey=(record:ProviderProbeRecord)=>`${record.providerId}/${record.keyId}`
const tierLabel=(value?:string)=>value==='priority' ? 'Fast' : value==='default' ? 'Standard' : value || '未观测'
const current=(record:ProviderProbeRecord)=>providers.value.find(provider=>provider.id===record.providerId && provider.revision===record.providerRevision)
async function start() {
  busy.value=true;error.value=''
  try {
    const targets=selection.value.map(value=>{
      const [providerId,keyId]=value.split('/'),provider=providers.value.find(p=>p.id===providerId)
      if(!provider || !provider.keys.some(key=>key.id===keyId))throw new Error('所选密钥已变化，请重新选择')
      return {providerId,keyId,revision:provider.revision}
    })
    if(!targets.length)throw new Error('请选择至少一把密钥')
    const ok=await manager.execute(()=>window.manager.startProviderProbe({mode:mode.value,targets,prompt:prompt.value.trim() || 'hi',
      ...(model.value.trim() ? {model:model.value.trim()} : {}),
      ...(serviceTier.value!=='inherit' ? {serviceTier:serviceTier.value as 'priority'|'default'|'auto'|'flex'} : {})}))
    if(!ok)error.value=manager.error
  } catch(e){error.value=e instanceof Error ? e.message : '启动失败'}
  finally{busy.value=false}
}
async function cancel() {
  if(state.value?.runId && !await manager.execute(()=>window.manager.cancelProviderProbe(state.value!.runId!)))error.value=manager.error
}
const modelRecord=ref<ProviderProbeRecord>(),modelSelection=ref<string[]>([])
const catalogOptions=computed(()=>[...new Set([...(modelRecord.value ? current(modelRecord.value)?.models ?? [] : []),...(modelRecord.value?.models?.map(model=>model.id) ?? [])])].map(id=>({label:id,value:id})))
function chooseModels(record:ProviderProbeRecord) {
  const provider=current(record)
  if(!provider){message.info('配置已变化，请重新获取模型');return}
  modelRecord.value=record;modelSelection.value=[...provider.models]
}
async function saveModels() {
  const record=modelRecord.value
  if(!record)return
  if(!modelSelection.value.length || modelSelection.value.length>500){message.info('请选择 1 至 500 个模型');return}
  if(await manager.execute(()=>window.manager.mutateProvider({action:'update',id:record.providerId,revision:record.providerRevision,changes:{models:[...modelSelection.value]}}))) {
    modelRecord.value=undefined;message.success('模型列表已保存，已同步关联账号')
  }
}
</script>

<template>
  <a-drawer :open="open" title="供应商接口测试" :width="880" destroy-on-close @close="emit('update:open',false)">
    <div class="provider-probe-panel">
      <a-form layout="vertical">
        <a-form-item label="测试内容"><a-radio-group v-model:value="mode" :disabled="state?.running" :options="[{label:'模型列表与连接',value:'models'},{label:'对话回复',value:'chat'}]" /></a-form-item>
        <a-form-item label="供应商与密钥" extra="每批最多 100 把密钥，按顺序执行。"><a-select v-model:value="selection" mode="multiple" show-search option-filter-prop="label" :disabled="state?.running" :options="options" placeholder="选择要测试的密钥" aria-label="测试目标" :max-tag-count="3" /></a-form-item>
        <template v-if="mode==='chat'">
          <div class="probe-form-row"><a-form-item label="模型" extra="留空按各供应商目录选择文本模型"><a-input v-model:value="model" aria-label="测试模型" :disabled="state?.running" :maxlength="200" /></a-form-item><a-form-item label="请求服务等级"><a-select v-model:value="serviceTier" :disabled="state?.running" :options="[{label:'使用供应商默认',value:'inherit'},{label:'Fast',value:'priority'},{label:'Standard',value:'default'},{label:'Auto',value:'auto'},{label:'Flex',value:'flex'}]" /></a-form-item></div>
          <a-form-item label="测试提示词" extra="经过独立临时本地 API 发送到所选接口，每次最多输出 256 tokens。"><a-textarea v-model:value="prompt" aria-label="测试提示词" :disabled="state?.running" :rows="2" :maxlength="4000" /></a-form-item>
        </template>
        <p v-else class="muted">连接测试读取 /models。模型列表可访问，不代表所有模型都能正常对话。</p>
        <a-space><a-button type="primary" :loading="busy" :disabled="state?.running || !selection.length" @click="start">开始测试</a-button><a-button v-if="state?.running" danger :loading="state.cancelling" @click="cancel">取消测试</a-button></a-space>
      </a-form>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
      <section v-if="state?.runId" class="probe-results">
        <div class="probe-result-heading"><h3>{{ state.mode==='models' ? '模型列表与连接结果' : '对话测试结果' }}</h3><a-tag :color="state.running ? 'processing' : undefined">{{ state.cancelling ? '正在取消' : state.running ? '进行中' : state.cancelled ? '已取消' : '已结束' }}</a-tag></div>
        <p class="muted">已处理 {{ state.completed }} / {{ state.total }} · 通过 {{ state.succeeded }} · 失败或过期 {{ state.failed }}</p>
        <a-table class="provider-probe-results" :data-source="state.records" :row-key="rowKey" :pagination="{pageSize:10,showSizeChanger:false,hideOnSinglePage:true}" :columns="[{title:'供应商 / 密钥',key:'identity'},{title:'结果',key:'status',width:140},{title:'耗时',key:'duration',width:90},{title:'操作',key:'actions',width:110}]" :scroll="{x:650}">
          <template #bodyCell="{column,record}">
            <template v-if="column.key==='identity'"><strong>{{ record.providerName }}</strong><small class="probe-subtext">{{ record.keyName || '未命名密钥' }} · {{ record.model || record.wireApi }}</small></template>
            <template v-else-if="column.key==='status'"><a-tag :color="record.status==='success' ? 'green' : record.status==='error' ? 'red' : record.status==='running' ? 'processing' : undefined">{{ labels[record.status] }}</a-tag><small v-if="record.status==='running'" class="probe-subtext">{{ stageLabels[record.stage] }}</small><small v-else-if="record.httpStatus" class="probe-subtext">HTTP {{ record.httpStatus }}</small></template>
            <template v-else-if="column.key==='duration'">{{ record.durationMs===undefined ? '—' : `${(record.durationMs/1000).toFixed(2)} s` }}</template>
            <template v-else><a-button v-if="record.models?.length" type="link" size="small" :disabled="!current(record) || state.running" @click="chooseModels(record)">选择模型</a-button></template>
          </template>
          <template #expandedRowRender="{record}"><div class="probe-output">
            <p>{{ record.baseUrl }}</p><a-alert v-if="record.error" type="error" :message="record.error" />
            <a-alert v-if="!current(record)" type="info" message="供应商配置已变化，此结果仅代表测试时的配置。" />
            <template v-if="record.models"><p>返回 {{ record.models.length }} 个模型{{ record.modelsTruncated ? '（列表过长，已截取前 1000 项）' : '' }}</p><div class="probe-model-list"><a-tag v-for="item in record.models" :key="item.id">{{ item.id }}</a-tag></div></template>
            <template v-if="state.mode==='chat'"><p>出站等级：{{ tierLabel(record.outboundTier) }} · 上游回显：{{ tierLabel(record.responseTier) }}</p><pre v-if="record.reply">{{ record.reply }}</pre><p v-if="record.replyTruncated" class="muted">回复较长，仅显示前 8000 个字符。</p></template>
          </div></template>
        </a-table>
        <p class="muted">结果保留到下一批测试或退出应用。关闭面板后测试继续，可从供应商页查看进度或取消。</p>
      </section>
    </div>
    <a-modal :open="!!modelRecord" destroy-on-close title="选择供应商模型" ok-text="保存模型" cancel-text="取消" :confirm-loading="manager.loading" @cancel="modelRecord=undefined" @ok="saveModels">
      <p>已选模型会替换供应商目录并同步到关联账号；原有模型默认保留，可手动取消。最多 500 项。</p>
      <a-select v-model:value="modelSelection" mode="multiple" :options="catalogOptions" show-search :max-tag-count="8" style="width:100%" aria-label="获取后的模型目录" />
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.probe-form-row{display:grid;grid-template-columns:1fr 1fr;gap:20px}.probe-results{margin-top:28px}.probe-result-heading{display:flex;justify-content:space-between;align-items:center}.probe-result-heading h3{margin:0}.probe-subtext{display:block;font-size:11px;opacity:.65;margin-top:5px}.probe-output{overflow-wrap:anywhere}.probe-output pre{white-space:pre-wrap;max-height:240px;overflow:auto;padding:14px;background:#7c3aed08;border-radius:10px;font:13px/1.7 ui-monospace,monospace}.probe-model-list{max-height:180px;overflow:auto}.probe-model-list .ant-tag{margin-bottom:6px}.probe-results>.muted{margin-top:16px;font-size:12px}
</style>
