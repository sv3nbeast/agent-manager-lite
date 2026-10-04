import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../src/main/store'
import { parseAccountImport, importParsedAccounts, editAccount } from '../src/main/accounts'
import { serializeAccounts } from '../src/main/accountFiles'
import { AgentIdentityService, taskDecryptor } from '../src/main/agentIdentity'
import { privateKey, parseAgentIdentity, agentAssertion, signAgentTask, type AgentIdentity } from '../src/main/agentIdentityCredentials'
import { AgentTaskProjection } from '../src/main/agentTaskProjection'
import { requestJSON, HTTPError } from '../src/main/network'
import { TokenAuthority } from '../src/main/tokens'
import { QuotaService } from '../src/main/quota'
import { Gateway } from '../src/main/gateway'
import { settingsSchema } from '../src/shared/types'

function identity(task: string | undefined = 'task-initial'): AgentIdentity {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return { agent_runtime_id: 'runtime-fixture', agent_private_key: key, account_id: 'org-fixture', chatgpt_user_id: 'user-fixture', task_id: task,
    chatgpt_account_is_fedramp: true, email: 'fixture@example.invalid' }
}
function vault(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'cml-agent-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return new Store(directory, { encrypt: v => Buffer.from(v), decrypt: v => v.toString() })
}
function add(store: Store, agent = identity()) {
  const parsed = parseAccountImport(JSON.stringify({ agent_identity: agent }))
  assert.deepEqual(parsed.preview.errors, [])
  importParsedAccounts(store, parsed.accounts)
  return parsed.accounts[0]
}
const noDecrypt = async () => { throw new Error('unexpected encrypted task') }

test('Agent Identity validates PKCS#8/ring keys and verifies signatures independently', () => {
  const agent = identity(), key = privateKey(agent.agent_private_key), publicKey = createPublicKey(key)
  const seed = key.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  for (const [prefix, suffix] of [['3053020101300506032b657004220420', 'a123032100'], ['3051020101300506032b657004220420', '812100']]) {
    const der = Buffer.concat([Buffer.from(prefix, 'hex'), seed, Buffer.from(suffix, 'hex'), publicBytes])
    assert.deepEqual(privateKey(der.toString('base64')).export({ format: 'der', type: 'pkcs8' }), key.export({ format: 'der', type: 'pkcs8' }))
    der[der.length - 1] ^= 1
    assert.throws(() => privateKey(der.toString('base64')), /公钥/)
  }
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  assert.throws(() => privateKey(ec), /Ed25519/)
  for (const value of ['', 'private-secret%', agent.agent_private_key + ' ', 'a'.repeat(16385)]) assert.throws(() => privateKey(value))
  const now = Date.parse('2026-10-01T01:02:03.456Z')
  const registration = signAgentTask(agent, now)
  assert.equal(registration.timestamp, '2026-10-01T01:02:03Z')
  assert.ok(verify(null, Buffer.from(`runtime-fixture:${registration.timestamp}`), publicKey, Buffer.from(registration.signature, 'base64')))
  const assertion = agentAssertion(agent, now)
  assert.match(assertion, /^AgentAssertion [A-Za-z0-9_-]+$/)
  const envelope = JSON.parse(Buffer.from(assertion.split(' ')[1], 'base64url').toString())
  assert.ok(verify(null, Buffer.from(`${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`), publicKey, Buffer.from(envelope.signature, 'base64')))
})

