import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldHideOnClose } from '../src/main/trayPolicy'

test('tray close policy hides only for a configured ordinary window close', () => {
  assert.equal(shouldHideOnClose({ closeToTray: false, explicitQuit: false }), false)
  assert.equal(shouldHideOnClose({ closeToTray: true, explicitQuit: false }), true)
  assert.equal(shouldHideOnClose({ closeToTray: true, explicitQuit: true }), false)
})
