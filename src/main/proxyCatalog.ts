import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {isDeepStrictEqual} from 'node:util'
import type {Store,State} from './store'
import {analyzeCatalog,parseProxyCatalog,type ParsedProxyCatalog,type CatalogNode} from './proxyCatalogParser'
import {buildStrategy,strategyCandidates,strategyEditor,renameStrategy} from './proxyStrategy'
import type {StrategyRecord,StrategyKind} from '../shared/proxyStrategy'
import {syncUnifiedCatalog} from './proxyCatalogSync'
import type {SubscriptionDownload} from './proxySubscriptionDownload'
import {catalogGroupNodeIds,freezeProxyCatalog,setCatalogTLSApproval} from './proxyCatalogGraph'
import {blockingNames,builtinNames,catalogFail,insecureDefinition} from './proxyNative'
import {encodeCatalogBinding} from './proxyCatalogBinding'
import {accountProxyURL,type StoredProxyResource} from './proxyPolicy'
import {catalogChangeSchema,catalogPageSchema,catalogResolveSchema,type CatalogChange,type CatalogPage,type CatalogPreview,type CatalogResolution,type CatalogRow,type CatalogSourceView,type SubscriptionUsage} from '../shared/proxyCatalog'

export interface StoredCatalogSource {id:string;revision:number;name:string;kind:'manual'|'subscription'|'strategy';strategyMembers?:StrategyRecord[];catalog:ParsedProxyCatalog;updatedAt:number;default?:{itemId:string;selections:Record<string,string>};defaultInvalidated?:boolean;url?:string;autoUpdate?:boolean;lastAttemptAt?:number;error?:string;usage?:SubscriptionUsage}
type Pending={expires:number;fingerprint:string;change:(state:State)=>void;catalog:ParsedProxyCatalog;bytes:number}
const maxBytes=32*1024*1024
const schema=<T>(schema:z.ZodType<T,z.ZodTypeDef,unknown>,raw:unknown):T=>{try{return schema.parse(raw)}catch{throw new Error('目录参数无效，请重新选择')}}
function source(state:State,id:string,revision:number|undefined):StoredCatalogSource{
 const found=state.proxyCatalogs?.filter(s=>s.id===id)
 if(!found||found.length!==1||found[0].revision!==revision)throw new Error('目录已变化或不存在，请重新打开')
 return found[0]
}
function fingerprint(state:State):string{return createHash('sha256').update(JSON.stringify([state.proxyCatalogs,state.proxyResources,state.unifiedProxy,state.accounts.map(a=>[a.id,a.generation,a.revision,a.kind,a.providerId,!!a.credentials.accessToken,a.proxy])])).digest('hex')}
function route(state:State,id:string){try{return accountProxyURL(state.accounts.find(a=>a.id===id)!,state)}catch{return '!invalid'}}
function affected(before:State,after:State){return before.accounts.filter(a=>route(before,a.id)!==route(after,a.id)).map(a=>({id:a.id,name:a.name}))}
function bounds(state:State):void{
 if((state.proxyCatalogs?.length??0)>32)throw new Error('最多保存 32 个代理来源')
 if((state.proxyResources?.length??0)>500)throw new Error('最多保存 500 个代理资源')
 if(Buffer.byteLength(JSON.stringify([state.proxyCatalogs,state.proxyResources,state.unifiedProxy]))>maxBytes)throw new Error('代理目录与运行快照不能超过 32 MiB')
}
function clearUnifiedSnapshot(state:State,resourceId:string){if(state.unifiedProxy?.resourceId===resourceId){delete state.unifiedProxy.snapshot;delete state.unifiedProxy.pending;delete state.unifiedProxy.staleError}}
function invalidateDefault(source:StoredCatalogSource){if(source.default)try{freezeProxyCatalog(source.catalog,source.default.itemId,source.default.selections)}catch{delete source.default;source.defaultInvalidated=true}}
function rebind(state:State,source:StoredCatalogSource):void{
 for(const resource of state.proxyResources??[])if(resource.catalog?.sourceId===source.id){
  try{resource.url=encodeCatalogBinding(freezeProxyCatalog(source.catalog,resource.catalog.itemId,resource.catalog.selections));delete resource.catalog.invalid}
  catch{resource.catalog.invalid=true}
  resource.catalog.revision=source.revision;resource.revision++
  clearUnifiedSnapshot(state,resource.id)
 }
 invalidateDefault(source)
}
function view(state:State,s:StoredCatalogSource):CatalogSourceView{return {id:s.id,revision:s.revision,name:s.name,kind:s.kind,...s.kind==='strategy'?{strategyKind:s.catalog.groups[0]?.kind as StrategyKind}:{},nodes:s.catalog.nodes.length,groups:s.catalog.groups.length,invalid:[...s.catalog.nodes,...s.catalog.groups].filter(n=>n.error).length,updatedAt:s.updatedAt,default:structuredClone(s.default),defaultInvalidated:!!s.defaultInvalidated,resources:(state.proxyResources??[]).filter(r=>r.catalog?.sourceId===s.id).length,...s.kind==='subscription'?{autoUpdate:!!s.autoUpdate,lastAttemptAt:s.lastAttemptAt,error:s.error,usage:structuredClone(s.usage)}:{}}}
function row(node:CatalogNode):CatalogRow{const insecure=!!node.native&&insecureDefinition(node.native);return {id:node.id,name:node.name,kind:'node',protocol:node.protocol,error:node.error,insecure,tlsAllowed:insecure&&!node.error}}
export class ProxyCatalog {
 private readonly pending=new Map<string,Pending>()
 private stopped=false
 constructor(private readonly store:Store,private readonly inUse:(id:string)=>boolean=()=>false,private readonly now=Date.now){}
 private ready():void{if(this.stopped)throw new Error('应用正在退出');for(const [id,value] of this.pending)if(value.expires<=this.now())this.pending.delete(id)}
 list():CatalogSourceView[]{this.ready();const state=this.store.read();return (state.proxyCatalogs??[]).map(s=>view(state,s))}
 strategyCandidates(raw:unknown){this.ready();return strategyCandidates(this.store.read(),raw)}
 strategyEditor(raw:unknown){this.ready();const input=schema(z.object({sourceId:z.string().uuid(),revision:z.number().int().nonnegative()}).strict(),raw),state=this.store.read();return strategyEditor(state,source(state,input.sourceId,input.revision))}
 reorder(raw:unknown):CatalogSourceView[]{
  this.ready();const ids=schema(z.array(z.string().uuid()).max(32),raw)
  this.store.transaction(state=>{const entries=state.proxyCatalogs??[];if(ids.length!==entries.length||new Set(ids).size!==entries.length||ids.some(id=>!entries.some(s=>s.id===id)))throw new Error('来源列表已变化，请重新打开');state.proxyCatalogs=ids.map(id=>entries.find(s=>s.id===id)!)})
  return this.list()
 }
 page(raw:unknown):CatalogPage{
  this.ready();const input=schema(catalogPageSchema,raw)
  const catalog=input.ticket?this.pending.get(input.ticket)?.catalog:source(this.store.read(),input.sourceId!,input.revision).catalog
  if(!catalog)throw new Error('目录预览已过期，请重新预览')
  let rows:CatalogRow[]
  if(input.kind==='nodes')rows=catalog.nodes.map(row)
  else if(input.kind==='groups')rows=catalog.groups.map(g=>({id:g.id,name:g.name,kind:'group',protocol:g.kind,error:g.error,memberCount:g.members.length,issueCount:g.issues.length}))
  else{const group=catalog.groups.find(g=>g.id===input.itemId);if(!group)throw new Error('请选择目录中的分组');rows=group.issues.map((issue,i)=>({id:String(i),name:issue.name,kind:'issue',error:issue.error}))}
  const query=input.query.trim().toLowerCase();rows=rows.filter(r=>r.name.toLowerCase().includes(query))
  const pageRows=rows.slice((input.page-1)*input.pageSize,input.page*input.pageSize)
  for(const row of pageRows)if(row.kind==='group')try{
   const ids=new Set(catalogGroupNodeIds(catalog,row.id)),nodes=catalog.nodes.filter(n=>ids.has(n.id)&&n.native&&insecureDefinition(n.native))
   row.insecure=nodes.length>0;row.tlsAllowed=nodes.length>0&&nodes.every(n=>!n.error)
  }catch{/* Broken structural groups keep diagnostics; permissions remain available per node. */}
  return {page:input.page,pageSize:input.pageSize,total:rows.length,rows:pageRows}
 }
 resolve(raw:unknown):CatalogResolution{
  this.ready();const input=schema(catalogResolveSchema,raw),catalog=source(this.store.read(),input.sourceId,input.revision).catalog
  const nodes=new Map(catalog.nodes.map(n=>[n.name,n])),groups=new Map(catalog.groups.map(g=>[g.name,g])),root=[...catalog.nodes,...catalog.groups].find(n=>n.id===input.itemId)
  if(!root||root.error||builtinNames.has(root.name))catalogFail(root?.error??'PROXY_RESOURCE_INVALID')
  const active=new Set<string>();let work=0
  const visit=(name:string,depth:number):typeof catalog.groups[number]|undefined=>{
   if(blockingNames.has(name))return
   if(++work>4096||depth>16||active.has(name))catalogFail('PROXY_RESOURCE_INVALID')
   const node=nodes.get(name);if(node){if(node.error||!node.native)catalogFail(node.error??'PROXY_UNSUPPORTED_OPTION');return}
   const group=groups.get(name);if(!group||group.error)catalogFail(group?.error??'PROXY_RESOURCE_INVALID')
   let members=group.members
   if(group.kind==='select'){
    if(!Object.hasOwn(input.selections,group.id))return group
    const selected=input.selections[group.id];if(!members.includes(selected))catalogFail('PROXY_RESOURCE_INVALID');members=[selected]
   }
   active.add(name)
   for(const member of members){const required=visit(member,depth+1);if(required){active.delete(name);return required}}
   active.delete(name)
  }
  const required=visit(root.name,0)
  if(required){
   const query=input.query.toLowerCase(),members=required.members.filter(name=>name.toLowerCase().includes(query)),options=members.slice((input.page-1)*25,input.page*25).map(name=>({name,error:blockingNames.has(name)?undefined:builtinNames.has(name)?'PROXY_UNSUPPORTED_OPTION':nodes.has(name)?nodes.get(name)!.error:groups.has(name)?groups.get(name)!.error:'SUBSCRIPTION_GROUP_MEMBER_MISSING'}))
   return {ready:false,name:root.name,selection:{id:required.id,name:required.name,page:input.page,total:members.length,options}}
  }
  const graph=freezeProxyCatalog(catalog,root.id,input.selections)
  return {ready:true,name:root.name,nodes:graph.proxies.length,groups:graph.groups.length}
 }
 preview(raw:unknown):CatalogPreview{
  return this.prepare(raw)
 }
 importSubscription(name:string,url:string,download:SubscriptionDownload):CatalogPreview{return this.prepare({action:'import',name,input:download.body},{url,usage:download.usage})}
 refreshSubscription(id:string,revision:number,download:SubscriptionDownload):void{
  this.ready();const before=source(this.store.read(),id,revision)
  if(before.kind!=='subscription'||!before.url)throw new Error('此来源不是订阅')
  const parsed=parseProxyCatalog(download.body)
  for(const node of parsed.nodes)if(node.error==='PROXY_TLS_INSECURE'&&before.catalog.nodes.some(old=>old.id===node.id&&!old.error&&isDeepStrictEqual(old.native,node.native)))node.error=undefined
  const catalog=analyzeCatalog(parsed)
  this.store.transaction(state=>{const s=source(state,id,revision);s.catalog=catalog;s.revision++;s.updatedAt=this.now();s.lastAttemptAt=s.updatedAt;delete s.error;if(download.usage)s.usage=download.usage;invalidateDefault(s);syncUnifiedCatalog(state,s,this.inUse);bounds(state)})
 }
 syncPendingSubscription():void{
  this.ready();const before=this.store.read();if(!before.unifiedProxy?.pending)return
  const after=structuredClone(before),resource=after.proxyResources?.find(r=>r.id===after.unifiedProxy?.resourceId),s=after.proxyCatalogs?.find(s=>s.id===resource?.catalog?.sourceId)
  if(!s)return
  syncUnifiedCatalog(after,s,this.inUse)
  if(!isDeepStrictEqual(before.unifiedProxy,after.unifiedProxy))this.store.transaction(state=>{const current=source(state,s.id,s.revision);syncUnifiedCatalog(state,current,this.inUse);bounds(state)})
 }
 private prepare(raw:unknown,subscription?:{url:string;usage?:SubscriptionUsage}):CatalogPreview{
  this.ready();if(this.pending.size>=6)throw new Error('目录预览过多，请关闭旧预览')
  const input=schema(catalogChangeSchema,raw),before=this.store.read(),after=structuredClone(before),ticket=randomUUID(),creating=input.action==='import'||input.action==='strategy'&&!input.sourceId,sourceId=creating?randomUUID():input.sourceId!,createdResource=randomUUID(),updatedAt=this.now()
  if(input.action==='strategy'&&((input.sourceId===undefined)!==(input.revision===undefined)))throw new Error('请选择完整的策略版本')
  const strategy=input.action==='strategy'?buildStrategy(before,input,sourceId):undefined
  let parsed:ParsedProxyCatalog|undefined=strategy?.catalog,tlsNames:string[]|undefined
  if(input.action==='import'||input.action==='replace')parsed=parseProxyCatalog(input.input)
  if(!creating)source(before,input.sourceId!,input.revision)
  if((input.action==='import'||input.action==='strategy')&&(before.proxyCatalogs??[]).some(s=>s.id!==sourceId&&s.name.toLowerCase()===input.name.toLowerCase()))throw new Error('代理来源名称已存在')
  if(input.action==='tls'){
   const catalog=source(before,input.sourceId,input.revision).catalog
   const ids=input.group?catalogGroupNodeIds(catalog,input.itemId):[input.itemId]
   const nodes=ids.map(id=>catalog.nodes.find(n=>n.id===id)).filter((n):n is CatalogNode=>!!n&&!!n.native&&insecureDefinition(n.native))
   if(!nodes.length)throw new Error('所选资源没有可调整的证书例外')
   parsed=setCatalogTLSApproval(catalog,nodes.map(n=>n.id),input.allow);tlsNames=nodes.map(n=>n.name)
  }
  // Capture parsed data and safe parameters, not a whole account/credential snapshot.
  // Raw input is cleared from the captured action once parsing has completed.
  if(input.action==='import'||input.action==='replace')input.input=''
  const change=(state:State):void=>{
   state.proxyCatalogs??=[];state.proxyResources??=[]
   if(input.action==='import'||input.action==='strategy'&&!input.sourceId){if(subscription&&state.proxyCatalogs.some(s=>s.url===subscription.url))throw new Error('此订阅已经导入');state.proxyCatalogs.push({id:sourceId,revision:0,name:input.name,kind:strategy?'strategy':subscription?'subscription':'manual',catalog:structuredClone(parsed!),updatedAt,...strategy?{strategyMembers:structuredClone(strategy.records)}:{},...subscription?{url:subscription.url,usage:subscription.usage,autoUpdate:false}:{}});bounds(state);return}
   const s=source(state,sourceId,input.revision)
   if(input.action==='remove'){
    const removed=new Set(state.proxyResources.filter(r=>r.catalog?.sourceId===s.id).map(r=>r.id))
    state.proxyResources=state.proxyResources.filter(r=>!removed.has(r.id));state.proxyCatalogs=state.proxyCatalogs.filter(c=>c.id!==s.id)
    if(state.unifiedProxy?.resourceId&&removed.has(state.unifiedProxy.resourceId))state.unifiedProxy={mode:'off'}
    for(const a of state.accounts)if(a.proxy?.mode==='resource'&&removed.has(a.proxy.resourceId!)){delete a.proxy;a.revision=(a.revision??0)+1}
    return
   }
   if(input.action==='strategy'){s.name=input.name;s.catalog=structuredClone(parsed!);s.strategyMembers=structuredClone(strategy!.records);s.revision++;s.updatedAt=updatedAt;invalidateDefault(s);syncUnifiedCatalog(state,s,this.inUse)}else if(input.action==='bind'){
    if((input.resourceId===undefined)!==(input.resourceRevision===undefined))throw new Error('请选择完整的资源版本')
    const existing=input.resourceId?state.proxyResources.find(r=>r.id===input.resourceId):undefined
    if(input.resourceId&&(!existing||existing.revision!==input.resourceRevision||existing.catalog?.sourceId!==s.id))throw new Error('代理资源已变化，请重新选择')
    if(state.proxyResources.some(r=>r.id!==existing?.id&&r.name.toLowerCase()===input.name.toLowerCase()))throw new Error('代理资源名称已存在')
    const graph=freezeProxyCatalog(s.catalog,input.itemId,input.selections),bound:StoredProxyResource={id:existing?.id??createdResource,revision:existing?existing.revision+1:0,name:input.name,url:encodeCatalogBinding(graph),catalog:{sourceId:s.id,itemId:input.itemId,revision:s.revision,selections:structuredClone(input.selections)}}
    if(existing){Object.assign(existing,bound);clearUnifiedSnapshot(state,existing.id)}else state.proxyResources.push(bound)
   }else{
    s.revision++;if(s.kind!=='subscription')s.updatedAt=updatedAt
    if(input.action==='rename'){if(state.proxyCatalogs.some(c=>c.id!==s.id&&c.name.toLowerCase()===input.name.toLowerCase()))throw new Error('代理来源名称已存在');s.name=input.name;if(s.kind==='strategy'){renameStrategy(s,input.name);syncUnifiedCatalog(state,s,this.inUse)}}
    else if(input.action==='clear-default'){delete s.default;s.defaultInvalidated=false}
    else if(input.action==='default'){freezeProxyCatalog(s.catalog,input.itemId,input.selections);s.default={itemId:input.itemId,selections:structuredClone(input.selections)};s.defaultInvalidated=false}
    else if(input.action==='auto-update'){if(s.kind!=='subscription'||!s.url)throw new Error('只有订阅来源支持自动更新');s.autoUpdate=input.enabled}
    else{if(input.action==='replace'&&s.kind!=='manual')throw new Error('订阅请使用刷新，自建策略请使用编辑策略');s.catalog=structuredClone(parsed!);rebind(state,s)}
   }
   bounds(state)
  }
  change(after)
  const changed=affected(before,after),s=(input.action==='remove'?before:after).proxyCatalogs!.find(s=>s.id===sourceId)!,summary=view(after,s)
  const bytes=Buffer.byteLength(JSON.stringify(s.catalog))+Buffer.byteLength(JSON.stringify(input))
  if([...this.pending.values()].reduce((sum,p)=>sum+p.bytes,bytes)>maxBytes)throw new Error('目录预览内容过多，请关闭旧预览')
  this.pending.set(ticket,{expires:this.now()+300000,fingerprint:fingerprint(before),change,catalog:s.catalog,bytes})
  return {ticket,action:input.action,name:s.name,nodes:summary.nodes,groups:summary.groups,invalid:summary.invalid,affected:changed,busy:changed.filter(a=>this.inUse(a.id)),resourceCount:input.action==='remove'?(before.proxyResources??[]).filter(r=>r.catalog?.sourceId===sourceId).length:summary.resources,invalidResources:(after.proxyResources??[]).filter(r=>r.catalog?.sourceId===sourceId&&r.catalog.invalid).length,clearsBindings:input.action==='remove'?before.accounts.filter(a=>a.proxy?.mode==='resource'&&before.proxyResources?.some(r=>r.id===a.proxy?.resourceId&&r.catalog?.sourceId===sourceId)).length:0,disablesUnified:before.unifiedProxy?.mode==='all_accounts'&&after.unifiedProxy?.mode==='off',tlsNames,tlsAllow:input.action==='tls'?input.allow:undefined,...strategy?{duplicateNames:strategy.duplicates,deferredUnified:!!after.unifiedProxy?.pending&&!!after.proxyResources?.some(r=>r.id===after.unifiedProxy?.resourceId&&r.catalog?.sourceId===sourceId)}:{},...input.action==='remove'?{strategyNames:before.proxyCatalogs!.filter(c=>c.kind==='strategy'&&c.strategyMembers?.some(m=>m.sourceId===sourceId)).map(c=>c.name)}:{},...input.action==='auto-update'?{autoUpdate:input.enabled}:{}}
 }
 apply(raw:unknown):void{
  this.ready();const {ticket}=schema(z.object({ticket:z.string().uuid(),confirmed:z.literal(true)}).strict(),raw),pending=this.pending.get(ticket)
  if(!pending)throw new Error('目录预览已过期，请重新预览')
  const before=this.store.read()
  if(fingerprint(before)!==pending.fingerprint){this.pending.delete(ticket);throw new Error('目录、资源或账号已变化，请重新预览')}
  const after=structuredClone(before);pending.change(after)
  if(affected(before,after).some(a=>this.inUse(a.id)))throw new Error('受影响账号正在使用，请停止服务、刷新或检测后重试')
  this.store.transaction(pending.change);this.pending.delete(ticket)
 }
 discard(raw:unknown):void{this.pending.delete(schema(z.string().uuid(),raw))}
 stop():void{this.stopped=true;this.pending.clear()}
}
