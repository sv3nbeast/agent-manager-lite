// Cockpit codex_session_manager trash semantics, with durable backups and an
// explicit descendant closure before calling official thread/delete.
import {constants,existsSync,lstatSync,mkdirSync,realpathSync,linkSync,unlinkSync,rmSync,readdirSync,type Stats} from 'node:fs'
import {open} from 'node:fs/promises'
import {join,relative,sep,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {atomic,directory,readBounded} from './clientConfig'
import {openSessionFile,firstSessionEvent,sessionIdentifier,rolloutFiles,safeSessionPath} from './sessionFiles'
import {sessionRelative,fileIdentity,textHash,verifySource,ensureSessionParent} from './sessionTransferFiles'
import {planSessionDeletion,deleteSessionThreads,verifyDeletedSessionMetadata,rebuildSessionMetadata,type SessionProgram,type OfficialDeletionEntry} from './officialSessions'
import type {SessionTransferSource} from './sessions'
import type {FileStamp} from './sessionZip'

const number=z.number().finite().nonnegative(),identity=z.object({device:number,inode:number}).strict(),digest=z.string().regex(/^[a-f0-9]{64}$/)
const stamp=identity.extend({size:number,mtime:number,ctime:number}).strict()
const fileSchema=z.object({id:z.string().uuid(),relative:z.string().refine(sessionRelative),backup:z.string().regex(/^\d+\.jsonl$/),source:stamp,stored:stamp,sha256:digest,title:z.string().max(2000),cwd:z.string().max(4000),updatedAt:z.number().finite().optional()}).strict()
const restoreFile=identity.extend({relative:z.string().refine(sessionRelative),stage:z.string().regex(/^\d+\.jsonl$/),size:number,sha256:digest}).strict()
const unique=(values:string[])=>new Set(values).size===values.length
export const trashJournalSchema=z.object({version:z.literal(1),id:z.string().uuid(),targetId:z.string().uuid(),targetName:z.string().max(200),root:z.string().max(4000).refine(isAbsolute),rootIdentity:identity,backupIdentity:identity,
  phase:z.enum(['preparing','backed_up','deleting','trashed','restoring','restored']),deletedAt:number,configHash:digest,selectedIds:z.array(z.string().uuid()).min(1).max(1000),allIds:z.array(z.string().uuid()).min(1).max(1000),files:z.array(fileSchema).max(10000),indexBefore:z.string().nullable(),indexHash:digest,officialFallback:z.boolean(),indexPending:z.boolean(),restoreFiles:z.array(restoreFile).max(10000),restoreIdentity:identity.optional(),restoreIds:z.array(z.string().uuid()).max(1000).optional(),restoredIds:z.array(z.string().uuid()).max(1000).optional(),removedIds:z.array(z.string().uuid()).max(1000).optional(),imported:z.object({kind:z.literal('cockpit'),key:digest}).strict().optional(),restoreIndex:z.object({before:z.string().nullable(),after:z.string(),beforeHash:digest,afterHash:digest}).strict().optional()
}).strict().refine(value=>unique(value.selectedIds)&&unique(value.allIds)&&[value.restoreIds??[],value.restoredIds??[],value.removedIds??[]].every(ids=>unique(ids)&&ids.every(id=>value.allIds.includes(id)))&&value.selectedIds.every(id=>value.allIds.includes(id))&&value.files.every(file=>value.allIds.includes(file.id))&&unique(value.files.map(file=>file.relative))&&unique(value.files.map(file=>file.backup))&&unique(value.restoreFiles.map(file=>file.relative))&&unique(value.restoreFiles.map(file=>file.stage))&&value.restoreFiles.every(file=>value.files.some(original=>original.relative===file.relative&&original.sha256===file.sha256&&original.stored.size===file.size))&&textHash(value.indexBefore)===value.indexHash&&(!value.restoreIndex||textHash(value.restoreIndex.before)===value.restoreIndex.beforeHash&&textHash(value.restoreIndex.after)===value.restoreIndex.afterHash),'废纸篓清单包含重复路径或无效摘要')
export type TrashJournal=z.infer<typeof trashJournalSchema>
export type TrashFile=TrashJournal['files'][number]
const limit=40*1024**2
const stampOf=(stat:Stats)=>({...fileIdentity(stat),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs})
const sameStamp=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink
const matches=(stat:Stats,value:z.infer<typeof stamp>)=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.dev===value.device&&stat.ino===value.inode&&stat.size===value.size&&stat.mtimeMs===value.mtime&&stat.ctimeMs===value.ctime
const safeError=(error:unknown)=>error instanceof Error&&!(error as NodeJS.ErrnoException).code?error.message:'废纸篓文件无法读写，请检查目录权限和磁盘空间'
export function saveTrashJournal(folder:string,journal:TrashJournal):void{
  checkBackup(folder,journal)
  const raw=JSON.stringify(trashJournalSchema.parse(journal));if(Buffer.byteLength(raw)>limit-1024)throw new Error('废纸篓恢复记录超过 40 MiB，请缩小范围')
  atomic(join(folder,'journal.json'),raw)
}
export function loadTrashJournal(folder:string):TrashJournal{
  directory(folder);if(realpathSync(folder)!==folder)throw new Error('废纸篓目录路径已变化')
  const path=join(folder,'journal.json'),size=lstatSync(path).size
  if(size>limit)throw new Error('废纸篓恢复记录超过 40 MiB')
  // Imported entries use one small journal per backup. Keep the hard limit
  // without allocating 40 MiB for every row in a large trash listing.
  const value=trashJournalSchema.parse(JSON.parse(readBounded(path,Math.min(limit,size+1))??''));checkBackup(folder,value);return value
}
function checkBackup(folder:string,journal:TrashJournal):void{
  const stat=lstatSync(folder)
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(folder)!==folder||stat.dev!==journal.backupIdentity.device||stat.ino!==journal.backupIdentity.inode||folder.split(sep).at(-1)!==journal.id)throw new Error('废纸篓目录已被替换，备份已保留')
}
export function checkTrashHome(journal:TrashJournal):void{
  const stat=lstatSync(journal.root)
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(journal.root)!==journal.root||stat.dev!==journal.rootIdentity.device||stat.ino!==journal.rootIdentity.inode)throw new Error('原会话目录已被替换，备份已保留')
}
function checkConfig(journal:TrashJournal):void{checkTrashHome(journal);if(textHash(readBounded(join(journal.root,'config.toml'),1024**2))!==journal.configHash)throw new Error('原目录配置已变化，请先核对配置再处理废纸篓')}
function current(root:string,path:string):Stats|undefined{
  const rel=relative(root,path);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('会话文件路径越界')
  let cursor=root
  try{directory(root);if(realpathSync(root)!==root)throw new Error('会话目录已变化');for(const part of rel.split(sep).slice(0,-1)){cursor=join(cursor,part);directory(cursor)};return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
}
async function checkedHash(root:string,path:string,expected:{size:number;sha256:string},signal:AbortSignal,maxLinks=1):Promise<Stats>{
  const stat=await safeSessionPath(root,path)
  if(!stat.isFile()||stat.nlink>maxLinks||stat.size!==expected.size)throw new Error('会话备份文件类型或大小已变化')
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),hash=createHash('sha256'),buffer=Buffer.alloc(256*1024)
  try{
    if(!sameStamp(await handle.stat(),stat))throw new Error('会话文件已被替换')
    for(let offset=0;offset<stat.size;){signal.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)throw new Error('会话文件读取不完整');hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead}
    const final=current(root,path);if(!final||!sameStamp(final,stat)||!sameStamp(await handle.stat(),stat)||hash.digest('hex')!==expected.sha256)throw new Error('会话文件内容已变化，备份已保留')
    return final
  }finally{await handle.close()}
}
async function copyRaw(root:string,path:string,destination:string,signal:AbortSignal,progress:(bytes:number)=>void):Promise<{stored:z.infer<typeof stamp>;sha256:string}>{
  const {file,stat}=await openSessionFile(root,path)
  try{
    const output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),hash=createHash('sha256'),buffer=Buffer.alloc(256*1024)
    try{
      for(let offset=0;offset<stat.size;){signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)throw new Error('会话文件读取不完整');hash.update(buffer.subarray(0,bytesRead))
        for(let written=0;written<bytesRead;){signal.throwIfAborted();const next=await output.write(buffer,written,bytesRead-written);if(!next.bytesWritten)throw new Error('会话备份写入失败');written+=next.bytesWritten}
        offset+=bytesRead;progress(offset)
      }
      const final=current(root,path);if(!final||!sameStamp(final,stat)||!sameStamp(await file.stat(),stat))throw new Error('备份期间会话发生变化，未开始删除')
      await output.utimes(new Date(stat.mtimeMs),new Date(stat.mtimeMs));await output.sync();return {stored:stampOf(await output.stat()),sha256:hash.digest('hex')}
    }finally{await output.close()}
  }finally{await file.close()}
}
export async function verifyBackup(folder:string,journal:TrashJournal,signal:AbortSignal):Promise<void>{
  checkBackup(folder,journal)
  for(const file of journal.files.filter(file=>!journal.removedIds?.includes(file.id))){const path=join(folder,file.backup),stat=await checkedHash(folder,path,{size:file.stored.size,sha256:file.sha256},signal);if(!matches(stat,file.stored))throw new Error('废纸篓备份已被替换')}
  checkBackup(folder,journal)
}
function lineId(line:string):string|undefined{try{const value=JSON.parse(line);return value&&typeof value==='object'&&typeof value.id==='string'?value.id:undefined}catch{return}}
export function removeTrashIndexEntries(raw:string|null,ids:ReadonlySet<string>):string|null{
  if(raw===null)return null
  return raw.split(/(?<=\n)/).filter(line=>{const id=lineId(line);return !id||!ids.has(id)}).join('')
}
export function restoreTrashIndexEntries(raw:string|null,journal:TrashJournal,ids=journal.allIds):string{
  const wanted=new Set(ids),entries=new Map<string,Record<string,unknown>>()
  for(const line of journal.indexBefore?.split('\n')??[]){const id=lineId(line);if(!id||!wanted.has(id))continue;entries.set(id,{...entries.get(id),...JSON.parse(line)})}
  for(const file of journal.files.filter(file=>wanted.has(file.id)).sort((a,b)=>(a.updatedAt??a.source.mtime)-(b.updatedAt??b.source.mtime))){
    const previous=entries.get(file.id)??{};entries.set(file.id,{...previous,id:file.id,...typeof previous.thread_name==='string'?{}:{thread_name:file.title},updated_at:new Date(file.updatedAt??file.source.mtime).toISOString()})
  }
  const output:string[]=[],seen=new Set<string>()
  for(const line of raw?.split(/(?<=\n)/)??[]){const id=lineId(line);if(!id||!entries.has(id)){output.push(line);continue};if(seen.has(id))continue;seen.add(id);output.push(JSON.stringify({...JSON.parse(line),...entries.get(id)})+'\n')}
  for(const [id,entry] of entries)if(!seen.has(id)){if(output.length&&!output.at(-1)!.endsWith('\n'))output.push('\n');output.push(JSON.stringify(entry)+'\n')}
  const result=output.join('');if(Buffer.byteLength(result)>16*1024**2)throw new Error('恢复后的会话索引超过 16 MiB');return result
}

