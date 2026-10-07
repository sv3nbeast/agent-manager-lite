// Capability-based renderer compatibility for manager-owned desktop instances.
// Exact historical profiles remain as regression-tested compatibility paths.
// The installed application, credentials and Codex configuration are read-only.
import {createHash,randomUUID} from 'node:crypto'
import * as nodeFS from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join,isAbsolute,relative,sep} from 'node:path'
import {applyCodexUiReplacements,codexUiFeatures,detectCodexUiCapabilities,type CodexUiFeature,type CodexUiFeatureSupports,type CodexUiReplacement} from './codexUiCapabilities'

const rawFS:typeof nodeFS=process.versions.electron?createRequire(join(dirname(process.execPath),'cml-runtime.cjs'))('original-fs'):nodeFS
export type CodexSpeedMenuEnhancements='speed'|'locale'|'speed-locale'
type CodexSpeedReplacement=CodexUiReplacement
type CodexReleaseProfile={
  id:string
  version:string
  injection:'preload'|'cdp'
  asset:string
  url:string
  source:string
  patched:Record<CodexSpeedMenuEnhancements,string>
  earlyBootstrap:string
  bootstrap:string
  appProtocol?:{asset:string;source:string;requirement:string}
  fuseWireSha256?:string
  speedReplacements:readonly CodexSpeedReplacement[]
  ultraReplacements?:readonly CodexSpeedReplacement[]
  localeReplacement?:CodexSpeedReplacement
  replacements?:readonly CodexSpeedReplacement[]
}
const legacySpeedReplacements=[
  {begin:'function TRa(e){',end:'}var ERa;',before:'a=i?.authMethod===`chatgpt`,o=',after:'a=i?.authMethod===`chatgpt`||i?.authMethod===`apikey`||r===`local`&&i?.authMethod===null&&i?.requiresAuth===!1,o='},
  {begin:'function Yqt(e,{runtime:t,storage:n},r,i){',end:'function Xqt(){',before:'let[r,i]=await Promise.all([e.getAccount({priority:`critical`}),e.getAuthMethod({priority:`critical`}).catch(()=>null)]);return i!==`personalAccessToken`&&r.account?.type===`chatgpt`',after:'let[r,i]=await Promise.all([e.getAccount({priority:`critical`}),e.getAuthMethod({priority:`critical`}).catch(()=>void 0)]);return i!==`personalAccessToken`&&(r.account?.type===`chatgpt`||r.account?.type===`apiKey`||e.getHostId()===`local`&&i===null&&r.account===null&&r.requiresOpenaiAuth===!1)'},
  {begin:'async function Qdi(e,t){',end:'async function $di(',before:'if(n!==`chatgpt`)return!1;',after:'if(n!==`chatgpt`&&n!==`apikey`){if(n!==null||t!==`local`)return!1;let a;try{a=await ep(e,t).getAccount({priority:`critical`})}catch{return!1}if(a?.account!==null||a?.requiresOpenaiAuth!==!1)return!1;}'}
] as const
// Only the translation provider is adapted. All built-in language resolution,
// message loading and explicit selections stay in the official renderer.
const legacyLocaleReplacement={begin:'function Wal(e){',end:'function Gal(){}',before:'let c=s,l=o?.get(`locale_source`,`IDE`)',after:'let c=!0,l=a?.systemLocale?`SYSTEM`:`IDE`'} as const
const currentSpeedReplacements=[
  {begin:'function lai(e){',end:'}var uai;',before:'a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`,',after:'a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`apikey`||r===`local`&&i?.authMethod===null&&i?.requiresAuth===!1,'},
  {begin:'async function Z$i(e,t){',end:'async function Q$i(',before:'if(n!==`chatgpt`&&n!==`personalAccessToken`)return!1;',after:'if(n!==`chatgpt`&&n!==`personalAccessToken`&&n!==`apikey`){if(n!==null||t!==`local`)return!1;let a;try{a=await vf(e.get(yf,t)?.rpc.getAccount({priority:`critical`}))}catch{return!1}if(a?.account!==null||a?.requiresOpenaiAuth!==!1)return!1;}' }
] as const
// The current renderer keeps the ultra reasoning level behind two server
// feature gates. Manager-owned local providers already advertise this level
// in their model catalog, so the audited renderer must keep it selectable and
// persist it for the isolated instance.
const currentUltraReplacements=[
  {begin:'function cni(){',end:'function lni(e){',before:'sni=ds(W,({get:e})=>new Set([..._g(e,Rse.enabledReasoningEfforts),`persistent`]))',after:'sni=ds(W,({get:e})=>new Set([..._g(e,Rse.enabledReasoningEfforts),`persistent`,`ultra`]))'},
  {begin:'function Kti({',end:'function qti(',before:'let u=[],d=null,f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),p=o&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));',after:'let u=[],d=null,f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),p=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));'},
  {begin:'function Kti({',end:'function qti(',before:'let e=o?r.supportedReasoningEfforts:r.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),',after:'let e=r.supportedReasoningEfforts,'},
  {begin:'function qDn(e,t,n){',end:'function JDn(e,t){',before:'return n===`ultra`&&!e(j,`536305374`)?void 0:n',after:'return !1?void 0:n'},
  {begin:'function $Dn(e,t){',end:'function eOn(e,t){',before:'(t.thinkingEffort!==`ultra`||e.get(j,`536305374`))&&e.get(LDn).mutate',after:'(t.thinkingEffort!==`ultra`||!0)&&e.get(LDn).mutate'},
  {begin:'function $Dn(e,t){',end:'function eOn(e,t){',before:'let n=e.get(yA),r=t.thinkingEffort!==`ultra`||e.get(j,`536305374`),',after:'let n=e.get(yA),r=!0,'},
  {begin:'function eOn(e,t){',end:'var tOn,nOn,rOn,iOn;',before:'else if(!e.get(j,`536305374`)){',after:'else if(!1){'}
] as const
const currentLocaleReplacement={begin:'function gZs(e){',end:'function _Zs(){}',before:'let l=c,u=s?.get(`locale_source`,`IDE`)',after:'let l=!0,u=o?.systemLocale?`SYSTEM`:`IDE`'} as const
// 26.930.51102 keeps the locale provider in a wrapper component and moves
// the renderer body to `_Zs`.  Keep this marker separate from the audited
// 41038 profile so an upstream bundle reshuffle cannot silently broaden the
// patch target.
const currentWrappedLocaleReplacement={begin:'function _Zs(e){',end:'function vZs(){}',before:'let l=c,u=s?.get(`locale_source`,`IDE`)',after:'let l=!0,u=o?.systemLocale?`SYSTEM`:`IDE`'} as const
const releases:readonly CodexReleaseProfile[]=[
  {id:'26.915.31945',version:'26.915.31945',injection:'preload',asset:'webview/assets/app-initial-a498f911edeb.js',url:'app://-/assets/app-initial-a498f911edeb.js',source:'34a75db63c7137eb4caecdba1f36d631c10c7912487e532fd5e9dafb175bb9be',patched:{speed:'5d8a7434e2ce686bcf359ea16d7d889bc0df9ec4c513d0222992ff7d038807a8',locale:'f76d1b5e0f1ef29951cf301d1bf31f9155fbebd79e35fcb48c8a203ade2b8754','speed-locale':'a21d5bf01e4280636727813c12f77fa45d87cb555606712f9c4fb98b9ef06b30'},earlyBootstrap:'.vite/build/early-bootstrap.js',bootstrap:'.vite/build/bootstrap-DF0QwAxC.js',speedReplacements:legacySpeedReplacements,localeReplacement:legacyLocaleReplacement},
  {id:'26.930.41038',version:'26.930.41038',injection:'cdp',fuseWireSha256:'352dd1a2192c4570488ed05121a0a8d3f20db7de8862181b6d6cdde148996642',asset:'webview/assets/app-initial-f5551f754e43.js',url:'app://-/assets/app-initial-f5551f754e43.js',source:'be620740a6218c263b32e3692ed2e40768624d984662731b0cbb359af47ebe8e',patched:{speed:'876e96728da1a7431a33bf9494c1c260faa5bde151a1e602a13f6db6b4789929',locale:'7a7a679d1d461961d3d7d4f1fb7aadf59c759ace0fa1aa48db1c085b2aef683d','speed-locale':'4c32ffa56c3a76f9ce54ca0962ccdac366f6685fe22eaacdbf34bc8380d36d1b'},earlyBootstrap:'.vite/build/early-bootstrap.js',bootstrap:'.vite/build/bootstrap-D18rbfeM.js',appProtocol:{asset:'.vite/build/app-protocol-DC-JCzS7.js',source:'b5fb869f9d9c3b42c2b1c3de28e154c9f2597379a8122a76263da00b3771cb19',requirement:'require("./app-protocol-DC-JCzS7.js")'},speedReplacements:currentSpeedReplacements,ultraReplacements:currentUltraReplacements,localeReplacement:currentLocaleReplacement},
  {id:'26.930.51102',version:'26.930.51102',injection:'cdp',fuseWireSha256:'352dd1a2192c4570488ed05121a0a8d3f20db7de8862181b6d6cdde148996642',asset:'webview/assets/app-initial-f9b16fbf8fc7.js',url:'app://-/assets/app-initial-f9b16fbf8fc7.js',source:'22f3ea455585cfc0508e3d3627eac161c80c849c0aace3d76d09fdebaa0aeca3',patched:{speed:'5de6f1c3edff9c936cb1e75192e28f464f731f1cede2253a54183ce49f8210a0',locale:'470630cf7208ef1e98fc07f97af6ca28b717051876f1368a57fd25609659cbca', 'speed-locale':'8349a89e0fe3a5c5159f6b437ebba8284a8242d454f9a3fc9e3b902649c856cd'},earlyBootstrap:'.vite/build/early-bootstrap.js',bootstrap:'.vite/build/bootstrap-CXJAEjVI.js',appProtocol:{asset:'.vite/build/app-protocol-DC-JCzS7.js',source:'b5fb869f9d9c3b42c2b1c3de28e154c9f2597379a8122a76263da00b3771cb19',requirement:'require("./app-protocol-DC-JCzS7.js")'},speedReplacements:currentSpeedReplacements,ultraReplacements:currentUltraReplacements,localeReplacement:currentWrappedLocaleReplacement}
]
const releaseByVersion=new Map(releases.map(profile=>[profile.version,profile]))
const replacementsFor=(profile:CodexReleaseProfile,enhancements:CodexSpeedMenuEnhancements):readonly CodexSpeedReplacement[]=>{if(profile.replacements)return profile.replacements;const ultra=profile.ultraReplacements??[],locale=profile.localeReplacement?[profile.localeReplacement]:[];return enhancements==='speed'?[...profile.speedReplacements,...ultra]:enhancements==='locale'?[...ultra,...locale]:[...profile.speedReplacements,...ultra,...locale]}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const sentinel=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')

