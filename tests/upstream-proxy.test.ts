import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, type StoredAccount } from '../src/main/store'
import { parseAccountImport } from '../src/main/accounts'
import { AccountNetwork } from '../src/main/accountNetwork'
import { AccountProxies } from '../src/main/accountProxy'
import { UpstreamProxies, upstreamProxyView } from '../src/main/upstreamProxy'
import { accountProxyURL, accountProxyView, defaultProxyURL } from '../src/main/proxyPolicy'
import { exportBackupState, validateBackup } from '../src/main/dataBackupState'

function fixture(t:{after(fn:()=>void|Promise<void>):void}) {
  const root=mkdtempSync(join(tmpdir(),'aml-upstream-proxy-')),key=randomBytes(32)
  const codec={encrypt:(text:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()])},
    decrypt:(raw:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString()}}
  const store=new Store(root,codec),account=parseAccountImport('at-fixture-proxy').accounts[0]
  store.transaction(state=>{state.accounts.push(account);state.settings.refreshMinutes=0})
  const network=new AccountNetwork(resolve('resources/bin/codex-proxy'),()=>store.proxyState())
  t.after(async()=>{await network.stop();rmSync(root,{force:true,recursive:true})})
  return {root,store,network,account,codec}
}
async function listen(t:{after(fn:()=>void|Promise<void>):void},server:Server) {
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const address=server.address();assert.ok(address&&typeof address==='object')
  t.after(()=>{server.closeAllConnections();server.close()})
  return `http://127.0.0.1:${address.port}`
}

test('new default and independent exits cover all account kinds while absent default preserves legacy OAuth scope',t=>{
  const f=fixture(t),resourceId=randomUUID(),legacy={proxyResources:[{id:resourceId,revision:0,name:'Legacy',url:'http://legacy.invalid:8080'}],unifiedProxy:{mode:'all_accounts' as const,resourceId}}
  for(const kind of ['oauth','api_key','agent_identity'] as const) {
    const account={...f.account,kind}
    assert.equal(accountProxyURL(account,legacy),kind==='oauth'?'http://legacy.invalid:8080/':undefined)
    const state={...legacy,upstreamProxy:{revision:1,mode:'custom' as const,url:'http://new.invalid:8081'}}
    assert.equal(accountProxyURL(account,state),'http://new.invalid:8081/')
    assert.deepEqual(accountProxyView(account,state),{mode:'inherit',source:'global',protocol:'HTTP',server:'new.invalid',port:8081,authenticated:false})
    assert.equal(accountProxyURL({...account,proxy:{mode:'direct'}},state),'direct')
    assert.equal(accountProxyURL({...account,proxy:{mode:'custom',url:'socks5h://own.invalid:1080'}},state),'socks5h://own.invalid:1080')
    assert.deepEqual(accountProxyView(account,{...state,upstreamProxy:{revision:2,mode:'direct'}}),{mode:'inherit',source:'global'})
  }
  assert.throws(()=>defaultProxyURL({upstreamProxy:{revision:1,mode:'custom',url:'file:///bad'}}))
  assert.equal(upstreamProxyView({upstreamProxy:{revision:1,mode:'custom',url:'file:///bad'}}).invalid,true)
})

test('proxy saves validate URL, preserve blank secrets, reject stale/busy changes and roundtrip encrypted backup',t=>{
  const f=fixture(t);let busy=false
  const service=new UpstreamProxies(f.store,f.network,()=>busy)
  service.save({revision:0,mode:'custom',url:'http://fixture:secret%40pass@127.0.0.1:9876'})
  assert.equal(f.store.snapshot().upstreamProxy?.authenticated,true)
  assert.equal(JSON.stringify(f.store.snapshot()).includes('secret'),false)
  assert.equal(readFileSync(join(f.root,'state.vault')).includes(Buffer.from('secret')),false)
  assert.equal(new Store(f.root,f.codec).read().upstreamProxy?.url,'http://fixture:secret%40pass@127.0.0.1:9876/')
  const bundle=validateBackup(exportBackupState(f.store.read(),{}))
  assert.deepEqual(bundle.state.upstreamProxy,f.store.read().upstreamProxy)
  const before=f.store.read()
  for(const url of ['file:///bad','ss://secret','http://host:0','socks5://host','http://user:%0a@host:88'])assert.throws(()=>service.save({revision:1,mode:'custom',url}))
  assert.throws(()=>service.save({revision:1,mode:'direct',url:'http://host:88'}))
  assert.deepEqual(f.store.read(),before)
  assert.throws(()=>service.save({revision:0,mode:'direct'}),/变化/)
  busy=true;assert.throws(()=>service.save({revision:1,mode:'direct'}),/正在使用/);busy=false
  service.save({revision:1,mode:'custom'});assert.equal(f.store.read().upstreamProxy?.url,before.upstreamProxy?.url)
  service.save({revision:2,mode:'direct'});assert.equal(defaultProxyURL(f.store.proxyState()),'direct')
  service.save({revision:3,mode:'inherit'});assert.equal(defaultProxyURL(f.store.proxyState()),undefined)
})

