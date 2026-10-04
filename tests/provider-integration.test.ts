import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type ServerResponse} from 'node:http'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Store} from '../src/main/store'
import {createAPIAccount,editAccount,parseAccountImport} from '../src/main/accounts'
import {serializeAccounts} from '../src/main/accountFiles'
import {mutateProvider} from '../src/main/providerLibrary'
import {queryProviderUsage,ProviderUsageUnavailable} from '../src/main/providerUsage'
import {QuotaService} from '../src/main/quota'
import {TokenAuthority} from '../src/main/tokens'
import {exportBackupState,validateBackup} from '../src/main/dataBackupState'
import {type IntegrationType} from '../src/shared/providerUsage'

type Context={after(fn:()=>unknown):void}
const account=(baseUrl:string,integrationType?:IntegrationType)=>createAPIAccount({name:'Fixture',baseUrl,apiKey:'fixture-integration-secret',models:['fixture'],wireApi:'responses',defaultTier:'fast',tags:[],note:'',...(integrationType===undefined?{}:{integrationType})})
const json=(res:ServerResponse,value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'fixture timed out');await delay(5)}}
function fixture(t:Context){
  const directory=mkdtempSync(join(tmpdir(),'cml-integration-'));let fail=false
  const codec={encrypt:(s:string)=>{if(fail)throw Error('fixture save failed');return Buffer.from(s)},decrypt:(b:Buffer)=>b.toString()}
  const store=new Store(directory,codec)
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const add=(a:ReturnType<typeof account>)=>store.transaction(s=>{s.accounts.push(a);s.settings.refreshMinutes=0})
  const edit=(id:string,integrationType:IntegrationType)=>editAccount(store,{id,revision:store.read().accounts.find(a=>a.id===id)?.revision??0,changes:{integrationType}},()=>true)
  return {store,codec,add,edit,fail:(value:boolean)=>{fail=value}}
}

