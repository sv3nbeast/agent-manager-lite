import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstanceApplication } from '../src/shared/instances'
import { readCodexModelClientVersion } from '../src/main/codexModelClientVersion'

const supported = process.platform === 'darwin' || process.platform === 'linux'
const build = realpathSync(mkdtempSync(join(tmpdir(), 'cml-model-version-test-build-')))
const binary = join(build, 'version-fixture')
if (supported) {
  const source = join(build, 'fixture.c')
  writeFileSync(source, String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "--version")) return 99;
  char path[8192], cwd[8192], mode[100] = "";
  snprintf(path, sizeof(path), "%s.evidence", argv[0]);
  FILE *f = fopen(path, "w");
  if (!f) return 98;
  fprintf(f, "home=%s\ncwd=%s\nsystemHome=%s\npid=%d\ncode=%s\nnode=%s\nopenai=%s\n", getenv("CODEX_HOME"), getcwd(cwd, sizeof(cwd)), getenv("HOME"), getpid(), getenv("CODEX_MODEL_VERSION_FIXTURE_LEAK") ? getenv("CODEX_MODEL_VERSION_FIXTURE_LEAK") : "", getenv("NODE_MODEL_VERSION_FIXTURE_LEAK") ? getenv("NODE_MODEL_VERSION_FIXTURE_LEAK") : "", getenv("OPENAI_MODEL_VERSION_FIXTURE_LEAK") ? getenv("OPENAI_MODEL_VERSION_FIXTURE_LEAK") : "");
  fclose(f);
  snprintf(path, sizeof(path), "%s.mode", argv[0]);
  f = fopen(path, "r");
  if (f) { fgets(mode, sizeof(mode), f); fclose(f); }
  if (!strcmp(mode, "slow")) sleep(30);
  if (!strcmp(mode, "failure")) { fprintf(stderr, "fixture-private-diagnostic"); return 23; }
  if (!strcmp(mode, "large")) for (int i = 0; i < 70000; i++) putchar('x');
  snprintf(path, sizeof(path), "%s.output", argv[0]);
  f = fopen(path, "r");
  if (!f) return 97;
  int c;
  while ((c = fgetc(f)) != EOF) putchar(c);
  fclose(f);
  return 0;
}
`)
  execFileSync('cc', [source, '-o', binary], { timeout: 30000, stdio: 'pipe' })
}
after(() => rmSync(build, { recursive: true, force: true }))

function fixture(t: { after(fn: () => void): void }, kind: 'desktop' | 'cli' = 'desktop', output = 'codex-cli 0.153.4\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-model-version-test-')))
  const app = join(root, 'Fixture.app')
  const path = kind === 'cli' ? join(root, 'codex') : join(app, 'Contents', 'Resources', 'codex')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  // The desktop application advertises an unrelated UI version and fails if
  // executed. Only its bundled version fixture is allowed to run.
  writeFileSync(join(app, 'Contents', 'MacOS', 'Codex'), '#!/bin/sh\nexit 77\n', { mode: 0o700 })
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>26.930.51102</string></dict></plist>')
  copyFileSync(binary, path); chmodSync(path, 0o700)
  writeFileSync(path + '.output', output)
  writeFileSync(path + '.mode', '')
  const application: InstanceApplication = { clientType: 'codex', id: 'fixture', name: 'Fixture', path: kind === 'cli' ? path : app, kind }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const evidence = () => Object.fromEntries(readFileSync(path + '.evidence', 'utf8').trimEnd().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  return { root, path, application, evidence }
}

test('desktop model discovery reads bundled CLI semver in an empty isolated home and leaves HOME unchanged', { skip: !supported }, async t => {
  const f = fixture(t), names = ['CODEX_MODEL_VERSION_FIXTURE_LEAK', 'NODE_MODEL_VERSION_FIXTURE_LEAK', 'OPENAI_MODEL_VERSION_FIXTURE_LEAK']
  const previous = names.map(name => process.env[name])
  names.forEach(name => { process.env[name] = 'fixture-only-inherited' })
  try {
    assert.equal(await readCodexModelClientVersion(f.application, new AbortController().signal), '0.153.4')
    const evidence = f.evidence()
    assert.equal(evidence.home, evidence.cwd)
    assert.notEqual(evidence.home, process.env.CODEX_HOME)
    assert.equal(evidence.systemHome, process.env.HOME)
    assert.deepEqual([evidence.code, evidence.node, evidence.openai], ['', '', ''])
    assert.equal(existsSync(evidence.home), false)
    assert.equal(existsSync(join(f.root, 'auth.json')), false)
  } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] }) }
})

test('registered native CLI uses its actual runtime and preserves prerelease semver', { skip: !supported }, async t => {
  const f = fixture(t, 'cli', 'codex-cli 0.154.0-alpha.4+fixture\n')
  assert.equal(await readCodexModelClientVersion(f.application, new AbortController().signal), '0.154.0-alpha.4+fixture')
  assert.equal(existsSync(f.evidence().home), false)
})

test('new desktop bundles run the native CLI app instead of the shell launcher or desktop program', { skip: !supported }, async t => {
  const f = fixture(t), resources = join(f.application.path, 'Contents', 'Resources')
  const native = join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
  const launcher = join(resources, 'codex-cli', 'bin', 'codex')
  mkdirSync(join(native, '..'), { recursive: true }); mkdirSync(join(launcher, '..'), { recursive: true })
  copyFileSync(binary, native); chmodSync(native, 0o700)
  writeFileSync(native + '.output', 'codex-cli 0.162.0-alpha.2\n'); writeFileSync(native + '.mode', '')
  writeFileSync(launcher, '#!/bin/sh\nexit 78\n', { mode: 0o700 })
  rmSync(f.path)
  assert.equal(await readCodexModelClientVersion(f.application, new AbortController().signal), '0.162.0-alpha.2')
  assert.equal(existsSync(native + '.evidence'), true)
  assert.equal(existsSync(f.path + '.evidence'), false)
  const home = readFileSync(native + '.evidence', 'utf8').split('\n').find(line => line.startsWith('home='))!.slice(5)
  assert.equal(existsSync(home), false)
})

test('bundle-local CLI launcher symlinks are allowed only when they resolve to a native program inside Resources', { skip: !supported }, async t => {
  const f = fixture(t), resources = join(f.application.path, 'Contents', 'Resources')
  const native = join(resources, 'codex-cli', 'native', 'codex')
  const launcher = join(resources, 'codex-cli', 'bin', 'codex')
  mkdirSync(join(native, '..'), { recursive: true }); mkdirSync(join(launcher, '..'), { recursive: true })
  copyFileSync(binary, native); chmodSync(native, 0o700)
  writeFileSync(native + '.output', 'codex-cli 0.161.0\n'); writeFileSync(native + '.mode', '')
  symlinkSync('../native/codex', launcher)
  assert.equal(await readCodexModelClientVersion(f.application, new AbortController().signal), '0.161.0')
  assert.equal(existsSync(native + '.evidence'), true)
  assert.equal(existsSync(f.path + '.evidence'), false)
})

test('new-layout links escaping the selected bundle or pointing to the desktop program reject without executing a fallback', { skip: !supported }, async t => {
  const f = fixture(t), launcher = join(f.application.path, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')
  mkdirSync(join(launcher, '..'), { recursive: true })
  for (const target of [binary, join(f.application.path, 'Contents', 'MacOS', 'Codex')]) {
    symlinkSync(target, launcher)
    await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /缺少.*Codex CLI/)
    assert.equal(existsSync(f.path + '.evidence'), false)
    rmSync(launcher)
  }
})

test('malformed CLI output and process failures reject without fallback or raw diagnostics and clean temporary homes', { skip: !supported }, async t => {
  const f = fixture(t)
  for (const output of ['26.930.51102', 'codex-cli unknown', 'codex-cli 01.153.4', 'codex-cli 0.153.4\nextra-data', 'Codex 0.153.4']) {
    writeFileSync(f.path + '.output', output)
    await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /有效.*版本/)
    assert.equal(existsSync(f.evidence().home), false)
  }
  for (const mode of ['failure', 'large']) {
    writeFileSync(f.path + '.mode', mode)
    await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), error => error instanceof Error && /失败或超时/.test(error.message) && !error.message.includes('fixture-private-diagnostic'))
    assert.equal(existsSync(f.evidence().home), false)
  }
})

test('version process is killed after the bounded timeout and its temporary home is removed', { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t); writeFileSync(f.path + '.mode', 'slow')
  const start = Date.now()
  await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /失败或超时/)
  assert.ok(Date.now() - start < 8000)
  assert.equal(existsSync(f.evidence().home), false)
  assert.throws(() => process.kill(Number(f.evidence().pid), 0))
})

test('cancellation prevents execution or kills an in-flight version process and cleans only its temporary home', { skip: !supported, timeout: 5000 }, async t => {
  const f = fixture(t), before = new AbortController()
  before.abort()
  await assert.rejects(readCodexModelClientVersion(f.application, before.signal), { name: 'AbortError' })
  assert.equal(existsSync(f.path + '.evidence'), false)
  writeFileSync(f.path + '.mode', 'slow')
  const control = new AbortController(), task = readCodexModelClientVersion(f.application, control.signal)
  // Wait only for the synthetic child to enter its isolated directory.
  const end = Date.now() + 2000
  while (!existsSync(f.path + '.evidence')) {
    if (Date.now() > end) throw new Error('Synthetic version process did not start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  control.abort()
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(existsSync(f.evidence().home), false)
  assert.throws(() => process.kill(Number(f.evidence().pid), 0))
  assert.equal(existsSync(f.path), true)
})

test('missing, linked and non-executable bundled CLIs reject before execution; unsupported clients do not fall back', { skip: !supported }, async t => {
  const f = fixture(t)
  chmodSync(f.path, 0o600)
  await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /缺少.*Codex CLI/)
  rmSync(f.path)
  await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /缺少.*Codex CLI/)
  symlinkSync(binary, f.path)
  await assert.rejects(readCodexModelClientVersion(f.application, new AbortController().signal), /缺少.*Codex CLI/)
  assert.equal(existsSync(f.path + '.evidence'), false)
  await assert.rejects(readCodexModelClientVersion({ ...f.application, clientType: 'unknown' } as unknown as InstanceApplication, new AbortController().signal), /尚未接入/)
})
