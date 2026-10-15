import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MacDesktopRuntime, type DesktopPlan } from '../src/main/instanceRuntime'

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-child-')))
  const pidFile = join(root, 'pid'), executable = join(root, 'child')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['home', 'desktop', 'workspace', 'desktop-home/tmp']) mkdirSync(join(root, name), { recursive: true })
  const quoted = "'" + pidFile.replaceAll("'", "'\"'\"'") + "'"
  // This owned child deliberately drops the launch argv. Discovery cannot
  // recover it; failed startup must still terminate the actual spawned child.
  writeFileSync(executable, `#!/bin/sh\nprintf '%s' "$$" > ${quoted}\nexec /bin/sleep 30\n`, { mode: 0o700 })
  const plan: DesktopPlan = { clientType: 'claude_code', mode: 'desktop', application: '/Applications/Fixture Claude.app', executable,
    directory: join(root, 'home'), desktopDirectory: join(root, 'desktop'), workingDirectory: join(root, 'workspace'), args: [], nonce: 'owned-fixture' }
  const waitPid = async () => {
    const deadline = Date.now() + 3000
    while (!existsSync(pidFile) && Date.now() < deadline) await delay(20)
    assert.ok(existsSync(pidFile))
    return Number(readFileSync(pidFile, 'utf8'))
  }
  return { plan, waitPid }
}

test('Desktop discovery failure reaps its own child even after argv changes', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t)
  class UnavailableDiscovery extends MacDesktopRuntime {
    override async find() { await f.waitPid(); throw new Error('synthetic discovery failure') }
  }
  const runtime = new UnavailableDiscovery(async () => {})
  await assert.rejects(runtime.launch(f.plan, new AbortController().signal), /synthetic discovery failure/)
  const pid = await f.waitPid()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('Desktop cancellation before discovery promptly reaps its own child', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), controller = new AbortController()
  class UnmatchedDiscovery extends MacDesktopRuntime {
    override async find() { await f.waitPid(); controller.abort(); return undefined }
  }
  const runtime = new UnmatchedDiscovery(async () => {}), started = Date.now()
  await assert.rejects(runtime.launch(f.plan, controller.signal), /启动已取消/)
  assert.ok(Date.now() - started < 8000, 'Cancellation must not wait for the discovery timeout')
  const pid = await f.waitPid()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
