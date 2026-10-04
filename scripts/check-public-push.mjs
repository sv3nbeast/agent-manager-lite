import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checker = fileURLToPath(new URL('./check-public-repository.mjs', import.meta.url))
const commits = new Set()
for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
  const [, localObject] = line.split(/\s+/)
  if (/^0+$/.test(localObject ?? '')) continue
  if (!/^[a-f0-9]{40,64}$/.test(localObject ?? '')) throw new Error('Invalid push object')
  commits.add(execFileSync('git', ['rev-parse', `${localObject}^{commit}`], { encoding: 'utf8' }).trim())
  const revisions = execFileSync('git', ['rev-list', localObject, '--not', '--remotes=origin'], { encoding: 'utf8' })
  for (const revision of revisions.trim().split('\n').filter(Boolean)) commits.add(revision)
}
const directory = mkdtempSync(join(tmpdir(), 'agent-public-push-'))
const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
try {
  for (const commit of commits) {
    execFileSync('git', ['read-tree', commit], { env })
    const result = spawnSync(process.execPath, [checker], { env, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Push blocked: commit ${commit} contains local-only data or could not be verified`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
