import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(repositoryRoot, 'package.json'))
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
const required = {
  yauzl: '3.4.0',
  yazl: '3.3.1',
  pend: '1.2.0',
  'buffer-crc32': '1.0.0',
  'eslint-visitor-keys': '5.0.1',
}
const failures = []
const nodeModules = resolve(repositoryRoot, 'node_modules')
try {
  if (lstatSync(nodeModules).isSymbolicLink()) {
    failures.push(`node_modules is a symbolic link (${nodeModules}); run npm ci in this checkout before packaging`)
  }
} catch (error) {
  failures.push(`node_modules is unavailable: ${error.message}`)
}
for (const [name, version] of Object.entries(required)) {
  if (packageJson.dependencies?.[name] !== version) {
    failures.push(`package.json must declare ${name}@${version} as a production dependency`)
  }
  try {
    require.resolve(name)
    const installed = JSON.parse(readFileSync(resolve(nodeModules, name, 'package.json'), 'utf8'))
    if (installed.version !== version) failures.push(`${name} resolved to ${installed.version}, expected ${version}`)
    require(name)
  } catch (error) {
    failures.push(`${name} cannot be loaded: ${error.message}`)
  }
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const listing = spawnSync(npm, ['ls', '--omit=dev', '--all'], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
if (listing.error) failures.push(`npm ls failed to start: ${listing.error.message}`)
else if (listing.status !== 0) {
  const output = `${listing.stdout || ''}${listing.stderr || ''}`.trim().replace(/\s+/g, ' ')
  const excerpt = output.length > 8_000 ? `${output.slice(0, 8_000)}…` : output
  failures.push(`npm ls --omit=dev --all failed (exit ${listing.status}): ${excerpt}`)
}
if (failures.length) {
  console.error(`Packaging dependency preflight failed:\n${failures.map(value => `- ${value}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Packaging dependency preflight passed (${Object.keys(required).length} runtime modules)`)
}
