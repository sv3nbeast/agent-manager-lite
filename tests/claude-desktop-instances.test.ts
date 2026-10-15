import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Instances, type InstanceSkillsServices, type InstanceSpeedMenuServices } from '../src/main/instances'
import type { DesktopPlan, DesktopProcess, DesktopRuntime } from '../src/main/instanceRuntime'
import type { NativeInstanceAccounts } from '../src/main/nativeInstanceAccounts'
import type { NativeProxyService } from '../src/main/nativeProxy'
import { Store } from '../src/main/store'
import { SessionCatalog } from '../src/main/sessions'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { instanceInputSchema, isClaudeDesktopProfile, type InstanceView } from '../src/shared/instances'
import { exportBackupState, validateBackup } from '../src/main/dataBackupState'
import { DataBackups } from '../src/main/dataBackups'
import { readBackupArchive } from '../src/main/dataBackupArchive'

const gatewaySchemaSource = `const schemas=${JSON.stringify(['inferenceProvider','inferenceCredentialKind','inferenceGatewayBaseUrl','inferenceGatewayApiKey','inferenceGatewayAuthScheme','inferenceModels','modelDiscoveryEnabled','disableDeploymentModeChooser'].map(flatKey => ({ flatKey, support: { enabled: { scopes: ['3p'] } } })))}; const proxy={flatKey:'egressProxyUrl',appBehaviorOnly:true,support:{enabled:{scopes:['1p','3p']}}}; const contracts=['configLibrary','_meta.json','appliedId','deploymentMode','claude_desktop_config.json','-3p','egressProxyPacUrl','proxy-server','proxy-pac-url'];`

function writeGatewayArchive(path: string): void {
  const files: any = { files: {} }, bodies: Buffer[] = []
  let offset = 0
  for (const [entry, content] of [['package.json', JSON.stringify({ name: '@ant/desktop', main: './native.js' })], ['native.js', gatewaySchemaSource]]) {
    const body = Buffer.from(content), parts = entry.split('/'); let parent = files
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ??= { files: {} }
    parent.files[parts.at(-1)!] = { size: body.length, offset: String(offset) }; bodies.push(body); offset += body.length
  }
  const json = Buffer.from(JSON.stringify(files)), header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4), size = Buffer.alloc(8)
  header.writeUInt32LE(header.length - 4); header.writeUInt32LE(json.length, 4); json.copy(header, 8)
  size.writeUInt32LE(4); size.writeUInt32LE(header.length, 4); writeFileSync(path, Buffer.concat([size, header, ...bodies]))
}

const desktopTest=(name:string,run:(t:TestContext)=>void|Promise<void>)=>test(name,{skip:process.platform!=='darwin'},run)

class DesktopFixture implements DesktopRuntime {
  readonly children = new Map<string, DesktopProcess>()
  readonly plans: DesktopPlan[] = []
  readonly callbacks: Array<{ nonce: string; url: string }> = []
  onLaunch?: (plan: DesktopPlan, signal: AbortSignal) => Promise<void>
  stopError = false
  async find(plan: DesktopPlan) { return this.children.get(plan.nonce) }
  async launch(plan: DesktopPlan, signal: AbortSignal) {
    signal.throwIfAborted()
    this.plans.push(structuredClone(plan))
    const child = { pid: 50000 + this.plans.length, started: 'desktop-fixture-' + this.plans.length }
    this.children.set(plan.nonce, child)
    await this.onLaunch?.(plan, signal)
    return child
  }
  async stop(plan: DesktopPlan) {
    if (this.stopError) throw new Error('fixture ownership temporarily unavailable')
    this.children.delete(plan.nonce)
  }
  async focus(plan: DesktopPlan) { assert.ok(this.children.has(plan.nonce)) }
  async openUrl(plan: DesktopPlan, url: string) {
    assert.ok(this.children.has(plan.nonce))
    this.callbacks.push({ nonce: plan.nonce, url })
  }
}

function forbiddenService<T>(name: string): T {
  return new Proxy({}, { get: (_target, property) => () => assert.fail(`${name}.${String(property)} must not run for Claude Desktop`) }) as T
}

