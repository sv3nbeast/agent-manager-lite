import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Store } from '../src/main/store'
import { mutateProvider, providerTierForAccount, readProviderKey } from '../src/main/providerLibrary'
import { createAPIAccount, editAccount, importParsedAccounts } from '../src/main/accounts'
import { Gateway } from '../src/main/gateway'
import { AccountFiles } from '../src/main/accountFiles'
import { parseAccountImport } from '../src/main/accounts'
import { settingsSchema } from '../src/shared/types'

function fixture(t:{after(fn:()=>void):void}) {
  const root = mkdtempSync(join(tmpdir(),'cml-provider-library-')), encryptionKey = randomBytes(32)
  let fail = false
  const codec = {
    encrypt(value:string) {
      if(fail) throw new Error('fixture storage unavailable')
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv)
      const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()])
      return Buffer.concat([iv,cipher.getAuthTag(),data])
    },
    decrypt(value:Buffer) {
      const cipher=createDecipheriv('aes-256-gcm',encryptionKey,value.subarray(0,12))
      cipher.setAuthTag(value.subarray(12,28))
      return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString()
    }
  }
  const store=new Store(join(root,'vault'),codec)
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  function create(baseUrl='https://fixture.invalid/v1',name='Fixture') {
    mutateProvider(store,{action:'create',details:{name,baseUrl,models:['fixture-model'],wireApi:'responses',defaultTier:'fast'}})
    return store.read().providers!.at(-1)!.id
  }
  const get=(id:string)=>store.read().providers!.find(p=>p.id===id)!
  function act(id:string,action:string,extra:Record<string,unknown>={},inUse:()=>boolean=()=>false) {
    mutateProvider(store,{action,id,revision:get(id).revision,...extra},inUse)
  }
  return {root,store,codec,create,get,act,setFailure:(value:boolean)=>{fail=value}}
}
function api(name:string,baseUrl:string,apiKey:string) {
  return createAPIAccount({name,baseUrl,apiKey,models:['account-model'],wireApi:'responses',defaultTier:'inherit',note:'',tags:[]})
}

test('explicit key reads validate provider, revision and key membership without mutating or exposing routine snapshots',t=>{
  const f=fixture(t),id=f.create(),other=f.create('https://other.invalid/v1')
  f.act(id,'addKey',{name:'Read target',apiKey:'fixture-readable-secret'})
  f.act(other,'addKey',{name:'Other target',apiKey:'fixture-other-secret'})
  const provider=f.get(id),input={id,revision:provider.revision,keyId:provider.keys[0].id}
  const before=f.store.read(),disk=readFileSync(join(f.store.directory,'state.vault'))
  assert.equal(readProviderKey(f.store,input),'fixture-readable-secret')
  assert.throws(()=>readProviderKey(f.store,{...input,revision:input.revision-1}),/已被修改/)
  assert.throws(()=>readProviderKey(f.store,{...input,keyId:f.get(other).keys[0].id}),/删除或移动/)
  assert.throws(()=>readProviderKey(f.store,{...input,id:'invalid'}))
  assert.deepEqual(f.store.read(),before)
  assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),disk)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-readable-secret'),false)
  f.act(id,'removeKey',{keyId:input.keyId})
  assert.throws(()=>readProviderKey(f.store,{...input,revision:f.get(id).revision}),/删除或移动/)
  f.act(id,'delete')
  assert.throws(()=>readProviderKey(f.store,input),/供应商已删除/)
})

