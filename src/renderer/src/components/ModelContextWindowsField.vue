<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatModelContextWindow, getModelContextWindow, modelContextChoice, modelContextWindowPresets, setModelContextWindow, type ModelContextChoice, type ModelContextDefault } from '../../../shared/modelContextWindows'

const props = defineProps<{ modelValue?: Record<string, number>; models: string[]; inheritedWindows?: Record<string, number>; active?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, number> | undefined] }>()
const custom = ref<string[]>([])
const bulkOptions = computed(() => [{ label: props.inheritedWindows ? '未设置 · 继承供应商或模型默认值' : '未设置 · 使用各模型默认值', value: 'default' }, ...modelContextWindowPresets])
const defaults = ref<Record<string, ModelContextDefault>>({}), defaultsLoading = ref(false), defaultsError = ref(false)
let defaultsRequest = 0
watch(() => [props.active !== false, ...props.models] as const, async () => {
  const request = ++defaultsRequest
  defaults.value = {}; defaultsLoading.value = false; defaultsError.value = false
  if (props.active === false || !props.models.length) return
  defaultsLoading.value = true
  try {
    const values = await window.manager.readModelContextDefaults([...props.models])
    if (request !== defaultsRequest) return
    defaults.value = Object.fromEntries(values.map(value => [value.modelId, value]))
  } catch {
    if (request === defaultsRequest) defaultsError.value = true
  } finally { if (request === defaultsRequest) defaultsLoading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { defaultsRequest++ })
function optionsFor(model: string) {
  const inherited = getModelContextWindow(props.inheritedWindows, model)
  const value = Object.hasOwn(defaults.value, model) ? defaults.value[model] : undefined
  const label = inherited !== undefined ? `未设置 · 使用供应商默认值 ${formatModelContextWindow(inherited)}`
    : value ? `未设置 · 使用默认值 ${formatModelContextWindow(value.contextWindow)}${value.source === 'template' ? '（模板）' : ''}`
    : defaultsLoading.value ? '未设置 · 正在读取默认值…' : '未设置 · 默认值暂不可用'
  return [{ label, value: 'default' }, ...modelContextWindowPresets, { label: '自定义', value: 'custom' }]
}
const bulk = ref<ModelContextChoice>('default')
const extraModels = computed(() => Object.keys(props.modelValue ?? {}).filter(model => !props.models.includes(model)))
function choice(model: string): ModelContextChoice {
  return custom.value.includes(model) ? 'custom' : modelContextChoice(getModelContextWindow(props.modelValue, model))
}
function select(model: string, value: ModelContextChoice) {
  custom.value = custom.value.filter(item => item !== model)
  if (value === 'custom') { custom.value.push(model); return }
  emit('update:modelValue', setModelContextWindow(props.modelValue, [model], value === 'default' ? undefined : value))
}
function input(model: string, value: number | null) {
  if (value === null || (Number.isInteger(value) && value >= 2 && value <= 10_000_000)) emit('update:modelValue', setModelContextWindow(props.modelValue, [model], value ?? undefined))
}
function applyAll() {
  if (bulk.value === 'custom') return
  custom.value = custom.value.filter(model => !props.models.includes(model))
  emit('update:modelValue', setModelContextWindow(props.modelValue, props.models, bulk.value === 'default' ? undefined : bulk.value))
}
function clearAll() { custom.value=[]; emit('update:modelValue', undefined) }
</script>

<template>
  <section class="context-window-field">
    <div v-if="models.length" class="context-window-bulk">
      <a-select v-model:value="bulk" :options="bulkOptions" aria-label="批量上下文窗口" />
      <a-button @click="applyAll">应用到当前模型</a-button>
    </div>
    <div v-for="model in models" :key="model" class="context-window-row">
      <span :title="model">{{ model }}</span>
      <div class="context-window-value">
        <a-select :value="choice(model)" :options="optionsFor(model)" :aria-label="`上下文窗口 · ${model}`" @change="select(model, $event as ModelContextChoice)" />
        <a-input-number v-if="choice(model) === 'custom'" :value="getModelContextWindow(modelValue, model)" :min="2" :max="10000000" :precision="0" :aria-label="`自定义上下文窗口 · ${model}`" placeholder="tokens" @change="input(model, $event as number | null)" />
      </div>
    </div>
    <p class="muted">{{ inheritedWindows ? '未设置时优先继承供应商配置，其余模型使用 Codex 内置目录默认值。' : '未设置时显示 Codex 内置目录默认值。' }}未知模型使用模板值，不代表上游支持该窗口。配置值以十进制 tokens 计算，例如 1M = 1,000,000。</p>
    <p v-if="defaultsError" class="muted">默认值读取失败，可重新打开编辑窗口。已有配置不受影响。</p>
    <p v-if="extraModels.length" class="muted">已保留 {{ extraModels.length }} 个未在当前模型列表中的配置。</p>
    <a-button v-if="Object.keys(modelValue ?? {}).length" size="small" class="context-window-clear" @click="clearAll">清空所有配置</a-button>
    <p v-if="!models.length" class="muted">先选择模型，再设置上下文窗口。</p>
  </section>
</template>

<style scoped>
.context-window-field{display:grid;gap:10px}.context-window-bulk{display:flex;gap:8px;margin-bottom:4px}.context-window-bulk .ant-select{flex:1}.context-window-row{display:grid;grid-template-columns:minmax(100px,1fr) minmax(225px,1.5fr);align-items:start;gap:12px}.context-window-row>span{padding-top:6px;font-size:12px;overflow-wrap:anywhere}.context-window-value{display:grid;gap:6px}.context-window-value .ant-input-number{width:100%}.context-window-clear{justify-self:start}.context-window-field p{margin:0;font-size:11px;line-height:1.7}
</style>
