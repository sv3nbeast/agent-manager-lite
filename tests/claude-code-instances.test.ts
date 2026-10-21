import test, { after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store, type StoredAccount } from '../src/main/store'
import { Instances } from '../src/main/instances'
import type { NativeInstanceAccounts } from '../src/main/nativeInstanceAccounts'
import { MacCliRuntime, MacInstanceRuntime } from '../src/main/cliInstanceRuntime'
import { parseClaudeCodeAccountImport } from '../src/main/claudeCodeAccounts'
import { createAPIAccount } from '../src/main/accounts'
import { randomUUID } from 'node:crypto'
import { SessionCatalog } from '../src/main/sessions'
import { validateClaudeCodeCliArgs } from '../src/main/claudeCodeInstanceAdapter'

const supported = process.platform === 'darwin'
const build = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-native-fixture-'))), binary = join(build, 'claude native fixture')
if (supported) execFileSync('go', ['build', '-o', binary, 'tests/fixtures/claude-client.go'], { cwd: resolve('.'), timeout: 30_000, stdio: 'pipe' })
after(() => rmSync(build, { recursive: true, force: true }))
const transcriptName = join('projects', 'fixture-project', '76be7829-ec9e-4577-94f6-e940c775f25f.jsonl')

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const result = read()
    if (result !== undefined) return result
    if (Date.now() > end) throw new Error('Claude fixture evidence timeout')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30))
  }
}

interface Evidence {
  configDirectory: string; home: string; cwd: string; argv0: string; args: string[]; pid: number
  apiKey: string; bearer: string; oauth: string; profile: string; model: string; baseUrl: string
  bedrock: string; openAIKey: string; codexHome: string; projectDirectoryOverride: string; nodeOptions: string
}

function fixture(t: TestContext, options: { open?: (script: string, launch: () => void) => Promise<void>; missingFlags?: boolean; ensure?: (id: string, store: Store) => Promise<StoredAccount> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-claude-instances-')))
  const store = new Store(join(root, 'data'), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const executable = join(root, options.missingFlags ? 'claude missing-flags' : "claude 程序 ' $(literal)")
  copyFileSync(binary, executable)
  const shellHome = join(root, 'shell-home'); mkdirSync(shellHome)
  const children: ChildProcess[] = [], managers: Instances[] = []
  const handoffs: { path: string; mode: number; body: string; script: string }[] = []
  const cli = new MacCliRuntime(async script => {
    const environment = script.replace(/\.command$/, '.environment')
    assert.equal(JSON.parse(readFileSync(join(script, '..', '..', 'home', '.claude.json'), 'utf8')).hasCompletedOnboarding, true)
    handoffs.push({ path: environment, mode: lstatSync(environment).mode & 0o777, body: readFileSync(environment, 'utf8'), script: readFileSync(script, 'utf8') })
    const launch = () => {
      const child = spawn('/bin/bash', [script], {
        env: { ...process.env, HOME: shellHome, OPENAI_API_KEY: 'inherited-openai-must-not-reach', CODEX_HOME: 'inherited-codex-home', CLAUDE_CONFIG_DIR: 'inherited-claude-directory', ANTHROPIC_API_KEY: 'inherited-anthropic-key', ANTHROPIC_AUTH_TOKEN: 'inherited-bearer', CLAUDE_CODE_OAUTH_TOKEN: 'inherited-oauth', ANTHROPIC_PROFILE: 'inherited-profile', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_PROJECT_DIR_NAME: 'inherited-project-override', ANTHROPIC_BASE_URL: 'https://inherited.invalid', NODE_OPTIONS: '--inspect=0' },
        stdio: 'ignore',
      })
      children.push(child)
    }
    if (options.open) await options.open(script, launch); else launch()
  })
  const runtime = new MacInstanceRuntime(undefined, cli)
  const nativeAccounts = new Proxy({}, { get: (_target, property) => () => assert.fail(`Claude invoked OpenAI native account service ${String(property)}`) }) as NativeInstanceAccounts
  const create = () => {
    const instances = new Instances(store, () => assert.fail('Claude must not create the OpenAI local gateway'), async id => options.ensure ? options.ensure(id, store) : assert.fail('Claude must not refresh through the OpenAI token authority'), runtime, nativeAccounts)
    managers.push(instances)
    return instances
  }
  const instances = create(), application = instances.registerApplication(executable, 'cli', 'claude_code')
  const api = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Claude fixture API', ANTHROPIC_API_KEY: 'fixture-claude-api-secret', baseUrl: 'http://127.0.0.1:9', models: ['fixture-sonnet'] })).accounts[0]
  const bearer = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Claude fixture bearer', ANTHROPIC_AUTH_TOKEN: 'fixture-claude-bearer-secret', baseUrl: 'http://127.0.0.1:10', models: ['fixture-haiku'] })).accounts[0]
  assert.ok(api && bearer)
  store.transaction(state => { state.accounts.push(api, bearer) })
  const add = (name = 'Claude API', account = api, extraArgs = ["literal $(no-execution);'汉字"], applicationId = application.id) => {
    instances.save({ details: { clientType: 'claude_code', name, applicationId, accountId: account.id, connectionMode: 'native', model: account.models[0], defaultTier: 'inherit', extraArgs } })
    return instances.views().at(-1)!
  }
  const start = async (id: string) => {
    const view = instances.views().find(item => item.id === id)!
    instances.start(instances.preview({ id, revision: view.revision }).ticket)
    await instances.settled(id)
    const updated = instances.views().find(item => item.id === id)!
    assert.equal(updated.status, 'running', updated.error)
  }
  const evidence = (directory: string) => waitFor<Evidence>(() => { try { return JSON.parse(readFileSync(join(directory, 'fixture-claude.json'), 'utf8')) } catch { return } })
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.closeAll().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })
  return { root, store, executable, shellHome, instances, create, application, api, bearer, add, start, evidence, handoffs, children }
}