test('provider editing saves key rotation and context clearing atomically without changing unrelated connections',t=>{
  const f=fixture(t),id=f.create()
  f.act(id,'addKey',{name:'A',apiKey:'fixture-a',createConnection:true})
  f.act(id,'addKey',{name:'B',apiKey:'fixture-b',createConnection:true})
  f.act(id,'update',{changes:{modelContextWindows:{'fixture-model':333333,'legacy-model':128000}}})
  const provider=f.get(id),before=f.store.read(),other=before.accounts[1]
  const input={action:'update',id,revision:provider.revision,changes:{name:'Edited'},clearModelContextWindows:true,keyChange:{keyId:provider.keys[0].id,apiKey:'fixture-rotated'}}
  assert.throws(()=>mutateProvider(f.store,{...input,keyChange:{...input.keyChange,apiKey:'fixture-b'}}),/已保存/)
  assert.deepEqual(f.store.read(),before)
  assert.throws(()=>mutateProvider(f.store,input,()=>true),/停止/)
  assert.deepEqual(f.store.read(),before)
  f.setFailure(true);assert.throws(()=>mutateProvider(f.store,input),/storage unavailable/)
  assert.deepEqual(f.store.read(),before)
  f.setFailure(false);mutateProvider(f.store,input)
  const saved=f.store.read()
  assert.equal(saved.providers![0].name,'Edited')
  assert.equal(saved.providers![0].modelContextWindows,undefined)
  assert.equal(saved.accounts[0].credentials.apiKey,'fixture-rotated')
  assert.deepEqual(saved.accounts[1],other)
  const reopened=new Store(f.store.directory,f.codec)
  assert.equal(reopened.read().providers![0].modelContextWindows,undefined)
  assert.equal(readProviderKey(reopened,{id,revision:f.get(id).revision,keyId:input.keyChange.keyId}),'fixture-rotated')
})

test('provider, initial key and usable connection commit atomically with inherited tier',t=>{
  const f=fixture(t)
  const input={action:'create',details:{name:'One form',baseUrl:'https://new.invalid/v1',models:['chosen-model'],defaultTier:'fast'},initialKey:{name:'',apiKey:'fixture-first-key',createConnection:true}}
  f.setFailure(true);assert.throws(()=>mutateProvider(f.store,input),/storage unavailable/)
  assert.equal(f.store.read().providers?.length??0,0);assert.equal(f.store.read().accounts.length,0)
  f.setFailure(false);mutateProvider(f.store,input)
  const state=f.store.read(),account=state.accounts[0],provider=state.providers![0]
  assert.equal(account.name,'One form');assert.equal(account.providerId,provider.id)
  assert.equal(providerTierForAccount(state,account),'fast');assert.equal(account.defaultTier,'inherit')
  assert.deepEqual(account.models,['chosen-model']);assert.equal(account.credentials.apiKey,'fixture-first-key')
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-first-key'),false)
  f.act(provider.id,'addKey',{name:'Second',apiKey:'fixture-second',createConnection:true})
  assert.equal(f.store.read().accounts.length,2)
  f.act(provider.id,'addKey',{name:'Second',apiKey:'fixture-second',createConnection:true})
  assert.equal(f.store.read().accounts.length,2,'Repeated save must not duplicate a connection')
})

test('new provider cannot silently overwrite an existing standalone API connection',t=>{
  const f=fixture(t),old=api('Old','https://old.invalid/v1','fixture-old')
  importParsedAccounts(f.store,[old])
  const before=f.store.read()
  assert.throws(()=>mutateProvider(f.store,{action:'create',details:{name:'New',baseUrl:old.baseUrl,models:['new-model'],defaultTier:'fast'},initialKey:{name:'New',apiKey:'fixture-old',createConnection:true}}),/重复账号/)
  assert.deepEqual(f.store.read(),before)
})

test('provider vault is backward compatible, encrypted and snapshot contains no saved secrets or exclusion hashes',t=>{
  const f=fixture(t)
  f.store.transaction(s=>{delete s.providers})
  assert.deepEqual(new Store(f.store.directory,f.codec).snapshot().providers,[])
  const id=f.create()
  f.act(id,'addKey',{name:'Personal',apiKey:'fake-provider-only-secret'})
  const key=f.get(id).keys[0]
  f.act(id,'createAccount',{name:'Linked',keyId:key.id})
  const snapshot=f.store.snapshot()
  assert.equal(snapshot.providers![0].keys[0].accountIds[0],snapshot.accounts[0].id)
  assert.equal(JSON.stringify(snapshot).includes('fake-provider-only-secret'),false)
  assert.equal('apiKey' in snapshot.providers![0].keys[0],false)
  assert.equal('excludedKeyHashes' in snapshot.providers![0],false)
  assert.equal(readFileSync(join(f.store.directory,'state.vault')).includes('fake-provider-only-secret'),false)
  assert.deepEqual(new Store(f.store.directory,f.codec).snapshot(),snapshot)
  const before=f.store.read(),disk=readFileSync(join(f.store.directory,'state.vault'))
  f.setFailure(true)
  assert.throws(()=>f.act(id,'editKey',{keyId:key.id,apiKey:'fake-rotated-secret'}),/storage unavailable/)
  assert.deepEqual(f.store.read(),before)
  assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),disk)
})

