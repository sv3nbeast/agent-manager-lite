<script setup lang="ts">
import {computed} from 'vue'
import {CheckCircleFilled,InfoCircleOutlined} from '@ant-design/icons-vue'
import type {InstanceLaunchPreview} from '../../../shared/instances'
const props=defineProps<{preview:InstanceLaunchPreview}>()
const items=computed(()=>[
  {id:'locale',label:'页面语言',available:props.preview.desktopLocaleCompatibilityAvailable,reason:props.preview.desktopLocaleCompatibilityReason,detail:'跟随语言偏好'},
  {id:'speed',label:'对话速度',available:props.preview.speedMenuAvailable,reason:props.preview.speedMenuReason,detail:'普通 / Fast'},
  {id:'ultra',label:'最高推理',available:props.preview.ultraAvailable,reason:props.preview.ultraReason,detail:'Ultra · 支持的模型'}
].filter(item=>item.available!==undefined))
</script>

<template>
  <section v-if="items.length" class="desktop-compatibility" aria-label="客户端功能兼容状态">
    <div class="compatibility-heading"><strong>客户端功能</strong><span v-if="preview.clientVersion">Codex {{preview.clientVersion}}</span></div>
    <div class="compatibility-items">
      <div v-for="item in items" :key="item.id" class="compatibility-item" :data-feature="item.id" :data-available="item.available">
        <span class="compatibility-label">{{item.label}}</span>
        <span class="compatibility-result" :class="{'is-unavailable':!item.available}"><CheckCircleFilled v-if="item.available" /><InfoCircleOutlined v-else />{{item.available?item.detail:'待适配'}}</span>
        <span v-if="!item.available" class="compatibility-reason">{{item.reason}}</span>
      </div>
    </div>
    <p v-if="preview.speedMenuAvailable||preview.ultraAvailable">可选档位取决于模型和服务商支持。</p>
  </section>
</template>

<style scoped>
.desktop-compatibility{border:1px solid var(--border,#e4e7ec);border-radius:12px;padding:14px 16px;margin-bottom:18px;background:var(--subtle,transparent)}
.compatibility-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.compatibility-heading strong{font-size:13px}.compatibility-heading>span{font-size:11px;color:#84909e;font-variant-numeric:tabular-nums}
.compatibility-items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.compatibility-item{display:flex;flex-direction:column;gap:6px;min-width:0}.compatibility-label{font-size:12px;color:#778392}.compatibility-result{display:flex;align-items:center;gap:6px;font-size:12px;color:inherit}.compatibility-result .anticon{color:#42996d}.compatibility-result.is-unavailable .anticon{color:#bb8a33}.compatibility-reason{font-size:11px;line-height:1.5;color:#927a50}.desktop-compatibility p{margin:12px 0 0;font-size:11px;line-height:1.5;color:#84909e}
@media(max-width:520px){.compatibility-items{grid-template-columns:1fr}.compatibility-item{display:grid;grid-template-columns:80px 1fr}.compatibility-reason{grid-column:2}}
</style>