export interface PrepareTrashInput {targetId:string;targetName:string;root:string;sources:SessionTransferSource[];selectedIds:string[];closure:OfficialDeletionEntry[];configHash:string}
export async function prepareTrashBatch(trashRoot:string,input:PrepareTrashInput,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}):Promise<{folder:string;journal:TrashJournal}>{
  signal.throwIfAborted();directory(trashRoot);if(realpathSync(trashRoot)!==trashRoot)throw new Error('废纸篓路径已变化')
  const ids=new Set(input.closure.map(row=>row.id)),sources=input.sources
  if(!sources.length||sources.length>10000||ids.size>1000||sources.reduce((n,file)=>n+file.size,0)>100*1024**3)throw new Error('每批支持 1–10000 个会话副本及最多 100 GiB')
  if(!input.selectedIds.length||input.selectedIds.some(id=>!ids.has(id))||sources.some(source=>source.root!==input.root||source.targetId!==input.targetId||!ids.has(source.record.id))||!unique(sources.map(source=>source.path)))throw new Error('会话备份范围与删除范围不一致')
  for(const entry of input.closure)if(entry.path&&existsSync(entry.path)&&!sources.some(source=>source.path===entry.path&&source.record.id===entry.id))throw new Error('官方删除包含尚未备份的会话文件')
  const rootStat=lstatSync(input.root),id=randomUUID(),folder=join(trashRoot,id)
  const indexBefore=readBounded(join(input.root,'session_index.jsonl'),16*1024**2)
  mkdirSync(folder,{mode:0o700})
  const journal:TrashJournal={version:1,id,targetId:input.targetId,targetName:input.targetName,root:input.root,rootIdentity:fileIdentity(rootStat),backupIdentity:fileIdentity(lstatSync(folder)),phase:'preparing',deletedAt:Date.now(),configHash:input.configHash,selectedIds:[...new Set(input.selectedIds)],allIds:[...ids],files:[],indexBefore,indexHash:textHash(indexBefore),officialFallback:false,indexPending:false,restoreFiles:[]}
  try{
    checkConfig(journal);saveTrashJournal(folder,journal);let bytes=0
    for(const [i,source] of sources.entries()){
      await verifySource(source);checkTrashHome(journal);const backup=i+'.jsonl'
      const result=await copyRaw(source.root,source.path,join(folder,backup),signal,value=>progress(bytes+value))
      await verifySource(source)
      journal.files.push({id:source.record.id,relative:relative(input.root,source.path).split(sep).join('/'),backup,source:{device:source.device,inode:source.inode,size:source.size,mtime:source.mtime,ctime:source.ctime},...result,title:source.record.title,cwd:source.record.cwd,updatedAt:source.record.updatedAt})
      saveTrashJournal(folder,journal);bytes+=source.size
    }
    signal.throwIfAborted();for(const source of sources)await verifySource(source)
    checkConfig(journal);if(textHash(readBounded(join(journal.root,'session_index.jsonl'),16*1024**2))!==journal.indexHash)throw new Error('备份期间会话索引已变化，请重新预览')
    journal.phase='backed_up';saveTrashJournal(folder,journal);return {folder,journal}
  }catch(error){checkBackup(folder,journal);rmSync(folder,{recursive:true});throw error}
}

