import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstatSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute,join} from 'node:path'
import {z} from 'zod'
import {atomic,directory,readBounded} from './clientConfig'
import {patchToml,TomlDocument} from './tomlPatch'

// Verified against Codex 26.915.31945's bundled native-menu-locales and webview
// locale chunks. English uses the built-in messages rather than a locale chunk.
export const supportedDesktopLocales=['en-US','am','ar','bg-BG','bn-BD','bs-BA','ca-ES','cs-CZ','da-DK','de-DE','el-GR','es-419','es-ES','et-EE','fa','fi-FI','fr-CA','fr-FR','gu-IN','hi-IN','hr-HR','hu-HU','hy-AM','id-ID','is-IS','it-IT','ja-JP','ka-GE','kk','kn-IN','ko-KR','lt','lv-LV','mk-MK','ml','mn','mr-IN','ms-MY','my-MM','nb-NO','nl-NL','pa','pl-PL','pt-BR','pt-PT','ro-RO','ru-RU','sk-SK','sl-SI','so-SO','sq-AL','sr-RS','sv-SE','sw-TZ','ta-IN','te-IN','th-TH','tl','tr-TR','uk-UA','ur','vi-VN','zh-CN','zh-HK','zh-TW'] as const
const markerSchema=z.discriminatedUnion('version',[
  z.object({version:z.literal(1),source:z.enum(['existing','legacy','system']),locale:z.string().max(100).optional()}).strict(),
  z.object({version:z.literal(2),source:z.enum(['existing','legacy','auto']),locale:z.string().max(100).optional()}).strict()
])
export interface DesktopLocaleOptions {directory:string;markerPath:string;systemLanguages?:readonly string[]}
export interface DesktopLocalePreview {locale?:string;effectiveLocale?:string;source:'existing'|'legacy'|'system'|'initialized';initialized:boolean;revision:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity=(path:string)=>{const stat=lstatSync(path);return {device:stat.dev,inode:stat.ino,path:realpathSync(path)}}
// Keep arbitrary original choices untouched in their source file, but only
// bounded language metadata belongs in a launch preview or the init marker.
const languageMetadata=(value:unknown):string|undefined=>typeof value==='string'&&value.length<=100?value:undefined

export function resolveDesktopLocale(value:string):string|undefined {
  if(value.length>100)return
  let locale:Intl.Locale
  try{locale=new Intl.Locale(value.trim().replaceAll('_','-'))}catch{return}
  if(locale.language==='en')return 'en-US'
  if(locale.language==='zh') {
    if(locale.script==='Hans')return 'zh-CN'
    if(locale.region==='HK'||locale.region==='MO')return 'zh-HK'
    if(locale.script==='Hant'||locale.region==='TW')return 'zh-TW'
    return 'zh-CN'
  }
  const exact=supportedDesktopLocales.find(value=>value.toLowerCase()===locale.baseName.toLowerCase())
  if(exact)return exact
  const region=locale.region??locale.maximize().region
  return supportedDesktopLocales.find(value=>value.toLowerCase()===`${locale.language}-${region}`.toLowerCase())
    ??supportedDesktopLocales.find(value=>value.split('-')[0]===locale.language)
}

export function systemDesktopLanguages():string[] {
  const languages:string[]=[]
  if(process.platform==='darwin')try {
    // Read language preferences, not LANG from the launching shell or manager.
    const output=execFileSync('/usr/bin/defaults',['read','-g','AppleLanguages'],{encoding:'utf8',timeout:1500,maxBuffer:8192,stdio:['ignore','pipe','ignore']})
    for(const part of output.replace(/^\s*\(|\)\s*$/g,'').split(',')){
      const value=part.trim().replace(/^"|"$/g,'')
      if(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(value))languages.push(value)
    }
  }catch{/* An unavailable system preference falls back to Intl. */}
  try{languages.push(Intl.DateTimeFormat().resolvedOptions().locale)}catch{}
  return [...new Set(languages)]
}

function inspect(options:DesktopLocaleOptions) {
  if(!isAbsolute(options.directory)||!isAbsolute(options.markerPath))throw new Error('实例语言配置需要绝对目录')
  directory(options.directory);directory(dirname(options.markerPath))
  const homeIdentity=identity(options.directory),markerIdentity=identity(dirname(options.markerPath))
  const file=join(options.directory,'config.toml'),globalFile=join(options.directory,'.codex-global-state.json')
  const config=readBounded(file,1024*1024),global=readBounded(globalFile,8*1024*1024),marker=readBounded(options.markerPath,4096)
  const document=new TomlDocument(config??'')
  let prior:ReturnType<typeof markerSchema.parse>|undefined
  if(marker!==null)try{prior=markerSchema.parse(JSON.parse(marker))}catch{throw new Error('实例语言初始化记录无法读取，原配置已保留')}
  let source:DesktopLocalePreview['source'],locale:string|undefined,legacy:unknown,hasLegacy=false
  const configured=document.raw(['desktop','localeOverride'])!==null
  const configuredLocale=document.scalar(['desktop','localeOverride'])
  // Version 1 recorded a manager-seeded system override. It cannot distinguish
  // a later manual choice of the very same value; only this exact old value is
  // eligible for migration. Version 2 never removes any explicit user choice.
  const migrationCandidate=prior?.version===1&&prior.source==='system'&&prior.locale!==undefined
    &&supportedDesktopLocales.some(value=>value===prior.locale)&&configured&&configuredLocale===prior.locale
  if((!configured||migrationCandidate)&&global!==null)try {
    const state:unknown=JSON.parse(global)
    if(!state||typeof state!=='object'||Array.isArray(state))throw new Error('not-object')
    hasLegacy=Object.prototype.hasOwnProperty.call(state,'localeOverride')
    if(hasLegacy)legacy=(state as Record<string,unknown>).localeOverride
  }catch{throw new Error('实例原语言设置无法读取，原配置已保留')}
  const removeManagedOverride=migrationCandidate&&!hasLegacy
  if(configured&&!removeManagedOverride){source='existing';locale=languageMetadata(configuredLocale)}
  else {
    if(hasLegacy){source='legacy';locale=languageMetadata(legacy)}
    else if(prior){source='initialized'}
    else {source='system'}
  }
  const auto=source==='system'||source==='initialized'||source==='legacy'&&legacy===null
  const effectiveLocale=auto?(options.systemLanguages??systemDesktopLanguages()).map(resolveDesktopLocale).find(Boolean)??'en-US'
    :locale!==undefined?resolveDesktopLocale(locale):undefined
  const revision=hash([homeIdentity,markerIdentity,config,global,marker,source,locale,effectiveLocale,removeManagedOverride])
  return {preview:{locale,effectiveLocale,source,initialized:!!prior,revision} satisfies DesktopLocalePreview,config,global,marker,prior,removeManagedOverride,file,globalFile,homeIdentity,markerIdentity}
}

export function previewDesktopLocale(options:DesktopLocaleOptions):DesktopLocalePreview {return inspect(options).preview}

// Default to the native client's auto detection. The record is separate from
// the temporary connection/auth journal, so user UI choices survive stopping.
// Only an unchanged, manager-seeded v1 override is removed during migration.
export function initializeDesktopLocale(options:DesktopLocaleOptions,expectedRevision?:string):DesktopLocalePreview {
  const current=inspect(options),view=current.preview
  if(expectedRevision!==undefined&&view.revision!==expectedRevision)throw new Error('实例语言设置已变化，请重新预览启动')
  if(current.prior?.version===2)return view
  const next=current.removeManagedOverride?patchToml(current.config??'',[{path:['desktop','localeOverride'],raw:null}]):current.config
  const verify=()=>{
    directory(options.directory);directory(dirname(options.markerPath))
    if(hash(identity(options.directory))!==hash(current.homeIdentity)||hash(identity(dirname(options.markerPath)))!==hash(current.markerIdentity)
      ||readBounded(current.file,1024*1024)!==current.config||readBounded(current.globalFile,8*1024*1024)!==current.global||readBounded(options.markerPath,4096)!==current.marker)
      throw new Error('实例语言配置目录或文件已变化，原文件已保留')
  }
  verify()
  if(next!==current.config){atomic(current.file,next!);current.config=next}
  verify()
  atomic(options.markerPath,JSON.stringify({version:2,source:view.source==='existing'||view.source==='legacy'?view.source:'auto',locale:view.locale})+'\n')
  return inspect(options).preview
}
