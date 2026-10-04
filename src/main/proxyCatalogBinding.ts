import {validateProxyGraph,type FrozenProxyGraph} from './proxyCatalogGraph'
import {catalogFail} from './proxyNative'
import {isNodeLink} from './proxyNode'
// Envelope only, never encryption. Created by the main-process catalog service
// and stored inside the vault; manual/custom URL inputs must not accept it.
const prefix='cml-proxy://'
const cache=new Map<string,FrozenProxyGraph>();let cacheBytes=0
export const isCatalogBinding=(raw:string)=>raw.startsWith(prefix)
export const needsProxyTunnel=(raw:string)=>isNodeLink(raw)||isCatalogBinding(raw)
export function encodeCatalogBinding(graph:FrozenProxyGraph):string{return prefix+Buffer.from(JSON.stringify(validateProxyGraph(graph))).toString('base64url')}
function loadBinding(raw:string):FrozenProxyGraph{
  const cached=cache.get(raw);if(cached){cache.delete(raw);cache.set(raw,cached);return cached}
  if(!isCatalogBinding(raw)||raw.length>700000)catalogFail('PROXY_RESOURCE_INVALID')
  const encoded=raw.slice(prefix.length)
  if(!/^[\w-]+$/.test(encoded))catalogFail('PROXY_RESOURCE_INVALID')
  const data=Buffer.from(encoded,'base64url')
  if(data.length>512*1024||data.toString('base64url')!==encoded)catalogFail('PROXY_RESOURCE_INVALID')
  let graph:FrozenProxyGraph
  try{graph=validateProxyGraph(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)))}catch{return catalogFail('PROXY_RESOURCE_INVALID')}
  cache.set(raw,graph);cacheBytes+=raw.length
  while(cache.size>32||cacheBytes>8*1024*1024){const key=cache.keys().next().value!;cacheBytes-=key.length;cache.delete(key)}
  return graph
}
export function validateCatalogBinding(raw:string):void{loadBinding(raw)}
export function decodeCatalogBinding(raw:string):FrozenProxyGraph{return structuredClone(loadBinding(raw))}
export function catalogBindingSummary(raw:string):{protocol:string;name:string}{const graph=loadBinding(raw),root=graph.groups.find(g=>g.name==='account-node')??graph.proxies.find(n=>n.name==='account-node')!;return {protocol:root.type.toUpperCase(),name:graph.names['account-node']}}
