// Frozen resource semantics adapted from Cockpit ee816002 codex_proxy_catalog_binding.rs.
import {analyzeCatalog,type ParsedProxyCatalog} from './proxyCatalogParser'
import {blockingNames,boundDefinition,builtinNames,catalogFail,catalogName,insecureDefinition,normalizeNativeProxy,record,validateNativeGroup,type NativeDefinition} from './proxyNative'

// Secrets: this is a main-process runtime value, not a renderer DTO or encryption.
export interface FrozenProxyGraph {version:1;proxies:NativeDefinition[];groups:NativeDefinition[];names:Record<string,string>;insecureNames:string[]}
export function validateProxyGraph(input:unknown):FrozenProxyGraph{
  boundDefinition(input,32)
  const root=record(input)
  if(Object.keys(root).some(key=>!['version','proxies','groups','names','insecureNames'].includes(key))||root.version!==1||!Array.isArray(root.proxies)||!Array.isArray(root.groups)||!Array.isArray(root.insecureNames))catalogFail('PROXY_RESOURCE_INVALID')
  const graph=structuredClone(root) as unknown as FrozenProxyGraph,count=graph.proxies.length+graph.groups.length,names=record(graph.names)
  if(!count||count>512||Object.keys(names).length!==count||Buffer.byteLength(JSON.stringify(graph))>512*1024)catalogFail('PROXY_RESOURCE_INVALID')
  const edges=new Map<string,string[]>(),insecure=new Set<string>()
  const add=(native:NativeDefinition,members:string[])=>{
    const name=native.name
    if(typeof name!=='string'||!/^(?:account-node|resource-[1-9]\d*)$/.test(name)||edges.has(name)||!Object.hasOwn(names,name))catalogFail('PROXY_RESOURCE_INVALID')
    catalogName(names[name]);edges.set(name,members)
  }
  graph.proxies=graph.proxies.map(raw=>{
    const native=normalizeNativeProxy(raw);add(native,[])
    if(insecureDefinition(native))insecure.add(native.name)
    return native
  })
  graph.groups=graph.groups.map(raw=>{
    const native=validateNativeGroup(raw,true),members=native.proxies as string[]
    if(!members.length||members.length>512||new Set(members).size!==members.length||native.type==='select'&&members.length!==1||native['empty-fallback']!=='REJECT')catalogFail('PROXY_RESOURCE_INVALID')
    add(native,members);return native
  })
  if(graph.insecureNames.some(name=>typeof name!=='string'||!insecure.has(name))||new Set(graph.insecureNames).size!==insecure.size||graph.insecureNames.length!==insecure.size)catalogFail('PROXY_RESOURCE_INVALID')
  const active=new Set<string>(),visited=new Set<string>(),depths=new Map<string,number>()
  const visit=(name:string,depth:number):void=>{
    if(blockingNames.has(name))return
    if(depth>16||active.has(name)||!edges.has(name))catalogFail('PROXY_RESOURCE_INVALID')
    // A shared subtree reached by a longer path must be checked at that depth too.
    if(visited.has(name)&&(depths.get(name)??-1)>=depth)return
    active.add(name)
    for(const member of edges.get(name)!)visit(member,depth+1)
    active.delete(name);visited.add(name);depths.set(name,depth)
  }
  visit('account-node',0)
  if(visited.size!==count)catalogFail('PROXY_RESOURCE_INVALID')
  return graph
}
export function freezeProxyCatalog(catalog:ParsedProxyCatalog,itemId:string,selections:Readonly<Record<string,string>>={}):FrozenProxyGraph{
  // Derive availability again rather than trusting persisted group flags.
  const current=analyzeCatalog(structuredClone(catalog)),items=[...current.nodes,...current.groups],root=items.find(item=>item.id===itemId)
  if(!root||items.filter(item=>item.id===itemId).length!==1||builtinNames.has(root.name))catalogFail('PROXY_RESOURCE_INVALID')
  const graph:FrozenProxyGraph={version:1,proxies:[],groups:[],names:{},insecureNames:[]},nodes=new Map(current.nodes.map(node=>[node.name,node])),groups=new Map(current.groups.map(group=>[group.name,group])),active=new Set<string>()
  let nextTag=0
  const visit=(name:string,depth:number):string=>{
    if(blockingNames.has(name))return name
    if(depth>16||active.has(name)||nextTag>=512)catalogFail('PROXY_RESOURCE_INVALID')
    active.add(name)
    const tag=nextTag++===0?'account-node':`resource-${nextTag-1}`
    graph.names[tag]=catalogName(name)
    const node=nodes.get(name)
    if(node){
      if(node.error||!node.native)catalogFail(node.error??'PROXY_UNSUPPORTED_OPTION')
      const native=normalizeNativeProxy({...node.native,name:tag})
      if(insecureDefinition(native))graph.insecureNames.push(tag)
      graph.proxies.push(native)
    }else{
      const group=groups.get(name)
      if(!group||group.error||!group.native)catalogFail(group?.error??'PROXY_RESOURCE_INVALID')
      let members=group.members
      if(group.kind==='select'){
        if(!Object.hasOwn(selections,group.id))catalogFail('PROXY_RESOURCE_SELECTION_REQUIRED')
        const selected=selections[group.id]
        if(!members.includes(selected))catalogFail('PROXY_RESOURCE_INVALID')
        members=[selected]
      }
      const tags=members.map(member=>visit(member,depth+1)),native=structuredClone(group.native)
      native.name=tag;native.proxies=tags;native['empty-fallback']='REJECT'
      if(Object.hasOwn(native,'default-selected')){
        // Preserve the declared candidate in automatic groups. A selector's
        // explicit UI choice wins over its source default.
        const index=group.kind==='select'?0:members.indexOf(native['default-selected'] as string)
        if(index<0)catalogFail('PROXY_RESOURCE_INVALID')
        native['default-selected']=tags[index]
      }
      validateNativeGroup(native,true);graph.groups.push(native)
    }
    active.delete(name)
    return tag
  }
  visit(root.name,0)
  return validateProxyGraph(graph)
}
// Used only after an explicit node/group permission preview is accepted.
// Import/refresh still begin with TLS verification exceptions blocked.
export function setCatalogTLSApproval(catalog:ParsedProxyCatalog,nodeIds:readonly string[],allow:boolean):ParsedProxyCatalog{
  if(!nodeIds.length||nodeIds.length>4096||new Set(nodeIds).size!==nodeIds.length)catalogFail('PROXY_RESOURCE_INVALID')
  const next=structuredClone(catalog),ids=new Set(nodeIds)
  for(const id of ids)if(next.nodes.filter(node=>node.id===id).length!==1)catalogFail('PROXY_RESOURCE_INVALID')
  for(const node of next.nodes)if(ids.has(node.id)){
    if(!node.native)catalogFail('PROXY_UNSUPPORTED_OPTION')
    node.native=normalizeNativeProxy(node.native)
    if(node.error&&node.error!=='PROXY_TLS_INSECURE')catalogFail(node.error)
    node.error=insecureDefinition(node.native)&&!allow?'PROXY_TLS_INSECURE':undefined
  }
  return analyzeCatalog(next)
}
export function catalogGroupNodeIds(catalog:ParsedProxyCatalog,groupId:string):string[]{
  const root=catalog.groups.find(group=>group.id===groupId)
  if(!root)catalogFail('PROXY_RESOURCE_INVALID')
  const nodes=new Map(catalog.nodes.map(node=>[node.name,node])),groups=new Map(catalog.groups.map(group=>[group.name,group])),visited=new Set<string>(),active=new Set<string>(),ids=new Set<string>(),pending:[string,boolean][]=[[root.name,false]]
  while(pending.length){
    const [name,leaving]=pending.pop()!
    if(leaving){active.delete(name);continue}
    if(active.has(name))catalogFail('SUBSCRIPTION_GROUP_CYCLE')
    if(visited.has(name)||builtinNames.has(name))continue
    visited.add(name)
    const node=nodes.get(name);if(node){ids.add(node.id);continue}
    const group=groups.get(name);if(!group)catalogFail('SUBSCRIPTION_GROUP_MEMBER_MISSING')
    active.add(name);pending.push([name,true]);for(const member of group.members)pending.push([member,false])
  }
  return [...ids]
}