test('URL deduplication preserves path case; account imports merge keys without changing provider settings or saved names',t=>{
  const f=fixture(t),id=f.create('https://EXAMPLE.invalid:443/Team/v1/')
  assert.throws(()=>f.create('https://example.invalid/Team/v1'),/已存在/)
  const different=f.create('https://example.invalid/team/v1')
  f.act(id,'addKey',{name:'Saved key name',apiKey:'fixture-shared'})
  f.act(id,'addKey',{name:'Unwanted rename',apiKey:'  fixture-shared  '})
  const before=f.get(id)
  importParsedAccounts(f.store,[api('Imported account','https://example.invalid/Team/v1','fixture-shared')])
  assert.deepEqual(f.get(id),before)
  assert.equal(f.get(different).keys.length,0)
  importParsedAccounts(f.store,[api('Second','https://example.invalid/Team/v1','fixture-second')])
  assert.equal(f.get(id).keys.length,2)
  assert.equal(f.get(id).keys[0].name,'Saved key name')
  assert.deepEqual(f.get(id).models,['fixture-model'])
  assert.equal(f.store.read().accounts[0].providerId,undefined,'Imports must not implicitly retarget accounts')
  assert.deepEqual(importParsedAccounts(f.store,[api('Duplicate','https://EXAMPLE.invalid:443/Team/v1/','fixture-shared')]),{added:0,duplicates:1})
})

test('removed keys survive reconciliation and restart; explicit additions restore only the requested key',t=>{
  const f=fixture(t),id=f.create()
  importParsedAccounts(f.store,[api('First','https://fixture.invalid/v1','fixture-removed'),api('Other','https://fixture.invalid/v1','fixture-other')])
  const key=f.get(id).keys[0]
  f.act(id,'removeKey',{keyId:key.id})
  for(let i=0;i<3;i++) mutateProvider(f.store,{action:'reconcile'})
  const reopened=new Store(f.store.directory,f.codec)
  mutateProvider(reopened,{action:'reconcile'})
  assert.deepEqual(reopened.read().providers![0].keys.map(k=>k.apiKey),['fixture-other'])
  f.act(id,'addKey',{name:'Explicitly restored',apiKey:'fixture-removed'})
  assert.equal(f.get(id).excludedKeyHashes.length,0)
  assert.equal(f.get(id).keys.length,2)
})

test('moving keys preserves identity, merges compatible duplicates, and atomically rejects name or revision conflicts',t=>{
  const f=fixture(t),left=f.create(),right=f.create('https://target.invalid/v1','Target')
  f.act(left,'addKey',{name:'Source',apiKey:'fixture-move'})
  const key=f.get(left).keys[0]
  f.act(left,'createAccount',{keyId:key.id,name:'Keep endpoint'})
  f.act(right,'addKey',{name:'Different name',apiKey:'fixture-move'})
  const before=f.store.read()
  assert.throws(()=>f.act(left,'moveKey',{keyId:key.id,targetId:right,targetRevision:f.get(right).revision}),/名称不同/)
  assert.deepEqual(f.store.read(),before)
  const destination=f.get(right).keys[0]
  f.act(right,'editKey',{keyId:destination.id,name:''})
  assert.throws(()=>f.act(left,'moveKey',{keyId:key.id,targetId:right,targetRevision:0}),/已被修改/)
  f.act(left,'moveKey',{keyId:key.id,targetId:right,targetRevision:f.get(right).revision})
  assert.equal(f.get(right).keys[0].id,destination.id)
  assert.equal(f.get(right).keys[0].name,'Source')
  const detached=f.store.read().accounts[0]
  assert.equal(detached.providerId,undefined)
  assert.equal(detached.baseUrl,'https://fixture.invalid/v1')
  assert.equal(detached.defaultTier,'fast')
  mutateProvider(f.store,{action:'reconcile'})
  assert.equal(f.get(left).keys.length,0)
  f.act(left,'addKey',{name:'Unique',apiKey:'fixture-unique'})
  const unique=f.get(left).keys[0]
  f.act(left,'moveKey',{keyId:unique.id,targetId:right,targetRevision:f.get(right).revision})
  assert.equal(f.get(right).keys[1].id,unique.id)
  assert.equal(f.get(right).keys[1].createdAt,unique.createdAt)
})

