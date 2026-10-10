import {spawn} from 'node:child_process'
import {needsProxyTunnel} from './proxyCatalogBinding'
import {normalizeStoredProxy} from './proxyPolicy'
import type {ProxyTunnels,ProxyLease} from './proxyTunnels'

export interface NativeProxyLease {url:string;alive():boolean;stop():Promise<void>}
export interface NativeProxyService {acquire(proxy:string,scope:string,signal:AbortSignal):Promise<NativeProxyLease>}

/** One opaque transport per instance; upstream credentials only enter the helper's stdin. */
export class NativeProxy implements NativeProxyService {
  constructor(private readonly binary:string,private readonly tunnels?:Pick<ProxyTunnels,'acquire'>){}
  async acquire(proxy:string,scope:string,signal:AbortSignal):Promise<NativeProxyLease> {
    signal.throwIfAborted()
    const normalized=normalizeStoredProxy(proxy)
    let upstream:ProxyLease|undefined
    try {
      if(needsProxyTunnel(normalized)){
        if(!this.tunnels)throw new Error('代理引擎尚未接入')
        upstream=await this.tunnels.acquire(normalized,scope,signal)
      }
      signal.throwIfAborted()
      const bridge=await this.start(upstream?.url??normalized,signal)
      let stopped:Promise<void>|undefined
      return {url:bridge.url,alive:bridge.alive,stop:()=>stopped??=bridge.stop().then(()=>upstream?.release())}
    }catch(error){upstream?.release();throw error}
  }
  private async start(proxy:string,signal:AbortSignal):Promise<NativeProxyLease> {
    const child=spawn(this.binary,['-native-proxy'],{stdio:['pipe','pipe','ignore'],windowsHide:true,
      env:{PATH:'/usr/bin:/bin',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}})
    let closed=false,ready=false,buffer='',stopTask:Promise<void>|undefined
    let finish!:()=>void
    const done=new Promise<void>(resolve=>{finish=resolve})
    child.once('close',()=>{closed=true;finish()})
    const stop=()=>stopTask??=(async()=>{
      if(!closed){
        child.stdin.end()
        // EOF gives the helper a chance to close all active CONNECT tunnels.
        const timer=setTimeout(()=>child.kill('SIGKILL'),2000)
        try{await done}finally{clearTimeout(timer)}
      }
    })()
    let abort:()=>void=()=>{}
    try {
      const url=await new Promise<string>((resolve,reject)=>{
        const timer=setTimeout(()=>fail('原生实例代理启动超时'),12000)
        const fail=(message='原生实例代理启动失败，请检查网络代理设置')=>{
          clearTimeout(timer);void stop();reject(new Error(message))
        }
        abort=()=>fail('实例代理启动已取消')
        signal.addEventListener('abort',abort,{once:true})
        child.once('error',()=>fail())
        child.stdin.on('error',()=>fail())
        child.once('close',()=>{clearTimeout(timer);if(!ready)fail()})
        child.stdout.on('data',(chunk:Buffer)=>{
          if(ready){void stop();return}
          buffer+=chunk.toString('utf8')
          if(buffer.length>4096){fail();return}
          const newline=buffer.indexOf('\n')
          if(newline<0)return
          try{
            const value=JSON.parse(buffer.slice(0,newline))
            // Never trust helper output with a credential, non-loopback endpoint
            // or additional output. Only this endpoint enters launch plans.
            if(value.type!=='ready'||typeof value.url!=='string'||!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(value.url)||Number(new URL(value.url).port)>65535||buffer.slice(newline+1).trim())throw 0
            signal.throwIfAborted();ready=true;clearTimeout(timer);resolve(value.url)
          }catch{fail()}
        })
        child.stdin.write(JSON.stringify({proxy})+'\n')
        if(signal.aborted)abort()
      })
      if(closed||signal.aborted){await stop();throw new Error('实例代理启动已取消')}
      return {url,alive:()=>!stopTask&&!closed&&child.exitCode===null&&child.signalCode===null,stop}
    }catch(error){await stop();throw error}
    finally{signal.removeEventListener('abort',abort)}
  }
}
