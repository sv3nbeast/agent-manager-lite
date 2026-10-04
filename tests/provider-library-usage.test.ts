import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'
import {Store} from '../src/main/store'
import {mutateProvider} from '../src/main/providerLibrary'
import {ProviderUsageQueries} from '../src/main/providerUsageRefresh'
import {type JSONRequest} from '../src/main/network'
import {exportBackupState,validateBackup} from '../src/main/dataBackupState'

type Context={after(fn:()=>unknown):void}
const json=(res:ServerResponse,value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}
async function server(t:Context,handler:(req:IncomingMessage,res:ServerResponse)=>void){
  const s=createServer(handler);await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>{s.closeAllConnections();s.close()})
  return `http://127.0.0.1:${(s.address() as {port:number}).port}/v1`
}
function fixture(t:Context,baseUrl:string,request?:JSONRequest){
  const directory=mkdtempSync(join(tmpdir(),'cml-library-usage-'));let fail=false
  const codec={encrypt:(text:string)=>{if(fail)throw Error('fixture storage');return Buffer.from(text)},decrypt:(bytes:Buffer)=>bytes.toString()}
  const store=new Store(directory,codec);t.after(()=>rmSync(directory,{recursive:true,force:true}))
  mutateProvider(store,{action:'create',details:{name:'Usage fixture',baseUrl,models:['fixture'],integrationType:'sub2api',defaultTier:'fast'}})
  const provider=()=>store.read().providers![0]
  const mutate=(action:string,extra:Record<string,unknown>={})=>mutateProvider(store,{action,id:provider().id,revision:provider().revision,...extra})
  mutate('addKey',{name:'First',apiKey:'fixture-first-secret'})
  const service=new ProviderUsageQueries(store,request);t.after(()=>service.stop())
  const start=(ids=provider().keys.map(key=>key.id))=>service.start({providerId:provider().id,revision:provider().revision,keyIds:ids})
  return {store,codec,provider,mutate,service,start,fail:(value:boolean)=>{fail=value}}
}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'fixture timeout');await delay(5)}}

test('library-only keys query real HTTP without accounts, preserve per-key quota and survive reopening and backup',async t=>{
  const paths:string[]=[]
  const base=await server(t,(req,res)=>{paths.push(req.url!);assert.equal(req.url,'/v1/usage');json(res,{remaining:req.headers.authorization==='Bearer fixture-first-secret'?0:23,unit:'USD'})})
  const f=fixture(t,base);f.mutate('addKey',{name:'Second',apiKey:'fixture-second-secret'})
  f.start();await f.service.settled()
  assert.deepEqual(paths,['/v1/usage','/v1/usage']);assert.equal(f.service.snapshot().completed,2);assert.equal(f.service.snapshot().failed,0)
  assert.deepEqual(f.provider().keys.map(k=>k.usage?.summary?.remaining),[0,23]);assert.equal(f.store.read().accounts.length,0)
  assert.equal(f.provider().defaultTier,'fast');assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-first-secret'),false)
  assert.deepEqual(new Store(f.store.directory,f.codec).snapshot(),JSON.parse(JSON.stringify(f.store.snapshot())))
  const backup=validateBackup(JSON.parse(JSON.stringify(exportBackupState(f.store.read(),{}))))
  assert.deepEqual(backup.state.providers![0].keys.map(k=>k.usage?.summary?.remaining),[0,23])
})

test('120 keys refresh across table pages with at most three concurrent real requests and no missing results',async t=>{
  let active=0,max=0,calls=0
  const base=await server(t,(_req,res)=>{active++;calls++;max=Math.max(max,active);setTimeout(()=>{active--;json(res,{remaining:calls,unit:'CNY'})},3)})
  const f=fixture(t,base)
  f.store.transaction(s=>{const p=s.providers![0];for(let i=1;i<120;i++)p.keys.push({id:randomUUID(),name:`Key ${i}`,apiKey:`fixture-${i}`,createdAt:1,updatedAt:1})})
  f.start();assert.throws(()=>f.start(),/正在进行/);await f.service.settled()
  assert.equal(calls,120);assert.equal(max,3);assert.equal(f.service.snapshot().completed,120);assert.equal(f.service.snapshot().failed,0)
  assert.equal(f.provider().keys.filter(k=>k.usage?.summary).length,120)
})

