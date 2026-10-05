<script setup lang="ts">
import {onUnmounted,ref} from 'vue'
import {useManager} from '../store'
import {useFormFeedback} from '../formFeedback'
import type {AccountRecyclePage,AccountRecyclePreview,AccountRecycleInput} from '../../../shared/accountRecycle'
const manager=useManager(),open=ref(false),loading=ref(false),busy=ref(false),error=ref(''),notice=ref(''),page=ref<AccountRecyclePage>(),selected=ref<string[]>([]),preview=ref<AccountRecyclePreview>()
useFormFeedback(()=>error.value,{active:()=>open.value})
let alive=true,request=0
const labels={restore:'恢复账号',export:'导出账号',purge:'永久删除'}
async function reload(){const current=++request;loading.value=true;error.value='';try{const result=await window.manager.listAccountRecycle();if(alive&&current===request){page.value=result;selected.value=[]}}catch(cause){if(alive&&current===request)error.value=String(cause)}finally{if(alive&&current===request)loading.value=false}}
async function begin(){open.value=true;notice.value='';preview.value=undefined;await reload()}
async function changePage(value:number){if(!page.value)return;loading.value=true;try{page.value=await window.manager.pageAccountRecycle({snapshotId:page.value.snapshotId,page:value})}catch(cause){error.value=String(cause)}finally{loading.value=false}}
async function prepare(action:AccountRecycleInput['action'],ids?:string[],all=false){
  if(!page.value||busy.value)return;busy.value=true;error.value='';notice.value=''
  try{preview.value=await window.manager.previewAccountRecycle({snapshotId:page.value.snapshotId,action,...all?{all:true}:{ids}})}catch(cause){error.value=String(cause)}finally{busy.value=false}
  if(preview.value?.action==='export')await perform()
}
async function perform(exportFirst=false){
  if(!preview.value||busy.value)return;const operation=preview.value;busy.value=true;error.value=''
  try{
    const result=await window.manager.applyAccountRecycle({ticket:operation.ticket,confirmed:true,exportFirst})
    if(result.cancelled){notice.value='已取消保存，回收站记录未删除。';return}
    // Forget a committed mutation before refreshing. A failed list reload must
    // never offer the completed destructive action a second time.
    preview.value=undefined;selected.value=[]
    notice.value=`${labels[operation.action]}完成，共 ${result.count} 个。`+(result.exported&&operation.action!=='export'?'已保存凭据备份。':'')
    await reload();await manager.refresh()
  }catch(cause){error.value=String(cause)}finally{busy.value=false}
}
async function cancelPreview(){preview.value=undefined;await window.manager.discardAccountRecycle().catch(cause=>{error.value=String(cause)})}
async function close(){if(busy.value)return;open.value=false;request++;loading.value=false;page.value=undefined;selected.value=[];await cancelPreview()}
onUnmounted(()=>{alive=false;request++;void window.manager.discardAccountRecycle()})
</script>
<template>
  <a-button @click="begin">账号回收站</a-button>
  <a-modal :open="open" title="账号回收站" :width="980" :closable="!busy" :mask-closable="false" :body-style="{maxHeight:'65vh',overflowY:'auto'}" @cancel="close">
    <div class="account-recycle">
      <p class="muted">移入的账号保留加密备份。恢复后可重新使用；正在运行的服务和客户端登录不会被自动接管。</p>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
      <a-alert v-if="notice" type="success" :message="notice" class="error-banner" />
      <div v-if="preview&&preview.action!=='export'" class="account-recycle-confirm">
        <h3>{{labels[preview.action]}} {{preview.count}} 个账号</h3>
        <p v-if="preview.action==='purge'">确认后将移除这些账号的回收站凭据备份。稍后新移入的账号不在本次范围内。</p>
        <p v-else>恢复账号资料及仍存在的原分组；已清理的本地 API 授权范围需要另行配置。同身份账号已存在时保留备份并停止恢复。</p>
        <p class="recycle-names">{{preview.names.join('、')}}{{preview.count>preview.names.length?'…':''}}</p>
        <p v-if="preview.action==='purge'" class="muted">可以先导出再删除。导出文件包含登录凭据；取消保存或保存失败时保留回收站记录。</p>
      </div>
      <template v-else>
        <div class="recycle-toolbar"><span>{{page?.total??0}} 个账号 · 已选 {{selected.length}}</span><a-space wrap><a-button :disabled="busy||loading" @click="reload">刷新</a-button><a-button :disabled="busy||loading||!selected.length" @click="prepare('restore',selected)">恢复所选</a-button><a-button :disabled="busy||loading||!selected.length" @click="prepare('export',selected)">导出所选</a-button><a-button :disabled="busy||loading||!selected.length" danger @click="prepare('purge',selected)">永久删除所选</a-button></a-space></div>
        <a-table class="account-recycle-table" row-key="id" :loading="loading" :data-source="page?.items??[]" :pagination="false" :scroll="{y:330}" :row-selection="{selectedRowKeys:selected,onChange:(keys:(string|number)[])=>selected=keys.map(String),preserveSelectedRowKeys:true,getCheckboxProps:()=>({disabled:busy||loading})}">
          <a-table-column key="name" title="账号"><template #default="{record}"><strong>{{record.name}}</strong><div class="muted recycle-meta">{{record.email||record.accountId}}</div></template></a-table-column>
          <a-table-column key="kind" title="类型" :width="125"><template #default="{record}">{{record.kind==='oauth'?'OAuth':record.kind==='api_key'?'API Key':'Agent Identity'}}<div class="muted recycle-meta">{{record.plan}}</div></template></a-table-column>
          <a-table-column key="deletedAt" title="移入时间" :width="165"><template #default="{record}">{{new Date(record.deletedAt).toLocaleString()}}</template></a-table-column>
          <a-table-column key="actions" title="操作" :width="185"><template #default="{record}"><a-space><a-button size="small" :disabled="busy" @click="prepare('restore',[record.id])">恢复</a-button><a-button size="small" :disabled="busy" @click="prepare('export',[record.id])">导出</a-button><a-button size="small" danger :disabled="busy" @click="prepare('purge',[record.id])">删除</a-button></a-space></template></a-table-column>
        </a-table>
        <a-pagination v-if="page&&page.total>25" :current="page.page" :page-size="25" :total="page.total" :show-size-changer="false" :disabled="busy||loading" @change="changePage" />
      </template>
    </div>
    <template #footer>
      <template v-if="preview&&preview.action!=='export'"><a-button :disabled="busy" @click="cancelPreview">返回</a-button><a-button :loading="busy" :danger="preview.action==='purge'" @click="perform()">确认{{labels[preview.action]}}</a-button><a-button v-if="preview.action==='purge'" type="primary" :loading="busy" @click="perform(true)">导出并删除</a-button></template>
      <template v-else><a-button :disabled="busy" @click="close">关闭</a-button><a-button :disabled="busy||loading||!page?.total" @click="prepare('export',undefined,true)">导出全部（含凭据）</a-button><a-button danger :disabled="busy||loading||!page?.total" @click="prepare('purge',undefined,true)">清空回收站</a-button></template>
    </template>
  </a-modal>
</template>
<style scoped>
.recycle-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0}.recycle-meta{font-size:11px;overflow-wrap:anywhere}.account-recycle .ant-pagination{text-align:right;margin-top:16px}.account-recycle-confirm{line-height:1.8;padding:12px 0}.recycle-names{overflow-wrap:anywhere}.account-recycle>.muted{line-height:1.8;font-size:12px}
</style>
