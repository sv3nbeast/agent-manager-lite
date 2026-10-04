import { isIP } from 'node:net'
import { z } from 'zod'
import type { Store } from './store'
import { defaultProxyURL, proxyAddressView, type ProxyState } from './proxyPolicy'
import { normalizeDirectProxy } from './proxyDirect'
import type { AccountNetwork } from './accountNetwork'
import { upstreamProxyInputSchema, upstreamProxyProbeSchema, type UpstreamProxyView } from '../shared/upstreamProxy'
import type { ProxyProbeResult } from '../shared/accountProxy'

export function upstreamProxyView(state:ProxyState):UpstreamProxyView {
  const saved=state.upstreamProxy,revision=saved?.revision??0,mode=saved?.mode??'inherit'
  try {
    const url=defaultProxyURL(state)
    return {...(url&&url!=='direct'?proxyAddressView(url):{}),revision,mode}
  } catch { return {revision,mode,invalid:true} }
}

/** Manual default only; no subscriptions, catalogues, engines or implicit fallback. */
export class UpstreamProxies {
  private probes=new Map<string,{controller:AbortController;task:Promise<ProxyProbeResult>}>()
  private cancelled=new Map<string,number>()
  private stopped=false
  constructor(private readonly store:Store,private readonly network:Pick<AccountNetwork,'through'>,
    private readonly inUse:()=>boolean=()=>false,private readonly probeURL='https://api64.ipify.org?format=json'){}
  private current(revision:number) {
    const state=this.store.proxyState()
    if((state.upstreamProxy?.revision??0)!==revision)throw new Error('默认网络代理已变化，请重新打开设置')
    return state
  }
  private resolve(mode:string,url:string|undefined,state:ProxyState):string {
    if(mode!=='custom'&&url!==undefined)throw new Error('此模式不接受代理地址')
    if(mode==='inherit'||mode==='direct')return 'direct'
    if(mode==='saved')return defaultProxyURL(state)??'direct'
    return normalizeDirectProxy(url??(state.upstreamProxy?.mode==='custom'?state.upstreamProxy.url:'')??'')
  }
  save(raw:unknown):void {
    const input=upstreamProxyInputSchema.parse(raw),state=this.current(input.revision)
    if(this.stopped||this.inUse()||this.probes.size)throw new Error('上游请求或服务正在使用网络，请停止后保存代理设置')
    const url=this.resolve(input.mode,input.url,state)
    this.store.transaction(value=>{value.upstreamProxy={revision:input.revision+1,mode:input.mode,...(input.mode==='custom'?{url}:{})}})
  }
  probe(raw:unknown):Promise<ProxyProbeResult> {
    const input=upstreamProxyProbeSchema.parse(raw),state=this.current(input.revision)
    for(const [id,at] of this.cancelled)if(Date.now()-at>=30000)this.cancelled.delete(id)
    if(this.cancelled.delete(input.requestId))throw new Error('出口测试已取消')
    if(this.stopped||this.probes.size>=4||this.probes.has(input.requestId))throw new Error('出口测试正在进行，请等待或取消')
    const proxy=this.resolve(input.mode,input.url,state),controller=new AbortController(),started=Date.now()
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(13000)])
    const task=Promise.resolve().then(async()=>{
      const value=await this.network.through(proxy)(this.probeURL,{signal,headers:{Accept:'application/json'}},'检测出口')
      signal.throwIfAborted();this.current(input.revision)
      if(typeof value.ip!=='string'||!isIP(value.ip))throw new Error('出口测试未返回有效 IP')
      return {requestId:input.requestId,ip:value.ip,latencyMs:Date.now()-started,checkedAt:Date.now()}
    }).finally(()=>this.probes.delete(input.requestId))
    this.probes.set(input.requestId,{controller,task});return task
  }
  async cancel(raw:unknown):Promise<void> {
    const id=z.string().uuid().parse(raw),probe=this.probes.get(id)
    if(probe){probe.controller.abort();await probe.task.catch(()=>{});return}
    for(const [key,at] of this.cancelled)if(Date.now()-at>=30000)this.cancelled.delete(key)
    if(this.cancelled.size>=128)throw new Error('取消请求过多，请稍后重试')
    this.cancelled.set(id,Date.now())
  }
  async stop():Promise<void> {
    this.stopped=true;this.cancelled.clear()
    for(const value of this.probes.values())value.controller.abort()
    await Promise.allSettled([...this.probes.values()].map(value=>value.task))
  }
}