test('provider updates project only linked credentials, block live connection edits, and protect stale account forms',t=>{
  const f=fixture(t),id=f.create()
  f.act(id,'addKey',{name:'A',apiKey:'fixture-a'})
  f.act(id,'addKey',{name:'B',apiKey:'fixture-b'})
  const [a,b]=f.get(id).keys
  f.act(id,'createAccount',{keyId:a.id,name:'Linked A'})
  f.act(id,'createAccount',{keyId:b.id,name:'Linked B'})
  const original=f.store.read().accounts[0]
  assert.throws(()=>editAccount(f.store,{id:original.id,revision:original.revision,changes:{apiKey:'direct-secret'}}),/供应商管理/)
  assert.throws(()=>f.act(id,'editKey',{keyId:a.id,apiKey:'rotated-a'},()=>true),/停止/)
  assert.throws(()=>f.act(id,'update',{changes:{baseUrl:'https://new.invalid/v1'}},()=>true),/停止/)
  assert.throws(()=>f.act(id,'removeKey',{keyId:a.id},()=>true),/停止/)
  assert.throws(()=>f.act(id,'delete',{},()=>true),/停止/)
  f.act(id,'update',{changes:{defaultTier:'standard'}},()=>true) // Applies only after gateway restart.
  f.act(id,'editKey',{keyId:a.id,apiKey:'rotated-a'})
  assert.equal(f.store.read().accounts[0].credentials.apiKey,'rotated-a')
  assert.equal(f.store.read().accounts[1].credentials.apiKey,'fixture-b')
  assert.throws(()=>editAccount(f.store,{id:original.id,revision:original.revision,changes:{name:'Old form'}}),/已被修改/)
  assert.throws(()=>f.act(id,'editKey',{keyId:a.id,apiKey:'fixture-b'}),/已保存此密钥/)
  f.act(id,'update',{changes:{baseUrl:'https://new.invalid/v1',models:['new-model'],wireApi:'chat_completions'}})
  assert.ok(f.store.read().accounts.every(account=>account.baseUrl==='https://new.invalid/v1' && account.wireApi==='chat_completions' && account.models[0]==='new-model'))
  const edited=f.store.read().accounts[0]
  assert.equal(providerTierForAccount(f.store.read(),edited),'standard')
  const tampered={...edited,baseUrl:'https://wrong.invalid/v1'}
  assert.throws(()=>providerTierForAccount(f.store.read(),tampered),/关联已变化/)
  f.act(id,'delete')
  assert.equal(f.store.read().accounts.length,2)
  assert.ok(f.store.read().accounts.every(account=>!account.providerId && account.defaultTier==='standard'))
})

test('link/unlink validates account revisions and prevents duplicate endpoints with the same credential',t=>{
  const f=fixture(t),id=f.create()
  f.act(id,'addKey',{name:'Key',apiKey:'fixture-link'})
  const key=f.get(id).keys[0]
  const existing=api('Existing','https://old.invalid/v1','fixture-old')
  importParsedAccounts(f.store,[existing])
  assert.throws(()=>f.act(id,'linkAccount',{keyId:key.id,accountId:existing.id,accountRevision:5}),/已被修改/)
  f.act(id,'linkAccount',{keyId:key.id,accountId:existing.id,accountRevision:0})
  const linked=f.store.read().accounts[0]
  assert.equal(linked.credentials.apiKey,'fixture-link')
  assert.equal(linked.baseUrl,'https://fixture.invalid/v1')
  assert.throws(()=>f.act(id,'createAccount',{keyId:key.id,name:'Duplicate'}),/重复账号/)
  assert.throws(()=>mutateProvider(f.store,{action:'unlinkAccount',accountId:existing.id,accountRevision:0}),/已被修改/)
  mutateProvider(f.store,{action:'unlinkAccount',accountId:existing.id,accountRevision:linked.revision})
  assert.equal(f.store.read().accounts[0].defaultTier,'fast')
  assert.equal(f.store.read().accounts[0].providerId,undefined)
})

