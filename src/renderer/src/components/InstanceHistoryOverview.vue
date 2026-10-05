<script setup lang="ts">
import { computed, nextTick, ref, watch, type CSSProperties } from 'vue'
import { theme } from 'ant-design-vue'
import { ExclamationCircleOutlined, FolderOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons-vue'
import type { InstanceHistorySummary } from '../../../shared/instances'

const props = defineProps<{ history: InstanceHistorySummary }>()
const { token } = theme.useToken()
const detailsOpen = ref(false), query = ref(''), detailsButton = ref<HTMLButtonElement>()
const colors = computed<CSSProperties>(() => ({
  '--history-text': token.value.colorText,
  '--history-muted': token.value.colorTextSecondary,
  '--history-border': token.value.colorBorderSecondary,
  '--history-surface': token.value.colorFillAlter,
  '--history-accent': token.value.colorPrimary,
  '--history-accent-bg': token.value.colorPrimaryBg,
  '--history-warning': token.value.colorWarningText,
  '--history-warning-bg': token.value.colorWarningBg,
  '--history-hover': token.value.colorFillTertiary,
}))
const projectPreview = computed(() => props.history.projects.slice(0, 3))
const remainingProjects = computed(() => Math.max(0, props.history.projects.length - projectPreview.value.length))
const filteredProjects = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return search ? props.history.projects.filter(project => [project.name, project.path].some(value => value.toLocaleLowerCase().includes(search))) : props.history.projects
})
const number = (value: number) => value.toLocaleString('zh-CN')
function openDetails() { query.value = ''; detailsOpen.value = true }
function closeDetails() {
  detailsOpen.value = false
  void nextTick(() => detailsButton.value?.focus())
}
watch(() => props.history, () => {
  if (detailsOpen.value) closeDetails()
  query.value = ''
}, { deep: true })
</script>

<template>
  <section class="instance-history-overview" :style="colors">
    <dl class="history-metrics">
      <div><dt>已保存会话</dt><dd>{{ number(history.sessions) }}</dd></div>
      <div><dt>项目</dt><dd>{{ number(history.projects.length) }}</dd></div>
      <div><dt>其中已归档</dt><dd>{{ number(history.archived) }}</dd></div>
    </dl>

    <div v-if="history.projects.length" class="history-project-preview">
      <div class="history-project-meta">
        <div class="history-project-names" aria-label="项目摘要">
          <FolderOutlined aria-hidden="true" />
          <span v-for="(project, index) in projectPreview" :key="project.path + ':' + index" class="history-project-name" :title="project.name">{{ project.name }}</span>
          <span v-if="remainingProjects" class="history-project-more">+{{ remainingProjects }}</span>
        </div>
        <p v-if="history.unassigned" class="history-unassigned">{{ number(history.unassigned) }} 个未关联项目的会话显示在「最近」。</p>
      </div>
      <button ref="detailsButton" type="button" class="history-details-button" aria-label="查看项目" aria-haspopup="dialog" :aria-expanded="detailsOpen" @click="openDetails">
        查看项目 <RightOutlined aria-hidden="true" />
      </button>
    </div>
    <p v-else class="history-unassigned">没有项目分组，会话显示在「最近」。</p>

    <div v-if="history.issues.length" class="history-issues" role="status">
      <ExclamationCircleOutlined aria-hidden="true" />
      <div><p v-for="(issue, index) in history.issues" :key="index">{{ issue }}</p></div>
    </div>

    <a-modal :open="detailsOpen" class="instance-history-detail-dialog" title="项目详情" aria-label="项目详情" :width="640" centered :keyboard="true" :mask-closable="true" :body-style="{ maxHeight: 'min(65vh, 640px)', overflowY: 'auto', padding: '18px 24px' }" @cancel="closeDetails">
      <template #footer><a-button @click="closeDetails">关闭</a-button></template>
      <div class="history-project-details" :style="colors">
        <a-input v-model:value="query" allow-clear aria-label="搜索项目" placeholder="搜索项目名称或路径">
          <template #prefix><SearchOutlined aria-hidden="true" /></template>
        </a-input>
        <p class="history-project-result" aria-live="polite">{{ query.trim() ? `找到 ${number(filteredProjects.length)} 个项目` : `${number(history.projects.length)} 个项目` }}<span v-if="history.unassigned"> · {{ number(history.unassigned) }} 个会话在「最近」</span></p>
        <ul v-if="filteredProjects.length" class="history-project-list" aria-label="项目会话分组">
          <li v-for="(project, index) in filteredProjects" :key="project.path + ':' + index" class="history-project-row">
            <FolderOutlined class="history-folder-icon" aria-hidden="true" />
            <div class="history-project-info">
              <div class="history-project-heading"><strong :title="project.name">{{ project.name }}</strong><span v-if="!project.exists" class="history-missing-directory">目录不存在</span></div>
              <p class="history-project-path" :title="project.path">{{ project.path }}</p>
            </div>
            <span class="history-project-count">{{ number(project.sessions) }}<span> 个会话</span></span>
          </li>
        </ul>
        <div v-else class="history-search-empty"><SearchOutlined aria-hidden="true" /><p>没有匹配的项目</p><span>试试项目名称或路径中的其他关键词。</span></div>
        <div v-if="history.issues.length" class="history-issues" role="status"><ExclamationCircleOutlined aria-hidden="true" /><div><p v-for="(issue, index) in history.issues" :key="index">{{ issue }}</p></div></div>
      </div>
    </a-modal>
  </section>
