import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto'
import {Store} from '../src/main/store'
import {ProxyCatalog} from '../src/main/proxyCatalog'
import {ProxyResources} from '../src/main/proxyResources'
import {parseAccountImport} from '../src/main/accounts'
import {decodeCatalogBinding} from '../src/main/proxyCatalogBinding'
import {freezeProxyCatalog} from '../src/main/proxyCatalogGraph'
import {accountProxyURL,unifiedProxyURL} from '../src/main/proxyPolicy'
import type {StrategyChange,StrategyKind} from '../src/shared/proxyStrategy'
const node=(name:string,extra:Record<string,unknown>={})=>({name,type:'http',server:'node.invalid',port:8080,password:'fixture-strategy-secret',...extra})
const content=(nodes:unknown[])=>JSON.stringify({proxies:nodes})
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'cml-strategy-')),key=randomBytes(32),busy=new Set<string>();let now=1800000000000,fail=false
 const codec={encrypt:(raw:string)=>{if(fail)throw new Error('fixture vault failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(raw),c.final(),c.getAuthTag()])},decrypt:(b:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString()}}
 const store=new Store(root,codec),catalog=new ProxyCatalog(store,id=>busy.has(id),()=>now),resources=new ProxyResources(store,id=>busy.has(id),()=>now)
 const current=(id:string)=>store.read().proxyCatalogs!.find(s=>s.id===id)!,ref=(id:string)=>({sourceId:id,revision:current(id).revision})
 const apply=(raw:unknown)=>{const p=catalog.preview(raw);catalog.apply({ticket:p.ticket,confirmed:true});return p}
 const add=(name:string,nodes:unknown[]= [node('Alpha'),node('Beta')])=>{apply({action:'import',name,input:content(nodes)});return store.read().proxyCatalogs!.at(-1)!}
 const create=(origin:string,name='Policy',kind:StrategyKind='fallback')=>{const s=current(origin);apply({action:'strategy',name,kind,members:s.catalog.nodes.filter(n=>!n.error).map(n=>({sourceId:s.id,itemId:n.id})),options:{}});return store.read().proxyCatalogs!.at(-1)!}
 const edit=(id:string):StrategyChange=>{const s=catalog.strategyEditor(ref(id));return {action:'strategy',...ref(id),name:s.name,kind:s.kind,members:s.members.map(({sourceId,itemId})=>({sourceId,itemId})),options:s.options}}
 const bind=(id:string,selections:Record<string,string>={})=>{const s=current(id);apply({action:'bind',...ref(id),itemId:s.catalog.groups[0].id,selections,name:'Resource'});return store.read().proxyResources!.at(-1)!}
 const enable=(id:string)=>{const r=store.read().proxyResources!.find(r=>r.id===id)!,p=resources.preview({action:'enable',id,revision:r.revision});resources.apply({ticket:p.ticket,confirmed:true})}
 t.after(()=>{catalog.stop();resources.stop();rmSync(root,{recursive:true,force:true})})
 return {root,store,catalog,resources,busy,current,ref,apply,add,create,edit,bind,enable,codec,advance:()=>now+=300001,fail:(value:boolean)=>fail=value}
}
test('strategy candidates page valid nodes, filter endpoints independently of sources and keep advisory nodes',t=>{
 const f=fixture(t),a=f.add('Contains keyword',Array.from({length:60},(_,i)=>node('Node '+i,{server:`host${i}.invalid`}))),b=f.add('Other',[node('剩余流量：100 GB'),node('Rejected',{type:'unknown'}),node('TLS',{tls:true,'skip-cert-verify':true})])
 let p=f.catalog.strategyCandidates({page:3});assert.equal(p.total,61);assert.equal(p.rows.length,11);assert.equal(p.rows.at(-1)!.notice,true)
 assert.equal(f.catalog.strategyCandidates({query:'Contains'}).total,0)
 p=f.catalog.strategyCandidates({query:'Node 59 host59.invalid 8080',sourceId:a.id});assert.equal(p.total,1)
 assert.equal(f.catalog.strategyCandidates({query:'Node 59',sourceId:b.id}).total,0)
 f.create(b.id);assert.equal(f.catalog.strategyCandidates({}).total,61)
 assert.equal(JSON.stringify(p).includes('fixture-strategy-secret'),false)
 assert.throws(()=>f.catalog.strategyCandidates({page:0}));assert.throws(()=>f.catalog.strategyCandidates({query:'x'.repeat(257)}))
})
test('four strategies preserve ordered copies, exact effective options and first same-name identity through encrypted reopen',t=>{
 const f=fixture(t),a=f.add('Origin A'),b=f.add('Origin B',[node('Alpha',{server:'other.invalid'}),node('Gamma')])
 for(const kind of ['select','fallback','url-test','load-balance'] as const){
  const members=[{sourceId:a.id,itemId:a.catalog.nodes[1].id},{sourceId:a.id,itemId:a.catalog.nodes[0].id},{sourceId:b.id,itemId:b.catalog.nodes[0].id},{sourceId:b.id,itemId:b.catalog.nodes[1].id}]
  const p=f.apply({action:'strategy',name:kind,kind,members,options:{url:'http://health.invalid/status',interval:180,timeout:7,tolerance:40,lazy:false}})
  assert.deepEqual(p.duplicateNames,['Alpha']);assert.equal(p.nodes,3);assert.equal(p.groups,1)
  const s=f.store.read().proxyCatalogs!.at(-1)!,group=s.catalog.groups[0],view=f.catalog.strategyEditor(f.ref(s.id))
  assert.deepEqual(group.members,['Beta','Alpha','Gamma']);assert.equal(s.strategyMembers![1].sourceId,a.id);assert.equal(s.catalog.nodes[1].native!.server,'node.invalid')
  const graph=freezeProxyCatalog(s.catalog,group.id,kind==='select'?{[group.id]:'Gamma'}:{}),native=graph.groups[0]
  assert.equal(graph.proxies.length,kind==='select'?1:3);assert.equal(native.type,kind)
  assert.equal(native.url,kind==='select'?undefined:'http://health.invalid/status');assert.equal(native.timeout,kind==='fallback'||kind==='url-test'?7000:undefined);assert.equal(native.tolerance,kind==='url-test'?40:undefined)
  assert.equal(view.options.timeout,kind==='fallback'||kind==='url-test'?7:undefined);assert.equal(view.options.lazy,kind==='select'?undefined:false)
  assert.equal(JSON.stringify([p,view,f.catalog.list(),f.store.snapshot()]).includes('fixture-strategy-secret'),false)
 }
 assert.equal(readFileSync(join(f.root,'state.vault')).includes('fixture-strategy-secret'),false)
 const reopened=new Store(f.root,f.codec);assert.deepEqual(reopened.read().proxyCatalogs,JSON.parse(JSON.stringify(f.store.read().proxyCatalogs)))
})
test('strategy validation rejects malformed ranges, references, TLS bypasses, name shadows and non-strategy updates',t=>{
 const f=fixture(t),a=f.add('Source',[node('Alpha'),node('Unsafe',{tls:true,'skip-cert-verify':true})]),base={action:'strategy',name:'Policy',kind:'fallback',members:[{sourceId:a.id,itemId:a.catalog.nodes[0].id}],options:{}}
 for(const patch of [{kind:'relay'},{members:[]},{members:Array(65).fill(base.members[0])},{members:[base.members[0],base.members[0]]},{name:'Alpha'},{name:'DIRECT'},{sourceId:a.id},{revision:0},{...f.ref(a.id)},{members:[{sourceId:a.id,itemId:a.catalog.nodes[1].id}]},{members:[{sourceId:a.id,itemId:'missing'}]}])assert.throws(()=>f.catalog.preview({...base,...patch}))
 for(const options of [{interval:29},{interval:3601},{timeout:0},{timeout:31},{timeout:1.2},{tolerance:-1},{tolerance:1001},{lazy:'true'},{url:'http://user:password@health.invalid/'},{url:'file:///tmp/test'},{url:'http://health.invalid/#'},{url:'https://health.invalid/\n'},{url:'https://health.invalid/'+'x'.repeat(2048)},{unexpected:1}])assert.throws(()=>f.catalog.preview({...base,options}))
 const blank=f.catalog.preview({...base,options:{url:'   '}});f.catalog.discard(blank.ticket)
 const strategy=f.create(a.id)
 assert.throws(()=>f.catalog.preview({...base,members:[{sourceId:strategy.id,itemId:strategy.catalog.nodes[0].id}]}))
 assert.throws(()=>f.catalog.preview({action:'replace',...f.ref(strategy.id),input:content([node('Gamma')])}))
 assert.throws(()=>f.catalog.preview({action:'auto-update',...f.ref(strategy.id),enabled:true}))
})
test('editing retains only its own saved copies after original source deletion; changed or revoked live nodes never fall back',t=>{
 const f=fixture(t),a=f.add('Source'),strategy=f.create(a.id),before=structuredClone(strategy.catalog)
 const removal=f.apply({action:'remove',...f.ref(a.id)});assert.deepEqual(removal.strategyNames,['Policy'])
 assert.deepEqual(f.current(strategy.id).catalog,before);const editor=f.catalog.strategyEditor(f.ref(strategy.id));assert.ok(editor.members.every(m=>m.savedCopy&&m.available))
 const renamed=f.edit(strategy.id);renamed.name='Retained';f.apply(renamed);assert.deepEqual(f.current(strategy.id).catalog.nodes,before.nodes)
 assert.throws(()=>f.catalog.preview({...renamed,sourceId:undefined,revision:undefined,name:'Stolen copy'}))
 const fresh=f.add('Fresh'),live=f.create(fresh.id,'Live')
 f.apply({action:'replace',...f.ref(fresh.id),input:content([node('Alpha',{tls:true,'skip-cert-verify':true})])})
 assert.ok(f.catalog.strategyEditor(f.ref(live.id)).members.every(m=>!m.available&&!m.savedCopy));assert.throws(()=>f.catalog.preview(f.edit(live.id)))
 assert.equal(f.current(live.id).catalog.nodes.length,2)
})
test('strategy edits keep group identity/defaults and independent snapshots while unified changes defer until idle',t=>{
 const f=fixture(t),a=f.add('Source'),strategy=f.create(a.id,'Policy','select'),gid=strategy.catalog.groups[0].id,selection={[gid]:'Alpha'}
 f.apply({action:'default',...f.ref(strategy.id),itemId:gid,selections:selection});const resource=f.bind(strategy.id,selection)
 const inherited=parseAccountImport('at-strategy-inherited').accounts[0],independent=parseAccountImport('at-strategy-independent').accounts[0];independent.proxy={mode:'resource',resourceId:resource.id}
 f.store.transaction(s=>s.accounts.push(inherited,independent));f.enable(resource.id);const old=unifiedProxyURL(f.store.read())
 f.apply({action:'replace',...f.ref(a.id),input:content([node('Alpha',{server:'new.invalid'}),node('Beta')])});f.busy.add(inherited.id)
 const p=f.apply({...f.edit(strategy.id),name:'Renamed'});assert.equal(p.deferredUnified,true);assert.equal(unifiedProxyURL(f.store.read()),old);assert.equal(accountProxyURL(independent,f.store.read()),resource.url)
 assert.equal(f.current(strategy.id).catalog.groups[0].id,gid);assert.deepEqual(f.current(strategy.id).default?.selections,selection)
 f.busy.clear();f.catalog.syncPendingSubscription();const updated=unifiedProxyURL(f.store.read());assert.equal(decodeCatalogBinding(updated).proxies[0].server,'new.invalid');assert.equal(accountProxyURL(independent,f.store.read()),resource.url)
 f.apply({...f.edit(strategy.id),members:[{sourceId:a.id,itemId:a.catalog.nodes[1].id}]});assert.equal(f.current(strategy.id).default,undefined);assert.equal(f.current(strategy.id).defaultInvalidated,true);assert.equal(unifiedProxyURL(f.store.read()),updated);assert.match(f.store.read().unifiedProxy!.staleError!,/原选择/)
})
test('renaming strategy updates group metadata with stable IDs, keeps copies independent and rejects member-name collisions',t=>{
 const f=fixture(t),a=f.add('Source'),strategy=f.create(a.id),original=f.current(strategy.id),resource=f.bind(strategy.id)
 f.apply({action:'rename',...f.ref(strategy.id),name:'Renamed'})
 const after=f.current(strategy.id);assert.equal(after.catalog.groups[0].id,original.catalog.groups[0].id);assert.equal(after.catalog.groups[0].native!.name,'Renamed');assert.equal(after.catalog.groups[0].name,'Renamed')
 assert.equal(f.store.read().proxyResources![0].url,resource.url);assert.throws(()=>f.catalog.preview({action:'rename',...f.ref(strategy.id),name:'Alpha'}));assert.equal(f.current(strategy.id).name,'Renamed')
})
test('stale or cancelled strategy previews, expired tickets and failed vault writes preserve data and current credentials',t=>{
 const f=fixture(t),a=f.add('Source'),strategy=f.create(a.id),draft=()=>({...f.edit(strategy.id),name:'Updated'})
 let p=f.catalog.preview(draft());f.catalog.discard(p.ticket);assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}))
 p=f.catalog.preview(draft());f.advance();assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}),/过期/)
 p=f.catalog.preview(draft());f.apply({action:'rename',...f.ref(a.id),name:'New source name'});assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}),/变化/)
 p=f.catalog.preview(draft());const before=f.store.read();f.fail(true);assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}),/vault failure/);assert.deepEqual(f.store.read(),before);f.fail(false)
 const account=parseAccountImport('at-strategy-rotated').accounts[0];f.store.transaction(s=>s.accounts.push(account));assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}),/变化/)
 p=f.catalog.preview(draft());f.store.transaction(s=>s.accounts[0].credentials.accessToken='at-strategy-latest');f.catalog.apply({ticket:p.ticket,confirmed:true});assert.equal(f.store.read().accounts[0].credentials.accessToken,'at-strategy-latest');assert.equal(f.current(strategy.id).strategyMembers![0].sourceName,'New source name')
})
test('strategy deletion shares dependency previews, blocks active removal and atomically clears only its bindings',t=>{
 const f=fixture(t),a=f.add('Source'),strategy=f.create(a.id),resource=f.bind(strategy.id),account=parseAccountImport('at-strategy-delete').accounts[0];account.proxy={mode:'resource',resourceId:resource.id};f.store.transaction(s=>s.accounts.push(account));f.enable(resource.id)
 const p=f.catalog.preview({action:'remove',...f.ref(strategy.id)});assert.equal(p.clearsBindings,1);assert.equal(p.disablesUnified,true)
 f.busy.add(account.id);assert.throws(()=>f.catalog.apply({ticket:p.ticket,confirmed:true}),/正在使用/);f.busy.clear();f.catalog.apply({ticket:p.ticket,confirmed:true})
 assert.equal(f.store.read().accounts[0].proxy,undefined);assert.equal(f.store.read().unifiedProxy?.mode,'off');assert.equal(f.catalog.list().length,1);assert.equal(f.catalog.list()[0].id,a.id)
})
