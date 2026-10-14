import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/main/store'
import { createAPIAccount } from '../src/main/accounts'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { prepareCodexSharedSkills } from '../src/main/codexSkills'
import { Gateway } from '../src/main/gateway'
import { Instances, type InstanceSkillsServices } from '../src/main/instances'
import type { DesktopPlan, DesktopProcess, DesktopRuntime } from '../src/main/instanceRuntime'
import { NativeInstanceAccounts } from '../src/main/nativeInstanceAccounts'
import { TokenAuthority } from '../src/main/tokens'

function skill(directory: string, name: string, body = `# ${name}\nSynthetic skill fixture.\n`) {
  const path = join(directory, name, 'SKILL.md')
  mkdirSync(join(directory, name), { recursive: true })
  writeFileSync(path, body)
  return path
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-skills-lifecycle-')))
  const sourceDirectory = join(root, 'personal-skills')
  skill(sourceDirectory, 'shared-first')
  const store = new Store(join(root, 'data'), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const account = createAPIAccount({ name: 'Synthetic API', apiKey: 'fixture-skills-not-a-real-key', baseUrl: 'http://127.0.0.1:9/v1', models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
  store.transaction(state => { state.accounts.push(account); state.upstreamProxy = { revision: 0, mode: 'direct' } })
  const tokens = new TokenAuthority(store, async () => assert.fail('Skills tests must never refresh against a real service'))
  const native = new NativeInstanceAccounts(store, tokens)
  const children = new Map<string, DesktopProcess>(), plans: DesktopPlan[] = [], gateways: Gateway[] = [], managers: Instances[] = []
  let onLaunch = (_plan: DesktopPlan) => {}
  // These in-memory processes never execute Codex, Claude, Terminal or a model request.
  const runtime: DesktopRuntime = {
    find: async plan => children.get(plan.nonce),
    launch: async (plan, signal) => {
      signal.throwIfAborted(); onLaunch(plan); plans.push(plan)
      const child = { pid: 47000 + plans.length, started: 'synthetic-skills-runtime' }
      children.set(plan.nonce, child)
      return child
    },
    stop: async plan => { children.delete(plan.nonce) },
    focus: async () => {},
  }
  const preparations: Parameters<typeof prepareCodexSharedSkills>[0][] = []
  const results: ReturnType<typeof prepareCodexSharedSkills>[] = []
  let prepareSkills: InstanceSkillsServices['prepare'] = options => prepareCodexSharedSkills({ ...options, sourceDirectory })
  let prepareAccount = async (id: string) => store.read().accounts.find(value => value.id === id)!
  const create = () => {
    const instances = new Instances(store, () => {
      const gateway = new Gateway(resolve('resources/bin/codex-proxy'), join(root, 'runtime'))
      gateways.push(gateway)
      return gateway
    }, id => prepareAccount(id), runtime, native, undefined, undefined, ['en-US'], undefined, undefined, {
      prepare: options => { preparations.push(options); const result = prepareSkills(options); results.push(result); return result },
    })
    managers.push(instances)
    return instances
  }
  const instances = create(), application = join(root, 'Fixture.app'), cli = join(root, 'codex-fixture')
  mkdirSync(join(application, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(application, 'Contents', 'MacOS', 'Codex'), 'fixture-never-executed', { mode: 0o700 })
  // Static native header satisfies registration; the runtime above owns every launch.
  writeFileSync(cli, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o700 })
  const apps = { desktop: instances.registerApplication(application), cli: instances.registerApplication(cli, 'cli') }
  const details = (name: string, connectionMode: 'native' | 'local_api' = 'native', mode: 'desktop' | 'cli' = 'desktop') => ({ name, connectionMode, applicationId: apps[mode].id, accountId: account.id, model: 'fixture-model', defaultTier: 'inherit', extraArgs: [] })
  const add = (name = 'Skills fixture', connectionMode: 'native' | 'local_api' = 'native', mode: 'desktop' | 'cli' = 'desktop') => {
    instances.save({ details: details(name, connectionMode, mode) })
    return instances.views().at(-1)!
  }
  const start = async (id: string, manager = instances) => {
    const view = manager.views().find(value => value.id === id)!
    manager.start(manager.preview({ id, revision: view.revision }).ticket)
    await manager.settled(id)
    const started = manager.views().find(value => value.id === id)!
    assert.equal(started.status, 'running', started.error)
    return started
  }
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.closeAll().catch(() => {})
    await Promise.all(gateways.map(gateway => gateway.stop()))
    await tokens.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, sourceDirectory, store, instances, create, details, add, start, plans, children, gateways, preparations, results,
    setOnLaunch: (value: typeof onLaunch) => { onLaunch = value },
    setPrepareSkills: (value: typeof prepareSkills) => { prepareSkills = value },
    setPrepareAccount: (value: typeof prepareAccount) => { prepareAccount = value },
  }
}

test('managed Codex native/local API and desktop/CLI launches discover shared skills before launch and on restart', async t => {
  for (const connectionMode of ['native', 'local_api'] as const) for (const mode of ['desktop', 'cli'] as const) {
    await t.test(`${connectionMode} ${mode}`, async t => {
      const f = fixture(t), instance = f.add('Launch matrix', connectionMode, mode)
      const shared = join(instance.directory, 'skills', 'shared-first')
      f.setOnLaunch(plan => {
        assert.equal(plan.directory, instance.directory)
        assert.equal(plan.mode, mode)
        assert.equal(realpathSync(shared), join(f.sourceDirectory, 'shared-first'))
      })
      await f.start(instance.id)
      assert.ok(lstatSync(shared).isSymbolicLink())
      assert.deepEqual(f.preparations, [{ directory: instance.directory, managerDirectory: f.store.directory }])
      assert.equal(f.gateways.length, connectionMode === 'local_api' ? 1 : 0)
      await f.instances.stop(instance.id)
      skill(f.sourceDirectory, 'shared-later')
      assert.equal(existsSync(join(instance.directory, 'skills', 'shared-later')), false)
      f.setOnLaunch(() => assert.equal(realpathSync(join(instance.directory, 'skills', 'shared-later')), join(f.sourceDirectory, 'shared-later')))
      await f.start(instance.id)
      assert.equal(f.preparations.length, 2)
      assert.equal(readFileSync(join(shared, 'SKILL.md'), 'utf8'), readFileSync(join(f.sourceDirectory, 'shared-first', 'SKILL.md'), 'utf8'))
    })
  }
})

test('instance-owned skills survive, while a sessions-only copy rebuilds its shared skills at launch', async t => {
  const f = fixture(t), source = f.add('Source')
  const owned = skill(join(source.directory, 'skills'), 'shared-first', 'Instance-owned instructions\n')
  await f.start(source.id)
  assert.equal(lstatSync(join(source.directory, 'skills', 'shared-first')).isSymbolicLink(), false)
  assert.equal(readFileSync(owned, 'utf8'), 'Instance-owned instructions\n')
  assert.ok(f.results[0].notices.length, 'The preserved conflict must produce a notice')
  for (const notice of f.results[0].notices) assert.ok(f.instances.views()[0].notice?.includes(notice))
  await f.instances.stop(source.id)
  mkdirSync(join(source.directory, 'sessions'))
  writeFileSync(join(source.directory, 'sessions', 'rollout-fixture.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread', model_provider: 'original' } }) + '\n')
  f.instances.startCopy({ id: source.id, revision: source.revision, copyMode: 'sessions', details: f.details('Sessions copy') })
  const deadline = Date.now() + 10_000
  while (['scanning', 'copying'].includes(f.instances.copyView()!.status)) {
    assert.ok(Date.now() < deadline, 'Synthetic session copy timed out')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  const copied = f.instances.copyView()!
  assert.equal(copied.status, 'completed', copied.error)
  const target = f.instances.views().find(value => value.id === copied.targetId)!
  assert.equal(existsSync(join(target.directory, 'skills')), false)
  assert.equal(f.preparations.length, 1, 'Copying session files must not import skills')
  await f.start(target.id)
  assert.equal(realpathSync(join(target.directory, 'skills', 'shared-first')), join(f.sourceDirectory, 'shared-first'))
  assert.equal(readFileSync(owned, 'utf8'), 'Instance-owned instructions\n')
  assert.ok(existsSync(join(target.directory, 'sessions', 'rollout-fixture.jsonl')))
})

test('preview, startup cancellation and a changed preview leave shared skills untouched', async t => {
  for (const connectionMode of ['native', 'local_api'] as const) await t.test(connectionMode, async t => {
    const f = fixture(t), instance = f.add('Do not prepare', connectionMode)
    const before = readdirSync(instance.directory)
    const preview = f.instances.preview({ id: instance.id, revision: instance.revision })
    assert.deepEqual(readdirSync(instance.directory), before)
    assert.equal(f.preparations.length, 0)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const preparing = new Promise<void>(resolveEntered => { entered = resolveEntered })
    f.setPrepareAccount(async id => { entered(); await gate; return f.store.read().accounts.find(value => value.id === id)! })
    f.instances.start(preview.ticket)
    await preparing
    const cancelled = f.instances.stop(instance.id)
    release()
    await cancelled
    assert.equal(f.preparations.length, 0)
    assert.equal(f.plans.length, 0)
    assert.equal(existsSync(join(instance.directory, 'skills')), false)
    const config = join(instance.directory, 'config.toml')
    f.setPrepareAccount(async id => { writeFileSync(config, 'model="changed-after-preview"\n'); return f.store.read().accounts.find(value => value.id === id)! })
    f.instances.start(f.instances.preview({ id: instance.id, revision: instance.revision }).ticket)
    await f.instances.settled(instance.id)
    assert.equal(f.instances.views()[0].status, 'error')
    assert.match(f.instances.views()[0].error!, /凭据准备期间已变化/)
    assert.equal(f.preparations.length, 0)
    assert.equal(f.plans.length, 0)
    assert.equal(existsSync(join(instance.directory, 'skills')), false)
    assert.equal(readFileSync(config, 'utf8'), 'model="changed-after-preview"\n')
  })
})

test('adopted external homes and recovery of a running instance do not sync shared skills', async t => {
  const f = fixture(t), external = join(f.root, 'external-home')
  mkdirSync(external)
  const existing = skill(join(external, 'skills'), 'keep-external', 'External instructions\n')
  const selected = f.instances.selectCopySource(external, 'attach')
  await f.instances.attachExisting({ ticket: selected.ticket, sourceClosed: true, details: f.details('External') })
  const adopted = f.instances.views()[0]
  await f.start(adopted.id)
  assert.equal(f.preparations.length, 0)
  assert.equal(existsSync(join(external, 'skills', 'shared-first')), false)
  assert.equal(readFileSync(existing, 'utf8'), 'External instructions\n')
  await f.instances.stop(adopted.id)
  const managed = f.add('Running managed')
  await f.start(managed.id)
  skill(f.sourceDirectory, 'added-while-running')
  const calls = f.preparations.length, pid = f.instances.views().find(value => value.id === managed.id)!.pid
  const reopened = f.create()
  await reopened.recover()
  assert.equal(reopened.views().find(value => value.id === managed.id)!.pid, pid)
  assert.equal(f.preparations.length, calls)
  assert.equal(existsSync(join(managed.directory, 'skills', 'added-while-running')), false)
  assert.equal(f.children.size, 1)
})

test('a shared-skill preparation error becomes a notice without blocking the client', async t => {
  const f = fixture(t), instance = f.add()
  const own = skill(join(instance.directory, 'skills'), 'keep-own', 'Keep this file\n')
  f.setPrepareSkills(() => { throw new Error('fixture-private-filesystem-detail') })
  const started = await f.start(instance.id)
  assert.match(started.notice!, /本机个人技能未能自动接入/)
  assert.equal(started.notice!.includes('fixture-private-filesystem-detail'), false)
  assert.equal(f.plans.length, 1)
  assert.equal(readFileSync(own, 'utf8'), 'Keep this file\n')
})

test('a Claude CLI launch never prepares Codex shared skills', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), executable = join(f.root, 'claude-synthetic-probe')
  // Only this synthetic fixture's --version/--help probes execute; its client
  // body and every real client are bypassed by the in-memory launch runtime.
  execFileSync('go', ['build', '-o', executable, 'tests/fixtures/claude-client.go'], { cwd: resolve('.'), timeout: 30_000, stdio: 'pipe' })
  const application = f.instances.registerApplication(executable, 'cli', 'claude_code')
  const account = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Synthetic Claude', ANTHROPIC_API_KEY: 'fixture-not-real', baseUrl: 'http://127.0.0.1:9', models: ['fixture-model'] })).accounts[0]
  assert.ok(account)
  f.store.transaction(state => state.accounts.push(account))
  f.instances.save({ details: { ...f.details('Claude'), clientType: 'claude_code', applicationId: application.id, accountId: account.id } })
  const instance = f.instances.views().at(-1)!
  f.setPrepareAccount(async () => assert.fail('Claude must not prepare an OpenAI account'))
  await f.start(instance.id)
  assert.equal(f.plans[0].clientType, 'claude_code')
  assert.equal(f.preparations.length, 0)
  assert.equal(f.gateways.length, 0)
  assert.equal(existsSync(join(instance.directory, 'skills')), false)
})
