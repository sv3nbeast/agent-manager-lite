import {spawn} from 'node:child_process'
import {createJSONRequest,requestJSON,type JSONFetch,type JSONRequest} from './network'
import {accountProxyURL,defaultProxyURL,normalizeStoredProxy,type ProxyState} from './proxyPolicy'
import {needsProxyTunnel} from './proxyCatalogBinding'
import type {ProxyTunnels,ProxyLease} from './proxyTunnels'

// Bounded helper processes reuse the vendored transport for HTTP/HTTPS/SOCKS.
// They never receive credentials in argv, environment, files or renderer IPC.
export class AccountNetwork {
  private readonly jobs=new Set<Promise<Response>>()
  private readonly controller=new AbortController()
  constructor(private readonly binary:string,private readonly proxyState:()=>ProxyState=()=>({}),private readonly tunnels?:Pick<ProxyTunnels,'acquire'>){}
  readonly request:JSONRequest=(url,init,operation,account)=>{
    const proxy=account?accountProxyURL(account,this.proxyState()):defaultProxyURL(this.proxyState())
    return proxy===undefined?requestJSON(url,init,operation):this.through(proxy,account?.id)(url,init,operation)
  }
  readonly fetchUpstream=(url:string,init:RequestInit={},account?:import('./store').StoredAccount):Promise<Response>=>{
    const proxy=account?accountProxyURL(account,this.proxyState()):defaultProxyURL(this.proxyState())
    return proxy===undefined?fetch(url,init):this.fetch(proxy,account?.id??'upstream')(url,init)
  }
  through(proxy:string,scope='probe'):JSONRequest {
    const normalized=proxy==='direct'?'direct':normalizeStoredProxy(proxy)
    return createJSONRequest((url,init)=>this.fetch(normalized,scope)(url,init))
  }
  private fetch(proxy:string,scope:string):JSONFetch {return (url,init)=>{
    const signal=AbortSignal.any([this.controller.signal,...(init.signal?[init.signal]:[])])
    signal.throwIfAborted()
    if(init.body!==undefined&&init.body!==null&&typeof init.body!=='string')throw new Error('不支持此请求体')
    const headers:Record<string,string>={};new Headers(init.headers).forEach((value,key)=>{headers[key]=value})
    if(Buffer.byteLength(JSON.stringify({url,headers,body:init.body??'',proxy}))>1024*1024)throw new Error('请求超过大小限制')
    if(this.jobs.size>=12)throw new Error('账号网络请求繁忙，请稍后重试')
    const task=(async()=>{
      let lease:ProxyLease|undefined
      try {
        if(needsProxyTunnel(proxy)){
          if(!this.tunnels)throw new Error('代理引擎尚未接入')
          lease=await this.tunnels.acquire(proxy,scope,signal)
        }
        signal.throwIfAborted()
        const raw=JSON.stringify({url,method:init.method??'GET',headers,body:init.body??'',proxy:lease?.url??proxy})
        if(Buffer.byteLength(raw)>1024*1024)throw new Error('请求超过大小限制')
        return await new Promise<Response>((resolve,reject)=>{
      const child=spawn(this.binary,['-egress-http'],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{PATH:process.env.PATH??'',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}: {})}})
      const chunks:Buffer[]=[];let size=0,failed=false
      const fail=()=>{failed=true;child.kill('SIGKILL')}
      const timer=setTimeout(fail,27000);signal.addEventListener('abort',fail,{once:true});if(signal.aborted)fail()
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',fail)}
      child.stdin.on('error',fail)
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>3*1024*1024)fail();else chunks.push(chunk)})
      child.once('error',()=>{clean();reject(new Error('账号网络进程无法启动'))})
      child.once('close',code=>{
        clean()
        if(failed||signal.aborted||code!==0){reject(new Error('账号代理请求失败或已取消'));return}
        try{
          const value=JSON.parse(Buffer.concat(chunks).toString())
          if(value.error||!Number.isInteger(value.status)||value.status<200||value.status>599||value.body!==undefined&&typeof value.body!=='string')throw 0
          const body=Buffer.from(value.body??'','base64');if(body.length>2*1024*1024)throw 0
          resolve(new Response([204,205,304].includes(value.status)?null:body,{status:value.status}))
        }catch{reject(new Error('账号代理响应无效'))}
      })
      child.stdin.end(raw)
        })
      }finally{lease?.release()}
    })()
    this.jobs.add(task);void task.finally(()=>this.jobs.delete(task)).catch(()=>{});return task
  }}
  async stop():Promise<void>{this.controller.abort();await Promise.allSettled([...this.jobs])}
}
