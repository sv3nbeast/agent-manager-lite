// Isolated lifecycle regression: never starts or stops an installed user client.
const { app, safeStorage, dialog, Tray, Menu, ipcMain } = require('electron')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')
const cp = require('node:child_process')
const { promisify } = require('node:util')
const assert = require('node:assert/strict')

const directory = process.env.CML_TEST_DATA_DIR
const lastClose = process.env.CML_TEST_TRAY_LAST_CLOSE === '1'
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep), 'tray smoke must use a temporary data directory')
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
const testVaultStats = require('./test-vault.cjs').installTestVault(safeStorage)
const root = fs.realpathSync(directory), application = join(root, 'Fixture.app'), executable = join(application, 'Contents/MacOS/Codex')
fs.mkdirSync(join(application, 'Contents/MacOS'), { recursive: true })
fs.writeFileSync(join(application, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.cml.tray.${randomUUID()}</string><key>CFBundleName</key><string>CML Tray Fixture</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
cp.execFileSync('go', ['build', '-o', executable, 'tests/fixtures/desktop-client.go'], { cwd: resolve('.'), timeout: 30_000, stdio: 'pipe' })

// Seed an owned, surviving child exactly like restart recovery after a manager
// interruption. recover() intentionally presents it as error, with a live PID.
const recoveredId = randomUUID(), accountId = randomUUID(), nonce = randomUUID(), applicationId = 'tray-fixture-desktop'
const recoveredFolder = join(root, 'instances', recoveredId), recoveredHome = join(recoveredFolder, 'home')
for (const name of ['home', 'desktop', 'workspace']) fs.mkdirSync(join(recoveredFolder, name), { recursive: true })
const recoveredChild = cp.spawn(executable, [`--cml-instance=${nonce}`], { cwd: join(recoveredFolder, 'workspace'), env: { ...process.env, CODEX_HOME: recoveredHome }, stdio: 'ignore' })
// An unrelated fixture uses the same executable, but its private nonce is not
// registered with the manager. Explicit shutdown must leave it alone.
const unrelatedHome = join(root, 'unrelated-home')
fs.mkdirSync(unrelatedHome)
const unrelatedChild = cp.spawn(executable, [`--cml-instance=${randomUUID()}`], { cwd: root, env: { ...process.env, CODEX_HOME: unrelatedHome }, stdio: 'ignore' })
fs.writeFileSync(join(recoveredFolder, 'launch.json'), JSON.stringify({ nonce, connectionMode: 'local_api' }))
fs.writeFileSync(join(root, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, closeToTray: false }, groups: [],
  accounts: [{ id: accountId, revision: 0, generation: randomUUID(), name: 'Recovery fixture', kind: 'api_key', baseUrl: 'http://127.0.0.1:9/v1', wireApi: 'responses', tags: [], note: '', defaultTier: 'inherit', models: ['fixture-model'], createdAt: Date.now(), credentials: { apiKey: 'fixture-only' } }],
  instanceApplications: [{ id: applicationId, clientType: 'codex', name: 'Fixture', path: application, kind: 'desktop' }],
  instances: [{ id: recoveredId, clientType: 'codex', revision: 0, createdAt: Date.now(), name: 'Recovered fixture', applicationId, accountId, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] }]
})), { mode: 0o600 })