function fixture(t: TestContext,proxyService?:NativeProxyService) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-desktop-instance-'))), bundle = join(root, 'Claude.app')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(bundle, 'Contents', 'Resources'))
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleExecutable</key><string>Claude</string><key>CFBundleName</key><string>Claude</string><key>CFBundleShortVersionString</key><string>2.1.0</string></dict></plist>')
  const executable = join(bundle, 'Contents', 'MacOS', 'Claude')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeGatewayArchive(join(bundle, 'Contents', 'Resources', 'app.asar'))
  const store = new Store(join(root, 'data'), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const runtime = new DesktopFixture(), managers: Instances[] = []
  const create = () => {
    const instances = new Instances(store,
      () => assert.fail('Desktop must not allocate a gateway'),
      async () => assert.fail('Desktop must not prepare a manager account'),
      runtime, forbiddenService<NativeInstanceAccounts>('nativeAccounts'), undefined, undefined, [],
      forbiddenService<InstanceSpeedMenuServices>('Codex desktop compatibility'), proxyService,
      forbiddenService<InstanceSkillsServices>('Codex skills'))
    managers.push(instances)
    return instances
  }
  const instances = create(), application = instances.registerApplication(bundle, 'desktop', 'claude_code')
  const add = (name = 'Claude Desktop') => {
    instances.save({ details: { clientType: 'claude_code', launchMode: 'desktop', name, applicationId: application.id, connectionMode: 'client_login', accountId: '', model: '', extraArgs: [] } })
    return instances.views().at(-1)!
  }
  const addApi = (name = 'Claude Desktop API', baseUrl = 'https://gateway.fixture.invalid/v1') => {
    const account = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Desktop API key', ANTHROPIC_API_KEY: `desktop-key-${randomUUID()}`, baseUrl, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], protocol: 'anthropic_messages', credentialKind: 'anthropic_api_key' })).accounts[0]
    store.transaction(state => state.accounts.push(account))
    instances.save({ details: { clientType: 'claude_code', launchMode: 'desktop', name, applicationId: application.id, connectionMode: 'native', accountId: account.id, model: 'claude-haiku-4-5', extraArgs: [] } })
    return { instance: instances.views().at(-1)!, account }
  }
  const start = async (instance: InstanceView) => {
    instances.start(instances.preview({ id: instance.id, revision: instance.revision }).ticket)
    await instances.settled(instance.id)
    const current = instances.views().find(item => item.id === instance.id)!
    assert.equal(current.status, 'running', current.error)
    return current
  }
  const checkpoint = (instance: InstanceView) => join(store.directory, 'instances', instance.id, 'launch.json')
  t.after(async () => {
    runtime.stopError = false
    for (const manager of managers.reverse()) await manager.closeAll().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  return { root, bundle, executable, store, runtime, create, instances, application, add, addApi, start, checkpoint }
}

test('client login permits no manager identity only for Claude Desktop and preserves legacy CLI defaults', () => {
  const details = { clientType: 'claude_code', launchMode: 'desktop', name: 'Desktop', applicationId: 'fixture', connectionMode: 'client_login', accountId: '', model: '' }
  assert.equal(instanceInputSchema.parse(details).connectionMode, 'client_login')
  for (const change of [{ clientType: 'codex' }, { launchMode: 'cli' }, { accountId: randomUUID() }, { model: 'claude-sonnet' }]) assert.equal(instanceInputSchema.safeParse({ ...details, ...change }).success, false)
  for (const connectionMode of ['native', 'local_api']) assert.equal(instanceInputSchema.safeParse({ ...details, connectionMode }).success, false)
  assert.equal(isClaudeDesktopProfile({ clientType: 'claude_code' }), false)
  assert.equal(isClaudeDesktopProfile({ clientType: 'claude_code', connectionMode: 'native' }), false)
  assert.equal(isClaudeDesktopProfile(details), true)
  assert.equal(isClaudeDesktopProfile({ clientType: 'claude_code', connectionMode: 'client_login' }), true)
  assert.equal(isClaudeDesktopProfile({ launchMode: 'desktop' }), false)
})

desktopTest('Desktop creation and preview need no account, and concurrent launches own separate profile and native homes', async t => {
  const f = fixture(t), first = f.add(), second = f.add('Second Desktop')
  const preview = f.instances.preview({ id: first.id, revision: first.revision })
  assert.equal(preview.launchMode, 'desktop')
  assert.equal(preview.identityStatus, 'client_login')
  assert.equal(preview.connectionMode, 'client_login')
  assert.equal(preview.history, undefined)
  assert.equal(preview.model, '')
  assert.equal(f.store.read().accounts.length, 0)
  assert.equal(existsSync(join(dirname(first.directory), 'desktop-home')), false, 'preview does not initialize HOME')
  await f.start(first); await f.start(second)
  assert.equal(f.runtime.children.size, 2)
  for (const [index, instance] of [first, second].entries()) {
    const plan = f.runtime.plans[index], home = join(dirname(instance.directory), 'desktop-home')
    assert.deepEqual(plan.launchEnvironment, { CLAUDE_CONFIG_DIR: instance.directory, HOME: home, CFFIXED_USER_HOME: home,CLAUDE_CODE_TMPDIR:join(home,'tmp') })
    assert.equal(lstatSync(home).mode & 0o777, 0o700)
    assert.equal(lstatSync(join(home,'tmp')).mode & 0o777,0o700)
    // The view exposes the API profile's `desktop-3p` directory for native
    // connections, while a client-login plan always launches the base
    // `desktop` profile. Keep this assertion tied to the persisted layout.
    assert.equal(plan.desktopDirectory, join(dirname(instance.directory), 'desktop'))
    assert.equal(plan.mode, 'desktop')
    const saved = JSON.parse(readFileSync(f.checkpoint(instance), 'utf8'))
    assert.equal(saved.launchMode, 'desktop'); assert.equal(saved.claudeExecutable, f.executable)
    assert.equal(saved.claudeApplication, f.bundle); assert.equal(saved.connectionMode, 'client_login')
    assert.equal(existsSync(join(instance.directory, '.claude.json')), false, 'CLI onboarding is not written')
    assert.equal(existsSync(join(instance.directory, 'auth.json')), false)
    assert.equal(existsSync(join(instance.directory, 'config.toml')), false)
  }
  await f.instances.refresh(); await f.instances.focus(first.id)
  assert.ok(f.instances.views().every(instance => instance.status === 'running' && instance.identityStatus === 'client_login'))
  await f.instances.stop(first.id)
  assert.equal(f.runtime.children.size, 1)
  assert.equal(f.instances.views().find(instance => instance.id === second.id)?.status, 'running')
})

desktopTest('Desktop native API instances save, preview, launch and recover through the unified manager', async t => {
  const f = fixture(t), { instance, account } = f.addApi()
  const preview = f.instances.preview({ id: instance.id, revision: instance.revision })
  assert.equal(preview.connectionMode, 'native')
  assert.equal(preview.launchMode, 'desktop')
  assert.equal(preview.identityStatus, 'api_configured')
  assert.equal(preview.accountName, account.name)
  assert.equal(preview.model, 'claude-haiku-4-5')
  assert.equal(preview.desktopDirectory, instance.desktopDirectory)
  assert.equal(preview.network?.source, 'account')
  await f.start(instance)
  const plan = f.runtime.plans[0], gatewayDir = join(dirname(instance.directory), 'desktop-3p'), library = join(gatewayDir, 'configLibrary')
  assert.equal(plan.claudeDesktopConnection, 'api')
  assert.equal(plan.directory, instance.directory)
  assert.equal(plan.desktopDirectory, join(dirname(instance.directory), 'desktop'))
  assert.equal(existsSync(join(gatewayDir, 'claude_desktop_config.json')), true)
  const meta = JSON.parse(readFileSync(join(library, '_meta.json'), 'utf8'))
  const config = JSON.parse(readFileSync(join(library, `${meta.appliedId}.json`), 'utf8'))
  assert.equal(config.inferenceProvider, 'gateway')
  assert.equal(config.inferenceGatewayBaseUrl, 'https://gateway.fixture.invalid')
  assert.deepEqual(config.inferenceModels, [{ name: 'claude-haiku-4-5' }, { name: 'claude-sonnet-4-5' }])
  const checkpoint = JSON.parse(readFileSync(f.checkpoint(instance), 'utf8'))
  assert.equal(checkpoint.connectionMode, 'native')
  assert.equal(checkpoint.launchMode, 'desktop')
  assert.equal(readFileSync(f.checkpoint(instance), 'utf8').includes(account.credentials.apiKey!), false)
  const restarted = f.create(); await restarted.recover()
  const recovered = restarted.views().find(value => value.id === instance.id)!
  assert.equal(recovered.status, 'running', recovered.error)
  assert.equal(restarted.runtime.plans.at(-1)?.claudeDesktopConnection, 'api')
  await restarted.stop(instance.id)
  assert.equal(existsSync(join(gatewayDir, 'configLibrary')), true, 'stopping keeps native Desktop data for recovery')
})

desktopTest('Desktop API preview rejects changed key and account proxy before creating or launching an instance', async t => {
  const f = fixture(t), { instance, account } = f.addApi()
  const preview = f.instances.preview({ id: instance.id, revision: instance.revision })
  f.store.transaction(state => {
    const current = state.accounts.find(value => value.id === account.id)!; current.credentials.apiKey = 'rotated-before-launch'; current.revision = (current.revision ?? 0) + 1
  })
  assert.throws(() => f.instances.start(preview.ticket), /配置或网络设置已变化/)
  await f.instances.settled(instance.id)
  assert.equal(f.runtime.plans.length, 0)
  assert.equal(f.instances.views()[0].status, 'stopped')
  assert.equal(existsSync(join(dirname(instance.directory), 'desktop-3p')), false)

  // A fresh preview binds the account-level proxy as well as the credential.
  const refreshed = f.instances.views()[0], next = f.instances.preview({ id: refreshed.id, revision: refreshed.revision })
  f.store.transaction(state => { state.accounts.find(value => value.id === account.id)!.proxy = { mode: 'custom', url: 'https://proxy.fixture.invalid:8443' } })
  assert.throws(() => f.instances.start(next.ticket), /配置或网络设置已变化/)
  await f.instances.settled(instance.id)
  assert.equal(f.runtime.plans.length, 0)
  assert.equal(f.instances.views()[0].status, 'stopped')
})

desktopTest('Desktop API account proxies are projected into the native gateway entry', async t => {
  const leases: Array<{ live: boolean; stops: number }> = []
  const f = fixture(t, { async acquire(proxy) {
    assert.equal(proxy, 'https://proxy.fixture.invalid:8443/')
    const lease = { live: true, stops: 0 }
    leases.push(lease)
    return { url: 'http://127.0.0.1:29204', alive: () => lease.live, stop: async () => { lease.live = false; lease.stops++ } }
  } })
  const { instance, account } = f.addApi()
  f.store.transaction(state => { state.accounts.find(value => value.id === account.id)!.proxy = { mode: 'custom', url: 'https://proxy.fixture.invalid:8443' } })
  await f.start(instance)
  const gatewayDir = join(dirname(instance.directory), 'desktop-3p'), library = join(gatewayDir, 'configLibrary')
  const meta = JSON.parse(readFileSync(join(library, '_meta.json'), 'utf8'))
  const config = JSON.parse(readFileSync(join(library, `${meta.appliedId}.json`), 'utf8'))
  assert.equal(config.egressProxyUrl, 'http://127.0.0.1:29204')
  assert.equal(config.inferenceGatewayBaseUrl, 'https://gateway.fixture.invalid')
  assert.equal(leases.length, 1)
  await f.instances.stop(instance.id)
  assert.equal(leases[0].stops, 1)
})

desktopTest('Desktop API to client-login switch restores login mode while retaining the isolated third-party profile', async t => {
  const f = fixture(t), { instance, account } = f.addApi()
  await f.start(instance); await f.instances.stop(instance.id)
  const persisted = join(dirname(instance.directory), 'desktop-3p', 'configLibrary')
  assert.equal(existsSync(persisted), true)
  const current = f.instances.views().find(value => value.id === instance.id)!
  f.instances.save({ id: instance.id, revision: current.revision, details: { clientType: 'claude_code', launchMode: 'desktop', name: current.name, applicationId: f.application.id, connectionMode: 'client_login', accountId: '', model: '', extraArgs: [] } })
  const login = f.instances.views().find(value => value.id === instance.id)!
  const preview = f.instances.preview({ id: login.id, revision: login.revision })
  assert.equal(preview.connectionMode, 'client_login')
  assert.equal(preview.identityStatus, 'client_login')
  assert.equal(preview.accountName, '在 Claude Desktop 内登录')
  await f.start(login)
  assert.equal(f.runtime.plans.at(-1)?.claudeDesktopConnection, undefined)
  assert.equal(existsSync(persisted), true)
  // Releasing a projection removes its secret-bearing entry and metadata;
  // the isolated third-party library directory itself remains for future use.
  assert.equal(existsSync(join(persisted, '_meta.json')), false)
  assert.equal(f.store.read().accounts.some(value => value.id === account.id), true)
})

desktopTest('Desktop stop and natural exit preserve login, configuration and transcripts without Codex cleanup', async t => {
  const f = fixture(t), instance = f.add()
  const settings = '{"theme":"dark","permissions":{"deny":["WebFetch"]}}\n'
  writeFileSync(join(instance.directory, 'settings.json'), settings)
  await f.start(instance)
  const userFiles = [join(instance.desktopDirectory, 'Cookies'), join(instance.directory, 'session.jsonl'), join(dirname(instance.directory), 'desktop-home', '.claude.json')]
  for (const path of userFiles) writeFileSync(path, 'client-owned state')
  f.runtime.children.clear()
  await f.instances.refresh()
  assert.equal(f.instances.views()[0].status, 'stopped')
  assert.equal(existsSync(f.checkpoint(instance)), false)
  assert.equal(readFileSync(join(instance.directory, 'settings.json'), 'utf8'), settings)
  for (const path of userFiles) assert.equal(readFileSync(path, 'utf8'), 'client-owned state')
  await f.start(instance); await f.instances.stop(instance.id)
  for (const path of userFiles) assert.equal(readFileSync(path, 'utf8'), 'client-owned state')
})

desktopTest('Desktop default proxy leases isolate instances and never expose upstream credentials',async t=>{
  const leases:Array<{scope:string;proxy:string;live:boolean;stops:number}>=[]
  const f=fixture(t,{async acquire(proxy,scope){
    const lease={scope,proxy,live:true,stops:0};leases.push(lease)
    return {url:'http://127.0.0.1:'+String(29100+leases.length),alive:()=>lease.live,stop:async()=>{
      assert.ok(!f.runtime.plans.some(plan=>plan.directory.includes(scope)&&f.runtime.children.has(plan.nonce)),'stop the client before releasing its network')
      lease.live=false;lease.stops++
    }}
  }})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'custom',url:'socks5h://desktop-user:desktop-secret@proxy.invalid:1080'}})
  const first=f.add(),second=f.add('Second Desktop')
  const preview=f.instances.preview({id:first.id,revision:first.revision})
  assert.deepEqual(preview.network,{mode:'proxy',source:'settings',proxy:{mode:'custom',protocol:'SOCKS5H',server:'proxy.invalid',port:1080,authenticated:true}})
  await f.start(first);await f.start(second)
  assert.deepEqual(leases.map(lease=>lease.scope),[first.id,second.id])
  assert.ok(leases.every(lease=>lease.proxy==='socks5h://desktop-user:desktop-secret@proxy.invalid:1080'))
  assert.notDeepEqual(f.runtime.plans[0].networkRoute,f.runtime.plans[1].networkRoute)
  assert.equal(JSON.stringify([preview,...f.runtime.plans]).includes('desktop-secret'),false)
  assert.equal(readFileSync(f.checkpoint(first),'utf8').includes('desktop-secret'),false)
  assert.equal(JSON.parse(readFileSync(f.checkpoint(first),'utf8')).nativeProxy,true)
  f.runtime.stopError=true
  await assert.rejects(f.instances.stop(first.id),/ownership temporarily unavailable/)
  assert.equal(leases[0].live,true);assert.equal(leases[0].stops,0)
  f.runtime.stopError=false;await f.instances.stop(first.id)
  assert.equal(leases[0].stops,1);assert.equal(leases[1].live,true)
  leases[1].live=false;await f.instances.refresh()
  assert.match(f.instances.views().find(instance=>instance.id===second.id)?.error??'',/网络代理已退出/)
  assert.equal(f.runtime.children.size,1,'failed route cannot silently become direct or close the user client')
  f.runtime.children.clear();await f.instances.refresh()
  assert.equal(leases[1].stops,1)
})

