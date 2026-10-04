import { z } from 'zod'
import { providerModelsInputSchema, type ProviderModelsResult } from '../shared/providerModels'
import { providerEndpoint } from '../shared/providerLibrary'
import type { Store } from './store'
import { probeJSON, probeModelList } from './providerProbe'
import {providerNetworkTarget,type UpstreamFetch} from './providerNetworkTarget'

/** Draft discovery never writes credentials or sends a conversation request. */
export class ProviderModels {
  private active?: { id:string; controller:AbortController; task:Promise<ProviderModelsResult> }
  constructor(private readonly store:Store, private readonly timeoutMs=20_000,private readonly fetchUpstream:UpstreamFetch=fetch) {}
  fetch(raw:unknown):Promise<ProviderModelsResult> {
    const input=providerModelsInputSchema.parse(raw)
    if(this.active)throw new Error('正在获取模型，请等待或取消当前请求')
    const saved=input.savedKey
    const resolveKey=()=>{
      if(!saved)return input.apiKey
      const provider=this.store.read().providers?.find(p=>p.id===saved.providerId)
      const key=provider?.keys.find(k=>k.id===saved.keyId)
      if(!provider || !key || provider.revision!==saved.revision)throw new Error('供应商或密钥已变化，请重新打开表单')
      if(providerEndpoint(provider.baseUrl)!==providerEndpoint(input.baseUrl))throw new Error('地址已更改，请填写此地址的密钥后获取模型')
      return key.apiKey
    }
    const apiKey=resolveKey(), controller=new AbortController(), timeout=AbortSignal.timeout(this.timeoutMs)
    const state=this.store.read(),provider=saved?state.providers?.find(p=>p.id===saved.providerId):undefined
    const account=provider&&saved?providerNetworkTarget(state,provider,{id:saved.keyId,apiKey:apiKey!}):undefined
    const task=(async()=>{
      try {
        const {body}=await probeJSON(`${input.baseUrl.replace(/\/+$/,'')}/models`,{
          headers:{Accept:'application/json',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})}
        },AbortSignal.any([controller.signal,timeout]),(url,init)=>this.fetchUpstream(url,init,account))
        // A key rotation / deletion during the network request invalidates its result.
        resolveKey()
        if(controller.signal.aborted)throw new Error('cancelled')
        return {requestId:input.requestId,...probeModelList(body,apiKey?[apiKey]:[])}
      } catch(error) {
        if(controller.signal.aborted)throw new Error('已取消获取模型')
        if(timeout.aborted)throw new Error('获取模型超时，请检查接口地址后重试')
        throw error
      } finally { if(this.active?.id===input.requestId)this.active=undefined }
    })()
    this.active={id:input.requestId,controller,task}
    return task
  }
  async cancel(raw:unknown):Promise<void> {
    const id=z.string().uuid().parse(raw),active=this.active
    if(active?.id!==id)return
    active.controller.abort();await active.task.catch(()=>{})
  }
  async stop():Promise<void> {this.active?.controller.abort();await this.active?.task.catch(()=>{})}
}