export interface TrashImportFile {key:string;root:string;path:string;stamp:FileStamp;sha256:string;id:string;relative:string;title:string;cwd:string;updatedAt?:number;deletedAt:number;indexEntry:unknown}
export interface ImportTrashInput {id:string;targetId:string;targetName:string;root:string;configHash:string;file:TrashImportFile}
// Import only copies an existing backup into our private store. No original
// rollout, account/config file, or source Cockpit entry is written or removed.
export async function importTrashBackup(trashRoot:string,input:ImportTrashInput,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}):Promise<void>{
  signal.throwIfAborted();directory(trashRoot);if(realpathSync(trashRoot)!==trashRoot)throw new Error('废纸篓路径已变化')
  const file=input.file,id=z.string().uuid().parse(input.id),folder=join(trashRoot,id),source={device:file.stamp.dev,inode:file.stamp.ino,size:file.stamp.size,mtime:file.stamp.mtimeMs,ctime:file.stamp.ctimeMs}
  if(!sessionRelative(file.relative)||!matches(await safeSessionPath(file.root,file.path),source))throw new Error('旧废纸篓文件在预览后变化')
  const fields=file.indexEntry&&typeof file.indexEntry==='object'&&!Array.isArray(file.indexEntry)?file.indexEntry as Record<string,unknown>:{}
  const indexBefore=JSON.stringify({...fields,id:file.id,...typeof fields.thread_name==='string'?{}:{thread_name:file.title}})+'\n'
  if(Buffer.byteLength(indexBefore)>16*1024**2)throw new Error('旧会话索引超过 16 MiB')
  directory(input.root);mkdirSync(folder,{mode:0o700})
  const journal:TrashJournal={version:1,id,targetId:input.targetId,targetName:input.targetName,root:input.root,rootIdentity:fileIdentity(lstatSync(input.root)),backupIdentity:fileIdentity(lstatSync(folder)),phase:'preparing',deletedAt:file.deletedAt,configHash:input.configHash,selectedIds:[file.id],allIds:[file.id],files:[],indexBefore,indexHash:textHash(indexBefore),officialFallback:false,indexPending:false,restoreFiles:[],imported:{kind:'cockpit',key:file.key}}
  try{
    saveTrashJournal(folder,journal)
    const result=await copyRaw(file.root,file.path,join(folder,'0.jsonl'),signal,progress)
    if(result.sha256!==file.sha256||!matches(await safeSessionPath(file.root,file.path),source))throw new Error('导入期间旧废纸篓备份发生变化')
    journal.files=[{id:file.id,relative:file.relative,backup:'0.jsonl',source,...result,title:file.title,cwd:file.cwd,updatedAt:file.updatedAt}]
    signal.throwIfAborted();checkTrashHome(journal);journal.phase='trashed';saveTrashJournal(folder,journal)
  }catch(error){checkBackup(folder,journal);rmSync(folder,{recursive:true});throw error}
}