desktopTest('Desktop inherits only when selected and explicit direct owns a direct bridge',async t=>{
  const requests:string[]=[]
  const f=fixture(t,{async acquire(proxy){requests.push(proxy);return {url:'http://127.0.0.1:29200',alive:()=>true,stop:async()=>{}}}})
  const instance=f.add()
  assert.deepEqual(f.instances.preview({id:instance.id,revision:instance.revision}).network,{mode:'inherit',source:'settings'})
  await f.start(instance);assert.equal(f.runtime.plans[0].networkRoute,undefined)
  await f.instances.stop(instance.id)
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'direct'}})
  assert.deepEqual(f.instances.preview({id:instance.id,revision:instance.revision}).network,{mode:'direct',source:'settings'})
  await f.start(instance)
  assert.deepEqual(requests,['direct'])
  assert.deepEqual(f.runtime.plans[1].networkRoute,{mode:'proxy',url:'http://127.0.0.1:29200'})
})

desktopTest('Desktop proxy changes invalidate previews and preparation without launching a client',async t=>{
  let releases=0
  const f=fixture(t,{async acquire(){
    f.store.transaction(state=>{state.upstreamProxy={revision:2,mode:'direct'}})
    return {url:'http://127.0.0.1:29201',alive:()=>true,stop:async()=>{releases++}}
  }})
  const instance=f.add(),preview=f.instances.preview({id:instance.id,revision:instance.revision})
  f.store.transaction(state=>{state.upstreamProxy={revision:1,mode:'custom',url:'https://user:secret@proxy.invalid'}})
  assert.throws(()=>f.instances.start(preview.ticket),/网络设置已变化/)
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket)
  await f.instances.settled(instance.id)
  assert.match(f.instances.views()[0].error??'',/网络在启动准备期间已变化/)
  assert.equal(releases,1);assert.equal(f.runtime.plans.length,0)
  assert.equal(existsSync(f.checkpoint(instance)),false)
})

