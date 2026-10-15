<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { ProviderProbeRecord } from '../../../shared/providerProbe'
import { providerKeyModels, providerKeyProtocol } from '../../../shared/providerLibrary'
import { useManager } from '../store'

const props=defineProps<{open:boolean;initial?:{providerId:string;keyId:string}}>()
const emit=defineEmits<{'update:open':[value:boolean]}>()
const manager=useManager(),mode=ref<'models'|'chat'>('models'),selection=ref<string[]>([])
const testModels=ref<Record<string,string>>({}),prompt=ref('hi'),serviceTier=ref<string>('inherit'),busy=ref(false),error=ref('')
const state=computed(()=>manager.data?.providerProbe)
const providers=computed(()=>manager.data?.providers ?? [])
const options=computed(()=>providers.value.flatMap(provider=>provider.keys.map(key=>({
  value:`${provider.id}/${key.id}`,label:`${provider.name} · ${key.name || '未命名密钥'}`
}))))
const selectedTargets=computed(()=>selection.value.flatMap(value=>{
  const [providerId,keyId]=value.split('/'),provider=providers.value.find(item=>item.id===providerId),key=provider?.keys.find(item=>item.id===keyId)
  return provider && key ? [{value,provider,key,models:providerKeyModels(provider,key),protocol:providerKeyProtocol(provider,key)}] : []
}))
const hasOpenAiTarget=computed(()=>selectedTargets.value.some(target=>target.protocol!=='anthropic_messages'))
watch(selectedTargets,targets=>{
  testModels.value=Object.fromEntries(targets.map(target=>[target.value,target.models.includes(testModels.value[target.value]) ? testModels.value[target.value] : target.models[0] ?? '']))
},{immediate:true})
watch(()=>props.open,open=>{
  if(!open)return
  error.value=''
  if(!state.value?.running)selection.value=props.initial ? [`${props.initial.providerId}/${props.initial.keyId}`] : options.value.slice(0,1).map(option=>option.value)
})
const labels:Record<string,string>={pending:'等待中',running:'测试中',success:'通过',error:'失败',cancelled:'已取消',stale:'配置已变化'}
const stageLabels:Record<string,string>={queued:'等待',models:'读取模型列表',starting:'准备请求',chat:'等待对话回复',cleanup:'结束测试',done:'已结束'}
const rowKey=(record:ProviderProbeRecord)=>`${record.providerId}/${record.keyId}`
const tierLabel=(value?:string)=>value==='priority' ? 'Fast' : value==='default' ? 'Standard' : value || '未观测'
const current=(record:ProviderProbeRecord)=>providers.value.find(provider=>provider.id===record.providerId && provider.revision===record.providerRevision)
async function start() {
  busy.value=true;error.value=''
  try {
    const targets=selection.value.map(value=>{
      const [providerId,keyId]=value.split('/'),provider=providers.value.find(p=>p.id===providerId)
      const key=provider?.keys.find(item=>item.id===keyId)
      if(!provider || !key)throw new Error('所选密钥已变化，请重新选择')
      const model=testModels.value[value]
      if(mode.value==='chat' && (!model || !providerKeyModels(provider,key).includes(model)))throw new Error(`请为「${provider.name} · ${key.name || '未命名密钥'}」选择已配置的测试模型`)
      return {providerId,keyId,revision:provider.revision,...(mode.value==='chat' ? {model} : {})}
    })
    if(!targets.length)throw new Error('请选择至少一把密钥')
    const ok=await manager.execute(()=>window.manager.startProviderProbe({mode:mode.value,targets,prompt:prompt.value.trim() || 'hi',
      ...(hasOpenAiTarget.value && serviceTier.value!=='inherit' ? {serviceTier:serviceTier.value as 'priority'|'default'|'auto'|'flex'} : {})}))
    if(!ok)error.value=manager.error
  } catch(e){error.value=e instanceof Error ? e.message : '启动失败'}
  finally{busy.value=false}
}
async function cancel() {
  if(state.value?.runId && !await manager.execute(()=>window.manager.cancelProviderProbe(state.value!.runId!)))error.value=manager.error
}
const modelRecord=ref<ProviderProbeRecord>(),modelSelection=ref<string[]>([])
const currentKey=(record:ProviderProbeRecord)=>current(record)?.keys.find(key=>key.id===record.keyId)
const catalogOptions=computed(()=>{
  const record=modelRecord.value,provider=record && current(record),key=record && currentKey(record)
  return [...new Set([...(provider && key ? providerKeyModels(provider,key) : []),...(record?.models?.map(model=>model.id) ?? [])])].map(id=>({label:id,value:id}))
})
function addFetchedModels() {
  const next=[...new Set([...modelSelection.value,...(modelRecord.value?.models?.map(model=>model.id) ?? [])])]
  if(next.length>500){message.info('最多保存 500 个模型，请缩小选择范围');return}
  modelSelection.value=next
}
function chooseModels(record:ProviderProbeRecord) {
  const provider=current(record)
  const key=currentKey(record)
  if(!provider || !key){message.info('配置已变化，请重新获取模型');return}
  manager.error='';modelRecord.value=record;modelSelection.value=[...providerKeyModels(provider,key)]
}
async function saveModels() {
  const record=modelRecord.value
  if(!record)return
  if(modelSelection.value.length>500){message.info('最多保存 500 个模型');return}
  if(await manager.execute(()=>window.manager.mutateProvider({action:'editKey',id:record.providerId,revision:record.providerRevision,keyId:record.keyId,models:[...modelSelection.value]}))) {
    modelRecord.value=undefined;message.success('此密钥的模型列表已保存')
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
          <div class="probe-target-models">
            <a-form-item v-for="target in selectedTargets" :key="target.value" :label="`${target.provider.name} · ${target.key.name || '未命名密钥'}`" :extra="target.models.length ? '仅列出此密钥保存的模型；本次使用下方所选模型。' : '此密钥尚未配置模型，请先读取模型列表并保存，或在密钥编辑中添加。'">
              <a-select v-model:value="testModels[target.value]" show-search option-filter-prop="label" :options="target.models.map(id=>({label:id,value:id}))" :disabled="state?.running" :aria-label="`测试模型 · ${target.provider.name} · ${target.key.name || '未命名密钥'}`" placeholder="选择此密钥的测试模型" />
            </a-form-item>
          </div>
          <a-form-item v-if="hasOpenAiTarget" label="请求服务等级" extra="仅应用于 OpenAI 协议的测试目标。"><a-select v-model:value="serviceTier" :disabled="state?.running" :options="[{label:'使用供应商默认',value:'inherit'},{label:'Fast',value:'priority'},{label:'Standard',value:'default'},{label:'Auto',value:'auto'},{label:'Flex',value:'flex'}]" /></a-form-item>
          <a-form-item label="测试提示词" extra="按各密钥的 API 协议发送到对应接口，每次最多输出 256 tokens。"><a-textarea v-model:value="prompt" aria-label="测试提示词" :disabled="state?.running" :rows="2" :maxlength="4000" /></a-form-item>
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
            <template v-if="column.key==='identity'"><strong>{{ record.providerName }}</strong><small class="probe-subtext">{{ record.keyName || '未命名密钥' }} · {{ record.model || record.protocol || record.wireApi }}</small></template>
            <template v-else-if="column.key==='status'"><a-tag :color="record.status==='success' ? 'green' : record.status==='error' ? 'red' : record.status==='running' ? 'processing' : undefined">{{ labels[record.status] }}</a-tag><small v-if="record.status==='running'" class="probe-subtext">{{ stageLabels[record.stage] }}</small><small v-else-if="record.httpStatus" class="probe-subtext">HTTP {{ record.httpStatus }}</small></template>
            <template v-else-if="column.key==='duration'">{{ record.durationMs===undefined ? '—' : `${(record.durationMs/1000).toFixed(2)} s` }}</template>
            <template v-else><a-button v-if="record.models?.length" type="link" size="small" :disabled="!current(record) || state.running" @click="chooseModels(record)">选择模型</a-button></template>
          </template>
          <template #expandedRowRender="{record}"><div class="probe-output">
            <p>{{ record.baseUrl }}</p><a-alert v-if="record.error" type="error" :message="record.error" />
            <a-alert v-if="!current(record)" type="info" message="供应商配置已变化，此结果仅代表测试时的配置。" />
            <template v-if="record.models"><p>返回 {{ record.models.length }} 个模型{{ record.modelsTruncated ? '（列表过长，已截取前 1000 项）' : '' }}</p><div class="probe-model-list"><a-tag v-for="item in record.models" :key="item.id">{{ item.id }}</a-tag></div></template>
            <template v-if="state.mode==='chat'"><p v-if="record.protocol!=='anthropic_messages'">出站等级：{{ tierLabel(record.outboundTier) }} · 上游回显：{{ tierLabel(record.responseTier) }}</p><pre v-if="record.reply">{{ record.reply }}</pre><p v-if="record.replyTruncated" class="muted">回复较长，仅显示前 8000 个字符。</p></template>
          </div></template>
        </a-table>
        <p class="muted">结果保留到下一批测试或退出应用。关闭面板后测试继续，可从供应商页查看进度或取消。</p>
      </section>
    </div>
    <a-modal :open="!!modelRecord" destroy-on-close title="选择此密钥的模型" ok-text="保存模型" cancel-text="取消" :confirm-loading="manager.loading" @cancel="modelRecord=undefined" @ok="saveModels">
      <p>{{ modelRecord?.providerName }} · {{ modelRecord?.keyName || '未命名密钥' }}：仅更新此密钥和它关联的连接，其余密钥不受影响。最多 500 项。</p>
      <a-space class="catalog-bulk-actions"><a-button size="small" :disabled="!modelRecord?.models?.length || modelRecord.models.length>500" @click="addFetchedModels">全部加入</a-button><a-button size="small" :disabled="!modelSelection.length" @click="modelSelection=[]">全部清除</a-button></a-space>
      <a-select v-model:value="modelSelection" mode="multiple" :options="catalogOptions" show-search :max-tag-count="8" style="width:100%" aria-label="获取后的模型目录" />
      <a-alert v-if="manager.error" type="error" :message="manager.error" class="error-banner" />
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.probe-target-models{padding:16px 16px 0;margin-bottom:20px;border:1px solid var(--border);border-radius:12px}.catalog-bulk-actions{margin-bottom:12px}.probe-results{margin-top:28px}.probe-result-heading{display:flex;justify-content:space-between;align-items:center}.probe-result-heading h3{margin:0}.probe-subtext{display:block;font-size:11px;opacity:.65;margin-top:5px}.probe-output{overflow-wrap:anywhere}.probe-output pre{white-space:pre-wrap;max-height:240px;overflow:auto;padding:14px;background:#7c3aed08;border-radius:10px;font:13px/1.7 ui-monospace,monospace}.probe-model-list{max-height:180px;overflow:auto}.probe-model-list .ant-tag{margin-bottom:6px}.probe-results>.muted{margin-top:16px;font-size:12px}
</style>
