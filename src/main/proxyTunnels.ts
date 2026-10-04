// Account-scoped leases adapted from Cockpit codex_proxy_runtime.rs. Credentials
// stay in main/child pipes. A failed node never becomes a direct connection.
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {createHash,randomBytes} from 'node:crypto'
import {parseProxyNode,type MihomoProxy} from './proxyNode'
import {decodeCatalogBinding,isCatalogBinding} from './proxyCatalogBinding'
import type {FrozenProxyGraph} from './proxyCatalogGraph'

export interface ProxyLease {url:string;release():void}
interface Tunnel {url:string;stop():Promise<void>}
interface Entry {key:string;refs:number;control:AbortController;ready:Promise<Tunnel>;tunnel?:Tunnel;idle?:NodeJS.Timeout;retired:boolean}
const cancelled=()=>new Error('代理连接已取消')
function until<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(cancelled())
  return new Promise((resolve,reject)=>{
    const abort=()=>{clean();reject(cancelled())},clean=()=>signal.removeEventListener('abort',abort)
    signal.addEventListener('abort',abort,{once:true})
    void task.then(value=>{clean();resolve(value)},error=>{clean();reject(error)})
  })
}
export function canonicalNode(node:unknown):string {
  const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,sorted(v)])):value
  return JSON.stringify(sorted(node))
}
async function ports():Promise<[number,number]>{
  const servers=[createServer(),createServer()]
  try {
    return await Promise.all(servers.map(server=>new Promise<number>((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a==='object')resolve(a.port);else reject(new Error('无法分配代理端口'))})
    }))) as [number,number]
  }finally{await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))))}
}
interface Dependencies {idleMs?:number;queueMs?:number;capacity?:number;parallel?:number}
export class ProxyTunnels {
  private readonly entries=new Map<string,Entry>()
  private readonly tasks=new Set<Promise<unknown>>()
  private readonly stopped=new AbortController()
  private starts=0
  private readonly queue:(()=>void)[]=[]
  constructor(private readonly helper:string,private readonly root:string,private readonly preflight:()=>Promise<string>,private readonly dependencies:Dependencies={}){}
  private track<T>(task:Promise<T>):Promise<T>{this.tasks.add(task);void task.finally(()=>this.tasks.delete(task)).catch(()=>{});return task}
  private retire(entry:Entry):void {
    if(entry.retired)return
    entry.retired=true;clearTimeout(entry.idle)
    if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key)
    entry.control.abort()
    this.track(entry.ready.then(tunnel=>tunnel.stop(),()=>{}))
  }
  private drop(entry:Entry):void {
    if(--entry.refs!==0||entry.retired)return
    if(!entry.tunnel)this.retire(entry)
    else{entry.idle=setTimeout(()=>this.retire(entry),this.dependencies.idleMs??30000);entry.idle.unref()}
  }
  async acquire(raw:string,scope:string,signal?:AbortSignal):Promise<ProxyLease>{
    const combined=AbortSignal.any([this.stopped.signal,...signal?[signal]:[]]);combined.throwIfAborted()
    const node=isCatalogBinding(raw)?decodeCatalogBinding(raw):parseProxyNode(raw)
    const runtime='version' in node?{...node,names:undefined}:node
    const key=createHash('sha256').update(scope+'\0'+canonicalNode(runtime)).digest('hex')
    let entry=this.entries.get(key)
    if(!entry){
      if(this.entries.size>=(this.dependencies.capacity??256)){
        const idle=[...this.entries.values()].find(value=>!value.refs&&value.tunnel)
        if(idle)this.retire(idle);else throw new Error('运行中的代理节点过多，请先停止部分服务')
      }
      entry={key,refs:0,control:new AbortController(),ready:undefined!,retired:false}
      const current=entry
      current.ready=this.track(Promise.resolve().then(()=>this.start(node,current)).then(tunnel=>{current.tunnel=tunnel;return tunnel},error=>{this.retire(current);throw error}))
      this.entries.set(key,current)
    }
    clearTimeout(entry.idle);entry.refs++
    try{const tunnel=await until(entry.ready,combined);combined.throwIfAborted();let released=false;const current=entry;return {url:tunnel.url,release:()=>{if(!released){released=true;this.drop(current)}}}}
    catch(error){this.drop(entry);throw error}
  }
  private async slot(signal:AbortSignal):Promise<()=>void>{
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(this.dependencies.queueMs??12000)])
    if(this.starts>=(this.dependencies.parallel??4)){
      let wake!:()=>void
      const waiting=new Promise<void>(resolve=>{wake=resolve;this.queue.push(wake)})
      try{await until(waiting,deadline)}catch(error){const index=this.queue.indexOf(wake);if(index>=0)this.queue.splice(index,1);else this.releaseSlot();throw error}
    }else this.starts++
    if(deadline.aborted){this.releaseSlot();throw cancelled()}
    return ()=>this.releaseSlot()
  }
  private releaseSlot():void {const next=this.queue.shift();if(next)next();else this.starts--}
  private async start(node:MihomoProxy|FrozenProxyGraph,entry:Entry):Promise<Tunnel>{
    const signal=AbortSignal.any([entry.control.signal,this.stopped.signal]),release=await this.slot(signal)
    try{
      const binary=await until(this.preflight(),signal);signal.throwIfAborted()
      const [port,controllerPort]=await ports();signal.throwIfAborted()
      const username=randomBytes(24).toString('hex'),password=randomBytes(24).toString('hex'),secret=randomBytes(32).toString('hex')
      const child=spawn(this.helper,['-proxy-engine'],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{PATH:process.platform==='win32'?'':'/usr/bin:/bin',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}})
      let closed=false,ready=false,buffer='',failed=false
      let finish!:()=>void
      const done=new Promise<void>(resolve=>{finish=resolve})
      this.track(done)
      const stop=async()=>{if(!closed){child.stdin.end();child.kill('SIGTERM')}await done}
      const abort=()=>{void stop()};signal.addEventListener('abort',abort,{once:true})
      const cleanup=()=>{closed=true;signal.removeEventListener('abort',abort);this.retire(entry);finish()}
      child.once('close',cleanup)
      // The supervisor owns its child's bounded shutdown and emits only a fixed
      // ready message. No raw engine stdout/stderr is forwarded to the UI.
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{failed=true;void stop();reject(new Error('代理引擎启动超时'))},12000)
        const fail=()=>{clearTimeout(timer);failed=true;void stop();reject(new Error('代理引擎启动失败，请检查节点或重新安装引擎'))}
        child.once('error',fail);child.stdin.on('error',fail)
        child.once('close',()=>{clearTimeout(timer);if(!ready)fail()})
        child.stdout.on('data',(chunk:Buffer)=>{
          if(failed)return
          buffer+=chunk.toString('utf8');if(buffer.length>4096){fail();return}
          const split=buffer.indexOf('\n');if(split<0)return
          const line=buffer.slice(0,split);buffer=buffer.slice(split+1)
          try{const event=JSON.parse(line);if(ready||event.type!=='ready'||!Number.isInteger(event.pid)||event.pid<=0)throw 0;signal.throwIfAborted();ready=true;clearTimeout(timer);resolve()}catch{fail()}
        })
        child.stdin.write(JSON.stringify({binary,root:this.root,port,username,password,controllerPort,secret,...('version' in node?{graph:node}:{proxy:node})})+'\n')
        if(signal.aborted)abort()
      }).catch(async error=>{await stop();throw error})
      if(closed||signal.aborted){await stop();throw cancelled()}
      return {url:`socks5h://${username}:${password}@127.0.0.1:${port}`,stop}
    }finally{release()}
  }
  async stop():Promise<void>{
    this.stopped.abort();for(const entry of this.entries.values())this.retire(entry)
    while(this.tasks.size)await Promise.allSettled([...this.tasks])
  }
}