test('large account reconciliation is idempotent and produces a secret-free provider summary',t=>{
  const f=fixture(t),id=f.create()
  // Seed distinct already-imported accounts to exercise the actual library merge at scale.
  f.store.transaction(s=>{s.accounts=Array.from({length:10000},(_,i)=>api(`Account ${i}`,'https://fixture.invalid/v1',`fixture-volume-secret-${i}`))})
  mutateProvider(f.store,{action:'reconcile'})
  assert.equal(f.get(id).keys.length,10000)
  const revision=f.get(id).revision
  mutateProvider(f.store,{action:'reconcile'})
  assert.equal(f.get(id).revision,revision)
  assert.equal(f.store.snapshot().providers![0].keys.length,10000)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-volume-secret'),false)
})

test('standalone account export preserves inherited provider defaults without changing the encrypted authority',async t=>{
  const f=fixture(t),id=f.create()
  f.act(id,'addKey',{name:'Export',apiKey:'fixture-export-key'})
  f.act(id,'createAccount',{keyId:f.get(id).keys[0].id,name:'Exported'})
  const before=f.store.read(),account=before.accounts[0],files=new AccountFiles(f.store)
  const path=join(f.root,'export.json')
  try {
    assert.equal(await files.export([account.id],path),1)
    const imported=parseAccountImport(readFileSync(path,'utf8')).accounts[0]
    assert.equal(imported.defaultTier,'fast')
    assert.equal(imported.credentials.apiKey,'fixture-export-key')
    assert.equal(imported.providerId,undefined)
    assert.deepEqual(f.store.read(),before)
  } finally {await files.stop()}
})

test('linked provider Fast reaches a simulated upstream, explicit tiers survive, changes require restart and account/instance overrides win',async t=>{
  const f=fixture(t),received:{tier?:string;authorization?:string}[]=[]
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    received.push({tier:JSON.parse(raw).service_tier,authorization:req.headers.authorization})
    res.setHeader('Content-Type','application/json');res.end('{"id":"fixture","object":"response","status":"completed","output":[]}')
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const address=upstream.address();assert.ok(address && typeof address==='object')
  const id=f.create(`http://127.0.0.1:${address.port}/v1`)
  f.act(id,'addKey',{name:'Runtime',apiKey:'fixture-runtime-key'})
  f.act(id,'createAccount',{keyId:f.get(id).keys[0].id,name:'Runtime account'})
  const events:Record<string,unknown>[]=[]
  const gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(f.root,'runtime'),event=>{if(event.type==='usage')events.push(event)})
  const start=async(instance?:'fast')=>{
    const state=f.store.read(),account=state.accounts[0]
    return gateway.start({id:account.id,port:0,account,apiKey:'fixture-client',providerTier:providerTierForAccount(state,account),defaultTier:instance},settingsSchema.parse({defaultTier:'standard'}))
  }
  const request=async(tier:unknown,want:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${gateway.current().port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer fixture-client','Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'本机 🧪',service_tier:tier})})
    assert.equal(response.status,200,await response.text())
    assert.deepEqual(received.at(-1),{tier:want,authorization:'Bearer fixture-runtime-key'})
  }
  try {
    await start()
    for(const tier of [undefined,null,'','default','flex','auto','priority']) await request(tier,tier===undefined || tier===null || tier==='' ? 'priority' : tier)
    const deadline=Date.now()+2000
    while(events.length<received.length && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(events[0].tierSource,'provider')
    f.act(id,'update',{changes:{defaultTier:'standard'}})
    await request(undefined,'priority')
    await gateway.stop();await start();await request(undefined,'default')
    await gateway.stop()
    const account=f.store.read().accounts[0]
    editAccount(f.store,{id:account.id,revision:account.revision,changes:{defaultTier:'flex'}})
    await start();await request(undefined,'flex')
    await gateway.stop();await start('fast');await request(undefined,'priority');await request('default','default')
  } finally {await gateway.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))}
})
