// Share-link semantics from Cockpit ee816002 codex_proxy_node_parser.rs;
// native output conversion from codex_proxy_mihomo.rs::legacy_proxy.
// Complete native catalogs/groups are a separate import boundary.
export type MihomoProxy=Record<string,unknown>&{name:string;type:string;server:string;port:number}
export class ProxyNodeError extends Error {constructor(unsupported=false){super(unsupported?'节点包含尚不支持的参数，请检查链接配置':'节点链接格式无效，请检查协议、地址与凭据')}}
function invalid():never{throw new ProxyNodeError()}
function unsupported():never{throw new ProxyNodeError(true)}
const control=/[\p{Cc}]/u,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isNodeLink=(raw:string)=>/^(?:ss|vmess|vless|trojan|hy2|hysteria2|tuic):\/\//.test(raw.trim())
function decode(value:string):string{try{const result=decodeURIComponent(value);if(control.test(result))invalid();return result}catch{return invalid()}}
function base64(value:string):Buffer{
  if(!value||!/^[-_A-Za-z0-9+/]+={0,2}$/.test(value))invalid()
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''),bytes=Buffer.from(value,'base64')
  if(bytes.toString('base64').replace(/=+$/,'')!==normalized)invalid();return bytes
}
function text(bytes:Buffer):string{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return invalid()}}
function host(value:string):string {
  const result=value.replace(/^\[|\]$/g,'')
  if(!result||Buffer.byteLength(result)>253||/[\s/@?#\\\p{Cc}]/u.test(result))invalid()
  return result
}
function port(value:string):number{if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>65535)invalid();return Number(value)}
function query(url:URL,allowed:string[]):Map<string,string>{
  const result=new Map<string,string>()
  for(const item of url.search.slice(1).split('&').filter(Boolean)){
    const separator=item.indexOf('=');if(separator<0)invalid()
    const key=decode(item.slice(0,separator)),value=decode(item.slice(separator+1))
    if(!allowed.includes(key))unsupported();if(result.has(key))invalid();result.set(key,value)
  }
  return result
}
const tlsKeys=['security','sni','alpn','fp','pbk','sid','insecure','allowInsecure'],transportKeys=['type','host','path','serviceName']
function tls(out:MihomoProxy,q:Map<string,string>,required:boolean){
  for(const key of ['insecure','allowInsecure'])if(q.has(key)&&!['0','false'].includes(q.get(key)!))unsupported()
  const security=q.get('security')??(required?'tls':'none')
  if(!['none','tls','reality'].includes(security)||required&&security==='none')unsupported()
  if(security==='none'){if(['sni','alpn','fp','pbk','sid'].some(key=>q.has(key)))unsupported();return}
  if(['vmess','vless'].includes(out.type))out.tls=true
  if(q.has('sni')){const sni=q.get('sni')!;if(!sni||/\s/u.test(sni))invalid();out[['vmess','vless'].includes(out.type)?'servername':'sni']=sni}
  if(q.has('alpn')){const items=q.get('alpn')!.split(',');if(items.some(v=>!v||Buffer.byteLength(v)>255))invalid();out.alpn=items}
  if(q.has('fp')){const fp=q.get('fp')!;if(!['chrome','firefox','safari','ios','android','edge','360','qq','random','randomized'].includes(fp))unsupported();out['client-fingerprint']=fp}
  if(security==='reality'){
    const pbk=q.get('pbk')??'',sid=q.get('sid')??''
    if(!/^[A-Za-z0-9_-]+$/.test(pbk)||base64(pbk).length!==32||sid.length>16||sid.length%2||!/^[a-f\d]*$/i.test(sid))invalid()
    out['reality-opts']={'public-key':pbk,'short-id':sid};out['client-fingerprint']??='chrome'
  }else if(q.has('pbk')||q.has('sid'))unsupported()
}
function transport(out:MihomoProxy,q:Map<string,string>){
  const type=q.get('type')??'tcp'
  if(type==='tcp'){if(['host','path','serviceName'].some(key=>q.has(key)))unsupported();return}
  if(type==='ws'||type==='httpupgrade'){
    if(q.has('serviceName'))unsupported()
    const opts:Record<string,unknown>={path:q.get('path')??'/'}
    if(q.has('host'))opts.headers={Host:q.get('host')}
    if(type==='httpupgrade')opts['v2ray-http-upgrade']=true
    out.network='ws';out['ws-opts']=opts
  }else if(type==='grpc'){
    if(q.has('host')||q.has('path'))unsupported();out.network='grpc';out['grpc-opts']={'grpc-service-name':q.get('serviceName')??''}
  }else unsupported()
}
function parseVMess(input:string):MihomoProxy{
  let obj:Record<string,unknown>
  try{obj=JSON.parse(text(base64(input.slice(8))));if(!obj||Array.isArray(obj)||typeof obj!=='object')invalid()}catch{return invalid()}
  const allowed=['v','ps','add','port','id','aid','scy','net','type','host','path','tls','sni','alpn','fp','insecure']
  if(Object.keys(obj).some(key=>!allowed.includes(key)))unsupported()
  const field=(key:string,fallback:string)=>{const value=obj[key];if(value===undefined)return fallback;if(typeof value==='number'&&Number.isFinite(value))return String(value);if(typeof value==='string'&&!control.test(value))return value;return invalid()}
  if(field('v','2')!=='2'||field('aid','0')!=='0'||!['none',''].includes(field('type','none')))unsupported()
  const id=field('id',''),server=host(field('add','')),cipher=field('scy','auto')
  if(!uuid.test(id))invalid()
  if(!['auto','aes-128-gcm','chacha20-poly1305','zero','none'].includes(cipher))unsupported()
  const out:MihomoProxy={name:'account-node',type:'vmess',server,port:port(field('port','')),uuid:id,cipher,alterId:0}
  const value=field('tls','');if(!['','none','tls'].includes(value))unsupported()
  const q=new Map([['security',value||'none'],['type',field('net','tcp')]])
  for(const key of ['host','path','sni','alpn','fp','insecure']){const value=field(key,'');if(value)q.set(key,value)}
  tls(out,q,false);transport(out,q);return out
}
export function parseProxyNode(raw:string):MihomoProxy{
  if(Buffer.byteLength(raw)>8192||control.test(raw))invalid()
  const input=raw.trim();if(input.startsWith('vmess://'))return parseVMess(input)
  let url:URL;try{url=new URL(input)}catch{return invalid()}
  const kind=url.protocol==='hy2:'?'hysteria2':url.protocol.slice(0,-1)
  if(!['ss','vless','trojan','hysteria2','tuic'].includes(kind))unsupported()
  if(!['','/'].includes(url.pathname))unsupported()
  const server=host(url.hostname)
  decode(url.hash.slice(1))
  const out:MihomoProxy={name:'account-node',type:kind,server,port:port(url.port||(['trojan','hysteria2','tuic'].includes(kind)?'443':''))}
  if(kind==='ss'){
    query(url,[])
    const authority=input.slice(5).split(/[/?#]/)[0],at=authority.lastIndexOf('@');if(at<0)invalid()
    const user=decode(authority.slice(0,at)),credentials=user.includes(':')?user:text(base64(user)),split=credentials.indexOf(':');if(split<0)invalid()
    const method=credentials.slice(0,split),password=credentials.slice(split+1)
    if(!['aes-128-gcm','aes-192-gcm','aes-256-gcm','chacha20-ietf-poly1305','xchacha20-ietf-poly1305','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305'].includes(method))unsupported()
    if(!password||control.test(credentials))invalid()
    if(method.startsWith('2022-'))for(const key of password.split(':'))if(base64(key).length!==(method==='2022-blake3-aes-128-gcm'?16:32))invalid()
    return {...out,cipher:method,password}
  }
  const user=decode(url.username);if(!user)invalid()
  // An explicit empty password separator is invalid for VLESS/Trojan too.
  const authority=input.slice(input.indexOf('://')+3).split(/[/?#]/)[0],userinfo=authority.slice(0,authority.lastIndexOf('@'))
  if(kind==='vless'||kind==='trojan'){
    if(userinfo.includes(':'))invalid()
    const allowed=kind==='vless'?[...tlsKeys,...transportKeys,'flow','encryption']:[...tlsKeys.filter(k=>!['pbk','sid'].includes(k)),...transportKeys],q=query(url,allowed)
    if(kind==='vless'){
      if(!uuid.test(user))invalid();if((q.get('encryption')??'none')!=='none')unsupported();out.uuid=user
      if(q.has('flow')){if(q.get('flow')!=='xtls-rprx-vision'||(q.get('type')??'tcp')!=='tcp'||!['tls','reality'].includes(q.get('security')??'none'))unsupported();out.flow=q.get('flow')}
    }else out.password=user
    tls(out,q,kind==='trojan');transport(out,q)
  }else if(kind==='hysteria2'){
    const q=query(url,['sni','alpn','insecure','obfs','obfs-password'])
    out.password=userinfo.includes(':')?user+':'+decode(url.password):user
    if(q.has('obfs')){if(q.get('obfs')!=='salamander')unsupported();if(!q.get('obfs-password'))invalid();out.obfs='salamander';out['obfs-password']=q.get('obfs-password')}else if(q.has('obfs-password'))unsupported()
    tls(out,q,true)
  }else{
    if(!uuid.test(user)||!url.password)invalid()
    const q=query(url,['sni','alpn','insecure','congestion_control','udp_relay_mode']),congestion=q.get('congestion_control')??'cubic',relay=q.get('udp_relay_mode')??'native'
    if(!['cubic','new_reno','bbr'].includes(congestion)||!['native','quic'].includes(relay))unsupported()
    Object.assign(out,{uuid:user,password:decode(url.password),'congestion-controller':congestion,'udp-relay-mode':relay});tls(out,q,true)
  }
  return out
}
export function proxyNodeName(input:string):string|undefined{
  try{
    const value=input.startsWith('vmess://')?JSON.parse(text(base64(input.slice(8)))).ps:decode(new URL(input).hash.slice(1))
    if(typeof value==='string'&&value.trim()&&value.length<=256&&!control.test(value)&&!/:\/\/|token=|password=/i.test(value))return value.trim()
  }catch{}
}
