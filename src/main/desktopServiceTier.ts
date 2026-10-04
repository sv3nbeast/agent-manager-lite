import {createHash} from 'node:crypto'
import {lstatSync,realpathSync} from 'node:fs'
import {basename,dirname,isAbsolute,join,relative,sep} from 'node:path'
import {z} from 'zod'
import {atomic,directory,readBounded} from './clientConfig'
import {patchToml,scalarRaw,TomlDocument} from './tomlPatch'

const tierSchema=z.enum(['fast','priority','default','auto','flex','scale','ultrafast'])
const markerSchema=z.object({version:z.literal(1),source:z.enum(['existing','initial']),tier:tierSchema.optional()}).strict()
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity=(path:string)=>{const stat=lstatSync(path);return {device:stat.dev,inode:stat.ino,path:realpathSync(path)}}
const normalized=(tier:string|undefined)=>tier==='fast'?'priority':tier

export interface DesktopServiceTierOptions {directory:string;markerPath:string;initialTier?:string}
export interface DesktopServiceTierPreview {
  tier?:string
  source:'existing'|'initial'|'initialized'
  initialized:boolean
  revision:string
}

function inspect(options:DesktopServiceTierOptions) {
  if(!isAbsolute(options.directory)||!isAbsolute(options.markerPath))throw new Error('实例速度配置需要绝对目录')
  const initial=tierSchema.optional().safeParse(options.initialTier)
  if(!initial.success)throw new Error('实例初始速度档位无效')
  directory(options.directory);directory(dirname(options.markerPath))
  const homeIdentity=identity(options.directory),markerIdentity=identity(dirname(options.markerPath))
  const scope=relative(homeIdentity.path,join(markerIdentity.path,basename(options.markerPath)))
  if(scope!=='..'&&!scope.startsWith('..'+sep)&&!isAbsolute(scope))throw new Error('速度初始化记录必须保存在受管实例目录，而非客户端 Home')
  const file=join(options.directory,'config.toml'),globalFile=join(options.directory,'.codex-global-state.json')
  const config=readBounded(file,1024*1024),global=readBounded(globalFile,8*1024*1024),marker=readBounded(options.markerPath,4096)
  const doc=new TomlDocument(config??'')
  if(doc.raw(['profile'])!==null)throw new Error('实例速度配置不支持 Profile 覆盖，请先移除该覆盖')
  if(marker!==null)try{markerSchema.parse(JSON.parse(marker))}catch{throw new Error('实例速度初始化记录无法读取，原配置已保留')}
  const configured=doc.raw(['service_tier'])!==null
  let tier:string|undefined
  if(configured){
    const parsed=tierSchema.safeParse(doc.scalar(['service_tier']))
    if(!parsed.success)throw new Error('实例现有 service_tier 无效，原配置已保留')
    tier=normalized(parsed.data)
  }else if(marker===null)tier=normalized(initial.data)
  const source:DesktopServiceTierPreview['source']=configured?'existing':marker===null?'initial':'initialized'
  const revision=hash([homeIdentity,markerIdentity,config,global,marker,normalized(initial.data)])
  return {preview:{tier,source,initialized:marker!==null,revision} satisfies DesktopServiceTierPreview,
    config,global,marker,file,globalFile,homeIdentity,markerIdentity}
}

export function previewDesktopServiceTier(options:DesktopServiceTierOptions):DesktopServiceTierPreview {return inspect(options).preview}

// Client preferences live beyond a temporary connection's journal. Seed only
// once, then let the native speed menu own config/global state/thread settings.
export function initializeDesktopServiceTier(options:DesktopServiceTierOptions,expectedRevision?:string):DesktopServiceTierPreview {
  const current=inspect(options),view=current.preview
  if(expectedRevision!==undefined&&view.revision!==expectedRevision)throw new Error('实例速度设置已变化，请重新预览启动')
  if(view.initialized)return view
  const next=view.source==='initial'&&view.tier!==undefined
    ?patchToml(current.config??'',[{path:['service_tier'],raw:scalarRaw(view.tier==='priority'?'fast':view.tier)}]):current.config
  const verify=()=>{
    directory(options.directory);directory(dirname(options.markerPath))
    if(hash(identity(options.directory))!==hash(current.homeIdentity)||hash(identity(dirname(options.markerPath)))!==hash(current.markerIdentity)
      ||readBounded(current.file,1024*1024)!==current.config||readBounded(current.globalFile,8*1024*1024)!==current.global||readBounded(options.markerPath,4096)!==current.marker)
      throw new Error('实例速度配置目录或文件已变化，原文件已保留')
  }
  verify()
  if(next!==current.config){atomic(current.file,next!);current.config=next}
  verify()
  atomic(options.markerPath,JSON.stringify({version:1,source:view.source,tier:view.tier})+'\n')
  return inspect(options).preview
}
