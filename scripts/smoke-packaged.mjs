import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, openSync, closeSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import assert from 'node:assert/strict'

const productName = 'Agent Manager Lite'
const sourcePackage = JSON.parse(readFileSync('package.json', 'utf8'))
const evidenceDirectory = resolve(process.env.CML_PACKAGED_EVIDENCE_DIR || 'docs/evidence')
mkdirSync(evidenceDirectory, { recursive: true })
const bundle = resolve(process.env.CML_PACKAGED_APP_PATH?join(process.env.CML_PACKAGED_APP_PATH,'Contents'):'release-agent-manager/mac-arm64/Agent Manager Lite.app/Contents')
const plist = join(bundle, 'Info.plist')
assert.ok(existsSync(plist), 'Build the macOS application before this test')
const plistValue = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
const executableName = plistValue('CFBundleExecutable')
assert.ok(executableName && !/[\\/]/.test(executableName), 'Bundle executable must be a single filename')
const binary = join(bundle,'MacOS',executableName)
assert.ok(existsSync(binary), 'Build the macOS application before this test')
assert.equal(plistValue('CFBundleName'), productName)
assert.equal(plistValue('CFBundleDisplayName'), productName)
assert.equal(plistValue('CFBundleIdentifier'), 'local.codex-manager-lite', 'Bundle identity must remain compatible with existing installs')
assert.equal(plistValue('CFBundleShortVersionString'), sourcePackage.version, 'Bundle display version must match the release source')
assert.equal(plistValue('CFBundleVersion'), sourcePackage.version, 'Bundle build version must match the release source')
const archive = join(bundle, 'Resources/app.asar')
const shippedPackage = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
assert.equal(shippedPackage.name, 'codex-manager-lite', 'Package identity is separate from the display brand')
assert.equal(shippedPackage.version, sourcePackage.version, 'Shipped package version must match the release source')
const missingRootDeclarations = Object.keys(sourcePackage.dependencies || {}).filter(name => !Object.hasOwn(shippedPackage.dependencies || {}, name))
assert.equal(missingRootDeclarations.length, 0, `Packaged package.json omitted runtime dependencies: ${missingRootDeclarations.join(', ')}`)
// Walk the runtime dependency graph inside the actual app.asar. electron-builder
// can produce a syntactically valid archive while omitting a transitive package
// (for example yauzl -> pend); catching that here gives a useful packaging error
// before Electron opens a blocking native main-process error dialog.
const archivedPackageCache = new Map([['', shippedPackage]])
const readArchivedPackage = packagePath => {
  if (archivedPackageCache.has(packagePath)) return archivedPackageCache.get(packagePath)
  let content
  try { content = extractFile(archive, `${packagePath}/package.json`) } catch {
    archivedPackageCache.set(packagePath, null)
    return null
  }
  const value = JSON.parse(content.toString('utf8'))
  archivedPackageCache.set(packagePath, value)
  return value
}
const resolveArchivedDependency = (fromPath, name) => {
  let ancestor = fromPath
  while (true) {
    const candidate = `${ancestor ? `${ancestor}/` : ''}node_modules/${name}`
    const packageJson = readArchivedPackage(candidate)
    if (packageJson) return { path: candidate, packageJson }
    const marker = ancestor.lastIndexOf('/node_modules/')
    if (marker < 0) {
      if (!ancestor) break
      ancestor = ''
    } else ancestor = ancestor.slice(0, marker)
  }
  return null
}
const missingPackagedDependencies = []
const pendingPackagedPackages = [{ path: '', packageJson: shippedPackage }]
const checkedPackagedPackages = new Set()
while (pendingPackagedPackages.length) {
  const current = pendingPackagedPackages.pop()
  if (checkedPackagedPackages.has(current.path)) continue
  checkedPackagedPackages.add(current.path)
  const optional = new Set(Object.keys(current.packageJson.optionalDependencies || {}))
  const dependencies = { ...(current.packageJson.dependencies || {}), ...(current.packageJson.optionalDependencies || {}) }
  for (const [name, range] of Object.entries(dependencies)) {
    const resolved = resolveArchivedDependency(current.path, name)
    if (!resolved) {
      if (!optional.has(name)) missingPackagedDependencies.push(`${current.path || '<root>'} -> ${name}@${range}`)
      continue
    }
    pendingPackagedPackages.push(resolved)
  }
}
assert.equal(missingPackagedDependencies.length, 0, `Packaged runtime dependency closure is incomplete: ${missingPackagedDependencies.join(', ')}. Rebuild with a complete, non-symlinked node_modules tree.`)
const shippedMain = extractFile(archive, 'out/main/index.js').toString('utf8')
// This verifies key addressing in the shipped code; it does not access or
// claim integration coverage of the user's real vault or system Keychain.
assert.match(shippedMain, /\.setName\(isolatedTest\s*\?\s*["']Codex Manager Lite Test["']\s*:\s*["']Codex Manager Lite["']\)/)
assert.match(shippedMain, /\.setPath\(["']userData["'],[^;\n]*\.getPath\(["']appData["']\),\s*["']codex-manager-lite["']\)\)/)
const help = execFileSync(join(bundle,'Resources/bin/codex-proxy'),['-help'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
assert.ok(typeof help === 'string')
const snapshotHelper=join(bundle,'Resources/bin/codex-profile-snapshot')
assert.ok(existsSync(snapshotHelper),'The installed application includes its profile snapshot helper')
const profileProbe=mkdtempSync(join(tmpdir(),'aml-packaged-snapshot-'))
let sourceFd,parentFd
try{
  const source=join(profileProbe,'source'),copy=join(profileProbe,'saved')
  writeFileSync(source,'saved history\n');sourceFd=openSync(source,'r');parentFd=openSync(profileProbe,'r')
  const result=spawnSync(snapshotHelper,['saved'],{stdio:['ignore','pipe','pipe',sourceFd,parentFd],timeout:10_000})
  assert.ifError(result.error);assert.equal(result.status,0,'The shipped helper creates an APFS snapshot from verified descriptors')
  writeFileSync(source,'later source write\n')
  assert.equal(readFileSync(copy,'utf8'),'saved history\n');assert.notEqual(statSync(copy).ino,statSync(source).ino)
  assert.equal(spawnSync(snapshotHelper,['../outside'],{stdio:['ignore','pipe','pipe',sourceFd,parentFd],timeout:10_000}).status,1)
}finally{if(sourceFd!==undefined)closeSync(sourceFd);if(parentFd!==undefined)closeSync(parentFd);rmSync(profileProbe,{recursive:true,force:true})}
const directory = mkdtempSync(join(tmpdir(),'cml-packaged-'))
const env = { ...process.env,CML_TEST_DATA_DIR:directory }
delete env.ELECTRON_RUN_AS_NODE
// Keep test-window frame callbacks running while Codex or another app is foreground.
// Electron's default main-process error dialog blocks startup and used to hide the
// useful error behind a later DevToolsActivePort ENOENT. Capture only this detached
// test process's pipes so the failure points at the original application error.
const startupTimeoutMs = 45_000
const rendererTimeoutMs = 10_000
const outputLimitBytes = 128 * 1024
const startupEvidence = join(evidenceDirectory,'packaged-startup-failure.log')
const capture = () => ({ chunks: [], bytes: 0, truncated: false })
const appendOutput = (target, chunk) => {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const remaining = outputLimitBytes - target.bytes
  if (remaining <= 0) { target.truncated = true; return }
  target.chunks.push(value.subarray(0, remaining))
  target.bytes += Math.min(value.length, remaining)
  if (value.length > remaining) target.truncated = true
}
const outputText = target => `${Buffer.concat(target.chunks).toString('utf8')}${target.truncated ? '\n[… output truncated …]\n' : ''}`
const errorText = error => {
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack && error.stack !== error.message ? `\n${error.stack}` : ''}`
  if (error && typeof error === 'object') { try { return JSON.stringify(error) } catch {} }
  return String(error)
}

let child
try {
  child = spawn(binary,['--cml-smoke-test','--user-data-dir='+directory,'--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-background-timer-throttling','--enable-logging=stderr','--log-level=0','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{env,stdio:['ignore','pipe','pipe'],detached:true})
} catch (error) {
  rmSync(directory,{recursive:true,force:true})
  throw new Error(`Unable to spawn packaged application: ${errorText(error)}`)
}
const launch = { error: null, exit: null, close: null, stdout: capture(), stderr: capture() }
child.stdout?.on('data', chunk => appendOutput(launch.stdout, chunk))
child.stderr?.on('data', chunk => appendOutput(launch.stderr, chunk))
child.once('error', error => { launch.error = error })
child.once('exit', (code, signal) => { launch.exit = { code, signal } })
child.once('close', (code, signal) => { launch.close = { code, signal } })
let socket
const kill = (signal = 'SIGKILL') => {
  // detached:true gives this smoke process its own process group. Signalling the
  // group cleans up Electron's renderer/helper children without matching or
  // interrupting an already-running user installation by bundle name.
  if (!child?.pid || child.pid === process.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if (error?.code !== 'ESRCH') console.error(`Unable to stop packaged smoke process group: ${errorText(error)}`)
  }
}
const startupDiagnostics = (reason, cause = undefined) => {
  let activePort = '<missing>'
  const active = join(directory,'DevToolsActivePort')
  try { if (existsSync(active)) activePort = readFileSync(active,'utf8') } catch (error) { activePort = `<unreadable: ${errorText(error)}>` }
  const details = [
    `reason: ${reason}`,
    `binary: ${binary}`,
    `userDataDir: ${directory}`,
    `pid: ${child?.pid ?? '<none>'}`,
    `spawn error: ${launch.error ? errorText(launch.error) : '<none>'}`,
    `exit: ${launch.exit ? JSON.stringify(launch.exit) : '<running>'}`,
    `close: ${launch.close ? JSON.stringify(launch.close) : '<open>'}`,
    `DevToolsActivePort: ${activePort}`,
    cause ? `cause: ${errorText(cause)}` : '',
    '--- stdout ---', outputText(launch.stdout),
    '--- stderr ---', outputText(launch.stderr),
  ].filter(Boolean).join('\n') + '\n'
  let evidenceError
  try { writeFileSync(startupEvidence, details, { encoding: 'utf8', mode: 0o600 }) } catch (error) { evidenceError = error }
  const saved = evidenceError ? `Unable to save startup evidence: ${errorText(evidenceError)}` : `Startup evidence: ${startupEvidence}`
  return new Error(`Packaged application startup failed (${reason}). ${saved}\n${details}`)
}
const launchStopped = () => launch.error || launch.exit || child.exitCode !== null || child.signalCode !== null
const waitForClose = async timeoutMs => {
  if (launch.close) return
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    delay(timeoutMs),
  ])
}
try {
  const active = join(directory,'DevToolsActivePort')
  const startupDeadline = Date.now() + startupTimeoutMs
  while (!existsSync(active)) {
    if (launch.error) throw startupDiagnostics('spawn-error', launch.error)
    if (launchStopped()) throw startupDiagnostics('app-exit-before-devtools', launch.exit ?? launch.error)
    if (Date.now() >= startupDeadline) throw startupDiagnostics('startup-timeout')
    await delay(100)
  }
  let activeContents
  try { activeContents = readFileSync(active,'utf8') } catch (error) { throw startupDiagnostics('devtools-port-read-error', error) }
  const port = Number(activeContents.split('\n')[0])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw startupDiagnostics('invalid-devtools-port', new Error(`Invalid port contents: ${JSON.stringify(activeContents)}`))
  let page
  let lastRendererError
  const rendererDeadline = Date.now() + rendererTimeoutMs
  while (!page) {
    if (launchStopped()) throw startupDiagnostics('app-exit-before-renderer', launch.exit ?? launch.error)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(5000)})
      page = (await response.json()).find(p=>p.type==='page' && p.url.startsWith('file:'))
    } catch (error) { lastRendererError = error }
    if (page) break
    if (Date.now() >= rendererDeadline) throw startupDiagnostics('renderer-timeout', lastRendererError)
    await delay(100)
  }
  socket = new WebSocket(page.webSocketDebuggerUrl)
  try {
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  } catch (error) { throw startupDiagnostics('devtools-websocket-error', error) }
  let id = 0
  const pending = new Map()
  socket.addEventListener('close',()=>{for(const task of pending.values())task.reject(new Error('Packaged debug session closed'));pending.clear()})
  socket.addEventListener('message',event=>{const result=JSON.parse(event.data);const task=pending.get(result.id);if(task){pending.delete(result.id);result.error?task.reject(new Error(result.error.message)):task.resolve(result.result)}})
  const call = (method,params={})=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});socket.send(JSON.stringify({id:current,method,params}));})
  const evaluate = async expression => {
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.description || result.exceptionDetails.text)
    return result.result.value
  }
  for (let i=0;i<100;i++) { if(await evaluate('!!window.manager && !!document.querySelector("h1")')) break; await delay(100) }
  assert.equal(await evaluate('document.title'), productName)
  assert.equal(await evaluate('document.querySelector(".sidebar-bottom .version").textContent'), `v${sourcePackage.version} · 本地数据`, 'Visible application version must match the installer')
  assert.equal(await evaluate('document.querySelector(".brand-mark")?.getAttribute("alt")'), productName)
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'实例')
  const snapshot=await evaluate('window.manager.load()')
  assert.equal(snapshot.accounts.length,0)
  assert.deepEqual(snapshot.upstreamProxy,{revision:0,mode:'inherit'})
  assert.equal(await evaluate('typeof window.manager.saveUpstreamProxy'),'function')
  assert.equal(await evaluate('window.manager.saveUpstreamProxy({revision:0,mode:"custom",url:"file:///invalid"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.saveAccountProxy({accountId:"invalid",revision:0,mode:"direct"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('typeof window.manager.readAccountKey'),'function')
  assert.equal(await evaluate('window.manager.readAccountKey({id:"invalid",revision:0}).then(()=>false,()=>true)'),true)
  const navigation=await evaluate('Array.from(document.querySelectorAll(".navigation .ant-menu-item")).map(el=>el.textContent.replace(/\\s/g,""))')
  assert.ok(navigation.includes('概览')&&navigation.includes('实例')&&navigation.some(value=>value.startsWith('账号管理'))&&navigation.some(value=>value.startsWith('供应商与密钥')),'Primary workspace navigation entries are present')
  await evaluate('Array.from(document.querySelectorAll(".navigation .ant-menu-item")).find(el=>el.textContent==="概览").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".overview-assets")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelectorAll(".overview-assets .asset-empty").length'),2)
  await evaluate('Array.from(document.querySelectorAll(".navigation .ant-menu-item")).find(el=>el.textContent.includes("账号管理")).click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".account-filters")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'你的账号')
  assert.deepEqual(snapshot.proxyResources,{resources:[],unified:{mode:'off'},eligible:0,inherited:0,independent:0,direct:0})
  // Proxy subscriptions, catalogues, strategies, engine installation and
  // account assignment are deliberately not product UI. The old IPC modules
  // remain private compatibility code for existing vaults and gateway egress.
  assert.equal(await evaluate('!!document.querySelector(".proxy-resources-trigger,.proxy-catalog-trigger,.proxy-engine-trigger,.proxy-assignment-trigger,.advanced-network")'),false)
  assert.equal(await evaluate('document.body.innerText.includes("代理来源目录")'),false)
  assert.equal(snapshot.tempLogin.phase,'idle')
  assert.equal(await evaluate('window.manager.startTempLogin({applicationId:"invalid",interceptAuthUrl:true}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.openTempLoginURL("invalid").then(()=>false,()=>true)'),true)
  assert.equal((await evaluate('window.manager.cleanupTempLogin()')).tempLoginCleanup.failed.length,0)
  assert.equal((await evaluate('window.manager.listAccountRecycle()')).total,0)
  assert.equal(await evaluate('window.manager.pageAccountRecycle({snapshotId:"invalid",page:1}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.previewAccountRecycle({snapshotId:"invalid",all:true,action:"purge"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.applyAccountRecycle({ticket:"invalid",confirmed:false}).then(()=>false,()=>true)'),true)
  await evaluate(`Array.from(document.querySelectorAll('.account-filters button')).find(el=>el.textContent==='账号回收站').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".account-recycle .ant-empty")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".account-recycle").textContent.includes("0 个账号")'),true)
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".ant-modal-footer button")).find(el=>el.getClientRects().length&&el.textContent==="清空回收站").disabled'),true)
  await evaluate('document.querySelector(".account-recycle").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  for(let i=0;i<50;i++){if(await evaluate('Array.from(document.querySelectorAll(".ant-modal-wrap")).every(el=>!el.getClientRects().length)'))break;await delay(50)}
  await evaluate(`Array.from(document.querySelectorAll('.page-heading button')).find(el=>el.textContent.replace(/\\s/g,'')==='添加账号').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".temp-login-storage .ant-select-selector")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".temp-login-panel").closest(".ant-modal-content").querySelector(".ant-modal-title").textContent'),'添加账号')
  assert.equal(await evaluate('document.querySelector("[aria-label=账号用途]").closest(".ant-select").textContent.includes("Codex")'),true)
  assert.equal(await evaluate('document.querySelector(".temp-login-storage").textContent.includes("文件（默认）")'),true)
  await evaluate('document.querySelector(".temp-login-storage .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
  for(let i=0;i<50;i++){if(await evaluate('Array.from(document.querySelectorAll(".ant-select-item-option")).some(el=>el.getClientRects().length&&el.textContent==="系统钥匙串")'))break;await delay(50)}
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".ant-select-item-option")).filter(el=>el.getClientRects().length).map(el=>el.textContent)'),['文件（默认）','系统钥匙串','自动（系统优先）'])
  await evaluate('Array.from(document.querySelectorAll(".ant-select-item-option")).find(el=>el.getClientRects().length&&el.textContent==="系统钥匙串").click()')
  assert.equal(await evaluate('document.querySelector(".temp-login-panel").textContent.includes("读取时可能请求系统授权")'),true)
  assert.equal(await evaluate('window.manager.startTempLogin({applicationId:"fixture",credentialStore:"invalid"}).then(()=>false,()=>true)'),true)
  assert.equal((await evaluate('window.manager.load()')).tempLogin.phase,'idle')
  assert.equal(existsSync(join(directory,'state.vault')),false)
  await evaluate('document.querySelector(".temp-login-panel").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  assert.equal(snapshot.gateway.running,false)
  assert.equal(snapshot.dataDirectory,directory)
  assert.equal(await evaluate('window.manager.readClientIdentity({id:"invalid"}).then(()=>false,()=>true)'),true)
  assert.deepEqual(await evaluate('window.manager.listClientAuthorities()'),[])
  assert.deepEqual(snapshot.clientSwitches,[])
  assert.equal(await evaluate('window.manager.previewClientSwitch({targetId:"invalid",accountId:"invalid"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.applyClientSwitch({ticket:"invalid",clientClosed:false}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.bindClientAuthority({ticket:"invalid",accountId:"invalid"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.releaseClientAuthority({targetId:"invalid",clientClosed:false}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.copyInstance({id:"invalid",revision:0,details:{}}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.copyExternalInstance({ticket:"invalid",sourceClosed:false,details:{}}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.attachExistingInstance({ticket:"invalid",sourceClosed:false,details:{}}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.cancelInstanceCopy("invalid").then(()=>false,()=>true)'),true)
  const history=await evaluate('window.manager.queryHistory({filter:{search:"",outcome:"all"},page:1,pageSize:25})')
  assert.equal(history.total,0)
  const targets=await evaluate('window.manager.listClientConfigs()')
  assert.equal(targets.length,1)
  const config=await evaluate(`window.manager.readClientConfig(${JSON.stringify(targets[0].id)})`)
  assert.equal(config.exists,false)
  const identity=await evaluate(`window.manager.readClientIdentity(${JSON.stringify({id:targets[0].id,includeKeyring:false})})`)
  assert.equal(identity.status,'missing');assert.equal(identity.mode,'file');assert.equal(identity.ticket,undefined)
  // Managed config does not save accounts/settings and cannot touch safeStorage.
  const preview=await evaluate(`window.manager.previewClientConfig(${JSON.stringify({id:targets[0].id,revision:config.revision,changes:{service_tier:'fast'}})})`)
  const saved=await evaluate(`window.manager.applyClientConfig(${JSON.stringify(preview.ticket)})`)
  assert.equal(saved.values.service_tier,'fast')
  const providers=await evaluate(`window.manager.readClientProviders(${JSON.stringify(targets[0].id)})`)
  const providerPreview=await evaluate(`window.manager.previewClientProvider(${JSON.stringify({id:targets[0].id,revision:providers.revision,providerId:'fixture_packaged',create:true,changes:{name:'Packaged fixture',base_url:'https://packaged.invalid/v1'},auth:{mode:'token',token:'fixture-packaged-secret'},makeDefault:true,serviceTier:'fast'})})`)
  assert.equal(JSON.stringify(providerPreview).includes('fixture-packaged-secret'),false)
  const providerSaved=await evaluate(`window.manager.applyClientConfig(${JSON.stringify(providerPreview.ticket)})`)
  assert.equal(providerSaved.values.model_provider,'fixture_packaged')
  const providerView=await evaluate(`window.manager.readClientProviders(${JSON.stringify(targets[0].id)})`)
  assert.equal(providerView.providers[0].bearerConfigured,true)
  assert.equal(JSON.stringify(providerView).includes('fixture-packaged-secret'),false)
  const providerIdentity=await evaluate(`window.manager.readClientIdentity(${JSON.stringify({id:targets[0].id,includeKeyring:false})})`)
  assert.equal(providerIdentity.status,'identified');assert.equal(providerIdentity.source,'config')
  assert.equal(JSON.stringify(providerIdentity).includes('fixture-packaged-secret'),false)
  await evaluate(`window.manager.cancelClientIdentity(${JSON.stringify(targets[0].id)})`)
  const catalog=await evaluate(`window.manager.readModelCatalog(${JSON.stringify(targets[0].id)})`)
  assert.equal(catalog.source,'official')
  const catalogPreview=await evaluate(`window.manager.previewModelCatalog(${JSON.stringify({id:targets[0].id,revision:catalog.revision,enabled:true,models:catalog.defaults,defaultModelId:'gpt-6.1-sol'})})`)
  await evaluate(`window.manager.applyClientConfig(${JSON.stringify(catalogPreview.ticket)})`)
  const catalogSaved=await evaluate(`window.manager.readModelCatalog(${JSON.stringify(targets[0].id)})`)
  assert.equal(catalogSaved.source,'managed')
  assert.equal(catalogSaved.models[0].modelId,'gpt-6.1-sol')
  const catalogText=readFileSync(catalogSaved.reference,'utf8')
  assert.deepEqual(JSON.parse(execFileSync(join(bundle,'Resources/bin/codex-proxy'),['-validate-model-catalog'],{input:catalogText,encoding:'utf8',timeout:5000})),{valid:true})
  assert.ok(catalogSaved.capabilities.some(model=>model.fast))
  assert.equal(JSON.stringify(catalogSaved).includes('base_instructions'),false)
  assert.equal(existsSync(join(directory,'state.vault')),false)
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'你的账号')
  // Complete finite CSS transitions in this isolated screenshot harness. An
  // occluded packaged window can otherwise freeze halfway through modal exit.
  await evaluate('document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).forEach(a=>a.finish())')
  for(let i=0;i<60;i++){if(await evaluate('Array.from(document.querySelectorAll(".ant-modal-wrap")).every(el=>!el.getClientRects().length)'))break;await delay(50)}
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".ant-modal-wrap")).every(el=>!el.getClientRects().length)'),true,JSON.stringify(await evaluate('Array.from(document.querySelectorAll(".ant-modal-wrap")).filter(el=>el.getClientRects().length).map(el=>({title:el.querySelector(".ant-modal-title")?.textContent,classes:el.className,display:el.style.display,content:el.querySelector(".ant-modal")?.className}))')))
  const capture=await call('Page.captureScreenshot',{format:'png'})
  writeFileSync(join(evidenceDirectory,'network-proxy-packaged-startup.png'),Buffer.from(capture.data,'base64'))
  // Unsaved settings must never make the account-page shortcut claim Fast.
  // This exercises shipped Vue code without creating a vault or using Keychain.
  await evaluate('document.querySelector(".sidebar-bottom button").click()')
  for(let i=0;i<100;i++){if(await evaluate('document.querySelectorAll(".settings-draft .ant-form-item").length>=2'))break;await delay(100)}
  await evaluate('(()=>{const items=Array.from(document.querySelectorAll(".settings-draft .ant-segmented-item-label,.settings-draft .ant-segmented-item"));const el=items.find(value=>value.textContent==="Fast");if(!el)throw new Error(JSON.stringify({items:items.map(value=>value.textContent),body:document.body.innerText.slice(-1000)}));el.click()})()')
  assert.equal(await evaluate('!!document.querySelector(".settings-unsaved")'),true)
  await evaluate('Array.from(document.querySelectorAll(".ant-menu-item")).find(el=>el.textContent.includes("账号管理")).click()')
  assert.equal(await evaluate('document.querySelector(".tier-strip input:checked").closest("label").textContent'),'跟随请求')
  await evaluate('document.querySelector(".sidebar-bottom button").click()')
  await evaluate('Array.from(document.querySelectorAll(".settings-actions button")).find(el=>el.textContent.replaceAll(" ","")==="放弃更改").click()')
  assert.equal(await evaluate('!!document.querySelector(".settings-unsaved")'),false)
  await evaluate('document.querySelector(".sidebar-bottom button").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".upstream-proxy-panel")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".upstream-proxy-panel").textContent.includes("默认网络代理")'),true)
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".upstream-proxy-panel .ant-segmented-item-label")).map(el=>el.textContent)'),['默认网络','直连','指定代理'])
  await evaluate('Array.from(document.querySelectorAll(".upstream-proxy-panel .ant-segmented-item-label")).find(el=>el.textContent==="指定代理").click()')
  assert.equal(await evaluate('!!document.querySelector("[aria-label=默认网络代理地址]")'),true)
  assert.equal(await evaluate('document.querySelector(".upstream-proxy-panel button.ant-btn-primary").disabled'),true)
  assert.equal(existsSync(join(directory,'state.vault')),false)
  await evaluate('Array.from(document.querySelectorAll(".ant-menu-item")).find(el=>el.textContent.includes("账号管理")).click()')
  assert.equal(existsSync(join(directory,'state.vault')),false)
  assert.deepEqual(snapshot.providers,[])
  assert.equal(snapshot.providerProbe.running,false)
  assert.deepEqual(snapshot.providerProbe.records,[])
  assert.equal(await evaluate('typeof window.manager.mutateProvider'), 'function')
  assert.equal(await evaluate('typeof window.manager.startProviderProbe'), 'function')
  assert.equal(await evaluate('window.manager.startProviderProbe({mode:"models",targets:[]}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.mutateProvider({action:"create",details:{}}).then(()=>false,()=>true)'),true)
  await evaluate(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent.includes('供应商与密钥')).click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".provider-library")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'供应商与密钥')
  assert.equal(await evaluate('document.getElementById("provider-library-tab").getAttribute("aria-selected")'),'true')
  assert.equal(await evaluate('!!document.querySelector(".api-connections")'),false)
  await evaluate('document.getElementById("api-connections-tab").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.getElementById("api-connections-panel")'))break;await delay(50)}
  assert.equal(await evaluate('document.getElementById("api-connections-tab").getAttribute("aria-selected")'),'true')
  assert.equal(await evaluate('document.querySelector(".ant-empty").textContent.includes("还没有 API 连接")'),true)
  assert.equal(await evaluate('!!document.querySelector(".tier-strip")'),false)
  await evaluate('document.getElementById("provider-library-tab").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".provider-library")'))break;await delay(50)}
  await evaluate(`Array.from(document.querySelectorAll('.provider-library .toolbar button')).find(el=>el.textContent.includes('接口测试')).click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".provider-probe-panel")'))break;await delay(50)}
  assert.equal(await evaluate('!!document.querySelector(".provider-probe-panel")'),true)
  assert.equal(await evaluate('document.querySelector(".provider-probe-panel button.ant-btn-primary").disabled'),true)
  assert.equal(existsSync(join(directory,'state.vault')),false)
  assert.deepEqual(snapshot.instances,[])
  assert.equal(await evaluate('window.manager.saveInstance({details:{}}).then(()=>false,()=>true)'),true)
  await evaluate(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent==='实例').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".instances-panel")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'实例')
  await evaluate('document.querySelector(".instances-panel .page-heading button.ant-btn-primary").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".instance-wizard")'))break;await delay(50)}
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".instance-step")).filter(el=>el.getClientRects().length).map(el=>el.dataset.step)'),['0'])
  assert.equal(await evaluate('document.querySelector("[aria-label=实例客户端]").closest(".ant-select").textContent'),'Codex')
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".instance-wizard-steps .ant-steps-item-title")).map(el=>el.textContent)'),['客户端','账号或供应商','项目与配置','确认'])
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".instance-editor input")).some(el=>el.getClientRects().length&&el.getAttribute("aria-label")==="实例名称")'),false)
  assert.equal(await evaluate('document.querySelector(".instance-wizard").closest(".ant-modal-content").querySelector(".ant-modal-footer button.ant-btn-primary").textContent.replace(/\\s/g,"")'),'下一步')
  await evaluate('document.querySelector(".instance-wizard").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  assert.deepEqual(snapshot.localAccess.keys,[])
  assert.equal(snapshot.localAccess.running,false)
  assert.equal(await evaluate('window.manager.mutateLocalAccess({action:"createKey",details:{}}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.startLocalAccess().then(()=>false,()=>true)'),true)
  await evaluate(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent==='本地 API').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".local-access-panel")'))break;await delay(50)}
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".local-access-panel button")).find(el=>el.textContent=== "启动账号池").disabled'),true)
  assert.equal(await evaluate('document.querySelector(".pool-keys").textContent.includes("暂无数据")'),true)
  assert.equal(await evaluate('window.manager.scanSessions({runId:"invalid"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.openSession({snapshotId:"invalid",sessionId:"x",targetId:"invalid",action:"file"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.sessionTokenStats({snapshotId:"invalid",sessionIds:[]}).then(()=>false,()=>true)'),true)
  assert.deepEqual(await evaluate('window.manager.sessionTransferState()'),{recoveries:[]})
  assert.equal(await evaluate('window.manager.previewSessionCopy({snapshotId:"invalid",sessionIds:[],targetId:"invalid",applicationId:"x"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.startSessionCopy({ticket:"invalid",clientsClosed:true}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.retrySessionTransfer({id:"invalid",applicationId:"x",clientsClosed:false}).then(()=>false,()=>true)'),true)
  assert.deepEqual(await evaluate('window.manager.sessionSyncState()'),{recoveries:[]})
  assert.equal(await evaluate('window.manager.previewSessionSync({targetIds:["invalid"],applicationId:"x"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.startSessionSync({ticket:"invalid",clientsClosed:false}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.retrySessionSync({id:"invalid",applicationId:"x",clientsClosed:true}).then(()=>false,()=>true)'),true)
  assert.deepEqual(await evaluate('window.manager.sessionTrashState()'),{recoveries:[]})
  const trash=await evaluate('window.manager.listSessionTrash()');assert.equal(trash.total,0);assert.deepEqual(trash.items,[])
  assert.equal(await evaluate('window.manager.previewSessionTrash({snapshotId:"invalid",sessionIds:[],applicationId:"x",clientsClosed:false}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.previewSessionTrashAction({snapshotId:"invalid",all:true,action:"restore"}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.startSessionTrash({ticket:"invalid",confirmed:false}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.recoverSessionTrash({id:"invalid",mode:"resume",clientsClosed:true}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.openSessionTrashBackup("../outside").then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('typeof window.manager.chooseLegacySessionTrash'),'function')
  assert.equal(await evaluate('window.manager.legacySessionTrashPage({snapshotId:"invalid",page:1}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.previewLegacySessionTrash({snapshotId:"invalid",sessionIds:[],mappings:[]}).then(()=>false,()=>true)'),true)
  await evaluate('window.manager.discardLegacySessionTrash()')
  assert.equal(await evaluate('window.manager.sessionArchiveState()'),undefined)
  assert.equal(await evaluate('window.manager.previewSessionExport({snapshotId:"invalid",sessionIds:[]}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.previewSessionImport({ticket:"invalid",targetId:"invalid",applicationId:"x",sessionIds:[]}).then(()=>false,()=>true)'),true)
  assert.equal(await evaluate('window.manager.startSessionImport({ticket:"invalid",clientsClosed:false}).then(()=>false,()=>true)'),true)
  await evaluate(`Array.from(document.querySelectorAll('.ant-menu-item')).find(el=>el.textContent==='会话管理').click()`)
  for(let i=0;i<50;i++){if(await evaluate('document.querySelector(".sessions-panel .toolbar")?.textContent.includes("读取于")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'会话')
  assert.equal(await evaluate('document.querySelector(".sessions-panel .toolbar").textContent.includes("0 个会话")'),true)
  assert.equal(await evaluate('document.querySelector(".sessions-panel .ant-empty").textContent.includes("没有找到会话")'),true)
  assert.equal(await evaluate('document.querySelector(".session-transfers .transfer-toolbar button").disabled'),true)
  assert.equal(await evaluate('document.querySelector(".session-sync .sync-toolbar button").disabled'),true)
  assert.equal(await evaluate('document.querySelector(".trash-toolbar button").disabled'),true)
  await evaluate(`Array.from(document.querySelectorAll('.trash-toolbar button')).find(el=>el.textContent==='导入旧废纸篓').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".legacy-trash-editor")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".legacy-trash-editor").textContent.includes("保留旧备份")'),true)
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".ant-modal-footer button")).find(el=>el.getClientRects().length&&el.textContent==="预览导入").disabled'),true)
  await evaluate('document.querySelector(".legacy-trash-editor").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  await evaluate(`Array.from(document.querySelectorAll('.trash-toolbar button')).find(el=>el.textContent==='打开废纸篓').click()`)
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".trash-list .ant-empty")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".trash-list").textContent.includes("0 个会话")'),true)
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".trash-list button")).find(el=>el.textContent==="清空废纸篓").disabled'),true)
  await evaluate('document.querySelector(".trash-list").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  const sessions=await evaluate('window.manager.scanSessions({runId:crypto.randomUUID(),titleQuery:"",contentQuery:"",kind:"all"})')
  assert.equal(sessions.total,0);assert.deepEqual(sessions.warnings,[])
  const fixtureId='00000000-0000-4000-8000-000000000009',sessionFolder=join(targets[0].directory,'sessions');mkdirSync(sessionFolder,{recursive:true})
  writeFileSync(join(sessionFolder,'rollout-'+fixtureId+'.jsonl'),JSON.stringify({type:'session_meta',timestamp:'2026-10-01T08:00:00Z',payload:{id:fixtureId,cwd:'/fixture',model_provider:'openai'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-01T08:00:01Z',payload:{type:'user_message',message:'packaged ZIP metadata fixture'}})+'\n')
  const zipSessions=await evaluate('window.manager.scanSessions({runId:crypto.randomUUID()})');assert.equal(zipSessions.total,1)
  const zipPreview=await evaluate(`window.manager.previewSessionExport(${JSON.stringify({snapshotId:zipSessions.snapshotId,sessionIds:[fixtureId]})})`);assert.equal(zipPreview.items.length,1);assert.equal(zipPreview.items[0].id,fixtureId);assert.ok(zipPreview.totalBytes>0)
  await evaluate('window.manager.discardSessionArchive()');assert.equal((await evaluate('window.manager.sessionArchiveState()')).status,'cancelled')
  for(const method of ['exportDataBackup','previewDataBackup','restoreDataBackup','discardDataBackup','cancelDataBackup','restartAfterBackup'])assert.equal(await evaluate(`typeof window.manager.${method}`),'function')
  for(const command of ['exportDataBackup({requestId:"invalid",password:"short"})','previewDataBackup({requestId:"invalid",password:"short"})','restoreDataBackup({ticket:"invalid",requestId:"invalid",confirmed:false})','discardDataBackup("invalid")','cancelDataBackup("invalid")','restartAfterBackup()'])assert.equal(await evaluate(`window.manager.${command}.then(()=>false,()=>true)`),true)
  await evaluate('document.querySelector(".sidebar-bottom button").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".data-backup-panel")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".data-backup-panel").textContent.includes("已有密钥的累计用量会保留")'),true)
  await evaluate('document.querySelector(".data-backup-panel button").click()')
  for(let i=0;i<50;i++){if(await evaluate('!!document.querySelector(".backup-password")'))break;await delay(50)}
  assert.equal(await evaluate('document.querySelector(".data-backup-dialog .ant-btn-primary").disabled'),true)
  await evaluate('document.querySelector(".data-backup-dialog").closest(".ant-modal-content").querySelector(".ant-modal-close").click()')
  await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
  await evaluate('document.querySelector(".data-backup-panel").scrollIntoView({block:"center"})')
  writeFileSync(join(evidenceDirectory,'network-proxy-data-backup-packaged.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'))
  assert.equal(existsSync(join(directory,'state.vault')),false)
  console.log('Packaged macOS smoke passed: Agent Manager Lite display brand and retained legacy identities; upstream proxy settings/invalid IPC; default instance entry and four-step Codex wizard; isolated renderer/preload, SQLite, TOML/Fast/Provider secret projection, provider library/probe/local pool/session navigation, encrypted backup UI and IPC validation, model catalog configuration and independent Go catalog validation; no existing vault or Keychain access')
} finally {
  socket?.close()
  kill('SIGTERM')
  await waitForClose(2_000)
  if (!launch.close) { kill('SIGKILL'); await waitForClose(2_000) }
  rmSync(directory,{recursive:true,force:true})
}