test('Agent Identity aliases, deduplication, export and snapshots preserve identity without disclosing keys', t => {
  const store = vault(t), agent = identity()
  const aliases = { agentRuntimeId: agent.agent_runtime_id, agentPrivateKey: agent.agent_private_key, taskId: agent.task_id,
    accountId: agent.account_id, chatgptUserId: agent.chatgpt_user_id, chatgptAccountIsFedramp: true }
  for (const source of [{ agent_identity: agent }, { agentIdentity: aliases }, { credentials: { agentIdentity: aliases } },
    { authMode: 'agentIdentity', credentials: aliases }, { credentials: agent }, { auth_mode: 'agentIdentity', ...agent }]) {
    const parsed = parseAccountImport(JSON.stringify(source))
    assert.equal(parsed.preview.errors.length, 0)
    assert.equal(parsed.accounts[0].kind, 'agent_identity')
    assert.equal(parsed.accounts[0].credentials.agentIdentity!.agent_private_key, agent.agent_private_key)
    assert.equal(JSON.stringify(parsed.preview).includes(agent.agent_private_key), false)
  }
  assert.equal(parseAgentIdentity({ agent_identity: { ...agent, chatgpt_account_id: 'lower-priority' } })!.account_id, agent.account_id)
  for (const fields of [{ task_id: 'invalid\nheader' }, { account_id: '' }, { chatgpt_account_is_fedramp: 'true' }, { agent_private_key: 'fixture-secret' }]) {
    const result = parseAccountImport(JSON.stringify({ agent_identity: { ...agent, ...fields } }))
    assert.equal(result.accounts.length, 0)
    assert.equal(result.preview.errors.join('').includes('fixture-secret'), false)
  }
  const account = add(store, agent)
  assert.deepEqual(importParsedAccounts(store, [parseAccountImport(JSON.stringify({ agent_identity: { ...agent, agent_runtime_id: 'another-runtime' } })).accounts[0]]), { added: 0, duplicates: 1 })
  add(store, { ...agent, chatgpt_user_id: 'another-user' })
  assert.equal(store.read().accounts.length, 2)
  assert.equal(store.snapshot().accounts[0].credentialConfigured, true)
  assert.equal(JSON.stringify(store.snapshot()).includes(agent.agent_private_key), false)
  const exported = serializeAccounts(store.read().accounts)
  assert.equal(parseAccountImport(exported).accounts[0].credentials.agentIdentity!.task_id, agent.task_id)
  assert.throws(() => editAccount(store, { id: account.id, revision: 0, changes: { apiKey: 'fake' } }), /仅支持/)
  editAccount(store, { id: account.id, revision: 0, changes: { note: 'metadata only' } })
  assert.equal(store.read().accounts[0].credentials.agentIdentity!.agent_private_key, agent.agent_private_key)
})

test('Agent task registration coalesces and persists before projection; stale completions cannot resurrect credentials', async t => {
  const store = vault(t), agent = identity(); delete agent.task_id
  const account = add(store, agent)
  let calls = 0
  const service = new AgentIdentityService(store, noDecrypt, async (_url, init) => {
    calls++; assert.equal((init?.headers as Record<string, string>).Authorization, undefined)
    await delay(10); return { task_id: 'task-new' }
  }, current => assert.equal(store.read().accounts[0].credentials.agentIdentity!.task_id, current.credentials.agentIdentity!.task_id))
  await Promise.all(Array.from({ length: 8 }, () => service.ensure(account.id)))
  assert.equal(calls, 1)
  await service.ensure(account.id, 'task-initial'); assert.equal(calls, 1)
  service.adopt(account.id, { ...agent, task_id: 'task-newer' }, 'task-new')
  assert.equal(service.adopt(account.id, { ...agent, task_id: 'task-stale' }, 'task-new')!.credentials.agentIdentity!.task_id, 'task-newer')
  await service.stop()
  for (const remove of [false, true]) {
    const data = vault(t), entry = add(data, agent)
    let release!: (value: Record<string, unknown>) => void
    const auth = new AgentIdentityService(data, noDecrypt, () => new Promise(resolve => { release = resolve }))
    const pending = auth.ensure(entry.id)
    data.transaction(state => { if (remove) state.accounts = []; else state.accounts[0].credentials.agentIdentity = identity() })
    release({ taskId: 'task-late' })
    await assert.rejects(pending, /已改变/)
    assert.equal(data.read().accounts[0]?.credentials.agentIdentity?.task_id, remove ? undefined : 'task-initial')
    await auth.stop()
  }
  const data = vault(t), entry = add(data, agent)
  const failingProjection = new AgentIdentityService(data, noDecrypt, async () => ({ task_id: 'durable' }), () => { throw new Error('projection failed') })
  await assert.rejects(failingProjection.ensure(entry.id), /projection failed/)
  assert.equal(data.read().accounts[0].credentials.agentIdentity!.task_id, 'durable')
  await failingProjection.stop()
})

