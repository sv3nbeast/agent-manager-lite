import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLaunchAtLogin } from '../src/main/loginItem'

test('launch-at-login preference is applied at the Electron boundary', () => {
  const calls: { openAtLogin: boolean }[] = []
  applyLaunchAtLogin({ setLoginItemSettings: options => calls.push(options) }, true)
  applyLaunchAtLogin({ setLoginItemSettings: options => calls.push(options) }, false)
  assert.deepEqual(calls, [{ openAtLogin: true }, { openAtLogin: false }])
})
