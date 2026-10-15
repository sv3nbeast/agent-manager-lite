import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {mutateProvider,providerTierForAccount} from '../src/main/providerLibrary'
import {providerKeyModels} from '../src/shared/providerLibrary'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'
import {validateBackup} from '../src/main/dataBackupState'

const codec={encrypt:(v:string)=>Buffer.from(v),decrypt:(v:Buffer)=>v.toString()}
function fixture(t:{after(fn:()=>void):void}){
  const directory=mkdtempSync(join(tmpdir(),'aml-key-catalog-'))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const store=new Store(directory,codec)
  mutateProvider(store,{action:'create',details:{name:'Mixed vendor',baseUrl:'https://catalog.invalid/v1',models:[],defaultTier:'fast'}})
  const provider=()=>store.read().providers![0]
  const act=(action:string,details:Record<string,unknown>,inUse:(id:string)=>boolean=()=>false)=>mutateProvider(store,{action,id:provider().id,revision:provider().revision,...details},inUse)
  return {store,directory,provider,act}
}
test('keys at the same supplier retain independent mixed model catalogues and protocols through edit, restart and backup',t=>{
  const f=fixture(t)
  f.act('addKey',{name:'OpenAI compatible',apiKey:'fixture-open',models:['custom-gpt','vendor-reasoner'],protocol:'openai_responses',createConnection:true})
  f.act('addKey',{name:'Claude compatible',apiKey:'fixture-claude',models:['claude-custom','custom-message-model'],protocol:'anthropic_messages',credentialKind:'anthropic_bearer',createConnection:true})
  const before=f.store.read(),open=before.accounts[0],claude=before.accounts[1],key=f.provider().keys[1]
  assert.equal(claude.identityService,'anthropic');assert.equal(claude.protocol,'anthropic_messages');assert.equal(claude.credentialKind,'anthropic_bearer')
  f.act('editKey',{keyId:key.id,models:['claude-new','vendor-new']})
  assert.deepEqual(f.store.read().accounts[0],open)
  assert.deepEqual(f.store.read().accounts[1].models,['claude-new','vendor-new'])
  f.act('update',{changes:{name:'Renamed',models:['legacy-only'],wireApi:'chat_completions'}})
  assert.deepEqual(f.store.read().accounts[0],open,'supplier legacy defaults must not project into key connections')
  assert.deepEqual(f.provider().keys[1].models,['claude-new','vendor-new'])
  const reopened=new Store(f.directory,codec),state=reopened.read()
  for(const account of state.accounts)assert.equal(providerTierForAccount(state,account),'fast')
  const portable=validateBackup({schema:'codex-manager-lite.data-backup',version:1,exportedAt:Date.now(),state,localKeyUsage:{},sourceConnections:0,sourceDirectories:0})
  assert.deepEqual(portable.state,state)
  const mismatch=structuredClone(portable);mismatch.state.providers![0].keys[1].models=['incorrect']
  assert.throws(()=>validateBackup(mismatch),/关联不一致/)
  assert.equal(JSON.stringify(reopened.snapshot()).includes('fixture-claude'),false)
})
test('legacy absent key catalogues project without writing; first mutation freezes old values, while explicit empty stays empty',t=>{
  const f=fixture(t)
  f.store.transaction(s=>{const p=s.providers![0];p.models=['legacy-model'];p.keys=[{id:randomUUID(),name:'Old',apiKey:'fixture-old',createdAt:0,updatedAt:0}]})
  const disk=readFileSync(join(f.directory,'state.vault')),key=f.provider().keys[0]
  assert.deepEqual(f.store.snapshot().providers![0].keys[0].models,['legacy-model'])
  assert.deepEqual(readFileSync(join(f.directory,'state.vault')),disk)
  f.act('update',{changes:{models:['changed-legacy-default'],wireApi:'chat_completions'}})
  assert.deepEqual(f.provider().keys[0].models,['legacy-model'])
  assert.equal(f.provider().keys[0].protocol,'openai_responses')
  f.act('editKey',{keyId:key.id,models:[]})
  assert.deepEqual(providerKeyModels(f.provider(),f.provider().keys[0]),[])
  assert.throws(()=>f.act('createAccount',{keyId:key.id,name:'Empty'}),/配置模型/)
  f.act('addKey',{name:'New empty',apiKey:'fixture-new',models:[]})
  assert.deepEqual(f.provider().keys[1].models,[])
})
test('materializing a legacy duplicate catalogue preserves linked accounts until an explicit model edit',t=>{
  const f=fixture(t),keyId=randomUUID(),models=['legacy-model','legacy-model','CaseSensitive']
  const account={...createAPIAccount({name:'Legacy connection',baseUrl:f.provider().baseUrl,apiKey:'fixture-legacy-duplicate',models,wireApi:'responses'}),providerId:f.provider().id,providerKeyId:keyId}
  f.store.transaction(state=>{
    state.providers![0].models=[...models]
    state.providers![0].keys=[{id:keyId,name:'Old key',apiKey:'fixture-legacy-duplicate',createdAt:0,updatedAt:0}]
    state.accounts.push(account)
  })
  const bytes=readFileSync(join(f.directory,'state.vault'))
  assert.deepEqual(f.store.snapshot().providers![0].keys[0].models,models)
  assert.deepEqual(readFileSync(join(f.directory,'state.vault')),bytes)
  assert.equal(providerTierForAccount(f.store.read(),account),'fast')
  f.act('update',{changes:{name:'Renamed legacy provider'}},()=>true)
  f.act('editKey',{keyId,name:'Renamed key'},()=>true)
  assert.deepEqual(f.provider().keys[0].models,models)
  assert.deepEqual(f.store.read().accounts[0],account,'cosmetic edits must not rewrite a running linked account')
  assert.equal(providerTierForAccount(f.store.read(),f.store.read().accounts[0]),'fast')
  f.act('editKey',{keyId,apiKey:'fixture-rotated-duplicate'})
  assert.deepEqual(f.provider().keys[0].models,models)
  assert.deepEqual(f.store.read().accounts[0].models,models)
  assert.equal(providerTierForAccount(f.store.read(),f.store.read().accounts[0]),'fast')
  assert.doesNotThrow(()=>validateBackup({schema:'codex-manager-lite.data-backup',version:1,exportedAt:Date.now(),state:f.store.read(),localKeyUsage:{},sourceConnections:0,sourceDirectories:0}))
  f.act('editKey',{keyId,models:['new-model','new-model','CaseSensitive']})
  assert.deepEqual(f.provider().keys[0].models,['new-model','CaseSensitive'])
  assert.deepEqual(f.store.read().accounts[0].models,['new-model','CaseSensitive'])
  f.act('addKey',{name:'New key',apiKey:'fixture-new-duplicate',models:['new-model','new-model']})
  assert.deepEqual(f.provider().keys[1].models,['new-model'])
})
test('catalogue writes are key-scoped, revision-bound, and do not interrupt another key in use',t=>{
  const f=fixture(t)
  for(const name of ['A','B'])f.act('addKey',{name,apiKey:'fixture-'+name,models:[name],createConnection:true})
  const before=f.store.read(),key=f.provider().keys[0],account=before.accounts[0]
  assert.throws(()=>f.act('editKey',{keyId:key.id,models:['changed']},id=>id===account.id),/停止/)
  assert.deepEqual(f.store.read(),before)
  f.act('editKey',{keyId:key.id,models:['changed']},id=>id===before.accounts[1].id)
  assert.deepEqual(f.store.read().accounts[1],before.accounts[1])
  assert.throws(()=>mutateProvider(f.store,{action:'editKey',id:f.provider().id,revision:before.providers![0].revision,keyId:key.id,models:['stale']}),/已被修改/)
  const latest=f.store.read()
  assert.throws(()=>f.act('editKey',{keyId:key.id,protocol:'anthropic_messages',credentialKind:'openai_api_key'}),/不匹配/)
  assert.deepEqual(f.store.read(),latest)
})
test('reconciliation imports each standalone key models and Claude auth scope without creating managed links',t=>{
  const f=fixture(t)
  const open=createAPIAccount({name:'Open',baseUrl:f.provider().baseUrl,apiKey:'fixture-open',models:['gemini-custom'],wireApi:'chat_completions'})
  const claude=createAPIAccount({name:'Claude',baseUrl:f.provider().baseUrl,apiKey:'fixture-claude',models:['claude-custom'],wireApi:'chat_completions',identityService:'anthropic',protocol:'anthropic_messages',credentialKind:'anthropic_api_key'})
  importParsedAccounts(f.store,[open,claude])
  const summary=f.store.snapshot().providers![0]
  assert.deepEqual(summary.keys.map(k=>k.models),[['gemini-custom'],['claude-custom']])
  assert.deepEqual(summary.keys.map(k=>k.accountIds),[[],[]])
  assert.deepEqual(summary.keys.map(k=>k.reusableAccountIds),[[open.id],[claude.id]])
})
test('moving a duplicate key with different catalogue refuses without losing either configuration',t=>{
  const f=fixture(t)
  f.act('addKey',{name:'Key',apiKey:'fixture-duplicate',models:['left']})
  mutateProvider(f.store,{action:'create',details:{name:'Other',baseUrl:'https://other.invalid/v1',models:[]},initialKey:{name:'Key',apiKey:'fixture-duplicate',models:['right'],createConnection:false}})
  const before=f.store.read(),target=before.providers![1]
  assert.throws(()=>f.act('moveKey',{keyId:f.provider().keys[0].id,targetId:target.id,targetRevision:target.revision}),/模型或协议不同/)
  assert.deepEqual(f.store.read(),before)
})