desktopTest('Desktop cancellation during proxy preparation releases its lease before any launch',async t=>{
  let entered!:()=>void,release!:()=>void,stops=0
  const started=new Promise<void>(resolve=>{entered=resolve}),waiting=new Promise<void>(resolve=>{release=resolve})
  const f=fixture(t,{async acquire(){entered();await waiting;return {url:'http://127.0.0.1:29202',alive:()=>true,stop:async()=>{stops++}}}})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'direct'}})
  const instance=f.add()
  f.instances.start(f.instances.preview({id:instance.id,revision:instance.revision}).ticket)
  await started
  const stopping=f.instances.stop(instance.id);release();await stopping
  assert.equal(stops,1);assert.equal(f.runtime.plans.length,0)
  assert.equal(f.instances.views()[0].status,'stopped')
})

desktopTest('Desktop recovery never claims that a lost proxy lease is still usable',async t=>{
  const f=fixture(t,{async acquire(){return {url:'http://127.0.0.1:29203',alive:()=>true,stop:async()=>{}}}})
  f.store.transaction(state=>{state.upstreamProxy={revision:0,mode:'direct'}})
  const instance=f.add();await f.start(instance)
  const restarted=f.create();await restarted.recover()
  assert.equal(restarted.views()[0].status,'error')
  assert.match(restarted.views()[0].error??'',/代理已结束/)
  assert.equal(f.runtime.children.size,1)
  await restarted.stop(instance.id)
  assert.equal(f.runtime.children.size,0)
})

