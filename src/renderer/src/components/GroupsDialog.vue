<script setup lang="ts">
import { computed, ref } from 'vue'
import { Modal, message } from 'ant-design-vue'
import type { AccountGroup } from '../../../shared/types'
import { useManager } from '../store'
defineProps<{ open: boolean; selected: string[] }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const manager = useManager()
const groups = computed(() => manager.data?.groups ?? [])
const editing = ref<string>(), name = ref(''), minutes = ref<number | null>(null)
const policy = ref('inherit')
const target = ref<string>(), operation = ref<'add' | 'remove' | 'move'>('add')
function edit(group?: AccountGroup) {
  editing.value = group?.id; name.value = group?.name ?? ''; minutes.value = group?.quotaAutoRefreshMinutes ?? null
  policy.value = minutes.value === null ? 'inherit' : minutes.value === -1 ? 'off' : 'custom'
}
async function save() {
  const interval = policy.value === 'inherit' ? null : policy.value === 'off' ? -1 : minutes.value
  if (policy.value === 'custom' && (!interval || interval < 1)) { message.error('请输入 1–999 分钟'); return }
  if (await manager.execute(() => window.manager.saveGroup({ id: editing.value, group: { name: name.value, quotaAutoRefreshMinutes: interval } }))) { edit(); message.success('分组已保存') }
}
function remove(group: AccountGroup) {
  Modal.confirm({ title: `删除分组「${group.name}」？`, content: '账号会保留，分组的刷新策略将不再应用。', okText: '删除分组', cancelText: '取消',
    onOk: async () => { if (await manager.execute(() => window.manager.deleteGroup(group.id)) && editing.value === group.id) edit() }
  })
}
async function reorder(index: number, step: number) {
  const ids = groups.value.map(g => g.id), swap = index + step
  ;[ids[index], ids[swap]] = [ids[swap], ids[index]]
  await manager.execute(() => window.manager.reorderGroups(ids))
}
async function apply(ids: string[]) {
  if (!target.value) return
  if (await manager.execute(() => window.manager.groupMembers({ id: target.value!, ids: [...ids], mode: operation.value }))) message.success('账号分组已更新')
}
</script>

<template>
  <a-drawer :open="open" title="账号分组" :width="560" @close="emit('update:open', false)">
    <p class="muted">分组可以设置独立的用量刷新间隔。账号属于多个组时，自动刷新使用排在前面的分组策略；全量刷新会跳过任一“不刷新”分组中的账号。</p>
    <div v-for="(group, index) in groups" :key="group.id" class="group-row">
      <div><strong>{{ group.name }}</strong><p class="muted">{{ group.accountIds.length }} 个账号 · {{ group.quotaAutoRefreshMinutes === null ? '继承全局' : group.quotaAutoRefreshMinutes === -1 ? '不自动 / 全量刷新' : `${group.quotaAutoRefreshMinutes} 分钟刷新` }}</p></div>
      <a-space :size="2"><a-button size="small" :disabled="index === 0" aria-label="上移分组" @click="reorder(index, -1)">↑</a-button><a-button size="small" :disabled="index === groups.length - 1" aria-label="下移分组" @click="reorder(index, 1)">↓</a-button><a-button size="small" type="link" @click="edit(group)">编辑</a-button><a-button size="small" type="text" danger @click="remove(group)">删除</a-button></a-space>
    </div>
    <a-empty v-if="!groups.length" description="还没有分组" :image-style="{ height: '50px' }" />
    <a-divider>{{ editing ? '编辑分组' : '新建分组' }}</a-divider>
    <a-form layout="vertical" @finish="save">
      <a-form-item label="分组名称"><a-input v-model:value="name" :maxlength="80" /></a-form-item>
      <a-form-item label="用量刷新"><a-select v-model:value="policy" :options="[{ label: '继承全局设置', value: 'inherit' }, { label: '不自动 / 全量刷新', value: 'off' }, { label: '自定义间隔', value: 'custom' }]" /></a-form-item>
      <a-form-item v-if="policy === 'custom'" label="间隔（分钟）"><a-input-number v-model:value="minutes" :min="1" :max="999" /></a-form-item>
      <a-space><a-button type="primary" html-type="submit" :disabled="!name.trim()" :loading="manager.loading">保存分组</a-button><a-button v-if="editing" @click="edit()">取消编辑</a-button></a-space>
    </a-form>
    <template v-if="selected.length">
      <a-divider>调整所选 {{ selected.length }} 个账号</a-divider>
      <a-space direction="vertical" style="width: 100%">
        <a-select v-model:value="target" placeholder="选择分组" style="width: 100%" :options="groups.map(g => ({ label: g.name, value: g.id }))" />
        <a-radio-group v-model:value="operation" :options="[{ label: '加入分组', value: 'add' }, { label: '从该组移除', value: 'remove' }, { label: '移动到该组', value: 'move' }]" />
        <p v-if="operation === 'move'" class="muted">移动会清除所选账号在其他分组中的归属。</p>
        <a-button :disabled="!target" :loading="manager.loading" @click="apply(selected)">应用分组操作</a-button>
      </a-space>
    </template>
    <a-alert v-if="manager.error" type="error" :message="manager.error" style="margin-top: 16px" />
  </a-drawer>
</template>

<style scoped>
.group-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid #8882; }
.group-row strong { word-break: break-all; }
.group-row p { margin: 5px 0 0; font-size: 12px; }
</style>
