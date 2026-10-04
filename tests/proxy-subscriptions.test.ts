import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {gzipSync} from 'node:zlib'
import {Agent,fetch} from 'undici'
import {setTimeout as delay} from 'node:timers/promises'
import {Store} from '../src/main/store'
import {ProxyCatalog} from '../src/main/proxyCatalog'
import {ProxySubscriptions} from '../src/main/proxySubscriptions'
import {ProxyResources} from '../src/main/proxyResources'
import {downloadSubscription,subscriptionURL,subscriptionTitle,subscriptionUsage,SubscriptionError,type SubscriptionDownload} from '../src/main/proxySubscriptionDownload'
import {accountProxyURL} from '../src/main/proxyPolicy'
import {decodeCatalogBinding} from '../src/main/proxyCatalogBinding'
import {parseAccountImport} from '../src/main/accounts'

const data=(server='old.invalid',extra:Record<string,unknown>={})=>JSON.stringify({proxies:[{name:'Alpha',type:'http',server,port:8080,password:'fixture-node-secret',...extra}],'proxy-groups':[{name:'Manual',type:'select',proxies:['Alpha']}]})
const url='https://subscription.invalid/fixture-private-token?token=fixture-subscription-secret'
const until=async(fn:()=>boolean|Promise<boolean>)=>{const end=Date.now()+3000;while(!await fn()){assert.ok(Date.now()<end,'condition timeout');await delay(5)}}
function fixture(t:{after(fn:()=>void|Promise<void>):void},download:typeof downloadSubscription=async()=>({body:data()})){
 const root=mkdtempSync(join(tmpdir(),'cml-subscription-')),key=randomBytes(32);let now=1800000000000,fail=false
 const codec={encrypt:(raw:string)=>{if(fail)throw new Error('fixture storage');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(raw),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b])},decrypt:(b:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString()}}
 const store=new Store(root,codec),busy=new Set<string>(),catalog=new ProxyCatalog(store,id=>busy.has(id),()=>now),subscriptions=new ProxySubscriptions(store,catalog,download,()=>now),resources=new ProxyResources(store,id=>busy.has(id),()=>now)
 const apply=(input:unknown)=>{const p=catalog.preview(input);catalog.apply({ticket:p.ticket,confirmed:true});return p}
 const current=()=>store.read().proxyCatalogs![0],ref=()=>({sourceId:current().id,revision:current().revision})
 const add=async()=>{const j=subscriptions.begin({action:'import',requestId:randomUUID(),url});const done=(await subscriptions.wait(j.id))!;assert.equal(done.phase,'preview',done.error);catalog.apply({ticket:done.preview!.ticket,confirmed:true});return current()}
 const refresh=async()=>{const j=subscriptions.begin({action:'refresh',requestId:randomUUID(),...ref()});return (await subscriptions.wait(j.id))!}
 const bind=()=>{const s=current(),g=s.catalog.groups[0];apply({action:'bind',...ref(),itemId:g.id,selections:{[g.id]:'Alpha'},name:'Resource'});return store.read().proxyResources![0]}
 t.after(async()=>{await subscriptions.stop();catalog.stop();resources.stop();rmSync(root,{recursive:true,force:true})})
 return {root,store,codec,catalog,subscriptions,resources,busy,apply,current,ref,add,refresh,bind,now:()=>now,advance:(ms=6*60*60*1000)=>now+=ms,fail:(v:boolean)=>fail=v}
}

