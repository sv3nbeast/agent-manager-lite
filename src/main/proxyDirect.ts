export function normalizeDirectProxy(input:string):string{
  const fail=()=>{throw new Error('代理地址无效，请使用支持的代理地址或节点分享链接')}
  const raw=input.trim();if(!raw||raw.length>8192||/[\u0000-\u0020\u007f\\]/.test(raw))return fail()
  let url:URL;try{url=new URL(raw)}catch{return fail()}
  if(!['http:','https:','socks5:','socks5h:'].includes(url.protocol)||!url.hostname||!['','/'].includes(url.pathname)||url.search)return fail()
  const port=url.port?Number(url.port):url.protocol==='http:'?80:url.protocol==='https:'?443:0
  if(!Number.isInteger(port)||port<1||port>65535)return fail()
  try{for(const part of [url.username,url.password])if(/[\u0000-\u001f\u007f]/.test(decodeURIComponent(part)))return fail()}catch{return fail()}
  url.hash='';return url.toString()
}
