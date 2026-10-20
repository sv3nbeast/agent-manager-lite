<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SessionContentBlock, SessionContentPage, SessionRecord } from '../../../shared/sessions'

const props = defineProps<{ snapshotId: string; record: SessionRecord; targetId: string; initialQuery?: string; canResume?: boolean; resumeReason?: string }>()
const emit = defineEmits<{ close: []; resume: [record: SessionRecord] }>()
const result = ref<SessionContentPage>(), query = ref(props.initialQuery ?? ''), appliedQuery = ref(''), loading = ref(false), error = ref('')
const body = ref<HTMLElement>()
let generation = 0, alive = true
const roles = { user: '你', assistant: 'Claude', system: '系统' }
const clientName = computed(() => props.record.launchMode === 'desktop' ? 'Claude Desktop · Code 本地记录' : 'Claude Code CLI')
const date = (value?: number) => value ? new Date(value).toLocaleString() : ''
function blockTitle(block: SessionContentBlock): string {
  if (block.type === 'thinking') return '思考过程'
  if (block.type === 'tool_use') return '工具调用' + (block.name ? ' · ' + block.name : '')
  if (block.type === 'tool_result') return '工具结果' + (block.name ? ' · ' + block.name : '')
  if (block.type === 'notice') return '附件与记录说明'
  return '展开完整消息'
}
function highlight(text: string): { text: string; match: boolean }[] {
  const needle = appliedQuery.value.toLocaleLowerCase()
  if (!needle) return [{ text, match: false }]
  const haystack = text.toLocaleLowerCase(), parts: { text: string; match: boolean }[] = []
  let offset = 0, found = haystack.indexOf(needle)
  // Limit markup for repetitive tool output; the remaining text still renders.
  while (found !== -1 && parts.length < 600) {
    if (found > offset) parts.push({ text: text.slice(offset, found), match: false })
    parts.push({ text: text.slice(found, found + needle.length), match: true })
    offset = found + needle.length; found = haystack.indexOf(needle, offset)
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), match: false })
  return parts
}
async function load(page = 1): Promise<void> {
  const current = ++generation, selection = { snapshotId: props.snapshotId, sessionId: props.record.id, targetId: props.targetId, page, pageSize: 40, query: query.value.trim() }
  loading.value = true; error.value = ''; result.value = undefined
  try {
    const next = await window.manager.sessionContent(selection)
    if (!alive || current !== generation) return
    result.value = next; appliedQuery.value = selection.query
    body.value?.scrollTo({ top: 0 })
  } catch (cause) { if (alive && current === generation) error.value = String(cause) }
  finally { if (alive && current === generation) loading.value = false }
}
watch(() => [props.snapshotId, props.record.id, props.targetId], () => { query.value = props.initialQuery ?? ''; void load() })
onMounted(() => { void load() })
onUnmounted(() => { alive = false; generation++ })
</script>