test('Agent quota signs local HTTP requests, recovers only invalid task 401 once, and never enters OAuth refresh', async t => {
  const store = vault(t), account = add(store), agent = account.credentials.agentIdentity!
  let registrations = 0, usage = 0, mode = 'task'
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/task/register')) {
      registrations++
      let raw = ''; for await (const part of req) raw += part
      const payload = JSON.parse(raw)
      assert.ok(verify(null, Buffer.from(`${agent.agent_runtime_id}:${payload.timestamp}`), createPublicKey(privateKey(agent.agent_private_key)), Buffer.from(payload.signature, 'base64')))
      res.end('{"task_id":"task-recovered"}'); return
    }
    usage++
    assert.equal(req.headers['chatgpt-account-id'], agent.account_id)
    assert.equal(req.headers['x-openai-fedramp'], 'true')
    const envelope = JSON.parse(Buffer.from(req.headers.authorization!.split(' ')[1], 'base64url').toString())
    assert.ok(verify(null, Buffer.from(`${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`), createPublicKey(privateKey(agent.agent_private_key)), Buffer.from(envelope.signature, 'base64')))
    if (mode === 'unauthorized') { res.writeHead(401).end('{"error":"invalid_token","secret":"fixture-not-public"}'); return }
    if (envelope.task_id === 'task-initial') { res.writeHead(401).end('{"error": {"code": "invalid_task_id"}}'); return }
    res.end('{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":37}}}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const request: typeof requestJSON = (url, init, op) => requestJSON(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init, op)
  const agents = new AgentIdentityService(store, noDecrypt, request)
  const tokens = new TokenAuthority(store, async () => { assert.fail('Agent Identity must not use OAuth') })
  const quota = new QuotaService(store, tokens, undefined, agents)
  quota.startAll(); await quota.settled()
  assert.equal(quota.current().failed, 0); assert.equal(registrations, 1); assert.equal(usage, 2)
  assert.equal(store.snapshot().accounts[0].quota?.windows[0].usedPercent, 37)
  mode = 'unauthorized'
  quota.startAll(); await quota.settled()
  assert.equal(quota.current().failed, 1); assert.equal(registrations, 1); assert.equal(usage, 3)
  assert.equal(store.snapshot().accounts[0].quota?.windows[0].usedPercent, 37)
  assert.equal(JSON.stringify(store.snapshot()).includes('fixture-not-public'), false)
  await quota.stop(); await agents.stop(); await tokens.stop()
})

test('Agent network classifications are bounded and cancellation does not issue a retry', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/slow') { req.on('close', () => res.destroy()); return }
    const body = req.url === '/large' ? 'x'.repeat(65537) + 'invalid task_id' : '{"error":{"code":"task_expired"}}'
    res.writeHead(req.url === '/other' ? 403 : 401).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  for (const [path, code] of [['/', 'agent_task_invalid'], ['/large', undefined], ['/other', undefined]]) {
    await assert.rejects(requestJSON(`http://127.0.0.1:${address.port}${path}`), error => {
      assert.ok(error instanceof HTTPError); assert.equal(error.code, code); return true
    })
  }
  const signal = AbortSignal.timeout(25)
  await assert.rejects(requestJSON(`http://127.0.0.1:${address.port}/slow`, { signal }), /取消/)
  const store = vault(t), account = add(store)
  let calls = 0
  const agents = new AgentIdentityService(store, noDecrypt, async (_url, init) => {
    calls++; await delay(5000, undefined, { signal: init?.signal ?? undefined }); return {}
  })
  await assert.rejects(agents.query(account.id, 'https://example.invalid', AbortSignal.timeout(25)))
  assert.equal(calls, 1)
  await agents.stop()
})

