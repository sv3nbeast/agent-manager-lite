import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, symlinkSync, renameSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { ClientConfigs } from '../src/main/clientConfig'
import { TomlDocument, patchToml } from '../src/main/tomlPatch'

function fixture(t: {after(fn: () => void):void}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-config-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const codec = { encrypt: (value:string) => Buffer.from(value), decrypt: (value:Buffer) => value.toString() }
  const store = new Store(join(root, 'app'), codec)
  let now = Date.now()
  const service = new ClientConfigs(store, () => now)
  const external = join(root, 'external'); mkdirSync(external)
  return { root, external, store, codec, service, advance: () => {now += 300001} }
}

test('TOML edits preserve comments, unknown values, multiline secrets, quoted keys and CRLF', () => {
  const source = '# 前置注释\r\nmodel = "old" # model note\r\nsecret = """line1\r\nprivate-token\r\n"""\r\narr = [1, 2, 3]\r\n[model_providers."a.b"] # provider\r\nname = "custom"\r\nbase_url = "https://example.invalid/v1"\r\n'
  const next = patchToml(source, [ {path:['model'], raw:'"new"'}, {path:['service_tier'],raw:'"fast"'}, {path:['model_providers','a.b','supports_websockets'],raw:'true'} ])
  assert.ok(next.includes(source.slice(source.indexOf('secret ='),source.indexOf('[model_providers'))))
  assert.match(next, /model = "new" # model note\r\n/)
  assert.match(next, /\[model_providers\."a.b"\] # provider\r\nsupports_websockets = true\r\n/)
  assert.deepEqual(new TomlDocument(next).children(['model_providers']), ['a.b'])
  assert.equal(new TomlDocument(next).scalar(['service_tier']), 'fast')
  assert.throws(() => new TomlDocument('api_key = "secret-do-not-echo'), error => !String(error).includes('secret-do-not-echo') && String(error).includes('第 1 行'))
})

test('TOML path edits support nested inline tables, dotted keys, deletion and injection rejection', () => {
  let source = 'model_providers = { "a.b" = { name = "mine", secret = "keep" }, other = { name = "other" } }\n'
  source = patchToml(source, [ {path:['model_providers','a.b','name'],raw:'"renamed"'}, {path:['model_providers','a.b','supports_websockets'],raw:'true'} ])
  assert.equal(new TomlDocument(source).scalar(['model_providers','a.b','supports_websockets']), true)
  assert.match(source, /secret = "keep"/)
  source = patchToml(source, [{path:['model_providers','a.b','name'],raw:null}, {path:['model_providers','a.b','supports_websockets'],raw:null}])
  assert.equal(new TomlDocument(source).scalar(['model_providers','a.b','secret']), 'keep')
  source = patchToml(source, [{path:['model_providers','a.b','secret'],raw:null}])
  assert.equal(new TomlDocument(source).raw(['model_providers','a.b','secret']), null)
  const dotted = patchToml('model_providers.p.name = "mine"\n', [{path:['model_providers','p','name'],raw:'"changed"'}, {path:['model_providers','p','base_url'],raw:'"https://example.invalid"'}])
  assert.equal(new TomlDocument(dotted).scalar(['model_providers','p','name']), 'changed')
  assert.throws(() => patchToml('', [{path:['model'],raw:'"good"\nsecret = "bad"'}]))
  assert.throws(() => patchToml('model_providers = "wrong-type"\n', [{path:['model_providers','p','name'],raw:'"no"'}]))
})

test('a terminal zero keeps its complete source range when read, edited or removed', () => {
  const path = ['model_providers', 'fixture', 'request_max_retries']
  const source = '# retain bytes\r\n[model_providers.fixture]\r\nrequest_max_retries = 0'
  const doc = new TomlDocument(source)
  assert.equal(doc.raw(path), '0')
  assert.equal(doc.scalar(path), 0)
  assert.equal(patchToml(source, [{path, raw: '0'}]), source)
  assert.equal(patchToml(source, [{path, raw: '2'}]), source.slice(0, -1) + '2')
  assert.equal(patchToml(source, [{path, raw: null}]), '# retain bytes\r\n[model_providers.fixture]\r\n')
  for (const raw of ['0', '-0', '+0', '0.0', '0x0', '[0]', '{ zero = 0 }']) {
    assert.equal(new TomlDocument('value = ' + raw).raw(['value']), raw)
    assert.equal(new TomlDocument(patchToml('', [{path: ['value'], raw}])).raw(['value']), raw)
  }
  assert.throws(() => patchToml('', [{path: ['value'], raw: '0\nsecret = "injected"'}]))
})

test('managed configuration is opt-in, Fast persists and snapshots do not disclose unknown secrets', t => {
  const f = fixture(t), target = f.service.targets()[0]
  const view = f.service.view(target.id)
  assert.equal(view.exists, false); assert.equal(existsSync(target.directory), false)
  const preview = f.service.preview({id:target.id,revision:view.revision,changes:{model:'fixture-model',service_tier:'fast',model_context_window:100000}})
  assert.equal(preview.changes.length, 4)
  assert.equal(existsSync(target.directory), false)
  const after = f.service.apply(preview.ticket)
  assert.equal(after.values.service_tier, 'fast')
  assert.equal(after.values.model_auto_compact_token_limit, 90000)
  assert.equal(statSync(join(target.directory,'config.toml')).mode & 0o777, 0o600)
  const reopened = new ClientConfigs(new Store(f.store.directory, f.codec))
  assert.equal(reopened.view(target.id).values.service_tier, 'fast')
  assert.equal(reopened.view(target.id).revisions.length, 1)
  assert.throws(() => f.service.apply(preview.ticket), /预览已过期/)
  const externalFile = join(f.external,'config.toml')
  writeFileSync(externalFile, 'service_tier="default"\n[model_providers.fixture]\nname="fixture"\nexperimental_bearer_token="do-not-leak"\n')
  const selected = f.service.register(f.external)
  assert.equal(readFileSync(externalFile,'utf8').includes('do-not-leak'),true)
  assert.equal(JSON.stringify(f.service.view(selected.id)).includes('do-not-leak'),false)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('do-not-leak'),false)
})

test('preview and apply reject stale files, expired tickets, invalid provider/context and path input', t => {
  const f=fixture(t), target=f.service.register(f.external), file=join(f.external,'config.toml')
  const view=f.service.view(target.id)
  const preview=f.service.preview({id:target.id,revision:view.revision,changes:{service_tier:'fast'}})
  writeFileSync(file,'# external edit\n')
  assert.throws(()=>f.service.apply(preview.ticket),/已被其他程序修改/)
  assert.equal(readFileSync(file,'utf8'),'# external edit\n')
  assert.throws(()=>f.service.preview({id:target.id,revision:view.revision,changes:{model:'model'}}),/已被其他程序修改/)
  const current=f.service.view(target.id)
  for(const changes of [{model_provider:'undefined-provider'},{model_context_window:100,model_auto_compact_token_limit:100},{model_auto_compact_token_limit:85},{arbitrary:'field'}]) {
    assert.throws(()=>f.service.preview({id:target.id,revision:current.revision,changes}))
  }
  const expiring=f.service.preview({id:target.id,revision:current.revision,changes:{service_tier:'fast'}})
  f.advance(); assert.throws(()=>f.service.apply(expiring.ticket),/已过期/)
  assert.throws(()=>f.service.view('../escape'))
  assert.throws(()=>f.service.previewRestore({id:target.id,backup:'../../escape'}))
})

test('restart restoration changes only owned fields; user edits and unknown settings survive', t => {
  const f=fixture(t), file=join(f.external,'config.toml')
  const original='model = \'old-model\' # comment\nservice_tier = "default"\nsecret = "fake-backup-secret"\n'
  writeFileSync(file,original)
  const target=f.service.register(f.external), view=f.service.view(target.id)
  const applied=f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{model:'new-model',service_tier:'fast'}}).ticket)
  const backup=applied.revisions[0].id
  const backupFile=join(f.store.directory,'config-backups',target.id,backup,'original.toml')
  assert.equal(readFileSync(backupFile,'utf8'),original)
  assert.equal(statSync(backupFile).mode & 0o777,0o600)
  writeFileSync(file,readFileSync(file,'utf8').replace('"new-model"','"user-model"')+'user_setting = "keep"\n')
  const restarted=new ClientConfigs(new Store(f.store.directory,f.codec))
  const preview=restarted.previewRestore({id:target.id,backup})
  assert.deepEqual(preview.conflicts,['model'])
  assert.deepEqual(preview.changes.map(x=>x.key),['service_tier'])
  restarted.apply(preview.ticket)
  const final=readFileSync(file,'utf8')
  assert.match(final,/model = "user-model" # comment/)
  assert.match(final,/service_tier = "default"/)
  assert.match(final,/user_setting = "keep"/)
  assert.match(final,/secret = "fake-backup-secret"/)
})