export interface CodexSpeedMenuInspection {
  supported:boolean
  reason:string
  fingerprint:string
  version?:string
  assetURL?:string
  sourceSha256?:string
  patchedSha256?:string
  enhancements?:CodexSpeedMenuEnhancements
  transport?:'preload'|'cdp'
  features?:readonly CodexUiFeature[]
  featureSupport?:CodexUiFeatureSupports
}
export interface CodexSpeedMenuInspectOptions {application:string;executable:string;platform?:NodeJS.Platform;enhancements?:CodexSpeedMenuEnhancements;features?:readonly CodexUiFeature[]}
export interface CodexSpeedMenuReader {
  canonical(path:string):string
  identity(path:string):string
  file(path:string,limit:number):Buffer
  archive(path:string,entry:string,limit:number):Buffer
  fuseWires(path:string):Buffer[]
  /** Dependency injection for isolated fixtures; production always uses SHA256. */
  digest?(value:string|Buffer):string
}
export interface CodexSpeedMenuHook {script:string;manifest:string;statusLog:string;env:Record<string,string>;transport?:'preload'|'cdp';manifestSha256?:string;patchedBody?:string;features?:readonly CodexUiFeature[]}
export interface CodexSpeedMenuPrepareOptions {
  inspection:CodexSpeedMenuInspection
  directory:string
  desktopDirectory:string
  executable:string
  nonce:string
  hookDirectory?:string
}
export interface CodexSpeedMenuStatusScope {statusLog:string;nonce:string;executable:string;directory:string;pid?:number;enhancements?:CodexSpeedMenuEnhancements;feature?:CodexUiFeature}
export interface CodexSpeedMenuStatus {state:'pending'|'active'|'fallback';reason?:string}

