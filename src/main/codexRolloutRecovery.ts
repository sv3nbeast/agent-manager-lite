// Offline, exact restoration of a provider-rewritten paginated rollout. Never
// guess byte deltas or rewrite SQLite cursors: restore verified original bytes.
import {constants,existsSync,type Stats} from 'node:fs'
import {open,readdir,realpath,rename,rm} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual,promisify} from 'node:util'
import {execFile} from 'node:child_process'
import * as zlib from 'node:zlib'
import {openSessionFile,safeSessionPath} from './sessionFiles'
import {hasIndexedRolloutBytes,isRolloutFile} from './codexRolloutMetadata'
import {probeClientDaemon} from './clientDaemon'

const limit=256*1024*1024,execute=promisify(execFile)
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
const codecs=zlib as typeof zlib&{zstdDecompressSync?:(data:Buffer,options:{maxOutputLength:number})=>Buffer;zstdCompressSync?:(data:Buffer)=>Buffer}
interface Snapshot {path:string;home:string;stat:Stats;stored:Buffer;raw:Buffer}
export interface RolloutProviderRecovery {
  source:Snapshot;target:Snapshot;restored:Buffer
  summary:{sessionId:string;sourcePath:string;targetPath:string;originalBytes:number;currentBytes:number;restoredBytes:number;bodySha256:string}
}
function sessionHome(path:string):string{
  if(!isAbsolute(path)||resolve(path)!==path||!isRolloutFile(path))throw new Error('必须指定绝对会话文件路径')
  for(let folder=dirname(path);dirname(folder)!==folder;folder=dirname(folder))if(['sessions','archived_sessions'].includes(basename(folder)))return dirname(folder)
  throw new Error('文件不在 Codex 会话目录内')
}
async function snapshot(path:string):Promise<Snapshot>{
  const home=sessionHome(path),{file,stat}=await openSessionFile(home,path)
  try{
    if(stat.size>limit)throw new Error('会话超过 256 MiB 精确恢复上限')
    const stored=Buffer.alloc(stat.size)
    let offset=0
    while(offset<stored.length){const {bytesRead}=await file.read(stored,offset,stored.length-offset,offset);if(!bytesRead)throw new Error('会话读取期间缩短');offset+=bytesRead}
    if(!same(stat,await file.stat())||!same(stat,await safeSessionPath(home,path)))throw new Error('会话读取期间发生变化')
    if(/\.zst$/i.test(path)&&!codecs.zstdDecompressSync)throw new Error('当前运行环境不支持 Zstandard')
    const raw=/\.zst$/i.test(path)?codecs.zstdDecompressSync!(stored,{maxOutputLength:limit}):stored
    return {path,home,stat,stored,raw}
  }finally{await file.close()}
}
function split(raw:Buffer){
  const at=raw.indexOf(10)
  if(at<0||at>4*1024*1024)throw new Error('会话缺少有界的完整元数据行')
  let event:Record<string,any>
  try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,at)).replace(/^\uFEFF/,''))}catch{throw new Error('会话元数据无法解析')}
  if(event?.type!=='session_meta'||!event.payload||typeof event.payload.id!=='string'||!hasIndexedRolloutBytes(event))throw new Error('仅支持身份明确的分页会话恢复')
  const provider=event.payload.model_provider
  if(typeof provider!=='string')throw new Error('会话缺少供应商标识')
  delete event.payload.model_provider
  return {event,provider,body:raw.subarray(at+1)}
}
export async function prepareRolloutProviderRecovery(sourcePath:string,targetPath:string):Promise<RolloutProviderRecovery>{
  const source=await snapshot(sourcePath),target=await snapshot(targetPath)
  if(source.stat.dev===target.stat.dev&&source.stat.ino===target.stat.ino)throw new Error('来源与目标必须是不同文件')
  if(basename(source.path).replace(/\.zst$/i,'')!==basename(target.path).replace(/\.zst$/i,''))throw new Error('原始副本与目标分段的文件身份不同')
  const original=split(source.raw),current=split(target.raw)
  if(!isDeepStrictEqual(original.event,current.event)||!original.body.equals(current.body))throw new Error('元数据或正文不一致，拒绝用原始副本覆盖此会话')
  if(original.provider===current.provider)throw new Error('供应商标识相同，无需执行此恢复')
  if(/\.zst$/i.test(target.path)&&!codecs.zstdCompressSync)throw new Error('当前运行环境不支持 Zstandard')
  const restored=/\.zst$/i.test(target.path)?codecs.zstdCompressSync!(source.raw):source.raw
  return {source,target,restored,summary:{sessionId:original.event.payload.id,sourcePath,targetPath,originalBytes:source.raw.length,currentBytes:target.raw.length,restoredBytes:source.raw.length,bodySha256:digest(original.body)}}
}
async function assertStopped(plan:RolloutProviderRecovery):Promise<void>{
  const home=plan.target.home
  if(process.env.CODEX_HOME&&await realpath(process.env.CODEX_HOME).catch(()=>resolve(process.env.CODEX_HOME!))===home)throw new Error('目标是当前会话使用的实例，必须从独立终端在实例退出后恢复')
  if(existsSync(join(dirname(home),'launch.json')))throw new Error('实例仍有启动记录，请先从管理器停止实例')
  const state=await probeClientDaemon(home)
  if(state!=='not_detected')throw new Error('无法确认实例已停止，请先退出使用此目录的 Codex 客户端与 CLI')
  const paths=[plan.target.path]
  for(const folder of [home,join(home,'sqlite')]){
    let entries
    try{entries=await readdir(folder,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
    for(const entry of entries)if(/\.sqlite(?:-wal|-shm)?$/i.test(entry.name)){
      if(!entry.isFile())throw new Error('会话数据库路径不安全')
      const path=join(folder,entry.name);await safeSessionPath(home,path);paths.push(path)
    }
  }
  try{const result=await execute('lsof',['-nP','-t','--',...paths],{timeout:10_000,maxBuffer:1024*1024});if(result.stdout.trim()||result.stderr.trim())throw new Error('仍有进程占用实例会话文件，请先退出实例')}
  catch(error){const e=error as Error&{code?:number;stdout?:string;stderr?:string};if(e.code===1&&!e.stdout?.trim()&&!e.stderr?.trim())return;throw new Error(e.code?'无法确认实例文件是否仍被占用，未执行恢复':e.message)}
}
async function unchanged(value:Snapshot):Promise<void>{
  const current=await snapshot(value.path)
  if(!same(value.stat,current.stat)||!value.stored.equals(current.stored))throw new Error('预览后文件已变化，未执行恢复')
}
async function assertFilesNotOpen(paths:string[]):Promise<void>{
  try{
    const result=await execute('lsof',['-nP','-t','--',...paths],{timeout:10_000,maxBuffer:1024*1024})
    if(result.stdout.trim()||result.stderr.trim())throw new Error('归档会话文件正在被读取；未执行在线恢复')
  }catch(error){
    const e=error as Error&{code?:number;stdout?:string;stderr?:string}
    if(e.code===1&&!e.stdout?.trim()&&!e.stderr?.trim())return
    throw new Error(e.code?'无法确认归档会话文件是否正在被读取；未执行在线恢复':e.message)
  }
}
/** Replace only closed immutable compressed ancestors. A racing reader sees
 * either the old complete file or the new complete file, never a partial one. */
export async function applyArchivedRolloutProviderRecovery(plan:RolloutProviderRecovery):Promise<{backupPath:string}>{
  if(!plan.target.path.split('/').includes('archived_sessions')||!plan.target.path.endsWith('.jsonl.zst'))throw new Error('在线恢复仅允许不可变的归档 Zstandard 分段')
  await assertFilesNotOpen([plan.target.path]);await unchanged(plan.source);await unchanged(plan.target)
  const backupPath=plan.target.path+'.provider-recovery-'+randomUUID()+'.bak',temporary=join(dirname(plan.target.path),'.provider-recovery-'+randomUUID())
  const write=async(path:string,bytes:Buffer)=>{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}}
  await write(backupPath,plan.target.stored)
  try{
    await write(temporary,plan.restored)
    const staged=await open(temporary,constants.O_RDWR|constants.O_NOFOLLOW)
    try{await staged.chmod(plan.target.stat.mode&0o777);await staged.utimes(plan.target.stat.atime,plan.target.stat.mtime);await staged.sync()}finally{await staged.close()}
    await assertFilesNotOpen([plan.target.path]);await unchanged(plan.source);await unchanged(plan.target)
    await rename(temporary,plan.target.path)
    const folder=await open(dirname(plan.target.path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{await folder.sync()}finally{await folder.close()}
    return {backupPath}
  }catch(error){throw new Error((error instanceof Error?error.message:'恢复失败')+'；原文件备份：'+backupPath)}
  finally{await rm(temporary,{force:true})}
}
export async function applyRolloutProviderRecovery(plan:RolloutProviderRecovery):Promise<{backupPath:string}>{
  await assertStopped(plan);await unchanged(plan.source);await unchanged(plan.target)
  const backupPath=plan.target.path+'.provider-recovery-'+randomUUID()+'.bak',temporary=join(dirname(plan.target.path),'.provider-recovery-'+randomUUID())
  const write=async(path:string,bytes:Buffer)=>{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}}
  await write(backupPath,plan.target.stored)
  try{
    await write(temporary,plan.restored)
    const staged=await open(temporary,constants.O_RDWR|constants.O_NOFOLLOW)
    try{await staged.utimes(plan.target.stat.atime,plan.target.stat.mtime);await staged.sync()}finally{await staged.close()}
    await assertStopped(plan);await unchanged(plan.source);await unchanged(plan.target)
    await rename(temporary,plan.target.path)
    const folder=await open(dirname(plan.target.path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{await folder.sync()}finally{await folder.close()}
    return {backupPath}
  }catch(error){throw new Error((error instanceof Error?error.message:'恢复失败')+'；原文件备份：'+backupPath)}
  finally{await rm(temporary,{force:true})}
}
