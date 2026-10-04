// Per-home sync journal: originals are renamed into a private backup before
// replacements are published. Recovery only touches verified own files.
import {constants,existsSync,lstatSync,mkdirSync,renameSync,linkSync,unlinkSync,rmSync,realpathSync,type Stats} from 'node:fs'
import {open} from 'node:fs/promises'
import {join,relative,sep,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {atomic,readBounded} from './clientConfig'
import {sessionRelative,textHash,ensureSessionParent,fileIdentity} from './sessionTransferFiles'
import {safeSessionPath} from './sessionFiles'
import type {SessionProgram} from './officialSessions'

const hash=z.string().regex(/^[a-f0-9]{64}$/),identity=z.object({device:z.number().int().nonnegative(),inode:z.number().int().nonnegative()}).strict()
const file=z.object({relative:z.string().refine(sessionRelative),stage:z.string(),device:z.number().int().nonnegative(),inode:z.number().int().nonnegative(),size:z.number().int().nonnegative(),sha256:hash}).strict()
const metadata=z.object({name:z.enum(['session_index.jsonl','.codex-global-state.json']),before:z.string().nullable(),after:z.string(),beforeHash:hash,afterHash:hash}).strict()
const unique=(values:string[])=>new Set(values).size===values.length
export const syncJournalSchema=z.object({version:z.literal(1),id:z.string().uuid(),targetId:z.string().uuid(),targetName:z.string().max(200),root:z.string().max(4000).refine(isAbsolute),rootIdentity:identity,stageIdentity:identity,phase:z.enum(['preparing','prepared','committed','done','rolled_back']),configHash:hash,
  originals:z.array(file.extend({stage:z.string().regex(/^old-\d+\.jsonl$/)})).max(10000),outputs:z.array(file.extend({stage:z.string().regex(/^new-\d+\.jsonl$/)})).max(1000),metadata:z.array(metadata).max(2),sessionIds:z.array(z.string().uuid()).max(1000),program:z.object({path:z.string().max(4000),device:z.number(),inode:z.number(),size:z.number(),mtime:z.number()}).strict()
}).strict().refine(value=>[value.originals,value.outputs].every(files=>unique(files.map(file=>file.relative))&&unique(files.map(file=>file.stage)))&&unique(value.metadata.map(item=>item.name))&&value.metadata.every(item=>textHash(item.before)===item.beforeHash&&textHash(item.after)===item.afterHash),'同步恢复记录存在重复路径或无效摘要')
export type SyncJournal=z.infer<typeof syncJournalSchema>
export const syncStage=(journal:Pick<SyncJournal,'root'|'id'>)=>join(journal.root,'.cml-session-sync-'+journal.id)
export function encodeSyncJournal(value:SyncJournal):string{const raw=JSON.stringify(syncJournalSchema.parse(value));if(Buffer.byteLength(raw)>40*1024**2-1024)throw new Error('同步恢复记录超过 40 MiB，请缩小范围或整理索引');return raw}
export function verifySyncRoot(journal:SyncJournal):void{const stat=lstatSync(journal.root);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(journal.root)!==journal.root||stat.dev!==journal.rootIdentity.device||stat.ino!==journal.rootIdentity.inode)throw new Error('同步目录已被替换，备份已保留')}
function verifyStage(journal:SyncJournal):void{verifySyncRoot(journal);const stat=lstatSync(syncStage(journal));if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==journal.stageIdentity.device||stat.ino!==journal.stageIdentity.inode)throw new Error('同步暂存目录已变化，备份已保留')}
function currentFile(root:string,path:string):Stats|undefined{
  const rel=relative(root,path);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('同步路径不属于目标目录')
  let current=root
  try{for(const part of rel.split(sep).slice(0,-1)){current=join(current,part);const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('同步文件目录已变化')};return lstatSync(path)}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
}
const sameStamp=(a:Stats,b:Stats)=>a.isFile()&&!a.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink
// Hash reads may yield for a long time. Retain their final stamps, then check
// every path synchronously before any mutation (closed-client contract).
function unchanged(root:string,checked:Map<string,Stats|undefined>):void{
  for(const [path,expected] of checked){const actual=currentFile(root,path);if(expected?(!actual||!sameStamp(actual,expected)):actual!==undefined)throw new Error('同步校验期间文件已变化，备份已保留')}
}
async function inspectFile(root:string,path:string,expected:SyncJournal['outputs'][number],signal?:AbortSignal):Promise<Stats|undefined>{
  let stat:Stats
  try{stat=await safeSessionPath(root,path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  if(!stat.isFile()||stat.nlink>2||stat.dev!==expected.device||stat.ino!==expected.inode||stat.size!==expected.size)throw new Error('同步文件已被其他进程修改，备份已保留')
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),hash=createHash('sha256');let position=0
  try{
    if(!sameStamp(await handle.stat(),stat))throw new Error('同步文件在打开期间发生变化')
    const buffer=Buffer.alloc(256*1024)
    while(position<stat.size){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,stat.size-position),position);if(!bytesRead)throw new Error('同步文件在校验期间发生变化');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead}
    if(!sameStamp(await handle.stat(),stat)||hash.digest('hex')!==expected.sha256)throw new Error('同步文件内容已变化，备份已保留')
    const actual=currentFile(root,path);if(!actual||!sameStamp(actual,stat))throw new Error('同步文件路径已变化');return stat
  }finally{await handle.close()}
}
export async function verifySyncFile(root:string,path:string,expected:SyncJournal['outputs'][number],signal?:AbortSignal):Promise<boolean>{return !!await inspectFile(root,path,expected,signal)}
function metadataCurrent(journal:SyncJournal,rollback=false):void{
  for(const item of journal.metadata){
    if(textHash(item.before)!==item.beforeHash||textHash(item.after)!==item.afterHash)throw new Error('同步索引备份校验失败')
    const current=readBounded(join(journal.root,item.name),16*1024**2)
    if(current!==item.before&&(!rollback||current!==item.after))throw new Error('同步目标索引已变化，未覆盖用户文件')
  }
}
export async function publishSync(journal:SyncJournal,signal:AbortSignal):Promise<void>{
  if(journal.phase!=='prepared')throw new Error('同步事务尚未准备完成')
  verifyStage(journal);metadataCurrent(journal)
  const checked=new Map<string,Stats|undefined>()
  for(const file of journal.originals){
    const path=join(journal.root,file.relative),stat=await inspectFile(journal.root,path,file,signal)
    if(!stat||stat.nlink!==1)throw new Error('同步原文件已移除或存在额外链接');checked.set(path,stat)
    const backup=join(syncStage(journal),file.stage);if(currentFile(journal.root,backup))throw new Error('同步备份位置已被占用');checked.set(backup,undefined)
  }
  for(const file of journal.outputs){
    const path=join(syncStage(journal),file.stage),stat=await inspectFile(journal.root,path,file,signal)
    if(!stat||stat.nlink!==1)throw new Error('同步新文件缺失或存在额外链接');checked.set(path,stat)
    const destination=join(journal.root,file.relative)
    if(!journal.originals.some(old=>old.relative===file.relative)){if(currentFile(journal.root,destination))throw new Error('同步新文件目标已被占用');checked.set(destination,undefined)}
  }
  signal.throwIfAborted();verifyStage(journal)
  if(textHash(readBounded(join(journal.root,'config.toml'),1024**2))!==journal.configHash)throw new Error('同步目标配置已变化，请重新预览')
  metadataCurrent(journal);unchanged(journal.root,checked)
  // No await from final validation to publication. Crash recovery handles any
  // prefix; this is not a filesystem lock against other same-user processes.
  for(const file of journal.outputs)ensureSessionParent(journal.root,join(journal.root,file.relative))
  for(const file of journal.originals)renameSync(join(journal.root,file.relative),join(syncStage(journal),file.stage))
  for(const file of journal.outputs)linkSync(join(syncStage(journal),file.stage),join(journal.root,file.relative))
  for(const item of journal.metadata)atomic(join(journal.root,item.name),item.after)
}
export async function rollbackSync(journal:SyncJournal):Promise<void>{
  if(['committed','done','rolled_back'].includes(journal.phase))throw new Error('同步事务已提交或已恢复，不能撤回')
  verifyStage(journal);metadataCurrent(journal,true)
  const installed:SyncJournal['outputs']=[],moved:SyncJournal['originals']=[],checked=new Map<string,Stats|undefined>()
  for(const file of journal.outputs){
    const path=join(journal.root,file.relative),old=journal.originals.find(old=>old.relative===file.relative),stat=currentFile(journal.root,path)
    if(old&&stat?.dev===old.device&&stat.ino===old.inode){checked.set(path,await inspectFile(journal.root,path,old));continue}
    const installedStat=await inspectFile(journal.root,path,file);checked.set(path,installedStat);if(installedStat)installed.push(file)
  }
  for(const old of journal.originals){
    const backup=join(syncStage(journal),old.stage),path=join(journal.root,old.relative),stat=await inspectFile(journal.root,backup,old);checked.set(backup,stat)
    if(stat){
      if(currentFile(journal.root,path)&&!installed.some(file=>file.relative===old.relative))throw new Error('同步原路径已被占用，备份已保留')
      if(!checked.has(path))checked.set(path,undefined);moved.push(old)
    }else{const original=await inspectFile(journal.root,path,old);if(!original)throw new Error('同步原文件和备份均缺失');checked.set(path,original)}
  }
  verifyStage(journal);metadataCurrent(journal,true);unchanged(journal.root,checked)
  for(const old of moved)ensureSessionParent(journal.root,join(journal.root,old.relative))
  for(const item of journal.metadata){const path=join(journal.root,item.name);if(readBounded(path,16*1024**2)===item.before)continue;if(item.before===null)unlinkSync(path);else atomic(path,item.before)}
  for(const file of installed)unlinkSync(join(journal.root,file.relative))
  for(const old of moved)renameSync(join(syncStage(journal),old.stage),join(journal.root,old.relative))
}
export function cleanupSync(journal:SyncJournal):void{
  if(!['done','committed','rolled_back'].includes(journal.phase))throw new Error('同步尚未提交或恢复，不能清理备份')
  verifySyncRoot(journal);if(!existsSync(syncStage(journal))&&journal.phase==='rolled_back')return
  verifyStage(journal)
  if(journal.phase==='rolled_back'){rmSync(syncStage(journal),{recursive:true});return}
  for(const file of journal.outputs){const path=join(syncStage(journal),file.stage),stat=currentFile(journal.root,path);if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==file.device||stat.ino!==file.inode)throw new Error('同步暂存文件已变化');unlinkSync(path)}}
  // Preserve overwritten originals and readable metadata backups for the user.
  for(const item of journal.metadata)if(item.before!==null&&!existsSync(join(syncStage(journal),item.name+'.before')))atomic(join(syncStage(journal),item.name+'.before'),item.before)
}
export function createSyncJournal(id:string,targetId:string,targetName:string,root:string,configHash:string,program:SessionProgram):SyncJournal{
  z.string().uuid().parse(id)
  const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(root)!==root)throw new Error('同步目标目录无效')
  const stage=syncStage({id,root});mkdirSync(stage,{mode:0o700})
  return {version:1,id,targetId,targetName,root,rootIdentity:fileIdentity(stat),stageIdentity:fileIdentity(lstatSync(stage)),phase:'preparing',configHash,originals:[],outputs:[],metadata:[],sessionIds:[],program}
}