desktopTest('Desktop restart recovery uses its saved executable even after the installation disappears', async t => {
  const f = fixture(t), instance = f.add()
  await f.start(instance)
  writeFileSync(join(instance.desktopDirectory, 'Cookies'), 'retained login')
  rmSync(f.bundle, { recursive: true })
  const restarted = f.create()
  await restarted.recover()
  const recovered = restarted.views().find(value => value.id === instance.id)!
  assert.equal(recovered.status, 'running', recovered.error)
  assert.equal(recovered.launchMode, 'desktop')
  assert.equal(recovered.identityStatus, 'client_login')
  await restarted.focus(instance.id); await restarted.stop(instance.id)
  assert.equal(f.runtime.children.size, 0)
  assert.equal(readFileSync(join(instance.desktopDirectory, 'Cookies'), 'utf8'), 'retained login')
  assert.equal(existsSync(f.checkpoint(instance)), false)
})

desktopTest('Desktop recovery refuses a CLI checkpoint without signalling the live desktop owner', async t => {
  const f = fixture(t), instance = f.add()
  await f.start(instance)
  const saved = JSON.parse(readFileSync(f.checkpoint(instance), 'utf8'))
  writeFileSync(f.checkpoint(instance), JSON.stringify({ ...saved, launchMode: 'cli' }))
  const restarted = f.create(); await restarted.recover()
  assert.equal(restarted.views()[0].status, 'error')
  assert.match(restarted.views()[0].error!, /无法安全恢复/)
  assert.equal(f.runtime.children.size, 1)
  assert.equal(existsSync(f.checkpoint(instance)), true)
})

