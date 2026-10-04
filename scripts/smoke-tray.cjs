const { app, safeStorage } = require('electron')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const assert = require('node:assert/strict')

const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && resolve(directory).startsWith(resolve(tmpdir()) + sep), 'tray smoke must use a temporary data directory')
const testVaultStats = require('./test-vault.cjs').installTestVault(safeStorage)
let finished = false
const timeout = setTimeout(() => { console.error('tray smoke timed out'); app.exit(1) }, 20_000)

app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    if (finished) return
    finished = true
    try {
      const saved = await window.webContents.executeJavaScript("window.manager.saveSettings({theme:'light',defaultTier:'follow',port:16321,refreshMinutes:0,launchAtLogin:false,closeToTray:true})")
      assert.equal(saved.settings.closeToTray, true)
      assert.equal(window.isVisible(), true)
      window.close()
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(window.isVisible(), false, 'ordinary close should hide the window when tray mode is enabled')
      assert.ok(testVaultStats().encryptions > 0)
      const persisted = JSON.parse(safeStorage.decryptString(readFileSync(join(directory, 'state.vault'))))
      assert.equal(persisted.settings.closeToTray, true)
      console.log('Tray smoke passed: persisted preference hides ordinary close and keeps the app alive')
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
