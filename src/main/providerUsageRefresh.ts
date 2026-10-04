import {randomUUID} from 'node:crypto'
import {providerUsageInputSchema,type ProviderUsageRefresh,type ProviderUsageState} from '../shared/providerUsage'
import type {Store,StoredAccount} from './store'
import type {StoredProvider} from './providerLibrary'
import {queryProviderUsage,ProviderUsageUnavailable,ProviderUsageRejected} from './providerUsage'
import {HTTPError,requestJSON,type JSONRequest} from './network'
import {providerNetworkTarget} from './providerNetworkTarget'

type Target={id:string;apiKey:string}
const empty=():ProviderUsageRefresh=>({running:false,cancelled:false,total:0,completed:0,failed:0,activeKeyIds:[]})
export class ProviderUsageQueries {
  private state=empty()
  private job?:Promise<void>
  private controller?:AbortController
  private provider?:StoredProvider
  constructor(private readonly store:Store,private readonly request:JSONRequest=requestJSON){}
  snapshot():ProviderUsageRefresh{this.invalidate();return structuredClone(this.state)}
  private current(provider:StoredProvider):boolean{return this.store.read().providers?.some(p=>p.id===provider.id&&p.revision===provider.revision)??false}
  invalidate():void{
    if(this.state.running&&this.provider&&!this.current(this.provider)){
      this.state.error='供应商配置已变化，剩余额度查询已取消'
      this.controller?.abort()
    }
  }
  start(raw:unknown):void{
    if(this.job)throw new Error('额度查询正在进行，请等待完成或取消')
    const input=providerUsageInputSchema.parse(raw),provider=this.store.read().providers?.find(p=>p.id===input.providerId)
    if(!provider||provider.revision!==input.revision)throw new Error('供应商已变化，请重新选择')
    const ids=new Set(input.keyIds)
    if(ids.size!==input.keyIds.length)throw new Error('不能重复查询同一密钥')
    const targets=provider.keys.filter(key=>ids.has(key.id)).map(key=>({id:key.id,apiKey:key.apiKey}))
    if(targets.length!==ids.size)throw new Error('密钥已删除或移动，请重新选择')
    this.provider=provider;this.controller=new AbortController()
    this.state={...empty(),runId:randomUUID(),providerId:provider.id,running:true,total:targets.length}
    this.job=this.run(provider,targets,this.controller.signal).finally(()=>{this.job=undefined;this.provider=undefined;this.controller=undefined})
  }
  cancel(runId:string):void{
    if(runId!==this.state.runId)throw new Error('查询批次已变化，请刷新后重试')
    this.controller?.abort()
  }
  async settled():Promise<void>{await this.job}
  async stop():Promise<void>{this.controller?.abort();await this.job}
  private async run(provider:StoredProvider,targets:Target[],signal:AbortSignal):Promise<void>{
    let index=0
    const worker=async()=>{
      while(index<targets.length&&!signal.aborted){
        if(!this.current(provider)){this.invalidate();break}
        const key=targets[index++]
        let failed=false
        this.state.activeKeyIds.push(key.id)
        try{
          // A transient transport target only. No account, gateway or model call
          // is created; library queries use the saved provider URL and key.
          let result:ProviderUsageState
          try{const target=providerNetworkTarget(this.store.read(),provider,key);result={summary:await queryProviderUsage(target,signal,this.request),checkedAt:Date.now()}}
          catch(error){
            if(signal.aborted||!this.current(provider)){this.invalidate();continue}
            failed=true
            result={checkedAt:Date.now(),unavailable:error instanceof ProviderUsageUnavailable,
              error:error instanceof HTTPError||error instanceof ProviderUsageUnavailable||error instanceof ProviderUsageRejected?error.message:'额度查询失败，请检查连接或配置后重试'}
          }
          if(signal.aborted||!this.current(provider)){this.invalidate();continue}
          try{
            this.store.transaction(state=>{
              const current=state.providers?.find(p=>p.id===provider.id&&p.revision===provider.revision)
              const saved=current?.keys.find(k=>k.id===key.id&&k.apiKey===key.apiKey)
              if(!saved)return
              saved.usage={...result,...(result.error&&saved.usage?.summary?{summary:saved.usage.summary}:{})}
            })
          }catch{failed=true;this.state.error='额度结果无法保存，请检查本地数据存储后重试'}
        }finally{this.state.activeKeyIds=this.state.activeKeyIds.filter(id=>id!==key.id);this.state.completed++;if(failed)this.state.failed++}
      }
    }
    try{await Promise.all(Array.from({length:Math.min(3,targets.length)},worker))}
    finally{this.state.running=false;this.state.cancelled=signal.aborted;this.state.activeKeyIds=[]}
  }
}
