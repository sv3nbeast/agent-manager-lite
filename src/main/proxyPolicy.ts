// Account eligibility and direct URL normalization adapted from Cockpit
// codex_account_proxy.rs. Proxy secrets never enter account view projections.
import type {StoredAccount} from './store'
import type {AccountProxyView} from '../shared/accountProxy'
import {isNodeLink,parseProxyNode} from './proxyNode'
import {normalizeDirectProxy} from './proxyDirect'
import {validateCatalogBinding,catalogBindingSummary,isCatalogBinding} from './proxyCatalogBinding'
export interface StoredAccountProxy {mode:'direct'|'custom'|'resource';url?:string;resourceId?:string}
export interface StoredProxyResource {id:string;revision:number;name:string;url:string;catalog?:{sourceId:string;itemId:string;revision:number;selections:Record<string,string>;invalid?:boolean}}
export interface ProxyState {upstreamProxy?:{revision:number;mode:'inherit'|'direct'|'custom';url?:string};proxyResources?:StoredProxyResource[];unifiedProxy?:{mode:'off'|'all_accounts';resourceId?:string;snapshot?:{url:string;resourceRevision:number;sourceRevision:number};pending?:boolean;staleError?:string}}
export function proxyEligible(account:StoredAccount):boolean {return ['oauth','api_key','agent_identity'].includes(account.kind)}
export function legacyProxyEligible(account:StoredAccount):boolean {return account.kind==='oauth'&&!account.providerId&&!!account.credentials.accessToken}
/** Explicit default applies to all upstream operations; absent/inherit retains old routing. */
export function defaultProxyURL(state:ProxyState={}):string|undefined {
  const proxy=state.upstreamProxy
  if(!proxy||proxy.mode==='inherit')return
  if(proxy.mode==='direct')return 'direct'
  if(proxy.mode!=='custom'||!proxy.url)throw new Error('默认网络代理配置无效，请重新设置')
  return normalizeDirectProxy(proxy.url)
}
export function normalizeProxy(input:string):string {
  const fail=()=>{throw new Error('代理地址无效，请使用支持的代理地址或节点分享链接')}
  const raw=input.trim();if(!raw||raw.length>8192||/[\u0000-\u0020\u007f\\]/.test(raw))return fail()
  if(isNodeLink(raw)){parseProxyNode(raw);return raw}
  return normalizeDirectProxy(raw)
}
export function normalizeStoredProxy(raw:string):string{if(isCatalogBinding(raw)){validateCatalogBinding(raw);return raw}return normalizeProxy(raw)}
export function proxyResource(state:ProxyState,id:string|undefined,revision?:number):StoredProxyResource {
  const matches=state.proxyResources?.filter(resource=>resource.id===id)??[]
  if(!id||matches.length!==1||revision!==undefined&&matches[0].revision!==revision)throw new Error('代理资源已变化或不存在，请重新选择')
  if(matches[0].catalog?.invalid)throw new Error('目录资源已失效，请重新选择节点或分组')
  if(matches[0].catalog)normalizeStoredProxy(matches[0].url);else normalizeProxy(matches[0].url)
  return matches[0]
}
export function accountProxyURL(account:StoredAccount,state:ProxyState={}):string|undefined {
  if(!proxyEligible(account))return
  if(!account.proxy){
    const configured=defaultProxyURL(state)
    if(configured!==undefined)return configured
    // Existing unified account exits were OAuth-only. Adding the new default
    // must not silently change legacy API-key / Agent Identity routing.
    if(!legacyProxyEligible(account))return
    const unified=state.unifiedProxy
    if(!unified||unified.mode==='off')return
    if(unified.mode!=='all_accounts')throw new Error('统一代理配置无效，请重新设置')
    return unifiedProxyURL(state)
  }
  if(account.proxy.mode==='direct')return 'direct'
  if(account.proxy.mode==='resource')return normalizeStoredProxy(proxyResource(state,account.proxy.resourceId).url)
  if(account.proxy.mode!=='custom'||!account.proxy.url)throw new Error('账号代理配置无效，请重新设置')
  return normalizeProxy(account.proxy.url)
}
export function unifiedProxyURL(state:ProxyState):string{
 const resource=proxyResource(state,state.unifiedProxy?.resourceId),snapshot=state.unifiedProxy?.snapshot
 if(snapshot&&(!resource.catalog||snapshot.resourceRevision!==resource.revision))throw new Error('统一出口快照已变化，请重新选择资源')
 return normalizeStoredProxy(snapshot?.url??resource.url)
}
export function proxyAddressView(raw:string):AccountProxyView {
  if(isCatalogBinding(raw))try{return {mode:'custom',...catalogBindingSummary(raw),catalog:true,authenticated:true}}catch{return {mode:'custom',invalid:true}}
  if(isNodeLink(raw))try{const node=parseProxyNode(raw);return {mode:'custom',protocol:node.type.toUpperCase(),server:node.server,port:node.port,authenticated:true}}catch{return {mode:'custom',invalid:true}}
  try{const url=new URL(normalizeProxy(raw));return {mode:'custom',protocol:url.protocol.slice(0,-1).toUpperCase(),server:url.hostname,port:Number(url.port)||(url.protocol==='https:'?443:80),authenticated:!!(url.username||url.password)}}
  catch{return {mode:'custom',invalid:true}}
}
export function accountProxyView(account:StoredAccount,state:ProxyState={}):AccountProxyView|undefined {
  if(!proxyEligible(account))return
  if(account.proxy?.mode==='direct')return {mode:'direct',source:'account'}
  const mode=account.proxy?.mode??'inherit',source=account.proxy?'account':state.upstreamProxy&&state.upstreamProxy.mode!=='inherit'?'global':!legacyProxyEligible(account)||state.unifiedProxy?.mode==='off'||!state.unifiedProxy?'default':'unified'
  try{
    const url=accountProxyURL(account,state),resourceId=mode==='resource'?account.proxy?.resourceId:source==='unified'?state.unifiedProxy?.resourceId:undefined
    return {...(url&&url!=='direct'?proxyAddressView(url):{}),mode,source,...resourceId?{resourceId,name:proxyResource(state,resourceId).name}:{}}
  }catch{return {mode,source,invalid:true}}
}
