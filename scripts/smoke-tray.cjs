// Isolated lifecycle regression: never starts or stops an installed user client.
const { app, safeStorage, dialog, Tray } = require('electron')
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
fs.writeFileSync(join(recoveredFolder, 'launch.json'), JSON.stringify({ nonce, connectionMode: 'local_api' }))
fs.writeFileSync(join(root, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, closeToTray: false }, groups: [],
  accounts: [{ id: accountId, revision: 0, generation: randomUUID(), name: 'Recovery fixture', kind: 'api_key', baseUrl: 'http://127.0.0.1:9/v1', wireApi: 'responses', tags: [], note: '', defaultTier: 'inherit', models: ['fixture-model'], createdAt: Date.now(), credentials: { apiKey: 'fixture-only' } }],
  instanceApplications: [{ id: applicationId, clientType: 'codex', name: 'Fixture', path: application, kind: 'desktop' }],
  instances: [{ id: recoveredId, clientType: 'codex', revision: 0, createdAt: Date.now(), name: 'Recovered fixture', applicationId, accountId, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] }]
})), { mode: 0o600 })

let trayMenu, releaseOpen, holdOpen = false, finished = false, passed = false, finalPid
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
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [application] })
const timeout = setTimeout(() => { console.error('tray lifecycle smoke timed out'); app.exit(1) }, 75_000)
process.on('exit', () => {
  if (recoveredChild.exitCode === null && recoveredChild.signalCode === null) recoveredChild.kill('SIGKILL')
  for (const child of sidecars) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (!passed && finalPid && alive(finalPid)) process.kill(finalPid, 'SIGKILL')
})
app.on('will-quit', () => {
  if (!passed) return
  assert.equal(alive(finalPid), false, 'explicit tray exit stops the owned desktop client')
  assert.ok(sidecars.every(child => child.exitCode !== null || child.signalCode !== null), 'explicit tray exit stops gateway processes')
  clearTimeout(timeout)
  console.log('Tray lifecycle smoke passed: recovered error/live PID, close during launch, Cmd+Q, continuing loopback API, gateway failure/live desktop, persisted preference and ' + (lastClose ? 'ordinary shutdown after the last instance stops' : 'explicit tray shutdown'))
})
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    if (finished) return
    finished = true
    let upstream
    const invoke = (method, input) => window.webContents.executeJavaScript(`window.manager.${method}(${input === undefined ? '' : JSON.stringify(input)})`)
    const wait = async predicate => { const end = Date.now() + 10000; for (;;) { const result = await predicate(); if (result) return result; assert.ok(Date.now() < end, 'tray lifecycle condition timed out'); await delay(40) } }
    const hideAndQuit = async pid => {
      window.show(); window.close(); await delay(100)
      assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false); if (pid) assert.ok(alive(pid))
      window.show(); app.quit(); await delay(100)
      assert.equal(window.isDestroyed(), false, 'normal Cmd+Q path must preserve the manager'); assert.equal(window.isVisible(), false); if (pid) assert.ok(alive(pid))
      window.show()
    }
    try {
      let current = await invoke('load'), recovered = current.instances.find(value => value.id === recoveredId)
      assert.equal(recovered.status, 'error'); assert.equal(recovered.pid, recoveredChild.pid)
      await hideAndQuit(recovered.pid)
      await invoke('stopInstance', recoveredId); await wait(() => !alive(recoveredChild.pid))
      current = await invoke('saveSettings', { ...current.settings, closeToTray: true })
      window.close(); await delay(100); assert.equal(window.isVisible(), false)
      const persisted = JSON.parse(safeStorage.decryptString(fs.readFileSync(join(root, 'state.vault'))))
      assert.equal(persisted.settings.closeToTray, true); assert.ok(testVaultStats().encryptions > 0)
      window.show(); await invoke('saveSettings', { ...current.settings, closeToTray: false })
      upstream = createServer(async (req, res) => { for await (const chunk of req) {} res.setHeader('Content-Type', 'application/json'); res.end('{"id":"tray-fixture","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}') })
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      current = await invoke('addAccount', { name: 'Tray local fixture', apiKey: 'fixture-local-only', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', tags: [], note: '' })
      const account = current.accounts.find(value => value.name === 'Tray local fixture')
      current = await invoke('saveInstance', { details: { clientType: 'codex', name: 'Tray lifecycle fixture', applicationId, accountId: account.id, connectionMode: 'local_api', defaultTier: 'inherit', model: 'fixture-model', extraArgs: [] } })
      let instance = current.instances.find(value => value.name === 'Tray lifecycle fixture')
      const start = async () => { const preview = await invoke('previewInstanceLaunch', { id: instance.id, revision: instance.revision }); await invoke('startInstance', preview.ticket) }
      holdOpen = true; await start(); await wait(() => releaseOpen)
      current = await invoke('load'); assert.equal(current.instances.find(value => value.id === instance.id).status, 'starting')
      await hideAndQuit(); releaseOpen()
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'running' && value })
      finalPid = instance.pid
      const { parseTOML, getStaticTOMLValue } = await import('toml-eslint-parser')
      const provider = getStaticTOMLValue(parseTOML(fs.readFileSync(join(instance.directory, 'config.toml'), 'utf8'))).model_providers.cml_instance
      const request = async () => { const response = await fetch(provider.base_url + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + provider.experimental_bearer_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model', input: 'isolated lifecycle probe' }) }); assert.equal(response.status, 200); await response.text() }
      await request(); await hideAndQuit(instance.pid)
      // Cross the sidecar's parent-monitor polling interval before proving
      // that closing the manager still leaves this local connection usable.
      await delay(2300); assert.ok(alive(instance.pid)); await request()
      assert.equal(sidecars.length, 1, 'only the isolated instance gateway was captured')
      sidecars[0].kill('SIGTERM')
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'error' && value })
      assert.ok(alive(instance.pid)); await hideAndQuit(instance.pid)
      await invoke('stopInstance', instance.id); await wait(() => !alive(finalPid))
      await start()
      instance = await wait(async () => { const value = (await invoke('load')).instances.find(value => value.id === instance.id); return value.status === 'running' && value })
      finalPid = instance.pid
      await new Promise(resolve => upstream.close(resolve)); upstream = undefined
      if (lastClose) {
        await invoke('stopInstance', instance.id); await wait(() => !alive(finalPid))
        passed = true; window.close(); return
      }
      const quit = trayMenu?.items.find(item => item.label === '退出并停止运行实例')
      assert.ok(quit, 'explicit stop-and-quit is available in the tray')
      passed = true; quit.click({}, {}, {})
    } catch (error) {
      console.error(error); await new Promise(resolve => upstream ? upstream.close(resolve) : resolve())
      clearTimeout(timeout); app.exit(1)
    }
  })
})
require('../out/main/index.js')
