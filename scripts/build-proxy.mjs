import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = resolve('resources/bin')
mkdirSync(directory, { recursive: true })
const output = resolve(directory, process.platform === 'win32' ? 'codex-proxy.exe' : 'codex-proxy')
const result = spawnSync('go', ['build', '-trimpath', '-o', output, '.'], {
  cwd: resolve('sidecars/codex-proxy'), stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' }
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
