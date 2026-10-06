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
if (result.status !== 0) process.exit(result.status ?? 1)
if (process.platform === 'darwin') {
  const snapshot = spawnSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror',
    'sidecars/profile-snapshot/main.c', '-o', resolve(directory, 'codex-profile-snapshot')], { stdio: 'inherit' })
  if (snapshot.error) throw snapshot.error
  if (snapshot.status !== 0) process.exit(snapshot.status ?? 1)
}
