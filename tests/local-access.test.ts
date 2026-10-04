import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync,statSync,renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../src/main/store'
import { createAPIAccount, deleteAccounts, importIntoStore } from '../src/main/accounts'
import { Gateway } from '../src/main/gateway'
import { LocalAccess } from '../src/main/localAccess'
import { History } from '../src/main/history'
import { emptyLocalAccess, type LocalKeyDetails } from '../src/shared/localAccess'
import type { StoredAccount } from '../src/main/store'

function fixture(t:{after(fn:()=>void|Promise<void>):void}) {
  const root=mkdtempSync(join(tmpdir(),'cml-local-access-')), encryptionKey=randomBytes(32)
  const codec={
    encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);const data=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data])},
    decrypt(value:Buffer){const cipher=createDecipheriv('aes-256-gcm',encryptionKey,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString()}
  }
  const store=new Store(join(root,'vault'),codec),history=new History(root),events:Record<string,unknown>[]=[]
  const gateway=new Gateway(resolve('resources/bin/codex-proxy'),join(root,'runtime'),event=>{events.push(event);history.record('fixture',event)})
  const service=new LocalAccess(store,gateway,async id=>store.read().accounts.find(a=>a.id===id)!,ids=>history.keyTokenUsage(ids))
  t.after(async()=>{await service.stop();history.close();rmSync(root,{recursive:true,force:true})})
  const add=(name:string,baseUrl='http://127.0.0.1:9',tier:'fast'|'standard'|'follow'='fast')=>{
    const account=createAPIAccount({name,baseUrl,apiKey:`fixture-upstream-${name}`,models:['fixture-common',`fixture-${name}`,'fixture-secret'],wireApi:'responses',defaultTier:tier,note:'',tags:[]})
    store.transaction(s=>{s.accounts.push(account)});return account
  }
  const savePool=(ids:string[],extra:Record<string,unknown>={})=>{
    const {revision:_revision,keys:_keys,...settings}=emptyLocalAccess()
    service.mutate({action:'savePool',revision:service.view().revision,settings:{...settings,accountIds:ids,...extra}})
  }
  const key=(label:string,extra:Partial<LocalKeyDetails>={})=>{
    service.mutate({action:'createKey',details:{label,enabled:true,inheritAccountPool:true,accountIds:[],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0,...extra}})
    return service.view().keys.at(-1)!
  }
  return {root,store,history,codec,gateway,service,events,add,savePool,key}
}
async function wait(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('Fixture observation timed out');await delay(10)}}
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port}

