import {execFileSync} from 'node:child_process'
import {isIP} from 'node:net'

// Electron's net.fetch uses Chromium's system proxy settings, not Node/curl's
// HTTP(S)_PROXY environment. A LaunchServices instance therefore needs the
// supported Chromium switches when the computer only has an environment proxy.
const explicitProxy=/^--(?:proxy-server|proxy-pac-url|proxy-auto-detect|no-proxy-server|proxy-bypass-list)(?:=|$)/i
const loopbackBypass=['localhost','127.0.0.1','[::1]','<local>']

function proxyValue(env:NodeJS.ProcessEnv,lower:string):string|undefined {
  const value=env[lower]??env[lower.toUpperCase()]
  return value?.trim()?value:undefined
}

export function chromiumEnvironmentProxy(value:string):string|undefined {
  if(value.length>2048||/[\s\r\n\0;\\]/.test(value))return
  let url:URL
  try{url=new URL(value.includes('://')?value:`http://${value}`)}catch{return}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='')return
  const scheme=url.protocol==='socks5h:'?'socks5:':url.protocol
  if(!['http:','https:','socks4:','socks5:'].includes(scheme)||!url.hostname)return
  // Chromium explicitly does not accept username/password in --proxy-server.
  // Never put a credential into argv, and never strip it to silently change a
  // configured authenticated proxy into a different unauthenticated connection.
  const port=url.port||(scheme==='http:'?'80':scheme==='https:'?'443':undefined)
  if(!port)return
  return `${scheme}//${url.hostname}:${port}`
}

function bypassRules(env:NodeJS.ProcessEnv):string[]|undefined {
  const raw=proxyValue(env,'no_proxy')
  if(!raw)return [...loopbackBypass]
  if(raw.length>4096)return
  const values=raw.split(/[,\s]+/).filter(Boolean)
  if(values.includes('*'))return
  const rules:string[]=[...loopbackBypass]
  for(const value of values){
    if(!/^[\w.*:[\]\/\-]+$/.test(value))return
    if(value.includes('/')){
      const match=value.match(/^(.+)\/(\d+)$/),family=match&&isIP(match[1]),prefix=match?Number(match[2]):-1
      if(!family||prefix<0||prefix>(family===4?32:128))return
      rules.push(value);continue
    }
    if(isIP(value)===6){rules.push(`[${value}]`);continue}
    const bracketed=value.match(/^\[([^\]]+)\](?::(\d+))?$/)
    const hostPort=value.match(/^([^:]+)(?::(\d+))?$/)
    const match=bracketed??hostPort
    if(!match)return
    const host=match[1],port=match[2]?Number(match[2]):undefined
    if(port!==undefined&&(!Number.isInteger(port)||port<1||port>65535))return
    const suffix=port===undefined?'':`:${port}`
    if(bracketed){
      if(isIP(host)!==6)return
      rules.push(`[${host}]${suffix}`);continue
    }
    if(isIP(host)===4){rules.push(`${host}${suffix}`);continue}
    // Match both the domain itself and its subdomains, while keeping any
    // port restriction on both rules. Do not treat an unsupported glob or URL
    // as a different exclusion and silently proxy an intended direct host.
    const domain=host.replace(/^\*?\./,'')
    if(!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(domain))return
    rules.push(`${domain}${suffix}`,`*.${domain}${suffix}`)
  }
  return [...new Set(rules)]
}

export function desktopNetworkArgs(args:readonly string[],env:NodeJS.ProcessEnv,systemProxyEnabled:boolean|undefined):string[] {
  if(systemProxyEnabled!==false||args.some(arg=>explicitProxy.test(arg)))return [...args]
  const all=proxyValue(env,'all_proxy'),http=proxyValue(env,'http_proxy')??all,https=proxyValue(env,'https_proxy')??all
  if(!http&&!https)return [...args]
  const httpProxy=http?chromiumEnvironmentProxy(http):undefined,httpsProxy=https?chromiumEnvironmentProxy(https):undefined
  // Malformed, authenticated and unsupported environment settings preserve the
  // previous launch behavior; they must not prevent the instance from opening.
  if(http&&!httpProxy||https&&!httpsProxy)return [...args]
  const bypass=bypassRules(env)
  if(!bypass)return [...args]
  const proxy=httpProxy&&httpProxy===httpsProxy?httpProxy:[httpProxy?`http=${httpProxy}`:undefined,httpsProxy?`https=${httpsProxy}`:undefined].filter(Boolean).join(';')
  return [...args,`--proxy-server=${proxy}`,`--proxy-bypass-list=${bypass.join(';')}`]
}

export function macSystemProxyEnabled():boolean|undefined {
  if(process.platform!=='darwin')return
  try{
    const raw=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:1500,maxBuffer:8192,stdio:['ignore','pipe','ignore']})
    const values=[...raw.matchAll(/\b(?:HTTP|HTTPS|SOCKS|ProxyAutoConfig|ProxyAutoDiscovery)Enable\s*:\s*([01])\b/g)]
    return values.length?values.some(match=>match[1]==='1'):undefined
  }catch{return}
}