<template>
  <a-modal open :width="960" title="会话内容" :footer="null" class="session-content-modal" @cancel="emit('close')">
    <div class="session-reader">
      <header class="session-reader-heading">
        <div><h2>{{record.title}}</h2><div class="session-reader-source"><a-tag>{{clientName}}</a-tag><span>{{result?.sourceName ?? record.locations.find(location => location.targetId === targetId)?.name}}</span></div></div>
        <a-button v-if="canResume" type="primary" :disabled="loading" @click="emit('resume', record)">恢复此会话</a-button>
      </header>
      <p class="muted session-reader-project">项目：{{result?.cwd ?? record.cwd}}</p>
      <p class="muted session-reader-id">会话 ID：{{record.sourceSessionId ?? record.id}}</p>
      <p v-if="resumeReason" class="muted session-reader-boundary">{{resumeReason}}</p>
      <a-form class="session-reader-search" layout="inline" :model="{query}" @finish="load(1)">
        <a-form-item><a-input v-model:value="query" aria-label="当前会话内容搜索" placeholder="查找这段会话中的文本" :maxlength="200" allow-clear :disabled="loading" /></a-form-item>
        <a-button html-type="submit" :loading="loading">查找</a-button>
        <span v-if="result" role="status" class="muted">{{appliedQuery ? '匹配' : '共'}} {{result.total}} 条消息</span>
      </a-form>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
      <a-alert v-if="result?.warnings.length" type="warning" class="error-banner"><template #message>记录读取提示</template><template #description><ul><li v-for="warning in result.warnings" :key="warning">{{warning}}</li></ul></template></a-alert>
      <div ref="body" class="session-reader-body" :aria-busy="loading">
        <a-spin :spinning="loading">
          <a-empty v-if="!loading && result && !result.messages.length" :description="appliedQuery ? '没有找到匹配消息，可修改或清空查找文本。' : '这段记录暂时没有可显示的消息。'" />
          <article v-for="entry in result?.messages ?? []" :key="entry.index" class="session-message" :class="'session-message-' + entry.role" :data-message-index="entry.index">
            <header class="session-message-heading"><strong>{{roles[entry.role]}}</strong><span class="muted">{{date(entry.timestamp)}}</span><span v-if="entry.model" class="muted">{{entry.model}}</span></header>
            <template v-for="(block, blockIndex) in entry.blocks" :key="blockIndex">
              <details v-if="block.type !== 'text' || block.text.length > 2400" class="session-content-detail" :class="'session-block-' + block.type" :open="!!appliedQuery">
                <summary>{{blockTitle(block)}}<span v-if="block.truncated" class="muted"> · 部分内容</span></summary>
                <pre><template v-for="(part, partIndex) in highlight(block.text)" :key="partIndex"><mark v-if="part.match">{{part.text}}</mark><template v-else>{{part.text}}</template></template></pre>
              </details>
              <pre v-else class="session-message-text"><template v-for="(part, partIndex) in highlight(block.text)" :key="partIndex"><mark v-if="part.match">{{part.text}}</mark><template v-else>{{part.text}}</template></template><span v-if="block.truncated" class="muted">\n（部分内容，可打开会话文件查看完整记录）</span></pre>
            </template>
            <p v-if="entry.truncated" class="muted session-content-limit">本条消息较长，显示部分内容；完整记录可从会话列表打开文件查看。</p>
          </article>
        </a-spin>
      </div>
      <footer class="session-reader-footer">
        <span class="muted">对话与工具记录以文本显示；附件不会自动加载。</span>
        <a-pagination v-if="result && result.total > result.pageSize" :current="result.page" :total="result.total" :page-size="result.pageSize" :show-size-changer="false" :disabled="loading" size="small" @change="load" />
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.session-reader-heading,.session-reader-source,.session-message-heading,.session-reader-footer{display:flex;align-items:center;gap:10px}.session-reader-heading{justify-content:space-between;align-items:flex-start}.session-reader-heading h2{font-size:18px;margin:0 0 10px;overflow-wrap:anywhere}.session-reader-source{flex-wrap:wrap;font-size:12px}.session-reader-project,.session-reader-id{font-size:12px;overflow-wrap:anywhere;margin:8px 0}.session-reader-boundary{font-size:12px;margin:10px 0}.session-reader-search{margin:18px 0;display:flex;align-items:center;gap:10px}.session-reader-search :deep(.ant-form-item){flex:1;margin:0}.session-reader-search>span{font-size:12px}.session-reader-body{max-height:52vh;min-height:150px;overflow:auto;scrollbar-gutter:stable;padding-right:8px}.session-message{border:1px solid var(--border-color,#e6e8ed);border-radius:10px;padding:16px;margin:0 0 14px}.session-message-user{border-left:3px solid #3b82f6}.session-message-heading{flex-wrap:wrap;font-size:12px;margin-bottom:12px}.session-message-heading strong{font-size:13px}.session-message pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:13px;line-height:1.8}.session-content-detail{margin-top:10px}.session-content-detail summary{cursor:pointer;font-size:12px;font-weight:500}.session-content-detail pre{margin-top:10px;padding:12px;background:rgba(127,127,127,.06);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.session-content-limit{font-size:12px;margin:10px 0 0}.session-message mark{background:#fff1a8;color:#171717;border-radius:2px}.session-reader-footer{justify-content:space-between;flex-wrap:wrap;margin-top:16px;font-size:11px}.session-reader .error-banner ul{padding-left:18px;max-height:100px;overflow:auto}@media(max-width:700px){.session-reader-heading,.session-reader-search{align-items:stretch;flex-direction:column}.session-reader-body{max-height:48vh}}
</style>
