// Run lifecycle regressions outside Electron so premature clean exits and a
// blocked main process cannot be mistaken for successful lifecycle validation.
const cp = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const workspace = resolve(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let activeCleanup

function ownedFixtures(directory) {
  const executable = join(fs.realpathSync(directory), 'Fixture.app', 'Contents/MacOS/Codex')
  const result = cp.execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,args='], { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024 })
  return result.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match || !match[2].includes(executable) || !/--cml-instance=[a-f0-9-]{36}(?:\s|$)/.test(match[2])) return []
    const pid = Number(match[1])
    try {
      const command = cp.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim()
      return command === executable ? [pid] : []
    } catch { return [] }
  })
}

async function run(lastClose) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'codex-manager-ui-'))
  const env = { ...process.env, CML_TEST_DATA_DIR: directory, CML_TEST_SYSTEM_KEYCHAIN: '0', CML_TEST_TRAY_LAST_CLOSE: lastClose ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = cp.spawn(require('electron'), [resolve(__dirname, 'smoke-tray.cjs')], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const marker = `Tray lifecycle smoke passed [${lastClose ? 'last-close' : 'explicit'}]:`
  let output = '', timedOut = false, closed = false, cleaning
  const kill = () => {
    if (!child.pid || process.platform === 'win32' && closed) return
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  const cleanup = () => cleaning ??= (async () => {
    clearTimeout(timer)
    kill()
    // LaunchServices places desktop clients outside the Electron process
    // group. Match the exact executable in this newly created temporary home;
    // never signal an installed user client or rely on its product name.
    try {
      for (const pid of ownedFixtures(directory)) {
        try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        if (!ownedFixtures(directory).length) break
        await delay(100)
      }
      assert.equal(ownedFixtures(directory).length, 0, 'isolated LaunchServices fixtures survived smoke cleanup')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })()
  activeCleanup = cleanup
  const timer = setTimeout(() => {
    timedOut = true
    console.error('Tray lifecycle smoke exceeded 95 seconds; stopping its isolated process group and fixture clients.')
    kill()
  }, 95_000)
  const collect = (stream, sink) => stream.on('data', chunk => {
    sink.write(chunk)
    output += chunk.toString()
    if (output.length > 128000) output = output.slice(-128000)
  })
  collect(child.stdout, process.stdout); collect(child.stderr, process.stderr)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => { closed = true; resolve(code) })
    })
    assert.equal(timedOut, false, 'tray lifecycle runner timed out')
    assert.equal(code, 0, 'tray lifecycle Electron process failed')
    assert.ok(output.includes(marker), 'Electron exited without completing the tray lifecycle assertions')
  } finally {
    await cleanup()
    activeCleanup = undefined
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  Promise.resolve(activeCleanup?.()).catch(error => console.error(error)).finally(() => process.exit(1))
})
;(async () => {
  if (process.platform !== 'darwin') throw new Error('Tray lifecycle smoke requires macOS LaunchServices')
  if (process.argv.includes('--last-close')) await run(true)
  else if (process.argv.includes('--explicit')) await run(false)
  else { await run(false); await run(true) }
})().catch(error => { console.error(error); process.exitCode = 1 })