async function resumeFixture(t:TestContext,options:Parameters<typeof fixture>[1]={},subscription?:StoredAccount) {
  const f=fixture(t,options)
  if(subscription)f.store.transaction(state=>{state.accounts.push(subscription)})
  const instance=f.add('Resume fixture',subscription??f.api,[]),sessionId=randomUUID()
  const project=join(f.root,"project ' literal $(safe)");mkdirSync(project)
  const alternateProject=join(f.root,'alternate-project');mkdirSync(alternateProject)
  const projectDirectory=join(instance.directory,'projects','fixture-resume');mkdirSync(projectDirectory,{recursive:true})
  const transcript=join(projectDirectory,sessionId+'.jsonl')
  writeFileSync(transcript,[JSON.stringify({type:'user',sessionId,cwd:project,message:{role:'user',content:'Synthetic previous conversation'},timestamp:new Date().toISOString()}),JSON.stringify({type:'assistant',sessionId,cwd:alternateProject,message:{content:'Synthetic response from second project'},timestamp:new Date().toISOString()})].join('\n')+'\n')
  const catalog=new SessionCatalog(f.store,id=>f.instances.inUse(id),{defaultClaudeDirectory:null})
  const scan=await catalog.scan({runId:randomUUID(),targetId:instance.id})
  const row=scan.items.find(row=>row.sourceSessionId===sessionId)!
  assert.ok(row)
  const selection={snapshotId:scan.snapshotId,sessionId:row.id,targetId:instance.id}
  const resume=await catalog.claudeResume({...selection,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]})
  return {...f,instance,sessionId,project,alternateProject,projectDirectory,transcript,catalog,selection,resume}
}

test('Claude resume launches the original instance and project without persisting launch overrides', {skip:!supported},async t=>{
  const f=await resumeFixture(t),before=f.store.read(),transcript=readFileSync(f.transcript,'utf8')
  const preview=f.instances.previewClaudeSessionResume(f.resume)
  assert.equal(preview.workingDirectory,f.project);assert.equal(preview.sessionId,f.sessionId)
  assert.deepEqual(preview.args,['--resume',f.sessionId]);assert.equal(preview.accountName,f.api.name)
  assert.deepEqual(f.store.read(),before)
  f.instances.start(preview.ticket);await f.instances.settled(f.instance.id)
  const running=f.instances.views().find(instance=>instance.id===f.instance.id)!
  assert.equal(running.status,'running',running.error)
  assert.equal(running.workingDirectory,f.project)
  const evidence=await f.evidence(f.instance.directory)
  assert.equal(evidence.cwd,f.project);assert.equal(evidence.configDirectory,f.instance.directory)
  assert.deepEqual(evidence.args.slice(-2),['--resume',f.sessionId])
  assert.equal(evidence.apiKey,f.api.credentials.apiKey)
  assert.deepEqual(f.store.read().instances,before.instances)
  assert.equal(readFileSync(f.transcript,'utf8'),transcript)
  assert.throws(()=>f.instances.start(preview.ticket),/过期/)
  assert.throws(()=>f.instances.previewClaudeSessionResume(f.resume),/正在运行/)
  await f.instances.stop(f.instance.id)
})

test('Claude resume accepts a real project path spelling while preserving its directory identity', {skip:!supported}, async t => {
  const f = await resumeFixture(t)
  const literalCwd = f.project + '/'
  writeFileSync(f.transcript, JSON.stringify({ type: 'user', sessionId: f.sessionId, cwd: literalCwd, message: { role: 'user', content: 'Literal project path' }, timestamp: new Date().toISOString() }) + '\n')
  const scan = await f.catalog.scan({ runId: randomUUID(), targetId: f.instance.id })
  const row = scan.items.find(item => item.sourceSessionId === f.sessionId)!
  const resume = await f.catalog.claudeResume({ snapshotId: scan.snapshotId, sessionId: row.id, targetId: f.instance.id,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0] })
  assert.equal(resume.cwd, literalCwd)
  const preview = f.instances.previewClaudeSessionResume(resume)
  assert.equal(preview.workingDirectory, literalCwd)
  f.instances.start(preview.ticket)
  await f.instances.settled(f.instance.id)
  assert.equal(f.instances.views().find(item => item.id === f.instance.id)?.status, 'running')
  assert.equal((await f.evidence(f.instance.directory)).cwd, f.project)
  await f.instances.stop(f.instance.id)
})

test('Claude transcript retains multiple cwd choices and starts from the selected directory; stale cwd identity is rejected',{skip:!supported},async t=>{
  const f=await resumeFixture(t),scan=await f.catalog.scan({runId:randomUUID(),targetId:f.instance.id}),row=scan.items.find(item=>item.sourceSessionId===f.sessionId)!
  assert.deepEqual(row.cwdCandidates,[f.project,f.alternateProject])
  assert.deepEqual(row.cwdAvailableCandidates,[f.project,f.alternateProject])
  const selected=await f.catalog.claudeResume({snapshotId:scan.snapshotId,sessionId:row.id,targetId:f.instance.id,sourceId:row.resumeSourceId!,cwd:f.alternateProject})
  const preview=f.instances.previewClaudeSessionResume(selected)
  assert.equal(preview.workingDirectory,f.alternateProject)
  const changed=join(f.root,'alternate-project-replaced');renameSync(f.alternateProject,changed);mkdirSync(f.alternateProject)
  assert.throws(()=>f.instances.start(preview.ticket),/目录已被替换|身份|变化/)
  assert.equal(f.children.length,0)
  const fresh=await f.catalog.scan({runId:randomUUID(),targetId:f.instance.id}),freshRow=fresh.items.find(item=>item.sourceSessionId===f.sessionId)!
  const freshSelection=await f.catalog.claudeResume({snapshotId:fresh.snapshotId,sessionId:freshRow.id,targetId:f.instance.id,sourceId:freshRow.resumeSourceId!,cwd:f.project})
  const freshPreview=f.instances.previewClaudeSessionResume(freshSelection)
  assert.equal(freshPreview.workingDirectory,f.project)
  f.instances.start(freshPreview.ticket);await f.instances.settled(f.instance.id)
  const evidence=await f.evidence(f.instance.directory)
  assert.equal(evidence.cwd,f.project)
  await f.instances.stop(f.instance.id)
})

