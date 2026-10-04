// Self-built node snapshots adapted from Cockpit ee816002 codex_proxy_strategy.rs
// and codex_proxy_catalog.rs:1170-1324. Only summaries cross the renderer boundary.
import {createHash} from 'node:crypto'
import type {State} from './store'
import type {StoredCatalogSource} from './proxyCatalog'
import {analyzeCatalog,catalogId,type CatalogNode,type ParsedProxyCatalog} from './proxyCatalogParser'
import {catalogName,normalizeNativeProxy,validateNativeGroup} from './proxyNative'
import {strategyCandidatesSchema,strategyFields,type StrategyChange,type StrategyRecord,type StrategyCandidate,type StrategyCandidates,type StrategyEditor,type StrategyKind,type StrategyOptions} from '../shared/proxyStrategy'
function fail():never{throw new Error('策略成员已变化或不可用，请重新选择；原策略已保留')}
function resolve(state:State,member:{sourceId:string;itemId:string},existing?:StoredCatalogSource):{node:CatalogNode;sourceName:string;savedCopy:boolean}{
 const origin=state.proxyCatalogs?.find(s=>s.id===member.sourceId)
 if(origin){if(origin.kind==='strategy')return fail();const node=origin.catalog.nodes.find(n=>n.id===member.itemId);if(!node||node.error||!node.native)return fail();return {node,sourceName:origin.name,savedCopy:false}}
 const record=existing?.strategyMembers?.find(m=>m.sourceId===member.sourceId&&m.itemId===member.itemId),node=record&&existing?.catalog.nodes.find(n=>n.name===record.name)
 if(!record||!node||node.error||!node.native)return fail()
 return {node,sourceName:record.sourceName,savedCopy:true}
}
export function strategyCandidates(state:State,raw:unknown):StrategyCandidates{
 const input=strategyCandidatesSchema.parse(raw),keywords=input.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean),rows:StrategyCandidate[]=[]
 for(const s of state.proxyCatalogs??[])if(s.kind!=='strategy'&&(!input.sourceId||s.id===input.sourceId))for(const n of s.catalog.nodes){
  if(n.error||!n.native)continue
  const server=typeof n.native.server==='string'?n.native.server:undefined,port=typeof n.native.port==='number'?n.native.port:undefined
  if(!keywords.every(word=>[n.name,server??'',String(port??''),server?`${server}:${port??''}`:''].some(v=>v.toLocaleLowerCase().includes(word))))continue
  rows.push({sourceId:s.id,sourceName:s.name,itemId:n.id,name:n.name,protocol:n.protocol,server,port,notice:/^(剩余流量|距离下次重置|套餐到期|到期时间|官网地址|.*官网地址\s*[:：]|remaining traffic|traffic remaining|expires?\s*[:：])/i.test(n.name.trim())})
 }
 return {page:input.page,total:rows.length,rows:rows.slice((input.page-1)*25,input.page*25)}
}
export function buildStrategy(state:State,input:StrategyChange,sourceId:string):{catalog:ParsedProxyCatalog;records:StrategyRecord[];duplicates:string[]}{
 const existing=input.sourceId?state.proxyCatalogs?.find(s=>s.id===sourceId):undefined
 if(input.sourceId&&(!existing||existing.kind!=='strategy'||existing.revision!==input.revision))return fail()
 const name=catalogName(input.name),records:StrategyRecord[]=[],nodes:CatalogNode[]=[],seen=new Set<string>(),duplicates:string[]=[]
 for(const member of input.members){const {node,sourceName}=resolve(state,member,existing);if(seen.has(node.name)){duplicates.push(node.name);continue}seen.add(node.name)
  records.push({...member,name:node.name,sourceName});nodes.push({id:catalogId('node',node.name),name:node.name,protocol:node.protocol,native:normalizeNativeProxy(node.native)})
 }
 if(!nodes.length||seen.has(name))throw new Error('策略名称不能与成员节点同名')
 const options=input.options,auto=input.kind!=='select',members=nodes.map(n=>n.name)
 const native=validateNativeGroup({name,type:input.kind,proxies:members,...auto?{url:options.url?.trim()||'https://www.gstatic.com/generate_204',interval:options.interval??30,...options.lazy===undefined?{}:{lazy:options.lazy}}:{},...input.kind==='url-test'?{tolerance:options.tolerance??50}:{},...auto&&input.kind!=='load-balance'&&options.timeout!==undefined?{timeout:options.timeout*1000}:{}})
 const groupId=createHash('sha256').update(`strategy:${sourceId}`).digest('hex').slice(0,24)
 const catalog=analyzeCatalog({nodes,groups:[{id:groupId,name,kind:input.kind,members,native,issues:[]}]})
 if(catalog.groups[0].error)return fail()
 return {catalog,records,duplicates}
}
export function strategyEditor(state:State,source:StoredCatalogSource):StrategyEditor{
 const group=source.catalog.groups[0],kind=group?.kind as StrategyKind
 if(source.kind!=='strategy'||!strategyFields[kind]||!group.native)throw new Error('此来源不是有效的自建策略')
 const options:StrategyOptions={}
 for(const key of strategyFields[kind]){const value=group.native[key];if(value!==undefined)Object.assign(options,{[key]:key==='timeout'&&typeof value==='number'?value/1000:value})}
 return {sourceId:source.id,revision:source.revision,name:source.name,kind,options,members:(source.strategyMembers??[]).map(m=>{try{const result=resolve(state,m,source);return {...m,sourceName:result.sourceName,available:true,savedCopy:result.savedCopy}}catch{return {...m,available:false,savedCopy:false}}})}
}
export function renameStrategy(source:StoredCatalogSource,name:string):void{
 if(source.catalog.nodes.some(n=>n.name===name))throw new Error('策略名称不能与成员节点同名')
 const group=source.catalog.groups[0];if(!group?.native)fail();group.name=catalogName(name);group.native={...group.native,name};analyzeCatalog(source.catalog);if(group.error)fail()
}
