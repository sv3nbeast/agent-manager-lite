import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'
import {TomlDocument,patchToml} from '../src/main/tomlPatch'
import type {ProviderConfigInput} from '../src/shared/providerConfig'

function fixture(t:{after(fn:()=>void):void}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-provider-')))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const codec={encrypt:(value:string)=>Buffer.from(value),decrypt:(value:Buffer)=>value.toString()}
  const store=new Store(join(root,'vault'),codec),service=new ClientConfigs(store)
  const target=service.register(root),file=join(root,'config.toml')
  const input=(patch:Partial<ProviderConfigInput>={}):ProviderConfigInput=>({id:target.id,revision:service.providers(target.id).revision,providerId:'fixture.provider',create:true,
    changes:{name:'Fixture',base_url:'https://example.invalid/v1'},auth:{mode:'token',token:'fixture-private-provider-token'},makeDefault:true,serviceTier:'fast',...patch})
  return {root,codec,store,service,target,file,input}
}

test('provider preview masks secrets, projects Fast atomically and survives reopening',t=>{
  const f=fixture(t),preview=f.service.previewProvider(f.input())
  assert.equal(existsSync(f.file),false)
  assert.equal(JSON.stringify(preview).includes('fixture-private-provider-token'),false)
  const saved=f.service.apply(preview.ticket),doc=new TomlDocument(readFileSync(f.file,'utf8'))
  assert.equal(doc.scalar(['model_provider']),'fixture.provider')
  assert.equal(doc.scalar(['service_tier']),'fast')
  assert.equal(doc.scalar(['model_providers','fixture.provider','experimental_bearer_token']),'fixture-private-provider-token')
  assert.equal(doc.scalar(['model_providers','fixture.provider','wire_api']),'responses')
  assert.equal(statSync(f.file).mode&0o777,0o600)
  const reopened=new ClientConfigs(new Store(f.store.directory,f.codec)),view=reopened.providers(f.target.id)
  assert.equal(view.providers[0].bearerConfigured,true)
  assert.equal(JSON.stringify(view).includes('fixture-private-provider-token'),false)
  const restore=reopened.previewRestore({id:f.target.id,backup:saved.revisions[0].id})
  assert.equal(JSON.stringify(restore).includes('fixture-private-provider-token'),false)
  reopened.apply(restore.ticket)
  assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).children(['model_providers']).length,0)
})

test('zero retries can be saved, reopened, edited and restored without changing a terminal zero', t => {
  const f = fixture(t)
  const original = '# preserve no trailing newline\n[model_providers."fixture.provider"]\nname="Original"\nbase_url="https://example.invalid/v1"\nrequest_max_retries=0'
  writeFileSync(f.file, original)
  assert.equal(f.service.providers(f.target.id).providers[0].values.request_max_retries, 0)
  const input = f.input({create:false, changes:{request_max_retries:2,stream_max_retries:0,supports_websockets:false}, auth:{mode:'keep'}, makeDefault:false, serviceTier:undefined})
  const preview = f.service.previewProvider(input)
  assert.deepEqual(preview.changes.map(value => [value.key.split('.').at(-1), value.before, value.after]), [
    ['supports_websockets','未设置','false'], ['request_max_retries','0','2'], ['stream_max_retries','未设置','0']
  ])
  const applied = f.service.apply(preview.ticket)
  const reopened = new ClientConfigs(new Store(f.store.directory, f.codec))
  assert.equal(reopened.providers(f.target.id).providers[0].values.stream_max_retries, 0)
  reopened.apply(reopened.previewRestore({id:f.target.id,backup:applied.revisions[0].id}).ticket)
  assert.equal(readFileSync(f.file,'utf8'), original)
})