test('subscription URL and generated metadata preserve compatible titles without exposing URL secrets',()=>{
 for(const input of ['http://site.invalid/','file:///tmp/foo','https://user:secret@site.invalid/','https://site.invalid/#','https://site.invalid/\nfoo'])assert.throws(()=>subscriptionURL(input),SubscriptionError)
 assert.equal(subscriptionURL(url).toString(),url)
 assert.equal(subscriptionTitle(new Headers({'profile-title':'base64:'+Buffer.from('测试订阅').toString('base64')}),[new URL(url)]),'测试订阅')
 assert.equal(subscriptionTitle(new Headers({'content-disposition':"attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.yaml"}),[new URL(url)]),'测试')
 for(const title of ['fixture-subscription-secret','fixture-private-token','https://secret.invalid/','bad@domain'])assert.equal(subscriptionTitle(new Headers({'profile-title':title}),[new URL(url)]),undefined)
 const headers=new Headers({'subscription-userinfo':'upload=10; download=20; total=0; expire=2000000000; unknown=secret'})
 assert.deepEqual(subscriptionUsage(headers,123),{upload:10,download:20,total:0,expireAt:2000000000000,at:123})
 assert.equal(subscriptionUsage(new Headers({'subscription-userinfo':'upload=-1; total=999999999999999999; expire=0'})),undefined)
})

test('actual HTTPS download uses Meta negotiation, same-origin redirects, bounded decompression and cancellation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cml-subscription-tls-')),key=join(root,'key.pem'),cert=join(root,'cert.pem'),config=join(root,'openssl.cnf')
 writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-config',config],{stdio:'ignore'})
 const seen:string[]=[],active=new Set<NodeJS.Timeout>(),connections=new Set<import('node:net').Socket>();let closed=0
 const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  seen.push(req.url!);assert.equal(req.headers['user-agent'],'clash.meta/CodexManagerLite');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined)
  switch(req.url?.split('?')[0]){
   case '/redirect':res.writeHead(302,{location:'/ok','set-cookie':'session=secret'});res.end();return
   case '/cross':res.writeHead(302,{location:'https://elsewhere.invalid/private'});res.end();return
   case '/loop':res.writeHead(302,{location:'/loop'});res.end();return
   case '/big':res.writeHead(200,{'content-encoding':'gzip'});res.end(gzipSync('x'.repeat(2*1024*1024+1)));return
   case '/length':res.writeHead(200,{'content-length':3*1024*1024});res.end('small');return
   case '/utf8':res.end(Buffer.from([0xc3,0x28]));return
   case '/error':res.writeHead(403);res.end('fixture-subscription-secret');return
   case '/slow':{res.write('proxies:');const timer=setInterval(()=>res.write(' '),20);active.add(timer);res.on('close',()=>{clearInterval(timer);active.delete(timer);closed++});return}
   default:res.writeHead(200,{'profile-title':'Fixture subscription','subscription-userinfo':'download=1024; total=0'});res.end(data())
  }
 })
 server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base=`https://127.0.0.1:${address.port}`
 const agent=new Agent({connect:{ca:readFileSync(cert)}}),transport:NonNullable<Parameters<typeof downloadSubscription>[3]>['transport']=(u,i)=>fetch(u,{...i,dispatcher:agent})
 t.after(async()=>{for(const timer of active)clearInterval(timer);for(const socket of connections)socket.destroy();await agent.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true})})
 const read=(path:string,signal=new AbortController().signal,timeout=3000)=>downloadSubscription(base+path,signal,()=>{}, {transport,timeout,now:()=>123})
 await assert.rejects(downloadSubscription(base+'/ok',new AbortController().signal,()=>{}),error=>!String(error).includes(base)&&/连接失败/.test(String(error)))
 const result=await read('/redirect');assert.equal(result.body,data());assert.equal(result.title,'Fixture subscription');assert.equal(result.usage?.total,0);assert.deepEqual(seen.slice(-2),['/redirect','/ok'])
 for(const [path,pattern] of [['/cross',/跨越来源/],['/loop',/重定向/],['/big',/2 MiB/],['/length',/2 MiB/],['/utf8',/UTF-8/],['/error',/HTTP 403/]] as const)await assert.rejects(read(path),pattern)
 const controller=new AbortController();const pending=read('/slow',controller.signal);await until(()=>seen.includes('/slow'));controller.abort();await assert.rejects(pending,/取消/);await until(()=>closed===1)
 await assert.rejects(read('/slow',undefined,60),/超时/);await until(()=>closed===2)
})