test('real global authenticated HTTP exit covers unattributed and all account requests; explicit direct wins and dead proxy cannot hit target',async t=>{
  const f=fixture(t);let direct=0,proxied=0
  const target=await listen(t,createServer((_req,res)=>{direct++;res.end('{"ip":"203.0.113.1"}')}))
  const proxy=await listen(t,createServer((req,res)=>{proxied++;assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:secret').toString('base64'));assert.equal(req.url,target+'/');res.end('{"ip":"203.0.113.2"}')}))
  const service=new UpstreamProxies(f.store,f.network)
  service.save({revision:0,mode:'custom',url:proxy.replace('://','://fixture:secret@')})
  assert.equal((await f.network.request(target)).ip,'203.0.113.2')
  for(const kind of ['oauth','api_key','agent_identity'] as const)assert.equal((await f.network.request(target,{},'fixture',{...f.account,kind})).ip,'203.0.113.2')
  assert.equal(proxied,4);assert.equal(direct,0)
  assert.equal((await f.network.request(target,{},'fixture',{...f.account,proxy:{mode:'direct'}})).ip,'203.0.113.1')
  service.save({revision:1,mode:'custom',url:'http://127.0.0.1:1'})
  await assert.rejects(f.network.request(target));assert.equal(direct,1)
  await assert.rejects(f.network.fetchUpstream(target));assert.equal(direct,1)
})

test('independent API and Agent Identity settings are stored and override the default',t=>{
  const f=fixture(t),service=new AccountProxies(f.store,f.network)
  for(const kind of ['api_key','agent_identity'] as const) {
    f.store.transaction(state=>{state.accounts[0].kind=kind})
    const before=f.store.read().accounts[0]
    service.save({accountId:before.id,revision:before.revision??0,mode:'custom',url:'https://proxy.invalid:443'})
    assert.equal(accountProxyURL(f.store.read().accounts[0]),'https://proxy.invalid/')
  }
})

test('exit checks cancel before start, abort in flight, reject late revisions and never commit settings',async t=>{
  const f=fixture(t);let release:(value:Record<string,unknown>)=>void=()=>{}
  let signal:AbortSignal|undefined,calls=0
  const network={through:()=>async(_url:string,init?:RequestInit)=>{calls++;signal=init?.signal??undefined;return await new Promise<Record<string,unknown>>(done=>{release=done;signal?.addEventListener('abort',()=>done({ip:'203.0.113.7'}),{once:true})})}}
  const service=new UpstreamProxies(f.store,network)
  const cancelled=randomUUID();await service.cancel(cancelled)
  assert.throws(()=>service.probe({revision:0,requestId:cancelled,mode:'direct'}),/取消/);assert.equal(calls,0)
  const id=randomUUID(),pending=service.probe({revision:0,requestId:id,mode:'direct'})
  await Promise.resolve();assert.throws(()=>service.save({revision:0,mode:'direct'}),/正在使用/)
  const rejection=assert.rejects(pending);await service.cancel(id);await rejection;assert.equal(signal?.aborted,true)
  const late=service.probe({revision:0,requestId:randomUUID(),mode:'direct'})
  await Promise.resolve();f.store.transaction(state=>{state.upstreamProxy={revision:1,mode:'direct'}});release({ip:'203.0.113.7'})
  await assert.rejects(late,/变化/);assert.equal(f.store.read().upstreamProxy?.revision,1)
  await service.stop()
})
