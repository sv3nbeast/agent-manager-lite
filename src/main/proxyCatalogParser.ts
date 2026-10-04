// Bounded catalog/diagnostic semantics adapted from Cockpit ee816002
// codex_proxy_subscription_parser.rs and codex_proxy_subscription_diagnostics.rs.
import {createHash} from 'node:crypto'
import {parseCatalogDocument} from './proxyCatalogYaml'
import {isNodeLink,parseProxyNode,proxyNodeName} from './proxyNode'
import {normalizeDirectProxy} from './proxyDirect'
import {blockingNames,builtinNames,catalogError,catalogFail,catalogName,groupKinds,insecureDefinition,normalizeNativeProxy,record,validNativeProtocol,validateNativeGroup,type CatalogErrorCode,type NativeDefinition} from './proxyNative'

export interface CatalogNode {id:string;name:string;protocol:string;native?:NativeDefinition;error?:CatalogErrorCode}
export interface CatalogIssue {name:string;error:CatalogErrorCode}
export interface CatalogGroup {id:string;name:string;kind:string;members:string[];native?:NativeDefinition;definitionError?:CatalogErrorCode;error?:CatalogErrorCode;issues:CatalogIssue[]}
// Main-process only. Never pass nodes/native definitions to renderer or log them.
export interface ParsedProxyCatalog {nodes:CatalogNode[];groups:CatalogGroup[]}
export const catalogId=(kind:'node'|'group',value:string)=>createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0,24)
function decodeBase64(raw:string):string{
  const input=raw.replace(/[\r\n\t ]/g,'')
  if(!input||!/^[-_A-Za-z0-9+/]+={0,2}$/.test(input))catalogFail()
  const bytes=Buffer.from(input,'base64')
  if(bytes.toString('base64').replace(/=+$/,'')!==input.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''))catalogFail()
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return catalogFail()}
}
function parseLinks(input:string):ParsedProxyCatalog{
  const lines=input.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'))
  if(!lines.length||lines.length>4096)catalogFail()
  const nodes=lines.map((line,index):CatalogNode=>{
    if(!line.includes('://')||Buffer.byteLength(line)>8192)catalogFail()
    let label:string|undefined
    try{const value=proxyNodeName(line);if(value)label=catalogName(value)}catch{}
    const name=label??`#${index+1}`
    const node:CatalogNode={id:catalogId('node',label??line),name,protocol:'unsupported'}
    try{
      let native:NativeDefinition
      if(isNodeLink(line))native=parseProxyNode(line)
      else{
        const url=new URL(normalizeDirectProxy(line))
        native={name,type:url.protocol.startsWith('socks5')?'socks5':'http',server:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port)||(url.protocol==='https:'?443:80)}
        if(url.protocol==='https:')native.tls=true
        if(url.username)native.username=decodeURIComponent(url.username)
        if(url.password)native.password=decodeURIComponent(url.password)
      }
      native.name=name;node.native=normalizeNativeProxy(native);node.protocol=node.native.type
    }catch(error){node.error=catalogError(error)==='SUBSCRIPTION_INVALID'?'PROXY_UNSUPPORTED_OPTION':catalogError(error)}
    return node
  })
  return analyzeCatalog({nodes,groups:[]})
}
function parseGroup(input:unknown,names:string[],hasProviders:boolean):CatalogGroup{
  const value=record(input),name=catalogName(value.name)
  if(typeof value.type!=='string')catalogFail()
  const group:CatalogGroup={id:catalogId('group',name),name,kind:groupKinds.has(value.type)||value.type==='relay'?value.type:'unsupported',members:[],issues:[]}
  try{
    if(Object.hasOwn(value,'proxies')){
      if(!Array.isArray(value.proxies)||value.proxies.length>4096)catalogFail()
      group.members=[...new Set(value.proxies.map(catalogName))]
    }
    if(!groupKinds.has(value.type))catalogFail('SUBSCRIPTION_GROUP_STRATEGY')
    if(Object.hasOwn(value,'use')||value['include-all-providers']===true||value['include-all']===true&&hasProviders)catalogFail('SUBSCRIPTION_PROVIDER_UNSUPPORTED')
    try{validateNativeGroup(value)}catch{catalogFail('SUBSCRIPTION_GROUP_OPTIONS')}
    if(value['include-all']===true||value['include-all-proxies']===true)group.members=[...new Set([...group.members,...[...names].sort()])]
    if(!group.members.length||group.members.length>4096)catalogFail('PROXY_UNSUPPORTED_OPTION')
    if(typeof value.interval==='number'&&value.interval>86400||typeof value.tolerance==='number'&&value.tolerance>65535)catalogFail('SUBSCRIPTION_GROUP_OPTIONS')
    const native=structuredClone(value)
    native.name=name;native.proxies=[...group.members]
    for(const key of ['include-all','include-all-proxies','include-all-providers','interrupt-exist-connections'])delete native[key]
    group.native=native as NativeDefinition
  }catch(error){group.definitionError=catalogError(error)}
  return group
}
export function parseProxyCatalog(raw:string):ParsedProxyCatalog{
  if(Buffer.byteLength(raw)>2*1024*1024)catalogFail('SUBSCRIPTION_TOO_LARGE')
  const input=raw.replace(/^\ufeff/,'').trim()
  if(!input)catalogFail()
  const first=input.split(/\r?\n/).find(line=>line.trim()&&!line.trim().startsWith('#'))?.trim()??''
  if(/^[a-z\d]+:\/\//i.test(first))return parseLinks(input)
  if(/^[a-z\d+/=_\-\r\n\t ]+$/i.test(input))return parseLinks(decodeBase64(input))
  const root=record(parseCatalogDocument(input)),proxies=root.proxies===undefined?[]:root.proxies,rawGroups=root['proxy-groups']===undefined?[]:root['proxy-groups']
  if(!Array.isArray(proxies)||!Array.isArray(rawGroups)||!proxies.length||proxies.length+rawGroups.length>4096)catalogFail()
  const nodes=proxies.map((input):CatalogNode=>{
    const value=record(input),name=catalogName(value.name)
    if(typeof value.type!=='string')catalogFail()
    const node:CatalogNode={id:catalogId('node',name),name,protocol:validNativeProtocol(value.type)?value.type:'unsupported'}
    try{node.native=normalizeNativeProxy({...value,name});if(insecureDefinition(node.native))node.error='PROXY_TLS_INSECURE'}catch(error){node.error=catalogError(error)}
    return node
  })
  const providers=root['proxy-providers'],hasProviders=providers!==undefined&&(!providers||typeof providers!=='object'||Array.isArray(providers)||Object.keys(providers).length>0)
  return analyzeCatalog({nodes,groups:rawGroups.map(group=>parseGroup(group,nodes.map(node=>node.name),hasProviders))})
}
export function analyzeCatalog(catalog:ParsedProxyCatalog):ParsedProxyCatalog{
  const names=new Set<string>()
  for(const item of [...catalog.nodes,...catalog.groups]){if(names.has(item.name))catalogFail('SUBSCRIPTION_DUPLICATE_NAME');names.add(item.name)}
  for(const node of catalog.nodes)if(builtinNames.has(node.name))node.error='PROXY_UNSUPPORTED_OPTION'
  for(const group of catalog.groups){if(builtinNames.has(group.name))group.definitionError='SUBSCRIPTION_GROUP_OPTIONS';group.error=group.definitionError}
  const nodes=new Map(catalog.nodes.map(node=>[node.name,node])),groups=new Map(catalog.groups.map(group=>[group.name,group]))
  const available=new Set<string>()
  for(let iteration=0;iteration<32;iteration++){
    const next=new Set(available)
    const usable=(name:string)=>builtinNames.has(name)?blockingNames.has(name):nodes.has(name)?!nodes.get(name)!.error&&!!nodes.get(name)!.native:available.has(name)
    for(const group of catalog.groups)if(!group.error&&group.members.length&&(group.kind==='select'?group.members.some(usable):group.members.every(usable)))next.add(group.name)
    if(next.size===available.size)break
    for(const name of next)available.add(name)
  }
  let work=0,issueCount=0
  for(const root of catalog.groups){
    const found=new Map<string,CatalogIssue>(),visited=new Set<string>(),active=new Set<string>()
    const pending:[string,boolean][]=[[root.name,false]]
    const issue=(name:string,error:CatalogErrorCode)=>{const key=JSON.stringify([name,error]);if(!found.has(key)){if(++issueCount>100_000)catalogFail();found.set(key,{name,error})}}
    while(pending.length){
      if(++work>1_000_000)catalogFail()
      const [name,leaving]=pending.pop()!
      if(leaving){active.delete(name);continue}
      const node=nodes.get(name)
      if(node){if(node.error||!node.native)issue(name,node.error??'PROXY_UNSUPPORTED_OPTION');continue}
      if(builtinNames.has(name)){if(!blockingNames.has(name))issue(name,'PROXY_UNSUPPORTED_OPTION');continue}
      const group=groups.get(name)
      if(!group){issue(name,'SUBSCRIPTION_GROUP_MEMBER_MISSING');continue}
      if(active.has(name)){issue(name,'SUBSCRIPTION_GROUP_CYCLE');continue}
      if(visited.has(name))continue
      visited.add(name)
      if(group.definitionError)issue(name,group.definitionError)
      if(!group.members.length)issue(name,'SUBSCRIPTION_GROUP_MEMBER_MISSING')
      active.add(name);pending.push([name,true])
      for(let index=group.members.length-1;index>=0;index--)pending.push([group.members[index],false])
    }
    root.issues=[...found.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.error.localeCompare(b.error))
    if(!available.has(root.name)&&!root.error){
      root.error=root.issues.some(issue=>issue.error==='SUBSCRIPTION_GROUP_CYCLE')?'SUBSCRIPTION_GROUP_CYCLE':root.issues.some(issue=>issue.error==='SUBSCRIPTION_GROUP_MEMBER_MISSING')?'SUBSCRIPTION_GROUP_MEMBER_MISSING':root.issues.length&&root.issues.every(issue=>issue.error==='PROXY_TLS_INSECURE')?'PROXY_TLS_INSECURE':'SUBSCRIPTION_GROUP_MEMBER_UNSUPPORTED'
    }
  }
  return catalog
}