// Stop renderer polling from reaching Instances.refresh during the final
// natural-exit assertion. Returning its last snapshot keeps the isolated UI
// alive while proving that the main-process supervision timer does the work.
let finalIgnoreLoads = false, cachedLoad
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'manager:invoke' ? async (event, command, input) => {
  if (finalIgnoreLoads && command === 'load') return cachedLoad
  const value = await handler(event, command, input)
  if (command === 'load') cachedLoad = value
  return value
} : handler)
let dockShowTask = Promise.resolve()
if (process.platform === 'darwin') {
  const showDock = app.dock.show.bind(app.dock), hideDock = app.dock.hide.bind(app.dock)
  app.dock.show = (...args) => {
    if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') console.log('tray dock: show requested')
    const task = showDock(...args)
    dockShowTask = Promise.resolve(task).then(() => { if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') console.log('tray dock: show completed', app.dock.isVisible()) })
    return task
  }
  app.dock.hide = (...args) => {
    if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') console.log('tray dock: hide requested', app.dock.isVisible())
    const result = hideDock(...args)
    if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') setTimeout(() => console.log('tray dock: after hide', app.dock.isVisible()), 500)
    return result
  }
}
let trayMenu, releaseOpen, holdOpen = false, finished = false, readyForFinalQuit = false, passed = false, finalPid, finalLaunchFile
const originalTrayMenu = Tray.prototype.setContextMenu
Tray.prototype.setContextMenu = function (menu) { trayMenu = menu; return originalTrayMenu.call(this, menu) }
const originalExecFile = cp.execFile, originalExec = promisify(originalExecFile), sidecars = []
const patchedExecFile = (...args) => originalExecFile(...args)
patchedExecFile[promisify.custom] = (file, args, options) => {
  if (holdOpen && file === '/usr/bin/open' && args.includes(application)) return new Promise((resolve, reject) => {
    releaseOpen = () => { holdOpen = false; originalExec(file, args, options).then(resolve, reject) }
  })
  return originalExec(file, args, options)
}
cp.execFile = patchedExecFile
const originalSpawn = cp.spawn
cp.spawn = (file, args, options) => {
  const child = originalSpawn(file, args, options)
  const config = args?.[args.indexOf('-config') + 1]
  if (file === resolve('resources/bin/codex-proxy') && typeof config === 'string' && fs.existsSync(config) && fs.realpathSync(config).startsWith(join(root, 'runtime') + sep)) sidecars.push(child)
  return child
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const signalFixture = (pid, signal) => {
  if (!pid || !alive(pid)) return
  try {
    const command = cp.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim()
    if (command === executable) process.kill(pid, signal)
  } catch (error) { if (alive(pid)) throw error }
}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
const timeout = setTimeout(() => { console.error('tray lifecycle smoke timed out'); app.exit(1) }, 75_000)
process.on('exit', () => {
  // The external runner also cleans temporary executable-owned fixtures after
  // crashes or a blocked Electron process that cannot run this hook.
  for (const child of [recoveredChild, unrelatedChild]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const child of sidecars) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (finalPid && alive(finalPid)) signalFixture(finalPid, 'SIGKILL')
})
app.on('will-quit', event => {
  try {
    assert.ok(readyForFinalQuit, 'manager exited before lifecycle assertions completed')
    if (lastClose) assert.ok(finalIgnoreLoads, 'natural exit must be supervised without renderer load polling')
    assert.equal(alive(finalPid), false, 'final manager exit follows owned client shutdown')
    assert.equal(fs.existsSync(finalLaunchFile), false, 'final shutdown recovered the owned launch journal')
    assert.ok(sidecars.every(child => child.exitCode !== null || child.signalCode !== null), 'final manager exit stops owned gateway processes')
    assert.ok(alive(unrelatedChild.pid), 'manager must leave the unrelated fixture alive')
    passed = true
    clearTimeout(timeout)
    console.log(`Tray lifecycle smoke passed [${lastClose ? 'last-close' : 'explicit'}]: recovered/starting/running/error ownership, Cmd+Q, application/tray Quit, background loopback API, foreground reopen and isolated final cleanup`)
  } catch (error) {
    event.preventDefault()
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})
app.on('quit', () => { if (!passed) console.error('Tray lifecycle smoke failed: no passed marker before process exit') })
if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') {
  app.on('before-quit', () => console.log('tray event: before-quit'))
  app.on('activate', () => console.log('tray event: activate'))
}
app.on('browser-window-created', (_event, window) => {
  if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') {
    window.on('show', () => console.log('tray window: show'))
    window.on('hide', () => console.log('tray window: hide'))
  }
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    if (finished) return
    finished = true
    let upstream
    const invoke = (method, input) => window.webContents.executeJavaScript(`window.manager.${method}(${input === undefined ? '' : JSON.stringify(input)})`)
    const wait = async predicate => { const end = Date.now() + 12000; for (;;) { const result = await predicate(); if (result) return result; assert.ok(Date.now() < end, 'tray lifecycle condition timed out'); await delay(40) } }
    const clickMenu = item => { assert.ok(item, 'requested menu action is implemented'); assert.equal(typeof item.click, 'function'); item.click(item, window, {}) }
    const reopen = async method => {
      if (method === 'tray') clickMenu(trayMenu?.items.find(item => item.label === '显示主窗口'))
      else app.emit(method === 'second-instance' ? 'second-instance' : 'activate', {}, [], root)
      await wait(() => window.isVisible())
      assert.equal(window.isDestroyed(), false)
      if (process.platform === 'darwin') { await dockShowTask; await wait(() => app.dock.isVisible()) }
    }
    const applicationQuit = () => {
      const menu = Menu.getApplicationMenu()
      const quit = menu?.items[0].submenu?.items.find(item => item.role === 'quit' || item.label === '退出 Agent Manager Lite')
      assert.ok(quit, 'application menu exposes its normal Quit action')
      // Native macOS roles execute through NSApplication, not MenuItem.click.
      if (process.platform === 'darwin' && quit.role === 'quit') Menu.sendActionToFirstResponder('terminate:')
      else clickMenu(quit)
    }
    const ordinaryTrayQuit = () => clickMenu(trayMenu?.items.find(item => item.enabled !== false && /^退出\s/.test(item.label) && !/停止/.test(item.label)))
    const assertPreserved = async (quit, pid, reopenMethod, request) => {
      if (process.env.CML_TEST_TRAY_DOCK_TRACE === '1') console.log('tray action:', quit.name || 'CmdQ')
      quit(); await delay(150)
      assert.equal(window.isDestroyed(), false, 'ordinary Quit must retain instance runtime supervision')
      assert.equal(window.isVisible(), false, 'ordinary Quit leaves the foreground interface')
      if (process.platform === 'darwin') await wait(() => !app.dock.isVisible())
      if (pid) assert.ok(alive(pid), 'ordinary Quit preserves the owned client')
      if (request) {
        // Cross the gateway parent monitor's 2-second interval while the UI is
        // still hidden. A retained client with a dead API is not a passing case.
        await delay(2300)
        if (pid) assert.ok(alive(pid)); await request()
      }
      await reopen(reopenMethod)
    }
    const preserveAllQuitPaths = async (pid, request) => {
      window.show(); window.close(); await delay(100)
      assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false)
      if (pid) assert.ok(alive(pid))
      await reopen('tray')
      await assertPreserved(() => app.quit(), pid, 'second-instance', request)
      await assertPreserved(applicationQuit, pid, 'activate', request)
      await assertPreserved(ordinaryTrayQuit, pid, 'tray', request)
    }
    try {
      let current = await invoke('load'), recovered = current.instances.find(value => value.id === recoveredId)
      assert.equal(recovered.status, 'error'); assert.equal(recovered.pid, recoveredChild.pid)
      await preserveAllQuitPaths(recovered.pid)
      await invoke('stopInstance', recoveredId); await wait(() => !alive(recoveredChild.pid))
      current = await invoke('saveSettings', { ...current.settings, closeToTray: true })
      window.close(); await delay(100); assert.equal(window.isVisible(), false)
      const persisted = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(root, 'state.vault'))))
      assert.equal(persisted.settings.closeToTray, true); assert.ok(testVaultStats().encryptions > 0)
      await reopen('tray'); await invoke('saveSettings', { ...current.settings, closeToTray: false })
      upstream = createServer(async (req, res) => { for await (const chunk of req) {} res.setHeader('Content-Type', 'application/json'); res.end('{"id":"tray-fixture","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}') })
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      current = await invoke('addAccount', { name: 'Tray local fixture', apiKey: 'fixture-local-only', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', tags: [], note: '' })
      const account = current.accounts.find(value => value.name === 'Tray local fixture')
      current = await invoke('saveInstance', { details: { clientType: 'codex', name: 'Tray lifecycle fixture', applicationId, accountId: account.id, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] } })
      let instance = current.instances.find(value => value.name === 'Tray lifecycle fixture')
      finalLaunchFile = join(root, 'instances', instance.id, 'launch.json')
      const { parseTOML, getStaticTOMLValue } = await import('toml-eslint-parser')
      const request = async () => {
        const provider = getStaticTOMLValue(parseTOML(fs.readFileSync(join(instance.directory, 'config.toml'), 'utf8'))).model_providers.cml_instance
        const response = await fetch(provider.base_url + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + provider.experimental_bearer_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model', input: 'isolated lifecycle probe' }), signal: AbortSignal.timeout(6000) })
        assert.equal(response.status, 200); assert.equal((await response.json()).id, 'tray-fixture')
      }
      const start = async () => { const preview = await invoke('previewInstanceLaunch', { id: instance.id, revision: instance.revision }); await invoke('startInstance', preview.ticket) }
      holdOpen = true; await start(); await wait(() => releaseOpen)
      current = await invoke('load'); assert.equal(current.instances.find(value => value.id === instance.id).status, 'starting')
      await preserveAllQuitPaths(undefined, request); releaseOpen()
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'running' && value })
      finalPid = instance.pid
      await request(); await preserveAllQuitPaths(instance.pid, request)
      // Reopen before Electron's delayed Dock-hide workaround fires. Its
      // pending callback must not hide a manager the user already reopened.
      app.quit(); await delay(50); await reopen('tray'); await delay(1250)
      assert.equal(window.isVisible(), true)
      if (process.platform === 'darwin') assert.equal(app.dock.isVisible(), true)
      assert.ok(alive(instance.pid)); await request()
      assert.equal(sidecars.length, 1, 'only the isolated instance gateway was captured')
      sidecars[0].kill('SIGTERM')
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'error' && value })
      assert.ok(alive(instance.pid)); await preserveAllQuitPaths(instance.pid)
      await invoke('stopInstance', instance.id); await wait(() => !alive(finalPid))
      await start()
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'running' && value })
      finalPid = instance.pid
      await request()
      if (lastClose) {
        // Do not call IPC load/stop after entering background mode: the main
        // process itself must detect the client's natural exit and recover.
        await assertPreserved(() => app.quit(), finalPid, 'tray', request)
        app.quit(); await delay(150); assert.equal(window.isVisible(), false)
        assert.ok(alive(finalPid)); await request()
        await new Promise(resolve => upstream.close(resolve)); upstream = undefined
        finalIgnoreLoads = true
        readyForFinalQuit = true
        signalFixture(finalPid, 'SIGTERM')
        return
      }
      await new Promise(resolve => upstream.close(resolve)); upstream = undefined
      const quit = trayMenu?.items.find(item => /退出/.test(item.label) && /停止/.test(item.label))
      assert.ok(quit, 'explicit stop-and-quit is available in the tray')
      readyForFinalQuit = true; clickMenu(quit)
    } catch (error) {
      console.error(error)
      if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
      clearTimeout(timeout); app.exit(1)
    }
  })
})
require('../out/main/index.js')