test('Claude resume rejects stale files, duplicate IDs, replaced projects and cancelled tickets', {skip:!supported},async t=>{
  const f=await resumeFixture(t)
  let preview=f.instances.previewClaudeSessionResume(f.resume)
  f.instances.discardClaudeSessionResume(preview.ticket)
  assert.throws(()=>f.instances.start(preview.ticket),/过期/)
  preview=f.instances.previewClaudeSessionResume(f.resume)
  const original=readFileSync(f.transcript,'utf8')
  writeFileSync(f.transcript,original+JSON.stringify({type:'assistant',sessionId:f.sessionId,cwd:f.project,message:{content:'Changed'}})+'\n')
  assert.throws(()=>f.instances.start(preview.ticket),/已变化|刷新/)
  const scan=await f.catalog.scan({runId:randomUUID(),targetId:f.instance.id})
  const row=scan.items.find(row=>row.sourceSessionId===f.sessionId)!
  const resume=await f.catalog.claudeResume({snapshotId:scan.snapshotId,sessionId:row.id,targetId:f.instance.id,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]})
  preview=f.instances.previewClaudeSessionResume(resume)
  const duplicate=join(f.instance.directory,'projects','duplicate');mkdirSync(duplicate)
  copyFileSync(f.transcript,join(duplicate,f.sessionId+'.jsonl'))
  assert.throws(()=>f.instances.start(preview.ticket),/冲突|已变化/)
  rmSync(duplicate,{recursive:true})
  const rescan=await f.catalog.scan({runId:randomUUID(),targetId:f.instance.id})
  const refreshedRow=rescan.items.find(row=>row.sourceSessionId===f.sessionId)!
  const refreshed=await f.catalog.claudeResume({snapshotId:rescan.snapshotId,sessionId:refreshedRow.id,targetId:f.instance.id,sourceId:refreshedRow.resumeSourceId!,cwd:refreshedRow.cwdAvailableCandidates![0]})
  preview=f.instances.previewClaudeSessionResume(refreshed)
  renameSync(f.project,f.project+'-old');mkdirSync(f.project)
  assert.throws(()=>f.instances.start(preview.ticket),/项目目录已被替换/)
  assert.equal(f.children.length,0)
})

test('Claude resume rejects a different instance and changed account binding', {skip:!supported},async t=>{
  const f=await resumeFixture(t),other=f.add('Other instance',f.bearer,[])
  assert.throws(()=>f.instances.previewClaudeSessionResume({...f.resume,instanceId:other.id}),/已变化/)
  const preview=f.instances.previewClaudeSessionResume(f.resume)
  f.store.transaction(state=>{state.instances!.find(instance=>instance.id===f.instance.id)!.accountId=f.bearer.id})
  assert.throws(()=>f.instances.start(preview.ticket),/已变化/)
  assert.equal(f.children.length,0)
})

test('interactive resume preserves tool restrictions and refuses automatic prompts or exit modes',()=>{
  assert.doesNotThrow(()=>validateClaudeCodeCliArgs(['--permission-mode','plan','--disallowed-tools','Bash','--effort','high'],[],{interactiveResume:true}))
  for(const args of [['--print'],['--help'],['--no-session-persistence'],['--output-format=json'],['--','send a prompt'],['send a prompt']]){
    assert.throws(()=>validateClaudeCodeCliArgs(args,[],{interactiveResume:true}),/恢复/)
  }
})

for(const kind of ['workspace','registered'] as const)test(`Claude resume uses its existing original project after the default ${kind} directory is deleted`,{skip:!supported},async t=>{
  const f=await resumeFixture(t)
  let removed=join(f.store.directory,'instances',f.instance.id,'workspace')
  if(kind==='registered'){
    removed=join(f.root,'old-default-project');mkdirSync(removed)
    const working=f.instances.registerWorkingDirectory(removed),{id,revision,createdAt:_,...details}=f.store.read().instances!.find(profile=>profile.id===f.instance.id)!
    f.instances.save({id,revision,details:{...details,workingDirectoryId:working.id}})
  }
  const before=f.store.read().instances!,profile=before.find(profile=>profile.id===f.instance.id)!
  rmSync(removed,{recursive:true})
  assert.throws(()=>f.instances.preview({id:profile.id,revision:profile.revision}),/ENOENT/)
  const scan=await f.catalog.scan({runId:randomUUID(),targetId:f.instance.id}),row=scan.items.find(row=>row.sourceSessionId===f.sessionId)!
  const resume=await f.catalog.claudeResume({snapshotId:scan.snapshotId,sessionId:row.id,targetId:f.instance.id,sourceId:row.resumeSourceId!,cwd:row.cwdAvailableCandidates![0]})
  const preview=f.instances.previewClaudeSessionResume(resume)
  assert.equal(preview.workingDirectory,f.project)
  f.instances.start(preview.ticket);await f.instances.settled(f.instance.id)
  const running=f.instances.views().find(instance=>instance.id===f.instance.id)!
  assert.equal(running.status,'running',running.error)
  assert.equal((await f.evidence(f.instance.directory)).cwd,f.project)
  assert.deepEqual(f.store.read().instances,before);assert.equal(existsSync(removed),false)
  const recovered=f.create();await recovered.recover()
  assert.equal(recovered.views().find(instance=>instance.id===f.instance.id)!.workingDirectory,f.project)
  assert.equal(recovered.views().find(instance=>instance.id===f.instance.id)!.pid,running.pid)
  await recovered.stop(f.instance.id)
  assert.equal(existsSync(join(f.store.directory,'instances',f.instance.id,'launch.json')),false)
  assert.equal(existsSync(removed),false);assert.deepEqual(f.store.read().instances,before)
})

