// Cockpit codex_session_manager.rs:2236–2328,2618–2752. The primary and legacy
// roots share the same format. Only an explicitly selected root is traversed.
import {createHash} from 'node:crypto'
import {realpathSync} from 'node:fs'
import {opendir} from 'node:fs/promises'
import {basename,dirname,join,posix,resolve,win32} from 'node:path'
import {z} from 'zod'
import {firstSessionEvent,openSessionFile,safeSessionPath,sessionActivity} from './sessionFiles'
import {fileIdentity,sessionRelative,textHash} from './sessionTransferFiles'
import {sameStamp,type FileStamp} from './sessionZip'
import type {TrashImportFile} from './sessionTrashFiles'

const maxBytes=100*1024**3,manifestLimit=1024**2
const manifestSchema=z.object({sessionId:z.string().uuid(),title:z.string().max(2000),cwd:z.string().max(4000),instanceId:z.string().max(256),instanceName:z.string().max(2000),instanceRoot:z.string().min(1).max(4000),originalRolloutPath:z.string().min(1).max(6000),relativeRolloutPath:z.string().min(1).max(2000),sessionIndexEntry:z.unknown(),deletedAt:z.string().max(100).nullable().optional()})
export interface LegacyTrashEntry extends TrashImportFile {
  groupId:string;sourceName:string;originalRoot:string;manifestPath:string;manifestStamp:FileStamp
}
export interface LegacyTrashSource {root:string;identity:{device:number;inode:number};entries:LegacyTrashEntry[];inventory:string}

function paths(manifest:z.infer<typeof manifestSchema>):{root:string;relative:string}{
  const flavor=posix.isAbsolute(manifest.instanceRoot)?posix:win32
  const rel=flavor===win32?manifest.relativeRolloutPath.replaceAll('\\','/'):manifest.relativeRolloutPath
  if(!flavor.isAbsolute(manifest.instanceRoot)||!flavor.isAbsolute(manifest.originalRolloutPath)||!sessionRelative(rel))throw new Error('旧废纸篓清单包含越界或异常会话路径')
  const root=flavor.normalize(manifest.instanceRoot),expected=flavor.join(root,...rel.split('/')),actual=flavor.normalize(manifest.originalRolloutPath)
  if(flavor===win32?actual.toLowerCase()!==expected.toLowerCase():actual!==expected)throw new Error('旧废纸篓原路径与相对路径不一致')
  return {root,relative:rel}
}

// Accept a complete root, a timestamp batch, or one entry. Never recurse into
// rollout files or other application data while discovering manifests.
async function manifests(root:string,signal:AbortSignal):Promise<string[]>{
  const result:string[]=[];let count=0
  async function visit(path:string,depth:number):Promise<void>{
    signal.throwIfAborted();const stat=await safeSessionPath(root,path);if(!stat.isDirectory())throw new Error('旧废纸篓目录类型异常')
    const dirs:string[]=[];let manifest:string|undefined
    for await(const entry of await opendir(path)){
      signal.throwIfAborted();if(++count>30000)throw new Error('旧废纸篓目录项超过 3 万，请选择单个批次')
      if(entry.name==='manifest.json'){if(!entry.isFile())throw new Error('旧废纸篓清单不是普通文件');manifest=join(path,entry.name)}
      else if(entry.isSymbolicLink())throw new Error('旧废纸篓包含链接目录或文件，请选择完整的原始备份')
      else if(entry.isDirectory()&&entry.name!=='files')dirs.push(join(path,entry.name))
    }
    if(manifest){result.push(manifest);if(result.length>10000)throw new Error('一次最多读取 1 万份旧废纸篓备份');return}
    if(depth<2)for(const dir of dirs.sort())await visit(dir,depth+1)
  }
  await visit(root,0);return result.sort()
}