function boundedFile(path:string,limit:number):Buffer {
  const fd=rawFS.openSync(path,rawFS.constants.O_RDONLY|rawFS.constants.O_NOFOLLOW|rawFS.constants.O_NONBLOCK)
  try{
    const stat=rawFS.fstatSync(fd)
    if(!stat.isFile()||stat.size>limit)throw new Error('file limit')
    const body=Buffer.alloc(stat.size)
    let offset=0
    while(offset<body.length){const size=rawFS.readSync(fd,body,offset,body.length-offset,offset);if(!size)throw new Error('short read');offset+=size}
    return body
  }finally{rawFS.closeSync(fd)}
}
function packedFile(path:string,entry:string,limit:number):Buffer {
  const fd=rawFS.openSync(path,rawFS.constants.O_RDONLY|rawFS.constants.O_NOFOLLOW|rawFS.constants.O_NONBLOCK)
  const read=(offset:number,length:number)=>{
    const result=Buffer.alloc(length);let count=0
    while(count<length){const n=rawFS.readSync(fd,result,count,length-count,offset+count);if(!n)throw new Error('short archive read');count+=n}
    return result
  }
  try{
    const stat=rawFS.fstatSync(fd)
    if(!stat.isFile()||stat.size<16)throw new Error('archive type')
    const size=read(0,8)
    if(size.readUInt32LE(0)!==4)throw new Error('archive size pickle')
    const headerSize=size.readUInt32LE(4)
    if(headerSize<8||headerSize>32*1024*1024||headerSize+8>stat.size)throw new Error('archive header limit')
    const header=read(8,headerSize),jsonSize=header.readUInt32LE(4)
    if(header.readUInt32LE(0)!==headerSize-4||jsonSize>headerSize-8)throw new Error('archive header pickle')
    let item: any=JSON.parse(header.subarray(8,8+jsonSize).toString('utf8'))
    for(const part of entry.split('/')){
      if(!part||part==='.'||part==='..'||!item?.files||!Object.hasOwn(item.files,part))throw new Error('archive entry')
      item=item.files[part]
    }
    if(item?.link||item?.unpacked||item?.files||!Number.isSafeInteger(item?.size)||item.size<0||item.size>limit||typeof item.offset!=='string'||!/^\d+$/.test(item.offset))throw new Error('archive entry type')
    const offset=Number(item.offset)+8+headerSize
    if(!Number.isSafeInteger(offset)||offset<8+headerSize||offset+item.size>stat.size)throw new Error('archive entry bounds')
    return read(offset,item.size)
  }finally{rawFS.closeSync(fd)}
}
function scanFuseWires(path:string):Buffer[] {
  const fd=rawFS.openSync(path,rawFS.constants.O_RDONLY|rawFS.constants.O_NOFOLLOW|rawFS.constants.O_NONBLOCK)
  try{
    const stat=rawFS.fstatSync(fd)
    if(!stat.isFile()||stat.size>1024*1024*1024)throw new Error('framework type')
    const wires:Buffer[]=[],chunk=Buffer.alloc(1024*1024),seen=new Set<number>()
    let position=0,tail=Buffer.alloc(0)
    while(position<stat.size){
      const n=rawFS.readSync(fd,chunk,0,Math.min(chunk.length,stat.size-position),position)
      if(!n)throw new Error('short framework read')
      const data=Buffer.concat([tail,chunk.subarray(0,n)]),base=position-tail.length
      let start=0
      for(;;){
        const found=data.indexOf(sentinel,start);if(found<0)break;start=found+1
        const absolute=base+found
        if(seen.has(absolute))continue
        const header=Buffer.alloc(2),wireOffset=absolute+sentinel.length
        if(rawFS.readSync(fd,header,0,2,wireOffset)!==2||header[1]>64||header[1]<3)throw new Error('fuse wire')
        const wire=Buffer.alloc(header[1]+2)
        if(rawFS.readSync(fd,wire,0,wire.length,wireOffset)!==wire.length)throw new Error('fuse wire truncated')
        wires.push(wire);seen.add(absolute)
        if(wires.length>16)throw new Error('fuse count')
      }
      tail=Buffer.from(data.subarray(Math.max(0,data.length-sentinel.length+1)));position+=n
    }
    return wires
  }finally{rawFS.closeSync(fd)}
}
const defaultReader:CodexSpeedMenuReader={
  canonical:path=>rawFS.realpathSync(path),
  identity:path=>{const s=rawFS.lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw new Error('resource type');return JSON.stringify([path,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs])},
  file:boundedFile,archive:packedFile,fuseWires:scanFuseWires
}
const checked=new WeakMap<CodexSpeedMenuInspection,{options:CodexSpeedMenuInspectOptions;reader:CodexSpeedMenuReader;profile:CodexReleaseProfile}>()
const inspectionCache=new Map<string,CodexSpeedMenuInspection>()

