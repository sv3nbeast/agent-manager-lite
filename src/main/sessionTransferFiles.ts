// Additive session transfer journal. File publication never replaces a rollout.
import {constants,lstatSync,existsSync,mkdirSync,linkSync,unlinkSync,rmSync,realpathSync,type Stats} from 'node:fs'
import {open,lstat} from 'node:fs/promises'
import {join,dirname,relative,sep,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {atomic,readBounded} from './clientConfig'
import {openSessionFile,safeSessionPath,sessionLines,jsonLine,sessionIdentifier} from './sessionFiles'
import type {SessionTransferSource} from './sessions'

export const textHash=(raw:string|null)=>createHash('sha256').update(raw===null?'absent:':'present:'+raw).digest('hex')
export const sessionRelative=(value:string)=>value.length<=2000&&!isAbsolute(value)&&!value.includes('\\')&&!/[\x00-\x1f\x7f:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..')&&/^(sessions|archived_sessions)\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/.test(value)
const identity=z.object({device:z.number().int().nonnegative(),inode:z.number().int().nonnegative()}).strict()
const hash=z.string().regex(/^[a-f0-9]{64}$/)
const metadata=z.object({name:z.enum(['session_index.jsonl','.codex-global-state.json']),before:z.string().max(16*1024*1024).nullable(),after:z.string().max(16*1024*1024),beforeHash:hash,afterHash:hash}).strict()
const file=z.object({relative:z.string().refine(sessionRelative),stage:z.string().regex(/^\d+\.jsonl$/),device:z.number().int().nonnegative(),inode:z.number().int().nonnegative(),size:z.number().int().nonnegative(),sha256:hash}).strict()
export const sessionJournalSchema=z.object({version:z.literal(1),id:z.string().uuid(),phase:z.enum(['preparing','prepared','committed','done','rolled_back']),targetId:z.string().uuid(),targetName:z.string().max(200),root:z.string().max(4000),rootIdentity:identity,stageIdentity:identity,configHash:hash,
  program:z.object({path:z.string().max(4000),device:z.number(),inode:z.number(),size:z.number(),mtime:z.number()}).strict(),sessionIds:z.array(z.string().min(1).max(256)).max(1000),files:z.array(file).max(1000),metadata:z.array(metadata).max(2),createdAt:z.number().int()}).strict()
export type SessionJournal=z.infer<typeof sessionJournalSchema>
export const sessionJournalLimit=40*1024*1024
export function encodeSessionJournal(journal:SessionJournal):string{
  const raw=JSON.stringify(sessionJournalSchema.parse(journal))
  // Reserve space for later phase transitions. Every saved journal must also
  // fit the bounded recovery reader after JSON escaping and UTF-8 encoding.
  if(Buffer.byteLength(raw)>sessionJournalLimit-1024)throw new Error('会话恢复记录超过 40 MiB，请缩小所选范围或先整理目标索引')
  return raw
}
export const stagePath=(journal:Pick<SessionJournal,'root'|'id'>)=>join(journal.root,'.cml-session-transfer-'+journal.id)
export const fileIdentity=(stat:Stats)=>({device:stat.dev,inode:stat.ino})
export function checkRoot(journal:SessionJournal):void{
  const stat=lstatSync(journal.root)
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(journal.root)!==journal.root||stat.dev!==journal.rootIdentity.device||stat.ino!==journal.rootIdentity.inode)throw new Error('目标会话目录已被替换，恢复数据已保留')
}
export function checkStage(journal:SessionJournal):void{
  const path=stagePath(journal),stat=lstatSync(path)
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==journal.stageIdentity.device||stat.ino!==journal.stageIdentity.inode)throw new Error('会话暂存目录已变化，已保留恢复数据')
}
export function ensureSessionParent(root:string,path:string):void{
  const rel=relative(root,dirname(path));if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('会话目标路径越界')
  let current=root
  for(const part of rel.split(sep).filter(Boolean)){
    current=join(current,part)
    if(!existsSync(current))mkdirSync(current,{mode:0o700})
    const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('会话目标路径包含链接或异常目录')
  }
}
export async function verifySource(source:SessionTransferSource):Promise<void>{
  const root=await lstat(source.root);if(root.dev!==source.rootDevice||root.ino!==source.rootInode)throw new Error('来源会话目录已被替换')
  const stat=await safeSessionPath(source.root,source.path)
  if(!stat.isFile()||stat.nlink!==1||stat.dev!==source.device||stat.ino!==source.inode||stat.size!==source.size||stat.mtimeMs!==source.mtime||stat.ctimeMs!==source.ctime)throw new Error('来源会话在预览后发生变化，请重新预览')
}
export async function copySessionRollout(source:SessionTransferSource,destination:string,provider:string,signal:AbortSignal,progress:(bytes:number)=>void):Promise<{size:number;sha256:string;device:number;inode:number}>{
  await verifySource(source);const {file,stat}=await openSessionFile(source.root,source.path)
  try{
    const output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),digest=createHash('sha256')
    let offset=0,written=0,header:Buffer|undefined
    const prefix:Buffer[]=[]
    try{
      for await(const line of sessionLines(file,Math.min(stat.size,4*1024*1024),signal)){
        const consumed=line.length+(offset+line.length<stat.size?1:0);offset+=consumed
        if(!line.toString().trim()){prefix.push(Buffer.concat([line,Buffer.from(consumed>line.length?'\n':'')]));continue}
        const meta=jsonLine(line)
        if(meta?.type!=='session_meta'||sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)!==source.record.id||!meta.payload||typeof meta.payload!=='object'||Array.isArray(meta.payload))throw new Error('会话元数据格式无法复制')
        meta.payload.model_provider=provider;header=Buffer.concat([...prefix,Buffer.from(JSON.stringify(meta)+(consumed>line.length?'\n':''))]);break
      }
      if(!header)throw new Error('来源会话缺少有效元数据')
      const write=async(buffer:Buffer)=>{digest.update(buffer);for(let cursor=0;cursor<buffer.length;){signal.throwIfAborted();const {bytesWritten}=await output.write(buffer,cursor,buffer.length-cursor);if(!bytesWritten)throw new Error('会话副本写入失败');cursor+=bytesWritten;written+=bytesWritten}}
      await write(header);progress(offset)
      const buffer=Buffer.alloc(256*1024)
      while(offset<stat.size){signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)throw new Error('来源会话文件不完整');await write(buffer.subarray(0,bytesRead));offset+=bytesRead;progress(offset)}
      await verifySource(source);const after=await file.stat()
      if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('复制期间来源会话发生变化')
      await output.utimes(new Date(source.mtime),new Date(source.mtime));await output.sync()
      return {size:written,sha256:digest.digest('hex'),...fileIdentity(await output.stat())}
    }finally{await output.close()}
  }finally{await file.close()}
}
async function ownedRollout(journal:SessionJournal,entry:SessionJournal['files'][number]):Promise<boolean>{
  const path=join(journal.root,entry.relative)
  let stat:Stats
  try{stat=await safeSessionPath(journal.root,path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  // Two links exist during publication: the staged inode and its final name.
  if(!stat.isFile()||stat.dev!==entry.device||stat.ino!==entry.inode||stat.size!==entry.size||stat.nlink>2)throw new Error('目标会话已被其他进程修改，未自动撤销')
  const input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),digest=createHash('sha256'),buffer=Buffer.alloc(256*1024)
  try{let offset=0;while(offset<stat.size){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)throw new Error('目标会话发生变化');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead}
    const after=await input.stat();if(after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||digest.digest('hex')!==entry.sha256)throw new Error('目标会话已被其他进程修改，未自动撤销')
  }finally{await input.close()}
  return true
}
export function cleanupSessionStage(journal:SessionJournal):void{checkRoot(journal);if(existsSync(stagePath(journal))){checkStage(journal);rmSync(stagePath(journal),{recursive:true})}}
export async function rollbackSessionTransfer(journal:SessionJournal):Promise<void>{
  checkRoot(journal)
  for(const item of journal.metadata){
    if(textHash(item.before)!==item.beforeHash||textHash(item.after)!==item.afterHash)throw new Error('会话备份校验失败')
    const current=readBounded(join(journal.root,item.name),16*1024*1024)
    if(current!==item.before&&current!==item.after)throw new Error('会话索引已被其他进程修改，恢复备份已保留')
  }
  const installed:SessionJournal['files']=[]
  for(const entry of journal.files)if(await ownedRollout(journal,entry))installed.push(entry)
  checkRoot(journal)
  for(const item of journal.metadata){const path=join(journal.root,item.name),current=readBounded(path,16*1024*1024);if(current===item.before)continue;if(current!==item.after)throw new Error('恢复期间索引发生变化');if(item.before===null)unlinkSync(path);else atomic(path,item.before)}
  for(const entry of installed){const path=join(journal.root,entry.relative),stat=lstatSync(path);if(stat.dev!==entry.device||stat.ino!==entry.inode)throw new Error('恢复期间会话文件发生变化');unlinkSync(path)}
  cleanupSessionStage(journal)
}
export function publishSessionTransfer(journal:SessionJournal):void{
  checkRoot(journal);checkStage(journal)
  if(textHash(readBounded(join(journal.root,'config.toml'),1024*1024))!==journal.configHash)throw new Error('目标配置已变化，请重新预览')
  for(const item of journal.metadata)if(readBounded(join(journal.root,item.name),16*1024*1024)!==item.before)throw new Error('目标会话索引在复制期间发生变化')
  for(const entry of journal.files){
    const staged=join(stagePath(journal),entry.stage),stat=lstatSync(staged)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==entry.device||stat.ino!==entry.inode||stat.size!==entry.size||stat.nlink!==1)throw new Error('会话暂存文件已变化')
    const path=join(journal.root,entry.relative);ensureSessionParent(journal.root,path);linkSync(staged,path)
  }
  for(const item of journal.metadata)atomic(join(journal.root,item.name),item.after)
}