export interface TrashRuntime {
  plan:typeof planSessionDeletion;remove:typeof deleteSessionThreads;verify:typeof verifyDeletedSessionMetadata;rebuild:typeof rebuildSessionMetadata
}
export const officialTrashRuntime:TrashRuntime={plan:planSessionDeletion,remove:deleteSessionThreads,verify:verifyDeletedSessionMetadata,rebuild:rebuildSessionMetadata}
// Validate both physical copies and official cascades. Startup does not resume
// destruction: an interrupted deleting batch must be explicitly retried/restored.
async function verifyDeletionScope(journal:TrashJournal,signal:AbortSignal):Promise<void>{
  const seen=new Set<string>()
  for await(const path of rolloutFiles(journal.root,signal)){
    const {file,stat}=await openSessionFile(journal.root,path)
    try{
      const meta=await firstSessionEvent(file,stat.size,signal),id=meta?.type==='session_meta'?sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id):undefined
      if(!id||!journal.allIds.includes(id))continue
      const record=journal.files.find(row=>join(journal.root,row.relative)===path)
      if(!record||record.id!==id||!matches(stat,record.source))throw new Error('待删除会话新增副本或内容已变化，请保留备份并重新检查')
      seen.add(record.relative)
    }finally{await file.close()}
  }
  if(journal.phase==='backed_up'&&seen.size!==journal.files.length)throw new Error('待删除会话文件在备份后发生变化')
}
export async function deleteTrashOriginals(folder:string,program:SessionProgram,signal:AbortSignal,runtime:TrashRuntime=officialTrashRuntime):Promise<TrashJournal>{
  const journal=loadTrashJournal(folder)
  if(journal.imported)throw new Error('导入的废纸篓备份只能恢复或永久清理，不能删除原目录会话')
  if(!['backed_up','deleting','trashed'].includes(journal.phase))throw new Error('此废纸篓批次不可执行删除')
  if(journal.phase==='trashed'&&!journal.indexPending)return journal
  if(journal.restoredIds?.length||journal.removedIds?.length)throw new Error('部分会话已恢复或清理，不能重新执行删除')
  checkConfig(journal);await verifyBackup(folder,journal,signal);await verifyDeletionScope(journal,signal)
  // File removal already committed. A healthy replacement CLI can confirm the
  // index directly, without issuing thread/delete for every missing rollout.
  if(journal.phase==='trashed'){
    try{await runtime.verify(program,journal.root,journal.allIds,signal);journal.indexPending=false;saveTrashJournal(folder,journal);return journal}
    catch{signal.throwIfAborted()}
  }
  if(journal.phase==='backed_up'&&textHash(readBounded(join(journal.root,'session_index.jsonl'),16*1024**2))!==journal.indexHash)throw new Error('备份后会话索引已变化，请重新预览')
  let closure:OfficialDeletionEntry[]=[]
  let officialAvailable=true
  try{closure=await runtime.plan(program,journal.root,journal.selectedIds,signal)}catch(error){signal.throwIfAborted();officialAvailable=false}
  for(const entry of closure){
    if(!journal.allIds.includes(entry.id))throw new Error('官方删除范围增加了未备份的派生会话，请重新预览')
    if(entry.path&&existsSync(entry.path)&&!journal.files.some(file=>file.id===entry.id&&join(journal.root,file.relative)===entry.path))throw new Error('官方删除包含尚未备份的会话文件')
  }
  const parents=new Map(closure.map(row=>[row.id,row.parentId])),selected=new Set(journal.selectedIds)
  const roots=journal.selectedIds.filter(id=>{const visited=new Set([id]);for(let parent=parents.get(id);parent;parent=parents.get(parent)){if(visited.has(parent))throw new Error('会话派生关系存在循环，未开始删除');visited.add(parent);if(selected.has(parent))return false};return true})
  if(!roots.length)throw new Error('会话派生关系无法确定删除入口')
  signal.throwIfAborted();await verifyDeletionScope(journal,signal);checkConfig(journal)
  journal.phase='deleting';journal.indexPending=true;saveTrashJournal(folder,journal)
  journal.officialFallback=!officialAvailable
  if(officialAvailable)try{
    const result=await runtime.remove(program,journal.root,roots,signal)
    journal.officialFallback=result.failedIds.length>0||result.deletedIds.length<roots.length
  }catch(error){signal.throwIfAborted();journal.officialFallback=true}
  // Recheck survivors after the official process; never remove a changed file.
  const checked=new Map<string,Stats>()
  for(const file of journal.files){const path=join(journal.root,file.relative),stat=current(journal.root,path);if(!stat)continue;if(!matches(stat,file.source))throw new Error('官方删除期间原会话发生变化，备份已保留');checked.set(path,stat)}
  if(checked.size)journal.officialFallback=true
  signal.throwIfAborted();checkConfig(journal);checkBackup(folder,journal)
  for(const [path,stat] of checked){const actual=current(journal.root,path);if(!actual||!sameStamp(stat,actual))throw new Error('删除期间会话发生变化，备份已保留')}
  const indexPath=join(journal.root,'session_index.jsonl'),before=readBounded(indexPath,16*1024**2),after=removeTrashIndexEntries(before,new Set(journal.allIds))
  for(const path of checked.keys())unlinkSync(path)
  if(after!==before&&after!==null)atomic(indexPath,after)
  journal.phase='trashed';saveTrashJournal(folder,journal)
  try{await runtime.verify(program,journal.root,journal.allIds,signal);journal.indexPending=false;saveTrashJournal(folder,journal)}catch(error){signal.throwIfAborted();throw new Error('会话已移入废纸篓，但官方索引更新未完成：'+safeError(error))}
  return journal
}