test('subscription import previews encrypted URL/definitions; cancellation and duplicates cannot publish',async t=>{
 const f=fixture(t,async()=>({body:data(),title:'Suggested',usage:{upload:1,download:2,total:0,at:123}})),id=randomUUID()
 let job=f.subscriptions.begin({action:'import',requestId:id,url});job=(await f.subscriptions.wait(id))!
 assert.equal(f.store.read().proxyCatalogs,undefined);assert.equal(job.preview?.name,'Suggested');assert.equal(JSON.stringify(job).includes('fixture-subscription-secret'),false)
 f.subscriptions.cancel(id);assert.throws(()=>f.catalog.apply({ticket:job.preview!.ticket,confirmed:true}),/过期/)
 const s=await f.add();assert.equal(s.kind,'subscription');assert.equal(s.autoUpdate,false);assert.equal(s.url,url)
 const reopened=new Store(f.root,f.codec);assert.equal(reopened.read().proxyCatalogs![0].url,url);assert.equal(readFileSync(join(f.root,'state.vault')).includes(Buffer.from('fixture-')),false)
 assert.equal(JSON.stringify([f.catalog.list(),f.store.snapshot(),f.subscriptions.list()]).includes('fixture-subscription-secret'),false)
 assert.throws(()=>f.subscriptions.begin({action:'import',requestId:randomUUID(),url}),/已经导入/)
 assert.throws(()=>f.apply({action:'replace',...f.ref(),input:data()}),/刷新/)
})

test('refresh retains exact TLS permissions and last usage; changed definitions require consent and clear invalid defaults',async t=>{
 let result:SubscriptionDownload={body:data('old.invalid',{'skip-cert-verify':true}),usage:{upload:0,download:40,total:100,at:123}}
 const f=fixture(t,async()=>result);await f.add();const node=f.current().catalog.nodes[0]
 f.apply({action:'tls',...f.ref(),itemId:node.id,group:false,allow:true});f.apply({action:'default',...f.ref(),itemId:node.id,selections:{}})
 result={body:data('old.invalid',{'skip-cert-verify':true})};assert.equal((await f.refresh()).phase,'completed');assert.equal(f.current().catalog.nodes[0].error,undefined);assert.equal(f.current().usage?.download,40);assert.ok(f.current().default)
 result={body:data('changed.invalid',{'skip-cert-verify':true})};assert.equal((await f.refresh()).phase,'completed');assert.equal(f.current().catalog.nodes[0].error,'PROXY_TLS_INSECURE');assert.equal(f.current().default,undefined);assert.equal(f.current().defaultInvalidated,true)
})

test('refresh and deferred unified adoption keep independent snapshots, active routes and restart state intact',async t=>{
 let result={body:data()};const f=fixture(t,async()=>result);await f.add();const r=f.bind(),a=parseAccountImport('at-fixture-subscription').accounts[0],independent={...a,id:randomUUID(),proxy:{mode:'resource' as const,resourceId:r.id}}
 f.store.transaction(s=>{s.accounts=[a,independent]});let p=f.resources.preview({action:'enable',id:r.id,revision:r.revision});f.resources.apply({ticket:p.ticket,confirmed:true})
 const original=accountProxyURL(a,f.store.proxyState())!;f.busy.add(a.id);result={body:data('new.invalid')};assert.equal((await f.refresh()).phase,'completed')
 assert.equal(f.store.read().unifiedProxy?.pending,true);assert.equal(accountProxyURL(a,f.store.proxyState()),original);assert.equal(accountProxyURL(independent,f.store.proxyState()),original)
 const reopened=new Store(f.root,f.codec),catalog=new ProxyCatalog(reopened,()=>false,f.now);catalog.syncPendingSubscription();assert.equal(decodeCatalogBinding(accountProxyURL(a,reopened.proxyState())!).proxies[0].server,'new.invalid');assert.equal(accountProxyURL(independent,reopened.proxyState()),original);catalog.stop()
 f.busy.clear();f.catalog.syncPendingSubscription();assert.equal(decodeCatalogBinding(accountProxyURL(a,f.store.proxyState())!).proxies[0].server,'new.invalid');assert.equal(f.store.read().proxyResources![0].url,original)
 result={body:JSON.stringify({proxies:[{name:'Other',type:'http',server:'other.invalid',port:80}]})};assert.equal((await f.refresh()).phase,'completed');assert.match(f.store.read().unifiedProxy!.staleError!,/保留/);assert.equal(decodeCatalogBinding(accountProxyURL(a,f.store.proxyState())!).proxies[0].server,'new.invalid')
 p=f.resources.preview({action:'disable'});f.resources.apply({ticket:p.ticket,confirmed:true});f.catalog.syncPendingSubscription();assert.equal(accountProxyURL(a,f.store.proxyState()),undefined)
})

