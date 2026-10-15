import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Store } from './store'
import type { StoredProvider } from './providerLibrary'
import { providerProbeInputSchema, type ProviderProbeInput, type ProviderProbeState, type ProviderProbeRecord, type ProbeModel } from '../shared/providerProbe'
import { providerKeyModels, providerKeyProtocol, providerKeyCredentialKind } from '../shared/providerLibrary'
import { resolveServiceTier } from '../shared/serviceTier'
import { object,type JSONFetch } from './network'
import {providerNetworkTarget,providerAPIEndpoint,providerAPIHeaders,type UpstreamFetch} from './providerNetworkTarget'
import type {ProxyState} from './proxyPolicy'
import type {ProxyTunnels} from './proxyTunnels'
import type { AccountCredentialKind, AccountProtocol, Settings } from '../shared/types'

class ProbeError extends Error { constructor(message:string,readonly status?:number) { super(message) } }
type Target = { provider:StoredProvider; keyId:string; apiKey:string; models:string[]; protocol:AccountProtocol; credentialKind:AccountCredentialKind; explicitModel?:string; record:ProviderProbeRecord }
const empty = ():ProviderProbeState=>({running:false,cancelling:false,cancelled:false,total:0,completed:0,succeeded:0,failed:0,records:[]})
const knownTiers = new Set(['priority','default','auto','flex','scale','ultrafast'])
const tier = (value:unknown) => typeof value==='string' && knownTiers.has(value) ? value : undefined
export function selectProbeModel(models:string[],_wireApi:string,explicit?:string):string | undefined {
  return explicit ?? models[0]
}
function redact(value:string,secrets:string[]):string {
  for(const secret of secrets) {
    if(!secret)continue
    for(const representation of new Set([secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')])) value=value.split(representation).join('[已隐藏密钥]')
  }
  return value
}
export async function probeJSON(url:string,init:RequestInit,signal:AbortSignal,transport:JSONFetch=fetch):Promise<{body:Record<string,unknown>;status:number}> {
  signal.throwIfAborted()
  let response:Response
  try { response=await transport(url,{...init,signal,redirect:'manual'}) }
  catch { throw new ProbeError('无法连接接口，请检查地址、网络或代理') }
  if(!response.ok) {
    await response.body?.cancel().catch(()=>{})
    const hint=response.status>=300 && response.status<400 ? '接口返回重定向，请填写最终服务地址'
      : [401,403].includes(response.status) ? '接口拒绝鉴权，请检查密钥和权限'
      : response.status===404 ? '接口路径不存在，请检查 Base URL 和协议'
      : response.status===429 ? '接口限流或额度不足，请稍后再试' : '接口返回错误'
    throw new ProbeError(`${hint}（HTTP ${response.status}）`,response.status)
  }
  const reader=response.body?.getReader()
  if(!reader)throw new ProbeError('接口返回空响应',response.status)
  try {
    let size=0;const chunks:Uint8Array[]=[]
    while(true) {
      const {value,done}=await reader.read();if(done)break
      signal.throwIfAborted()
      size+=value.length;if(size>2*1024*1024)throw new Error('oversize')
      chunks.push(value)
    }
    const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'))
    signal.throwIfAborted()
    if(!body || typeof body!=='object' || Array.isArray(body))throw new Error('shape')
    return {body:body as Record<string,unknown>,status:response.status}
  } catch {throw new ProbeError('响应格式无效、读取中断或超过 2 MB',response.status)}
  finally {await reader.cancel().catch(()=>{})}
}
export function probeModelList(body:Record<string,unknown>,secrets:string[]):{models:ProbeModel[];modelsTruncated:boolean} {
  if(body.error || !Array.isArray(body.data))throw new ProbeError('模型接口未返回有效的 data 列表')
  const found=new Map<string,ProbeModel>();let count=0
  for(const entry of body.data) {
    const item=object(entry),id=typeof item.id==='string' ? item.id.trim() : ''
    if(!id || id.length>200 || /[\x00-\x1f]/.test(id) || redact(id,secrets)!==id || found.has(id))continue
    count++
    if(found.size>=1000)continue
    const name=item.display_name ?? item.displayName
    found.set(id,{id,...(typeof name==='string' && name.trim() ? {name:redact(name.trim(),secrets).slice(0,200)} : {})})
  }
  return {models:[...found.values()],modelsTruncated:count>1000}
}
/** Bound pagination and keep provider-supplied cursors on the same endpoint. */
export async function fetchProbeModels(baseUrl:string,protocol:AccountProtocol,credentialKind:AccountCredentialKind,apiKey:string|undefined,signal:AbortSignal,transport:JSONFetch=fetch,validateCurrent?:()=>unknown):Promise<{models:ProbeModel[];modelsTruncated:boolean;httpStatus:number}> {
  const endpoint=providerAPIEndpoint(baseUrl,protocol,'models'),models=new Map<string,ProbeModel>(),cursors=new Set<string>()
  let url=endpoint,httpStatus=200
  for(let page=0;page<10;page++) {
    validateCurrent?.()
    const {body,status}=await probeJSON(url,{headers:providerAPIHeaders(protocol,credentialKind,apiKey)},signal,transport)
    validateCurrent?.()
    httpStatus=status
    const parsed=probeModelList(body,apiKey?[apiKey]:[])
    let modelsTruncated=parsed.modelsTruncated
    for(const model of parsed.models) {
      if(models.has(model.id))continue
      if(models.size===1000){modelsTruncated=true;continue}
      models.set(model.id,model)
    }
    const more=protocol==='anthropic_messages'&&body.has_more===true
    if(modelsTruncated||!more||models.size===1000||page===9)return {models:[...models.values()],modelsTruncated:modelsTruncated||more,httpStatus}
    const cursor=typeof body.last_id==='string'?body.last_id:''
    if(!cursor||cursor.length>1000||/[\x00-\x1f\x7f]/.test(cursor)||cursors.has(cursor)||apiKey&&redact(cursor,[apiKey])!==cursor)throw new ProbeError('模型接口返回无效的分页信息')
    cursors.add(cursor)
    const next=new URL(endpoint);next.searchParams.set('after_id',cursor);url=next.href
  }
  return {models:[...models.values()],modelsTruncated:true,httpStatus}
}
function responseText(body:Record<string,unknown>):string {
  if(body.error || body.status!==undefined && body.status!=='completed')throw new ProbeError('对话未正常完成，请检查模型支持和输出限制')
  const text = typeof body.output_text==='string' ? body.output_text : Array.isArray(body.output)
    ? body.output.flatMap(item=>Array.isArray(object(item).content) ? object(item).content as unknown[] : [])
      .filter(item=>object(item).type==='output_text').map(item=>typeof object(item).text==='string' ? object(item).text : '').join('') : ''
  if(!text.trim())throw new ProbeError('对话返回成功状态，但没有可读回复')
  return text
}
function chatText(body:Record<string,unknown>,protocol:AccountProtocol):string {
  if(protocol==='openai_responses')return responseText(body)
  if(body.error)throw new ProbeError('对话未正常完成，请检查模型支持和输出限制')
  let text=''
  if(protocol==='anthropic_messages') {
    if(body.stop_reason!==undefined&&!['end_turn','stop_sequence'].includes(String(body.stop_reason)))throw new ProbeError('对话未正常完成，请检查模型支持和输出限制')
    text=Array.isArray(body.content)?body.content.filter(item=>object(item).type==='text').map(item=>typeof object(item).text==='string'?object(item).text:'').join(''):''
  } else if(Array.isArray(body.choices)) {
    if(body.choices.some(choice=>object(choice).finish_reason!==undefined&&object(choice).finish_reason!=='stop'))throw new ProbeError('对话未正常完成，请检查模型支持和输出限制')
    text=body.choices.map(choice=>{
      const content=object(object(choice).message).content
      return typeof content==='string'?content:Array.isArray(content)?content.filter(item=>object(item).type==='text').map(item=>typeof object(item).text==='string'?object(item).text:'').join(''):''
    }).join('')
  }
  if(!text.trim())throw new ProbeError('对话返回成功状态，但没有可读回复')
  return text
}

export class ProviderProbes {
  private state=empty()
  private task?:Promise<void>
  private controller?:AbortController
  private active?:{target:Target;controller:AbortController}
  constructor(private readonly store:Store,_binary:string,_runtimeRoot:string,
    private readonly timeouts={models:20_000,chat:90_000},private readonly fetchUpstream:UpstreamFetch=fetch,
    _proxyState:()=>ProxyState=()=>({}),_tunnels?:Pick<ProxyTunnels,'acquire'>) {}
  snapshot():ProviderProbeState {this.invalidate();return structuredClone(this.state)}
  private current(target:Target):boolean {
    const provider=this.store.read().providers?.find(p=>p.id===target.provider.id)
    return provider?.revision===target.provider.revision && provider.keys.some(k=>k.id===target.keyId && k.apiKey===target.apiKey)
  }
  invalidate():void {if(this.active && !this.current(this.active.target))this.active.controller.abort()}
  start(raw:unknown):ProviderProbeState {
    if(this.task)throw new Error('已有测试正在运行，请先取消或等待完成')
    const input=providerProbeInputSchema.parse(raw),state=this.store.read(),seen=new Set<string>()
    const targets=input.targets.map(selection=>{
      const identity=`${selection.providerId}/${selection.keyId}`
      if(seen.has(identity))throw new Error('同一密钥不能重复加入测试')
      seen.add(identity)
      const provider=state.providers?.find(p=>p.id===selection.providerId),key=provider?.keys.find(k=>k.id===selection.keyId)
      if(!provider || provider.revision!==selection.revision || !key)throw new Error('供应商或密钥已变化，请重新选择测试目标')
      const protocol=providerKeyProtocol(provider,key),credentialKind=providerKeyCredentialKind(provider,key)
      const record:ProviderProbeRecord={providerId:provider.id,providerRevision:provider.revision,providerName:provider.name,
        keyId:key.id,keyName:key.name,baseUrl:provider.baseUrl,protocol,wireApi:protocol==='openai_responses'?'responses':'chat_completions',status:'pending',stage:'queued'}
      return {provider,keyId:key.id,apiKey:key.apiKey,models:providerKeyModels(provider,key),protocol,credentialKind,explicitModel:selection.model,record}
    })
    this.state={...empty(),runId:randomUUID(),mode:input.mode,running:true,total:targets.length,records:targets.map(target=>target.record)}
    this.controller=new AbortController()
    this.task=this.run(targets,input,state.settings,this.controller.signal).finally(()=>{this.task=undefined;this.controller=undefined})
    return this.snapshot()
  }
  cancel(runId:string):ProviderProbeState {
    if(this.state.runId!==runId)throw new Error('测试批次已变化，请刷新后重试')
    if(this.state.running) {this.state.cancelling=true;this.state.cancelled=true;this.controller?.abort()}
    return this.snapshot()
  }
  async stop():Promise<void> {this.controller?.abort();await this.task}
  async settled():Promise<void> {await this.task}
  private async run(targets:Target[],input:ProviderProbeInput,settings:Settings,signal:AbortSignal):Promise<void> {
    try {
      for(const target of targets) {
        const record=target.record
        if(signal.aborted) {record.status='cancelled';record.stage='done';continue}
        if(!this.current(target)) {record.status='stale';record.error='配置已变化，请重新测试';record.stage='done';continue}
        const controller=new AbortController(),timeout=new AbortController()
        const timer=setTimeout(()=>timeout.abort(),this.timeouts[input.mode])
        this.active={target,controller}
        const combined=AbortSignal.any([signal,controller.signal,timeout.signal]),started=performance.now()
        record.status='running';record.startedAt=Date.now()
        try {
          if(input.mode==='models') {
            record.stage='models'
            const account=providerNetworkTarget(this.store.read(),target.provider,{id:target.keyId,apiKey:target.apiKey})
            Object.assign(record,await fetchProbeModels(target.provider.baseUrl,target.protocol,target.credentialKind,target.apiKey,combined,(url,init)=>this.fetchUpstream(url,init,account),()=>{
              if(!this.current(target))throw new ProbeError('配置已变化，请重新测试')
            }))
          } else await this.chat(target,input,settings,combined)
          if(combined.aborted)throw new ProbeError('测试已中止')
          record.status='success'
        } catch(error) {
          if(signal.aborted) {record.status='cancelled';record.error='测试已取消'}
          else if(!this.current(target)) {record.status='stale';record.error='配置已变化，请重新测试'}
          else if(timeout.signal.aborted) {record.status='error';record.error='测试超时，已停止请求'}
          else {record.status='error';record.error=error instanceof ProbeError ? error.message : '本地测试失败，请检查接口或网络配置'}
          if(error instanceof ProbeError && error.status)record.httpStatus=error.status
          delete record.reply;delete record.replyTruncated;delete record.models;delete record.modelsTruncated
        } finally {
          clearTimeout(timer);this.active=undefined;record.finishedAt=Date.now();record.durationMs=Math.round(performance.now()-started);record.stage='done'
          if(!signal.aborted && !this.current(target)) {record.status='stale';record.error='配置已变化，请重新测试';delete record.reply;delete record.replyTruncated;delete record.models;delete record.modelsTruncated}
          this.count()
        }
      }
    } finally {this.state.running=false;this.state.cancelling=false;this.state.cancelled=signal.aborted;this.count()}
  }
  private count():void {
    this.state.completed=this.state.records.filter(r=>!['pending','running'].includes(r.status)).length
    this.state.succeeded=this.state.records.filter(r=>r.status==='success').length
    this.state.failed=this.state.records.filter(r=>r.status==='error' || r.status==='stale').length
  }
  private async chat(target:Target,input:ProviderProbeInput,settings:Settings,signal:AbortSignal):Promise<void> {
    const record=target.record,provider=target.provider
    const model=selectProbeModel(target.models,target.protocol,target.explicitModel??input.model)
    if(!model)throw new ProbeError('没有可用的测试模型，请先配置或获取模型列表')
    record.model=model;record.stage='starting'
    const account=providerNetworkTarget(this.store.read(),provider,{id:target.keyId,apiKey:target.apiKey})
    const serviceTier=target.protocol==='anthropic_messages'?undefined:resolveServiceTier(input.serviceTier,settings.defaultTier,provider.defaultTier,undefined,account.defaultTier).tier
    const payload=target.protocol==='openai_responses'
      ? {model,input:[{role:'user',content:[{type:'input_text',text:input.prompt}]}],store:false,stream:false,max_output_tokens:256,...(serviceTier?{service_tier:serviceTier}:{})}
      : {model,messages:[{role:'user',content:input.prompt}],stream:false,max_tokens:256,...(serviceTier?{service_tier:serviceTier}:{})}
    signal.throwIfAborted();record.stage='chat';record.outboundTier=tier(serviceTier)
    const {body,status:httpStatus}=await probeJSON(providerAPIEndpoint(provider.baseUrl,target.protocol,'chat'),{
      method:'POST',headers:{...providerAPIHeaders(target.protocol,target.credentialKind,target.apiKey),'Content-Type':'application/json'},body:JSON.stringify(payload)
    },signal,(url,init)=>this.fetchUpstream(url,init,account))
    const reply=Array.from(redact(chatText(body,target.protocol),[target.apiKey]))
    record.httpStatus=httpStatus;record.responseTier=tier(body.service_tier);record.reply=reply.slice(0,8000).join('');record.replyTruncated=reply.length>8000
  }
}