test('Claude resumed subscription keeps its project identity across renewal and manager recovery without the default workspace',{skip:!supported},async t=>{
  let refreshes=0
  const subscription=parseClaudeCodeAccountImport(JSON.stringify({accessToken:'resume-initial-access',refreshToken:'resume-vault-refresh',models:['fixture-sonnet']})).accounts[0]
  const f=await resumeFixture(t,{ensure:async(id,store)=>{
    store.transaction(state=>{const account=state.accounts.find(value=>value.id===id)!;account.credentials.accessToken=`resume-access-${++refreshes}`;account.generation=`resume-generation-${refreshes}`})
    return store.read().accounts.find(value=>value.id===id)!
  }},subscription)
  const workspace=join(f.store.directory,'instances',f.instance.id,'workspace'),checkpoint=join(workspace,'..','launch.json'),credentials=join(f.instance.directory,'.credentials.json'),before=f.store.read().instances
  rmSync(workspace,{recursive:true})
  const preview=f.instances.previewClaudeSessionResume(f.resume)
  f.instances.start(preview.ticket);await f.instances.settled(f.instance.id)
  const running=f.instances.views().find(instance=>instance.id===f.instance.id)!
  assert.equal(running.status,'running',running.error);assert.equal(refreshes,1)
  assert.equal((await f.evidence(f.instance.directory)).cwd,f.project)
  const saved=JSON.parse(readFileSync(checkpoint,'utf8')),stat=lstatSync(f.project)
  assert.deepEqual(saved.claudeWorkingDirectory,{path:f.project,canonicalPath:f.project,device:stat.dev,inode:stat.ino})
  assert.equal(readFileSync(checkpoint,'utf8').includes('resume-access'),false)
  // Transcript growth is expected after launch; credential renewal binds the
  // original project and identity, not a permanently frozen conversation body.
  writeFileSync(f.transcript,readFileSync(f.transcript,'utf8')+JSON.stringify({type:'assistant',sessionId:f.sessionId,cwd:f.project,message:{content:'Later completed reply'}})+'\n')
  f.store.transaction(state=>{const account=state.accounts.find(value=>value.id===subscription.id)!;account.credentials.accessToken='resume-live-access';account.generation='resume-live-generation'})
  await f.instances.updateCredentials(f.store.read().accounts.find(value=>value.id===subscription.id)!)
  assert.equal(JSON.parse(readFileSync(credentials,'utf8')).claudeAiOauth.accessToken,'resume-live-access')
  const recovered=f.create();await recovered.recover()
  const recoveredView=recovered.views().find(instance=>instance.id===f.instance.id)!
  assert.equal(recoveredView.status,'running',recoveredView.error);assert.equal(recoveredView.pid,running.pid);assert.equal(recoveredView.workingDirectory,f.project)
  assert.equal(refreshes,2);assert.equal(JSON.parse(readFileSync(credentials,'utf8')).claudeAiOauth.accessToken,'resume-access-2')
  assert.deepEqual(f.store.read().instances,before);assert.equal(existsSync(workspace),false)
  renameSync(f.project,f.project+'-old');mkdirSync(f.project)
  await assert.rejects(recovered.updateCredentials(f.store.read().accounts.find(value=>value.id===subscription.id)!),/项目目录已被替换/)
  const replaced=f.create();await replaced.recover()
  assert.equal(replaced.views().find(instance=>instance.id===f.instance.id)!.status,'error')
  assert.equal(refreshes,2,'A replaced original project must block renewal before refreshing credentials')
  await replaced.stop(f.instance.id)
  assert.equal(existsSync(credentials),false);assert.equal(existsSync(checkpoint),false)
  assert.deepEqual(f.store.read().instances,before)
})

test('Claude API and Bearer use concurrent owned native processes and consume a private secret handoff', { skip: !supported }, async t => {
  const f = fixture(t), first = f.add(), second = f.add('Claude Bearer', f.bearer)
  const settings = '{"theme":"light","permissions":{"deny":["WebFetch"]}}\n'
  writeFileSync(join(first.directory, 'settings.json'), settings)
  const preview = f.instances.preview({ id: first.id, revision: first.revision })
  assert.equal(preview.clientType, 'claude_code'); assert.equal(preview.identityStatus, 'api_configured')
  assert.ok(!JSON.stringify(preview).includes(f.api.credentials.apiKey!))
  await f.start(first.id); await f.start(second.id)
  const a = await f.evidence(first.directory), b = await f.evidence(second.directory)
  assert.notEqual(a.pid, b.pid); assert.equal(a.configDirectory, first.directory); assert.equal(b.configDirectory, second.directory)
  assert.equal(a.apiKey, f.api.credentials.apiKey); assert.equal(a.bearer, '')
  assert.equal(b.apiKey, ''); assert.equal(b.bearer, f.bearer.credentials.apiKey)
  for (const result of [a, b]) {
    assert.equal(result.home, f.shellHome)
    for (const key of ['oauth', 'profile', 'bedrock', 'openAIKey', 'codexHome', 'projectDirectoryOverride', 'nodeOptions'] as const) assert.equal(result[key], '', key)
    assert.match(result.argv0, /^--cml-instance=/)
    assert.deepEqual(result.args.slice(0, 8), ['--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', result.model, "literal $(no-execution);'汉字"])
  }
  assert.equal(a.model, 'fixture-sonnet'); assert.equal(b.model, 'fixture-haiku')
  assert.equal(a.baseUrl, f.api.baseUrl); assert.equal(b.baseUrl, f.bearer.baseUrl)
  assert.equal(f.handoffs.length, 2)
  for (const handoff of f.handoffs) {
    assert.equal(handoff.mode, 0o600); assert.equal(existsSync(handoff.path), false)
    assert.ok(!handoff.script.includes(f.api.credentials.apiKey!) && !handoff.script.includes(f.bearer.credentials.apiKey!))
  }
  for (const instance of [first, second]) {
    const checkpoint = readFileSync(join(f.store.directory, 'instances', instance.id, 'launch.json'), 'utf8')
    assert.ok(!checkpoint.includes('secret'))
    assert.equal(existsSync(join(instance.directory, 'auth.json')), false)
    assert.equal(existsSync(join(instance.directory, 'config.toml')), false)
    assert.ok(existsSync(join(instance.directory, transcriptName)))
  }
  const transcript = readFileSync(join(first.directory, transcriptName), 'utf8')
  await f.instances.stop(first.id)
  assert.throws(() => process.kill(a.pid, 0)); assert.doesNotThrow(() => process.kill(b.pid, 0))
  assert.equal(readFileSync(join(first.directory, 'settings.json'), 'utf8'), settings)
  assert.equal(readFileSync(join(first.directory, transcriptName), 'utf8'), transcript)
  await f.instances.stop(second.id)
})

