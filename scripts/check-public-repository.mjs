import { execFileSync } from 'node:child_process'

const privatePaths = /^(?:docs|\.local|\.upstream|node_modules|out|dist|coverage|test-results|playwright-report|release(?:-[^/]+)?)\/|^(?:AGENTS\.md|TASK_PROMPT\.md|CHANGELOG\.md)$|^sidecars\/codex-proxy\/USAGE_ATTRIBUTION_REVIEW\.md$/
const privateFiles = /(?:^|\/)(?:auth\.json|\.env(?:\.(?!example$)[^/]+)?|[^/]+\.(?:vault|cmlbackup|sqlite(?:-shm|-wal)?|db|pem|key|dmg|log))$/

function indexedFiles() {
  const raw = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return raw.split('\0').filter(Boolean).map(entry => {
    const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/)
    if (!match) throw new Error('Unable to parse the repository index.')
    return { mode: match[1], objectId: match[2], stage: Number(match[3]), file: match[4] }
  })
}

function indexedBlobs(entries) {
  const ids = [...new Set(entries.map(entry => entry.objectId))]
  const blobs = new Map()
  if (!ids.length) return blobs
  // Read the exact staged objects, not potentially different working-tree files.
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    input: ids.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let offset = 0
  for (const id of ids) {
    const headerEnd = batch.indexOf(10, offset)
    if (headerEnd < 0) throw new Error('Incomplete index object header.')
    const header = batch.subarray(offset, headerEnd).toString('ascii')
    const match = header.match(/^([a-f0-9]{40}|[a-f0-9]{64}) blob (\d+)$/)
    if (!match || match[1] !== id) throw new Error('Unable to read an indexed blob.')
    const length = Number(match[2]), start = headerEnd + 1, end = start + length
    if (!Number.isSafeInteger(length) || end >= batch.length || batch[end] !== 10) {
      throw new Error('Incomplete index object contents.')
    }
    blobs.set(id, batch.subarray(start, end))
    offset = end + 1
  }
  if (offset !== batch.length) throw new Error('Unexpected index object contents.')
  return blobs
}

function checkRepository() {
  const entries = indexedFiles(), failures = [], inspect = []
  for (const entry of entries) {
    const { file, mode, stage } = entry
    if (stage !== 0) {
      failures.push(`${file}: unresolved index entry`)
    } else if (mode === '160000') {
      failures.push(`${file}: gitlink contents cannot be inspected`)
    } else if (!['100644', '100755', '120000'].includes(mode)) {
      failures.push(`${file}: unsupported index file mode`)
    } else if (privatePaths.test(file) || privateFiles.test(file)) {
      failures.push(`${file}: local-only file`)
    } else {
      inspect.push(entry)
    }
  }

  const blobs = indexedBlobs(inspect)
  for (const { file, objectId } of inspect) {
    const buffer = blobs.get(objectId)
    if (!buffer) throw new Error('Missing index object contents.')
    if (buffer.includes(0)) continue
    const content = buffer.toString('utf8')
    // Only synthetic account names used by source fixtures are allowed.
    if (/\/Users\/(?!example\/|alice\/|bob\/|Alice Smith\/)[^/\r\n]+\//.test(content)) {
      failures.push(`${file}: personal machine path`)
    }
    if (!file.endsWith('check-public-repository.mjs') && /docs\/(?:evidence\/|[A-Z][A-Z_]+\.md)/.test(content)) {
      // Smoke scripts may write local evidence; public docs must not link to it.
      if (/\.md$/.test(file) || file.startsWith('.github/')) failures.push(`${file}: private document reference`)
    }
  }

  if (failures.length) {
    console.error(`Public repository check failed:\n${[...new Set(failures)].join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`Public repository check passed (${entries.length} tracked files).`)
  }
}

try {
  checkRepository()
} catch {
  // An unreadable or malformed index must never be treated as a clean tree.
  console.error('Public repository check failed: unable to inspect the repository index.')
  process.exitCode = 1
}
