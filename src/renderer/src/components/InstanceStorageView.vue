<script setup lang="ts">
import {computed,onMounted,ref} from 'vue'
import type {InstanceStorageInventory,InstanceStorageCategory} from '../../../shared/instanceStorage'

const inventory=ref<InstanceStorageInventory>(),loading=ref(false),error=ref('')
const totalLabel=computed(()=>inventory.value?bytes(inventory.value.logicalBytes):'—')
const bytes=(value:number)=>{if(value<1024)return String(value)+' B';if(value<1024**2)return (value/1024).toFixed(1)+' KiB';if(value<1024**3)return (value/1024**2).toFixed(1)+' MiB';return (value/1024**3).toFixed(2)+' GiB'}
const date=(value?:number)=>value?new Date(value).toLocaleString():'元数据缺失'
const categoryName:Record<InstanceStorageCategory,string>={sessions:'会话与历史',databases:'SQLite 数据库',config:'配置与登录状态',skills:'技能',workspace:'实例工作目录',cache:'缓存',other:'其他文件'}
async function scan(){loading.value=true;error.value='';try{inventory.value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('存储扫描超过界面等待时限，请先处理超大目录后重试。')),35_000);window.manager.scanInstanceStorage().then(value=>{clearTimeout(timer);resolve(value)},cause=>{clearTimeout(timer);reject(cause)})})}catch(cause){error.value=cause instanceof Error?cause.message:String(cause)}finally{loading.value=false}}
onMounted(()=>void scan())
</script>

<template>
  <section class="storage-view">
    <div class="page-heading"><div><h1>存储清单</h1><p>只盘点本管理器的受管实例和历史归档，不自动移动或删除任何内容。</p></div><a-button :loading="loading" @click="scan">重新扫描</a-button></div>
    <a-alert type="info" show-icon message="显示文件逻辑大小，不能直接当作额外磁盘占用或可回收空间。" description="macOS APFS 克隆可能共享未修改的数据块；文件系统分配空间仅作估算，可能把共享块重复计算。外部 Codex 目录和登记在实例之外的项目工作目录不计入；受管实例内部工作区会单独统计。归档目录缺少可靠的原实例元数据时会标注，不能据此自动恢复或清理。" />
    <a-alert v-if="error" type="error" show-icon :message="error" class="error-banner" />
    <a-spin :spinning="loading">
      <template v-if="inventory">
        <div class="storage-summary">
          <a-card><a-statistic title="逻辑文件量" :value="totalLabel" /></a-card>
          <a-card><a-statistic title="目录条目" :value="inventory.rows.length" /></a-card>
          <a-card><a-statistic title="文件数量" :value="inventory.files.toLocaleString()" /></a-card>
          <a-card><a-statistic title="文件系统分配估算" :value="inventory.filesystemBlocksBytes===undefined?'不可用':bytes(inventory.filesystemBlocksBytes)" /></a-card>
        </div>
        <a-alert v-for="(warning,index) in inventory.warnings" :key="index" type="warning" show-icon :message="warning" class="storage-warning" />
        <a-empty v-if="!inventory.rows.length" description="没有发现受管实例目录或历史归档。" />
        <a-card v-for="row in inventory.rows" :key="row.id" class="storage-row" :data-storage-id="row.id">
          <template #title><div class="storage-row-title"><span>{{row.name}}</span><a-tag :color="row.kind==='managed'?'blue':'orange'">{{row.kind==='managed'?'受管实例':'历史归档'}}</a-tag><span class="muted storage-path" :title="row.directory">{{row.directory}}</span></div></template>
          <template #extra><div class="storage-size"><strong>{{bytes(row.logicalBytes)}}</strong><small class="muted">逻辑大小</small></div></template>
          <a-alert v-if="row.warning" type="warning" show-icon :message="row.warning" class="storage-warning" />
          <a-descriptions size="small" :column="2" bordered>
            <a-descriptions-item label="创建时间">{{date(row.createdAt)}}</a-descriptions-item>
            <a-descriptions-item label="文件数">{{row.files.toLocaleString()}}</a-descriptions-item>
            <a-descriptions-item label="分配空间估算">{{row.filesystemBlocksBytes===undefined?'不可用':bytes(row.filesystemBlocksBytes)}}<span class="muted"> · 仅为文件系统块估算</span></a-descriptions-item>
            <a-descriptions-item label="分类逻辑大小"><span v-for="category in row.categories" :key="category.category" class="storage-category">{{categoryName[category.category]}} {{bytes(category.logicalBytes)}} ({{category.files}})</span></a-descriptions-item>
          </a-descriptions>
        </a-card>
        <p class="muted storage-footnote">扫描时间：{{date(inventory.capturedAt)}}。统计会跳过符号链接，并受目录读取权限及安全扫描上限影响。若上方显示扫描已停止，当前数字只代表已读取部分，不是完整总量。</p>
      </template>
    </a-spin>
  </section>
</template>

<style scoped>
.storage-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:18px 0}.storage-row{margin:14px 0}.storage-row-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.storage-path{font-size:11px;font-weight:400;overflow-wrap:anywhere}.storage-size{display:flex;flex-direction:column;text-align:right}.storage-size small{font-size:11px}.storage-category{display:inline-block;margin:0 12px 5px 0;white-space:nowrap}.storage-warning{margin-bottom:10px}.storage-footnote{font-size:12px;margin-top:18px}@media(max-width:900px){.storage-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