test('context resets and restores remain paired, and original TOML literal style is recoverable', t => {
  const f=fixture(t), target=f.service.register(f.external), file=join(f.external,'config.toml')
  writeFileSync(file,"model='old'\nmodel_context_window=100_000\nmodel_auto_compact_token_limit=85_000\n")
  let view=f.service.view(target.id)
  view=f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{model:'new',model_context_window:null}}).ticket)
  assert.equal(view.values.model_context_window,null);assert.equal(view.values.model_auto_compact_token_limit,null)
  const restore=f.service.previewRestore({id:target.id,backup:view.revisions[0].id})
  f.service.apply(restore.ticket)
  assert.match(readFileSync(file,'utf8'),/model='old'/)
  assert.equal(f.service.view(target.id).values.model_context_window,100000)
  view=f.service.view(target.id)
  view=f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{model_context_window:200000,model_auto_compact_token_limit:170000}}).ticket)
  writeFileSync(file,readFileSync(file,'utf8').replace('170000','185000'))
  const conflicted=f.service.previewRestore({id:target.id,backup:view.revisions[0].id})
  assert.equal(conflicted.changes.length,0)
  assert.deepEqual(new Set(conflicted.conflicts),new Set(['model_context_window','model_auto_compact_token_limit']))
})

test('unchanged projections restore exact original bytes; changed files retain user edits and altered original backups are refused', t=>{
  const f=fixture(t),file=join(f.external,'config.toml'),original='# exact original\r\nmodel = \'old\' # comment\r\ncustom = true\r\n'
  writeFileSync(file,original);const target=f.service.register(f.external)
  const project=()=>{const view=f.service.view(target.id);return f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{model:'new',service_tier:'fast'}}).ticket).revisions[0].id}
  for(let i=0;i<3;i++){
    const backup=project();f.service.apply(f.service.previewRestore({id:target.id,backup}).ticket)
    assert.equal(readFileSync(file,'utf8'),original)
  }
  const changed=project();writeFileSync(file,readFileSync(file,'utf8')+'# user note\r\nfuture = 42\r\n')
  f.service.apply(f.service.previewRestore({id:target.id,backup:changed}).ticket)
  assert.match(readFileSync(file,'utf8'),/# user note\r\nfuture = 42\r\n$/)
  assert.equal(new TomlDocument(readFileSync(file,'utf8')).scalar(['model']),'old')
  const tampered=project(),projected=readFileSync(file,'utf8')
  writeFileSync(join(f.store.directory,'config-backups',target.id,tampered,'original.toml'),'model="untrusted"\n')
  assert.throws(()=>f.service.previewRestore({id:target.id,backup:tampered}),/原文备份已改变/)
  assert.equal(readFileSync(file,'utf8'),projected)
})