test('Claude subscription launch refreshes before projection, updates live and keeps refresh tokens in the vault', { skip: !supported }, async t => {
  let refreshed = 0
  const f = fixture(t, { ensure: async (id, store) => {
    refreshed++
    store.transaction(state => {
      const account = state.accounts.find(value => value.id === id)!
      account.credentials = { ...account.credentials, accessToken: 'refreshed-subscription-access', refreshToken: 'rotated-vault-refresh', expiresAt: Date.now() + 3600_000 }
      account.generation = 'refreshed-generation'
    })
    return store.read().accounts.find(value => value.id === id)!
  } })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Synthetic subscription', accessToken: 'expired-subscription-access', refreshToken: 'vault-only-refresh', expiresAt: Date.now() - 1, models: ['fixture-sonnet'], scopes: ['user:profile', 'user:inference'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Subscription', subscription), peer = f.add('API peer', f.api)
  const preview = f.instances.preview({ id: instance.id, revision: instance.revision })
  assert.equal(preview.identityStatus, 'subscription_configured')
  assert.equal(JSON.stringify(preview).includes('subscription-access'), false)
  await f.start(instance.id); await f.start(peer.id)
  assert.equal(refreshed, 1)
  const evidence = await f.evidence(instance.directory), credentialFile = join(instance.directory, '.credentials.json')
  assert.equal(evidence.oauth, ''); assert.equal(evidence.apiKey, ''); assert.equal(evidence.bearer, '')
  let credentials = readFileSync(credentialFile, 'utf8')
  assert.equal(JSON.parse(credentials).claudeAiOauth.accessToken, 'refreshed-subscription-access')
  assert.equal(JSON.parse(credentials).claudeAiOauth.refreshToken, null)
  assert.equal(lstatSync(credentialFile).mode & 0o777, 0o600)
  for (const secret of ['vault-only-refresh', 'rotated-vault-refresh', 'expired-subscription-access']) assert.equal(credentials.includes(secret), false)
  for (const handoff of f.handoffs) assert.equal(handoff.body.includes('subscription-access') || handoff.script.includes('subscription-access'), false)
  const checkpoint = readFileSync(join(f.store.directory, 'instances', instance.id, 'launch.json'), 'utf8')
  assert.equal(checkpoint.includes('subscription-access') || checkpoint.includes('refresh'), false)
  f.store.transaction(state => { state.accounts.find(value => value.id === subscription.id)!.credentials.accessToken = 'live-subscription-access' })
  await f.instances.updateCredentials(f.store.read().accounts.find(value => value.id === subscription.id)!)
  credentials = readFileSync(credentialFile, 'utf8')
  assert.equal(JSON.parse(credentials).claudeAiOauth.accessToken, 'live-subscription-access')
  const peerEvidence = await f.evidence(peer.directory)
  await f.instances.stop(instance.id)
  assert.equal(existsSync(credentialFile), false)
  assert.doesNotThrow(() => process.kill(peerEvidence.pid, 0))
  assert.equal(f.store.read().accounts.find(value => value.id === subscription.id)!.credentials.refreshToken, 'rotated-vault-refresh')
})

test('Claude subscription cancellation while refreshing leaves no native credential or late process', { skip: !supported }, async t => {
  let release!: () => void, started!: () => void
  const refreshing = new Promise<void>(resolveRefresh => { started = resolveRefresh }), pending = new Promise<void>(resolvePending => { release = resolvePending })
  const f = fixture(t, { ensure: async (id, store) => { started(); await pending; return store.read().accounts.find(value => value.id === id)! } })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-subscription-access', refreshToken: 'synthetic-vault-refresh', models: ['fixture-sonnet'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Cancelled subscription', subscription)
  f.instances.start(f.instances.preview({ id: instance.id, revision: instance.revision }).ticket)
  await refreshing
  const stop = f.instances.stop(instance.id); release(); await stop
  assert.equal(f.handoffs.length, 0)
  assert.equal(existsSync(join(instance.directory, '.credentials.json')), false)
  assert.equal(existsSync(join(instance.directory, 'fixture-claude.json')), false)
})

test('Claude subscription startup failure removes only its projection and preserves an existing native login', { skip: !supported }, async t => {
  const f = fixture(t, { ensure: async (id, store) => store.read().accounts.find(value => value.id === id)!, open: async () => { throw new Error('synthetic Terminal failure') } })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-subscription-access', models: ['fixture-sonnet'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Failed subscription', subscription)
  f.instances.start(f.instances.preview({ id: instance.id, revision: instance.revision }).ticket); await f.instances.settled(instance.id)
  assert.equal(f.instances.views().find(value => value.id === instance.id)!.status, 'error')
  assert.equal(existsSync(join(instance.directory, '.credentials.json')), false)
  await f.instances.stop(instance.id)
  const preserved = '{"claudeAiOauth":{"accessToken":"independent-user-login"}}'
  writeFileSync(join(instance.directory, '.credentials.json'), preserved, { mode: 0o600 })
  const current = f.instances.views().find(value => value.id === instance.id)!
  f.instances.start(f.instances.preview({ id: instance.id, revision: current.revision }).ticket); await f.instances.settled(instance.id)
  assert.equal(readFileSync(join(instance.directory, '.credentials.json'), 'utf8'), preserved)
  assert.match(f.instances.views().find(value => value.id === instance.id)!.error ?? '', /已有独立登录|登录凭据|已保留/)
})