test('provider edits retain comments, custom transport fields, inline tables and unedited credentials',t=>{
  for(const inline of [false,true]){
    const f=fixture(t)
    const content=inline?'model_providers = { "fixture.provider" = { name="Original", base_url="https://example.invalid/v1", experimental_bearer_token="private-existing", unknown=[1,2], http_headers={ "X-Custom"="hidden-header" } }, other={name="Other"} }\n'
      :'# keep comment\n[model_providers."fixture.provider"] # endpoint note\nname="Original" # name note\nbase_url="https://example.invalid/v1"\nexperimental_bearer_token="private-existing"\nunknown=[1,2]\n[model_providers."fixture.provider".http_headers]\n"X-Custom"="hidden-header"\n[model_providers.other]\nname="Other"\n'
    writeFileSync(f.file,content)
    const before=f.service.providers(f.target.id)
    assert.equal(JSON.stringify(before).includes('hidden-header'),false)
    f.service.apply(f.service.previewProvider(f.input({create:false,changes:{name:'Changed',supports_websockets:true},auth:{mode:'keep'},makeDefault:false,serviceTier:undefined})).ticket)
    const next=readFileSync(f.file,'utf8'),doc=new TomlDocument(next)
    assert.equal(doc.scalar(['model_providers','fixture.provider','experimental_bearer_token']),'private-existing')
    assert.equal(doc.raw(['model_providers','fixture.provider','unknown']),'[1,2]')
    assert.equal(doc.scalar(['model_providers','fixture.provider','http_headers','X-Custom']),'hidden-header')
    assert.equal(doc.scalar(['model_providers','other','name']),'Other')
    if(!inline){assert.ok(next.includes('# endpoint note'));assert.ok(next.includes('# name note'))}
  }
})

test('explicit authentication changes clear competing fields while keep never rewrites them',t=>{
  const f=fixture(t)
  f.service.apply(f.service.previewProvider(f.input()).ticket)
  f.service.apply(f.service.previewProvider(f.input({create:false,changes:{},auth:{mode:'environment',envKey:'FIXTURE_API_KEY',instructions:'fixture-secret-guidance'},makeDefault:false,serviceTier:undefined})).ticket)
  let doc=new TomlDocument(readFileSync(f.file,'utf8'))
  assert.equal(doc.scalar(['model_providers','fixture.provider','env_key']),'FIXTURE_API_KEY')
  assert.equal(doc.raw(['model_providers','fixture.provider','experimental_bearer_token']),null)
  const preview=f.service.previewProvider(f.input({create:false,changes:{},auth:{mode:'openai'},makeDefault:false,serviceTier:undefined}))
  assert.equal(JSON.stringify(preview).includes('fixture-secret-guidance'),false)
  f.service.apply(preview.ticket)
  doc=new TomlDocument(readFileSync(f.file,'utf8'))
  assert.equal(doc.scalar(['model_providers','fixture.provider','requires_openai_auth']),true)
  assert.equal(doc.raw(['model_providers','fixture.provider','env_key']),null)
})

test('account credential projection binds endpoint and protocol, and rejects rotation or deletion after preview',t=>{
  const f=fixture(t),account=createAPIAccount({name:'Fixture account',apiKey:'fixture-account-secret',baseUrl:'https://example.invalid/v1',models:['gpt-5.5'],wireApi:'responses',defaultTier:'inherit',note:'',tags:[]})
  importParsedAccounts(f.store,[account])
  const input=f.input({auth:{mode:'account',accountId:account.id}})
  assert.throws(()=>f.service.previewProvider({...input,changes:{...input.changes,base_url:'https://other.invalid/v1'}}),/目标地址/)
  const preview=f.service.previewProvider(input)
  assert.equal(JSON.stringify(preview).includes('fixture-account-secret'),false)
  f.store.transaction(state=>{state.accounts[0].credentials.apiKey='rotated-fixture-secret'})
  assert.throws(()=>f.service.apply(preview.ticket),/凭据已改变/)
  assert.equal(existsSync(f.file),false)
  const next=f.service.previewProvider(input)
  f.service.apply(next.ticket)
  assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).scalar(['model_providers','fixture.provider','experimental_bearer_token']),'rotated-fixture-secret')
  const pending=f.service.previewProvider(f.input({create:false,changes:{name:'Renamed'},auth:{mode:'account',accountId:account.id}}))
  f.store.transaction(state=>{state.accounts=[]})
  assert.throws(()=>f.service.apply(pending.ticket),/凭据已改变/)
  importParsedAccounts(f.store,[{...account,wireApi:'chat_completions'}])
  assert.throws(()=>f.service.previewProvider(f.input({create:false,auth:{mode:'account',accountId:account.id}})),/Chat Completions/)
})

