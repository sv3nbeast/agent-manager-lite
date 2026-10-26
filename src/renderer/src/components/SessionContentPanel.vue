<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SessionContentBlock, SessionContentPage, SessionRecord } from '../../../shared/sessions'

const props = defineProps<{ snapshotId: string; record: SessionRecord; targetId: string; versionId?: string; initialQuery?: string; canResume?: boolean; canForkDefault?: boolean; canResumeCodex?: boolean; resumeReason?: string }>()
const emit = defineEmits<{ close: []; resume: [record: SessionRecord]; forkDefault: [record: SessionRecord]; resumeCodex:[record:SessionRecord] }>()
const result = ref<SessionContentPage>(), query = ref(props.initialQuery ?? ''), appliedQuery = ref(''), loading = ref(false), error = ref('')
const body = ref<HTMLElement>()
let generation = 0, alive = true
const roles = computed(() => ({ user: '你', assistant: props.record.clientType==='codex'?'Codex':'Claude', system: '系统' }))
const clientName = computed(() => props.record.clientType==='codex'?'Codex':props.record.launchMode === 'desktop' ? 'Claude Desktop · Code 本地记录' : 'Claude Code CLI')
const date = (value?: number) => value ? new Date(value).toLocaleString() : ''
const pageLabel = computed(() => !result.value?'':result.value.messages.length?`第 ${result.value.startIndex+1}–${result.value.startIndex+result.value.messages.length} 条 / 共 ${result.value.total} 条记录`:`没有匹配记录（共 ${result.value.total} 条）`)
const canLoadOlder = computed(()=>!!result.value&&result.value.startIndex>0)
const canLoadNewer = computed(()=>!!result.value&&result.value.startIndex+result.value.messages.length<result.value.total)
function blockTitle(block: SessionContentBlock): string {
  if (block.type === 'thinking') return '思考过程'
  if (block.type === 'tool_use') return '工具调用' + (block.name ? ' · ' + block.name : '')
  if (block.type === 'tool_result') return '工具结果' + (block.name ? ' · ' + block.name : '')
  if (block.type === 'notice') return '附件与记录说明'
  return '展开完整消息'
}
function codeSpan(value: string): string {
  const safe = value.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
  const runs = safe.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1)
  return `${fence} ${safe} ${fence}`
}
function codeBlock(value: string): string {
  const runs = value.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)))
  return `${fence}text\n${value}\n${fence}`
}
function plainMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+.!|])/g, '\\$1')
}
function markdownForCurrentPage(): string {
  const page = result.value
  if (!page) return ''
  const lines = [
    `# ${plainMarkdown(page.title.replace(/[\r\n]+/g, ' '))}`,
    '',
    `- 来源：${plainMarkdown(page.sourceName.replace(/[\r\n]+/g, ' '))}`,
    `- 项目：${codeSpan(page.cwd)}`,
    `- 会话 ID：${codeSpan(page.sourceSessionId)}`,
    `- 当前范围：${page.messages.length?`第 ${page.startIndex+1}–${page.startIndex+page.messages.length} 条`:'没有匹配记录'}（共 ${page.total} 条${appliedQuery.value ? '匹配记录' : '记录'}）`,
    '',
    '> 此文件仅包含当前显示窗口；切换窗口后可分别导出其他记录。',
  ]
  for (const entry of page.messages) {
    const heading = `## ${roles.value[entry.role]}${entry.timestamp ? ` · ${plainMarkdown(date(entry.timestamp))}` : ''}${entry.model ? ` · ${plainMarkdown(entry.model.replace(/[\r\n]+/g, ' '))}` : ''}`
    lines.push('', heading, '')
    for (const block of entry.blocks) {
      if (block.type === 'text') lines.push(block.text.split('\n').map(plainMarkdown).join('\n'), '')
      else {
        lines.push(`### ${plainMarkdown(blockTitle(block).replace(/[\r\n]+/g, ' '))}`, '', codeBlock(block.text), '')
      }
      if (block.truncated) lines.push('_此内容已截断。_', '')
    }
    if (entry.truncated) lines.push('_此消息部分内容已截断。_', '')
  }
  if (page.warnings.length) lines.push('', '## 读取提示', '', ...page.warnings.map(warning => `- ${warning.replace(/[\r\n]+/g, ' ')}`), '')
  return lines.join('\n').trimEnd() + '\n'
}
const actionFeedback = ref<{ type: 'success' | 'error'; text: string }>()
async function copyCurrentPage(): Promise<void> {
  const markdown = markdownForCurrentPage()
  if (!markdown) return
  try {
    await navigator.clipboard.writeText(markdown)
    actionFeedback.value = { type: 'success', text: `已复制${pageLabel.value}（当前窗口，不含其他记录）` }
  } catch { actionFeedback.value = { type: 'error', text: '复制失败；请检查系统剪贴板权限后重试' } }
}
function saveCurrentPage(): void {
  const page = result.value, markdown = markdownForCurrentPage()
  if (!page || !markdown) return
  const title = page.title.replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').trim().slice(0, 80) || 'Claude 会话'
  const blobUrl = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = blobUrl; anchor.download = `${title}-第${page.startIndex+1}-${page.startIndex+page.messages.length}条.md`
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
  actionFeedback.value = { type: 'success', text: `已下载${pageLabel.value}的 Markdown（当前窗口，不含其他记录）` }
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
function readErrorMessage(cause: unknown): string {
  const raw = typeof cause === 'string' ? cause : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string' ? cause.message : ''
  const message = raw.replace(/^Error:\s*/, '').trim() || '会话内容读取失败，请刷新会话列表后重试'
  if (/history_base/.test(message)) return `${message}。Codex 分段历史未能完整验证，因此没有显示局部内容；请刷新列表并检查来源目录中的 rollout 文件。`
  if (/会话文件.*变化|rollout.*变化/.test(message)) return `${message}。请刷新会话列表后重试。`
  return message
}
async function load(page = 1, recent = false, offset?:number, windowSize=10): Promise<void> {
  const current = ++generation, selection = { snapshotId: props.snapshotId, sessionId: props.record.id, targetId: props.targetId, ...(props.versionId ? { versionId: props.versionId } : {}), page, pageSize: windowSize, query: query.value.trim(), recent, ...(offset===undefined?{}:{offset}) }
  loading.value = true; error.value = ''; actionFeedback.value = undefined; result.value = undefined
  try {
    const next = await window.manager.sessionContent(selection)
    if (!alive || current !== generation) return
    result.value = next; appliedQuery.value = selection.query
    body.value?.scrollTo({ top: 0 })
  } catch (cause) { if (alive && current === generation) error.value = readErrorMessage(cause) }
  finally { if (alive && current === generation) loading.value = false }
}
function loadOlder():void{const current=result.value;if(!current||current.startIndex<=0)return;const count=Math.min(10,current.startIndex);void load(1,true,current.startIndex-count,count)}
function loadNewer():void{const current=result.value;if(!current||current.startIndex+current.messages.length>=current.total)return;void load(1,true,current.startIndex+current.messages.length,10)}
watch(() => [props.snapshotId, props.record.id, props.targetId, props.versionId], () => { query.value = props.initialQuery ?? ''; void load(1,true) })
onMounted(() => { void load(1,true) })
onUnmounted(() => { alive = false; generation++ })
</script>

<template>
  <a-modal open :width="960" title="会话内容" :footer="null" class="session-content-modal" @cancel="emit('close')">
    <div class="session-reader">
      <header class="session-reader-heading">
        <div><h2>{{result?.title ?? record.title}}</h2><div class="session-reader-source"><a-tag>{{clientName}}</a-tag><span>{{result?.sourceName ?? record.locations.find(location => location.targetId === targetId)?.name}}</span></div></div>
        <a-space><a-button v-if="canResume" type="primary" :disabled="loading" @click="emit('resume', record)">恢复此会话</a-button><a-button v-if="canForkDefault" type="primary" :disabled="loading" @click="emit('forkDefault', record)">在 Terminal 中分叉</a-button><a-button v-if="canResumeCodex" type="primary" :disabled="loading" @click="emit('resumeCodex',record)">恢复此会话</a-button></a-space>
      </header>
      <p class="muted session-reader-project">项目：{{result?.cwd ?? record.cwd}}</p>
      <p class="muted session-reader-id">会话 ID：{{record.sourceSessionId ?? record.id}} · 默认显示最近 10 条记录</p>
      <p v-if="resumeReason" class="muted session-reader-boundary">{{resumeReason}}</p>
      <a-form class="session-reader-search" layout="inline" :model="{query}" @finish="load(1,true)">
        <a-form-item><a-input v-model:value="query" aria-label="当前会话内容搜索" placeholder="查找这段会话中的文本" :maxlength="200" allow-clear :disabled="loading" /></a-form-item>
        <a-button html-type="submit" :loading="loading">查找</a-button>
        <span v-if="result" role="status" class="muted">{{appliedQuery ? '匹配' : '共'}} {{result.total}} 条消息</span>
      </a-form>
      <div v-if="result" class="session-reader-export">
        <span class="muted">{{pageLabel}}；当前窗口按时间正序，复制和下载只包含当前窗口</span>
        <a-space>
          <a-button size="small" :disabled="loading||!result.messages.length" @click="copyCurrentPage">复制当前窗口 Markdown</a-button>
          <a-button size="small" :disabled="loading||!result.messages.length" @click="saveCurrentPage">下载当前窗口 Markdown</a-button>
        </a-space>
      </div>
      <a-alert v-if="actionFeedback" :type="actionFeedback.type" :message="actionFeedback.text" class="session-reader-feedback" />
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
        <span class="muted">对话与工具记录以文本显示；附件不会自动加载。复制或下载仅包含当前窗口。</span>
        <a-space v-if="result && result.total > result.pageSize"><a-button size="small" :disabled="loading||!canLoadOlder" @click="loadOlder">更早 10 条</a-button><a-button size="small" :disabled="loading||!canLoadNewer" @click="loadNewer">更新 10 条</a-button></a-space>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.session-reader-heading,.session-reader-source,.session-message-heading,.session-reader-footer{display:flex;align-items:center;gap:10px}.session-reader-heading{justify-content:space-between;align-items:flex-start}.session-reader-heading h2{font-size:18px;margin:0 0 10px;overflow-wrap:anywhere}.session-reader-source{flex-wrap:wrap;font-size:12px}.session-reader-project,.session-reader-id{font-size:12px;overflow-wrap:anywhere;margin:8px 0}.session-reader-boundary{font-size:12px;margin:10px 0}.session-reader-search{margin:18px 0;display:flex;align-items:center;gap:10px}.session-reader-search :deep(.ant-form-item){flex:1;margin:0}.session-reader-search>span{font-size:12px}.session-reader-export{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:-6px 0 14px;font-size:12px}.session-reader-feedback{margin-bottom:12px}.session-reader-body{max-height:52vh;min-height:150px;overflow:auto;scrollbar-gutter:stable;padding-right:8px}.session-message{border:1px solid var(--border-color,#e6e8ed);border-radius:10px;padding:16px;margin:0 0 14px}.session-message-user{border-left:3px solid #3b82f6}.session-message-heading{flex-wrap:wrap;font-size:12px;margin-bottom:12px}.session-message-heading strong{font-size:13px}.session-message pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:13px;line-height:1.8}.session-content-detail{margin-top:10px}.session-content-detail summary{cursor:pointer;font-size:12px;font-weight:500}.session-content-detail pre{margin-top:10px;padding:12px;background:rgba(127,127,127,.06);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.session-content-limit{font-size:12px;margin:10px 0 0}.session-message mark{background:#fff1a8;color:#171717;border-radius:2px}.session-reader-footer{justify-content:space-between;flex-wrap:wrap;margin-top:16px;font-size:11px}.session-reader .error-banner ul{padding-left:18px;max-height:100px;overflow:auto}@media(max-width:700px){.session-reader-heading,.session-reader-search{align-items:stretch;flex-direction:column}.session-reader-body{max-height:48vh}}
</style>
