<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue'
import {Modal,message} from 'ant-design-vue'
import type {LocalKeyDetails,LocalKeyView,LocalPoolSettings,CustomRoutingRule,QuotaReserveThreshold} from '../../../shared/localAccess'
import {useManager} from '../store'
const manager=useManager(),state=computed(()=>manager.data?.localAccess),accounts=computed(()=>manager.data?.accounts??[])
const busy=computed(()=>Boolean(state.value?.running||state.value?.starting)),otherService=computed(()=>state.value?.singleStarting||manager.data?.gateway?.running&&!state.value?.running)
const settings=reactive<LocalPoolSettings>({accountIds:[],routingStrategy:'auto',customRoutingRules:[],sessionAffinity:true,sessionAffinityTtlMs:3600000,quotaReserve:{}})
const savedPool=computed(()=>state.value?{accountIds:state.value.accountIds,routingStrategy:state.value.routingStrategy,customRoutingRules:state.value.customRoutingRules??[],sessionAffinity:state.value.sessionAffinity,sessionAffinityTtlMs:state.value.sessionAffinityTtlMs,quotaReserve:state.value.quotaReserve??{}}:undefined)
watch(()=>JSON.stringify(savedPool.value),()=>{if(savedPool.value)Object.assign(settings,{...savedPool.value,accountIds:[...savedPool.value.accountIds],customRoutingRules:savedPool.value.customRoutingRules.map(rule=>({...rule})),quotaReserve:Object.fromEntries(Object.entries(savedPool.value.quotaReserve).map(([id,value])=>[id,{...value}]))})},{immediate:true})
const dirty=computed(()=>JSON.stringify(settings)!==JSON.stringify(savedPool.value))
const open=ref(false),editing=ref<LocalKeyView>(),allowed=ref(''),excluded=ref('')
const form=reactive<LocalKeyDetails>({label:'',enabled:true,inheritAccountPool:true,accountIds:[],priorityAccountIds:[],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0})
const options=computed(()=>accounts.value.filter(account=>state.value?.accountIds.includes(account.id)).map(account=>({value:account.id,label:account.name})))
const priorityOptions=computed(()=>options.value.filter(option=>form.inheritAccountPool||form.accountIds.includes(option.value)))
watch(()=>priorityOptions.value,options=>{form.priorityAccountIds=(form.priorityAccountIds??[]).filter(id=>options.some(option=>option.value===id))})
watch(()=>settings.accountIds,ids=>{settings.customRoutingRules=(settings.customRoutingRules??[]).filter(rule=>ids.includes(rule.accountId))})
const oauthRows=computed(()=>settings.accountIds.map(id=>accounts.value.find(account=>account.id===id)).filter((account):account is NonNullable<typeof account>=>!!account&&account.kind==='oauth'))
function reserveFor(id:string):QuotaReserveThreshold{return settings.quotaReserve[id]??{hourlyPercent:0,weeklyPercent:0}}
function setReserve(id:string,part:'hourlyPercent'|'weeklyPercent',value:unknown){const next={...reserveFor(id),[part]:Math.max(0,Math.min(100,Number(value??0)))};if(next.hourlyPercent===0&&next.weeklyPercent===0)delete settings.quotaReserve[id];else settings.quotaReserve={...settings.quotaReserve,[id]:next}}
const routingColumns=[{title:'账号 / 已知配额',key:'account'},{title:'使用顺序',key:'order',width:140},{title:'优先级',key:'priority',width:105},{title:'权重',key:'weight',width:105}]
const routingRows=computed(()=>{
  const names=new Map(accounts.value.map(account=>[account.id,account.name])),info=new Map((state.value?.accountInfo??[]).map(value=>[value.id,value])),rules=new Map((settings.customRoutingRules??[]).map(rule=>[rule.accountId,rule]))
  return settings.accountIds.map(id=>({id,name:names.get(id)??'已移除账号',info:info.get(id),rule:rules.get(id)??{accountId:id,priority:0,weight:1,isBackup:false,isPreferred:false}}))
})
function setRule(id:string,changes:Partial<CustomRoutingRule>){const existing=routingRows.value.find(row=>row.id===id)!.rule;settings.customRoutingRules=[...(settings.customRoutingRules??[]).filter(rule=>rule.accountId!==id),{...existing,...changes}]}
function setOrder(id:string,value:unknown){setRule(id,{isPreferred:value==='preferred',isBackup:value==='backup'})}
const columns=[{title:'名称',key:'label'},{title:'账号范围',key:'scope'},{title:'模型限制',key:'models'},{title:'Token 用量 / 上限',key:'tokens'},{title:'状态',key:'state'},{title:'操作',key:'actions'}]
const names=(ids:string[])=>ids.map(id=>accounts.value.find(account=>account.id===id)?.name??'已移除账号').join('、')
const start=()=>manager.execute(()=>window.manager.startLocalAccess())
const stop=()=>manager.execute(()=>window.manager.stopLocalAccess())
function changeAffinity(value:string|number|null){settings.sessionAffinityTtlMs=Number(value||60)*60000}
async function savePool(){await manager.execute(()=>window.manager.mutateLocalAccess({action:'savePool',revision:state.value!.revision,settings:{...settings,accountIds:[...settings.accountIds],customRoutingRules:settings.customRoutingRules?.map(rule=>({...rule})),quotaReserve:Object.fromEntries(Object.entries(settings.quotaReserve).map(([id,value])=>[id,{...value}]))}}))}
function edit(key?:LocalKeyView){editing.value=key;Object.assign(form,key?{label:key.label,enabled:key.enabled,inheritAccountPool:key.inheritAccountPool,accountIds:[...key.accountIds],priorityAccountIds:[...(key.priorityAccountIds??[])],modelPrefix:key.modelPrefix,allowedModels:key.allowedModels,excludedModels:key.excludedModels,tokenLimit:key.tokenLimit}:{label:'',enabled:true,inheritAccountPool:true,accountIds:[],priorityAccountIds:[],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0});allowed.value=form.allowedModels.join('\n');excluded.value=form.excludedModels.join('\n');open.value=true}
async function saveKey(){const lines=(text:string)=>[...new Set(text.split('\n').map(value=>value.trim()).filter(Boolean))];const details={...form,accountIds:[...form.accountIds],priorityAccountIds:[...(form.priorityAccountIds??[])],allowedModels:lines(allowed.value),excludedModels:lines(excluded.value)};if(await manager.execute(()=>window.manager.mutateLocalAccess(editing.value?{action:'updateKey',id:editing.value.id,revision:editing.value.revision,details}:{action:'createKey',details})))open.value=false}
async function copy(key:LocalKeyView){try{await window.manager.copyLocalAccessKey(key.id);message.success({content:'本地密钥已复制',key:'local-key'})}catch(error){message.error(String(error))}}
function change(key:LocalKeyView,action:'rotateKey'|'deleteKey'){Modal.confirm({title:action==='rotateKey'?`重置“${key.label}”的密钥？`:`删除密钥“${key.label}”？`,content:action==='rotateKey'?'原密钥将失效，Token 已用量保留。':'该密钥将无法再访问本地服务，历史调用记录保留。',okText:'确认',cancelText:'取消',async onOk(){await manager.execute(()=>window.manager.mutateLocalAccess({action,id:key.id,revision:key.revision}))}})}
</script>
<template>
  <section class="local-access-panel">
    <a-alert v-if="state?.error" type="error" :message="state.error" class="error-banner" />
    <a-alert v-if="otherService" type="info" message="单账号连接正在运行。请先在单账号页停止，再启动账号池。" class="error-banner" />
    <a-card title="账号池" class="settings-card">
      <a-form layout="vertical">
        <a-form-item label="可用账号"><a-select v-model:value="settings.accountIds" mode="multiple" aria-label="账号池账号" :disabled="busy" :options="accounts.map(account=>({value:account.id,label:account.name}))" placeholder="选择可被本地 API 调度的账号" :max-tag-count="4" /></a-form-item>
        <div class="pool-options"><a-form-item label="调度策略"><a-select v-model:value="settings.routingStrategy" aria-label="账号池调度策略" :disabled="busy" :options="[{value:'auto',label:'自动'},{value:'random',label:'随机'},{value:'single_account',label:'固定首个账号'},{value:'quota_high_first',label:'剩余额度高优先'},{value:'quota_low_first',label:'剩余额度低优先'},{value:'plan_high_first',label:'高套餐优先'},{value:'plan_low_first',label:'低套餐优先'},{value:'expiry_soon_first',label:'订阅即将到期优先'},{value:'custom',label:'自定义优先级和权重'}]" /></a-form-item><a-form-item label="会话保持"><a-switch v-model:checked="settings.sessionAffinity" :disabled="busy" aria-label="账号池会话保持" /><span class="muted">同一会话优先使用原账号</span></a-form-item><a-form-item label="保持时长（分钟）"><a-input-number :value="settings.sessionAffinityTtlMs/60000" :disabled="busy||!settings.sessionAffinity" :min="1" :max="1440" @change="changeAffinity" /></a-form-item></div>
        <a-collapse class="routing-rules" :default-active-key="[]" ghost>
          <a-collapse-panel key="rules" header="账号优先级与配额">
            <a-table :columns="routingColumns" :data-source="routingRows" row-key="id" size="small" :pagination="{pageSize:6,showSizeChanger:false}" :scroll="{x:590}">
              <template #bodyCell="{column,record}">
                <template v-if="column.key==='account'"><strong>{{record.name}}</strong><div class="muted">剩余额度：{{record.info?.remainingPercent===undefined?'未知':`${record.info.remainingPercent}%`}} · 到期：{{record.info?.expiresAt?new Date(record.info.expiresAt).toLocaleString():'未知'}}</div></template>
                <template v-else-if="column.key==='order'"><a-select :value="record.rule.isPreferred?'preferred':record.rule.isBackup?'backup':'normal'" :disabled="busy||settings.routingStrategy==='single_account'" :aria-label="`账号使用顺序 ${record.name}`" :options="[{value:'preferred',label:'优先'},{value:'normal',label:'正常'},{value:'backup',label:'备用'}]" style="width:110px" @change="setOrder(record.id,$event)" /></template>
                <template v-else-if="column.key==='priority'"><a-input-number :value="record.rule.priority" :disabled="busy||settings.routingStrategy!=='custom'" :min="0" :max="100" :precision="0" :aria-label="`账号优先级 ${record.name}`" style="width:76px" @change="setRule(record.id,{priority:Number($event??0)})" /></template>
                <template v-else-if="column.key==='weight'"><a-input-number :value="record.rule.weight" :disabled="busy||settings.routingStrategy!=='custom'" :min="1" :max="100" :precision="0" :aria-label="`账号权重 ${record.name}`" style="width:76px" @change="setRule(record.id,{weight:Number($event??1)})" /></template>
              </template>
            </a-table>
            <p class="muted pool-help">依次使用优先、正常、备用账号；当前层没有可用账号时进入下一层。自定义模式中优先级越大越优先，同级按权重分配。会话保持可能继续使用已选账号。</p>
          </a-collapse-panel>
          <a-collapse-panel key="quota-reserve" header="OAuth 额度储备（可选）">
            <p class="muted pool-help">设置后，达到任一阈值的 OAuth 账号会暂时保留给需要的场景，不参与普通本地 API 调度。0 表示不设置；刷新账号用量后约一秒内生效。仅适用于 OAuth 账号，API Key 不显示在这里。</p>
            <a-table :data-source="oauthRows" :pagination="false" row-key="id" size="small">
              <a-table-column title="账号" key="name"><template #default="{record}"><strong>{{record.name}}</strong><div class="muted">当前剩余：{{(state?.accountInfo??[]).find(value=>value.id===record.id)?.remainingPercent===undefined?'未知':`${(state?.accountInfo??[]).find(value=>value.id===record.id)?.remainingPercent}%`}}</div></template></a-table-column>
              <a-table-column title="5 小时阈值 (%)" key="hourly"><template #default="{record}"><a-input-number :value="reserveFor(record.id).hourlyPercent" :min="0" :max="100" :precision="0" :disabled="busy" style="width:130px" @change="setReserve(record.id,'hourlyPercent',$event)" /></template></a-table-column>
              <a-table-column title="周阈值 (%)" key="weekly"><template #default="{record}"><a-input-number :value="reserveFor(record.id).weeklyPercent" :min="0" :max="100" :precision="0" :disabled="busy" style="width:120px" @change="setReserve(record.id,'weeklyPercent',$event)" /></template></a-table-column>
            </a-table>
            <a-empty v-if="!oauthRows.length" description="当前账号池没有 OAuth 账号" :image="undefined" />
          </a-collapse-panel>
        </a-collapse>
        <a-space wrap><a-button :disabled="busy" :loading="manager.loading" @click="savePool">保存账号池</a-button><a-button v-if="!busy" type="primary" :disabled="otherService||dirty||!state?.accountIds.length||!state.keys.some(key=>key.enabled)" :loading="manager.loading" @click="start">启动账号池</a-button><a-button v-else danger :loading="manager.loading" @click="stop">{{state?.starting?'取消启动':'停止账号池'}}</a-button></a-space>
      </a-form>
      <p v-if="settings.routingStrategy==='single_account'" class="muted pool-help">每把密钥只使用其范围内第一个账号；失败也不会切换到其他账号。账号顺序按选择顺序保存；此模式不使用其他排序设置。</p>
      <p class="muted pool-help">先保存账号范围，再创建下游密钥。账号及供应商的默认等级优先于全局设置，用户请求中的显式等级优先。运行期间修改默认等级需停止重启。刷新用量后，新配额约一秒内应用到后续调度；已有流式请求继续执行。</p>
      <a-alert v-if="state?.running" type="success" :message="`已启动：http://127.0.0.1:${state.port}/v1`" description="配置已应用。每把密钥仅能调用自身范围内的账号和模型。" />
    </a-card>
    <a-card class="pool-keys" title="下游密钥"><template #extra><a-button type="primary" :disabled="busy" @click="edit()">创建密钥</a-button></template>
      <a-table :columns="columns" :data-source="state?.keys??[]" row-key="id" size="small" :pagination="{pageSize:8,showSizeChanger:false}" :scroll="{x:800}">
        <template #bodyCell="{column,record}">
          <template v-if="column.key==='label'"><strong>{{record.label}}</strong><div class="muted" v-if="record.modelPrefix">模型前缀：{{record.modelPrefix}}</div></template>
          <template v-else-if="column.key==='scope'"><a-tooltip :title="names(record.effectiveAccountIds)">{{record.inheritAccountPool?'继承账号池':'独立范围'}} · {{record.effectiveAccountIds.length}} 个账号</a-tooltip><div v-if="record.priorityAccountIds?.length" class="muted"><a-tooltip :title="names(record.priorityAccountIds)">优先 {{record.priorityAccountIds.length}} 个账号</a-tooltip></div></template>
          <template v-else-if="column.key==='models'">{{record.allowedModels.length?`允许 ${record.allowedModels.length} 条`:'允许全部'}}<div v-if="record.excludedModels.length">排除 {{record.excludedModels.length}} 条</div></template>
          <template v-else-if="column.key==='tokens'">{{record.tokenUsed===null?'未知':record.tokenUsed.toLocaleString()}} / {{record.tokenLimit?record.tokenLimit.toLocaleString():'不限'}}</template>
          <template v-else-if="column.key==='state'"><a-tag :color="record.enabled?'green':undefined">{{record.enabled?'启用':'禁用'}}</a-tag></template>
          <template v-else-if="column.key==='actions'"><a-space wrap><a-button size="small" @click="copy(record)">复制</a-button><a-button size="small" :disabled="busy" @click="edit(record)">编辑</a-button><a-button size="small" :disabled="busy" @click="change(record,'rotateKey')">重置</a-button><a-button size="small" danger :disabled="busy" @click="change(record,'deleteKey')">删除</a-button></a-space></template>
        </template>
      </a-table>
      <p class="muted pool-help">密钥只在本机加密保存，复制时写入剪贴板。重置密钥保留已用量；Token 上限按请求完成后的用量判断，并发在途请求可能超出。更改权限前需停止账号池。</p>
    </a-card>
    <a-modal :open="open" centered :width="640" :body-style="{maxHeight:'calc(100vh - 220px)',overflowY:'auto'}" :title="editing?'编辑本地密钥':'创建本地密钥'" ok-text="保存密钥" cancel-text="取消" :confirm-loading="manager.loading" @ok="saveKey" @cancel="open=false">
      <a-form layout="vertical" class="local-key-editor">
        <a-form-item label="密钥名称"><a-input v-model:value="form.label" aria-label="本地密钥名称" :maxlength="120" /></a-form-item>
        <a-form-item label="启用"><a-switch v-model:checked="form.enabled" aria-label="本地密钥启用" /></a-form-item>
        <a-form-item label="继承账号池"><a-switch v-model:checked="form.inheritAccountPool" aria-label="密钥继承账号池" /></a-form-item>
        <a-form-item v-if="!form.inheritAccountPool" label="独立账号范围"><a-select v-model:value="form.accountIds" mode="multiple" aria-label="密钥账号范围" :options="options" /></a-form-item>
        <a-form-item label="优先账号顺序" extra="按选择顺序优先尝试；只在同一使用层级内生效，保留会话保持。固定首个账号模式不使用此列表。"><a-select v-model:value="form.priorityAccountIds" mode="multiple" aria-label="密钥优先账号" :options="priorityOptions" :disabled="state?.routingStrategy==='single_account'" placeholder="可选，未选择时跟随账号池策略" /></a-form-item>
        <a-form-item label="模型前缀" extra="可选，例如 work：客户端使用 work/模型名。"><a-input v-model:value="form.modelPrefix" aria-label="本地密钥模型前缀" :maxlength="64" /></a-form-item>
        <div class="pool-options"><a-form-item label="允许的模型" extra="每行一条，支持 *；空白表示允许全部。"><a-textarea v-model:value="allowed" aria-label="本地密钥允许模型" :rows="3" /></a-form-item><a-form-item label="排除的模型" extra="每行一条，优先于允许规则。"><a-textarea v-model:value="excluded" aria-label="本地密钥排除模型" :rows="3" /></a-form-item></div>
        <a-form-item label="Token 总上限" extra="0 表示不限；重置密钥不会重置已用量。"><a-input-number v-model:value="form.tokenLimit" aria-label="本地密钥Token上限" :min="0" :max="Number.MAX_SAFE_INTEGER" :precision="0" style="width:100%" /></a-form-item>
        <a-alert v-if="manager.error" type="error" :message="manager.error" />
      </a-form>
    </a-modal>
  </section>
</template>
<style scoped>
.routing-rules{margin-bottom:16px}.routing-rules strong{overflow-wrap:anywhere}.pool-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}.pool-options .ant-switch{margin-right:8px}.pool-help{font-size:12px;line-height:1.8;margin-top:18px}.pool-keys{margin-top:20px}.pool-keys strong{overflow-wrap:anywhere}
</style>
