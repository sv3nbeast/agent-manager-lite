// Native capability boundary adapted from Cockpit ee816002 codex_proxy_mihomo.rs.
// Definitions contain credentials. Keep them in the main process and encrypted storage.
import {nativeOptions} from './proxyNativeOptions'

export type NativeDefinition=Record<string,unknown>&{name:string;type:string}
export type CatalogErrorCode='SUBSCRIPTION_INVALID'|'SUBSCRIPTION_TOO_LARGE'|'SUBSCRIPTION_DUPLICATE_NAME'|'PROXY_UNSUPPORTED_OPTION'|'PROXY_TLS_INSECURE'|'SUBSCRIPTION_GROUP_STRATEGY'|'SUBSCRIPTION_PROVIDER_UNSUPPORTED'|'SUBSCRIPTION_GROUP_OPTIONS'|'SUBSCRIPTION_GROUP_MEMBER_MISSING'|'SUBSCRIPTION_GROUP_MEMBER_UNSUPPORTED'|'SUBSCRIPTION_GROUP_CYCLE'|'PROXY_RESOURCE_SELECTION_REQUIRED'|'PROXY_RESOURCE_INVALID'
export class CatalogError extends Error {constructor(readonly code:CatalogErrorCode){super(code)}}
export function catalogFail(code:CatalogErrorCode='SUBSCRIPTION_INVALID'):never{throw new CatalogError(code)}
export function catalogError(error:unknown):CatalogErrorCode{return error instanceof CatalogError?error.code:'SUBSCRIPTION_INVALID'}
export const blockingNames=new Set(['REJECT','REJECT-DROP'])
export const builtinNames=new Set(['DIRECT','REJECT','REJECT-DROP','PASS','PASS-RULE','COMPATIBLE'])
export const groupKinds=new Set(['select','url-test','fallback','load-balance'])
export function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))catalogFail()
  return value as Record<string,unknown>
}
export function catalogName(value:unknown):string{
  if(typeof value!=='string')catalogFail()
  const name=value.trim()
  if(!name||Buffer.byteLength(name)>256||/[\p{Cc}]|:\/\/|token=|password=/iu.test(name))catalogFail()
  return name
}
export function validNativeProtocol(type:string):boolean{return Object.hasOwn(nativeOptions,type)}
export function insecureDefinition(value:unknown):boolean{
  if(Array.isArray(value))return value.some(insecureDefinition)
  if(value&&typeof value==='object')return Object.entries(value).some(([key,item])=>['insecure','skip-cert-verify'].includes(key.toLowerCase().replaceAll('_','-'))&&item===true||insecureDefinition(item))
  return false
}
// Apply a budget before cloning. Also used when reading a frozen/persisted graph.
export function boundDefinition(value:unknown,maxDepth=24):void{
  let budget=100_000,bytes=0
  const active=new Set<object>()
  const walk=(v:unknown,depth:number):void=>{
    if(depth>maxDepth||--budget<0)catalogFail()
    if(typeof v==='string'){
      const length=Buffer.byteLength(v);bytes+=length
      if(length>65536||bytes>32*1024*1024||v.includes('\0'))catalogFail()
    }else if(typeof v==='number'){if(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))catalogFail()}
    else if(v&&typeof v==='object'){
      if(active.has(v))catalogFail();active.add(v)
      if(Array.isArray(v)){if(v.length>4096)catalogFail();for(const item of v)walk(item,depth+1)}
      else for(const [key,item] of Object.entries(record(v))){walk(key,depth+1);walk(item,depth+1)}
      active.delete(v)
    }else if(v!==null&&typeof v!=='boolean')catalogFail()
  }
  walk(value,0)
}
function nativeSafety(value:unknown):void{
  if(Array.isArray(value)){for(const item of value)nativeSafety(item);return}
  if(!value||typeof value!=='object')return
  const map=record(value)
  for(const [raw,item] of Object.entries(map)){
    const key=raw.toLowerCase().replaceAll('_','-')
    if(['dialer-proxy','interface-name','routing-mark','detour','bind-interface','config-path','ca','ca-str','client-cert','client-key'].includes(key)||key.endsWith('-path')||key.endsWith('-file'))catalogFail('PROXY_UNSUPPORTED_OPTION')
    if(['skip-cert-verify','insecure'].includes(key)&&typeof item!=='boolean')catalogFail()
    if(['certificate','private-key'].includes(key)){
      if(typeof item!=='string')catalogFail()
      const inlineWG=key==='private-key'&&map.type==='wireguard'&&/^[A-Za-z0-9+/]{43}=$/.test(item)&&Buffer.from(item,'base64').length===32&&Buffer.from(item,'base64').toString('base64')===item
      if(!item.startsWith('-----BEGIN ')&&!inlineWG)catalogFail('PROXY_UNSUPPORTED_OPTION')
    }
    nativeSafety(item)
  }
}
function range(value:unknown):boolean{
  return typeof value==='string'&&value.split(',').every(part=>{
    const parts=part.trim().split('-')
    return parts.length<=2&&parts.every(n=>/^\d+$/.test(n)&&Number(n)>=1&&Number(n)<=65535)&&(parts.length===1||Number(parts[0])<=Number(parts[1]))
  })
}
function validDNS(value:unknown):boolean{
  if(typeof value!=='string')return false
  const name=value.replace(/\.$/,'')
  return name.length>0&&name.length<=253&&name.split('.').every(label=>label.length>0&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}
export function normalizeNativeProxy(input:unknown):NativeDefinition{
  boundDefinition(input)
  const proxy=structuredClone(record(input)),kind=proxy.type
  if(typeof kind!=='string'||!validNativeProtocol(kind))catalogFail('PROXY_UNSUPPORTED_OPTION')
  const alias=['vmess','vless'].includes(kind)?['sni','servername']:kind==='trojan'?['servername','sni']:undefined
  for(const [from,to] of [...(alias?[alias]:[]),['mport','ports']])if(Object.hasOwn(proxy,from)){
    if(Object.hasOwn(proxy,to)&&JSON.stringify(proxy[from])!==JSON.stringify(proxy[to]))catalogFail(from==='mport'?'PROXY_UNSUPPORTED_OPTION':'SUBSCRIPTION_INVALID')
    proxy[to]=proxy[from];delete proxy[from]
  }
  nativeSafety(proxy)
  const allowed=new Set([...nativeOptions[kind],'type','tfo','mptcp','ip-version','smux'])
  if(Object.keys(proxy).some(key=>!allowed.has(key)))catalogFail('PROXY_UNSUPPORTED_OPTION')
  proxy.name=catalogName(proxy.name)
  if(kind==='hysteria2'&&Object.hasOwn(proxy,'udp')&&proxy.udp!==true)catalogFail('PROXY_UNSUPPORTED_OPTION')
  if(kind!=='wireguard'||!Object.hasOwn(proxy,'peers')){
    if(typeof proxy.server!=='string'||!proxy.server||Buffer.byteLength(proxy.server)>253||/[\s\p{Cc}/@?#\\]/u.test(proxy.server))catalogFail()
    if(!(typeof proxy.port==='number'&&Number.isInteger(proxy.port)&&proxy.port>=1&&proxy.port<=65535)&&!(kind==='mieru'&&range(proxy['port-range'])))catalogFail()
  }
  if(kind==='ssh'&&(!Array.isArray(proxy['host-key'])||!proxy['host-key'].length||!proxy['host-key'].every(key=>typeof key==='string'&&key.length>0)))catalogFail('PROXY_UNSUPPORTED_OPTION')
  if(proxy['ech-opts']&&Object.hasOwn(record(proxy['ech-opts']),'query-server-name')&&!validDNS(record(proxy['ech-opts'])['query-server-name']))catalogFail()
  if(Object.hasOwn(proxy,'plugin')&&!['obfs','v2ray-plugin','shadow-tls','restls'].includes(proxy.plugin as string))catalogFail('PROXY_UNSUPPORTED_OPTION')
  if(Object.hasOwn(proxy,'ports')&&!range(proxy.ports))catalogFail('PROXY_UNSUPPORTED_OPTION')
  return proxy as NativeDefinition
}
export function validateTestURL(value:unknown):void{
  if(typeof value!=='string'||value.length>2048||/[\p{Cc}]/u.test(value))catalogFail()
  let url:URL;try{url=new URL(value)}catch{return catalogFail()}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.hash||value.includes('#'))catalogFail('PROXY_UNSUPPORTED_OPTION')
}
const groupOptions=new Set(['name','type','proxies','url','interval','timeout','max-failed-times','lazy','disable-udp','expected-status','hidden','icon','tolerance','strategy','include-all','include-all-proxies','include-all-providers','empty-fallback','interrupt-exist-connections','default-selected'])
export function validateNativeGroup(input:unknown,frozen=false):NativeDefinition{
  boundDefinition(input)
  const group=record(input)
  if(typeof group.type!=='string'||!groupKinds.has(group.type)||Object.keys(group).some(key=>!groupOptions.has(key)))catalogFail('PROXY_UNSUPPORTED_OPTION')
  catalogName(group.name)
  if(Object.hasOwn(group,'interrupt-exist-connections')&&group['interrupt-exist-connections']!==false||Object.hasOwn(group,'empty-fallback')&&group['empty-fallback']!=='REJECT')catalogFail('PROXY_UNSUPPORTED_OPTION')
  if(frozen&&['include-all','include-all-proxies','include-all-providers'].some(key=>Object.hasOwn(group,key)))catalogFail('PROXY_UNSUPPORTED_OPTION')
  if(Object.hasOwn(group,'proxies')){
    if(!Array.isArray(group.proxies)||group.proxies.length>4096)catalogFail()
    group.proxies.forEach(catalogName)
  }else if(frozen)catalogFail()
  if(Object.hasOwn(group,'default-selected')){
    catalogName(group['default-selected'])
    if(frozen&&!(group.proxies as unknown[]).includes(group['default-selected']))catalogFail()
  }
  if(Object.hasOwn(group,'url'))validateTestURL(group.url)
  for(const key of ['interval','timeout','max-failed-times','tolerance'])if(Object.hasOwn(group,key)&&!(typeof group[key]==='number'&&Number.isInteger(group[key])&&group[key]>=0&&group[key]<=120000))catalogFail()
  for(const key of ['lazy','hidden','disable-udp','include-all','include-all-proxies','include-all-providers'])if(Object.hasOwn(group,key)&&typeof group[key]!=='boolean')catalogFail()
  return group as NativeDefinition
}