test('restoration keeps a whole provider connection when the user changes any dependent field',t=>{
  for(const changed of ['token','unknown-header','unknown-array','selection']){
    const f=fixture(t)
    writeFileSync(f.file,'model_provider="previous"\nservice_tier="default"\n[model_providers."fixture.provider"]\nname="Old"\nbase_url="https://old.invalid/v1"\nexperimental_bearer_token="old-private-key"\n')
    const saved=f.service.apply(f.service.previewProvider(f.input({create:false})).ticket)
    const edits=changed==='token'?[{path:['model_providers','fixture.provider','experimental_bearer_token'],raw:'"user-new-key"'}]
      :changed==='selection'?[{path:['model_provider'],raw:'"user-selected"'}]:[{path:['model_providers','fixture.provider','http_headers','X-Auth'],raw:'"user-header"'}]
    const modified=changed==='unknown-array'?readFileSync(f.file,'utf8')+'\n[[model_providers."fixture.provider".future]]\nkey="user-array-value"\n':patchToml(readFileSync(f.file,'utf8'),edits);writeFileSync(f.file,modified)
    const preview=f.service.previewRestore({id:f.target.id,backup:saved.revisions[0].id})
    assert.equal(preview.changes.length,0)
    assert.ok(preview.conflicts.includes('model_provider'))
    f.service.apply(preview.ticket)
    assert.equal(readFileSync(f.file,'utf8'),modified)
  }
})

test('provider restoration retains unrelated edits and legacy v1 backups still restore',t=>{
  const f=fixture(t)
  writeFileSync(f.file,'# prior\nmodel="original"\n')
  const quick=f.service.apply(f.service.preview({id:f.target.id,revision:f.service.view(f.target.id).revision,changes:{model:'updated'}}).ticket)
  const journalPath=join(f.store.directory,'config-backups',f.target.id,quick.revisions[0].id,'change.json')
  const journal=JSON.parse(readFileSync(journalPath,'utf8'))
  journal.version=1;journal.edits=journal.edits.map(({path,...edit}:{path:string[]})=>({...edit,key:path[0]}));delete journal.providerGuards
  writeFileSync(journalPath,JSON.stringify(journal))
  const saved=f.service.apply(f.service.previewProvider(f.input()).ticket)
  writeFileSync(f.file,readFileSync(f.file,'utf8')+'unrelated_root="keep"\n')
  f.service.apply(f.service.previewRestore({id:f.target.id,backup:saved.revisions[0].id}).ticket)
  f.service.apply(f.service.previewRestore({id:f.target.id,backup:quick.revisions[0].id}).ticket)
  const doc=new TomlDocument(readFileSync(f.file,'utf8'))
  assert.equal(doc.scalar(['model']),'original');assert.equal(doc.scalar(['unrelated_root']),'keep')
  writeFileSync(journalPath,'{"secret":"fixture-private-broken-backup", broken}')
  assert.throws(()=>f.service.previewRestore({id:f.target.id,backup:quick.revisions[0].id}),error=>!String(error).includes('fixture-private-broken-backup')&&String(error).includes('备份格式'))
})

test('invalid, stale and ambiguous provider inputs never partially modify client files',t=>{
  const f=fixture(t)
  for(const patch of [{providerId:'openai'},{providerId:'bad\nID'},{changes:{name:'Bad',base_url:'https://secret@host.invalid/v1'}},{changes:{name:'Bad',base_url:'https://host.invalid/v1?key=secret'}},{changes:{name:'Bad',base_url:'https://host.invalid',request_max_retries:-1}},{makeDefault:false,serviceTier:'fast'}])assert.throws(()=>f.service.previewProvider(f.input(patch as Partial<ProviderConfigInput>)))
  assert.equal(existsSync(f.file),false)
  const preview=f.service.previewProvider(f.input());writeFileSync(f.file,'# user edit\n')
  assert.throws(()=>f.service.apply(preview.ticket),/已被其他程序修改/)
  for(const custom of ['auth={command="fixture-no-execution"}','http_headers={Authorization="private-original"}']){
    writeFileSync(f.file,`[model_providers."fixture.provider"]\nname="Fixture"\nbase_url="https://example.invalid/v1"\n${custom}\n`)
    const before=readFileSync(f.file,'utf8')
    assert.throws(()=>f.service.previewProvider(f.input({create:false})),/鉴权/)
    assert.equal(readFileSync(f.file,'utf8'),before)
  }
})