test('imported native accounts expose builtin models while API-only keys cannot route hidden native models',async t=>{
  const f=fixture(t),api=f.add('api')
  importIntoStore(f.store,JSON.stringify({access_token:'fixture-native-pat',email:'fixture@example.invalid'}))
  const native=f.store.read().accounts.find(account=>account.kind==='oauth')!
  assert.deepEqual(native.models,[])
  f.savePool([api.id,native.id])
  const nativeKey=f.key('Native',{inheritAccountPool:false,accountIds:[native.id]}),apiKey=f.key('API',{inheritAccountPool:false,accountIds:[api.id]})
  const denied=f.key('Native limited',{inheritAccountPool:false,accountIds:[native.id],allowedModels:['gpt-5.5']})
  const port=await freePort();f.store.transaction(state=>{state.settings.port=port})
  f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)
  const list=async(key:string)=>{
    const response=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000)})
    assert.equal(response.status,200)
    return (await response.json()).data.map((model:{id:string})=>model.id) as string[]
  }
  const ids=await list(f.service.key(nativeKey.id))
  assert.ok(ids.includes('gpt-5.5'));assert.ok(ids.includes('gpt-6.1-sol'))
  assert.equal(ids.includes('fixture-api'),false);assert.equal(ids.includes('codex-auto-review'),false)
  assert.deepEqual(await list(f.service.key(denied.id)),['gpt-5.5'])
  const manifest=JSON.parse(readFileSync(join(f.gateway.runtimeDirectory()!,'manifest.json'),'utf8'))
  assert.ok(manifest.apiKeys.find((key:{id:string})=>key.id===nativeKey.id).modelRouting.routableModels.includes('codex-auto-review'))
  for(const key of [apiKey,denied]){
    const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(key.id)}`,'Content-Type':'application/json'},body:'{"model":"codex-auto-review","input":"denied"}',signal:AbortSignal.timeout(5000)})
    assert.equal(response.status,404,await response.text())
  }
  await f.service.stop();await f.service.startSingle(native.id)
  assert.ok((await list(f.store.read().accounts.find(account=>account.id===native.id)!.credentials.localAPIKey!)).includes('gpt-5.5'))
})

test('OAuth quota reserve projects fresh snapshots and hot updates the running sidecar state',async t=>{
  const f=fixture(t),base=f.add('oauth-fixture'),port=await freePort()
  const oauth={...base,id:randomUUID(),kind:'oauth' as const,models:[],credentials:{accessToken:'fixture-oauth-token'}} as StoredAccount
  oauth.quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'5h',usedPercent:70},{id:'main.secondary_window',name:'week',usedPercent:10}]}
  f.store.transaction(state=>{state.accounts=state.accounts.filter(account=>account.id!==base.id);state.accounts.push(oauth);state.settings.port=port})
  f.savePool([oauth.id],{quotaReserve:{[oauth.id]:{hourlyPercent:20,weeklyPercent:0}}})
  f.key('OAuth reserve')
  f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)
  const runtime=f.gateway.runtimeDirectory()!
  const manifest=JSON.parse(readFileSync(join(runtime,'manifest.json'),'utf8'))
  const account=manifest.accounts.find((value:{id:string})=>value.id===oauth.id)
  assert.equal(account.quotaReserve.hourlyThresholdPercent,20)
  assert.equal(account.quotaReserve.weeklyThresholdPercent,0)
  const initial=JSON.parse(readFileSync(join(runtime,'quota-reserve-state.json'),'utf8')).accounts[oauth.id]
  assert.equal(initial.hourlyRemainingPercent,30)
  assert.equal(initial.weeklyRemainingPercent,90)
  f.store.transaction(state=>{const current=state.accounts.find(value=>value.id===oauth.id)!;current.quota={updatedAt:Date.now()+1000,windows:[{id:'main.primary_window',name:'5h',usedPercent:95},{id:'main.secondary_window',name:'week',usedPercent:10}]}})
  f.gateway.updateRoutingAccount(f.store.read().accounts.find(value=>value.id===oauth.id)!)
  const updated=JSON.parse(readFileSync(join(runtime,'quota-reserve-state.json'),'utf8')).accounts[oauth.id]
  assert.equal(updated.hourlyRemainingPercent,5)
  await f.service.stop()
})

test('pool strategy changes select actual upstream accounts, ignore review quota, and pin one account without fallback',{timeout:40000},async t=>{
  const f=fixture(t),received:string[]=[],fail=new Set<string>()
  const upstream=createServer(async(req,res)=>{
    for await(const _chunk of req){}
    const key=req.headers.authorization!;received.push(key)
    res.setHeader('Content-Type','application/json')
    res.statusCode=fail.has(key)?503:200
    res.end(res.statusCode===503?'{"error":{"message":"fixture offline"}}':'{"id":"fixture-routing","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))})
  const a=f.add('a',`http://127.0.0.1:${address.port}/v1`),b=f.add('b',a.baseUrl),c=f.add('c',a.baseUrl)
  const port=await freePort()
  f.store.transaction(state=>{
    state.settings.port=port
    for(const [i,plan,used] of [[0,'plus',10],[1,'pro',80],[2,'free',30]] as const){
      state.accounts[i].plan=plan
      state.accounts[i].quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'短周期',usedPercent:used},{id:'review.primary_window',name:'代码审查',usedPercent:100}]}
    }
  })
  f.savePool([a.id,b.id,c.id],{sessionAffinity:false})
  const key=f.key('Strategy'),scoped=f.key('Fixed scope',{inheritAccountPool:false,accountIds:[c.id,b.id]})
  const call=async(id=key.id,model='fixture-common')=>{
    const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(id)}`,'Content-Type':'application/json'},body:JSON.stringify({model,input:'routing fixture'}),signal:AbortSignal.timeout(5000)})
    await response.text();return response.status
  }
  for(const [strategy,want] of [['auto','b'],['plan_high_first','b'],['plan_low_first','c'],['quota_high_first','a'],['quota_low_first','b'],['single_account','a']] as const){
    f.savePool([a.id,b.id,c.id],{routingStrategy:strategy,sessionAffinity:false})
    f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)
    const start=received.length
    for(let i=0;i<3;i++)assert.equal(await call(),200)
    assert.deepEqual(received.slice(start),Array(3).fill(`Bearer fixture-upstream-${want}`),strategy)
    if(strategy==='single_account'){
      assert.deepEqual(f.service.view().keys.find(value=>value.id===key.id)!.effectiveAccountIds,[a.id])
      assert.deepEqual(f.service.view().keys.find(value=>value.id===scoped.id)!.effectiveAccountIds,[c.id])
      assert.equal(await call(scoped.id),200);assert.equal(received.at(-1),'Bearer fixture-upstream-c')
      const beforeDenied=received.length
      assert.equal(await call(scoped.id,'fixture-b'),404);assert.equal(received.length,beforeDenied)
      fail.add('Bearer fixture-upstream-a')
      const beforeFailure=received.length
      assert.equal(await call(),503)
      assert.deepEqual(received.slice(beforeFailure),['Bearer fixture-upstream-a'],'Single account mode must not fall back to another account')
    }
    await f.service.stop()
  }
})

test('local key mutations persist encrypted secrets, reject stale or widening scopes, and expose unknown usage without breaking snapshots',async t=>{
  const f=fixture(t),a=f.add('a'),b=f.add('b')
  f.savePool([a.id,b.id])
  const k=f.key('Restricted',{inheritAccountPool:false,accountIds:[a.id]})
  const secret=f.service.key(k.id)
  assert.equal(JSON.stringify(f.service.view()).includes(secret),false)
  assert.equal(readFileSync(join(f.store.directory,'state.vault')).includes(secret),false)
  assert.equal(new Store(f.store.directory,f.codec).read().localAccess!.keys[0].key,secret)
  assert.throws(()=>f.savePool([b.id]),/独立范围引用/)
  assert.throws(()=>f.savePool([a.id,a.id]),/重复/)
  assert.throws(()=>f.key('Outside',{inheritAccountPool:false,accountIds:[randomUUID()]}),/池内/)
  assert.throws(()=>f.key('Empty',{inheritAccountPool:false}),/至少/)
  assert.throws(()=>f.key('restricted'),/已存在/)
  assert.throws(()=>f.key('Wrong priority',{inheritAccountPool:false,accountIds:[a.id],priorityAccountIds:[b.id]}),/账号范围内/)
  assert.throws(()=>f.key('Duplicate priority',{priorityAccountIds:[a.id,a.id]}),/重复/)
  const priorityKey=f.key('Priority',{priorityAccountIds:[b.id]})
  assert.throws(()=>f.savePool([a.id]),/优先顺序引用/)
  f.service.mutate({action:'deleteKey',id:priorityKey.id,revision:priorityKey.revision})
  assert.throws(()=>f.savePool([a.id,b.id],{customRoutingRules:[{accountId:a.id,priority:101,weight:1,isBackup:false,isPreferred:false}]}))
  assert.throws(()=>f.savePool([a.id,b.id],{customRoutingRules:[{accountId:a.id,priority:0,weight:1,isBackup:true,isPreferred:true}]}),/同时/)
  assert.throws(()=>f.savePool([a.id,b.id],{customRoutingRules:[{accountId:randomUUID(),priority:0,weight:1,isBackup:false,isPreferred:false}]}),/账号池内/)
  f.service.mutate({action:'rotateKey',id:k.id,revision:k.revision})
  assert.notEqual(f.service.key(k.id),secret)
  assert.throws(()=>f.service.mutate({action:'deleteKey',id:k.id,revision:k.revision}),/已变化/)
  const failedUsage=new LocalAccess(f.store,f.gateway,async()=>a,()=>{throw new Error('storage failure')})
  assert.equal(failedUsage.view().keys[0].tokenUsed,null)
  assert.match(failedUsage.view().error!,/未知/)
  failedUsage.start();await failedUsage.settled()
  assert.equal(f.gateway.current().running,false)
  assert.match(failedUsage.view().error!,/storage failure/)
  f.service.mutate({action:'deleteKey',id:k.id,revision:f.service.view().keys[0].revision})
  assert.throws(()=>f.service.key(k.id),/不存在/)
})

test('pool startup is cancellable, protects referenced accounts, and rejects changed configuration',async t=>{
  const f=fixture(t),a=f.add('a');f.savePool([a.id]);f.key('Caller')
  let finish!:()=>void
  const service=new LocalAccess(f.store,f.gateway,async()=>{await new Promise<void>(resolve=>{finish=resolve});return a},()=>({}))
  service.start()
  assert.equal(service.view().starting,true);assert.equal(service.usesAccount(a.id),true)
  assert.throws(()=>service.start(),/已有/)
  assert.throws(()=>service.mutate({action:'deleteKey',id:f.service.view().keys[0].id,revision:0}),/先停止/)
  assert.throws(()=>deleteAccounts(f.store,[a.id],id=>service.usesAccount(id)),/运行|使用|停止/)
  const stopped=service.stop();finish();await stopped
  assert.equal(service.view().starting,false);assert.equal(service.usesAccount(a.id),false)
  service.start();f.store.transaction(state=>{state.accounts[0].defaultTier='standard'});finish();await service.settled()
  assert.match(service.view().error!,/已变化/);assert.equal(f.gateway.current().running,false)
  const single=service.startSingle(a.id)
  const cancelled=assert.rejects(single,/abort|取消/i)
  assert.equal(service.view().singleStarting,true)
  assert.throws(()=>service.start(),/已有/)
  assert.equal(service.usesAccount(a.id),true)
  const stopping=service.stop();finish();await stopping;await cancelled
  assert.equal(service.view().singleStarting,false)
  assert.equal(f.gateway.current().running,false)
})

test('custom pool weights, ordered key priorities, preferred and backup layers select real upstream accounts',{timeout:40000},async t=>{
  const f=fixture(t),received:string[]=[],fail=new Set<string>()
  const upstream=createServer(async(req,res)=>{for await(const _chunk of req){};const key=req.headers.authorization!;received.push(key);res.statusCode=fail.has(key)?503:200;res.setHeader('Content-Type','application/json');res.end(res.statusCode===503?'{"error":{"message":"fixture unavailable"}}':'{"id":"fixture-policy","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))})
  const a=f.add('a',`http://127.0.0.1:${address.port}/v1`),b=f.add('b',a.baseUrl),c=f.add('c',a.baseUrl),port=await freePort()
  f.store.transaction(state=>{state.settings.port=port;state.accounts[0].source={subscription_active_until:'2040-01-01T00:00:00Z'};state.accounts[1].source={subscription_active_until:'2030-01-01T00:00:00Z'}})
  f.savePool([a.id,b.id,c.id],{sessionAffinity:false})
  const ordinary=f.key('Weighted'),priority=f.key('Ordered',{priorityAccountIds:[a.id,b.id]})
  const rule=(accountId:string,priority=0,weight=1,extra={})=>({accountId,priority,weight,isBackup:false,isPreferred:false,...extra})
  const start=async(strategy:string,rules:unknown[])=>{await f.service.stop();f.savePool([a.id,b.id,c.id],{routingStrategy:strategy,customRoutingRules:rules,sessionAffinity:false});f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error);received.length=0}
  const call=async(key=ordinary)=>{const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(key.id)}`,'Content-Type':'application/json'},body:'{"model":"fixture-common","input":"policy"}',signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,await response.text())}
  await start('custom',[rule(a.id,10,1),rule(b.id,10,3),rule(c.id,100,100,{isBackup:true})])
  for(let i=0;i<8;i++)await call()
  assert.equal(received.filter(key=>key==='Bearer fixture-upstream-a').length,2)
  assert.equal(received.filter(key=>key==='Bearer fixture-upstream-b').length,6)
  assert.equal(received.includes('Bearer fixture-upstream-c'),false)
  received.length=0;await call(priority);assert.deepEqual(received,['Bearer fixture-upstream-a'])
  fail.add('Bearer fixture-upstream-a');received.length=0;await call(priority);assert.deepEqual(received,['Bearer fixture-upstream-a','Bearer fixture-upstream-b'])
  fail.add('Bearer fixture-upstream-b');received.length=0;await call(priority);assert.deepEqual(received,['Bearer fixture-upstream-a','Bearer fixture-upstream-b','Bearer fixture-upstream-c'])
  fail.clear()
  await start('auto',[rule(a.id),rule(b.id),rule(c.id,0,1,{isPreferred:true})])
  await call(priority);assert.deepEqual(received,['Bearer fixture-upstream-c'],'Global preferred layer precedes key preference within the normal layer')
  await start('custom',[rule(a.id,1),rule(b.id,10),rule(c.id,5)])
  for(let i=0;i<3;i++)await call()
  assert.deepEqual(received,Array(3).fill('Bearer fixture-upstream-b'))
  await start('expiry_soon_first',[]);await call();assert.deepEqual(received,['Bearer fixture-upstream-b'])
  const reopened=new Store(f.store.directory,f.codec)
  assert.deepEqual(reopened.read().localAccess!.keys.find(key=>key.id===priority.id)!.priorityAccountIds,[a.id,b.id])
  assert.equal(f.service.view().accountInfo?.find(account=>account.id===b.id)?.expiresAt,Date.parse('2030-01-01T00:00:00Z'))
})

test('quota and plan updates reorder live requests without restarting or changing account Fast defaults',{timeout:15000},async t=>{
  const f=fixture(t),received:{key:string;tier:string}[]=[]
  const upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push({key:req.headers.authorization!,tier:JSON.parse(raw).service_tier});res.setHeader('Content-Type','application/json');res.end('{"id":"fixture-live-quota","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))})
  const a=f.add('a',`http://127.0.0.1:${address.port}/v1`),b=f.add('b',a.baseUrl,'standard'),port=await freePort()
  f.store.transaction(state=>{state.settings.port=port;for(const [index,used] of [[0,90],[1,20]])state.accounts[index].quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'主窗口',usedPercent:used}]}})
  f.savePool([a.id,b.id],{routingStrategy:'quota_high_first',sessionAffinity:false});const key=f.key('Dynamic')
  const start=f.gateway.start.bind(f.gateway)
  f.gateway.start=(...args)=>{
    const pending=start(...args)
    // Refresh arrives after the manifest was captured, before ready. Startup
    // must catch up from the vault even though no running gateway observed it.
    f.store.transaction(state=>{state.accounts[1].quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'主窗口',usedPercent:10}]}})
    return pending
  }
  f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)
  const directory=f.gateway.runtimeDirectory()!,stateFile=join(directory,'quota-pool-state.json')
  assert.equal(JSON.parse(readFileSync(stateFile,'utf8')).accounts[b.id].remainingQuota,90)
  const call=async()=>{const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(key.id)}`,'Content-Type':'application/json'},body:'{"model":"fixture-common","input":"dynamic"}',signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,await response.text());return received.at(-1)!}
  assert.deepEqual(await call(),{key:'Bearer fixture-upstream-b',tier:'default'})
  f.store.transaction(state=>{state.accounts[0].quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'主窗口',usedPercent:0}]};state.accounts[0].defaultTier='standard'})
  const current=f.store.read().accounts[0]
  // A failed projection must remain visible and be retryable without losing
  // the account observation already saved in the encrypted authority.
  renameSync(directory,directory+'.fixture-held')
  try{assert.throws(()=>f.gateway.updateRoutingAccount(current),/同步到本地服务失败/);assert.match(f.gateway.current().quotaSyncError!,/同步/)}finally{renameSync(directory+'.fixture-held',directory)}
  f.store.transaction(state=>{state.accounts[1].quota={updatedAt:Date.now(),windows:[{id:'main.primary_window',name:'主窗口',usedPercent:25}]}})
  f.gateway.updateRoutingAccount(f.store.read().accounts[1])
  assert.match(f.gateway.current().quotaSyncError!,/同步/,'Another account succeeding must not hide the failed account projection')
  assert.equal(JSON.parse(readFileSync(stateFile,'utf8')).accounts[a.id].remainingQuota,10)
  f.gateway.updateRoutingAccount(current);assert.equal(f.gateway.current().quotaSyncError,undefined)
  const end=Date.now()+5000
  while((await call()).key!=='Bearer fixture-upstream-a'){if(Date.now()>end)assert.fail('Live quota was not applied');await delay(80)}
  assert.equal(received.at(-1)!.tier,'priority','Updating quota must not apply an unsaved/restart-required Fast default')
  assert.equal(f.gateway.runtimeDirectory(),directory)
  assert.equal(statSync(stateFile).mode&0o777,0o600)
  const raw=readFileSync(stateFile,'utf8');assert.equal(raw.includes(a.credentials.apiKey!),false);assert.equal(raw.includes('localAPIKey'),false)
})

test('real pool enforces account/model scopes, preserves per-account Fast defaults and restores token limits across key rotation and restart',{timeout:40000},async t=>{
  const f=fixture(t),received:{key:string|undefined;body:Record<string,unknown>}[]=[]
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    received.push({key:req.headers.authorization,body:JSON.parse(raw)})
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({id:'fixture-response',object:'response',status:'completed',service_tier:'default',output:[],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))})
  const a=f.add('a',`http://127.0.0.1:${address.port}/v1`),b=f.add('b',a.baseUrl,'standard'),c=f.add('c',a.baseUrl,'follow')
  const port=await freePort();f.store.transaction(s=>{s.settings.port=port;s.settings.defaultTier='fast'})
  f.savePool([a.id,b.id,c.id],{sessionAffinity:false})
  const keyA=f.key('Fast',{inheritAccountPool:false,accountIds:[a.id],modelPrefix:'work',allowedModels:['fixture-*'],excludedModels:['fixture-secret']})
  const keyB=f.key('Standard',{inheritAccountPool:false,accountIds:[b.id]}),keyC=f.key('Follow',{inheritAccountPool:false,accountIds:[c.id]})
  const limited=f.key('Limited',{inheritAccountPool:false,accountIds:[a.id],tokenLimit:5}),disabled=f.key('Disabled',{enabled:false})
  const mixed=f.key('Pool')
  f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)
  const url=`http://127.0.0.1:${f.service.view().port}`
  const call=(key:string,model='fixture-common',tier?:unknown,headers:Record<string,string>={})=>fetch(url+'/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...headers},body:JSON.stringify({model,input:'模型范围 🧪\n测试',service_tier:tier}),signal:AbortSignal.timeout(5000)})
  for(const [key,want,account,model,tier] of [[keyA,'priority',a,'work/fixture-a',undefined],[keyA,'default',a,'work/fixture-common','default'],[keyB,'default',b,'fixture-common',undefined],[keyB,'priority',b,'fixture-common','priority'],[keyC,undefined,c,'fixture-common',undefined],[keyA,'flex',a,'work/fixture-common','flex']] as const){
    const previous=f.events.filter(e=>e.type==='usage').length
    const response=await call(f.service.key(key.id),model,tier,{'X-Cockpit-Target-Account-Id':b.id});assert.equal(response.status,200,await response.text())
    assert.equal(received.at(-1)!.key,`Bearer ${account.credentials.apiKey}`);assert.equal(received.at(-1)!.body.service_tier,want)
    await wait(()=>f.events.filter(e=>e.type==='usage').length>previous)
    const event=f.events.filter(e=>e.type==='usage').at(-1)!
    assert.equal(event.accountId,account.id);assert.equal(event.apiKeyId,key.id);assert.equal(event.apiKeyLabel,key.label)
    assert.equal(event.inboundServiceTier,tier??'');assert.equal(event.outboundServiceTier,want??'')
    assert.equal(event.tierSource,tier?'request':want?'account':'follow')
  }
  const before=received.length
  for(const [key,model] of [[f.service.key(keyA.id),'work/fixture-b'],[f.service.key(keyA.id),'work/fixture-secret'],[f.service.key(keyA.id),'outside-model'],[f.service.key(keyA.id),'codex-auto-review'],['wrong-key','fixture-common'],[f.service.key(disabled.id),'fixture-common']]){
    const response=await call(key,model);assert.ok(response.status>=400,await response.text())
  }
  assert.equal(received.length,before)
  for(const path of ['/v1/images/generations','/v1/chat/completions']){
    const response=await fetch(url+path,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(keyA.id)}`,'Content-Type':'application/json'},body:JSON.stringify({model:'work/fixture-secret',prompt:'denied',messages:[{role:'user',content:'denied'}]})})
    assert.equal(response.status,404,await response.text())
  }
  assert.equal(received.length,before)
  const models=await fetch(url+'/v1/models',{headers:{Authorization:`Bearer ${f.service.key(keyA.id)}`}})
  assert.equal(models.status,200);assert.deepEqual((await models.json()).data.map((m:{id:string})=>m.id).sort(),['work/fixture-a','work/fixture-common'])
  const management=await fetch(url+'/v1/cockpit/auth/reload',{method:'POST',headers:{Authorization:`Bearer ${f.service.key(keyA.id)}`,'Content-Type':'application/json'},body:JSON.stringify({accountIds:[b.id]})})
  assert.equal(management.status,403);await management.text()
  const invalid=await call(f.service.key(keyA.id),'work/fixture-common',42);assert.equal(invalid.status,400);await invalid.text()
  for(let i=0;i<9;i++){const response=await call(f.service.key(mixed.id));assert.equal(response.status,200,await response.text())}
  assert.equal(new Set(received.slice(-9).map(value=>value.key)).size,3,'Pool must schedule all eligible accounts')
  const first=await call(f.service.key(limited.id));assert.equal(first.status,200,await first.text())
  await wait(()=>f.history.keyTokenUsage([limited.id])[limited.id]===5)
  const exhausted=await call(f.service.key(limited.id));assert.equal(exhausted.status,429);assert.match(await exhausted.text(),/token_limit_exceeded/)
  await f.service.stop()
  assert.deepEqual(readdirSync(join(f.root,'runtime')),[])
  const oldKey=f.service.key(limited.id)
  f.service.mutate({action:'rotateKey',id:limited.id,revision:limited.revision})
  const reopenedHistory=new History(f.root),reopenedStore=new Store(f.store.directory,f.codec)
  try{
    const restarted=new LocalAccess(reopenedStore,f.gateway,async id=>reopenedStore.read().accounts.find(a=>a.id===id)!,ids=>reopenedHistory.keyTokenUsage(ids))
    assert.equal(restarted.view().keys.find(k=>k.id===limited.id)!.tokenUsed,5)
    restarted.start();await restarted.settled();assert.equal(restarted.view().running,true,restarted.view().error)
    const old=await call(oldKey);assert.equal(old.status,401);await old.text()
    const limitedAgain=await call(restarted.key(limited.id));assert.equal(limitedAgain.status,429);await limitedAgain.text()
    await restarted.stop()
  }finally{reopenedHistory.close()}
})

test('pool preserves affinity, changes defaults on pre-output fallback, and never replays emitted or cancelled SSE',{timeout:40000},async t=>{
  const f=fixture(t),received:{key:string|undefined;tier:unknown}[]=[]
  let mode:'success'|'fallback'|'broken-stream'|'cancel'='success',closed=0
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw),key=req.headers.authorization
    received.push({key,tier:body.service_tier})
    if(mode==='fallback'&&key==='Bearer fixture-upstream-a'){res.statusCode=503;res.end('{"error":{"message":"fixture offline"}}');return}
    if(mode==='broken-stream'||mode==='cancel'){
      res.once('close',()=>{closed++})
      res.setHeader('Content-Type','text/event-stream');res.flushHeaders()
      const chunk=Buffer.from('data: {"type":"response.output_text.delta","delta":"中文🧪"}\n\n'),split=chunk.indexOf(Buffer.from('🧪'))+2
      res.write(chunk.subarray(0,split));await delay(5);res.write(chunk.subarray(split))
      if(mode==='broken-stream'){await delay(30);res.destroy()}
      return
    }
    res.setHeader('Content-Type','application/json');res.end('{"id":"fixture-ok","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}')
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))})
  const a=f.add('a',`http://127.0.0.1:${address.port}/v1`),b=f.add('b',a.baseUrl,'standard')
  const port=await freePort();f.store.transaction(s=>{s.settings.port=port;s.settings.defaultTier='follow';s.accounts[0].plan='plus';s.accounts[1].plan='free'})
  f.savePool([a.id,b.id],{sessionAffinity:true});const key=f.key('Affinity')
  const start=async()=>{f.service.start();await f.service.settled();assert.equal(f.service.view().running,true,f.service.view().error)}
  const call=(signal?:AbortSignal)=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${f.service.key(key.id)}`,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-common',input:'turn 🧪',prompt_cache_key:'fixture-conversation',stream:mode==='broken-stream'||mode==='cancel'}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)})
  await start();
  for(let i=0;i<6;i++){const response=await call();assert.equal(response.status,200,await response.text())}
  assert.equal(new Set(received.map(value=>value.key)).size,1,'Same session must keep the selected provider')
  ;await f.service.stop();f.savePool([a.id,b.id],{sessionAffinity:false,routingStrategy:'plan_high_first'})
  mode='fallback';received.length=0;await start();
  const success=await call();assert.equal(success.status,200,await success.text())
  assert.deepEqual(received,[{key:'Bearer fixture-upstream-a',tier:'priority'},{key:'Bearer fixture-upstream-b',tier:'default'}])
  ;await f.service.stop();mode='broken-stream';received.length=0;await start()
  ;const broken=await call();assert.equal(broken.status,200)
  const reader=broken.body!.getReader(),decoder=new TextDecoder();let output='',failed=false
  try{while(true){const item=await reader.read();if(item.done)break;output+=decoder.decode(item.value,{stream:true})}}catch{failed=true}
  assert.ok(failed||!output.includes('response.completed'))
  assert.ok(output.includes('中文🧪'),output);assert.equal(received.length,1);assert.equal(received[0].key,'Bearer fixture-upstream-a')
  ;await f.service.stop();mode='cancel';received.length=0;await start()
  ;const beforeClosed=closed,controller=new AbortController(),response=await call(controller.signal),stream=response.body!.getReader()
  assert.equal((await stream.read()).done,false);controller.abort()
  await wait(()=>closed>beforeClosed);assert.equal(received.length,1)
  ;await Promise.all([f.service.stop(),f.service.stop()])
  assert.deepEqual(readdirSync(join(f.root,'runtime')),[])
})