function patch(source:string,profile:CodexReleaseProfile,enhancements:CodexSpeedMenuEnhancements):string {
  if(profile.replacements?.every(r=>r.offset!==undefined))return applyCodexUiReplacements(source,profile.replacements)
  let result=source
  for(const replacement of replacementsFor(profile,enhancements)){
    const start=result.indexOf(replacement.begin)
    if(start<0||result.indexOf(replacement.begin,start+1)!==-1)throw new Error('patch start')
    const end=result.indexOf(replacement.end,start+replacement.begin.length)
    if(end<0)throw new Error('patch end')
    const body=result.slice(start,end)
    if(body.split(replacement.before).length!==2)throw new Error('patch count')
    result=result.slice(0,start)+body.replace(replacement.before,replacement.after)+result.slice(end)
  }
  return result
}
export function inspectCodexSpeedMenu(options:CodexSpeedMenuInspectOptions,reader:CodexSpeedMenuReader=defaultReader):CodexSpeedMenuInspection {
  if(options.features)return inspectCodexDesktopUi(options,reader)
  const enhancements=options.enhancements??'speed'
  const parts:unknown[]=[options.application,options.executable,options.platform??process.platform,enhancements],digest=reader.digest??hash
  let version:string|undefined,profile:CodexReleaseProfile|undefined,cacheKey:string|undefined
  const finish=(supported:boolean,reason:string):CodexSpeedMenuInspection=>{
    const patchedSha256=profile?.patched[enhancements]
    const result=Object.freeze({supported,reason,fingerprint:hash(JSON.stringify(parts)),...(version?{version}:{}),...(supported&&profile&&patchedSha256?{assetURL:profile.url,sourceSha256:profile.source,patchedSha256,enhancements,transport:profile.injection}:{})})
    if(supported&&profile)checked.set(result,{options:{...options,enhancements},reader,profile})
    if(cacheKey&&supported){if(inspectionCache.size>=16)inspectionCache.delete(inspectionCache.keys().next().value!);inspectionCache.set(cacheKey,result)}
    return result
  }
  if(!['speed','locale','speed-locale'].includes(enhancements))return finish(false,'未知的 Codex 界面适配模式，使用原界面')
  if((options.platform??process.platform)!=='darwin')return finish(false,'当前平台暂不支持 Codex 速度菜单')
  try{
    if(!isAbsolute(options.application)||!options.application.endsWith('.app')||reader.canonical(options.application)!==options.application||reader.canonical(options.executable)!==options.executable||dirname(options.executable)!==join(options.application,'Contents','MacOS'))return finish(false,'客户端路径不符合隔离启动要求')
    const archive=join(options.application,'Contents','Resources','app.asar'),framework=reader.canonical(join(options.application,'Contents','Frameworks','Codex Framework.framework','Codex Framework'))
    if(relative(options.application,framework).startsWith('..'+sep)||isAbsolute(relative(options.application,framework)))return finish(false,'客户端框架路径不符合兼容要求')
    parts.push(reader.identity(options.executable),reader.identity(archive),reader.identity(framework))
    if(reader===defaultReader){cacheKey=hash(JSON.stringify(parts));const cached=inspectionCache.get(cacheKey);if(cached)return cached}
    const pkgBody=reader.archive(archive,'package.json',128*1024),pkg=JSON.parse(pkgBody.toString('utf8'))
    parts.push(digest(pkgBody));version=typeof pkg.version==='string'?pkg.version:undefined;profile=version?releaseByVersion.get(version):undefined
    if(pkg.name!=='openai-codex-electron'||pkg.main!=='.vite/build/early-bootstrap.js'||profile===undefined)return finish(false,'当前 Codex 版本尚未适配，使用原界面')
    parts.push(profile.id,profile.source,profile.appProtocol?.source??'legacy-bootstrap-protocol')
    const patchedSha256=profile.patched[enhancements]
    const wires=reader.fuseWires(framework);parts.push(wires.map(w=>hash(w)))
    if(!wires.length||wires.some(w=>w[0]!==1||w[1]<3||w.length!==w[1]+2))return finish(false,'此 Codex 禁用了启动兼容参数，使用原界面')
    if(profile.injection==='preload' && wires.some(w=>w[4]!==49))return finish(false,'此 Codex 禁用了启动兼容参数，使用原界面')
    if(profile.injection==='cdp' && (wires.length!==1||digest(wires[0])!==profile.fuseWireSha256))return finish(false,'此 Codex 的启动兼容参数与已审计版本不匹配，使用原界面')
    const html=reader.archive(archive,'webview/index.html',1024*1024).toString('utf8')
    const early=reader.archive(archive,profile.earlyBootstrap,1024*1024).toString('utf8')
    const bootstrap=reader.archive(archive,profile.bootstrap,16*1024*1024).toString('utf8')
    const appProtocol=profile.appProtocol?reader.archive(archive,profile.appProtocol.asset,4*1024*1024).toString('utf8'):undefined
    parts.push(digest(html),digest(early),digest(bootstrap),...(appProtocol===undefined?[]:[digest(appProtocol)]))
    if(/<script\b[^>]*\bintegrity\s*=/i.test(html)||/strict-dynamic/i.test(html)||!/script-src\s+(?:&#39;|')self(?:&#39;|')/.test(html))return finish(false,'Codex 页面完整性策略不兼容，使用原界面')
    if(!early.includes(`require("./${profile.bootstrap.slice(profile.bootstrap.lastIndexOf('/')+1)}")`)||!bootstrap.includes('require("electron")')||!bootstrap.includes('CODEX_ELECTRON_USER_DATA_PATH'))return finish(false,'Codex 资源加载方式已变化，使用原界面')
    if(profile.appProtocol){if(!bootstrap.includes(profile.appProtocol.requirement)||!appProtocol?.includes('protocol.handle(`app`,')||digest(appProtocol)!==profile.appProtocol.source)return finish(false,'Codex 协议资源已变化，使用原界面')}
    else if(!bootstrap.includes('protocol.handle(`app`,') )return finish(false,'Codex 资源加载方式已变化，使用原界面')
    const source=reader.archive(archive,profile.asset,32*1024*1024).toString('utf8'),sourceDigest=digest(source)
    parts.push(sourceDigest)
    if(sourceDigest!==profile.source||digest(patch(source,profile,enhancements))!==patchedSha256)return finish(false,'Codex 界面资源已变化，使用原界面')
    return finish(true,enhancements==='locale'?'可按语言偏好显示 Codex 内置翻译':enhancements==='speed-locale'?'可显示内置翻译并选择普通或 Fast':'可在 Codex 对话中选择普通或 Fast')
  }catch{return finish(false,'无法读取 Codex 兼容信息，使用原界面')}
}

const capabilityCache=new Map<string,ReturnType<typeof detectCodexUiCapabilities>>()
/** Inspect each requested enhancement independently on the actual installed
 * bytes. Package versions are diagnostic metadata, not admission criteria. */
export function inspectCodexDesktopUi(options:CodexSpeedMenuInspectOptions,reader:CodexSpeedMenuReader=defaultReader):CodexSpeedMenuInspection {
  const requested=codexUiFeatures.filter(feature=>(options.features??codexUiFeatures).includes(feature))
  const parts:unknown[]=[options.application,options.executable,options.platform??process.platform,requested]
  const digest=reader.digest??hash
  let version:string|undefined,cacheKey:string|undefined
  const fail=(reason:string):CodexSpeedMenuInspection=>Object.freeze({supported:false,reason,fingerprint:hash(JSON.stringify(parts)),version,features:[],featureSupport:Object.fromEntries(codexUiFeatures.map(f=>[f,{supported:false,reason}])) as CodexUiFeatureSupports})
  if((options.platform??process.platform)!=='darwin')return fail('当前平台尚未接入 Codex 桌面适配')
  if(!requested.length)return fail('未请求桌面适配功能')
  try{
    if(!isAbsolute(options.application)||!options.application.endsWith('.app')||reader.canonical(options.application)!==options.application||reader.canonical(options.executable)!==options.executable||dirname(options.executable)!==join(options.application,'Contents','MacOS'))return fail('客户端路径不符合隔离启动要求')
    const archive=join(options.application,'Contents','Resources','app.asar'),framework=reader.canonical(join(options.application,'Contents','Frameworks','Codex Framework.framework','Codex Framework'))
    if(relative(options.application,framework).startsWith('..'+sep)||isAbsolute(relative(options.application,framework)))return fail('客户端框架路径不符合兼容要求')
    parts.push(reader.identity(options.executable),reader.identity(archive),reader.identity(framework))
    if(reader===defaultReader){cacheKey=hash(JSON.stringify(parts));const cached=inspectionCache.get(cacheKey);if(cached)return cached}
    const pkgBody=reader.archive(archive,'package.json',128*1024),pkg=JSON.parse(pkgBody.toString('utf8'))
    parts.push(digest(pkgBody));version=typeof pkg.version==='string'&&pkg.version.length<100?pkg.version:undefined
    if(pkg.name!=='openai-codex-electron'||pkg.main!=='.vite/build/early-bootstrap.js')return fail('所选客户端未使用兼容的 Codex 桌面入口')
    const wires=reader.fuseWires(framework)
    parts.push(wires.map(w=>hash(w)))
    if(!wires.length||wires.some(w=>w[0]!==1||w[1]<8||w.length!==w[1]+2||[...w.subarray(2)].some(bit=>![48,49].includes(bit)))||wires.some(w=>!w.equals(wires[0])))return fail('客户端启动兼容参数尚未识别')
    const html=reader.archive(archive,'webview/index.html',1024*1024).toString('utf8')
    if(/<script\b[^>]*\bintegrity\s*=/i.test(html)||/strict-dynamic/i.test(html)||!/script-src\s+(?:&#39;|')self(?:&#39;|')/.test(html))return fail('Codex 页面完整性策略不兼容')
    const early=reader.archive(archive,pkg.main,1024*1024).toString('utf8')
    const bootstrapNames=[...early.matchAll(/require\(["']\.\/(bootstrap-[\w-]+\.js)["']\)/g)].map(m=>m[1])
    if(bootstrapNames.length!==1)return fail('Codex 桌面启动入口已变化')
    const bootstrap='.vite/build/'+bootstrapNames[0],boot=reader.archive(archive,bootstrap,16*1024*1024).toString('utf8')
    if(!boot.includes('require("electron")')||!boot.includes('CODEX_ELECTRON_USER_DATA_PATH'))return fail('Codex 桌面隔离接口已变化')
    parts.push(digest(html),digest(early),digest(boot))
    const audited=version?releaseByVersion.get(version):undefined
    let asset=audited?.asset,source:string|undefined
    if(asset)try{source=reader.archive(archive,asset,32*1024*1024).toString('utf8')}catch{asset=undefined}
    if(!asset){
      const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["'](?:\.\/|\/)?assets\/([\w.-]+\.js)["'][^>]*>/g)].map(m=>m[1])
      if(scripts.length!==1)return fail('Codex 页面入口无法唯一识别')
      const loader=reader.archive(archive,'webview/assets/'+scripts[0],2*1024*1024).toString('utf8')
      parts.push(digest(loader))
      const initial=[...new Set(loader.match(/app-initial-[\w-]+\.js/g)??[])]
      if(initial.length!==1)return fail('Codex 功能页面无法唯一识别')
      asset='webview/assets/'+initial[0];source=reader.archive(archive,asset,32*1024*1024).toString('utf8')
    }
    const sourceDigest=digest(source!)
    parts.push(asset,sourceDigest)
    let detected:ReturnType<typeof detectCodexUiCapabilities>
    if(audited&&sourceDigest===audited.source){
      const replacements={locale:audited.localeReplacement?[audited.localeReplacement]:[],speed:[...audited.speedReplacements],ultra:[...(audited.ultraReplacements??[])]}
      detected={replacements,features:Object.fromEntries(codexUiFeatures.map(f=>[f,{supported:replacements[f].length>0,reason:replacements[f].length?'已验证的功能结构':'此客户端未包含该功能的兼容结构'}])) as CodexUiFeatureSupports}
    }else{
      detected=capabilityCache.get(sourceDigest)??detectCodexUiCapabilities(source!)
      if(capabilityCache.size>=4)capabilityCache.delete(capabilityCache.keys().next().value!)
      capabilityCache.set(sourceDigest,detected)
    }
    const featureSupport=structuredClone(detected.features),features=requested.filter(f=>featureSupport[f].supported)
    const replacements=features.flatMap(f=>detected.replacements[f]).sort((a,b)=>(b.offset??0)-(a.offset??0))
    parts.push(featureSupport,features,replacements)
    if(!features.length)return {...fail('客户端页面功能结构尚未兼容'),featureSupport}
    const profile:CodexReleaseProfile={id:'capabilities',version:version??'',injection:wires[0][4]===49?'preload':'cdp',asset,url:'app://-/assets/'+asset.split('/').pop(),source:sourceDigest,patched:{speed:'',locale:'','speed-locale':''},earlyBootstrap:pkg.main,bootstrap,speedReplacements:[],replacements}
    const patchedDigest=digest(patch(source!,profile,'speed-locale'))
    profile.patched={speed:patchedDigest,locale:patchedDigest,'speed-locale':patchedDigest}
    const result:CodexSpeedMenuInspection=Object.freeze({supported:true,reason:features.length===requested.length?'所选功能已通过兼容检测':'部分功能可用，请查看各项兼容状态',fingerprint:hash(JSON.stringify(parts)),version,features,featureSupport,assetURL:profile.url,sourceSha256:sourceDigest,patchedSha256:patchedDigest,enhancements:'speed-locale',transport:profile.injection})
    checked.set(result,{options:{...options,features:requested},reader,profile})
    if(cacheKey){if(inspectionCache.size>=16)inspectionCache.delete(inspectionCache.keys().next().value!);inspectionCache.set(cacheKey,result)}
    return result
  }catch{return fail('无法验证 Codex 桌面兼容资源')}
}

function privateDirectory(path:string):void {
  const s=rawFS.lstatSync(path)
  if(s.isSymbolicLink()||!s.isDirectory()||rawFS.realpathSync(path)!==path||(process.getuid&&s.uid!==process.getuid())||(s.mode&0o022))throw new Error('private directory')
}
function atomicFile(path:string,body:string):void {
  const temporary=path+'.'+randomUUID()+'.tmp'
  const fd=rawFS.openSync(temporary,rawFS.constants.O_WRONLY|rawFS.constants.O_CREAT|rawFS.constants.O_EXCL|rawFS.constants.O_NOFOLLOW,0o600)
  try{rawFS.writeFileSync(fd,body,'utf8');rawFS.fsyncSync(fd)}finally{rawFS.closeSync(fd)}
  try{rawFS.linkSync(temporary,path)}finally{rawFS.unlinkSync(temporary)}
}
function atomicBytes(path:string,body:Buffer):void {
  const temporary=path+'.'+randomUUID()+'.tmp'
  const fd=rawFS.openSync(temporary,rawFS.constants.O_WRONLY|rawFS.constants.O_CREAT|rawFS.constants.O_EXCL|rawFS.constants.O_NOFOLLOW,0o600)
  try{rawFS.writeFileSync(fd,body);rawFS.fsyncSync(fd)}finally{rawFS.closeSync(fd)}
  try{rawFS.linkSync(temporary,path)}finally{rawFS.unlinkSync(temporary)}
}
// This source executes only in the selected instance's main Electron process.
const hookSource=String.raw`'use strict';
(() => {
  // NODE_OPTIONS preloads are inherited by Workers. Only the main thread
  // owns the instance's resource handler and may publish its status.
  const {isMainThread,threadId} = require('node:worker_threads');
  if (process.type !== 'browser' || !isMainThread || threadId !== 0) return;
  const fs = require('node:fs'), Module = require('node:module'), {createHash} = require('node:crypto');
  const expected = __EXPECTED__, manifestDigest = __MANIFEST_DIGEST__;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const privateHookDirectory = () => { const stat=fs.lstatSync(expected.hookDirectory); return stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(expected.hookDirectory)===expected.hookDirectory&&(!process.getuid||stat.uid===process.getuid())&&!(stat.mode&0o022); };
  const log = (kind, reason) => { try {
    if(!privateHookDirectory())return;
    const fd = fs.openSync(expected.statusLog, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) return;
      fs.writeSync(fd, JSON.stringify({time:Date.now(),pid:process.pid,mainThread:isMainThread,threadId,nonce:expected.nonce,executable:expected.executable,directory:expected.home,kind,...(reason?{reason}:{})})+'\n');
    } finally { fs.closeSync(fd); }
  } catch {} };
  const hasArg = value => process.argv.filter(arg => arg === value).length === 1;
  if (process.execPath !== expected.executable || process.env.CODEX_HOME !== expected.home || process.env.CODEX_ELECTRON_USER_DATA_PATH !== expected.desktopDirectory || !hasArg('--cml-instance='+expected.nonce) || process.argv.filter(arg=>arg.startsWith('--cml-instance=')).length !== 1 || !hasArg('--user-data-dir='+expected.desktopDirectory) || process.env.CML_CODEX_SPEED_MENU_MANIFEST !== expected.manifest || process.env.CML_CODEX_SPEED_MENU_LOG !== expected.statusLog) { log('disabled','scope'); return; }
  let manifest;
  try {
    if(!privateHookDirectory())throw Error();
    const fd=fs.openSync(expected.manifest,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    let body; try {const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>32768)throw Error();body=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
    if(digest(body)!==manifestDigest)throw Error(); manifest=JSON.parse(body);
    if(manifest.version!==1||manifest.home!==expected.home||manifest.desktopDirectory!==expected.desktopDirectory||manifest.executable!==expected.executable||manifest.nonce!==expected.nonce||manifest.url!==expected.url||manifest.sourceSha256!==expected.sourceSha256||manifest.patchedSha256!==expected.patchedSha256||manifest.enhancements!==expected.enhancements||!Array.isArray(manifest.replacements)||manifest.replacements.length!==expected.replacementCount||digest(JSON.stringify(manifest.replacements))!==expected.replacementsSha256)throw Error();
  } catch {log('disabled','manifest');return;}
  const originalLoad=Module._load;let installed=false,attempted=false;
  Module._load=function(request,parent,isMain){
    const loaded=originalLoad.apply(this,arguments);
    if(request!=='electron'||attempted)return loaded;
    attempted=true;
    try {
      if(!loaded||!loaded.protocol||typeof loaded.protocol.handle!=='function')throw Error();
      const originalHandle=loaded.protocol.handle;
      loaded.protocol.handle=function(scheme,handler){
        if(scheme!=='app')return originalHandle.call(this,scheme,handler);
        log('protocol-wrapped');
        return originalHandle.call(this,scheme,async function(request){
          const response=await handler.apply(this,arguments);
          if(request.url!==manifest.url)return response;
          try {
            if(request.signal?.aborted||response.status!==200||response.headers.has('content-encoding')||! /^(text|application)\/(javascript|ecmascript)(;|$)/i.test(response.headers.get('content-type')||'')){log('original','response');return response;}
            let body=await response.clone().text();
            if(digest(body)!==manifest.sourceSha256){log('original','source');return response;}
            for(const replacement of manifest.replacements){
              if(replacement.offset!==undefined){
                const at=replacement.offset;if(!Number.isSafeInteger(at)||at<0||body.slice(at,at+replacement.before.length)!==replacement.before)throw Error();
                body=body.slice(0,at)+replacement.after+body.slice(at+replacement.before.length);continue;
              }
              const start=body.indexOf(replacement.begin);
              if(start<0||body.indexOf(replacement.begin,start+1)!==-1)throw Error();
              const end=body.indexOf(replacement.end,start+replacement.begin.length);
              if(end<0)throw Error();
              const scope=body.slice(start,end);if(scope.split(replacement.before).length!==2)throw Error();
              body=body.slice(0,start)+scope.replace(replacement.before,replacement.after)+body.slice(end);
            }
            if(digest(body)!==manifest.patchedSha256||request.signal?.aborted){log('original','patched');return response;}
            const headers=new Headers(response.headers);headers.set('content-length',String(Buffer.byteLength(body,'utf8')));headers.set('etag','"'+manifest.patchedSha256+'"');
            for(const name of ['content-md5','digest','content-digest','last-modified'])headers.delete(name);
            const result=new Response(body,{status:response.status,statusText:response.statusText,headers});log('patched');return result;
          }catch{log('original','transform');return response;}
        });
      };
      installed=true;log('hook-installed');
    }catch{log('disabled','protocol');}
    return loaded;
  };
  log('hook-loaded');
})();
`
export function prepareCodexSpeedMenu(options:CodexSpeedMenuPrepareOptions):CodexSpeedMenuHook|undefined {
  const proof=checked.get(options.inspection)
  if(!options.inspection.supported||!proof||proof.options.executable!==options.executable||!/^[A-Za-z0-9-]{8,128}$/.test(options.nonce))return
  const current=inspectCodexSpeedMenu(proof.options,proof.reader)
  if(!current.supported||current.fingerprint!==options.inspection.fingerprint)return
  let folder:string|undefined
  try{
    if(!isAbsolute(options.directory)||!isAbsolute(options.desktopDirectory))return
    privateDirectory(options.directory);privateDirectory(options.desktopDirectory)
    const base=join(options.desktopDirectory,'cml-speed-menu'),target=join(base,options.nonce)
    if(options.hookDirectory&&options.hookDirectory!==target)return
    if(!rawFS.existsSync(base))rawFS.mkdirSync(base,{mode:0o700})
    privateDirectory(base)
    rawFS.mkdirSync(target,{mode:0o700});folder=target
    const manifest=join(target,'manifest.json'),script=join(target,'hook.cjs'),statusLog=join(target,'status.jsonl')
    const enhancements=proof.options.enhancements??'speed',profile=proof.profile,replacements=replacementsFor(profile,enhancements)
    const patchedBodyPath=profile.injection==='cdp'?join(target,'patched.js'):undefined
    const patchedBody=patchedBodyPath?Buffer.from(patch(proof.reader.archive(join(proof.options.application,'Contents','Resources','app.asar'),profile.asset,32*1024*1024).toString('utf8'),profile,enhancements),'utf8'):undefined
    if(patchedBody&&(hash(patchedBody)!==profile.patched[enhancements]))throw new Error('patch digest')
    const scope={home:options.directory,desktopDirectory:options.desktopDirectory,executable:options.executable,nonce:options.nonce,url:profile.url,sourceSha256:profile.source,patchedSha256:profile.patched[enhancements],enhancements,features:options.inspection.features,replacementCount:replacements.length,replacementsSha256:hash(JSON.stringify(replacements)),...(patchedBodyPath&&patchedBody?{patchedBody:patchedBodyPath,patchedBodySha256:hash(patchedBody)}:{})}
    const manifestBody=JSON.stringify({version:1,...scope,fingerprint:current.fingerprint,replacements},null,2)+'\n'
    if(patchedBodyPath&&patchedBody)atomicBytes(patchedBodyPath,patchedBody)
    atomicFile(manifest,manifestBody);atomicFile(statusLog,'')
    const source=hookSource.replace('__EXPECTED__',JSON.stringify({...scope,manifest,statusLog,hookDirectory:target})).replace('__MANIFEST_DIGEST__',JSON.stringify(hash(manifestBody)))
    atomicFile(script,source)
    return {script,manifest,statusLog,transport:profile.injection,features:options.inspection.features,manifestSha256:hash(manifestBody),...(patchedBodyPath?{patchedBody:patchedBodyPath}:{}),env:{CML_CODEX_SPEED_MENU_MANIFEST:manifest,CML_CODEX_SPEED_MENU_LOG:statusLog}}
  }catch{
    if(folder)try{privateDirectory(folder);rawFS.rmSync(folder,{recursive:true,force:true})}catch{/* Never follow a replaced directory. */}
    return
  }
}
const reasons:Record<string,string>={scope:'启动参数未生效',manifest:'适配文件已变化',protocol:'当前客户端的加载方式尚未适配',response:'客户端页面加载异常',source:'客户端更新后需重新适配',patched:'适配文件校验失败',transform:'页面适配失败',cdp:'CDP 调试通道未建立',cdpResponse:'CDP 页面拦截失败'}
export function readCodexSpeedMenuStatus(scope:CodexSpeedMenuStatusScope,now=Date.now()):CodexSpeedMenuStatus {
  const feature=scope.feature==='ultra'?'Ultra 推理菜单':scope.feature==='locale'||scope.enhancements==='locale'?'页面翻译':scope.enhancements==='speed-locale'?'页面翻译和普通 / Fast 菜单':'普通 / Fast 菜单'
  const fallback=(reason?:string):CodexSpeedMenuStatus=>({state:'fallback',reason:`${feature}未加载${reason?'（'+reason+'）':''}，请重启实例后再试`})
  try{
    const lines=boundedFile(scope.statusLog,128*1024).toString('utf8').trim().split('\n')
    let result:CodexSpeedMenuStatus={state:'pending',reason:'等待客户端加载界面'}
    let resourceLoaded=false
    for(const line of lines){
      let value:any;try{value=JSON.parse(line)}catch{continue}
      if(value?.nonce!==scope.nonce||value?.executable!==scope.executable||value?.directory!==scope.directory)continue
      if(scope.pid!==undefined&&value.pid!==scope.pid)continue
      // Older logs lack thread metadata; known Worker records never represent
      // the main process's resource handler, even when their PID is identical.
      if((value.mainThread!==undefined&&value.mainThread!==true)||(value.threadId!==undefined&&value.threadId!==0))continue
      const reason=typeof value.reason==='string'&&Object.hasOwn(reasons,value.reason)?reasons[value.reason]:undefined
      // An aborted preload does not uninstall a handler that already served a
      // resource. The latest resource result takes precedence over startup
      // diagnostics; a later real original response still downgrades active.
      if(value.kind==='patched'){resourceLoaded=true;result={state:'active'}}
      else if(value.kind==='original'){resourceLoaded=true;result=fallback(reason)}
      else if(value.kind==='disabled'&&!resourceLoaded)result=fallback(reason)
    }
    if(result.state==='pending'&&now-rawFS.lstatSync(scope.statusLog).birthtimeMs>20000)return fallback()
    return result
  }catch{return fallback('无法读取加载状态')}
}
