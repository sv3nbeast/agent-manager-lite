<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, CloudServerOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { SshServerInput } from '../../../shared/ssh'
import { useManager } from '../store'

const manager = useManager()
const open = ref(false), syncOpen = ref(false), editing = ref<string>(), syncServerId = ref(''), syncAccountId = ref(''), error = ref(''), testing = ref(''), syncing = ref('')
const form = reactive<SshServerInput>({ name: '', host: '', port: 22, username: '', codexHome: '~/.codex', auth: { kind: 'agent' }, syncOnCodexSwitch: false })
const servers = computed(() => manager.data?.sshServers?.servers ?? [])
const accounts = computed(() => (manager.data?.accounts ?? []).filter(account => account.kind !== 'agent_identity'))
const selected = computed(() => manager.data?.sshServers?.selectedId ? servers.value.find(server => server.id === manager.data!.sshServers!.selectedId) : undefined)
const displayError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^(?:Error: )?Error invoking remote method 'manager:invoke': (?:Error: )?/, '')

function reset(server?: SshServerInput & { id?: string }) {
  editing.value = server?.id
  Object.assign(form, server ? structuredClone(server) : { name: '', host: '', port: 22, username: '', codexHome: '~/.codex', auth: { kind: 'agent' }, syncOnCodexSwitch: false })
  error.value = ''; open.value = true
}
async function save() {
  error.value = ''
  try {
    const input = { ...form, ...(editing.value ? { id: editing.value } : {}), auth: form.auth.kind === 'agent' ? { kind: 'agent' as const } : { kind: 'private_key_file' as const, path: form.auth.path }}
    if (await manager.execute(() => window.manager.saveSshServer(input))) { open.value = false; message.success('SSH 服务器已保存') }
  } catch (cause) { error.value = displayError(cause) }
}
function remove(id: string, name: string) {
  Modal.confirm({ title: `删除 SSH 服务器“${name}”？`, content: '只删除管理器中的加密配置，不会修改远端文件。', okText: '删除', okType: 'danger', cancelText: '取消', async onOk() { await manager.execute(() => window.manager.deleteSshServer(id)) } })
}
async function choose(id: string | undefined) { await manager.execute(() => window.manager.selectSshServer(id)) }
async function test(id: string) {
  testing.value = id; error.value = ''
  try { const result = await window.manager.testSshServer(id); message.success(result.message) } catch (cause) { error.value = displayError(cause) } finally { if (testing.value === id) testing.value = '' }
}
async function sync(id: string) {
  if (!accounts.value.length) { error.value = '请先添加可同步的 OAuth 或 Responses API 账号'; return }
  syncServerId.value = id; syncAccountId.value = accounts.value[0].id; error.value = ''; syncOpen.value = true
}
async function performSync() {
  const id = syncServerId.value, accountId = syncAccountId.value
  if (!id || !accountId) return
  syncing.value = id; error.value = ''
  try { const result = await window.manager.syncSshAccount({ serverId: id, accountId }); await manager.refresh(); syncOpen.value = false; message.success(`已同步到 ${result.serverName}`) } catch (cause) { error.value = displayError(cause) } finally { if (syncing.value === id) syncing.value = '' }
}
</script>

