import {isAlias,isMap,isNode,isScalar,isSeq,parseAllDocuments,type Node} from 'yaml'
import {catalogFail} from './proxyNative'

// Convert the AST ourselves: aliases are bounded before expansion, string keys
// stay strings, and neither explicit tags nor merge constructors are executed.
export function parseCatalogDocument(input:string):unknown{
  if(Buffer.byteLength(input)>2*1024*1024)catalogFail('SUBSCRIPTION_TOO_LARGE')
  try{
    const documents=parseAllDocuments(input,{strict:true,uniqueKeys:true,prettyErrors:false,logLevel:'silent',schema:'core',version:'1.2',resolveKnownTags:false,merge:false,intAsBigInt:true})
    if(documents.length!==1)catalogFail()
    const document=documents[0]
    if(document.errors.length||document.warnings.length)catalogFail()
    const anchors=new Map<string,Node>(),targets=new Map<Node,Node>()
    let scanned=0
    const inspect=(value:unknown,depth:number):void=>{
      if(depth>32||++scanned>100_000)catalogFail()
      if(value===null)return
      if(!isNode(value)||value.tag)catalogFail()
      if(isAlias(value)){
        const target=anchors.get(value.source);if(!target)catalogFail();targets.set(value,target)
      }else{
        if(value.anchor)anchors.set(value.anchor,value)
        if(isMap(value))for(const pair of value.items){inspect(pair.key,depth+1);inspect(pair.value,depth+1)}
        else if(isSeq(value))for(const item of value.items)inspect(item,depth+1)
      }
    }
    inspect(document.contents,0)
    let budget=100_000,bytes=0
    const active=new Set<Node>()
    const expand=(value:unknown,depth:number):unknown=>{
      if(depth>32||--budget<0)catalogFail()
      if(value===null)return null
      if(!isNode(value)||active.has(value))catalogFail()
      active.add(value)
      let result:unknown
      if(isAlias(value))result=expand(targets.get(value),depth+1)
      else if(isScalar(value)){
        result=value.value
        if(typeof result==='bigint'){if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))catalogFail();result=Number(result)}
        if(typeof result==='string'){
          const length=Buffer.byteLength(result);bytes+=length
          if(length>16384||bytes>32*1024*1024||result.includes('\0'))catalogFail()
        }else if(typeof result==='number'){if(!Number.isFinite(result))catalogFail()}
        else if(result!==null&&typeof result!=='boolean')catalogFail()
      }else if(isSeq(value))result=value.items.map(item=>expand(item,depth+1))
      else if(isMap(value)){
        result={}
        for(const pair of value.items){
          const key=expand(pair.key,depth+1)
          if(typeof key!=='string'||Object.hasOwn(result as object,key))catalogFail()
          Object.defineProperty(result,key,{value:expand(pair.value,depth+1),enumerable:true,writable:true,configurable:true})
        }
      }else catalogFail()
      active.delete(value)
      return result
    }
    return expand(document.contents,0)
  }catch{ return catalogFail() }
}
