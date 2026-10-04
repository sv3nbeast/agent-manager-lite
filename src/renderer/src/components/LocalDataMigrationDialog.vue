<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { AppSnapshot } from '../../../shared/types'
import type { LocalDataPreview, LocalDataScan } from '../../../shared/localDataMigration'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ changed: [snapshot: AppSnapshot]; close: [] }>()
const scan = ref<LocalDataScan>()
const selected = ref<string[]>([])
const preview = ref<LocalDataPreview>()
const phase = ref<'scan' | 'preview' | 'apply' | ''>('')
const error = ref('')
const now = ref(Date.now())
let generation = 0
let requestId: string | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
const busy = computed(() => !!phase.value)
const applying = computed(() => phase.value === 'apply')
const expired = computed(() => !!preview.value && preview.value.expiresAt <= now.value)
const hasChanges = computed(() => {
  const counts = preview.value?.counts
  return !!preview.value?.newArchive || !!counts && counts.addedAccounts + counts.addedProviders + counts.mergedProviders + counts.addedKeys + counts.addedGroups + counts.mergedGroups > 0
})
const canApply = computed(() => !!preview.value && !preview.value.errors.length && !expired.value && hasChanges.value && !busy.value)
const displayError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/, '')
const accountKind = (kind: string) => kind === 'oauth' ? 'ChatGPT' : kind === 'agent_identity' ? 'Agent Identity' : '供应商连接'
const providerAction = (action: string) => ({ add: '新增', merge: '合并', duplicate: '重复，保留现有', conflict: '配置冲突' })[action] || action
const tierLabel = (tier: string | undefined) => ({ fast: 'Fast', standard: 'Standard', flex: 'Flex', auto: 'Auto', follow: '跟随请求', inherit: '继承' })[tier ?? 'inherit'] || '继承'