test('manual quota integration uses only its protocol on a real dual-interface host, preserving paths and automatic behavior',async t=>{
  const paths:string[]=[];let status=200
  const server=createServer((req,res)=>{
    paths.push(req.url!);assert.equal(req.headers.authorization,'Bearer fixture-integration-secret')
    if(status!==200){res.writeHead(status).end();return}
    if(req.url?.endsWith('/dashboard/billing/subscription'))json(res,{hard_limit_usd:100})
    else if(req.url?.endsWith('/dashboard/billing/usage'))json(res,{total_usage:200})
    else if(req.url?.endsWith('/api/usage/token/'))json(res,{})
    else if(req.url?.endsWith('/usage'))json(res,{remaining:7,unit:'CNY'})
    else res.writeHead(404).end()
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/tenant/v1`
  for(const type of [undefined,'auto','sub2api','new_api'] as const){
    paths.length=0
    const value=await queryProviderUsage(account(base,type),new AbortController().signal)
    assert.equal(value.source,type==='sub2api'?'sub2api':'new_api')
    assert.equal(value.remaining,type==='sub2api'?7:98)
    assert.deepEqual(paths,type==='sub2api'?['/tenant/v1/usage']:['/tenant/v1/dashboard/billing/subscription','/tenant/v1/dashboard/billing/usage','/tenant/v1/api/usage/token/'])
  }
  status=404
  for(const type of ['sub2api','new_api'] as const){
    paths.length=0
    await assert.rejects(queryProviderUsage(account(new URL(base).origin,type),new AbortController().signal),ProviderUsageUnavailable)
    assert.deepEqual(paths,type==='sub2api'?['/usage','/v1/usage']:['/dashboard/billing/subscription','/v1/dashboard/billing/subscription'])
  }
  status=401;paths.length=0
  await assert.rejects(queryProviderUsage(account(base,'sub2api'),new AbortController().signal),/HTTP 401/)
  assert.deepEqual(paths,['/tenant/v1/usage'])
})

test('official provider protocols retain source precedence over integration selection; invalid enum is rejected before network',async()=>{
  for(const type of ['sub2api','new_api'] as const){
    const paths:string[]=[]
    const value=await queryProviderUsage(account('https://api.deepseek.com/v1',type),new AbortController().signal,async url=>{
      paths.push(url);return {is_available:true,balance_infos:[{currency:'CNY',total_balance:'3'}]}
    })
    assert.equal(value.source,'deepseek');assert.deepEqual(paths,['https://api.deepseek.com/user/balance'])
  }
  const invalid=account('https://fixture.invalid');Object.assign(invalid,{integrationType:'unexpected'})
  await assert.rejects(queryProviderUsage(invalid,new AbortController().signal,async()=>assert.fail('invalid settings must not send credentials')))
})

test('account integration edits are atomic, preserve Fast and metadata, and persist through exports and backups',t=>{
  const f=fixture(t),a=account('https://fixture.invalid/v1');f.add(a)
  f.store.transaction(s=>{s.accounts[0].providerUsage={checkedAt:1,summary:{source:'new_api',updatedAt:1,balance:12}}})
  f.edit(a.id,'auto');assert.equal(f.store.read().accounts[0].providerUsage?.summary?.balance,12)
  const before=f.store.read(),bytes=readFileSync(join(f.store.directory,'state.vault'))
  f.fail(true);assert.throws(()=>f.edit(a.id,'sub2api'),/save failed/);assert.deepEqual(f.store.read(),before);assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),bytes);f.fail(false)
  f.edit(a.id,'sub2api')
  const current=f.store.read().accounts[0]
  assert.equal(current.providerUsage,undefined);assert.equal(current.defaultTier,'fast');assert.equal(current.baseUrl,a.baseUrl)
  assert.equal(current.providerUsageRevision,1)
  editAccount(f.store,{id:a.id,revision:current.revision,changes:{note:'Edited note',integrationType:undefined}})
  assert.equal(f.store.read().accounts[0].integrationType,'sub2api');assert.equal(f.store.read().accounts[0].providerUsageRevision,1)
  assert.equal('providerUsageRevision' in f.store.snapshot().accounts[0],false)
  assert.equal(new Store(f.store.directory,f.codec).snapshot().accounts[0].integrationType,'sub2api')
  const imported=parseAccountImport(serializeAccounts([current]));assert.equal(imported.preview.errors.length,0);assert.equal(imported.accounts[0].integrationType,'sub2api');assert.equal(imported.accounts[0].defaultTier,'fast')
  const backup=exportBackupState(f.store.read(),{});assert.equal(validateBackup(JSON.parse(JSON.stringify(backup))).state.accounts[0].integrationType,'sub2api')
  const malformed=structuredClone(backup);Object.assign(malformed.state.accounts[0],{integrationType:'anything'});assert.throws(()=>validateBackup(malformed))
  const oauth={...a,id:crypto.randomUUID(),kind:'oauth' as const,credentials:{accessToken:'fixture-oauth'}};f.add(oauth)
  assert.throws(()=>f.edit(oauth.id,'sub2api'),/登录账号仅支持/)
})

test('provider selection projects only to linked accounts, survives detachment, and rejects inconsistent backup relationships',t=>{
  const f=fixture(t)
  mutateProvider(f.store,{action:'create',details:{name:'Provider',baseUrl:'https://fixture.invalid/v1',models:['fixture'],defaultTier:'fast',integrationType:'sub2api'}})
  const get=()=>f.store.read().providers![0]
  const act=(action:string,extra:Record<string,unknown>)=>mutateProvider(f.store,{action,id:get().id,revision:get().revision,...extra},()=>action==='update')
  for(const suffix of ['one','two']){act('addKey',{name:suffix,apiKey:`fixture-${suffix}`});act('createAccount',{keyId:get().keys.at(-1)!.id,name:suffix})}
  const standalone=account('https://independent.invalid/v1','sub2api');f.add(standalone)
  f.store.transaction(s=>{for(const a of s.accounts)a.providerUsage={checkedAt:1,summary:{source:'sub2api',updatedAt:1,remaining:4}}})
  const first=f.store.read().accounts[0]
  assert.throws(()=>f.edit(first.id,'new_api'),/供应商管理/)
  act('update',{changes:{integrationType:'new_api'}})
  for(const a of f.store.read().accounts.slice(0,2)){assert.equal(a.integrationType,'new_api');assert.equal(a.providerUsage,undefined);assert.equal(a.defaultTier,'inherit')}
  assert.equal(f.store.read().accounts[2].providerUsage?.summary?.remaining,4)
  const linked=f.store.read().accounts[0]
  editAccount(f.store,{id:linked.id,revision:linked.revision,changes:{integrationType:undefined}})
  act('update',{changes:{name:'Renamed',integrationType:undefined}})
  assert.equal(get().integrationType,'new_api');assert.equal(f.store.read().accounts[0].integrationType,'new_api')
  const backup=exportBackupState(f.store.read(),{});assert.equal(validateBackup(JSON.parse(JSON.stringify(backup))).state.providers![0].integrationType,'new_api')
  const mismatch=structuredClone(backup);mismatch.state.accounts[0].integrationType='sub2api';assert.throws(()=>validateBackup(mismatch),/关联不一致/)
  mutateProvider(f.store,{action:'unlinkAccount',accountId:first.id,accountRevision:f.store.read().accounts[0].revision})
  assert.equal(f.store.read().accounts[0].integrationType,'new_api');assert.equal(f.store.read().accounts[0].defaultTier,'fast')
  act('update',{changes:{integrationType:'auto'}})
  assert.equal(f.store.read().accounts[0].integrationType,'new_api');assert.equal(f.store.read().accounts[1].integrationType,'auto')
})

test('changing integration away and back prevents late successes and failures from restoring stale quota',async t=>{
  const f=fixture(t),a=account('https://fixture.invalid/v1','sub2api');f.add(a)
  let resolveRequest:((body:Record<string,unknown>)=>void)|undefined,rejectRequest:((error:Error)=>void)|undefined
  const tokens=new TokenAuthority(f.store,async()=>assert.fail('no token exchange'))
  const service=new QuotaService(f.store,tokens,async()=>new Promise<Record<string,unknown>>((resolve,reject)=>{resolveRequest=resolve;rejectRequest=reject}),undefined,()=>assert.fail('no OAuth routing change'))
  t.after(async()=>{await service.stop();await tokens.stop()})
  for(const failed of [false,true]){
    resolveRequest=undefined;rejectRequest=undefined;service.start([a.id]);await until(()=>!!resolveRequest)
    f.edit(a.id,'new_api');f.edit(a.id,'sub2api')
    if(failed)rejectRequest!(Error('fixture failure'));else resolveRequest!({remaining:99,unit:'USD'})
    await service.settled()
    assert.equal(f.store.read().accounts[0].providerUsage,undefined)
  }
})
