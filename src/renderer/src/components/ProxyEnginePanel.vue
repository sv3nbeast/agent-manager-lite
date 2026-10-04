<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import {engineActive,engineErrors,type EngineStatus} from '../../../shared/proxyEngine'
const props=defineProps<{open:boolean}>(),emit=defineEmits<{'update:open':[boolean]}>()
const state=ref<EngineStatus>(),working=ref(false),error=ref(''),checked=ref(false),cancelling=ref(false)
const active=computed(()=>engineActive(state.value)),disabled=computed(()=>working.value||active.value),percent=computed(()=>state.value?.totalBytes?Math.min(100,Math.floor(state.value.receivedBytes/state.value.totalBytes*100)):0)
const labels={idle:'等待安装',downloading:'正在下载',importing:'正在读取安装包',verifying:'正在校验安装包',extracting:'正在解压',checking:'正在检查版本',installing:'正在完成安装',completed:'安装完成',cancelled:'安装已取消',failed:'安装失败'}
let generation=0,timer:ReturnType<typeof setTimeout>|undefined,statusRequest:Promise<EngineStatus>|undefined
function message(cause:unknown){return (cause instanceof Error?cause.message:String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/,'').replace(/^Error: /,'')}
async function refresh(version=generation){
  if(!props.open)return
  try{
    if(!statusRequest){const request=window.manager.proxyEngineStatus();statusRequest=request;void request.then(()=>{if(statusRequest===request)statusRequest=undefined},()=>{if(statusRequest===request)statusRequest=undefined})}
    const next=await statusRequest;if(version!==generation||!props.open)return
    state.value=next;if(!engineActive(next))cancelling.value=false
    if(engineActive(next))timer=setTimeout(()=>void refresh(version),300)
  }catch(cause){if(version===generation)error.value=message(cause)}
}
async function install(kind:'download'|'import'){
  clearTimeout(timer);const version=++generation;working.value=true;error.value='';checked.value=false
  try{const next=await (kind==='download'?window.manager.downloadProxyEngine():window.manager.importProxyEngine());if(version!==generation)return;if(next)state.value=next;await refresh(version)}catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation)working.value=false}
}
async function cancel(){if(!state.value?.jobId)return;cancelling.value=true;try{await window.manager.cancelProxyEngine(state.value.jobId)}catch(cause){error.value=message(cause);cancelling.value=false}}
async function check(){working.value=true;error.value='';checked.value=false;const version=generation;try{await window.manager.checkProxyEngine();if(version===generation)checked.value=true}catch(cause){if(version===generation)error.value=message(cause)}finally{if(version===generation){working.value=false;await refresh(version)}}}
watch(()=>props.open,open=>{clearTimeout(timer);generation++;working.value=false;error.value='';checked.value=false;if(open)void refresh(generation)},{immediate:true})
onBeforeUnmount(()=>{clearTimeout(timer);generation++})
</script>
<template>
  <a-modal :open="open" title="代理引擎" :width="660" :footer="null" destroy-on-close @cancel="emit('update:open',false)">
    <div class="proxy-engine-panel">
      <p class="muted">SS、VMess、VLESS、Trojan、Hysteria2、TUIC 分享链接通过 Mihomo 运行。HTTP / HTTPS / SOCKS 代理无需安装引擎。</p>
      <a-spin v-if="!state&&!error" />
      <template v-if="state">
        <div class="engine-summary"><strong>Mihomo {{state.version}}</strong><a-tag :color="state.installedVersion?'purple':'default'">{{state.installedVersion?'已安装 '+state.installedVersion:'尚未安装'}}</a-tag></div>
        <p class="engine-asset">{{state.assetName??'此系统暂无可用安装包'}} <span v-if="state.archiveBytes"> · {{(state.archiveBytes/1024/1024).toFixed(1)}} MiB</span></p>
        <p class="muted">从官方发布页下载，或选择同版本安装包。校验完整性与版本后才会替换旧安装。关闭窗口后安装继续，退出应用会取消。</p>
        <div v-if="active" class="engine-progress"><strong>{{labels[state.phase]}}</strong><a-progress :percent="percent" :show-info="['downloading','importing'].includes(state.phase)" /><span>{{(state.receivedBytes/1024/1024).toFixed(1)}} MiB</span></div>
        <a-alert v-if="error||(state.error&&state.error!=='ENGINE_INSTALL_CANCELLED')" type="error" :message="error||engineErrors[state.error!]" />
        <a-alert v-else-if="checked" type="success" message="文件完整性和版本检查通过" />
        <a-alert v-else-if="state.phase==='completed'||state.phase==='cancelled'" :type="state.phase==='completed'?'success':'info'" :message="labels[state.phase]" />
        <a-space wrap class="engine-actions">
          <a-button type="primary" :disabled="disabled||!state.supported" @click="install('download')">{{state.installedVersion?'重新下载安装':'下载并安装'}}</a-button>
          <a-button :disabled="disabled||!state.supported" @click="install('import')">导入官方安装包</a-button>
          <a-button :disabled="disabled||!state.installedVersion" @click="check">检查安装</a-button>
          <a-button v-if="active" danger :disabled="state.phase==='installing'" :loading="cancelling" @click="cancel">取消安装</a-button>
          <a-button v-if="!active" :disabled="working" @click="refresh()">刷新状态</a-button>
        </a-space>
        <p class="muted engine-license">Mihomo · GPL-3.0 · 仅用于选定账号的出口，不更改系统代理。完整订阅与代理组仍在迁移中。</p>
      </template>
      <a-alert v-else-if="error" type="error" :message="error" />
    </div>
  </a-modal>
</template>
<style scoped>
.engine-summary{display:flex;align-items:center;justify-content:space-between;margin:20px 0 8px}.engine-summary strong{font-size:20px}.engine-asset{overflow-wrap:anywhere;font-size:13px}.engine-progress{padding:16px 0}.engine-actions{margin-top:18px}.engine-license{margin-top:20px;font-size:12px}.proxy-engine-panel>.ant-alert{margin-top:14px}
</style>
