import {ProxyResources} from './proxyResources'
import {ProxyCatalog} from './proxyCatalog'
import {ProxySubscriptions} from './proxySubscriptions'
import {CatalogError} from './proxyNative'
import {catalogErrors} from '../shared/proxyCatalog'
import {ProxyBatch} from './proxyBatch'
import {ProxyEngine} from './proxyEngine'
import {ProxyTunnels} from './proxyTunnels'
import {EngineError} from './proxyEngineFiles'
import {engineErrors} from '../shared/proxyEngine'
import { app, BrowserWindow, ipcMain, safeStorage, dialog, clipboard, shell, Tray, Menu, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { settingsSchema, accountInputSchema } from '../shared/types'
import { Store } from './store'
import { createAPIAccount, importIntoStore, parseAccountImport, saveOAuthAccount, editAccount, readAccountKey, batchTags, deleteAccounts, importParsedAccounts } from './accounts'
import { saveGroup, deleteGroup, reorderGroups, updateGroupMembers } from './groups'
import { AccountFiles } from './accountFiles'
import { LocalDataMigration } from './localDataMigration'
import {AccountRecycle} from './accountRecycle'
import { Gateway } from './gateway'
import { TokenAuthority } from './tokens'
import { OAuthLogin } from './oauth'
import {OfficialTempLogin} from './tempLogin'
import { QuotaService } from './quota'
import { AgentIdentityService, taskDecryptor } from './agentIdentity'
import { recoverAgentTasks } from './agentRecovery'
import { History } from './history'
import { ClientConfigs } from './clientConfig'
import {ClientIdentities} from './clientIdentity'
import {ClientAuthority} from './clientAuthority'
import {ClientSwitches} from './clientSwitch'
import {NativeInstanceAccounts} from './nativeInstanceAccounts'
import { historyFilterSchema, historyQuerySchema } from '../shared/history'
import { mutateProvider, readProviderKey } from './providerLibrary'
import {readModelContextDefaults} from './modelContextDefaults'
import {readInstanceModelDefaults} from './instanceModelDefaults'
import { ProviderProbes } from './providerProbe'
import { ProviderModels } from './providerModels'
import {ProviderUsageQueries} from './providerUsageRefresh'
import { Instances } from './instances'
import {ExternalInstanceSources} from './externalInstanceSources'
import { LocalAccess } from './localAccess'
import {SessionCatalog} from './sessions'
import {SessionTransfers} from './sessionTransfers'
import {SessionArchives} from './sessionArchives'
import {SessionSync} from './sessionSync'
import {SessionTrash} from './sessionTrash'
import {SessionVisibilityRepair} from './sessionVisibility'
import {sessionSelectionSchema} from '../shared/sessions'
import {AccountNetwork} from './accountNetwork'
import {AccountProxies} from './accountProxy'
import {UpstreamProxies} from './upstreamProxy'
import {effectiveKeyUsage} from './dataBackupState'
import {DataBackups} from './dataBackups'
import {backupRequestSchema} from '../shared/dataBackup'
import { WakeupScheduler } from './wakeupScheduler'
import { applyLaunchAtLogin } from './loginItem'
import { shouldHideOnClose } from './trayPolicy'
import { SshServers } from './ssh'

const development = !app.isPackaged
const isolatedTest = Boolean(process.env.CML_TEST_DATA_DIR && (development || process.argv.includes('--cml-smoke-test')))
const productName = 'Agent Manager Lite'
// Keep the storage identity from the original releases. Electron uses this
// name for macOS Keychain "Safe Storage" and Linux password-store addressing;
// changing it with the display brand would prevent opening existing vaults.
app.setName(isolatedTest ? 'Codex Manager Lite Test' : 'Codex Manager Lite')
// The existing vault, history, instance paths and single-instance lock stay in
// the same directory. Display-brand changes are not a data migration.
app.setPath('userData', isolatedTest ? resolve(process.env.CML_TEST_DATA_DIR!) : development ? resolve('.local/development') : join(app.getPath('appData'), 'codex-manager-lite'))
const ownsLock = app.requestSingleInstanceLock()
if (!ownsLock) app.quit()
let explicitQuit = false
let keepAliveInTray = false

async function main(): Promise<void> {
  const proxyEngine=new ProxyEngine(app.getPath('userData'))
  const store = new Store(app.getPath('userData'), {
    encrypt: value => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('系统凭据存储不可用，请解锁系统钥匙串后重试')
      return safeStorage.encryptString(value)
    },
    decrypt: value => safeStorage.decryptString(value)
  })
  const sshServers = new SshServers(store)
  keepAliveInTray = store.read().settings.closeToTray
  // Keep the OS login-item state aligned with the persisted preference. A
  // failure here must not make an existing vault unusable; saving the setting
  // below still reports a concrete error when the user changes it.
  try { if (!isolatedTest) applyLaunchAtLogin(app, store.read().settings.launchAtLogin) } catch (error) { console.error('无法同步开机启动设置', error) }
  const binaryRoot = app.isPackaged ? process.resourcesPath : resolve('resources')
  const history = new History(app.getPath('userData'))
  const accountFiles = new AccountFiles(store)
  const localDataMigration = new LocalDataMigration(store)
  let instances:Instances
  let sessionTransfers:SessionTransfers
  let sessionArchives:SessionArchives
  let sessionSync:SessionSync
  let sessionTrash:SessionTrash
  let clientSwitches:ClientSwitches
  let dataBackups:DataBackups
  const maintenance=()=>!!dataBackups&&(dataBackups.applying||dataBackups.restartRequired)
  const commands=new Map<symbol,string>()
  // Closing the manager window must not stop a client instance that is still
  // serving the user. The optional tray preference remains useful when there
  // are no instances, while an active instance implicitly keeps the manager
  // resident so its local gateway remains supervised.
  // A recovered process or a process with a failed gateway is displayed as
  // "error", but still owns a client and recovery journal. Do not infer
  // process lifetime from the presentation status or treat it as stopped.
  const hasActiveInstances = () => instances?.views().some(value =>
    instances.inUse(value.id, false)) === true
  const clientConfigs = new ClientConfigs(store,Date.now,id=>(instances?.inUse(id) ?? false)||(clientSwitches?.usesTarget(id) ?? false))
  const clientIdentities = new ClientIdentities(store,clientConfigs)
  const runId = randomUUID()
  let historyExport: AbortController | undefined
  let exportTask: Promise<number> | undefined
  const binary = join(binaryRoot, 'bin', process.platform === 'win32' ? 'codex-proxy.exe' : 'codex-proxy')
  const proxyTunnels=new ProxyTunnels(binary,join(app.getPath('userData'),'proxy-tunnels'),()=>proxyEngine.preflight())
  const accountNetwork=new AccountNetwork(binary,()=>store.proxyState(),proxyTunnels)
  const runtimeRoot = join(app.getPath('userData'), 'runtime')
  const providerUsageQueries=new ProviderUsageQueries(store,accountNetwork.request)
  const providerModels = new ProviderModels(store,20_000,accountNetwork.fetchUpstream)
  const providerProbes = new ProviderProbes(store,binary,join(app.getPath('userData'),'provider-probes'),undefined,accountNetwork.fetchUpstream,()=>store.proxyState(),proxyTunnels)
  const gateway: Gateway = new Gateway(binary, runtimeRoot, event => history.record(runId, event),
    (id, identity, expectedTask,generation) => agents.adopt(id, identity, expectedTask,generation),()=>store.proxyState(),proxyTunnels)
  const projectRouting = (account:import('./store').StoredAccount) => {
    let failure:unknown
    for(const target of [gateway,instances])try{target?.updateRoutingAccount(account)}catch(error){failure=error}
    if(failure)throw failure
  }
  const projectCredentials = async (account:import('./store').StoredAccount) => {await Promise.all([gateway.updateCredentials(account),instances?.updateCredentials(account)]);projectRouting(account)}
  const agents: AgentIdentityService = new AgentIdentityService(store, taskDecryptor(binary), accountNetwork.request, projectCredentials)
  let credentialRecovery = recoverAgentTasks(runtimeRoot, store, agents)
  const tokens = new TokenAuthority(store, accountNetwork.request, projectCredentials)
  const clientAuthority=new ClientAuthority(store,clientConfigs,clientIdentities,tokens,projectCredentials,id=>instances?.inUse(id)??false)
  const nativeAccounts=new NativeInstanceAccounts(store,tokens,(id,targetId)=>instances.usesNativeAccountOutside(id,targetId)||clientAuthority.busy(id),projectCredentials)
  instances=new Instances(store,()=>{
    const instanceRunId=randomUUID()
    return new Gateway(binary,runtimeRoot,event=>history.record(instanceRunId,event),(id,identity,expected,generation)=>agents.adopt(id,identity,expected,generation),()=>store.proxyState(),proxyTunnels)
  },async id=>{let account=await tokens.ensure(id);if(account.kind==='agent_identity')account=await agents.ensure(id);return account},undefined,nativeAccounts,Date.now,id=>(sessionTransfers?.busy(id)??false)||(sessionArchives?.busy(id)??false)||(sessionSync?.busy(id)??false)||(sessionTrash?.busy(id)??false),app.getPreferredSystemLanguages())
  const externalInstanceSources=new ExternalInstanceSources({managerRoot:realpathSync(store.directory),managedDirectories:()=>instances.views().map(instance=>instance.directory),...(isolatedTest?{home:join(realpathSync(store.directory),'external-source-home')}:{})})
  const localAccess=new LocalAccess(store,gateway,async id=>{let account=await tokens.ensure(id);if(account.kind==='agent_identity')account=await agents.ensure(id);return account},ids=>effectiveKeyUsage(store.read(),history.keyTokenUsage(ids)))
  const sessions=new SessionCatalog(store,id=>instances.inUse(id))
  sessionTransfers=new SessionTransfers(store,sessions,()=>instances.applications(),id=>instances.inUse(id,false)||!!clientSwitches?.usesTarget(id)||!!sessionArchives?.busy(id)||!!sessionSync?.busy(id)||!!sessionTrash?.busy(id))
  sessionArchives=new SessionArchives(store,sessions,sessionTransfers,Date.now,id=>(sessionSync?.busy(id)??false)||(sessionTrash?.busy(id)??false))
  sessionSync=new SessionSync(store,sessionTransfers,()=>instances.applications(),id=>instances.inUse(id,false)||!!clientSwitches?.usesTarget(id)||!!sessionArchives?.busy(id)||!!sessionTrash?.busy(id))
  sessionTrash=new SessionTrash(store,sessions,sessionTransfers,()=>instances.applications(),id=>instances.inUse(id,false)||!!clientSwitches?.usesTarget(id)||!!sessionArchives?.busy(id)||!!sessionSync?.busy(id))
  clientSwitches=new ClientSwitches(store,clientConfigs,tokens,id=>localAccess.usesAccount(id)||instances.usesAccount(id)||clientAuthority.busy(id),id=>instances.inUse(id))
  const sessionVisibility=new SessionVisibilityRepair(clientConfigs,id=>instances.inUse(id)||clientSwitches.usesTarget(id))
  sessionTrash.recover()
  await instances.recover()
  await sessionTransfers.recover()
  await sessionSync.recover()
  const quotas = new QuotaService(store, tokens, accountNetwork.request, agents,projectRouting,maintenance)
  const accountProxies=new AccountProxies(store,accountNetwork,id=>localAccess.usesAccount(id)||instances.usesAccount(id)||clientAuthority.usesAccount(id)||clientSwitches.usesAccount(id)||tokens.busy(id)||agents.busy(id)||quotas.busy()||providerUsageQueries.snapshot().running||providerProbes.snapshot().running||wakeups.usesAccount(id)||[...commands.values()].includes('fetchProviderModels'))
  const accountBusy=(id:string)=>localAccess.usesAccount(id)||instances.usesAccount(id)||clientAuthority.usesAccount(id)||clientSwitches.usesAccount(id)||tokens.busy(id)||agents.busy(id)||accountProxies.busy(id)||providerUsageQueries.snapshot().running||providerProbes.snapshot().running||[...commands.values()].includes('fetchProviderModels')
  const proxyResources=new ProxyResources(store,id=>accountBusy(id)||quotas.busy())
  const proxyBatch=new ProxyBatch(store,id=>accountBusy(id)||quotas.busy())
  const proxyCatalog=new ProxyCatalog(store,id=>accountBusy(id)||quotas.busy())
  const proxySubscriptions=new ProxySubscriptions(store,proxyCatalog,undefined,Date.now,maintenance)
  const wakeups = new WakeupScheduler(store, runId => new Gateway(binary, join(runtimeRoot, 'wakeup'), event => history.record(runId, event),
    (id, identity, expectedTask, generation) => agents.adopt(id, identity, expectedTask, generation), () => store.proxyState(), proxyTunnels),
    async id => { let account = await tokens.ensure(id); if (account.kind === 'agent_identity') account = await agents.ensure(id); return account })
  const accountBusyWithWakeups = (id:string) => accountBusy(id) || wakeups.usesAccount(id)
  // Proxy subscription refresh is a legacy compatibility capability. The
  // lightweight product has no subscription UI, so never start a background
  // network timer on launch; an explicitly invoked legacy IPC call may still
  // use the service for an existing vault.
  const accountRecycle=new AccountRecycle(store,Date.now,accountBusyWithWakeups)
  const login = new OAuthLogin({ request:accountNetwork.request, open: url => shell.openExternal(url), save: async value => {
    const account = saveOAuthAccount(store, value)
    await projectCredentials(account)
    quotas.schedule()
    return account.id
  } })
  const upstreamProxies=new UpstreamProxies(store,accountNetwork,()=>
    store.read().accounts.some(account=>accountBusyWithWakeups(account.id))||quotas.busy()||
    providerUsageQueries.snapshot().running||providerProbes.snapshot().running||['starting','waiting','exchanging'].includes(login.current().status)||
    [...commands.values()].some(command=>!['saveUpstreamProxy','load','probeUpstreamProxy','cancelUpstreamProxyProbe'].includes(command)))
  const tempLogin=new OfficialTempLogin(store,()=>instances.applications(),undefined,accountBusy,()=>quotas.schedule())
  tempLogin.scheduleCleanup()
  quotas.schedule()
  wakeups.start()
  const snapshot = () => ({ ...store.snapshot(),sshServers:sshServers.view(),wakeup:wakeups.view(),backupRestartRequired:dataBackups?.restartRequired??false,tempLogin:tempLogin.current(),tempLoginCleanup:tempLogin.cleanupStatus(),clientAuthorities:clientAuthority.views(),clientSwitches:clientSwitches.views(), localAccess:localAccess.view(),instances:instances.views(),instanceCopy:instances.copyView(),instanceApplications:instances.applications(),providerProbe:providerProbes.snapshot(),providerUsageRefresh:providerUsageQueries.snapshot(), gateway: gateway.current(), login: login.current(), quotaRefresh: quotas.current(), historyError: history.error, credentialRecovery })
  let exiting = false
  let tray: Tray | undefined
  let refreshTrayMenu: (() => void) | undefined
  dataBackups=new DataBackups(store,ids=>history.keyTokenUsage(ids),()=>{
    if(exiting)throw new Error('应用正在退出')
    if([...commands.values()].some(command=>!['restoreDataBackup','load','cancelDataBackup'].includes(command)))throw new Error('其他操作正在进行，请等待完成后重新恢复')
    const local=localAccess.view(),copy=instances.copyView(),sync=sessionSync.view(),transfer=sessionTransfers.view(),trash=sessionTrash.state()
    if(gateway.current().running||local.running||local.starting||local.singleStarting||instances.views().some(value=>instances.inUse(value.id))||copy&&['scanning','copying'].includes(copy.status)||wakeups.running())throw new Error('请先停止本地 API 和所有实例，并处理实例复制或待恢复事项')
    if(providerUsageQueries.snapshot().running||quotas.busy()||providerProbes.snapshot().running||tempLogin.current().running||['starting','waiting','exchanging'].includes(login.current().status)||store.read().accounts.some(a=>tokens.busy(a.id)||agents.busy(a.id)||clientAuthority.busy(a.id)||accountProxies.busy(a.id)))throw new Error('请先完成或取消登录、用量查询与凭据刷新')
    if(proxySubscriptions.list().some(job=>job.phase==='fetching'))throw new Error('请等待现有网络配置更新结束')
    if(sessionTransfers.active()||sessionTrash.active()||['preparing','running'].includes(sync.sync?.status??'')||['preparing','running'].includes(sessionArchives.view()?.status??'')||sync.recoveries.length||transfer.recoveries.length||trash.recoveries.length)throw new Error('请先完成会话操作并处理待恢复事项')
  })
  // Quota auto-refresh can be disabled independently; a running OAuth service
  // still needs fresh credentials. ensure() coalesces concurrent rotations.
  const credentialTimer = setInterval(() => {
    const status = gateway.current()
    if (exiting || maintenance()) return
    const ids=[...new Set([...(status.running?gateway.accountIds():[]),...instances.accountIds()])]
    for(const id of ids){const generation=store.read().accounts.find(account=>account.id===id)?.generation
      void Promise.resolve().then(() => { gateway.syncCredentials(); instances.syncCredentials(); return tokens.ensure(id) })
      .then(account => {const current=store.read().accounts.find(value=>value.id===id);if(current&&current.generation===account.generation)return projectCredentials(account)}).catch(() => {
      store.transaction(state => {
        const account = state.accounts.find(a => a.id === id)
        if (account&&account.generation===generation) { account.error = '本地服务登录状态更新失败，请刷新用量或重新登录'; account.errorAt = Date.now() }
      })
    })}
  }, 60_000)
  credentialTimer.unref()
  app.on('before-quit', event => {
    if (exiting) return
    // A normal window close, Cmd+Q, or window-all-closed can reach this hook
    // without the tray's explicit-quit marker. Keep the manager resident in
    // that case: the gateway sidecar intentionally monitors this process and
    // would otherwise terminate roughly two seconds after its parent exits.
    // The tray's "退出并停止运行实例" action sets explicitQuit and performs the
    // existing full cleanup path.
    if (!explicitQuit && hasActiveInstances()) {
      event.preventDefault()
      keepAliveInTray = true
      // Startup failure can request quit before the main window is created.
      // Preserving the owned instances must not itself throw in that case.
      for (const openWindow of BrowserWindow.getAllWindows()) openWindow.hide()
      return
    }
    explicitQuit = true
    event.preventDefault(); exiting = true
    clearInterval(credentialTimer)
    accountFiles.discard()
    sessions.stop()
    sessionVisibility.stop()
    clientIdentities.stop()
    clientSwitches.stop()
    externalInstanceSources.clear()
    proxyResources.stop()
    proxyBatch.stop()
    const subscriptionStop=proxySubscriptions.stop()
    proxyCatalog.stop()
    login.cancel()
    historyExport?.abort()
    Promise.allSettled([localDataMigration.stop(),dataBackups.stop(),providerModels.stop(),upstreamProxies.stop(),subscriptionStop,wakeups.stop(),proxyEngine.stop(),accountProxies.stop(),accountNetwork.stop(),tempLogin.stop(),quotas.stop(), tokens.stop(), clientAuthority.stop(), agents.stop(), localAccess.stop(), instances.closeAll(),providerProbes.stop(),providerUsageQueries.stop(), accountFiles.stop(), accountRecycle.stop(), sessionArchives.stop(), sessionTransfers.stop(), sessionSync.stop(), sessionTrash.stop(), exportTask]).finally(async () => {await proxyTunnels.stop();history.close();app.quit()})
  })
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.show(); window.focus() })
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: productName })
    // Preserve Electron's standard menu roles and shortcuts while separating
    // user-facing menu labels from the legacy encryption application name.
    const applicationMenu = Menu.buildFromTemplate([
      { role: 'appMenu', label: productName },
      { role: 'fileMenu' }, { role: 'editMenu' },
      { role: 'viewMenu' }, { role: 'windowMenu' }
    ])
    for (const item of applicationMenu.items[0].submenu?.items ?? []) {
      if (item.role === 'about') item.label = `关于 ${productName}`
      else if (item.role === 'hide') item.label = `隐藏 ${productName}`
      else if (item.role === 'quit') item.label = `退出 ${productName}`
    }
    Menu.setApplicationMenu(applicationMenu)
  }
  const appIconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icons/icon.png')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  const window = new BrowserWindow({ icon: appIconPath, width: 1240, height: 820, minWidth: 940, minHeight: 640,
    title: productName, backgroundColor: '#f5f6fa',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const trayIconPath = app.isPackaged ? join(process.resourcesPath, 'tray.png') : resolve('resources/tray.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  if (!icon.isEmpty()) {
    tray = new Tray(icon)
    tray.setToolTip(productName)
    const showWindow = () => { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
    tray.on('click', () => { if (window.isVisible()) window.hide(); else showWindow() })
    refreshTrayMenu = () => {
      tray?.setContextMenu(Menu.buildFromTemplate([
        { label: '显示主窗口', click: showWindow },
        { label: '有运行实例时关闭窗口会继续运行', enabled: false },
        { type: 'separator' },
        { label: `退出并停止运行实例`, click: () => { explicitQuit = true; app.quit() } }
      ]))
    }
    refreshTrayMenu()
  }
  window.on('close', event => {
    const hide = shouldHideOnClose({ closeToTray: store.read().settings.closeToTray, explicitQuit, activeInstances: hasActiveInstances() })
    // Recompute after the last instance stops. A previous automatic tray hide
    // must not leave a destroyed window resident when tray mode is disabled.
    keepAliveInTray = hide
    if (hide) {
      event.preventDefault()
      window.hide()
    }
  })
  const renderer = join(__dirname, '../renderer/index.html')
  const allowed = new URL(development && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(renderer).toString()).toString()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== allowed) event.preventDefault() })
  ipcMain.handle('manager:invoke', async (event, command: string, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== allowed.split('#')[0]) throw new Error('不允许的调用来源')
    if(exiting)throw new Error('应用正在退出')
    if(maintenance()&&!['load','cancelDataBackup','restartAfterBackup'].includes(command))throw new Error('配置恢复正在进行或等待重启，请完成后再操作')
    const invocation=Symbol(command);commands.set(invocation,command)
    try { return await (async()=>{ switch (command) {
      case 'exportDataBackup': {
        const inputValue=backupRequestSchema.parse(input)
        const chosen=await dialog.showSaveDialog(window,{title:'导出加密配置备份',defaultPath:`agent-manager-${new Date().toISOString().slice(0,10)}.cmlbackup`,filters:[{name:`${productName} 加密备份`,extensions:['cmlbackup']}]})
        if(chosen.canceled||!chosen.filePath)return
        if(exiting)throw new Error('应用正在退出')
        return await dataBackups.export(inputValue,chosen.filePath)
      }
      case 'previewDataBackup': {
        const inputValue=backupRequestSchema.parse(input)
        const chosen=await dialog.showOpenDialog(window,{title:'选择加密配置备份',properties:['openFile'],filters:[{name:`${productName} 加密备份`,extensions:['cmlbackup']}]})
        if(chosen.canceled||!chosen.filePaths[0])return
        if(exiting)throw new Error('应用正在退出')
        return await dataBackups.preview(inputValue,chosen.filePaths[0])
      }
      case 'restoreDataBackup':return await dataBackups.apply(input)
      case 'discardDataBackup':dataBackups.discard(z.string().uuid().parse(input));return
      case 'cancelDataBackup':dataBackups.cancel(z.string().uuid().parse(input));return
      case 'restartAfterBackup':
        z.undefined().parse(input)
        if(!dataBackups.restartRequired)throw new Error('当前没有等待重启的恢复操作')
        // Restore already requires every instance/service to be stopped.
        // This explicit maintenance restart must not become a tray hide.
        explicitQuit = true
        app.relaunch();app.quit();return
      case 'listSshServers': z.undefined().parse(input); return sshServers.view()
      case 'saveSshServer': sshServers.save(input); break
      case 'deleteSshServer': sshServers.remove(input); break
      case 'selectSshServer': sshServers.select(input); break
      case 'testSshServer': return await sshServers.test(input)
      case 'syncSshAccount': return await sshServers.sync(input)
      case 'startProxySubscription':return proxySubscriptions.begin(input)
      case 'proxySubscriptionJobs':z.undefined().parse(input);return proxySubscriptions.list()
      case 'cancelProxySubscription':proxySubscriptions.cancel(input);return
      case 'proxyStrategyCandidates':return proxyCatalog.strategyCandidates(input)
      case 'proxyStrategyEditor':return proxyCatalog.strategyEditor(input)
      case 'listProxyCatalogs': z.undefined().parse(input);return proxyCatalog.list()
      case 'reorderProxyCatalogs':return proxyCatalog.reorder(input)
      case 'proxyCatalogPage': return proxyCatalog.page(input)
      case 'resolveProxyCatalog': return proxyCatalog.resolve(input)
      case 'previewProxyCatalog': return proxyCatalog.preview(input)
      case 'applyProxyCatalog': proxyCatalog.apply(input);break
      case 'discardProxyCatalog': proxyCatalog.discard(input);return
      case 'proxyEngineStatus': z.undefined().parse(input);return proxyEngine.status()
      case 'downloadProxyEngine': z.undefined().parse(input);return proxyEngine.begin()
      case 'importProxyEngine': {
        z.undefined().parse(input)
        const selected=await dialog.showOpenDialog(window,{title:'选择指定版本的官方 Mihomo 压缩包',properties:['openFile'],filters:[{name:'Mihomo 安装包',extensions:['gz','zip']}]})
        if(selected.canceled||!selected.filePaths[0])return
        return proxyEngine.begin(selected.filePaths[0])
      }
      case 'cancelProxyEngine': proxyEngine.cancel(z.string().uuid().parse(input));return
      case 'checkProxyEngine': z.undefined().parse(input);await proxyEngine.preflight();return
      case 'previewProxyChange': return proxyResources.preview(input)
      case 'previewProxyImport': return proxyBatch.previewImport(input)
      case 'previewProxyAssignment': return proxyBatch.previewAssignment(input)
      case 'applyProxyBatch': proxyBatch.apply(input);break
      case 'discardProxyBatch': proxyBatch.discard(z.string().uuid().parse(input));return
      case 'applyProxyChange': proxyResources.apply(input);break
      case 'discardProxyChange': proxyResources.discard(z.string().uuid().parse(input));return
      case 'saveAccountProxy': accountProxies.save(input);break
      case 'saveUpstreamProxy': upstreamProxies.save(input);break
      case 'probeUpstreamProxy': return upstreamProxies.probe(input)
      case 'cancelUpstreamProxyProbe': await upstreamProxies.cancel(input);return
      case 'probeAccountProxy': return accountProxies.probe(input)
      case 'cancelAccountProxyProbe': await accountProxies.cancel(z.string().uuid().parse(input));return
      case 'load': if(!maintenance())await instances.refresh();return snapshot()
      case 'wakeupSetEnabled': wakeups.setEnabled(z.boolean().parse(input)); return snapshot()
      case 'wakeupSave': wakeups.save(input); return snapshot()
      case 'wakeupDelete': wakeups.delete(z.string().uuid().parse(input)); return snapshot()
      case 'wakeupRunNow': await wakeups.runNow(z.string().uuid().parse(input)); return snapshot()
      case 'wakeupCancel': wakeups.cancel(z.string().uuid().parse(input)); return snapshot()
      case 'scanSessions': return sessions.scan(input)
      case 'chooseLegacySessionTrash': {
        const selection=await dialog.showOpenDialog(window,{title:'选择 Cockpit 会话废纸篓、日期批次或条目目录',properties:['openDirectory']})
        return selection.canceled?undefined:sessionTrash.selectLegacy(selection.filePaths[0])
      }
      case 'legacySessionTrashPage': return sessionTrash.legacyPage(input)
      case 'previewLegacySessionTrash': return sessionTrash.previewLegacy(input)
      case 'discardLegacySessionTrash': await sessionTrash.discardLegacy();return
      case 'sessionTrashState': return sessionTrash.state()
      case 'listSessionTrash': return sessionTrash.list()
      case 'sessionTrashPage': return sessionTrash.page(input)
      case 'previewSessionTrash': return sessionTrash.previewTrash(input)
      case 'previewSessionTrashAction': return sessionTrash.previewAction(input)
      case 'startSessionTrash': sessionTrash.start(input);return sessionTrash.state()
      case 'discardSessionTrash': await sessionTrash.discard();return
      case 'cancelSessionTrash': await sessionTrash.cancel(z.string().uuid().parse(input));return sessionTrash.state()
      case 'recoverSessionTrash': await sessionTrash.recoverBatch(input);return sessionTrash.state()
      case 'openSessionTrashBackup': shell.showItemInFolder(sessionTrash.backupLocation(z.string().uuid().parse(input)));return
      case 'sessionSyncState': return sessionSync.view()
      case 'previewSessionSync': return sessionSync.preview(input)
      case 'startSessionSync': sessionSync.start(input);return sessionSync.view()
      case 'discardSessionSync': await sessionSync.discard();return
      case 'cancelSessionSync': await sessionSync.cancel(z.string().uuid().parse(input));return sessionSync.view()
      case 'retrySessionSync': await sessionSync.retry(input);return sessionSync.view()
      case 'openSessionSyncBackup': shell.showItemInFolder(sessionSync.backupLocation(z.string().uuid().parse(input)));return
      case 'sessionArchiveState': return sessionArchives.view()
      case 'previewSessionExport': return sessionArchives.previewExport(input)
      case 'discardSessionArchive': await sessionArchives.discardPreview();return
      case 'cancelSessionArchive': await sessionArchives.cancel(z.string().uuid().parse(input));return sessionArchives.view()
      case 'chooseSessionArchive': {
        const selection=await dialog.showOpenDialog(window,{title:'选择 Codex 会话 ZIP',properties:['openFile'],filters:[{name:'会话包',extensions:['zip']}]})
        return selection.canceled||!selection.filePaths[0]?undefined:sessionArchives.openPackage(selection.filePaths[0])
      }
      case 'startSessionExport': {
        const ticket=z.string().uuid().parse(input)
        const selection=await dialog.showSaveDialog(window,{title:'导出会话 ZIP（包含完整对话）',defaultPath:'codex-sessions.zip',filters:[{name:'会话包',extensions:['zip']}]})
        return selection.canceled||!selection.filePath?undefined:sessionArchives.startExport(ticket,selection.filePath)
      }
      case 'previewSessionImport': return sessionArchives.previewImport(input)
      case 'startSessionImport': return sessionArchives.startImport(input)
      case 'sessionTransferState': return sessionTransfers.view()
      case 'previewSessionCopy': return sessionTransfers.preview(input)
      case 'startSessionCopy': sessionTransfers.start(input);return sessionTransfers.view()
      case 'discardSessionCopy': sessionTransfers.discard();return
      case 'cancelSessionTransfer': await sessionTransfers.cancel(z.string().uuid().parse(input));return sessionTransfers.view()
      case 'retrySessionTransfer': await sessionTransfers.retry(input);return sessionTransfers.view()
      case 'openSessionTransferBackup': shell.showItemInFolder(sessionTransfers.backupLocation(z.string().uuid().parse(input)));return
      case 'listSessionVisibilityRepairInstances': z.undefined().parse(input);return sessionVisibility.instances()
      case 'listSessionVisibilityRepairProviders': z.undefined().parse(input);return sessionVisibility.providers()
      case 'previewSessionVisibilityRepair': return sessionVisibility.preview(input)
      case 'applySessionVisibilityRepair': return await sessionVisibility.apply(input)
      case 'discardSessionVisibilityRepair': sessionVisibility.discard(z.string().uuid().parse(input));return
      case 'cancelSessionVisibilityRepair': sessionVisibility.cancel(z.string().uuid().parse(input));return
      case 'sessionPage': return sessions.page(input)
      case 'sessionTokenStats': return sessions.tokenStats(input)
      case 'cancelSessionScan': sessions.cancel(z.string().uuid().parse(input));return
      case 'cancelSessionTokens': sessions.cancelTokens(z.string().uuid().parse(input));return
      case 'openSession': {
        const parsed=sessionSelectionSchema.extend({action:z.enum(['location','file','copyId'])}).strict().parse(input)
        const {action,...selection}=parsed,path=await sessions.location(selection)
        if(action==='copyId')clipboard.writeText(selection.sessionId)
        else if(action==='location')shell.showItemInFolder(path)
        else if(await shell.openPath(path))throw new Error('无法打开会话文件，请检查默认应用')
        return
      }
      case 'mutateLocalAccess': localAccess.mutate(input);break
      case 'startLocalAccess': localAccess.start();break
      case 'stopLocalAccess': await localAccess.stop();break
      case 'copyLocalAccessKey': clipboard.writeText(localAccess.key(z.string().uuid().parse(input)));return
      case 'mutateProvider': mutateProvider(store, input, id => localAccess.usesAccount(id) || instances.usesAccount(id) || clientAuthority.usesAccount(id) || clientSwitches.usesAccount(id)); quotas.schedule(); break
      case 'readProviderKey': return readProviderKey(store, input)
      case 'readModelContextDefaults': return readModelContextDefaults(input)
      case 'readInstanceModelDefaults': return readInstanceModelDefaults(input)
      case 'saveInstance': instances.save(input); break
      case 'copyInstance': instances.startCopy(input);break
      case 'copyExternalInstance': instances.startExternalCopy(input);break
      case 'discoverExternalInstanceSources': return externalInstanceSources.discover()
      case 'selectExternalInstanceSource': return externalInstanceSources.select(input,directory=>instances.selectCopySource(directory))
      case 'attachExistingInstance': await instances.attachExisting(input);break
      case 'chooseExistingInstanceDirectory': {
        const selection=await dialog.showOpenDialog(window,{title:'选择直接使用的 Codex 配置目录（不复制）',properties:['openDirectory']})
        if(!selection.canceled&&selection.filePaths[0])return instances.selectCopySource(selection.filePaths[0],'attach')
        return
      }
      case 'chooseInstanceCopySource': {
        const selection=await dialog.showOpenDialog(window,{title:'选择要复制的 Codex 配置目录（CODEX_HOME）',properties:['openDirectory']})
        if(!selection.canceled&&selection.filePaths[0])return instances.selectCopySource(selection.filePaths[0])
        return
      }
      case 'cancelInstanceCopy': await instances.cancelCopy(z.string().uuid().parse(input));break
      case 'removeInstance': instances.remove(input); break
      case 'previewInstanceLaunch': return instances.preview(input)
      case 'previewInstanceHistory': return instances.previewHistory(input)
      case 'startInstance': instances.start(z.string().uuid().parse(input)); break
      case 'stopInstance': await instances.stop(z.string().uuid().parse(input)); break
      case 'closeAllInstances': await instances.closeAll(); break
      case 'focusInstance': await instances.focus(z.string().uuid().parse(input)); return
      case 'chooseInstanceApplication': {
        const selection=await dialog.showOpenDialog(window,{title:'选择 Codex 或 ChatGPT 桌面应用',properties:['openFile'],filters:[{name:'macOS 应用',extensions:['app']}]})
        if(!selection.canceled && selection.filePaths[0])instances.registerApplication(selection.filePaths[0]);break
      }
      case 'chooseInstanceCli': {
        const selection=await dialog.showOpenDialog(window,{title:'选择原生 Codex CLI 可执行文件',properties:['openFile']})
        if(!selection.canceled&&selection.filePaths[0])instances.registerApplication(selection.filePaths[0],'cli');break
      }
      case 'chooseInstanceWorkingDirectory': {
        const selection=await dialog.showOpenDialog(window,{title:'选择 CLI 工作目录',properties:['openDirectory']})
        if(selection.canceled||!selection.filePaths[0])return
        return instances.registerWorkingDirectory(selection.filePaths[0])
      }
      case 'listInstanceWorkingDirectories': return instances.workingDirectories()
      case 'refreshProviderUsage': providerUsageQueries.start(input); break
      case 'cancelProviderUsage': providerUsageQueries.cancel(z.string().uuid().parse(input)); break
      case 'fetchProviderModels': return await providerModels.fetch(input)
      case 'cancelProviderModels': await providerModels.cancel(input); return
      case 'startProviderProbe': providerProbes.start(input); break
      case 'cancelProviderProbe': providerProbes.cancel(z.string().uuid().parse(input)); break
      case 'listClientConfigs': return clientConfigs.targets()
      case 'chooseClientConfig': {
        const selection = await dialog.showOpenDialog(window, { title: '选择 Codex 配置所在目录', properties: ['openDirectory'] })
        if (selection.canceled || !selection.filePaths[0]) return
        return clientConfigs.register(selection.filePaths[0])
      }
      case 'readClientConfig': return clientConfigs.view(z.string().uuid().parse(input))
      case 'readClientIdentity': return await clientIdentities.read(input)
      case 'importClientIdentity': return clientIdentities.import(z.string().uuid().parse(input))
      case 'cancelClientIdentity': clientIdentities.cancel(z.string().uuid().parse(input));return
      case 'previewClientSwitch': return clientSwitches.preview(input)
      case 'previewRestoreClientSwitch': return clientSwitches.previewRestore(input)
      case 'applyClientSwitch': return clientSwitches.applyWhenClosed(input)
      case 'discardClientSwitch': clientSwitches.discard(z.string().uuid().parse(input));return
      case 'listClientAuthorities': return clientAuthority.views()
      case 'bindClientAuthority': return await clientAuthority.bind(input)
      case 'syncClientAuthority': await clientAuthority.sync(z.string().uuid().parse(input));return clientAuthority.views()
      case 'releaseClientAuthority': return clientAuthority.release(input)
      case 'previewClientConfig': return clientConfigs.preview(input)
      case 'previewRestoreClientConfig': return clientConfigs.previewRestore(input)
      case 'applyClientConfig': return clientConfigs.apply(z.string().uuid().parse(input))
      case 'discardClientConfig': clientConfigs.discard(); return
      case 'readModelCatalog': return clientConfigs.catalogView(z.string().uuid().parse(input))
      case 'readClientProviders': return clientConfigs.providers(z.string().uuid().parse(input))
      case 'previewClientProvider': return clientConfigs.previewProvider(input)
      case 'previewModelCatalog': return clientConfigs.previewCatalog(input)
      case 'chooseModelCatalog': {
        const id = z.string().uuid().parse(input)
        const selection = await dialog.showOpenDialog(window, { title: '选择模型目录 JSON', properties: ['openFile'], filters: [{ name: '模型目录', extensions: ['json'] }] })
        if (selection.canceled || !selection.filePaths[0]) return
        return clientConfigs.importCatalog(id,selection.filePaths[0])
      }
      case 'recoverCredentials': credentialRecovery = recoverAgentTasks(runtimeRoot, store, agents, { activeDirectory: gateway.runtimeDirectory() }); break
      case 'queryHistory': return history.query(historyQuerySchema.parse(input))
      case 'cancelHistoryExport': historyExport?.abort(); return
      case 'exportHistory': {
        const filter = historyFilterSchema.parse(input)
        if (historyExport) throw new Error('已有导出进行中')
        const controller = new AbortController(); historyExport = controller
        try {
          const selection = await dialog.showSaveDialog(window, { title: '导出调用记录', defaultPath: 'codex-requests.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
          if (selection.canceled || !selection.filePath || controller.signal.aborted) return { count: 0, cancelled: true }
          exportTask = history.exportCSV(filter, selection.filePath, controller.signal)
          return { count: await exportTask, cancelled: false }
        } catch (error) {
          if (controller.signal.aborted) return { count: 0, cancelled: true }
          throw error
        } finally { historyExport = undefined; exportTask = undefined }
      }
      case 'saveSettings': {
        const next = settingsSchema.parse(input), previous = store.read().settings
        try {
          if (!isolatedTest) applyLaunchAtLogin(app, next.launchAtLogin)
        } catch (error) {
          throw new Error('无法更新开机启动设置')
        }
        try { store.transaction(state => { state.settings = next }) } catch (error) {
          try { if (!isolatedTest) applyLaunchAtLogin(app, previous.launchAtLogin) } catch {}
          throw error
        }
        keepAliveInTray = next.closeToTray || hasActiveInstances()
        refreshTrayMenu?.()
        quotas.schedule(); break
      }
      case 'addAccount': {
        const result = importParsedAccounts(store, [createAPIAccount(accountInputSchema.parse(input))])
        if (!result.added) throw new Error('此接口和凭据的账号已存在')
        break
      }
      case 'readAccountKey': return readAccountKey(store, input)
      case 'editAccount': editAccount(store, input, id => localAccess.usesAccount(id) || instances.usesAccount(id) || clientAuthority.usesAccount(id) || clientSwitches.usesAccount(id)); quotas.schedule(); break
      case 'batchTags': batchTags(store, input); break
      case 'saveGroup': saveGroup(store, input); quotas.schedule(); break
      case 'deleteGroup': deleteGroup(store, z.string().uuid().parse(input)); quotas.schedule(); break
      case 'reorderGroups': reorderGroups(store, input); quotas.schedule(); break
      case 'groupMembers': updateGroupMembers(store, input); quotas.schedule(); break
      case 'deleteAccounts': deleteAccounts(store, input,accountBusyWithWakeups); quotas.schedule(); break
      case 'listAccountRecycle': return accountRecycle.list()
      case 'pageAccountRecycle': return accountRecycle.page(input)
      case 'previewAccountRecycle': return accountRecycle.preview(input)
      case 'discardAccountRecycle': accountRecycle.discard();return
      case 'applyAccountRecycle': {
        const result=await accountRecycle.apply(input,async()=>{
          const selection=await dialog.showSaveDialog(window,{title:'导出回收站账号（包含登录凭据）',defaultPath:'codex-recycled-accounts.json',filters:[{name:'JSON',extensions:['json']}]})
          return selection.canceled?undefined:selection.filePath
        });quotas.schedule();return result
      }
      case 'previewImport': return parseAccountImport(z.string().max(16 * 1024 * 1024).parse(input)).preview
      case 'importAccounts': importIntoStore(store, z.string().max(16 * 1024 * 1024).parse(input)); quotas.schedule(); break
      case 'scanLocalData': return localDataMigration.scan(z.string().uuid().parse(input))
      case 'chooseLocalData': {
        const requestId=z.string().uuid().parse(input),operation=localDataMigration.begin(requestId)
        const selection=await dialog.showOpenDialog(window,{title:'选择本机账号与供应商数据目录',properties:['openDirectory']})
        if(selection.canceled||!selection.filePaths[0]){localDataMigration.cancel(requestId);return undefined}
        return localDataMigration.finishScan(operation,selection.filePaths[0])
      }
      case 'previewLocalData': return localDataMigration.preview(input)
      case 'applyLocalData': {const result=await localDataMigration.apply(input);quotas.schedule();return {...result,snapshot:snapshot()}}
      case 'discardLocalData': localDataMigration.discard(z.string().uuid().parse(input));return
      case 'cancelLocalData': localDataMigration.cancel(z.string().uuid().parse(input));return
      case 'stageImport': return accountFiles.stage(z.string().max(16 * 1024 * 1024).parse(input))
      case 'discardImport': accountFiles.discard(z.string().uuid().optional().parse(input)); return
      case 'chooseImportFile': {
        const selectionId=z.string().uuid().optional().parse(input),operation=accountFiles.beginFileSelection(selectionId)
        const selection = await dialog.showOpenDialog(window, { title: '选择 Codex 账号文件', properties: ['openFile'], filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt'] }] })
        if (selection.canceled || !selection.filePaths[0]) return
        return accountFiles.finishFileSelection(operation,selection.filePaths[0])
      }
      case 'cancelImportFileSelection': accountFiles.cancelFileSelection(z.string().uuid().parse(input));return
      case 'commitImport': {
        const result = accountFiles.commit(z.string().uuid().parse(input)); quotas.schedule()
        return { ...result, snapshot: snapshot() }
      }
      case 'exportAccounts': {
        const ids = z.array(z.string().uuid()).min(1).max(10000).parse(input)
        const selection = await dialog.showSaveDialog(window, { title: '导出账号（包含登录凭据）', defaultPath: 'codex-accounts.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (selection.canceled || !selection.filePath) return { count: 0, cancelled: true }
        return { count: await accountFiles.export(ids, selection.filePath), cancelled: false }
      }
      case 'startTempLogin': {
        if(['starting','waiting','exchanging'].includes(login.current().status))throw new Error('请先完成或取消当前浏览器登录')
        tempLogin.start(input);break
      }
      case 'cancelTempLogin': await tempLogin.cancel(z.string().uuid().parse(input));break
      case 'openTempLoginURL': {
        const url=tempLogin.authURL(z.string().uuid().parse(input))
        try{await shell.openExternal(url)}catch{throw new Error('无法打开浏览器，请复制本次授权链接后手动打开')}
        return
      }
      case 'copyTempLoginURL': clipboard.writeText(tempLogin.authURL(z.string().uuid().parse(input)));return
      case 'cleanupTempLogin': await tempLogin.cleanup();break
      case 'startLogin': {
        if(tempLogin.current().running)throw new Error('请先完成或取消当前官方客户端登录')
        await login.start(z.enum(['browser', 'device']).parse(input));break
      }
      case 'cancelLogin': login.cancel(); break
      case 'openLogin': await login.open(); return
      case 'completeLogin': await login.complete(z.string().min(1).max(8192).parse(input)); break
      case 'refreshQuotas': quotas.start(z.array(z.string().uuid()).max(10000).parse(input)); break
      case 'refreshAllQuotas': quotas.startAll(); break
      case 'cancelQuotaRefresh': quotas.cancel(); break
      case 'refreshSubscription': await quotas.refreshSubscriptionInfo(z.string().uuid().parse(input)); break
      case 'refreshResetCredits': await quotas.refreshResetCreditsInfo(z.string().uuid().parse(input)); break
      case 'consumeResetCredit': await quotas.consumeResetCredit(z.string().uuid().parse(input)); break
      case 'startGateway': {
        await localAccess.startSingle(z.string().uuid().parse(input))
        break
      }
      case 'stopGateway': await localAccess.stop(); break
      case 'copyGatewayKey': {
        const account = store.read().accounts.find(account => account.id === gateway.current().profileId)
        if (!account?.credentials.localAPIKey || !gateway.current().running) throw new Error('请先启动本地 API')
        clipboard.writeText(account.credentials.localAPIKey); return
      }
      default: throw new Error('未知操作')
    }
    return snapshot()
    })()
    } catch (error) {
      if (error instanceof CatalogError) throw new Error(catalogErrors[error.code]??'代理目录无效')
      if (error instanceof EngineError) throw new Error(engineErrors[error.code])
      if (error instanceof z.ZodError) throw new Error(`参数格式错误：${[...new Set(error.issues.map(issue => issue.path.join('.') || '输入'))].join('、')}`)
      throw error
    }finally{commands.delete(invocation)}
  })
  await window.loadURL(allowed)
}
if (ownsLock) app.whenReady().then(main).catch(error => { dialog.showErrorBox('启动失败', String(error)); app.quit() })
  app.on('window-all-closed', () => { if (explicitQuit || !keepAliveInTray) app.quit() })