test('Agent runtime task projection saves sidecar recovery and protects newer vault tasks and identity changes', t => {
  const store = vault(t), account = add(store), agent = account.credentials.agentIdentity!
  const path = join(store.directory, 'auth.json'), service = new AgentIdentityService(store, noDecrypt)
  const projection = new AgentTaskProjection(account.id, path, agent, (id, value, baseline) => service.adopt(id, value, baseline))
  const write = (identity: AgentIdentity) => writeFileSync(path, JSON.stringify({ auth_mode: 'agentIdentity', ...identity }))
  write({ ...agent, task_id: 'sidecar-one' })
  assert.equal(projection.sync()!.credentials.agentIdentity!.task_id, 'sidecar-one')
  write({ ...agent, task_id: 'sidecar-two' })
  projection.sync()
  service.adopt(account.id, { ...agent, task_id: 'desktop-new' }, 'sidecar-two')
  write({ ...agent, task_id: 'sidecar-late' })
  assert.equal(projection.sync()!.credentials.agentIdentity!.task_id, 'desktop-new')
  assert.equal(store.read().accounts[0].credentials.agentIdentity!.task_id, 'desktop-new')
  write({ ...agent, chatgpt_user_id: 'other-user' })
  assert.throws(() => projection.sync(), /身份/)
  write({ ...agent, task_id: 'do-not-resurrect' })
  store.transaction(state => { state.accounts = [] })
  assert.equal(projection.sync(), undefined)
  assert.equal(store.read().accounts.length, 0)
})

test('source-built Agent Identity gateway loads without access token and persists recovered task at stop', async t => {
  const store = vault(t), account = add(store), agent = account.credentials.agentIdentity!
  const service = new AgentIdentityService(store, noDecrypt)
  const root = join(store.directory, 'runtime')
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'), root, () => {}, (id, value, baseline) => service.adopt(id, value, baseline))
  try {
    const status = await gateway.start({ id: account.id, account, apiKey: 'fixture-local-key', port: 0 }, settingsSchema.parse({}))
    const directory = join(root, readdirSync(root)[0])
    const path = join(directory, 'auth', `${account.id}.json`)
    const auth = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(auth.access_token, undefined); assert.equal(auth.auth_mode, 'agentIdentity')
    assert.equal(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).accounts[0].authKind, 'agent_identity')
    const models = await fetch(`http://127.0.0.1:${status.port}/v1/models`, { headers: { Authorization: 'Bearer fixture-local-key' } })
    assert.equal(models.status, 200); await models.json()
    writeFileSync(path, JSON.stringify({ ...auth, task_id: 'sidecar-recovery' }))
    assert.equal(gateway.syncCredentials()?.credentials.agentIdentity?.task_id, 'sidecar-recovery')
    await gateway.updateCredentials(account)
    assert.equal(store.read().accounts[0].credentials.agentIdentity!.task_id, 'sidecar-recovery')
    writeFileSync(path, JSON.stringify({ ...auth, task_id: 'last-task-before-stop' }))
    await gateway.stop()
    assert.equal(store.read().accounts[0].credentials.agentIdentity!.task_id, 'last-task-before-stop')
    assert.deepEqual(readdirSync(root), [])
    await assert.rejects(taskDecryptor(resolve('resources/bin/codex-proxy'))(agent.agent_private_key, 'invalid-ciphertext'), /解密失败/)
  } finally { await gateway.stop(); await service.stop() }
})

test('failed vault commit retains running Agent task projection for an explicit retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-agent-retry-'))
  t.after(() => rmSync(directory, {recursive:true,force:true}))
  let fail = false
  const store = new Store(directory, { encrypt: value => { if (fail) throw new Error('fixture storage failure'); return Buffer.from(value) }, decrypt: value => value.toString() })
  const account = add(store), service = new AgentIdentityService(store, noDecrypt)
  const root = join(directory, 'runtime')
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'), root, () => {}, (id, value, baseline) => service.adopt(id, value, baseline))
  try {
    await gateway.start({id:account.id,account,apiKey:'fixture-local-key',port:0}, settingsSchema.parse({}))
    const path = join(root, readdirSync(root)[0], 'auth', `${account.id}.json`)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path,'utf8')), task_id:'must-survive' }))
    fail = true
    await assert.rejects(gateway.stop(), /运行凭据已保留/)
    assert.equal(gateway.current().running, true)
    assert.match(gateway.current().error!, /重试/)
    assert.equal(JSON.parse(readFileSync(path,'utf8')).task_id, 'must-survive')
    fail = false
    await gateway.stop()
    assert.equal(store.read().accounts[0].credentials.agentIdentity!.task_id,'must-survive')
    assert.deepEqual(readdirSync(root), [])
  } finally { fail=false; await gateway.stop(); await service.stop() }
})
