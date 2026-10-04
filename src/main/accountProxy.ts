import {isIP} from 'node:net'
import {z} from 'zod'
import {Store} from './store'
import {accountProxyURL,normalizeProxy,normalizeStoredProxy,proxyEligible,proxyResource} from './proxyPolicy'
import {accountProxyInputSchema,proxyProbeInputSchema,type ProxyProbeResult} from '../shared/accountProxy'
import {AccountNetwork} from './accountNetwork'
import {normalizeDirectProxy} from './proxyDirect'

export class AccountProxies {
  private readonly probes=new Map<string,{accountId:string;controller:AbortController;task:Promise<ProxyProbeResult>}>()
  private readonly cancellations=new Map<string,number>()
  private stopped=false
  constructor(private readonly store:Store,private readonly network:AccountNetwork,private readonly inUse:(id:string)=>boolean=()=>false,
    private readonly probeURL='https://api64.ipify.org?format=json'){}
  busy(id:string):boolean{return [...this.probes.values()].some(probe=>probe.accountId===id)}
  private account(id:string,revision:number){
    const account=this.store.read().accounts.find(account=>account.id===id)
    if(!account||revision!==(account.revision??0))throw new Error('账号已变化，请重新打开代理设置')
    if(!proxyEligible(account))throw new Error('此账号类型尚不支持网络代理')
    return account
  }
  save(raw:unknown):void {
    const input=accountProxyInputSchema.parse(raw),before=this.account(input.accountId,input.revision)
    if(this.stopped||this.inUse(input.accountId)||this.busy(input.accountId))throw new Error('账号正在使用或测试，请停止相关服务、刷新或测试后修改代理')
    if(input.mode!=='custom'&&input.url!==undefined)throw new Error('此模式不接受代理地址')
    if(input.mode!=='resource'&&(input.resourceId!==undefined||input.resourceRevision!==undefined))throw new Error('此模式不接受代理资源')
    if(input.mode==='resource')proxyResource(this.store.read(),input.resourceId,input.resourceRevision??-1)
    const url=input.mode==='custom'?(input.url===undefined?normalizeProxy((before.proxy?.mode==='custom'?before.proxy.url:'')??''):normalizeDirectProxy(input.url)):undefined
    this.store.transaction(state=>{
      const account=state.accounts.find(account=>account.id===input.accountId)!
      if(input.mode==='inherit')delete account.proxy
      else account.proxy={mode:input.mode,...(url?{url}:{}),...(input.mode==='resource'?{resourceId:input.resourceId}:{})}
      account.revision=(account.revision??0)+1
    })
  }
  probe(raw:unknown):Promise<ProxyProbeResult> {
    const input=proxyProbeInputSchema.parse(raw),before=this.account(input.accountId,input.revision)
    this.expireCancellations()
    if(this.cancellations.delete(input.requestId))throw new Error('出口测试已取消')
    if(this.stopped||this.probes.size>=4||this.probes.has(input.requestId)||this.busy(input.accountId))throw new Error('代理测试正在进行，请先取消或等待完成')
    if(input.mode!=='custom'&&input.url!==undefined)throw new Error('此模式不接受代理地址')
    if(input.mode!=='resource'&&(input.resourceId!==undefined||input.resourceRevision!==undefined))throw new Error('此模式不接受代理资源')
    const resolve=(account:typeof before)=>input.mode==='custom'?normalizeDirectProxy(input.url??''):input.mode==='direct'?'direct':input.mode==='resource'?
      normalizeStoredProxy(proxyResource(this.store.read(),input.resourceId,input.resourceRevision??-1).url):accountProxyURL(input.mode==='inherit'?{...account,proxy:undefined}:account,this.store.read())??'direct'
    const proxy=resolve(before)
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(13000)]),started=Date.now()
    const task=Promise.resolve().then(async()=>{
      const value=await this.network.through(proxy)(this.probeURL,{signal,headers:{Accept:'application/json'}},'检测出口')
      signal.throwIfAborted()
      const current=this.account(input.accountId,input.revision)
      if(current.generation!==before.generation)throw new Error('账号已恢复，请重新测试')
      if(resolve(current)!==proxy)throw new Error('代理配置已变化，请重新测试')
      if(typeof value.ip!=='string'||!isIP(value.ip))throw new Error('出口检测未返回有效 IP')
      return {requestId:input.requestId,ip:value.ip,latencyMs:Date.now()-started,checkedAt:Date.now()}
    }).finally(()=>this.probes.delete(input.requestId))
    this.probes.set(input.requestId,{accountId:input.accountId,controller,task});return task
  }
  private expireCancellations():void{for(const [id,time] of this.cancellations)if(Date.now()-time>=30000)this.cancellations.delete(id)}
  async cancel(id:string):Promise<void>{
    z.string().uuid().parse(id);if(this.stopped)return
    const probe=this.probes.get(id)
    if(probe){probe.controller.abort();await probe.task.catch(()=>{});return}
    this.expireCancellations()
    if(!this.cancellations.has(id)&&this.cancellations.size>=128)throw new Error('取消请求过多，请稍后重试')
    this.cancellations.set(id,Date.now())
  }
  async stop():Promise<void>{this.stopped=true;this.cancellations.clear();for(const probe of this.probes.values())probe.controller.abort();await Promise.allSettled([...this.probes.values()].map(probe=>probe.task))}
}
