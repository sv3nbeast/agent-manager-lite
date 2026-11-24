const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, realpathSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')
const { extractFile } = require('@electron/asar')

function assertUpdaterOptOut(bootstrap) {
  // Match the shared update policy and its macOS caller, independent of the
  // client version and minified function name. Unknown policies stop the smoke.
  const guard = bootstrap.match(/(?:^|[,;])([\w$]+)=\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)=>["']false["']!==\5\.CODEX_SPARKLE_ENABLED&&[\w$]+\.includes\(\2\)&&\3===\4(?=[,;])/)
  const mac = bootstrap.match(/shouldIncludeSparkle:\(([\w$]+),([\w$]+),([\w$]+)=process\.env\)=>([\w$]+)\(\1,\2,["']darwin["'],\3\)(?=[,}])/)
  assert.ok(guard && mac && mac[4] === guard[1], 'Cannot verify the macOS updater opt-out in this client. No desktop was launched.')
}

async function withTestApplication(source, run) {
  assert.equal(process.platform, 'darwin')
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cml-ui-test-app-'))
  try {
    const installed = realpathSync(source)
    const application = join(root, basename(installed))
    execFileSync('/bin/cp', ['-cR', installed, application])
    const resources = 'Contents/Resources/app.asar'
    const archive = join(application, resources)
    assert.equal(realpathSync(archive), archive)
    const original = statSync(join(installed, resources)), copy = statSync(archive)
    assert.ok(original.dev !== copy.dev || original.ino !== copy.ino, 'Desktop test requires a separate app bundle')
    assertUpdaterOptOut(extractFile(archive, '.vite/build/early-bootstrap.js').toString('utf8'))
    return await run(application)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

module.exports = { assertUpdaterOptOut, withTestApplication }
