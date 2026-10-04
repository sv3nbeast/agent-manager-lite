// A separate Node process can stop Electron even while macOS Keychain blocks its main thread.
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const directory = mkdtempSync(join(tmpdir(), 'codex-manager-ui-'))
// Real OS-keychain integration is an explicit, separate manual test. Never
// inherit this mode into ordinary regression runs from the user's shell.
const systemKeychain = process.argv.includes('--system-keychain')
const env = { ...process.env, CML_TEST_DATA_DIR: directory, CML_TEST_SYSTEM_KEYCHAIN: systemKeychain ? '1' : '0',CML_TEST_NODE_TUNNELS:process.argv.includes('--proxy-nodes')?'1':'0' }
delete env.ELECTRON_RUN_AS_NODE
const suite = process.argv.includes('--tray') ? 'smoke-tray.cjs' : process.argv.includes('--proxy-batch') ? 'smoke-proxy-batch.cjs' : process.argv.includes('--unified-proxy') ? 'smoke-unified-proxy.cjs' : process.argv.includes('--account-proxy') ? 'smoke-account-proxy.cjs' : process.argv.includes('--temp-login') ? 'smoke-temp-login.cjs' : process.argv.includes('--account-recycle') ? 'smoke-account-recycle.cjs' : process.argv.includes('--legacy-trash') ? 'smoke-legacy-session-trash.cjs' : process.argv.includes('--session-trash') ? 'smoke-session-trash.cjs' : process.argv.includes('--session-visibility') ? 'smoke-session-visibility.cjs' : process.argv.includes('--sessions') ? 'smoke-sessions.cjs' : process.argv.includes('--client-identity') ? 'smoke-client-identity.cjs' : process.argv.includes('--local-access') ? 'smoke-local-access.cjs' : process.argv.includes('--instances') ? 'smoke-instances.cjs' : process.argv.includes('--provider-probes') ? 'smoke-provider-probes.cjs' : 'smoke-electron.cjs'
const selectedSuite=process.argv.includes('--upstream-proxy')?'smoke-upstream-proxy.cjs':process.argv.includes('--agent-manager')?'smoke-agent-manager.cjs':process.argv.includes('--account-cards')?'smoke-account-cards.cjs':process.argv.includes('--local-onboarding')?'smoke-local-onboarding.cjs':process.argv.includes('--product-polish')?'smoke-product-polish.cjs':process.argv.includes('--data-backups')?'smoke-data-backups.cjs':process.argv.includes('--quota-details')?'smoke-quota-details.cjs':process.argv.includes('--provider-usage')?'smoke-provider-usage.cjs':process.argv.includes('--fast-settings')?'smoke-fast-settings.cjs':process.argv.includes('--proxy-strategy')?'smoke-proxy-strategy.cjs':process.argv.includes('--proxy-subscriptions')?'smoke-proxy-subscriptions.cjs':process.argv.includes('--proxy-catalog')?'smoke-proxy-catalog.cjs':process.argv.includes('--proxy-nodes')?'smoke-proxy-batch.cjs':process.argv.includes('--proxy-engine')?'smoke-proxy-engine.cjs':suite
const child = spawn(require('electron'), [resolve(__dirname, selectedSuite)], {
  cwd: resolve(__dirname, '..'), env, stdio: 'inherit', detached: process.platform !== 'win32'
})
let timedOut = false
function kill() {
  if (!child.pid) return
  try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
}
const timer = setTimeout(() => {
  timedOut = true
  console.error('Desktop smoke exceeded 90 seconds; stopping its isolated process group.')
  kill()
}, 90_000)
const cleanup = () => { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }) }
child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1 })
child.once('exit', code => { cleanup(); process.exitCode = timedOut ? 1 : code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { kill(); cleanup(); process.exit(1) })