desktopTest('Desktop rejects stale bundle and directory previews before launch', async t => {
  for (const replace of ['bundle', 'directory', 'home'] as const) await t.test(replace, async t => {
    const f = fixture(t), instance = f.add(), preview = f.instances.preview({ id: instance.id, revision: instance.revision })
    if (replace === 'bundle') writeFileSync(join(f.bundle, 'Contents', 'Resources', 'app.asar'), 'upgraded bundle')
    else if (replace === 'directory') { renameSync(instance.desktopDirectory, instance.desktopDirectory + '.previous'); mkdirSync(instance.desktopDirectory) }
    else { mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(dirname(instance.directory), 'desktop-home')) }
    assert.throws(() => f.instances.start(preview.ticket), /变化|替换/)
    assert.equal(f.runtime.plans.length, 0)
    assert.equal(existsSync(f.checkpoint(instance)), false)
  })
})

desktopTest('Desktop config cannot redirect its native home or embedded CLI profile', async t => {
  for (const [location, body] of [
    ['settings.json', { env: { HOME: '/outside' } }],
    ['settings.json', { env: { CLAUDE_CONFIG_DIR: '/outside' } }],
    ['ccd-environment-config.json', { environments: [{ env: { CFFIXED_USER_HOME: '/outside' } }] }],
  ] as const) await t.test(location + JSON.stringify(body), t => {
    const f = fixture(t), instance = f.add(), path = join(location === 'settings.json' ? instance.directory : instance.desktopDirectory, location)
    const bytes = JSON.stringify(body); writeFileSync(path, bytes)
    assert.throws(() => f.instances.preview({ id: instance.id, revision: instance.revision }), /不能覆盖受管隔离目录/)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    assert.equal(f.runtime.plans.length, 0)
  })
  await t.test('encrypted and ordinary native environments survive stop and reopen unchanged', async t => {
    const f=fixture(t),instance=f.add(),path=join(instance.desktopDirectory,'ccd-environment-config.json')
    for(const field of ['envVars','scopedEnvVars']){
      // Even ciphertext that represents an empty object cannot be classified
      // with the manager's different safeStorage identity.
      const bytes=JSON.stringify({[field]:'opaque-ciphertext-of-empty-environment'});writeFileSync(path,bytes)
      const settings=JSON.stringify({env:{EDITOR:'code',CLAUDE_CODE_TMPDIR:'/tmp/custom-desktop-tasks'},permissions:{allow:['Read']}})
      writeFileSync(join(instance.directory,'settings.json'),settings)
      await f.start(instance);await f.instances.stop(instance.id)
      await f.start(instance);await f.instances.stop(instance.id)
      assert.equal(readFileSync(path,'utf8'),bytes)
      assert.equal(readFileSync(join(instance.directory,'settings.json'),'utf8'),settings)
    }
    assert.equal(f.runtime.plans.length,4)
  })
  await t.test('native temporary paths and matching managed root defaults remain usable',async t=>{
    const f=fixture(t),instance=f.add(),path=join(instance.desktopDirectory,'ccd-environment-config.json')
    const native=JSON.stringify({tmpDirOverride:'/tmp/custom-claude'})
    writeFileSync(path,native)
    writeFileSync(join(instance.directory,'settings.json'),JSON.stringify({env:{CLAUDE_CONFIG_DIR:instance.directory,HOME:join(dirname(instance.directory),'desktop-home')}}))
    await f.start(instance);await f.instances.stop(instance.id)
    assert.equal(readFileSync(path,'utf8'),native)
  })
})