</template>

<style scoped>
.instance-history-overview{padding:14px 18px;border:1px solid var(--history-border);border-radius:12px;background:var(--history-surface);color:var(--history-text)}
.history-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0}
.history-metrics>div{padding:0 18px;border-left:1px solid var(--history-border)}
.history-metrics>div:first-child{padding-left:0;border-left:0}
.history-metrics>div:last-child{padding-right:0}
.history-metrics dt{font-size:13px;line-height:20px;color:var(--history-muted)}
.history-metrics dd{margin:2px 0 0;font-size:25px;font-weight:600;line-height:30px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.history-metrics>div:first-child dd{color:var(--history-accent)}
.history-project-preview{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--history-border)}
.history-project-meta{flex:1;min-width:0}
.history-project-names{display:flex;align-items:center;gap:7px;min-width:0;flex:1;color:var(--history-muted);font-size:13px}
.history-project-names>.anticon{flex-shrink:0;font-size:15px}
.history-project-name{min-width:0;max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;line-height:20px;border-radius:5px;background:var(--history-hover);color:var(--history-text)}
.history-project-more{white-space:nowrap;font-variant-numeric:tabular-nums}
.history-details-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;flex-shrink:0;padding:0 10px;background:transparent;border:1px solid var(--history-border);border-radius:7px;font:inherit;font-size:13px;color:var(--history-text);cursor:pointer;transition:background .12s,border-color .12s,transform .12s}
.history-details-button:hover{border-color:var(--history-accent);background:var(--history-accent-bg);color:var(--history-accent)}
.history-details-button:active{transform:translateY(1px)}
.history-details-button:focus-visible{outline:2px solid var(--history-accent);outline-offset:3px}
.history-details-button>.anticon{font-size:10px}
.history-unassigned{margin:10px 0 0;font-size:13px;line-height:20px;color:var(--history-muted)}
.history-project-meta .history-unassigned{margin-top:4px}
.history-issues{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--history-warning-bg);color:var(--history-warning);font-size:13px;line-height:20px}
.history-issues>.anticon{margin-top:3px;flex-shrink:0}
.history-issues p{margin:0;overflow-wrap:anywhere}
.history-issues p+p{margin-top:5px}
.history-project-details{color:var(--history-text)}
.history-project-details :deep(.ant-input-affix-wrapper){height:36px;border-radius:8px}
.history-project-details :deep(.ant-input-prefix){margin-right:7px;color:var(--history-muted)}
.history-project-result{margin:12px 0 4px;font-size:13px;line-height:20px;color:var(--history-muted)}
.history-project-list{margin:0;padding:0;list-style:none}
.history-project-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--history-border)}
.history-project-row:last-child{border-bottom:0}
.history-folder-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:34px;height:34px;border-radius:8px;font-size:17px;color:var(--history-accent);background:var(--history-accent-bg)}
.history-project-info{flex:1;min-width:0}
.history-project-heading{display:flex;align-items:center;gap:8px;min-width:0}
.history-project-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;line-height:21px}
.history-missing-directory{flex-shrink:0;padding:1px 6px;border-radius:5px;font-size:12px;line-height:18px;color:var(--history-warning);background:var(--history-warning-bg)}
.history-project-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:4px 0 0;font-size:13px;line-height:20px;color:var(--history-muted)}
.history-project-count{flex-shrink:0;font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.history-project-count span{font-size:13px;color:var(--history-muted)}
.history-search-empty{padding:36px 12px;text-align:center;color:var(--history-muted);font-size:13px}
.history-search-empty>.anticon{font-size:25px}
.history-search-empty p{margin:12px 0 5px;color:var(--history-text);font-size:14px}
@media(max-width:560px){.instance-history-overview{padding:14px}.history-metrics>div{padding:0 12px}.history-project-preview{align-items:flex-start}.history-project-names{flex-wrap:wrap}.history-project-name{max-width:115px}.history-project-heading{flex-wrap:wrap;gap:4px}.history-project-row{gap:9px}}
@media(prefers-reduced-motion:reduce){.history-details-button{transition:none}.history-details-button:active{transform:none}}
</style>