test('failures retain last success; cancellation closes active requests and never queries remaining keys',async t=>{
  let mode='ok',calls=0;const held:ServerResponse[]=[]
  const base=await server(t,(_req,res)=>{calls++;if(mode==='hold'){held.push(res);return}if(mode==='fail'){res.writeHead(429).end('fixture-first-secret');return}json(res,{remaining:8,unit:'USD'})})
  const f=fixture(t,base);f.start();await f.service.settled();const summary=f.provider().keys[0].usage!.summary
  mode='fail';f.start();await f.service.settled();assert.deepEqual(f.provider().keys[0].usage!.summary,summary);assert.match(f.provider().keys[0].usage!.error!,/HTTP 429/);assert.equal(JSON.stringify(f.store.snapshot()).includes('fixture-first-secret'),false)
  for(let i=0;i<5;i++)f.mutate('addKey',{name:`Pending ${i}`,apiKey:`fixture-pending-${i}`})
  const before=f.provider().keys.map(k=>k.usage),priorCalls=calls;mode='hold';f.start();await until(()=>held.length===3)
  assert.throws(()=>f.service.cancel(randomUUID()),/批次已变化/)
  f.service.cancel(f.service.snapshot().runId!);await f.service.settled()
  assert.equal(calls-priorCalls,3);assert.equal(f.service.snapshot().cancelled,true);assert.deepEqual(f.provider().keys.map(k=>k.usage),before)
  await until(()=>held.every(res=>res.destroyed));assert.equal(f.store.read().accounts.length,0)
})

test('rotations, endpoint/integration edits, moves and removals discard stale quota without changing unrelated keys',async t=>{
  let release:((value:Record<string,unknown>)=>void)|undefined
  const f=fixture(t,'https://fixture.invalid/v1',async()=>new Promise(resolve=>{release=resolve}))
  f.mutate('addKey',{name:'Other',apiKey:'fixture-other'})
  f.store.transaction(s=>{for(const key of s.providers![0].keys)key.usage={checkedAt:1,summary:{source:'sub2api',updatedAt:1,remaining:5}}})
  const id=f.provider().keys[0].id
  f.start([id]);await until(()=>!!release);f.mutate('editKey',{keyId:id,apiKey:'fixture-rotated'});release!({remaining:90,unit:'USD'});await f.service.settled()
  assert.equal(f.provider().keys[0].usage,undefined);assert.equal(f.provider().keys[1].usage?.summary?.remaining,5);assert.equal(f.service.snapshot().cancelled,true)
  f.mutate('update',{changes:{name:'Renamed'}});assert.equal(f.provider().keys[1].usage?.summary?.remaining,5)
  f.mutate('update',{changes:{integrationType:'new_api'}});assert.equal(f.provider().keys[1].usage,undefined)
  f.store.transaction(s=>{s.providers![0].keys[1].usage={checkedAt:1,summary:{source:'new_api',updatedAt:1,remaining:5}}})
  f.mutate('update',{changes:{baseUrl:'https://new.invalid/v1'}});assert.equal(f.provider().keys[1].usage,undefined)
  mutateProvider(f.store,{action:'create',details:{name:'Target',baseUrl:'https://target.invalid/v1',models:['fixture']}})
  const destination=f.store.read().providers![1]
  f.store.transaction(s=>{s.providers![0].keys[0].usage={checkedAt:1,summary:{source:'sub2api',updatedAt:1,remaining:5}}})
  f.mutate('moveKey',{keyId:id,targetId:destination.id,targetRevision:destination.revision})
  assert.equal(f.store.read().providers![1].keys[0].usage,undefined)
  release=undefined;f.start();await until(()=>!!release);f.mutate('delete');release!({remaining:90});await f.service.settled()
  assert.equal(f.store.read().providers!.length,1);assert.equal(f.service.snapshot().cancelled,true)
})

test('input validation rejects stale revisions, duplicate/missing keys and injected credentials before network; save failure is visible once',async t=>{
  let calls=0
  const f=fixture(t,'https://fixture.invalid/v1',async()=>{calls++;return {remaining:10,unit:'USD'}})
  const p=f.provider(),input={providerId:p.id,revision:p.revision,keyIds:[p.keys[0].id]}
  for(const raw of [{...input,apiKey:'injected'},{...input,keyIds:[]},{...input,keyIds:[randomUUID()]},{...input,keyIds:[p.keys[0].id,p.keys[0].id]},{...input,revision:-1},{...input,revision:p.revision+1}])assert.throws(()=>f.service.start(raw))
  assert.equal(calls,0)
  const bytes=readFileSync(join(f.store.directory,'state.vault'));f.fail(true);f.start();await f.service.settled()
  assert.equal(f.service.snapshot().failed,1);assert.match(f.service.snapshot().error!,/无法保存/);assert.equal(f.provider().keys[0].usage,undefined);assert.deepEqual(readFileSync(join(f.store.directory,'state.vault')),bytes)
})

test('stop aborts pending library requests and protects the last saved summary',async t=>{
  let started=false,aborted=false
  const f=fixture(t,'https://fixture.invalid/v1',async(_url,init)=>new Promise((_resolve,reject)=>{started=true;init?.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('fixture-first-secret'))},{once:true})}))
  f.start();await until(()=>started);await f.service.stop()
  assert.equal(aborted,true);assert.equal(f.service.snapshot().running,false);assert.equal(f.provider().keys[0].usage,undefined)
})