test('cancel, late replies, changed sources and disk failures cannot overwrite newer configuration or resurrect data',async t=>{
 let complete:(v:SubscriptionDownload)=>void=()=>{};let pending=false
 const f=fixture(t,async()=>pending?new Promise<SubscriptionDownload>(resolve=>{complete=resolve}):{body:data()});await f.add();pending=true
 const start=()=>f.subscriptions.begin({action:'refresh',requestId:randomUUID(),...f.ref()})
 let job=start();const original=f.store.read();f.subscriptions.cancel(job.id);complete({body:data('cancel.invalid')});assert.equal((await f.subscriptions.wait(job.id))!.phase,'cancelled');assert.deepEqual(f.store.read(),original)
 job=start();f.apply({action:'rename',...f.ref(),name:'Newer'});const newer=f.store.read();complete({body:data('late.invalid')});assert.equal((await f.subscriptions.wait(job.id))!.phase,'failed');assert.deepEqual(f.store.read(),newer)
 job=start();f.fail(true);complete({body:data('disk.invalid')});assert.equal((await f.subscriptions.wait(job.id))!.phase,'failed');assert.deepEqual(f.store.read(),newer);f.fail(false)
 job=start();f.apply({action:'remove',...f.ref()});complete({body:data('removed.invalid')});await f.subscriptions.wait(job.id);assert.equal(f.store.read().proxyCatalogs!.length,0)
 const id=randomUUID();f.subscriptions.cancel(id);assert.equal(f.subscriptions.begin({action:'import',requestId:id,url}).phase,'cancelled')
})

test('automatic update defaults off, persists opt-in, observes six-hour retry backoff and shuts down active work',async t=>{
 let count=0,fail=false
 const f=fixture(t,async()=>{count++;if(fail)throw new SubscriptionError('订阅下载失败（HTTP 503）');return {body:data()}});await f.add();f.advance();await f.subscriptions.tick();assert.equal(count,1)
 f.apply({action:'auto-update',...f.ref(),enabled:true});assert.equal(new Store(f.root,f.codec).read().proxyCatalogs![0].autoUpdate,true)
 const task=f.subscriptions.tick();assert.equal(f.subscriptions.tick(),task);await task;assert.equal(count,2)
 f.advance();fail=true;const original=f.current().catalog;await f.subscriptions.tick();assert.equal(count,3);assert.deepEqual(f.current().catalog,original);assert.match(f.current().error!,/503/)
 await f.subscriptions.tick();assert.equal(count,3);f.advance();fail=false;await f.subscriptions.tick();assert.equal(count,4);assert.equal(f.current().error,undefined)
 f.apply({action:'auto-update',...f.ref(),enabled:false});f.advance();await f.subscriptions.tick();assert.equal(count,4)
 const waiting=fixture(t,async(_url,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})))
 const jobs=Array.from({length:4},(_,i)=>waiting.subscriptions.begin({action:'import',requestId:randomUUID(),url:url+'&n='+i}))
 assert.throws(()=>waiting.subscriptions.begin({action:'import',requestId:randomUUID(),url:url+'&n=5'}),/4/)
 await waiting.subscriptions.stop();assert.equal(waiting.store.read().proxyCatalogs,undefined);for(const j of jobs)assert.equal(await waiting.subscriptions.wait(j.id),undefined)
})