test('configuration rejects symlinks, replaced directories, malformed TOML and oversized files', t => {
  for(const mode of ['symlink','directory','malformed','oversize']) {
    const f=fixture(t),target=f.service.register(f.external),file=join(f.external,'config.toml'),view=f.service.view(target.id)
    const preview=f.service.preview({id:target.id,revision:view.revision,changes:{service_tier:'fast'}})
    const outside=join(f.root,'outside');writeFileSync(outside,'do-not-touch')
    if(mode==='symlink')symlinkSync(outside,file)
    if(mode==='directory'){renameSync(f.external,f.external+'-old');mkdirSync(f.external)}
    if(mode==='malformed')writeFileSync(file,'secret = "dont-print-me')
    if(mode==='oversize')writeFileSync(file,'#'+'a'.repeat(1024*1024))
    assert.throws(()=>f.service.apply(preview.ticket))
    assert.throws(()=>f.service.view(target.id),error=>!String(error).includes('dont-print-me'))
    assert.equal(readFileSync(outside,'utf8'),'do-not-touch')
    if(mode==='directory') {
      const selectedAgain=f.service.register(f.external)
      assert.notEqual(selectedAgain.id,target.id)
      assert.equal(f.service.view(selectedAgain.id).exists,false)
      assert.equal(f.service.targets().length,2)
    }
  }
})

test('restoring a window preserves a later threshold even when the threshold was not in the original diff', t => {
  const f=fixture(t),file=join(f.external,'config.toml')
  writeFileSync(file,'model_context_window=100000\nmodel_auto_compact_token_limit=85000\n')
  const target=f.service.register(f.external),view=f.service.view(target.id)
  const applied=f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{model_context_window:200000,model_auto_compact_token_limit:85000}}).ticket)
  writeFileSync(file,readFileSync(file,'utf8').replace('85000','180000'))
  const restore=f.service.previewRestore({id:target.id,backup:applied.revisions[0].id})
  assert.equal(restore.changes.length,0)
  assert.deepEqual(restore.conflicts,['model_context_window'])
  f.service.apply(restore.ticket)
  assert.equal(f.service.view(target.id).values.model_context_window,200000)
  assert.equal(f.service.view(target.id).values.model_auto_compact_token_limit,180000)
})

test('a prepared backup is recoverable only for the exact projected file after an interrupted commit', t => {
  const f=fixture(t),target=f.service.register(f.external),file=join(f.external,'config.toml'),view=f.service.view(target.id)
  const after=f.service.apply(f.service.preview({id:target.id,revision:view.revision,changes:{service_tier:'fast'}}).ticket)
  const backup=after.revisions[0].id, journalFile=join(f.store.directory,'config-backups',target.id,backup,'change.json')
  const journal=JSON.parse(readFileSync(journalFile,'utf8'));journal.status='prepared';writeFileSync(journalFile,JSON.stringify(journal))
  assert.equal(new ClientConfigs(new Store(f.store.directory,f.codec)).view(target.id).revisions.length,1)
  const restore=f.service.previewRestore({id:target.id,backup})
  assert.equal(restore.changes[0].after,'未设置')
  // An external editor writing identical content does not establish ownership
  // of an uncommitted backup. Its inode differs from the prepared projection.
  writeFileSync(file+'.external',readFileSync(file));renameSync(file+'.external',file)
  assert.equal(f.service.view(target.id).revisions.length,0)
  assert.throws(()=>f.service.previewRestore({id:target.id,backup}),/未确认写入/)
  assert.match(readFileSync(file,'utf8'),/fast/)
})
