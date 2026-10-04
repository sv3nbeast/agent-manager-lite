import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const tag = process.argv[2]
assert.ok(typeof tag === 'string' && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag), 'Use a version tag such as v0.1.1 or v0.2.0-beta.1')
const prerelease = tag.slice(1).split('-').slice(1).join('-')
assert.ok(!prerelease || prerelease.split('.').every(value => !/^\d+$/.test(value) || /^(?:0|[1-9]\d*)$/.test(value)), 'Numeric prerelease identifiers cannot have leading zeros')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
assert.equal(tag, `v${pkg.version}`, 'Tag must match package.json version')
assert.equal(lock.version, pkg.version, 'Lockfile version must match package.json')
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root package version must match')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
assert.equal(git('rev-parse', `refs/tags/${tag}^{commit}`), git('rev-parse', 'HEAD'), 'Build the exact existing tag commit')
git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main')
console.log(`Verified ${tag}: package, lockfile, tag commit and main ancestry`)