desktopTest('Desktop cancellation before launch never allocates a client, while deferred cancellation stops only its owner', async t => {
  const f = fixture(t), early = f.add('Cancelled before launch')
  f.instances.start(f.instances.preview({ id: early.id, revision: early.revision }).ticket)
  await f.instances.stop(early.id)
  assert.equal(f.runtime.plans.length, 0)
  assert.equal(f.instances.views()[0].status, 'stopped')
  const sibling = f.add('Running sibling'); await f.start(sibling)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  f.runtime.onLaunch = async () => { entered(); await gate }
  const deferred = f.add('Cancelled during launch')
  f.instances.start(f.instances.preview({ id: deferred.id, revision: deferred.revision }).ticket)
  await started
  const stopping = f.instances.stop(deferred.id); release(); await stopping
  assert.equal(f.runtime.children.size, 1)
  assert.equal(f.instances.views().find(value => value.id === deferred.id)?.status, 'stopped')
  assert.equal(f.instances.views().find(value => value.id === sibling.id)?.status, 'running')
  assert.equal(existsSync(f.checkpoint(deferred)), false)
})

desktopTest('Desktop failed cleanup retains its checkpoint and profile until a safe retry', async t => {
  const f = fixture(t), instance = f.add()
  f.runtime.onLaunch = async () => { f.runtime.stopError = true; throw new Error('launch interrupted') }
  f.instances.start(f.instances.preview({ id: instance.id, revision: instance.revision }).ticket)
  await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status, 'error')
  assert.match(f.instances.views()[0].error!, /清理未完成/)
  assert.equal(existsSync(f.checkpoint(instance)), true)
  assert.equal(f.runtime.children.size, 1)
  writeFileSync(join(instance.desktopDirectory, 'Cookies'), 'keep final native state')
  f.runtime.stopError = false
  await f.instances.stop(instance.id)
  assert.equal(f.runtime.children.size, 0)
  assert.equal(existsSync(f.checkpoint(instance)), false)
  assert.equal(readFileSync(join(instance.desktopDirectory, 'Cookies'), 'utf8'), 'keep final native state')
})

desktopTest('Desktop and CLI cannot reuse a saved instance or silently cross application modes', async t => {
  const f = fixture(t), desktop = f.add(), cliPath = join(f.root, 'claude-cli')
  writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const cliApp = f.instances.registerApplication(cliPath, 'cli', 'claude_code')
  const api = parseClaudeCodeAccountImport(JSON.stringify({ name: 'fixture API', ANTHROPIC_API_KEY: 'fixture-only', baseUrl: 'https://fixture.invalid', models: ['fixture-model'] })).accounts[0]
  f.store.transaction(state => state.accounts.push(api))
  const cliDetails = { clientType: 'claude_code', launchMode: 'cli', name: 'CLI', applicationId: cliApp.id, accountId: api.id, connectionMode: 'native', model: 'fixture-model' }
  f.instances.save({ details: cliDetails })
  const cli = f.instances.views().at(-1)!
  f.store.transaction(state => { delete state.instances!.find(value => value.id === cli.id)!.launchMode })
  const desktopDetails = { clientType: 'claude_code', launchMode: 'desktop', name: 'Desktop replacement', applicationId: f.application.id, accountId: '', connectionMode: 'client_login', model: '' }
  assert.throws(() => f.instances.save({ id: cli.id, revision: cli.revision, details: desktopDetails }), /创建新实例/)
  assert.throws(() => f.instances.save({ id: desktop.id, revision: desktop.revision, details: cliDetails }), /创建新实例/)
  assert.throws(() => f.instances.save({ details: { ...desktopDetails, applicationId: cliApp.id } }), /运行方式/)
  // A provider key is valid for a Claude Desktop third-party connection;
  // changing the installed application creates a separate Desktop profile.
  f.instances.save({ details: { ...cliDetails, launchMode: 'desktop', name: 'CLI cross-mode replacement', applicationId: f.application.id } })
  assert.equal(f.store.read().instances?.length, 3)
  assert.equal(f.store.read().instances?.find(value => value.id === cli.id)?.launchMode, undefined)
  await assert.rejects(f.instances.completeDesktopLogin(cli.id, 'claude://complete'), /Claude Desktop/)
})