<template>
  <a-card title="SSH 远端 Codex" class="settings-card ssh-servers-panel">
    <template #extra><a-button type="primary" size="small" @click="reset()"><PlusOutlined />添加服务器</a-button></template>
    <p class="muted">配置保存在管理器加密 vault。连接使用系统 OpenSSH 的非交互模式；私钥只保存路径，不读取或上传私钥内容。</p>
    <a-alert v-if="error" type="error" show-icon :message="error" class="ssh-error" />
    <a-empty v-if="!servers.length" description="尚未配置远端服务器" />
    <div v-else class="ssh-server-list">
      <a-card v-for="server in servers" :key="server.id" size="small" class="ssh-server-card">
        <div class="ssh-server-heading"><div><CloudServerOutlined /><strong>{{ server.name }}</strong><a-tag v-if="selected?.id===server.id" color="purple">当前选择</a-tag></div><span class="muted">{{ server.username }}@{{ server.host }}:{{ server.port }}</span></div>
        <p class="muted ssh-server-path">CODEX_HOME：{{ server.codexHome }} · {{ server.auth.kind==='agent'?'SSH Agent':'指定私钥' }}</p>
        <a-alert v-if="server.lastSync" :type="server.lastSync.verified?'success':'error'" :message="server.lastSync.verified?`上次同步成功：${server.lastSync.accountEmail||server.lastSync.accountId}`:`上次同步失败：${server.lastSync.error||'未知错误'}`" />
        <a-space wrap>
          <a-button size="small" :type="selected?.id===server.id?'primary':undefined" @click="choose(selected?.id===server.id?undefined:server.id)">{{ selected?.id===server.id?'取消选择':'选择' }}</a-button>
          <a-button size="small" :loading="testing===server.id" @click="test(server.id)">测试连接</a-button>
          <a-button size="small" :loading="syncing===server.id" :disabled="!accounts.length" @click="sync(server.id)">同步账号</a-button>
          <a-button size="small" @click="reset(server)">编辑</a-button>
          <a-button size="small" danger type="text" @click="remove(server.id,server.name)"><DeleteOutlined />删除</a-button>
        </a-space>
      </a-card>
    </div>
    <a-modal v-model:open="open" :title="editing?'编辑 SSH 服务器':'添加 SSH 服务器'" ok-text="保存" cancel-text="取消" :confirm-loading="manager.loading" @ok="save">
      <a-form layout="vertical">
        <a-form-item label="名称"><a-input v-model:value="form.name" maxlength="120" /></a-form-item>
        <a-space class="ssh-form-row" align="start"><a-form-item label="主机" class="ssh-host"><a-input v-model:value="form.host" placeholder="example.com" /></a-form-item><a-form-item label="端口"><a-input-number v-model:value="form.port" :min="1" :max="65535" /></a-form-item></a-space>
        <a-form-item label="用户名"><a-input v-model:value="form.username" placeholder="root" /></a-form-item>
        <a-form-item label="远端 Codex 目录" extra="只接受绝对路径或 ~/ 路径，例如 ~/.codex"><a-input v-model:value="form.codexHome" /></a-form-item>
        <a-form-item label="认证方式"><a-radio-group v-model:value="form.auth.kind" :options="[{label:'SSH Agent',value:'agent'},{label:'指定私钥文件',value:'private_key_file'}]" /></a-form-item>
        <a-form-item v-if="form.auth.kind==='private_key_file'" label="私钥路径"><a-input v-model:value="form.auth.path" placeholder="~/.ssh/id_ed25519" autocomplete="off" /></a-form-item>
        <a-form-item><a-checkbox v-model:checked="form.syncOnCodexSwitch">切换账号后自动同步（默认关闭）</a-checkbox></a-form-item>
      </a-form>
    </a-modal>
    <a-modal v-model:open="syncOpen" title="同步账号到远端 Codex" ok-text="继续同步" cancel-text="取消" :confirm-loading="!!syncing" @ok="performSync">
      <p>将选定账号的 <code>auth.json</code> 通过非交互 SSH 传输到远端 CODEX_HOME，并在远端校验 SHA-256。请确认远端客户端已关闭或允许重新读取凭据。</p>
      <a-form-item label="账号"><a-select v-model:value="syncAccountId" :options="accounts.map(account=>({value:account.id,label:account.name+(account.email?' · '+account.email:'')}))" /></a-form-item>
    </a-modal>
  </a-card>
</template>

<style scoped>
.ssh-servers-panel{margin-top:18px}.ssh-error{margin:12px 0}.ssh-server-list{display:grid;gap:12px}.ssh-server-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.ssh-server-heading>div{display:flex;align-items:center;gap:8px}.ssh-server-heading strong{font-size:15px}.ssh-server-path{overflow-wrap:anywhere}.ssh-form-row{display:flex;width:100%}.ssh-form-row .ssh-host{flex:1}.ssh-form-row :deep(.ant-form-item){margin-bottom:0}
</style>
