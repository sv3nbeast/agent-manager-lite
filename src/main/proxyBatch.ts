// Batch selection/overwrite semantics follow Cockpit's codexProxyBatch/Assignment.
// Local resource writes have no tunnel rebuild: publish one atomic vault transaction.
import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {Store,State} from './store'
import {accountProxyView,legacyProxyEligible,proxyResource,type StoredProxyResource} from './proxyPolicy'
import {prepareProxyImport} from './proxyImport'
import {applyProxyBatchSchema,proxyImportInputSchema,proxyAssignmentSchema,type ProxyImportPreview,type ProxyAssignmentInput,type ProxyAssignmentPreview} from '../shared/proxyBatch'

type Operation={kind:'import';resources:StoredProxyResource[]}|{kind:'assign';input:ProxyAssignmentInput}
type Pending={operation:Operation;fingerprint:string;expires:number}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fingerprint(state:State,operation:Operation):string {
  if(operation.kind==='import')return digest(state.proxyResources??[])
  const selected=new Set(operation.input.accountIds)
  return digest([state.upstreamProxy,state.proxyResources,state.unifiedProxy,state.accounts.filter(a=>selected.has(a.id)).map(a=>[a.id,a.generation,a.revision,a.kind,a.providerId,!!a.credentials.accessToken,a.proxy])])
}
function assignment(state:State,input:ProxyAssignmentInput,inUse:(id:string)=>boolean):ProxyAssignmentPreview {
  if(new Set(input.accountIds).size!==input.accountIds.length)throw new Error('账号选择不能重复')
  if(input.mode!=='resource'&&(input.resourceId!==undefined||input.resourceRevision!==undefined))throw new Error('此模式不接受代理资源')
  const resource=input.mode==='resource'?proxyResource(state,input.resourceId,input.resourceRevision??-1):undefined
  const accounts=new Map(state.accounts.map(a=>[a.id,a]))
  const rows=input.accountIds.map(id=>{
    const account=accounts.get(id);if(!account)throw new Error('所选账号已不存在，请重新选择')
    if(!legacyProxyEligible(account))return {id,name:account.name,status:'ineligible' as const,overwrite:false,busy:false}
    const same=input.mode==='inherit'?!account.proxy:input.mode==='direct'?account.proxy?.mode==='direct':account.proxy?.mode==='resource'&&account.proxy.resourceId===resource!.id
    const next={...account,proxy:input.mode==='inherit'?undefined:input.mode==='direct'?{mode:'direct' as const}:{mode:'resource' as const,resourceId:resource!.id}}
    // Do not bind a broken inherited setting; direct/resource can explicitly repair it.
    const after=accountProxyView(next,state);if(after?.invalid)throw new Error('目标代理配置无效，请先修复或选择有效资源')
    return {id,name:account.name,status:same?'same' as const:'change' as const,overwrite:!same&&!!account.proxy,before:accountProxyView(account,state),after,busy:!same&&inUse(id)}
  })
  return {mode:input.mode,resourceName:resource?.name,rows,changed:rows.filter(r=>r.status==='change').length,same:rows.filter(r=>r.status==='same').length,ineligible:rows.filter(r=>r.status==='ineligible').length,overwritten:rows.filter(r=>r.overwrite).length,busy:rows.filter(r=>r.busy).length}
}
export class ProxyBatch {
  private readonly pending=new Map<string,Pending>()
  private stopped=false
  constructor(private readonly store:Store,private readonly inUse:(id:string)=>boolean=()=>false,private readonly now=Date.now){}
  private ready():void {
    if(this.stopped)throw new Error('应用正在退出')
    for(const [ticket,pending] of this.pending)if(pending.expires<=this.now())this.pending.delete(ticket)
    if(this.pending.size>=10)throw new Error('批量预览过多，请关闭旧预览后重试')
  }
  private remember(operation:Operation,state:State):string {
    const ticket=randomUUID();this.pending.set(ticket,{operation,fingerprint:fingerprint(state,operation),expires:this.now()+300000});return ticket
  }
  previewImport(raw:unknown):ProxyImportPreview {
    this.ready();const input=proxyImportInputSchema.parse(raw),state=this.store.read(),prepared=prepareProxyImport(input.input,input.options,state.proxyResources??[])
    if(!prepared.preview.blocked)prepared.preview.ticket=this.remember({kind:'import',resources:prepared.resources},state)
    return prepared.preview
  }
  previewAssignment(raw:unknown):ProxyAssignmentPreview {
    this.ready();const input=proxyAssignmentSchema.parse(raw),state=this.store.read(),preview=assignment(state,input,this.inUse)
    if(preview.changed)preview.ticket=this.remember({kind:'assign',input},state)
    return preview
  }
  apply(raw:unknown):void {
    const {ticket}=applyProxyBatchSchema.parse(raw),pending=this.pending.get(ticket)
    if(this.stopped||!pending||pending.expires<=this.now()){this.pending.delete(ticket);throw new Error('批量预览已过期，请重新预览')}
    const state=this.store.read(),operation=pending.operation
    if(fingerprint(state,operation)!==pending.fingerprint){this.pending.delete(ticket);throw new Error('账号或代理资源已变化，请重新预览')}
    if(operation.kind==='import'){
      if((state.proxyResources?.length??0)+operation.resources.length>500)throw new Error('最多保存 500 个手动代理资源')
      this.store.transaction(next=>{next.proxyResources??=[];next.proxyResources.push(...structuredClone(operation.resources))})
    }else{
      const preview=assignment(state,operation.input,this.inUse)
      if(preview.busy)throw new Error('所选账号正在使用、刷新或检测，请停止后重新预览')
      const changed=new Set(preview.rows.filter(r=>r.status==='change').map(r=>r.id)),input=operation.input
      this.store.transaction(next=>{for(const account of next.accounts)if(changed.has(account.id)){
        if(input.mode==='inherit')delete account.proxy
        else account.proxy={mode:input.mode,...input.mode==='resource'?{resourceId:input.resourceId}:{}}
        account.revision=(account.revision??0)+1
      }})
    }
    this.pending.delete(ticket)
  }
  discard(ticket:string):void{this.pending.delete(z.string().uuid().parse(ticket))}
  stop():void{this.stopped=true;this.pending.clear()}
}
