import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldHideOnClose, shouldPreserveInstancesOnQuit } from '../src/main/trayPolicy'

test('tray close policy hides only for a configured ordinary window close', () => {
  assert.equal(shouldHideOnClose({ closeToTray: false, explicitQuit: false }), false)
  assert.equal(shouldHideOnClose({ closeToTray: true, explicitQuit: false }), true)
  assert.equal(shouldHideOnClose({ closeToTray: true, explicitQuit: true }), false)
})

test('an active instance keeps the manager resident even without tray preference', () => {
  assert.equal(shouldHideOnClose({ closeToTray: false, explicitQuit: false, activeInstances: true }), true)
  assert.equal(shouldHideOnClose({ closeToTray: false, explicitQuit: true, activeInstances: true }), false)
  assert.equal(shouldHideOnClose({ closeToTray: false, explicitQuit: false, activeInstances: false }), false)
})

test('ordinary Quit preserves instance ownership while explicit stop-and-quit completes shutdown', () => {
  assert.equal(shouldPreserveInstancesOnQuit({ explicitQuit: false, activeInstances: true }), true)
  assert.equal(shouldPreserveInstancesOnQuit({ explicitQuit: true, activeInstances: true }), false)
  assert.equal(shouldPreserveInstancesOnQuit({ explicitQuit: false, activeInstances: false }), false)
  assert.equal(shouldPreserveInstancesOnQuit({ explicitQuit: false }), false)
})
