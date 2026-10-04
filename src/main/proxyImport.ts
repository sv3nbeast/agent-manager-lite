// Credential-format recognition adapted from Cockpit codex_proxy_manual_import.rs.
// All parsing is local; preview errors and addresses never contain credentials.
import {createHash,randomUUID} from 'node:crypto'
import {normalizeProxy,proxyAddressView,type StoredProxyResource} from './proxyPolicy'
import type {ProxyImportOptions,ProxyImportPreview,ProxyImportRow} from '../shared/proxyBatch'
import {isNodeLink,parseProxyNode,proxyNodeName} from './proxyNode'
import {canonicalNode} from './proxyTunnels'

const invalid=()=>{throw new Error('invalid')}
function endpoint(value:string,protocol:string):string|undefined {
  const split=value.lastIndexOf(':'),host=value.slice(0,split),port=value.slice(split+1)
  if(split<1||!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||/[\s@/?#\\]/u.test(host)||(host.includes(':')&&!(host.startsWith('[')&&host.endsWith(']'))))return
  try{const url=new URL(`${protocol}://${value}`);if(url.hostname&&!url.username&&!url.password){normalizeProxy(url.toString());return value}}catch{}
}
function withAuth(host:string,auth:string,protocol:string):string|undefined {
  const target=endpoint(host,protocol),split=auth.indexOf(':');if(!target||split<1)return
  return `${protocol}://${encodeURIComponent(auth.slice(0,split))}:${encodeURIComponent(auth.slice(split+1))}@${target}`
}
export function normalizeProxyImportLine(raw:string,options:ProxyImportOptions):string {
  const input=raw.trim();if(!input||Buffer.byteLength(input)>8192||/[\p{Cc}]/u.test(input))return invalid()
  if(input.includes('://')){try{return normalizeProxy(input)}catch{return invalid()}}
  const candidates=new Set<string>(),add=(value:string|undefined)=>{if(value)candidates.add(value)}
  if(options.format==='auto'){const value=endpoint(input,options.protocol);if(value)add(`${options.protocol}://${value}`)}
  if(['auto','host_auth'].includes(options.format)){
    const offset=input.startsWith('[')?input.indexOf(']')+1:0,first=input.indexOf(':',offset),second=first<0?-1:input.indexOf(':',first+1)
    if(second>=0)add(withAuth(input.slice(0,second),input.slice(second+1),options.protocol))
  }
  for(let index=input.indexOf('@');index>=0;index=input.indexOf('@',index+1)){
    if(['auto','auth_at_host'].includes(options.format))add(withAuth(input.slice(index+1),input.slice(0,index),options.protocol))
    if(['auto','host_at_auth'].includes(options.format))add(withAuth(input.slice(0,index),input.slice(index+1),options.protocol))
  }
  if(candidates.size>1)throw new Error('ambiguous')
  if(candidates.size!==1)return invalid()
  try{return normalizeProxy([...candidates][0])}catch{return invalid()}
}
export function proxyImportFingerprint(raw:string):string {
  if(isNodeLink(raw))return createHash('sha256').update(canonicalNode(parseProxyNode(raw))).digest('hex')
  const url=new URL(normalizeProxy(raw)),protocol=url.protocol.startsWith('socks5')?'socks5:':url.protocol
  return createHash('sha256').update(JSON.stringify([protocol,url.hostname.toLowerCase(),Number(url.port)||(url.protocol==='https:'?443:80),decodeURIComponent(url.username),decodeURIComponent(url.password)])).digest('hex')
}
function uniqueName(raw:string,names:Set<string>):string {
  let base='';for(const character of raw){if(base.length+character.length>70)break;base+=character}
  let name=base,count=2
  while(names.has(name.toLowerCase()))name=`${base} (${count++})`
  names.add(name.toLowerCase());return name
}
export function prepareProxyImport(raw:string,options:ProxyImportOptions,existing:StoredProxyResource[]):{preview:ProxyImportPreview;resources:StoredProxyResource[]} {
  if(Buffer.byteLength(raw)>2*1024*1024)throw new Error('代理列表不能超过 2 MiB')
  let text=raw.trim(),encoded=false
  if(text&&!/[:@\r\n]/.test(text)&&/^[A-Za-z\d+/_-]+={0,2}$/.test(text)){
    try{const bytes=Buffer.from(text,'base64');if(bytes.toString('base64').replace(/=+$/,'')!==text.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''))throw 0;text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);encoded=true}catch{throw new Error('Base64 代理列表无效')}
  }
  // Structured sources must keep their references; never flatten a partially parsed document.
  if(/^\s*\{|^\s*\[\s*["{]|(?:^|\n)\s*(?:proxies|proxy-groups)\s*:/u.test(text))throw new Error('此入口用于逐行代理地址；结构化订阅和代理组尚未接入')
  const seen=new Set<string>(),names=new Set(existing.map(r=>r.name.toLowerCase())),resources:StoredProxyResource[]=[],rows:ProxyImportRow[]=[]
  for(const resource of existing)try{seen.add(proxyImportFingerprint(resource.url))}catch{}
  for(const [index,rawLine] of text.split(/\r?\n/).entries()){
    const line=rawLine.trim();if(!line||line.startsWith('#'))continue
    if(rows.length>=4096)throw new Error('一次最多预览 4096 行代理')
    try{
      const url=normalizeProxyImportLine(line,options),address=proxyAddressView(url),key=proxyImportFingerprint(url),duplicate=seen.has(key);seen.add(key)
      let label=`${address.protocol} · ${address.server}:${address.port}`
      if(isNodeLink(line))label=proxyNodeName(line)??label
      else if(line.includes('://')){try{const fragment=decodeURIComponent(new URL(line).hash.slice(1));if(fragment&&!/[\p{Cc}]|:\/\/|token=|password=/iu.test(fragment))label=fragment}catch{}}
      const name=uniqueName(label,names),included=!duplicate||!options.skipDuplicates
      rows.push({line:index+1,name,address,duplicate,included})
      if(included)resources.push({id:randomUUID(),revision:0,name,url})
    }catch(cause){rows.push({line:index+1,duplicate:false,included:false,error:cause instanceof Error&&cause.message==='ambiguous'?'ambiguous':'invalid'})}
  }
  if(!rows.length)throw new Error('请输入至少一行代理地址')
  const invalidCount=rows.filter(r=>r.error).length,duplicates=rows.filter(r=>r.duplicate).length
  const blocked=invalidCount&&!options.skipInvalid?'存在无效或歧义行，请修正或明确选择跳过无效行':!resources.length?'没有可导入的代理':resources.length+existing.length>500?'保存后将超过 500 个手动代理资源，请缩小导入范围':undefined
  return {resources,preview:{encoded,rows,valid:rows.length-invalidCount-duplicates,invalid:invalidCount,duplicates,added:resources.length,...blocked?{blocked}:{}}}
}