test('Claude subscription recovery resumes renewal for an owned process without a vanished relay', { skip: !supported }, async t => {
  let refreshes = 0
  const f = fixture(t, { ensure: async (id, store) => {
    store.transaction(state => { const account = state.accounts.find(value => value.id === id)!; account.credentials.accessToken = `recovery-access-${++refreshes}`; account.generation = `recovery-generation-${refreshes}` })
    return store.read().accounts.find(value => value.id === id)!
  } })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-initial-access', refreshToken: 'synthetic-vault-refresh', models: ['fixture-sonnet'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Recovered subscription', subscription); await f.start(instance.id)
  const original = await f.evidence(instance.directory), recovered = f.create()
  await recovered.recover()
  assert.equal(recovered.views().find(value => value.id === instance.id)!.status, 'running')
  assert.equal(recovered.views().find(value => value.id === instance.id)!.pid, original.pid)
  assert.deepEqual(recovered.accountIds(), [subscription.id])
  assert.equal(JSON.parse(readFileSync(join(instance.directory, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'recovery-access-2')
  f.store.transaction(state => { const account = state.accounts.find(value => value.id === subscription.id)!; account.credentials.accessToken = 'recovery-access-3'; account.generation = 'recovery-generation-3' })
  await recovered.updateCredentials(f.store.read().accounts.find(value => value.id === subscription.id)!)
  assert.equal(JSON.parse(readFileSync(join(instance.directory, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'recovery-access-3')
  await recovered.stop(instance.id)
  assert.equal(existsSync(join(instance.directory, '.credentials.json')), false)
})

for (const change of ['organization', 'settings', 'proxy'] as const) test(`Claude subscription refuses live projection and recovery after ${change} changes`, { skip: !supported }, async t => {
  const f = fixture(t, { ensure: async (id, store) => store.read().accounts.find(value => value.id === id)! })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-initial-access', refreshToken: 'synthetic-vault-refresh', models: ['fixture-sonnet'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Boundary subscription', subscription); await f.start(instance.id)
  await f.evidence(instance.directory)
  const path = join(instance.directory, '.credentials.json'), original = readFileSync(path, 'utf8')
  if (change === 'settings') writeFileSync(join(instance.directory, 'settings.json'), '{"theme":"changed"}')
  else f.store.transaction(state => {
    const account = state.accounts.find(value => value.id === subscription.id)!
    if (change === 'organization') account.claudeSubscription = { ...account.claudeSubscription, organizationId: 'other-organization' }
    else account.proxy = { mode: 'direct' }
    account.credentials.accessToken = 'must-not-project-after-change'
  })
  await assert.rejects(f.instances.updateCredentials(f.store.read().accounts.find(value => value.id === subscription.id)!), /身份或配置已变化/)
  assert.equal(readFileSync(path, 'utf8'), original)
  const recovered = f.create(); await recovered.recover()
  assert.equal(recovered.views().find(value => value.id === instance.id)!.status, 'error')
  assert.equal(readFileSync(path, 'utf8'), original)
  await recovered.stop(instance.id)
})

test('Claude subscription ignores a late credential projection after replacement and stop', { skip: !supported }, async t => {
  const f = fixture(t, { ensure: async (id, store) => store.read().accounts.find(value => value.id === id)! })
  const subscription = parseClaudeCodeAccountImport(JSON.stringify({ accessToken: 'synthetic-initial-access', models: ['fixture-sonnet'] })).accounts[0]
  f.store.transaction(state => { state.accounts.push(subscription) })
  const instance = f.add('Late update subscription', subscription); await f.start(instance.id)
  await f.evidence(instance.directory)
  const path = join(instance.directory, '.credentials.json'), old = f.store.read().accounts.find(value => value.id === subscription.id)!
  const late = f.instances.updateCredentials(old)
  f.store.transaction(state => { const account = state.accounts.find(value => value.id === subscription.id)!; account.credentials.accessToken = 'new-generation-access'; account.generation = 'new-generation' })
  const current = f.store.read().accounts.find(value => value.id === subscription.id)!
  await Promise.all([late, f.instances.updateCredentials(current)])
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth.accessToken, 'new-generation-access')
  await f.instances.stop(instance.id); await f.instances.updateCredentials(old); await f.instances.updateCredentials(current)
  assert.equal(existsSync(path), false)
})

test('Claude cards keep their CLI mode and report missing or incompatible connections accurately', {skip:!supported}, t=>{
  const f=fixture(t),instance=f.add()
  assert.equal(f.instances.views()[0].identityStatus,'api_configured')
  f.store.transaction(state=>{state.accounts[0].protocol='openai_responses';state.instanceApplications=[]})
  assert.equal(f.instances.views()[0].identityStatus,'unknown')
  assert.equal(f.instances.views()[0].launchMode,'cli')
  f.store.transaction(state=>{state.accounts=state.accounts.filter(account=>account.id!==instance.accountId)})
  assert.equal(f.instances.views()[0].identityStatus,'missing')
  assert.throws(()=>f.instances.preview({id:instance.id,revision:instance.revision}),/连接已删除/)
})

test('Claude restart recovery retains the live process and preserves its final user settings and sessions', { skip: !supported }, async t => {
  const f = fixture(t), first = f.add(), second = f.add('Claude peer', f.bearer)
  await f.start(first.id); await f.start(second.id)
  const a = await f.evidence(first.directory), b = await f.evidence(second.directory)
  const transcript = readFileSync(join(first.directory, transcriptName), 'utf8')
  const finalSettings = '{"theme":"dark","fixtureSettingAfterExit":true}\n'
  writeFileSync(join(first.directory, 'fixture-write-settings.json'), finalSettings)
  const reopened = f.create(); await reopened.recover()
  assert.equal(reopened.views().find(item => item.id === first.id)?.pid, a.pid)
  assert.equal(reopened.views().find(item => item.id === first.id)?.status, 'error')
  assert.doesNotThrow(() => process.kill(a.pid, 0)); assert.doesNotThrow(() => process.kill(b.pid, 0))
  await reopened.stop(first.id)
  assert.throws(() => process.kill(a.pid, 0)); assert.doesNotThrow(() => process.kill(b.pid, 0))
  assert.equal(readFileSync(join(first.directory, 'settings.json'), 'utf8'), finalSettings)
  assert.equal(readFileSync(join(first.directory, transcriptName), 'utf8'), transcript)
  assert.equal(existsSync(join(f.store.directory, 'instances', first.id, 'launch.json')), false)
  await reopened.stop(second.id)
})

test('Claude natural exit is recovered without deleting user configuration or transcript state', { skip: !supported }, async t => {
  const f = fixture(t), instance = f.add(); await f.start(instance.id)
  const value = await f.evidence(instance.directory), settings = '{"theme":"dark","keepOnExit":true}\n'
  writeFileSync(join(instance.directory, 'fixture-write-settings.json'), settings)
  process.kill(value.pid, 'SIGTERM')
  await waitFor(() => { try { process.kill(value.pid, 0); return } catch { return true } })
  const reopened = f.create(); await reopened.recover()
  assert.equal(reopened.views()[0].status, 'stopped')
  assert.equal(readFileSync(join(instance.directory, 'settings.json'), 'utf8'), settings)
  assert.ok(existsSync(join(instance.directory, transcriptName)))
  assert.equal(existsSync(join(instance.directory, '.claude.json')), true)
})

test('Claude deferred terminal cancellation revokes the permit and deletes unconsumed credentials', { skip: !supported }, async t => {
  let scriptText = '', release: (() => void) | undefined
  const f = fixture(t, { open: async script => { scriptText = readFileSync(script, 'utf8'); await new Promise<void>(resolveOpen => { release = resolveOpen }) } })
  const instance = f.add(), preview = f.instances.preview({ id: instance.id, revision: 0 })
  f.instances.start(preview.ticket)
  await waitFor(() => release)
  assert.equal(existsSync(f.handoffs[0].path), true)
  const stopped = f.instances.stop(instance.id); release!(); await stopped
  assert.equal(f.instances.views()[0].status, 'stopped'); assert.equal(existsSync(f.handoffs[0].path), false)
  const delayed = spawn('/bin/bash', ['-c', scriptText], { stdio: 'ignore' })
  const code = await new Promise(resolveExit => delayed.once('close', resolveExit))
  assert.notEqual(code, 0)
  assert.equal(existsSync(join(instance.directory, 'fixture-claude.json')), false)
})

test('Claude terminal failure cleans the secret handoff and keeps the original settings', { skip: !supported }, async t => {
  const f = fixture(t, { open: async () => { throw new Error('simulated Terminal failure') } }), instance = f.add()
  const settings = '{"theme":"light"}\n'; writeFileSync(join(instance.directory, 'settings.json'), settings)
  f.instances.start(f.instances.preview({ id: instance.id, revision: 0 }).ticket); await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status, 'error')
  assert.equal(f.handoffs.length, 1); assert.equal(existsSync(f.handoffs[0].path), false)
  assert.equal(readFileSync(join(instance.directory, 'settings.json'), 'utf8'), settings)
  assert.equal(existsSync(join(instance.directory, 'fixture-claude.json')), false)
  assert.equal(existsSync(join(f.store.directory, 'instances', instance.id, 'launch.json')), false)
})

test('Claude client exiting during startup preserves its files and leaves another instance running', { skip: !supported }, async t => {
  const f = fixture(t), peer = f.add('Healthy Claude peer', f.bearer), failing = f.add('Early exit', f.api, [])
  await f.start(peer.id)
  const peerEvidence = await f.evidence(peer.directory), settings = '{"theme":"light","preserveAfterFailure":true}\n'
  writeFileSync(join(failing.directory, 'settings.json'), settings)
  writeFileSync(join(failing.directory, 'fixture-exit-immediately'), 'exit 3')
  f.instances.start(f.instances.preview({ id: failing.id, revision: 0 }).ticket); await f.instances.settled(failing.id)
  assert.equal(f.instances.views().find(item => item.id === failing.id)?.status, 'error')
  assert.doesNotThrow(() => process.kill(peerEvidence.pid, 0))
  assert.equal(f.instances.views().find(item => item.id === peer.id)?.status, 'running')
  assert.equal(readFileSync(join(failing.directory, 'settings.json'), 'utf8'), settings)
  assert.ok(existsSync(join(failing.directory, transcriptName)))
  assert.ok(f.handoffs.every(handoff => !existsSync(handoff.path)))
  assert.equal(existsSync(join(f.store.directory, 'instances', failing.id, 'launch.json')), false)
})

test('Claude preview detects changed settings, account credentials and executable ownership before launch', { skip: !supported }, async t => {
  for (const change of ['settings', 'account', 'executable'] as const) await t.test(change, async subtest => {
    const f = fixture(subtest), instance = f.add()
    const settings = join(instance.directory, 'settings.json'); writeFileSync(settings, '{"theme":"light"}')
    const preview = f.instances.preview({ id: instance.id, revision: 0 })
    if (change === 'settings') writeFileSync(settings, '{"theme":"dark"}')
    if (change === 'account') f.store.transaction(state => { state.accounts[0].credentials.apiKey = 'fixture-account-changed' })
    if (change === 'executable') { renameSync(f.executable, `${f.executable}.old`); copyFileSync(binary, f.executable) }
    assert.throws(() => f.instances.start(preview.ticket), /变化|替换/)
    assert.equal(f.handoffs.length, 0); assert.equal(existsSync(join(instance.directory, 'fixture-claude.json')), false)
  })
})

test('Claude upgrade missing a managed isolation flag is blocked before secret handoff', { skip: !supported }, async t => {
  const f = fixture(t, { missingFlags: true }), instance = f.add()
  f.instances.start(f.instances.preview({ id: instance.id, revision: 0 }).ticket); await f.instances.settled(instance.id)
  assert.equal(f.instances.views()[0].status, 'error')
  assert.match(f.instances.views()[0].error ?? '', /缺少受管参数/)
  assert.equal(f.handoffs.length, 0); assert.equal(existsSync(join(instance.directory, 'fixture-claude.json')), false)
})

test('Claude rejects unsupported OAuth identities and non-native CLI boundaries', { skip: !supported }, t => {
  const f = fixture(t)
  const oauth = parseClaudeCodeAccountImport(JSON.stringify({ name: 'Pending subscription', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fixture', models: ['fixture-sonnet'] })).accounts[0]
  const openai = createAPIAccount({ name: 'OpenAI boundary fixture', note: '', tags: [], apiKey: 'fixture-openai', baseUrl: 'http://127.0.0.1:9/v1', models: ['fixture-sonnet'], wireApi: 'responses', defaultTier: 'inherit' })
  f.store.transaction(state => { state.accounts.push(oauth, openai) })
  assert.equal(f.add(oauth.name, oauth).identityStatus, 'subscription_configured')
  assert.throws(() => f.add(openai.name, openai), /尚未|兼容|Anthropic|凭据|登录/)
  const badOAuth = { ...oauth, credentialKind: 'openai_oauth' as const }
  f.store.transaction(state => { state.accounts = state.accounts.map(account => account.id === oauth.id ? badOAuth : account) })
  assert.throws(() => f.add('Wrong OAuth service', badOAuth), /尚未|兼容|Anthropic|凭据|登录/)
  assert.throws(() => f.instances.save({ details: { clientType: 'claude_code', name: 'Unsupported local API', applicationId: f.application.id, accountId: f.api.id, connectionMode: 'local_api', model: 'fixture-sonnet', extraArgs: [] } }), /本地 API|直连|支持|尚未/)
  const script = join(f.root, 'claude.js'); writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  assert.throws(() => {
    const app = f.instances.registerApplication(script, 'cli', 'claude_code')
    const view = f.add('Script rejected', f.api, [], app.id)
    f.instances.preview({ id: view.id, revision: 0 })
  }, /原生/)
  assert.throws(() => f.instances.registerApplication(f.executable, 'desktop', 'claude_code'), /Claude\.app|Desktop|隔离/)
  for (const args of [['auth', 'login'], ['setup-token'], ['update'], ['mcp', 'add'], ['-rforeign-session'], ['-mforeign-model'], ['-wother-worktree']]) {
    assert.throws(() => f.add(`Rejected ${args[0]}`, f.api, args), /参数|命令|覆盖|允许/)
  }
  assert.equal(f.handoffs.length, 0)
})

test('Claude stable launcher upgrades retain the application ID and recover each running executable', { skip: !supported }, async t => {
  const f = fixture(t), launcher = join(f.root, 'claude-current'), versionTwo = join(f.root, 'claude-version-two')
  copyFileSync(binary, versionTwo); symlinkSync(f.executable, launcher)
  const application = f.instances.registerApplication(launcher, 'cli', 'claude_code')
  const first = f.add('Running old version', f.api, [], application.id), second = f.add('Waiting for upgrade', f.bearer, [], application.id)
  const stalePreview = f.instances.preview({ id: second.id, revision: 0 })
  await f.start(first.id)
  const oldProcess = await f.evidence(first.directory)
  const firstCheckpoint = JSON.parse(readFileSync(join(f.store.directory, 'instances', first.id, 'launch.json'), 'utf8'))
  assert.equal(firstCheckpoint.claudeExecutable, f.executable)
  assert.equal(existsSync(`${versionTwo}.help-probe`), false)
  rmSync(launcher); symlinkSync(versionTwo, launcher)
  const detected = f.instances.applications().find(item => item.id === application.id)
  assert.equal(detected?.id, application.id); assert.equal(detected?.path, versionTwo)
  assert.equal(f.instances.views().find(item => item.id === second.id)?.applicationId, application.id)
  assert.throws(() => f.instances.start(stalePreview.ticket), /变化|替换/)
  await f.start(second.id)
  const newProcess = await f.evidence(second.directory)
  assert.equal(existsSync(`${versionTwo}.help-probe`), true)
  assert.equal(f.instances.views().find(item => item.id === second.id)?.clientVersion, '2.2.0')
  const reopened = f.create(); await reopened.recover()
  assert.equal(reopened.views().find(item => item.id === first.id)?.pid, oldProcess.pid)
  assert.equal(reopened.views().find(item => item.id === second.id)?.pid, newProcess.pid)
  await reopened.stop(first.id)
  assert.throws(() => process.kill(oldProcess.pid, 0)); assert.doesNotThrow(() => process.kill(newProcess.pid, 0))
  await reopened.stop(second.id)
})

test('Claude recovery locates the saved native process after the stable launcher and old version disappear', { skip: !supported }, async t => {
  const f = fixture(t), launcher = join(f.root, 'claude-current'), versionTwo = join(f.root, 'claude-version-two')
  copyFileSync(binary, versionTwo); symlinkSync(f.executable, launcher)
  const application = f.instances.registerApplication(launcher, 'cli', 'claude_code')
  const instance = f.add('Surviving upgrade', f.api, [], application.id)
  rmSync(launcher); symlinkSync(versionTwo, launcher)
  await f.start(instance.id)
  const live = await f.evidence(instance.directory)
  assert.equal(JSON.parse(readFileSync(join(f.store.directory, 'instances', instance.id, 'launch.json'), 'utf8')).claudeExecutable, versionTwo)
  rmSync(launcher); rmSync(f.executable)
  const reopened = f.create(); await reopened.recover()
  assert.equal(reopened.views().find(item => item.id === instance.id)?.pid, live.pid)
  assert.doesNotThrow(() => process.kill(live.pid, 0))
  await reopened.stop(instance.id)
  assert.throws(() => process.kill(live.pid, 0))
  assert.ok(existsSync(join(instance.directory, transcriptName)))
})
