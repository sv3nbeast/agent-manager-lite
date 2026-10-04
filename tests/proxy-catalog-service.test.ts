import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto'
import {Store} from '../src/main/store'
import {ProxyCatalog} from '../src/main/proxyCatalog'
import {ProxyResources} from '../src/main/proxyResources'
import {parseAccountImport} from '../src/main/accounts'
import {accountProxyURL,normalizeProxy} from '../src/main/proxyPolicy'
import {decodeCatalogBinding,encodeCatalogBinding} from '../src/main/proxyCatalogBinding'
import {nativeOptions} from '../src/main/proxyNativeOptions'

const node=(name='Alpha',extra:Record<string,unknown>={})=>({name,type:'http',server:'node.invalid',port:8080,password:'synthetic-catalog-secret',...extra})
const content=(nodes:unknown[]=[node()],groups:unknown[]=[{name:'Choose',type:'select',proxies:['Alpha']}])=>JSON.stringify({proxies:nodes,'proxy-groups':groups})
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'cml-catalog-')),key=randomBytes(32);let now=Date.now(),fail=false
 const codec={encrypt:(value:string)=>{if(fail)throw new Error('fixture vault failed');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body])},decrypt:(value:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString()}}
 const store=new Store(root,codec),busy=new Set<string>(),service=new ProxyCatalog(store,id=>busy.has(id),()=>now),resources=new ProxyResources(store,id=>busy.has(id))
 const account=parseAccountImport('at-catalog-fixture').accounts[0];store.transaction(s=>{s.accounts.push(account);s.settings.refreshMinutes=0})
 const apply=(raw:unknown)=>{const p=service.preview(raw);service.apply({ticket:p.ticket,confirmed:true});return p}
 const add=(input=content(),name='来源')=>{apply({action:'import',name,input});return service.list().find(s=>s.name===name)!}
 const current=()=>service.list()[0],ref=()=>({sourceId:current().id,revision:current().revision})
 const items=()=>store.read().proxyCatalogs![0].catalog
 const bind=(itemId=items().nodes[0].id,selections:Record<string,string>={},name='出口')=>{apply({action:'bind',...ref(),itemId,selections,name});return store.read().proxyResources!.at(-1)!}
 const enable=(id:string)=>{const r=store.read().proxyResources!.find(r=>r.id===id)!,p=resources.preview({action:'enable',id,revision:r.revision});resources.apply({ticket:p.ticket,confirmed:true})}
 t.after(()=>{service.stop();resources.stop();rmSync(root,{recursive:true,force:true})})
 return {root,store,service,resources,busy,account,apply,add,ref,items,bind,enable,codec,current,advance:()=>{now+=300001},fail:(value:boolean)=>{fail=value}}
}
test('directory previews are paginated, preserve rejected entries and encrypt complete definitions',t=>{
 const f=fixture(t),raw=content(Array.from({length:61},(_,i)=>node(`N${i}`,i===60?{type:'unknown'}:{})),[])
 const preview=f.service.preview({action:'import',name:'大量节点',input:raw})
 assert.equal(f.service.list().length,0);assert.equal(preview.invalid,1)
 const page=f.service.page({ticket:preview.ticket,kind:'nodes',page:3});assert.equal(page.rows.length,11);assert.equal(page.total,61);assert.equal(page.rows.at(-1)!.error,'PROXY_UNSUPPORTED_OPTION')
 for(const view of [preview,page])assert.equal(JSON.stringify(view).includes('synthetic-catalog-secret'),false)
 f.service.apply({ticket:preview.ticket,confirmed:true});assert.equal(f.current().nodes,61)
 assert.equal(readFileSync(join(f.root,'state.vault')).includes(Buffer.from('synthetic-catalog-secret')),false)
 const reopened=new Store(f.root,f.codec);assert.equal(reopened.read().proxyCatalogs![0].catalog.nodes[0].native!.password,'synthetic-catalog-secret')
 assert.equal(JSON.stringify(f.store.snapshot()).includes('synthetic-catalog-secret'),false)
 assert.equal(f.service.page({...f.ref(),kind:'nodes',page:1,query:'N60'}).rows.length,1)
})
test('explicit nested selector resolution pages every candidate without picking an implicit default',t=>{
 const f=fixture(t);f.add(content(Array.from({length:31},(_,i)=>node(`N${i}`)),[{name:'Root',type:'select',proxies:['Nested'], 'default-selected':'Nested'},{name:'Nested',type:'select',proxies:Array.from({length:31},(_,i)=>`N${i}`)}]))
 const root=f.items().groups[0],nested=f.items().groups[1],resolve=(selections:Record<string,string>,page=1)=>f.service.resolve({...f.ref(),itemId:root.id,selections,page})
 assert.equal(resolve({}).selection?.id,root.id)
 assert.throws(()=>f.bind(root.id),/SELECTION_REQUIRED/)
 const one={[root.id]:'Nested'};assert.equal(resolve(one).selection?.options.length,25);assert.equal(resolve(one,2).selection?.options.length,6)
 const choices={...one,[nested.id]:'N30'};assert.equal(resolve(choices).ready,true)
 f.apply({action:'default',...f.ref(),itemId:root.id,selections:choices});assert.deepEqual(f.current().default?.selections,choices)
 const resource=f.bind(root.id,choices);const graph=decodeCatalogBinding(resource.url);assert.equal(graph.proxies.length,1);assert.equal(graph.names[graph.proxies[0].name],'N30')
 assert.throws(()=>normalizeProxy(resource.url));assert.equal(JSON.stringify(f.service.list()).includes('password'),false)
})
test('source replacement blocks busy routes; missing selections invalidate bindings and defaults without fallback',t=>{
 const f=fixture(t);f.add();const group=f.items().groups[0],choices={[group.id]:'Alpha'}
 f.apply({action:'default',...f.ref(),itemId:group.id,selections:choices});const resource=f.bind(group.id,choices);f.enable(resource.id)
 const original=f.store.read(),p=f.service.preview({action:'replace',...f.ref(),input:content([node('Beta')],[{name:'Choose',type:'select',proxies:['Beta']}])})
 assert.equal(p.invalidResources,1);assert.deepEqual(p.affected.map(a=>a.id),[f.account.id]);f.busy.add(f.account.id)
 assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/正在使用/);assert.deepEqual(f.store.read(),original)
 f.busy.clear();f.service.apply({ticket:p.ticket,confirmed:true});assert.equal(f.current().default,undefined);assert.equal(f.current().defaultInvalidated,true)
 assert.throws(()=>accountProxyURL(f.store.read().accounts[0],f.store.proxyState()),/失效/);assert.equal(f.store.snapshot().proxyResources?.resources[0].address.invalid,true)
 assert.equal(f.store.snapshot().proxyResources?.unified.mode,'invalid')
 const next=f.items().groups[0]
 f.apply({action:'bind',...f.ref(),itemId:next.id,selections:{[next.id]:'Beta'},name:'出口',resourceId:resource.id,resourceRevision:1})
 assert.equal(f.store.snapshot().proxyResources?.unified.mode,'all_accounts');assert.equal(f.current().default,undefined)
})
test('TLS group consent is explicit and revocation invalidates all dependent resource exits atomically',t=>{
 const f=fixture(t);f.add(content([node('Alpha',{'skip-cert-verify':true}),node('Beta')],[{name:'Auto',type:'fallback',proxies:['Alpha','Beta']}]))
 const group=f.items().groups[0],page=f.service.page({...f.ref(),kind:'groups',page:1});assert.equal(page.rows[0].insecure,true);assert.equal(page.rows[0].tlsAllowed,false)
 assert.throws(()=>f.bind(group.id),/TLS_INSECURE/)
 const p=f.service.preview({action:'tls',...f.ref(),itemId:group.id,group:true,allow:true});assert.deepEqual(p.tlsNames,['Alpha']);f.service.apply({ticket:p.ticket,confirmed:true})
 assert.equal(f.service.page({...f.ref(),kind:'groups',page:1}).rows[0].tlsAllowed,true)
 const resource=f.bind(group.id);f.enable(resource.id)
 assert.deepEqual(decodeCatalogBinding(resource.url).insecureNames,['resource-1'])
 f.apply({action:'tls',...f.ref(),itemId:group.id,group:true,allow:false})
 assert.equal(f.store.read().proxyResources![0].catalog!.invalid,true);assert.throws(()=>accountProxyURL(f.store.read().accounts[0],f.store.proxyState()))
 f.apply({action:'tls',...f.ref(),itemId:group.id,group:true,allow:true});assert.ok(accountProxyURL(f.store.read().accounts[0],f.store.proxyState()))
})
test('source deletion previews unified and independent dependencies; unrelated resources and accounts survive',t=>{
 const f=fixture(t);f.add();const resource=f.bind();f.enable(resource.id)
 const own={...f.account,id:randomUUID(),proxy:{mode:'resource' as const,resourceId:resource.id}},direct={...f.account,id:randomUUID(),proxy:{mode:'direct' as const}},other={id:randomUUID(),revision:0,name:'保留',url:'http://127.0.0.1:9999/'}
 f.store.transaction(s=>{s.accounts.push(own,direct);s.proxyResources!.push(other)})
 const p=f.service.preview({action:'remove',...f.ref()});assert.equal(p.clearsBindings,1);assert.equal(p.disablesUnified,true);assert.equal(p.affected.length,2)
 f.busy.add(own.id);assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/正在使用/);f.busy.clear()
 f.service.apply({ticket:p.ticket,confirmed:true});assert.equal(f.service.list().length,0);assert.deepEqual(f.store.read().proxyResources,[other]);assert.equal(f.store.read().accounts[1].proxy,undefined);assert.deepEqual(f.store.read().accounts[2],direct)
})
test('tickets expire/cancel, stale metadata rejects, failed encryption preserves state and rotation is retained',t=>{
 const f=fixture(t)
 let p=f.service.preview({action:'import',name:'取消',input:content()});f.service.discard(p.ticket);assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/过期/)
 p=f.service.preview({action:'import',name:'过期',input:content()});f.advance();assert.throws(()=>f.service.page({ticket:p.ticket,kind:'nodes',page:1}),/过期/)
 p=f.service.preview({action:'import',name:'变化',input:content()});f.store.transaction(s=>{s.accounts[0].revision=1});assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/变化/)
 p=f.service.preview({action:'import',name:'原子保存',input:content()});const before=f.store.read();f.fail(true);assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/vault failed/);assert.deepEqual(f.store.read(),before)
 f.fail(false);f.store.transaction(s=>{s.accounts[0].credentials.accessToken='at-rotated-fixture'});f.service.apply({ticket:p.ticket,confirmed:true});assert.equal(f.store.read().accounts[0].credentials.accessToken,'at-rotated-fixture')
 assert.throws(()=>f.service.apply({ticket:p.ticket,confirmed:true}),/过期/)
 f.service.stop();assert.throws(()=>f.service.preview({action:'import',name:'stopped',input:content()}),/退出/)
})
test('catalog bindings stay private, enforce source ownership and cannot be edited through a raw URL field',t=>{
 const f=fixture(t);f.add();const resource=f.bind()
 assert.throws(()=>f.resources.preview({action:'update',id:resource.id,revision:0,name:'绕过',url:'http://127.0.0.1:1'}),/目录资源/)
 const p=f.resources.preview({action:'update',id:resource.id,revision:0,name:'新名称'});f.resources.apply({ticket:p.ticket,confirmed:true})
 const graph=decodeCatalogBinding(resource.url);graph.proxies[0].server='tampered.invalid';assert.equal(decodeCatalogBinding(resource.url).proxies[0].server,'node.invalid')
 assert.equal(encodeCatalogBinding(decodeCatalogBinding(resource.url)),resource.url)
 assert.throws(()=>f.service.preview({action:'bind',...f.ref(),itemId:f.items().nodes[0].id,selections:{},name:'更新',resourceId:resource.id,resourceRevision:0}),/变化/)
 const other=f.add(content([node('Other')],[]),'第二来源')
 assert.throws(()=>f.service.preview({action:'bind',sourceId:other.id,revision:other.revision,itemId:f.store.read().proxyCatalogs![1].catalog.nodes[0].id,selections:{},name:'更新',resourceId:resource.id,resourceRevision:1}),/变化/)
 assert.throws(()=>f.service.preview({action:'import',name:'secret://bad',input:content()}),/参数无效/)
})
test('Go and TypeScript native option lists remain identical',()=>{assert.deepEqual(JSON.parse(readFileSync('sidecars/codex-proxy/native_proxy_options.json','utf8')),nativeOptions)})