desktopTest('Desktop sessions stay in the client and callbacks target only a running desktop instance', async t => {
  const f = fixture(t), first = f.add(), second = f.add('Other Desktop')
  const project = join(first.directory, 'projects', 'fixture'); mkdirSync(project, { recursive: true })
  writeFileSync(join(project, randomUUID() + '.jsonl'), JSON.stringify({ type: 'user', sessionId: randomUUID(), message: { role: 'user', content: 'must not be indexed as CLI' } }) + '\n')
  const catalog = new SessionCatalog(f.store), result = await catalog.scan({ runId: randomUUID() })
  assert.equal(result.sources?.some(source => source.id === first.id || source.id === second.id), false)
  assert.equal(result.items.length, 0)
  await assert.rejects(catalog.scan({ runId: randomUUID(), targetId: first.id }), /来源目录不存在/)
  assert.throws(() => f.instances.previewHistory({ id: first.id, revision: first.revision }), /客户端内查看/)
  await assert.rejects(f.instances.completeDesktopLogin(first.id, 'claude://complete'), /先启动/)
  await f.start(first); await f.start(second)
  await f.instances.completeDesktopLogin(first.id, 'claude://complete?fixture=1')
  assert.deepEqual(f.runtime.callbacks, [{ nonce: f.runtime.plans[0].nonce, url: 'claude://complete?fixture=1' }])
  await f.instances.stop(first.id)
  await assert.rejects(f.instances.completeDesktopLogin(first.id, 'claude://complete'), /先启动/)
  assert.equal(f.runtime.children.size, 1)
})

desktopTest('Desktop account-free bindings survive backup validation without becoming CLI instances',t=>{
  const f=fixture(t),instance=f.add()
  const exported=exportBackupState(f.store.read(),{}),restored=validateBackup(JSON.parse(JSON.stringify(exported)))
  const profile=restored.state.instances?.find(value=>value.id===instance.id)
  assert.ok(profile)
  assert.equal(profile.launchMode,'desktop')
  assert.equal(profile.connectionMode,'client_login')
  assert.equal(profile.accountId,'')
  assert.equal(profile.model,'')
  assert.equal(isClaudeDesktopProfile(profile),true)
  assert.equal(restored.state.accounts.length,0)
})

desktopTest('Desktop portable backup never follows native Keychain service links or restores them',async t=>{
  const f=fixture(t),instance=f.add(),library=join(dirname(instance.directory),'desktop-home','Library'),keychains=join(f.root,'synthetic-keychains')
  mkdirSync(library,{recursive:true});mkdirSync(keychains)
  writeFileSync(join(keychains,'login.keychain-db'),'synthetic-keychain-secret-must-not-be-exported')
  symlinkSync(keychains,join(library,'Keychains'))
  const backup=new DataBackups(f.store,()=>({})),destination=join(f.root,'desktop.cmlbackup'),password='synthetic-only-backup-password'
  const target=new Store(join(f.root,'restore'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),restore=new DataBackups(target,()=>({}))
  t.after(async()=>{await backup.stop();await restore.stop()})
  await backup.export({requestId:randomUUID(),password},destination)
  const read=await readBackupArchive(destination,password,new AbortController().signal)
  try{
    assert.equal(JSON.stringify(read.payload).includes('synthetic-keychain-secret'),false)
    assert.equal(JSON.stringify(read.payload).includes('synthetic-keychains'),false)
  }finally{read.cipher.key.fill(0)}
  const preview=await restore.preview({requestId:randomUUID(),password},destination)
  await restore.apply({ticket:preview.ticket,requestId:randomUUID(),confirmed:true})
  assert.equal(target.read().instances?.[0].connectionMode,'client_login')
  assert.equal(existsSync(join(target.directory,'instances',instance.id,'desktop-home')),false)
  assert.equal(readFileSync(join(keychains,'login.keychain-db'),'utf8'),'synthetic-keychain-secret-must-not-be-exported')
})
