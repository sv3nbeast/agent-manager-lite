import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { parseAccountImport } from '../src/main/accounts'
import { SshServers, buildSshArgs } from '../src/main/ssh'
import { authFor } from '../src/main/nativeAccountProjection'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'cml-ssh-'))
  const key = randomBytes(32)
  const codec = {
    encrypt(value: string) { return Buffer.from(value).toString('base64') as unknown as Buffer },
    decrypt(value: Buffer) { return Buffer.from(value.toString(), 'base64').toString() }
  }
  const store = new Store(root, codec)
  const account = parseAccountImport(JSON.stringify({ access_token: 'fixture-access-token', email: 'ssh@example.invalid' })).accounts[0]
  store.transaction(state => state.accounts.push(account))
  t.after(() => { key.fill(0); rmSync(root, { recursive: true, force: true }) })
  return { root, store, account }
}

test('SSH servers are validated, encrypted in the normal vault, and selected state survives reopen', t => {
  const f = fixture(t), service = new SshServers(f.store, () => 100)
  const view = service.save({ name: '测试服务器', host: 'remote.example', port: 2222, username: 'codex', codexHome: '~/.codex', auth: { kind: 'agent' }, syncOnCodexSwitch: false })
  assert.equal(view.servers.length, 1)
  const id = view.servers[0].id
  service.select(id)
  assert.equal(service.view().selectedId, id)
  const raw = readFileSync(join(f.root, 'state.vault'))
  assert.equal(raw.includes('remote.example'), false, '服务器配置保存在 vault 中，不以明文写入')
  assert.equal(raw.includes('fixture-access-token'), false)
  const reopened = new Store(f.root, { encrypt: value => Buffer.from(value).toString('base64') as unknown as Buffer, decrypt: value => Buffer.from(value.toString(), 'base64').toString() })
  assert.equal(reopened.read().sshServers?.selectedId, id)
  assert.equal(reopened.read().sshServers?.servers[0].codexHome, '~/.codex')
  assert.throws(() => service.save({ name: 'bad', host: 'remote;rm', port: 22, username: 'root', codexHome: '/tmp/codex', auth: { kind: 'agent' }, syncOnCodexSwitch: false }), /主机名/)
  assert.throws(() => service.save({ name: 'bad', host: 'remote.example', port: 22, username: 'root', codexHome: '/tmp/a b', auth: { kind: 'agent' }, syncOnCodexSwitch: false }), /远端 Codex/)
})

test('SSH connection and sync use bounded parameterized commands and verify remote hash', async t => {
  const f = fixture(t), calls: { file: string; args: string[]; input?: string }[] = []
  const service = new SshServers(f.store, () => 100, async (file, args, input) => {
    calls.push({ file, args, input })
    if (args.includes('printf')) return { stdout: 'cml-ssh-ok\n', stderr: '' }
    const auth = authFor(f.store.read().accounts[0], null)
    const hash = createHash('sha256').update(auth).digest('hex')
    return { stdout: `cml-sync-ok\t${hash}\n`, stderr: '' }
  })
  const server = service.save({ name: 'fixture', host: 'remote.example', port: 22, username: 'runner', codexHome: '~/.codex', auth: { kind: 'private_key_file', path: '~/.ssh/id_ed25519' }, syncOnCodexSwitch: false }).servers[0]
  assert.deepEqual(buildSshArgs(server, ['printf', 'cml-ssh-ok']), ['-p', '22', '-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'IdentitiesOnly=yes', '-i', '~/.ssh/id_ed25519', 'runner@remote.example', 'printf', 'cml-ssh-ok'])
  assert.equal((await service.test(server.id)).ok, true)
  const result = await service.sync({ serverId: server.id, accountId: f.account.id })
  assert.equal(result.verified, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].file, 'ssh')
  assert.ok(calls[1].args.includes('sh') && calls[1].args.includes('-s'))
  assert.equal(calls[1].args.includes('remote.example'), false, 'host is part of user@host argument')
  assert.ok(calls[1].input && !calls[1].input.includes('fixture-access-token'), 'raw access token never enters the sync script')
  assert.equal(f.store.read().sshServers?.servers[0].lastSync?.verified, true)
})

test('SSH sync records a bounded failure without exposing credentials', async t => {
  const f = fixture(t), service = new SshServers(f.store, Date.now, async () => { throw new Error('Permission denied (publickey)') })
  const server = service.save({ name: 'fixture', host: 'remote.example', port: 22, username: 'runner', codexHome: '~/.codex', auth: { kind: 'agent' }, syncOnCodexSwitch: false }).servers[0]
  await assert.rejects(service.sync({ serverId: server.id, accountId: f.account.id }), /认证失败/)
  const status = f.store.read().sshServers?.servers[0].lastSync
  assert.equal(status?.verified, false)
  assert.match(status?.error ?? '', /认证失败/)
  assert.equal(JSON.stringify(status).includes('fixture-access-token'), false)
})
