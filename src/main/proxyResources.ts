// Shared exit precedence and change previews follow Cockpit's unified proxy.
// Manual resources and their references commit in the same encrypted vault.
import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {Store,State,StoredAccount} from './store'
import {accountProxyURL,normalizeProxy,normalizeStoredProxy,proxyAddressView,legacyProxyEligible,proxyResource,unifiedProxyURL} from './proxyPolicy'
import {applyProxyChangeSchema,proxyResourceChangeSchema,type ProxyResourceChange,type ProxyResourcesView,type ProxyChangePreview} from '../shared/proxyResources'

function counts(state:State){
  const eligible=state.accounts.filter(legacyProxyEligible)
  return {eligible:eligible.length,inherited:eligible.filter(a=>!a.proxy).length,independent:eligible.filter(a=>a.proxy&&a.proxy.mode!=='direct').length,direct:eligible.filter(a=>a.proxy?.mode==='direct').length}
}
export function proxyResourcesView(state:State):ProxyResourcesView {
  let unified:ProxyResourcesView['unified']={mode:'off'}
  if(state.unifiedProxy&&state.unifiedProxy.mode!=='off'){
    try{
      if(state.unifiedProxy.mode!=='all_accounts')throw 0
      const resource=proxyResource(state,state.unifiedProxy.resourceId)
      unifiedProxyURL(state)
      unified={mode:'all_accounts',resourceId:resource.id,name:resource.name,...state.unifiedProxy.pending?{pending:true}:{},...state.unifiedProxy.staleError?{staleError:state.unifiedProxy.staleError}:{}}
    }catch{unified={mode:'invalid',error:'统一代理配置无效，请重新选择资源或关闭；继承账号的请求已阻止'}}
  }
  return {...counts(state),unified,resources:(state.proxyResources??[]).map(resource=>({id:resource.id,name:resource.name,revision:resource.revision,
    address:resource.catalog?.invalid?{mode:'custom',invalid:true}:proxyAddressView(resource.url),accountCount:state.accounts.filter(a=>a.proxy?.mode==='resource'&&a.proxy.resourceId===resource.id).length,
    unified:state.unifiedProxy?.mode==='all_accounts'&&state.unifiedProxy.resourceId===resource.id,catalogSourceId:resource.catalog?.sourceId}))}
}
function fingerprint(state:State):string{
  return createHash('sha256').update(JSON.stringify([state.upstreamProxy,state.proxyResources,state.unifiedProxy,state.accounts.map(a=>[a.id,a.generation,a.revision,a.kind,a.providerId,!!a.credentials.accessToken,a.proxy])])).digest('hex')
}
function route(state:State,account:StoredAccount):string|undefined {
  try{return accountProxyURL(account,state)}catch{return '!invalid'}
}
function mutate(state:State,input:ProxyResourceChange,createdId:string):void {
  state.proxyResources??=[]
  if(input.action==='disable'){state.unifiedProxy={mode:'off'};return}
  const resource=input.action==='create'?undefined:state.proxyResources.find(r=>r.id===input.id)
  if(input.action!=='create'&&(!resource||resource.revision!==input.revision))throw new Error('代理资源已变化或不存在，请重新选择')
  if(input.action==='enable'){proxyResource(state,resource!.id);state.unifiedProxy={mode:'all_accounts',resourceId:resource!.id};return}
  if(input.action==='remove'){
    state.proxyResources=state.proxyResources.filter(value=>value.id!==resource!.id)
    if(state.unifiedProxy?.resourceId===resource!.id)state.unifiedProxy={mode:'off'}
    for(const account of state.accounts)if(account.proxy?.mode==='resource'&&account.proxy.resourceId===resource!.id){delete account.proxy;account.revision=(account.revision??0)+1}
    return
  }
  if(state.proxyResources.some(value=>value.id!==resource?.id&&value.name.toLowerCase()===input.name.toLowerCase()))throw new Error('代理资源名称已存在')
  if(input.action==='create'){
    if(state.proxyResources.length>=500)throw new Error('最多保存 500 个手动代理资源')
    state.proxyResources.push({id:createdId,revision:0,name:input.name,url:normalizeProxy(input.url)})
  }else{
    if(resource!.catalog&&input.url!==undefined)throw new Error('目录资源请在来源目录中重新选择节点或分组')
    resource!.name=input.name;resource!.url=input.url===undefined?normalizeStoredProxy(resource!.url):normalizeProxy(input.url);resource!.revision++
    if(state.unifiedProxy?.resourceId===resource!.id&&state.unifiedProxy.snapshot)state.unifiedProxy.snapshot.resourceRevision=resource!.revision
    for(const account of state.accounts)if(account.proxy?.mode==='resource'&&account.proxy.resourceId===resource!.id)account.revision=(account.revision??0)+1
  }
}
export class ProxyResources {
  private readonly pending=new Map<string,{input:ProxyResourceChange;createdId:string;fingerprint:string;expires:number}>()
  private stopped=false
  constructor(private readonly store:Store,private readonly inUse:(id:string)=>boolean=()=>false,private readonly now=Date.now){}
  private affected(before:State,after:State):{id:string;name:string}[]{const next=new Map(after.accounts.map(a=>[a.id,route(after,a)]));return before.accounts.filter(a=>route(before,a)!==next.get(a.id)).map(a=>({id:a.id,name:a.name}))}
  preview(raw:unknown):ProxyChangePreview {
    if(this.stopped)throw new Error('应用正在退出')
    for(const [id,entry] of this.pending)if(entry.expires<=this.now())this.pending.delete(id)
    if(this.pending.size>=20)throw new Error('预览过多，请关闭旧预览后重试')
    const input=proxyResourceChangeSchema.parse(raw),before=this.store.read(),after=structuredClone(before),createdId=randomUUID(),ticket=randomUUID()
    mutate(after,input,createdId)
    const affected=this.affected(before,after),resource=input.action==='disable'?undefined:(input.action==='remove'?before:after).proxyResources?.find(r=>r.id===(input.action==='create'?createdId:input.id))
    const view:ProxyChangePreview={ticket,action:input.action,name:resource?.name,address:resource?proxyAddressView(resource.url):undefined,affected,busy:affected.filter(a=>this.inUse(a.id)),...counts(after),
      disablesUnified:before.unifiedProxy?.mode==='all_accounts'&&after.unifiedProxy?.mode==='off',
      clearsBindings:input.action==='remove'?before.accounts.filter(a=>a.proxy?.mode==='resource'&&a.proxy.resourceId===input.id).length:0}
    this.pending.set(ticket,{input,createdId,fingerprint:fingerprint(before),expires:this.now()+300000})
    return view
  }
  apply(raw:unknown):void {
    const {ticket}=applyProxyChangeSchema.parse(raw),pending=this.pending.get(ticket)
    if(this.stopped||!pending||pending.expires<=this.now()){this.pending.delete(ticket);throw new Error('代理预览已过期，请重新预览')}
    const before=this.store.read()
    if(fingerprint(before)!==pending.fingerprint){this.pending.delete(ticket);throw new Error('账号或代理资源已变化，请重新预览')}
    const after=structuredClone(before);mutate(after,pending.input,pending.createdId)
    if(this.affected(before,after).some(a=>this.inUse(a.id)))throw new Error('受影响账号正在使用、刷新或检测，请停止后重新预览')
    this.store.transaction(state=>mutate(state,pending.input,pending.createdId))
    this.pending.delete(ticket)
  }
  discard(ticket:string):void{this.pending.delete(z.string().uuid().parse(ticket))}
  stop():void{this.stopped=true;this.pending.clear()}
}
