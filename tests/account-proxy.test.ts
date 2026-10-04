import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type Server} from 'node:http'
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {Store,type StoredAccount} from '../src/main/store'
import {parseAccountImport,deleteAccounts} from '../src/main/accounts'
import {serializeAccounts} from '../src/main/accountFiles'
import {AccountProxies} from '../src/main/accountProxy'
import {AccountNetwork} from '../src/main/accountNetwork'
import {normalizeProxy,accountProxyURL} from '../src/main/proxyPolicy'
import {TokenAuthority} from '../src/main/tokens'
import {QuotaService} from '../src/main/quota'
import {HTTPError,type JSONRequest} from '../src/main/network'
import {Gateway} from '../src/main/gateway'
import {settingsSchema} from '../src/shared/types'
import {authFor} from '../src/main/nativeAccountProjection'
import {AccountRecycle} from '../src/main/accountRecycle'
import {LocalAccess} from '../src/main/localAccess'
import {emptyLocalAccess} from '../src/shared/localAccess'

const binary=resolve('resources/bin/codex-proxy')
const fixture=(t:{after(fn:()=>void|Promise<void>):void})=>{
 const root=mkdtempSync(join(tmpdir(),'cml-proxy-')),codec={encrypt:(raw:string)=>Buffer.from(raw),decrypt:(raw:Buffer)=>raw.toString()},store=new Store(root,codec)
 const account=parseAccountImport('at-fixture-proxy').accounts[0];store.transaction(state=>{state.accounts.push(account);state.settings.refreshMinutes=0})
 const network=new AccountNetwork(binary);t.after(async()=>{await network.stop();rmSync(root,{recursive:true,force:true})})
 return {root,store,account,network,codec}
}
async function listen(t:{after(fn:()=>void|Promise<void>):void},server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');t.after(()=>{server.closeAllConnections();server.close()});return `http://127.0.0.1:${address.port}`}
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'wait timeout');await delay(5)}}

test('proxy validation, account scope, secret-free snapshots, rollback and recycle restoration',async t=>{
 const f=fixture(t);let busy=false,fail=false
 const service=new AccountProxies(f.store,f.network,()=>busy),id=f.account.id
 assert.equal(normalizeProxy(' http://fixture:p%40ss@[::1]:8080/#label '),'http://fixture:p%40ss@[::1]:8080/')
 for(const raw of ['file:///secret','http://proxy:0','socks5://host','http://proxy/path','http://proxy?q=secret','http://fixture:pa\nss@host','http://fixture:%0a@host','http://fixture:%ff@host','http://host\\x','http://host:65536'])assert.throws(()=>normalizeProxy(raw),error=>!String(error).includes(raw))
 service.save({accountId:id,revision:0,mode:'custom',url:'http://fixture:proxy-secret@127.0.0.1:9876'})
 const account=f.store.read().accounts[0];assert.equal(accountProxyURL(account),'http://fixture:proxy-secret@127.0.0.1:9876/')
 const snapshot=JSON.stringify(f.store.snapshot());assert.equal(snapshot.includes('proxy-secret'),false);assert.equal(snapshot.includes('fixture:'),false);assert.equal(f.store.snapshot().accounts[0].egressProxy?.authenticated,true)
 assert.equal(serializeAccounts([account]).includes('proxy-secret'),false)
 assert.equal(new Store(f.root,f.codec).read().accounts[0].proxy?.url,account.proxy?.url)
 assert.throws(()=>service.save({accountId:id,revision:0,mode:'direct'}),/变化/)
 busy=true;assert.throws(()=>service.save({accountId:id,revision:1,mode:'direct'}),/正在使用/);busy=false
 service.save({accountId:id,revision:1,mode:'custom'});assert.equal(f.store.read().accounts[0].proxy?.url,account.proxy?.url)
 assert.throws(()=>authFor(f.store.read().accounts[0],null),/本地 API/)
 const guarded=new Store(f.root,{...f.codec,encrypt:raw=>{if(fail)throw new Error('fixture save error');return f.codec.encrypt(raw)}})
 fail=true;assert.throws(()=>new AccountProxies(guarded,f.network).save({accountId:id,revision:2,mode:'direct'}),/save error/)
 assert.deepEqual(guarded.read(),JSON.parse(JSON.stringify(f.store.read())))
 deleteAccounts(f.store,[id]);const recycle=new AccountRecycle(f.store),list=recycle.list(),preview=recycle.preview({snapshotId:list.snapshotId,all:true,action:'restore'})
 await recycle.apply({ticket:preview.ticket,confirmed:true},async()=>undefined)
 assert.equal(f.store.read().accounts[0].proxy?.url,account.proxy?.url)
 const restored=f.store.read().accounts[0];service.save({accountId:id,revision:restored.revision!,mode:'direct'});assert.equal(accountProxyURL(f.store.read().accounts[0]),'direct')
 service.save({accountId:id,revision:restored.revision!+1,mode:'inherit'});assert.equal(accountProxyURL(f.store.read().accounts[0]),undefined)
 for(const kind of ['api_key','agent_identity'] as const){f.store.transaction(state=>{state.accounts[0].kind=kind});service.save({accountId:id,revision:f.store.read().accounts[0].revision!,mode:'direct'});assert.equal(accountProxyURL(f.store.read().accounts[0]),'direct');assert.equal(accountProxyURL({...account,kind}),account.proxy?.url)}
})