export async function scanLegacyTrash(path:string,signal:AbortSignal,progress:(files:number,bytes:number)=>void=()=>{}):Promise<LegacyTrashSource>{
  signal.throwIfAborted();const root=join(realpathSync(dirname(resolve(path))),basename(path)),identity=fileIdentity(await safeSessionPath(root,root)),names=await manifests(root,signal)
  if(!names.length)throw new Error('所选目录没有 Cockpit 会话废纸篓清单，请选择废纸篓根目录、日期批次或单个条目')
  const entries:LegacyTrashEntry[]=[],groups=new Set<string>();let total=0,metadataBytes=0
  for(const manifestPath of names){
    signal.throwIfAborted();const manifestFile=await openSessionFile(root,manifestPath);let manifest:z.infer<typeof manifestSchema>
    try{
      if(manifestFile.stat.size>manifestLimit||(metadataBytes+=manifestFile.stat.size)>32*1024**2)throw new Error('旧废纸篓清单超过单份 1 MiB 或合计 32 MiB')
      const buffer=Buffer.alloc(manifestFile.stat.size);let offset=0
      while(offset<buffer.length){signal.throwIfAborted();const part=await manifestFile.file.read(buffer,offset,buffer.length-offset,offset);if(!part.bytesRead)throw new Error('旧废纸篓清单在读取期间变化');offset+=part.bytesRead}
      try{manifest=manifestSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)))}catch{throw new Error('旧废纸篓清单格式不受支持或已损坏')}
      if(!sameStamp(manifestFile.stat,await manifestFile.file.stat())||!sameStamp(manifestFile.stat,await safeSessionPath(root,manifestPath)))throw new Error('旧废纸篓清单在读取期间变化')
    }finally{await manifestFile.file.close()}
    const original=paths(manifest),filePath=join(dirname(manifestPath),'files',...original.relative.split('/'))
    const groupId=textHash(original.root);groups.add(groupId);if(groups.size>100)throw new Error('旧废纸篓来源超过 100 个目录，请选择单个批次')
    const opened=await openSessionFile(root,filePath)
    try{
      total+=opened.stat.size;if(!opened.stat.size||total>maxBytes)throw new Error('旧废纸篓为空文件或合计超过 100 GiB')
      const meta=await firstSessionEvent(opened.file,opened.stat.size,signal)
      if(meta?.type!=='session_meta'||(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)!==manifest.sessionId)throw new Error('旧废纸篓会话文件与清单 ID 不一致')
      const digest=createHash('sha256'),buffer=Buffer.alloc(256*1024);let offset=0
      while(offset<opened.stat.size){signal.throwIfAborted();const {bytesRead}=await opened.file.read(buffer,0,Math.min(buffer.length,opened.stat.size-offset),offset);if(!bytesRead)throw new Error('旧废纸篓会话文件读取不完整');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;progress(entries.length,total-opened.stat.size+offset)}
      if(!sameStamp(opened.stat,await opened.file.stat())||!sameStamp(opened.stat,await safeSessionPath(root,filePath)))throw new Error('旧废纸篓会话文件在读取期间变化')
      const sha256=digest.digest('hex'),key=textHash(JSON.stringify({...manifest,instanceRoot:original.root,relativeRolloutPath:original.relative,sha256})),parsedDate=manifest.deletedAt?Date.parse(manifest.deletedAt):NaN
      entries.push({key,groupId,sourceName:manifest.instanceName,originalRoot:original.root,manifestPath,manifestStamp:manifestFile.stat,root,path:filePath,stamp:opened.stat,sha256,id:manifest.sessionId,relative:original.relative,title:manifest.title,cwd:manifest.cwd,updatedAt:await sessionActivity(opened.file,opened.stat.size,signal),deletedAt:Number.isFinite(parsedDate)&&parsedDate>=0?parsedDate:0,indexEntry:manifest.sessionIndexEntry})
    }finally{await opened.file.close()}
  }
  const source={root,identity,entries,inventory:textHash(names.join('\n'))};await verifyLegacyTrash(source,signal);progress(entries.length,total);return source
}

export async function verifyLegacyTrash(source:LegacyTrashSource,signal:AbortSignal,entries=source.entries):Promise<void>{
  signal.throwIfAborted();const stat=await safeSessionPath(source.root,source.root)
  if(stat.dev!==source.identity.device||stat.ino!==source.identity.inode||textHash((await manifests(source.root,signal)).join('\n'))!==source.inventory)throw new Error('旧废纸篓目录或条目在预览后变化，请重新选择')
  for(const entry of entries){
    signal.throwIfAborted()
    for(const [path,stamp] of [[entry.path,entry.stamp],[entry.manifestPath,entry.manifestStamp]] as const){const now=await safeSessionPath(source.root,path);if(!now.isFile()||now.nlink!==1||!sameStamp(now,stamp))throw new Error('旧废纸篓内容在预览后变化，请重新选择')}
  }
}

export function importedBatchId(key:string,targetId:string):string{
  const hex=textHash(key+':'+targetId)
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
