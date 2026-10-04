// HTTPS subscription semantics adapted from Cockpit ee816002 codex_proxy_catalog.rs.
import {Agent,fetch as request,type Response} from 'undici'
import type {SubscriptionUsage} from '../shared/proxyCatalog'
export class SubscriptionError extends Error {}
function fail(text:string):never{throw new SubscriptionError(text)}
export function subscriptionURL(raw:string):URL{
 if(raw.length>8192||/[\p{Cc}]/u.test(raw))fail('订阅地址无效，请使用 HTTPS 地址')
 let url:URL;try{url=new URL(raw.trim())}catch{return fail('订阅地址无效，请使用 HTTPS 地址')}
 if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash||raw.includes('#'))fail('订阅地址无效，请使用不含用户名、密码和片段的 HTTPS 地址')
 return url
}
function titleName(raw:string):string|undefined{
 const name=raw.trim().slice(0,80)
 if(!name||Buffer.byteLength(name)>256||/[@/\\?\p{Cc}]|:\/\/|token=|password=/iu.test(name))return
 return name
}
export function subscriptionTitle(headers:Pick<Headers,'get'>,urls:URL[]):string|undefined{
 let title=headers.get('profile-title'),name:string|undefined
 if(title&&title.length<=2048){
  try{if(title.startsWith('base64:')){const b=title.slice(7);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(b))throw 0;title=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(b,'base64'))}name=titleName(title)}catch{}
 }
 if(!name){const raw=headers.get('content-disposition');if(raw&&raw.length<=2048)for(const key of ['filename*','filename']){
  const field=raw.split(';').map(p=>p.trim()).find(p=>p.slice(0,p.indexOf('=')).toLowerCase()===key)
  if(!field)continue
  try{let value=field.slice(field.indexOf('=')+1).trim().replace(/^"|"$/g,'');if(key==='filename*'){if(!/^utf-8''/i.test(value))continue;value=value.slice(7)}name=titleName(decodeURIComponent(value).replace(/\.ya?ml$/,''));if(name)break}catch{}
 }}
 if(name&&urls.some(url=>[...url.pathname.split('/').filter(v=>v.length>=8),...Array.from(url.searchParams.values()).filter(v=>v.length>=6)].some(v=>{try{return name!.includes(decodeURIComponent(v))||name!.includes(v)}catch{return name!.includes(v)}})))return
 return name
}
export function subscriptionUsage(headers:Pick<Headers,'get'>,now=Date.now()):SubscriptionUsage|undefined{
 const raw=headers.get('subscription-userinfo');if(!raw||raw.length>1024)return
 const values:Record<string,number|undefined>={}
 for(const field of raw.split(';')){const [key,value]=field.trim().split('='),k=key.trim().toLowerCase();if(!['upload','download','total','expire'].includes(k))continue
  const n=value&&/^\d+$/.test(value.trim())?Number(value.trim()):NaN
  values[k]=Number.isSafeInteger(n)&&n>=0&&(k==='expire'?n>0&&n<=8640000000000:n<=2**50)?n:undefined
 }
 if(Object.values(values).every(v=>v===undefined))return
 return {upload:values.upload??0,download:values.download??0,total:values.total??0,...values.expire?{expireAt:values.expire*1000}:{},at:now}
}
export interface SubscriptionDownload {body:string;title?:string;usage?:SubscriptionUsage}
type Transport=(url:string,init:{headers:Record<string,string>;redirect:'manual';signal:AbortSignal})=>Promise<Response>
// Tests can inject transport/clock only in the main process. No IPC TLS override.
export async function downloadSubscription(raw:string,signal:AbortSignal,progress:(received:number,total?:number)=>void,dependencies:{transport?:Transport;timeout?:number;now?:()=>number}={}):Promise<SubscriptionDownload>{
 let url=subscriptionURL(raw);const origin=url.origin,urls=[url],agent=dependencies.transport?undefined:new Agent({connect:{timeout:8000}}),timeout=AbortSignal.timeout(dependencies.timeout??30000),combined=AbortSignal.any([signal,timeout])
 const fetch:Transport=dependencies.transport??((url,init)=>request(url,{...init,dispatcher:agent}))
 try{
  for(let hop=0;hop<=3;hop++){
   combined.throwIfAborted()
   const response=await fetch(url.toString(),{redirect:'manual',headers:{'user-agent':'clash.meta/CodexManagerLite',accept:'*/*'},signal:combined})
   if(response.status>=300&&response.status<400){await response.body?.cancel();const location=response.headers.get('location');if(!location||hop===3)fail('订阅重定向无效或次数过多')
    let next:URL;try{next=subscriptionURL(new URL(location,url).toString())}catch{return fail('订阅重定向无效')}
    if(next.origin!==origin)fail('订阅重定向跨越来源，已停止下载');url=next;urls.push(url);continue
   }
   if(!response.ok){await response.body?.cancel();fail(`订阅下载失败（HTTP ${response.status}）`)}
   const declared=response.headers.get('content-length'),total=declared&&/^\d+$/.test(declared)?Number(declared):undefined
   if(total!==undefined&&total>2*1024*1024){await response.body?.cancel();fail('订阅内容不能超过 2 MiB')}
   if(!response.body)fail('订阅返回空内容')
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0
   try{while(true){combined.throwIfAborted();const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024)fail('订阅内容不能超过 2 MiB');chunks.push(value);progress(bytes,response.headers.has('content-encoding')?undefined:total)}}finally{await reader.cancel().catch(()=>{})}
   combined.throwIfAborted()
   let body:string;try{body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))}catch{return fail('订阅内容不是有效的 UTF-8')}
   return {body,title:subscriptionTitle(response.headers,urls),usage:subscriptionUsage(response.headers,dependencies.now?.()??Date.now())}
  }
  return fail('订阅下载失败')
 }catch(error){if(signal.aborted)fail('订阅操作已取消');if(timeout.aborted)fail('订阅下载超时');if(error instanceof SubscriptionError)throw error;return fail('订阅连接失败，请检查网络')}
 finally{await agent?.destroy()}
}