test('source-built helper routes token rotation and usage through the authenticated proxy with no target credential leakage',async t=>{
 const f=fixture(t),requests:{url:string;auth:string|undefined;proxy:string|undefined}[]=[],proxies:string[]=[]
 const jwt=(suffix:string)=>'fixture.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200,suffix,email:'proxy@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'fixture-workspace'}})).toString('base64url')+'.signature'
 const target=await listen(t,createServer(async(req,res)=>{for await(const _ of req){};requests.push({url:req.url!,auth:req.headers.authorization,proxy:req.headers['proxy-authorization'] as string|undefined});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/token'?{access_token:jwt('new'),id_token:jwt('id'),refresh_token:'rotated-fixture'}:req.url==='/subscription'?{accounts:[{account:{id:'fixture-workspace'},entitlement:{subscription_plan:'plus',expires_at:Date.now()+30*86400000}}]}:{plan_type:'plus',rate_limit:{primary_window:{used_percent:20,limit_window_seconds:18000}}}))}))
 const proxy=await listen(t,createServer(async(req,res)=>{
  proxies.push(req.url!);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:proxy-secret').toString('base64'))
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
  const response=await fetch(req.url!,{method:req.method,headers:{Authorization:req.headers.authorization??'','Content-Type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status);res.end(await response.text())
 }))
 f.store.transaction(state=>{const account=state.accounts[0];account.credentials.refreshToken='refresh-fixture';account.credentials.accountId='fixture-workspace';account.proxy={mode:'custom',url:proxy.replace('://','://fixture:proxy-secret@')}})
 const request:JSONRequest=(url,init,operation,account)=>f.network.request(target+(url.includes('/oauth/token')?'/token':url.includes('/accounts/check/')?'/subscription':'/usage'),init,operation,account)
 const tokens=new TokenAuthority(f.store,request),quota=new QuotaService(f.store,tokens,request)
 t.after(async()=>{await quota.stop();await tokens.stop()})
 quota.start([f.account.id]);await quota.settled();await quota.subscriptionsSettled()
 assert.equal(quota.current().failed,0);assert.equal(proxies.length,3);assert.deepEqual(requests.map(value=>value.url),['/token','/usage','/subscription']);assert.equal(requests[1].auth,'Bearer '+f.store.read().accounts[0].credentials.accessToken);assert.ok(requests.every(value=>value.proxy===undefined));assert.ok(f.store.snapshot().accounts[0].subscriptionActiveUntil)
 assert.equal(f.store.read().accounts[0].credentials.refreshToken,'rotated-fixture');assert.equal(f.store.read().accounts[0].quota?.windows[0].usedPercent,20)
 const before=proxies.length;await f.network.request(target+'/usage',{},'fixture',{...f.store.read().accounts[0],kind:'api_key'});assert.equal(proxies.length,before+1,'an API account with an explicit proxy retains its selected exit')
})

test('proxy helper does not follow redirects or fall back after refusal; HTTP errors stay classified and cancellation stops the child',async t=>{
 const f=fixture(t);let targetHits=0,waiting=false,disconnected=false
 const target=await listen(t,createServer((_req,res)=>{targetHits++;res.end('{}')}))
 const proxy=await listen(t,createServer((req,res)=>{
  if(req.url?.endsWith('/wait')){waiting=true;req.on('close',()=>{disconnected=true});return}
  if(req.url?.endsWith('/redirect')){res.writeHead(302,{Location:target});res.end();return}
  res.writeHead(401);res.end('{"error":"invalid_task_id","secret":"fixture-error-secret"}')
 }))
 await assert.rejects(f.network.through(proxy)(target+'/error'),error=>error instanceof HTTPError&&error.status===401&&error.code==='agent_task_invalid'&&!String(error).includes('secret'))
 await assert.rejects(f.network.through(proxy)(target+'/redirect'),error=>error instanceof HTTPError&&error.status===302)
 await assert.rejects(f.network.through('http://fixture:proxy-secret@127.0.0.1:1')(target),error=>!String(error).includes('proxy-secret'))
 assert.equal(targetHits,0)
 const controller=new AbortController(),pending=f.network.through(proxy)(target+'/wait',{signal:controller.signal});await until(()=>waiting);controller.abort();await assert.rejects(pending,/取消/);await until(()=>disconnected)
 assert.equal(targetHits,0)
})

test('proxy helper preserves challenge metadata for diagnosis while excluding upstream secrets',async t=>{
 const f=fixture(t)
 const target=await listen(t,createServer((_req,res)=>{
  res.writeHead(403,{'Content-Type':'text/html','Cf-Mitigated':'challenge','Set-Cookie':'fixture-private-cookie','X-Private':'fixture-private-header'})
  res.end('<html>verification required</html>')
 }))
 const account={...f.account,proxy:{mode:'direct' as const}}
 const response=await f.network.fetchUpstream(target,{},account)
 assert.equal(response.headers.get('cf-mitigated'),'challenge')
 assert.equal(response.headers.get('content-type'),'text/html')
 assert.equal(response.headers.get('set-cookie'),null)
 assert.equal(response.headers.get('x-private'),null)
 await response.body?.cancel()
 await assert.rejects(f.network.request(target,{},'查询订阅账号信息',account),error=>error instanceof HTTPError&&error.status===403&&error.diagnostic==='cloudflare_challenge'&&!String(error).includes('fixture-private'))
})

test('token-free egress probe supports saved/draft/direct, cancellation, account revisions and save exclusion',async t=>{
 const f=fixture(t);let tokensSeen=false,waiting=false,hits=0
 const target=await listen(t,createServer((req,res)=>{tokensSeen||=!!req.headers.authorization;res.end('{"ip":"203.0.113.42"}')}))
 const proxy=await listen(t,createServer((req,res)=>{hits++;tokensSeen||=!!req.headers.authorization;if(req.url?.includes('wait')){waiting=true;return}res.end('{"ip":"2001:db8::1"}')}))
 const service=new AccountProxies(f.store,f.network,()=>false,target),id=f.account.id
 const input={accountId:id,revision:0,requestId:randomUUID(),mode:'custom' as const,url:proxy}
 const cancelledId=randomUUID();await service.cancel(cancelledId)
 assert.throws(()=>service.probe({...input,requestId:cancelledId}),/取消/);assert.equal(hits,0)
 assert.equal((await service.probe(input)).ip,'2001:db8::1');assert.equal(f.store.read().accounts[0].proxy,undefined)
 service.save({accountId:id,revision:0,mode:'custom',url:proxy})
 assert.equal((await service.probe({accountId:id,revision:1,requestId:randomUUID(),mode:'saved'})).ip,'2001:db8::1')
 assert.equal((await service.probe({accountId:id,revision:1,requestId:randomUUID(),mode:'direct'})).ip,'203.0.113.42');assert.equal(tokensSeen,false)
 const delayed=new AccountProxies(f.store,f.network,()=>false,target+'/wait'),requestId=randomUUID(),pending=delayed.probe({accountId:id,revision:1,requestId,mode:'saved'})
 const rejection=assert.rejects(pending,/取消/);await until(()=>waiting)
 assert.throws(()=>delayed.save({accountId:id,revision:1,mode:'direct'}),/正在使用/)
 await delayed.cancel(requestId);await rejection;assert.equal(delayed.busy(id),false);await delayed.stop()
})

test('real sidecar startup projects each account proxy, rejects invalid configuration and preserves no-proxy accounts',async t=>{
 const f=fixture(t),gateway=new Gateway(binary,join(f.root,'runtime'));t.after(()=>gateway.stop())
 for(const proxy of [{mode:'custom' as const,url:'http://fixture:proxy-secret@127.0.0.1:9'}, {mode:'direct' as const},undefined]){
  const account={...f.account,proxy};await gateway.start({id:account.id,port:0,account,apiKey:'fixture-client'},settingsSchema.parse({}))
  const raw=JSON.parse(readFileSync(join(gateway.runtimeDirectory()!,'auth',account.id+'.json'),'utf8'))
  assert.equal(raw.proxy_url,proxy?.mode==='direct'?'direct':proxy?.url?normalizeProxy(proxy.url):undefined)
  assert.equal(JSON.stringify(gateway.current()).includes('proxy-secret'),false);await gateway.stop()
 }
 await assert.rejects(gateway.start({id:f.account.id,port:0,account:{...f.account,proxy:{mode:'custom',url:'bad://fixture-secret'}},apiKey:'fixture-client'},settingsSchema.parse({})),/代理地址无效/)
 assert.deepEqual(readdirSync(join(f.root,'runtime')),[])
})

test('a proxy change during pool preparation prevents startup with a stale route',async t=>{
 const f=fixture(t),gateway=new Gateway(binary,join(f.root,'runtime'))
 let release!:()=>void
 const ready=new Promise<void>(resolve=>{release=resolve})
 const service=new LocalAccess(f.store,gateway,async()=>{await ready;return f.store.read().accounts[0]},()=>({}))
 t.after(()=>service.stop())
 const {revision:_revision,keys:_keys,...settings}=emptyLocalAccess()
 service.mutate({action:'savePool',revision:0,settings:{...settings,accountIds:[f.account.id]}})
 service.mutate({action:'createKey',details:{label:'Fixture',enabled:true,inheritAccountPool:true,accountIds:[],modelPrefix:'',allowedModels:[],excludedModels:[],tokenLimit:0}})
 service.start();assert.equal(service.usesAccount(f.account.id),true)
 // A late external writer must invalidate preparation even if it bypasses IPC.
 f.store.transaction(state=>{state.accounts[0].proxy={mode:'direct'}})
 release();await service.settled()
 assert.equal(service.view().running,false);assert.match(service.view().error!,/变化/)
 assert.equal(gateway.runtimeDirectory(),undefined)
})
