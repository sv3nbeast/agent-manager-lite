import {randomUUID,createHash} from 'node:crypto'
import {z} from 'zod'
import type {Store} from './store'
import type {ProxyCatalog} from './proxyCatalog'
import {CatalogError} from './proxyNative'
import {catalogErrors,subscriptionRequestSchema,type SubscriptionJob,type SubscriptionRequest} from '../shared/proxyCatalog'
import {downloadSubscription,subscriptionURL,SubscriptionError} from './proxySubscriptionDownload'

interface Job {view:SubscriptionJob;key:string;control:AbortController;task:Promise<void>;at:number}
const interval=6*60*60*1000
export class ProxySubscriptions {
 private jobs=new Map<string,Job>()
 private cancelled=new Map<string,number>()
 private stopped=false
 private timer?:ReturnType<typeof setInterval>
 private autoTask?:Promise<void>
 constructor(private readonly store:Store,private readonly catalog:ProxyCatalog,private readonly download=downloadSubscription,private readonly now=Date.now,private readonly suspended:()=>boolean=()=>false){}
 private ready(){
  if(this.stopped)throw new Error('应用正在退出')
  for(const [id,at] of this.cancelled)if(this.now()-at>300000)this.cancelled.delete(id)
  for(const [id,job] of this.jobs)if(job.view.phase!=='fetching'&&this.now()-job.at>300000){if(job.view.preview)this.catalog.discard(job.view.preview.ticket);this.jobs.delete(id)}
  while(this.jobs.size>=16){const oldest=[...this.jobs].find(([,job])=>job.view.phase!=='fetching');if(!oldest)break;if(oldest[1].view.preview)this.catalog.discard(oldest[1].view.preview.ticket);this.jobs.delete(oldest[0])}
 }
 list():SubscriptionJob[]{this.ready();return [...this.jobs.values()].map(j=>structuredClone(j.view))}
 begin(raw:unknown):SubscriptionJob{
  this.ready();const input=subscriptionRequestSchema.parse(raw)
  if(this.jobs.has(input.requestId))throw new Error('订阅任务编号已经使用')
  if([...this.jobs.values()].filter(j=>j.view.phase==='fetching').length>=4)throw new Error('最多同时下载 4 个订阅，请稍后重试')
  let url:string
  if(input.action==='import')url=subscriptionURL(input.url).toString()
  else{const source=this.store.read().proxyCatalogs?.find(s=>s.id===input.sourceId);if(!source||source.revision!==input.revision)throw new Error('来源已变化，请重新打开');if(source.kind!=='subscription'||!source.url)throw new Error('此来源不是订阅');url=subscriptionURL(source.url).toString()}
  const key=input.action==='refresh'?'source:'+input.sourceId:'url:'+createHash('sha256').update(url).digest('hex')
  if([...this.jobs.values()].some(j=>j.key===key&&j.view.phase==='fetching'))throw new Error('此来源正在下载')
  if(input.action==='import'&&this.store.read().proxyCatalogs?.some(s=>s.url===url))throw new Error('此订阅已经导入')
  const view:SubscriptionJob={id:input.requestId,...input.action==='refresh'?{sourceId:input.sourceId}:{},phase:'fetching',receivedBytes:0},job:Job={view,key,control:new AbortController(),at:this.now(),task:Promise.resolve()}
  this.jobs.set(view.id,job)
  if(this.cancelled.delete(view.id)){view.phase='cancelled';return structuredClone(view)}
  job.task=this.run(job,input,url)
  return structuredClone(view)
 }
 private async run(job:Job,input:SubscriptionRequest,url:string):Promise<void>{
  const timer=setTimeout(()=>job.control.abort(new SubscriptionError('订阅操作超时')),45000)
  try{
   const result=await this.download(url,job.control.signal,(receivedBytes,totalBytes)=>{if(!job.control.signal.aborted)Object.assign(job.view,{receivedBytes,totalBytes})})
   job.control.signal.throwIfAborted()
   if(this.stopped)throw new Error('stopped')
   if(input.action==='import'){
    const name=input.name??result.title??new URL(url).hostname
    job.view.preview=this.catalog.importSubscription(name,url,result);job.view.phase='preview'
   }else{this.catalog.refreshSubscription(input.sourceId,input.revision,result);job.view.phase='completed'}
  }catch(error){
   const cancelled=job.control.signal.aborted&&!(job.control.signal.reason instanceof SubscriptionError)
   job.view.phase=cancelled?'cancelled':'failed'
   const reason=job.control.signal.aborted?job.control.signal.reason:error
   job.view.error=cancelled?undefined:reason instanceof SubscriptionError?reason.message:reason instanceof CatalogError?catalogErrors[reason.code]??'订阅内容无效':'订阅处理或保存失败，原来源已保留'
   if(input.action==='refresh'&&!cancelled&&!this.stopped)try{const current=this.store.read().proxyCatalogs?.find(s=>s.id===input.sourceId);if(current?.revision===input.revision)this.store.transaction(state=>{const s=state.proxyCatalogs!.find(s=>s.id===input.sourceId&&s.revision===input.revision);if(s){s.lastAttemptAt=this.now();s.error=job.view.error}})}catch{/* Failed storage must never become a successful refresh. */}
  }finally{clearTimeout(timer);job.at=this.now()}
 }
 cancel(raw:unknown):void{
  const id=z.string().uuid().parse(raw),job=this.jobs.get(id)
  if(job?.view.phase==='fetching')job.control.abort()
  else if(job?.view.phase==='preview'){this.catalog.discard(job.view.preview!.ticket);delete job.view.preview;job.view.phase='cancelled'}
  else if(!job){if(this.cancelled.size>=64)this.cancelled.delete(this.cancelled.keys().next().value!);this.cancelled.set(id,this.now())}
 }
 async wait(id:string):Promise<SubscriptionJob|undefined>{const job=this.jobs.get(id);await job?.task;return job?structuredClone(job.view):undefined}
 schedule(){if(!this.timer&&!this.stopped){this.timer=setInterval(()=>{void this.tick().catch(()=>{})},60000);this.timer.unref()}}
 tick():Promise<void>{
  if(this.autoTask)return this.autoTask
  if(this.stopped||this.suspended())return Promise.resolve()
  const task=(async()=>{
   this.catalog.syncPendingSubscription()
   const ids=(this.store.read().proxyCatalogs??[]).filter(s=>s.kind==='subscription'&&s.url&&s.autoUpdate&&this.now()-Math.max(s.updatedAt,s.lastAttemptAt??0)>=interval).map(s=>s.id)
   for(const id of ids){
    if(this.stopped||this.suspended())return
    const s=this.store.read().proxyCatalogs?.find(s=>s.id===id)
    if(!s?.autoUpdate||s.kind!=='subscription'||this.now()-Math.max(s.updatedAt,s.lastAttemptAt??0)<interval)continue
    let job:SubscriptionJob;try{job=this.begin({action:'refresh',requestId:randomUUID(),sourceId:s.id,revision:s.revision})}catch{continue}
    await this.wait(job.id)
   }
  })();this.autoTask=task
  void task.then(()=>{if(this.autoTask===task)this.autoTask=undefined},()=>{if(this.autoTask===task)this.autoTask=undefined})
  return task
 }
 async stop():Promise<void>{this.stopped=true;clearInterval(this.timer);this.timer=undefined;for(const job of this.jobs.values())job.control.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.task));await this.autoTask?.catch(()=>{});this.jobs.clear();this.cancelled.clear()}
}