function discardPreview() {
  const ticket = preview.value?.ticket
  preview.value = undefined
  if (ticket) void window.manager.discardLocalData(ticket).catch(() => {})
}
function invalidate() {
  generation++
  const pending = requestId
  requestId = undefined
  if (pending) void window.manager.cancelLocalData(pending).catch(() => {})
  discardPreview()
  phase.value = ''
  error.value = ''
}
function reset() { invalidate(); scan.value = undefined; selected.value = [] }
function close() {
  if (applying.value) return
  reset()
  emit('close')
}
function cancelOperation() {
  if (applying.value) return
  reset()
}
watch(() => props.open, reset)
watch(preview, value => {
  clearInterval(expiryTimer)
  expiryTimer = undefined
  now.value = Date.now()
  if (value) expiryTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => { reset(); clearInterval(expiryTimer) })

async function inspect(custom: boolean) {
  reset()
  const version = generation
  const started = crypto.randomUUID()
  requestId = started
  phase.value = 'scan'
  try {
    const result = custom ? await window.manager.chooseLocalData(started) : await window.manager.scanLocalData(started)
    if (version !== generation) {
      void window.manager.cancelLocalData(started).catch(() => {})
      return
    }
    if (result) {
      scan.value = result
      selected.value = result.sources.filter(source => source.accounts + source.providers + source.groups > 0).map(source => source.id)
    }
  } catch (e) {
    if (version === generation) error.value = displayError(e)
  } finally {
    if (version === generation) phase.value = ''
  }
}
async function prepare() {
  if (!scan.value || !selected.value.length || busy.value) return
  const version = ++generation
  discardPreview()
  error.value = ''
  phase.value = 'preview'
  const input = { scanId: scan.value.scanId, sourceIds: [...selected.value] }
  try {
    const result = await window.manager.previewLocalData(input)
    if (version !== generation) {
      void window.manager.discardLocalData(result.ticket).catch(() => {})
      return
    }
    preview.value = result
  } catch (e) {
    if (version === generation) error.value = displayError(e)
  } finally {
    if (version === generation) phase.value = ''
  }
}
function back() {
  generation++
  discardPreview()
  error.value = ''
  phase.value = ''
}
async function apply() {
  if (!canApply.value || !preview.value) return
  const ticket = preview.value.ticket
  const version = ++generation
  phase.value = 'apply'
  error.value = ''
  try {
    const result = await window.manager.applyLocalData({ ticket, confirmed: true })
    // The transaction may finish after a parent closes the dialog. Its snapshot is still current.
    emit('changed', result.snapshot)
    message.success(`已导入 ${result.addedAccounts} 个账号、${result.addedProviders} 个供应商，合并 ${result.mergedProviders} 个供应商`)
    if (version === generation) {
      preview.value = undefined
      reset()
      emit('close')
    }
  } catch (e) {
    if (version === generation) error.value = displayError(e)
  } finally {
    if (version === generation) phase.value = ''
  }
}
</script>

<template>
  <a-modal :open="open" title="扫描本机数据" :width="820" :closable="!applying" :mask-closable="!applying" :keyboard="!applying" destroy-on-close @cancel="close">
    <template #footer>
      <div v-if="preview" class="modal-actions local-data-actions"><a-button :disabled="applying" @click="close">取消</a-button><a-button :disabled="applying" @click="back">返回选择</a-button><a-button type="primary" :disabled="!canApply" :loading="applying" @click="apply">确认迁移</a-button></div>
      <div v-else-if="scan" class="modal-actions local-data-actions"><a-button :disabled="busy" @click="close">取消</a-button><a-button type="primary" :disabled="!selected.length || busy" :loading="phase === 'preview'" @click="prepare">预览迁移</a-button></div>
      <a-button v-else @click="close">取消</a-button>
    </template>
    <div class="local-data-dialog">
      <p class="muted">从本机客户端或兼容账号库导入 ChatGPT 账号、供应商和分组。先扫描、再预览，确认后才保存到本应用；不会修改来源文件。</p>
      <template v-if="!preview">
        <a-space wrap>
          <a-button type="primary" :disabled="busy" :loading="phase === 'scan'" @click="inspect(false)">扫描本机数据</a-button>
          <a-button :disabled="busy" @click="inspect(true)">选择兼容数据目录</a-button>
          <a-button v-if="busy" @click="cancelOperation">取消{{ phase === 'scan' ? '扫描' : '预览' }}</a-button>
        </a-space>
        <p v-if="!scan" class="muted local-data-empty">点击扫描查找常用客户端数据，也可以自行选择目录。</p>
        <template v-else>
          <p v-if="!scan.sources.length" class="muted local-data-empty">未找到可迁移的数据。可以选择其他兼容数据目录。</p>
          <a-checkbox-group v-else v-model:value="selected" class="local-data-sources" :disabled="busy">
            <article v-for="source in scan.sources" :key="source.id" class="local-data-source">
              <a-checkbox :value="source.id"><strong>{{ source.name }}</strong></a-checkbox>
              <code class="local-data-path">{{ source.path }}</code>
              <p class="local-data-count">{{ source.accounts }} 个账号 · {{ source.providers }} 个供应商 · {{ source.groups }} 个分组</p>
              <a-alert v-for="(issue, index) in source.issues" :key="index" type="warning" :message="issue" />
            </article>
          </a-checkbox-group>
        </template>
      </template>
      <template v-else>
        <div class="local-data-summary">
          <div><strong>{{ preview.counts.addedAccounts }}</strong><span>新增账号</span></div>
          <div><strong>{{ preview.counts.duplicateAccounts }}</strong><span>重复账号</span></div>
          <div><strong>{{ preview.counts.addedProviders }}</strong><span>新增供应商</span></div>
          <div><strong>{{ preview.counts.mergedProviders }}</strong><span>合并供应商</span></div>
        </div>
        <p class="muted">新增 {{ preview.counts.addedKeys }} 个供应商密钥、{{ preview.counts.addedGroups }} 个分组，合并 {{ preview.counts.mergedGroups }} 个分组。重复账号保留本应用当前信息。</p>
        <p class="muted">{{ preview.newArchive ? '新增加密归档' : '已存在加密归档' }}：{{ preview.preservedFiles }} 份来源数据保存在本应用密库中；外部实例和账号绑定需要重新配置。</p>
        <details class="local-data-origin"><summary>来源目录（{{ preview.sources.length }}）</summary><code v-for="source in preview.sources" :key="source.id" class="local-data-path">{{ source.path }}</code></details>
        <a-alert v-for="(item, index) in preview.warnings" :key="`warning-${index}`" type="warning" :message="item" />
        <a-alert v-for="(item, index) in preview.errors" :key="`error-${index}`" type="error" :message="item" />
        <section v-if="preview.accounts.length" class="local-data-section">
          <h4>账号</h4>
          <a-table size="small" :data-source="preview.accounts" :row-key="(_: unknown, index: number) => index" :pagination="{ pageSize: 5, showSizeChanger: false }">
            <a-table-column title="账号" key="name" data-index="name" />
            <a-table-column title="类型" key="kind"><template #default="{ record }">{{ accountKind(record.kind) }}</template></a-table-column>
            <a-table-column title="速度" key="defaultTier"><template #default="{ record }"><a-tag :color="record.defaultTier === 'fast' ? 'green' : undefined">{{ tierLabel(record.defaultTier) }}</a-tag></template></a-table-column>
            <a-table-column title="处理" key="action"><template #default="{ record }"><a-tag :color="record.action === 'add' ? 'green' : undefined">{{ record.action === 'add' ? '新增' : '重复，保留现有' }}</a-tag></template></a-table-column>
          </a-table>
        </section>
        <section v-if="preview.providers.length" class="local-data-section">
          <h4>供应商</h4>
          <a-table size="small" :data-source="preview.providers" :row-key="(_: unknown, index: number) => index" :pagination="{ pageSize: 5, showSizeChanger: false }">
            <a-table-column title="供应商" key="name"><template #default="{ record }"><strong>{{ record.name }}</strong><code class="local-data-path">{{ record.baseUrl }}</code></template></a-table-column>
            <a-table-column title="模型 / 密钥" key="contents"><template #default="{ record }">{{ record.models }} / {{ record.keys }}</template></a-table-column>
            <a-table-column title="处理" key="action"><template #default="{ record }"><a-tag :color="record.action === 'conflict' ? 'red' : record.action === 'add' ? 'green' : undefined">{{ providerAction(record.action) }}</a-tag></template></a-table-column>
          </a-table>
        </section>
        <a-alert v-if="expired" type="warning" message="此预览已过期，请返回重新预览。" />
        <a-alert v-else-if="!hasChanges && !preview.errors.length" type="info" message="所选数据均已存在，无需重复导入。" />
      </template>
      <a-alert v-if="error" type="error" :message="error" class="error-banner" />
    </div>
  </a-modal>
</template>

<style scoped>
.local-data-dialog{max-height:calc(100vh - 300px);overflow:auto}.local-data-actions{margin-top:0}.local-data-empty{padding:20px 0 10px}.local-data-sources{display:block;margin-top:18px}.local-data-source{padding:14px;border:1px solid var(--border,#e9eaf0);border-radius:8px;margin-bottom:10px}.local-data-path{display:block;margin-top:7px;font-size:12px;overflow-wrap:anywhere;color:var(--muted,#858897);white-space:normal}.local-data-count{font-size:12px;margin:10px 0 0}.local-data-source .ant-alert,.local-data-dialog>.ant-alert{margin-top:10px}.local-data-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0 14px}.local-data-summary div{display:flex;flex-direction:column;gap:5px;padding:12px;border:1px solid var(--border,#e9eaf0);border-radius:8px}.local-data-summary strong{font-size:22px}.local-data-summary span{font-size:12px;color:var(--muted,#858897)}.local-data-origin{font-size:12px;margin-bottom:14px}.local-data-origin summary{cursor:pointer}.local-data-section{margin-top:18px}.local-data-section h4{margin-bottom:8px}.local-data-section :deep(td){overflow-wrap:anywhere}@media(max-width:600px){.local-data-summary{grid-template-columns:repeat(2,1fr)}}
</style>
