import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClientConfigs} from '../src/main/clientConfig'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'
import {Store} from '../src/main/store'
import {instanceInputSchema} from '../src/shared/instances'
import {patchToml,TomlDocument} from '../src/main/tomlPatch'

function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-config-speed-menu-')))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const store=new Store(join(root,'vault'),{encrypt:(value:string)=>Buffer.from(value),decrypt:(value:Buffer)=>value.toString()})
  const account=createAPIAccount({name:'Fixture',apiKey:'fixture-upstream-secret',baseUrl:'https://fixture.invalid/v1',wireApi:'responses',models:['gpt-5.5'],defaultTier:'fast',note:'',tags:[]})
  importParsedAccounts(store,[account]);const id=randomUUID()
  store.transaction(state=>{state.instances=[{...instanceInputSchema.parse({name:'Fixture instance',applicationId:'fixture-app',accountId:account.id,model:'gpt-5.5'}),id,revision:0,createdAt:Date.now()}]})
  const configs=new ClientConfigs(store),target=configs.prepareIdentityTarget(id),file=join(target.directory,'config.toml'),auth=join(target.directory,'auth.json')
  return {store,id,configs,file,auth}
}

test('native menu speed edits survive stop while temporary provider, key and address are restored independently',t=>{
  for(const raw of ['"default"','"priority"',null]){
    const f=fixture(t),source='# original config\nmodel="before"\nmodel_provider="original"\nservice_tier="fast"\n[model_providers.original]\nname="Original"\nbase_url="https://original.invalid/v1"\n'
    writeFileSync(f.file,source);writeFileSync(f.auth,'fixture-auth-preserve')
    const preview=f.configs.previewInstanceConnection(f.id,f.configs.view(f.id).revision,{port:12345,key:'fixture-temporary-instance-key',model:'gpt-5.5',tier:'priority',manageServiceTier:false})
    assert.equal(preview.changes.some(change=>change.key==='service_tier'),false)
    let backup='';f.configs.apply(preview.ticket,id=>{backup=id})
    writeFileSync(f.file,patchToml(readFileSync(f.file,'utf8'),[{path:['service_tier'],raw}]))
    const restore=f.configs.previewRestore({id:f.id,backup},true)
    assert.deepEqual(restore.conflicts,[]);assert.equal(restore.changes.some(change=>change.key==='service_tier'),false)
    f.configs.apply(restore.ticket)
    const content=readFileSync(f.file,'utf8'),doc=new TomlDocument(content)
    assert.equal(doc.raw(['service_tier']),raw);assert.equal(doc.scalar(['model_provider']),'original');assert.equal(doc.scalar(['model']),'before')
    assert.equal(doc.raw(['model_providers','cml_instance','experimental_bearer_token']),null)
    assert.equal(doc.raw(['model_providers','cml_instance','base_url']),null)
    assert.equal(content.includes('fixture-temporary-instance-key'),false);assert.equal(content.includes('127.0.0.1:12345'),false)
    assert.equal(doc.scalar(['model_providers','original','base_url']),'https://original.invalid/v1')
    assert.equal(readFileSync(f.auth,'utf8'),'fixture-auth-preserve');assert.ok(content.includes('# original config'))
    const next=f.configs.previewInstanceConnection(f.id,f.configs.view(f.id).revision,{port:12346,key:'fixture-next-key',model:'gpt-5.5',tier:'priority',manageServiceTier:false})
    f.configs.apply(next.ticket);assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).raw(['service_tier']),raw)
  }
})

test('ordinary instance callers retain their existing tier projection and exact restoration',t=>{
  const f=fixture(t),source='# before\nservice_tier="default"\n'
  writeFileSync(f.file,source)
  const preview=f.configs.previewInstanceConnection(f.id,f.configs.view(f.id).revision,{port:12345,key:'fixture-standard-path',model:'gpt-5.5',tier:'priority'})
  assert.ok(preview.changes.some(change=>change.key==='service_tier'))
  let backup='';f.configs.apply(preview.ticket,id=>{backup=id})
  assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).scalar(['service_tier']),'fast')
  const restore=f.configs.previewRestore({id:f.id,backup},true);assert.deepEqual(restore.conflicts,[])
  f.configs.apply(restore.ticket);assert.equal(readFileSync(f.file,'utf8'),source)
})

test('native-menu mode does not weaken provider guards when the actual provider or key changes',t=>{
  const f=fixture(t);writeFileSync(f.file,'service_tier="fast"\n')
  const preview=f.configs.previewInstanceConnection(f.id,f.configs.view(f.id).revision,{port:12345,key:'fixture-original-temporary',model:'gpt-5.5',tier:'priority',manageServiceTier:false})
  let backup='';f.configs.apply(preview.ticket,id=>{backup=id})
  writeFileSync(f.file,patchToml(readFileSync(f.file,'utf8'),[{path:['model_providers','cml_instance','base_url'],raw:'"http://127.0.0.1:54321/v1"'}]))
  const restore=f.configs.previewRestore({id:f.id,backup},true)
  assert.ok(restore.conflicts.some(key=>key.startsWith('model_providers.')))
  f.configs.apply(restore.ticket)
  assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).scalar(['model_providers','cml_instance','base_url']),'http://127.0.0.1:54321/v1')
})