const restoreStage=(journal:TrashJournal)=>join(journal.root,'.cml-trash-restore-'+journal.id)
function checkRestoreStage(journal:TrashJournal):void{checkTrashHome(journal);const stat=lstatSync(restoreStage(journal));if(!journal.restoreIdentity||stat.isSymbolicLink()||!stat.isDirectory()||stat.dev!==journal.restoreIdentity.device||stat.ino!==journal.restoreIdentity.inode)throw new Error('恢复暂存目录已变化')}
// Originals are never overwritten. Existing files with identical bytes count as
// restored; a same-ID but different body is a visible conflict, retaining backup.
export async function restoreTrashBatch(folder:string,program:SessionProgram,signal:AbortSignal,runtime:TrashRuntime=officialTrashRuntime,ids?:string[]):Promise<TrashJournal>{
  const journal=loadTrashJournal(folder)
  if(!['backed_up','deleting','trashed','restoring','restored'].includes(journal.phase))throw new Error('备份未完成，不能恢复会话')
  checkConfig(journal);await verifyBackup(folder,journal,signal)
  if(journal.phase==='restored'){if(existsSync(restoreStage(journal))){checkRestoreStage(journal);if(readdirSync(restoreStage(journal)).length)throw new Error('已恢复批次的暂存目录含未知文件');rmSync(restoreStage(journal),{recursive:true})};return journal}
  const wanted=[...new Set(z.array(z.string().uuid()).min(1).max(1000).parse(ids??journal.restoreIds??journal.allIds.filter(id=>!journal.restoredIds?.includes(id)&&!journal.removedIds?.includes(id))))]
  if(wanted.some(id=>!journal.allIds.includes(id)||journal.removedIds?.includes(id)||journal.restoredIds?.includes(id)))throw new Error('所选废纸篓会话已变化，请刷新')
  if(journal.phase==='restoring'){
    const expected=journal.restoreIds??journal.allIds
    if(expected.length!==wanted.length||expected.some(id=>!wanted.includes(id)))throw new Error('请先完成当前恢复批次')
  }else{
    if((journal.phase!=='trashed'||journal.indexPending)&&wanted.length!==journal.allIds.length)throw new Error('未完成的删除必须整批恢复')
    if(journal.restoreIdentity&&existsSync(restoreStage(journal))){checkRestoreStage(journal);if(readdirSync(restoreStage(journal)).length)throw new Error('已完成恢复的暂存目录含未知文件');rmSync(restoreStage(journal),{recursive:true})}
    journal.restoreIdentity=undefined;journal.restoreFiles=[];journal.restoreIndex=undefined
  }
  journal.restoreIds=wanted
  const files=journal.files.filter(file=>wanted.includes(file.id))
  for(const file of files){const path=join(journal.root,file.relative);if(current(journal.root,path))await checkedHash(journal.root,path,{size:file.stored.size,sha256:file.sha256},signal,2)}
  if(!journal.restoreIdentity){
    const stage=restoreStage(journal)
    if(existsSync(stage)){directory(stage);if(realpathSync(stage)!==stage||readdirSync(stage).length)throw new Error('恢复暂存目录已被占用')}else mkdirSync(stage,{mode:0o700})
    journal.restoreIdentity=fileIdentity(lstatSync(stage))
  }
  journal.phase='restoring';journal.indexPending=true;saveTrashJournal(folder,journal);checkRestoreStage(journal)
  for(const file of files){
    const destination=join(journal.root,file.relative)
    if(current(journal.root,destination))continue
    let staged=journal.restoreFiles.find(entry=>entry.relative===file.relative)
    if(!staged){
      const stage=file.backup,path=join(restoreStage(journal),stage)
      // A crash before the journal append can leave an incomplete staging file.
      // No published link exists yet; only this batch's fixed staging name is removed.
      if(current(journal.root,path))unlinkSync(path)
      const result=await copyRaw(folder,join(folder,file.backup),path,signal,()=>{})
      if(result.sha256!==file.sha256)throw new Error('恢复期间备份发生变化')
      staged={relative:file.relative,stage,device:result.stored.device,inode:result.stored.inode,size:result.stored.size,sha256:result.sha256};journal.restoreFiles.push(staged);saveTrashJournal(folder,journal)
    }
  }
  const checked=new Map<string,Stats|undefined>()
  for(const file of files){
    const path=join(journal.root,file.relative),stat=current(journal.root,path)
    if(stat){checked.set(path,await checkedHash(journal.root,path,{size:file.stored.size,sha256:file.sha256},signal,2));continue}
    checked.set(path,undefined)
    const staged=journal.restoreFiles.find(entry=>entry.relative===file.relative);if(!staged)throw new Error('会话恢复暂存文件缺失')
    const stage=join(restoreStage(journal),staged.stage),verified=await checkedHash(journal.root,stage,staged,signal,2)
    if(verified.dev!==staged.device||verified.ino!==staged.inode)throw new Error('会话恢复暂存文件已被替换');checked.set(stage,verified)
  }
  signal.throwIfAborted();checkConfig(journal);checkRestoreStage(journal)
  for(const [path,expected] of checked){const actual=current(journal.root,path);if(expected?(!actual||!sameStamp(actual,expected)):actual)throw new Error('恢复期间会话发生变化，未覆盖原文件')}
  const indexPath=join(journal.root,'session_index.jsonl'),before=readBounded(indexPath,16*1024**2)
  if(journal.restoreIndex&&before!==journal.restoreIndex.before&&before!==journal.restoreIndex.after)throw new Error('恢复期间会话索引已被修改，备份已保留')
  if(!journal.restoreIndex){const after=restoreTrashIndexEntries(before,journal,wanted);journal.restoreIndex={before,after,beforeHash:textHash(before),afterHash:textHash(after)};saveTrashJournal(folder,journal)}
  const after=journal.restoreIndex.after
  for(const file of files){const path=join(journal.root,file.relative);if(checked.get(path))continue;ensureSessionParent(journal.root,path);linkSync(join(restoreStage(journal),journal.restoreFiles.find(entry=>entry.relative===file.relative)!.stage),path)}
  if(after!==before)atomic(indexPath,after)
  // Remove only staging links we recorded, preserving original independent files.
  for(const staged of journal.restoreFiles){const path=join(restoreStage(journal),staged.stage),stat=current(journal.root,path);if(stat){if(stat.dev!==staged.device||stat.ino!==staged.inode)throw new Error('恢复暂存文件已变化');unlinkSync(path)}}
  await runtime.rebuild(program,journal.root,[...new Set(files.map(file=>file.id))],signal)
  journal.restoredIds=[...new Set([...(journal.restoredIds??[]),...wanted])]
  journal.phase=journal.allIds.every(id=>journal.restoredIds!.includes(id)||journal.removedIds?.includes(id))?'restored':'trashed';journal.indexPending=false;saveTrashJournal(folder,journal)
  checkRestoreStage(journal);rmSync(restoreStage(journal),{recursive:true});return journal
}
// Explicit permanent cleanup is restricted to completed batches. Callers supply
// an internally resolved folder, never a renderer path. No recursive symlink walk.
export function purgeTrashBatch(folder:string,ids?:string[]):void{
  const journal=loadTrashJournal(folder)
  if(!['trashed','restored'].includes(journal.phase)||journal.indexPending)throw new Error('请先完成会话恢复或索引更新，再永久清理')
  const wanted=[...new Set(z.array(z.string().uuid()).min(1).max(1000).parse(ids??journal.allIds))]
  if(wanted.some(id=>!journal.allIds.includes(id)))throw new Error('清理会话不属于此废纸篓批次')
  const allowed=new Set(['journal.json',...journal.files.map(file=>file.backup)])
  for(const entry of readdirSync(folder,{withFileTypes:true})){if(!allowed.has(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw new Error('废纸篓包含未识别文件，未永久清理')}
  journal.removedIds=[...new Set([...(journal.removedIds??[]),...wanted])];saveTrashJournal(folder,journal)
  for(const file of journal.files.filter(file=>journal.removedIds!.includes(file.id))){const path=join(folder,file.backup);if(existsSync(path))unlinkSync(path)}
  if(journal.allIds.every(id=>journal.removedIds!.includes(id))){checkBackup(folder,journal);rmSync(folder,{recursive:true})}
}

export function discardTrashPreparation(folder:string):void{
  const journal=loadTrashJournal(folder)
  if(!['preparing','backed_up'].includes(journal.phase))throw new Error('删除已经开始，请恢复会话或完成删除')
  if(!journal.imported){checkTrashHome(journal)
    for(const file of journal.files){const stat=current(journal.root,join(journal.root,file.relative));if(!stat||!matches(stat,file.source))throw new Error('原文件发生变化，未清理备份')}
  }
  for(const entry of readdirSync(folder,{withFileTypes:true}))if(!entry.isFile()||entry.isSymbolicLink()||entry.name!=='journal.json'&&!/^\d+\.jsonl$/.test(entry.name))throw new Error('备份目录包含未知文件，未清理')
  checkBackup(folder,journal);rmSync(folder,{recursive:true})
}
