<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import {useManager} from '../store'
import type {TempCredentialStore} from '../../../shared/tempLogin'
const props=defineProps<{disabled:boolean}>(),manager=useManager(),applicationId=ref(''),intercept=ref(true),actionError=ref('')
const credentialStore=ref<TempCredentialStore>('file')
const login=computed(()=>manager.data?.tempLogin),cleanup=computed(()=>manager.data?.tempLoginCleanup)
const applications=computed(()=>(manager.data?.instanceApplications??[]).filter(app=>app.kind!=='cli'&&app.supportsTempLogin===true))
const labels={'idle':'准备登录','preparing':'正在准备临时客户端','launching':'正在打开临时客户端','waiting-login':'等待你在临时客户端中登录','importing':'正在读取并保存账号','closing':'正在关闭临时客户端','cleaning':'正在清理临时文件','completed':'登录成功','cancelled':'登录已取消','failed':'登录未完成'}
watch(applications,value=>{if(!value.some(app=>app.id===applicationId.value))applicationId.value=value[0]?.id??''},{immediate:true})
async function choose(){actionError.value='';const old=new Set(applications.value.map(app=>app.id));if(await manager.execute(()=>window.manager.chooseInstanceApplication())){const selected=applications.value.find(app=>!old.has(app.id));if(selected)applicationId.value=selected.id;else if(!applications.value.length)actionError.value='请选择安装的 Codex 桌面应用，或使用浏览器授权登录。'}}
async function start(){actionError.value='';await manager.execute(()=>window.manager.startTempLogin({applicationId:applicationId.value,interceptAuthUrl:intercept.value,credentialStore:credentialStore.value}))}
async function cancel(){if(login.value?.id)await manager.execute(()=>window.manager.cancelTempLogin(login.value!.id!))}
async function retryCleanup(){await manager.execute(()=>window.manager.cleanupTempLogin())}
async function url(action:'open'|'copy'){try{actionError.value='';if(login.value?.id)await(action==='open'?window.manager.openTempLoginURL(login.value.id):window.manager.copyTempLoginURL(login.value.id))}catch(cause){actionError.value=String(cause)}}
</script>
<template>
  <div class="temp-login-panel">
    <h3>使用官方客户端登录</h3>
    <p class="muted">打开一个空白临时 Codex 客户端。完成登录后自动保存账号、关闭该客户端并清理临时文件；你的现有客户端继续运行。</p>
    <a-alert v-if="login?.error||actionError" type="error" :message="actionError||login?.error" class="error-banner" />
    <a-alert v-if="login?.notice" type="info" :message="login.notice" class="error-banner" />
    <a-alert v-if="login?.phase==='completed'" type="success" :message="login.updated?'登录成功，已有账号的凭据已更新。':'登录成功，账号已保存。'" class="error-banner" />
    <div v-if="login?.running" class="temp-login-progress">
      <p><a-spin size="small" /> <strong>{{labels[login.phase]}}</strong></p>
      <p v-if="login.expiresAt" class="muted">等待登录至 {{new Date(login.expiresAt).toLocaleTimeString()}}</p>
      <p v-if="login.credentialStore!=='file'" class="muted">登录完成后读取一次临时系统凭据，系统可能请求授权。</p>
      <template v-if="login.authUrl"><p class="muted">官方生成的本次授权链接</p><a-textarea :value="login.authUrl" readonly :auto-size="{minRows:2,maxRows:4}" /><a-space style="margin-top:12px"><a-button @click="url('copy')">复制授权链接</a-button><a-button type="primary" @click="url('open')">打开授权页面</a-button></a-space></template>
      <p v-else-if="login.authStatus==='armed'" class="muted">请在临时客户端点击继续登录，授权链接将显示在这里。</p>
      <a-button style="margin-top:12px" :loading="manager.loading" @click="cancel">取消并清理</a-button>
    </div>
    <template v-else>
      <a-alert v-if="!applications.length" type="info" message="未检测到支持此登录方式的 Codex 桌面应用。请安装 Codex 或手动选择 Codex.app，也可以使用浏览器授权登录。" class="error-banner" />
      <a-space class="temp-login-select"><a-select v-model:value="applicationId" placeholder="选择 Codex 桌面应用" :disabled="disabled||manager.loading" :options="applications.map(app=>({value:app.id,label:app.name+' · '+app.path}))" style="width:360px;max-width:100%" /><a-button :disabled="disabled||manager.loading" @click="choose">选择 Codex.app</a-button></a-space>
      <div class="temp-login-storage"><span>临时凭据存储</span><a-select v-model:value="credentialStore" :disabled="disabled||manager.loading" :options="[{value:'file',label:'文件（默认）'},{value:'keyring',label:'系统钥匙串'},{value:'auto',label:'自动（系统优先）'}]" style="width:220px" /></div>
      <p v-if="credentialStore!=='file'" class="muted">仅使用本次临时客户端的独立条目。读取时可能请求系统授权，结束后清理该条目。</p>
      <p><a-checkbox v-model:checked="intercept" :disabled="disabled||manager.loading">在此显示官方授权链接，方便复制到其他浏览器</a-checkbox></p>
      <a-space><a-button :disabled="disabled||!applicationId" :loading="manager.loading" @click="start">启动临时登录</a-button><span v-if="login?.phase==='cancelled'" class="muted">本次登录已取消</span></a-space>
    </template>
    <div class="temp-login-cleanup"><a-button size="small" :disabled="login?.running||manager.loading" @click="retryCleanup">重试清理临时文件</a-button><span v-if="cleanup?.failed.length" class="muted">{{cleanup.failed.length}} 项尚未清理</span></div>
    <a-alert v-for="failure in cleanup?.failed??[]" :key="failure.id" type="info" :message="failure.error" class="error-banner" />
  </div>
</template>
<style scoped>
.temp-login-panel{border-top:1px solid var(--border-color,#ddd);margin-top:22px;padding-top:12px}.temp-login-panel>.muted{line-height:1.7}.temp-login-select{display:flex;flex-wrap:wrap}.temp-login-cleanup,.temp-login-storage{display:flex;align-items:center;gap:10px;margin-top:16px}.temp-login-progress p{line-height:1.7}
</style>
