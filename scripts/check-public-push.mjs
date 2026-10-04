import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateContentIssues } from './public-repository-policy.mjs'

const checker = fileURLToPath(new URL('./check-public-repository.mjs', import.meta.url))
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const zeroPattern = /^(?:0{40}|0{64})$/

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitObject(objectId) {
  const result = git(['rev-parse', `${objectId}^{commit}`])
  if (!objectIdPattern.test(result)) throw new Error('Invalid commit object')
  return result
}

function checkMetadata(objectId, type) {
  const issues = privateContentIssues(git(['cat-file', type, objectId]), { checkDocumentReferences: true })
  if (issues.length) throw new Error(`Push blocked: ${type} ${objectId} contains ${issues.join(', ')}`)
}

function checkPush() {
  const commits = new Set(), tips = new Set(), frontiers = new Set(), tags = new Set()
  for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
    const fields = line.split(/\s+/)
    if (fields.length !== 4 || !objectIdPattern.test(fields[1]) || !objectIdPattern.test(fields[3])) {
      throw new Error('Invalid push update')
    }
    const [, localObject, , remoteObject] = fields
    if (zeroPattern.test(localObject)) continue
    tips.add(commitObject(localObject))
    // Trust only objects advertised by this actual push target. A stale or
    // unrelated remote-tracking ref must never hide newly published history.
    if (!zeroPattern.test(remoteObject)) {
      try { frontiers.add(commitObject(remoteObject)) } catch { /* Unknown target object: inspect all ancestors. */ }
    }
    let object = localObject
    while (git(['cat-file', '-t', object]) === 'tag') {
      if (tags.has(object)) break
      tags.add(object)
      const match = git(['cat-file', 'tag', object]).match(/^object ([a-f0-9]{40}|[a-f0-9]{64})\n/)
      if (!match) throw new Error('Invalid annotated tag object')
      object = match[1]
    }
  }

  for (const tip of tips) commits.add(tip)
  if (tips.size) {
    const revisions = git(['rev-list', ...tips, ...(frontiers.size ? ['--not', ...frontiers] : [])])
    for (const revision of revisions.split('\n').filter(Boolean)) commits.add(revision)
  }
  for (const tag of tags) checkMetadata(tag, 'tag')

  const directory = mkdtempSync(join(tmpdir(), 'agent-public-push-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
  try {
    for (const commit of commits) {
      checkMetadata(commit, 'commit')
      execFileSync('git', ['read-tree', commit], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      const result = spawnSync(process.execPath, [checker], { env, stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`Push blocked: commit ${commit} contains local-only data or could not be verified`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

try {
  checkPush()
} catch (error) {
  // Keep raw Git output and rejected metadata out of the failure message.
  console.error(error instanceof Error && error.message.startsWith('Push blocked:') ? error.message : 'Push blocked: unable to verify the proposed Git objects')
  process.exitCode = 1
}
