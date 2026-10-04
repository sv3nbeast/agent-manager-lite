// Cockpit codex_account_recycle_bin.rs. The single encrypted vault atomically
// commits live accounts and immutable recycled copies, without a second index.
import {createHash,randomUUID} from 'node:crypto'
import {Store,type RecycledAccount,type State} from './store'
import {sameAccount} from './accounts'
import {sameNativeAccount} from './accountIdentity'
import {providerTierForAccount} from './providerLibrary'
import {writeAccountExport} from './accountFiles'
import {accountRecyclePageSchema,accountRecyclePreviewSchema,accountRecycleApplySchema,type AccountRecyclePage,type AccountRecyclePreview,type AccountRecycleResult} from '../shared/accountRecycle'

const stamp=(entry:RecycledAccount)=>createHash('sha256').update(JSON.stringify(entry)).digest('hex')
interface Pending {view:AccountRecyclePreview;entries:RecycledAccount[];stamps:Map<string,string>;expires:number}
export class AccountRecycle {
  private snapshot?:{id:string;entries:RecycledAccount[];expires:number}
  private pending?:Pending
  private task?:Promise<AccountRecycleResult>
  private readonly controller=new AbortController()
  constructor(private readonly store:Store,private readonly now:()=>number=Date.now,private readonly inUse:(id:string)=>boolean=()=>false){}
  list():AccountRecyclePage{
    const entries=(this.store.read().accountRecycle??[]).sort((a,b)=>b.deletedAt-a.deletedAt||a.id.localeCompare(b.id))
    this.snapshot={id:randomUUID(),entries,expires:this.now()+300000}
    return this.page({snapshotId:this.snapshot.id,page:1})
  }
  page(raw:unknown):AccountRecyclePage{
    const input=accountRecyclePageSchema.parse(raw),snapshot=this.snapshot
    if(!snapshot||snapshot.id!==input.snapshotId||snapshot.expires<this.now())throw new Error('回收站列表已更新或过期，请刷新')
    const page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.entries.length/input.pageSize)))
    return {snapshotId:snapshot.id,total:snapshot.entries.length,page,pageSize:input.pageSize,items:snapshot.entries.slice((page-1)*input.pageSize,page*input.pageSize).map(({id,deletedAt,account})=>({id,deletedAt,accountId:account.id,name:account.name,email:account.email,plan:account.plan,kind:account.kind}))}
  }
  preview(raw:unknown):AccountRecyclePreview{
    if(this.task)throw new Error('回收站操作正在进行')
    const input=accountRecyclePreviewSchema.parse(raw);this.page({snapshotId:input.snapshotId,page:1})
    const wanted=new Set(input.all?this.snapshot!.entries.map(entry=>entry.id):input.ids),entries=this.snapshot!.entries.filter(entry=>wanted.has(entry.id))
    if(!entries.length||entries.length!==wanted.size)throw new Error('请选择当前回收站中的账号')
    const view:AccountRecyclePreview={ticket:randomUUID(),action:input.action,count:entries.length,names:entries.slice(0,20).map(entry=>entry.account.name)}
    const pending={view,entries,stamps:new Map(entries.map(entry=>[entry.id,stamp(entry)])),expires:this.now()+300000}
    this.validate(pending);this.pending=pending;return structuredClone(view)
  }
  private validate(pending:Pending):State{
    if(this.controller.signal.aborted)throw new Error('应用正在退出，回收站操作已取消')
    if(pending.expires<this.now())throw new Error('回收站确认已过期，请重新预览')
    const state=this.store.read(),current=new Map((state.accountRecycle??[]).map(entry=>[entry.id,entry]))
    for(const entry of pending.entries){const live=current.get(entry.id);if(!live||stamp(live)!==pending.stamps.get(entry.id))throw new Error('所选回收站记录已变化，请刷新；备份未被覆盖')}
    if(pending.view.action==='restore'){
      const restored=[...state.accounts]
      for(const entry of pending.entries){
        const account=entry.account
        if(this.inUse(account.id))throw new Error('相关账号仍在使用或刷新，请稍后恢复')
        if(restored.some(live=>live.id===account.id||sameAccount(live,account)||sameNativeAccount(live,account)))throw new Error('相同账号已存在，回收站副本已保留')
        restored.push(account)
      }
    }
    return state
  }
  discard():void{if(!this.task)this.pending=undefined}
  apply(raw:unknown,choosePath:()=>Promise<string|undefined>):Promise<AccountRecycleResult>{
    const input=accountRecycleApplySchema.parse(raw),pending=this.pending
    if(this.task)throw new Error('回收站操作正在进行')
    if(!pending||pending.view.ticket!==input.ticket)throw new Error('回收站确认已失效，请重新预览')
    this.validate(pending)
    const task=this.run(pending,input.exportFirst,choosePath);this.task=task
    void task.finally(()=>{this.task=undefined}).catch(()=>{})
    return task
  }
  private async run(pending:Pending,exportFirst:boolean,choosePath:()=>Promise<string|undefined>):Promise<AccountRecycleResult>{
    let exported=0
    try{
      if(exportFirst||pending.view.action==='export'){
        const path=await choosePath();if(!path)return {count:0,exported:0,cancelled:true}
        this.validate(pending)
        const accounts=pending.entries.map(entry=>{const account=structuredClone(entry.account);if(account.providerId&&account.defaultTier==='inherit')account.defaultTier=entry.providerDefault??'inherit';return account})
        exported=await writeAccountExport(this.store.directory,accounts,path,this.controller.signal)
      }
      this.validate(pending)
      if(pending.view.action!=='export')this.store.transaction(state=>{
        if(pending.view.action==='restore')for(const entry of pending.entries){
          const account=structuredClone(entry.account);account.generation=randomUUID();account.revision=(account.revision??0)+1
          // Keep unchanged provider links; changed or removed providers must not
          // replace the archived credential or its effective service tier.
          if(account.providerId)try{const tier=providerTierForAccount(state,account);if(account.defaultTier==='inherit'&&tier!==entry.providerDefault)throw new Error('Provider default changed')}catch{if(account.defaultTier==='inherit')account.defaultTier=entry.providerDefault??'inherit';delete account.providerId;delete account.providerKeyId}
          state.accounts.push(account)
          for(const group of state.groups)if(entry.groupIds.includes(group.id)&&!group.accountIds.includes(account.id))group.accountIds.push(account.id)
        }
        const wanted=new Set(pending.entries.map(entry=>entry.id));state.accountRecycle=(state.accountRecycle??[]).filter(entry=>!wanted.has(entry.id))
      })
      this.pending=undefined
      return {count:pending.entries.length,exported,cancelled:false}
    }catch(error){if(exported)throw new Error('账号备份已保存，但后续操作未完成：'+(error instanceof Error?error.message:'请刷新重试'));throw error}
  }
  async stop():Promise<void>{this.controller.abort();await this.task?.catch(()=>{});this.pending=undefined;this.snapshot=undefined}
}
