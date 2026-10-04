import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { AccountFiles } from '../src/main/accountFiles'
import { importParsedAccounts, parseAccountImport } from '../src/main/accounts'

const api=(key:string,extra:Record<string,unknown>={})=>({name:'Same display name',email:'same@example.invalid',apiKey:key,baseUrl:'https://supplier.invalid/v1',models:['fixture-model'],...extra})
function oauth(user:string,token:string,extra:Record<string,unknown>={}) {
  const payload={email:'same@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'shared-org',chatgpt_user_id:user}}
  return {name:'Same display name',access_token:`fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${token}`,refresh_token:`fixture-refresh-${token}`,...extra}
}
function fixture(t:{after(fn:()=>void|Promise<void>):void}) {
  const root=mkdtempSync(join(tmpdir(),'aml-import-ids-')),store=new Store(root,{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),files=new AccountFiles(store)
  t.after(async()=>{await files.stop();rmSync(root,{recursive:true,force:true})})
  const commit=(source:unknown)=>files.commit(files.stage(JSON.stringify(source)).ticket)
  return {store,files,commit}
}

test('new imports and exact duplicates return the committed ID while preserving the stored account',t=>{
  const f=fixture(t),first=f.commit(api('fixture-key-one'))
  const saved=f.store.read().accounts[0]
  assert.deepEqual(first,{added:1,duplicates:0,skipped:0,accountIds:[saved.id]})
  const repeated=f.commit(api('fixture-key-one',{name:'Renamed import',note:'Must not replace stored metadata'}))
  assert.deepEqual(repeated,{added:0,duplicates:1,skipped:0,accountIds:[saved.id]})
  assert.deepEqual(f.store.read().accounts[0],saved)
  assert.deepEqual(Object.keys(repeated).sort(),['accountIds','added','duplicates','skipped'])
  assert.equal(JSON.stringify(repeated).includes('fixture-key-one'),false)
})

test('duplicate matches use real credential and endpoint identity rather than display names',t=>{
  const f=fixture(t),first=f.commit(api('fixture-key-one')),second=f.commit(api('fixture-key-two'))
  assert.notEqual(first.accountIds[0],second.accountIds[0])
  const normalized=f.commit(api('fixture-key-one',{baseUrl:'https://SUPPLIER.invalid:443/v1/'}))
  assert.deepEqual(normalized.accountIds,first.accountIds);assert.equal(normalized.duplicates,1)
  const endpoint=f.commit(api('fixture-key-one',{baseUrl:'https://supplier.invalid/Other/v1'}))
  assert.equal(endpoint.added,1);assert.notEqual(endpoint.accountIds[0],first.accountIds[0])
  assert.equal(f.store.read().accounts.length,3)
})

test('mixed multi-account imports return only the matched and newly committed IDs in first-seen order',t=>{
  const f=fixture(t),existing=f.commit(api('fixture-existing')),unrelated=f.commit(api('fixture-unrelated'))
  const result=f.commit([api('fixture-existing'),api('fixture-new'),api('fixture-existing'),api('fixture-new')])
  const added=f.store.read().accounts.find(account=>account.credentials.apiKey==='fixture-new')!
  assert.deepEqual(result,{added:1,duplicates:3,skipped:0,accountIds:[existing.accountIds[0],added.id]})
  assert.equal(result.accountIds.includes(unrelated.accountIds[0]),false)
  assert.equal(f.store.read().accounts.length,3)
})

test('OAuth repeats resolve the original ID without overwriting credentials and strong identity conflicts remain separate',t=>{
  const f=fixture(t),first=f.commit(oauth('user-one','old')),saved=f.store.read().accounts[0]
  const repeated=f.commit(oauth('user-one','new'))
  assert.deepEqual(repeated.accountIds,first.accountIds);assert.equal(repeated.duplicates,1)
  assert.deepEqual(f.store.read().accounts[0],saved)
  const another=f.commit(oauth('user-two','another'))
  assert.equal(another.added,1);assert.notEqual(another.accountIds[0],first.accountIds[0])
})

test('API, OAuth and Agent Identity credentials sharing names or account metadata do not mix IDs',t=>{
  const f=fixture(t),key=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64')
  const identity={agent_identity:{agent_runtime_id:'fixture-runtime',agent_private_key:key,account_id:'shared-org',chatgpt_user_id:'user-one',chatgpt_account_is_fedramp:false,email:'same@example.invalid'},name:'Same display name'}
  const result=f.commit([api('fixture-api'),oauth('user-one','oauth'),identity])
  assert.equal(result.added,3);assert.equal(new Set(result.accountIds).size,3)
  const accounts=f.store.read().accounts
  assert.deepEqual(accounts.map(account=>account.kind),['api_key','oauth','agent_identity'])
  const repeated=f.commit({...identity,agent_identity:{...identity.agent_identity,agent_runtime_id:'different-runtime'}})
  assert.deepEqual(repeated.accountIds,[accounts[2].id]);assert.equal(repeated.duplicates,1)
  assert.equal(JSON.stringify(repeated).includes(key),false)
})

test('skipped and invalid entries do not select unrelated accounts or commit a partial import',t=>{
  const f=fixture(t),unrelated=f.commit(api('fixture-unrelated'))
  const result=f.commit([{platform:'claude',type:'oauth',access_token:'fixture-skipped'},api('fixture-valid')])
  assert.equal(result.skipped,1);assert.equal(result.accountIds.length,1)
  assert.equal(result.accountIds.includes(unrelated.accountIds[0]),false)
  const staged=f.files.stage(JSON.stringify([api('fixture-not-committed'),{name:'Missing credentials'}]))
  assert.throws(()=>f.files.commit(staged.ticket),/导入错误/)
  assert.equal(f.store.read().accounts.some(account=>account.credentials.apiKey==='fixture-not-committed'),false)
})

test('optional ID collection preserves legacy count results and reports nothing on a failed transaction',t=>{
  const f=fixture(t),parsed=parseAccountImport(JSON.stringify([api('fixture-one'),api('fixture-one')])).accounts,ids:string[]=[]
  const result=importParsedAccounts(f.store,parsed,id=>ids.push(id))
  assert.deepEqual(result,{added:1,duplicates:1})
  assert.deepEqual(ids,[f.store.read().accounts[0].id,f.store.read().accounts[0].id])
  const root=mkdtempSync(join(tmpdir(),'aml-failed-import-ids-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const failedStore=new Store(root,{encrypt:()=>{throw new Error('fixture persistence failure')},decrypt:value=>value.toString()}),failedIds:string[]=[]
  assert.throws(()=>importParsedAccounts(failedStore,parsed,id=>failedIds.push(id)),/persistence failure/)
  assert.deepEqual(failedIds,[]);assert.equal(failedStore.read().accounts.length,0)
})
