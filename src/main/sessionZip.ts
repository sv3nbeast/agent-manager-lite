// Cockpit's codex-session-export v1 format; streaming ZIP64 transport is local.
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,type Stats} from 'node:fs'
import {open,rename,rm,type FileHandle} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Readable,Writable,addAbortSignal} from 'node:stream'
import {pipeline,finished} from 'node:stream/promises'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import {z} from 'zod'
import type {SessionTransferSource} from './sessions'
import {verifySource,sessionRelative} from './sessionTransferFiles'
import {openSessionFile} from './sessionFiles'
import {assertUnpagedSessionSources} from './sessionPaging'

export const archiveMaxBytes=100*1024**3,manifestMaxBytes=8*1024**2
const safeEntry=(path:string)=>path.length<=2000&&!/[\\\x00-\x1f\x7f:]/.test(path)&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..')
const itemSchema=z.object({sessionId:z.string().uuid(),title:z.string().max(2000),cwd:z.string().max(4000),updatedAt:z.number().int().min(0).max(253402300799).nullable().optional(),relativeRolloutPath:z.string().max(2000),fileEntry:z.string().refine(value=>safeEntry(value)&&value.startsWith('files/')&&value.endsWith('.jsonl')),sizeBytes:z.number().int().min(1).max(archiveMaxBytes),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),sessionIndexEntry:z.unknown(),sourceInstance:z.object({id:z.string().max(256),name:z.string().max(2000)})})
export const manifestSchema=z.object({kind:z.literal('codex-session-export'),packageVersion:z.literal(1),exportedAt:z.string().max(100),sessions:z.array(itemSchema).min(1).max(1000)})
export type SessionManifest=z.infer<typeof manifestSchema>
export type FileStamp=Pick<Stats,'dev'|'ino'|'size'|'mtimeMs'|'ctimeMs'>
export const sameStamp=(a:FileStamp,b:FileStamp)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
export const selectedPath=(path:string)=>join(realpathSync(dirname(resolve(path))),basename(path))

export class SessionZip {
  private constructor(readonly path:string,readonly stamp:FileStamp,readonly zip:yauzl.ZipFile,readonly fd:number,readonly entries:Map<string,yauzl.Entry>,readonly manifest:SessionManifest){}
  static async read(path:string,signal:AbortSignal,expected?:FileStamp):Promise<SessionZip>{
    signal.throwIfAborted();path=selectedPath(path)
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    let zip:yauzl.ZipFile|undefined
    try{
      const stamp=fstatSync(fd)
      if(!stamp.isFile()||stamp.nlink!==1||stamp.size>archiveMaxBytes+1024**3||!sameStamp(stamp,lstatSync(path))||expected&&!sameStamp(stamp,expected))throw new Error('会话包不是普通文件、体积过大或已在预览后变化')
      zip=await yauzl.fromFdPromise(fd,{autoClose:false,strictFileNames:true,validateEntrySizes:true})
      if(zip.entryCount>4001)throw new Error('会话包文件条目超过限制')
      const entries=new Map<string,yauzl.Entry>(),names=new Set<string>();let total=0
      for await(const entry of zip.eachEntry()){
        signal.throwIfAborted()
        const isDir=entry.fileName.endsWith('/'),name=isDir?entry.fileName.slice(0,-1):entry.fileName,type=(entry.externalFileAttributes>>>16)&0o170000
        if(!safeEntry(name)||names.has(name.toLowerCase())||entry.isEncrypted()||![0,8].includes(entry.compressionMethod)||type!==0&&type!==(isDir?0o040000:0o100000))throw new Error('会话包包含重复、加密、链接或不安全的文件条目')
        names.add(name.toLowerCase());total+=entry.uncompressedSize
        if(!Number.isSafeInteger(total)||total>archiveMaxBytes+manifestMaxBytes||entry.uncompressedSize>archiveMaxBytes||isDir&&entry.uncompressedSize!==0)throw new Error('会话包解压体积超过限制')
        if(!isDir)entries.set(name,entry)
      }
      const entry=entries.get('manifest.json')
      if(!entry||entry.uncompressedSize>manifestMaxBytes)throw new Error('会话包缺少清单或清单超过 8 MiB')
      const chunks:Buffer[]=[],stream=addAbortSignal(signal,await zip.openReadStreamPromise(entry));let bytes=0
      for await(const chunk of stream){bytes+=chunk.length;if(bytes>manifestMaxBytes)throw new Error('会话包清单超过 8 MiB');chunks.push(chunk)}
      const parsed=manifestSchema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))))
      if(!parsed.success)throw new Error('会话包清单格式或版本不受支持')
      const manifest=parsed.data,ids=new Set<string>(),used=new Set(['manifest.json']);let size=0
      for(const item of manifest.sessions){
        const file=entries.get(item.fileEntry)
        if(ids.has(item.sessionId)||used.has(item.fileEntry)||!file||file.uncompressedSize!==item.sizeBytes)throw new Error('会话包含重复会话、缺少文件或文件大小不匹配')
        ids.add(item.sessionId);used.add(item.fileEntry);size+=item.sizeBytes
      }
      if(size>archiveMaxBytes||used.size!==entries.size)throw new Error('会话包体积过大或包含清单以外的文件')
      const result=new SessionZip(path,stamp,zip,fd,entries,manifest);result.verify();return result
    }catch(error){if(zip)await closeZip(zip);else closeSync(fd);throw error}
  }
  verify():void{
    const stat=lstatSync(this.path)
    if(!stat.isFile()||stat.nlink!==1||!sameStamp(stat,this.stamp)||!sameStamp(fstatSync(this.fd),this.stamp))throw new Error('会话包在读取期间发生变化，请重新选择')
  }
  async extract(item:SessionManifest['sessions'][number],path:string,signal:AbortSignal,progress:(bytes:number)=>void):Promise<void>{
    this.verify();signal.throwIfAborted()
    const input=addAbortSignal(signal,await this.zip.openReadStreamPromise(this.entries.get(item.fileEntry)!)),digest=createHash('sha256')
    let size=0
    let output:FileHandle|undefined
    try{
      output=await open(path,'wx',0o600)
      for await(const chunk of input){signal.throwIfAborted();size+=chunk.length;if(size>item.sizeBytes)throw new Error('会话包文件解压超过清单大小');digest.update(chunk);await output.writeFile(chunk);progress(size)}
      if(size!==item.sizeBytes||digest.digest('hex')!==item.sha256.toLowerCase())throw new Error('会话文件 SHA256 校验失败，未写入目标目录')
      if(item.updatedAt!==null&&item.updatedAt!==undefined)await output.utimes(item.updatedAt,item.updatedAt)
      await output.sync();this.verify()
    }finally{input.destroy();await output?.close()}
  }
  close():Promise<void>{return closeZip(this.zip)}
}
function closeZip(zip:yauzl.ZipFile):Promise<void>{
  if(!zip.isOpen)return Promise.resolve()
  return new Promise((resolve,reject)=>{zip.once('close',resolve);zip.once('error',reject);zip.close()})
}

export async function* sourceBytes(source:SessionTransferSource,signal:AbortSignal,progress:(bytes:number)=>void,expectedHash?:string):AsyncGenerator<Buffer>{
  signal.throwIfAborted();await verifySource(source);const {file,stat}=await openSessionFile(source.root,source.path),hash=createHash('sha256');let offset=0
  try{
    while(offset<stat.size){signal.throwIfAborted();const buffer=Buffer.alloc(Math.min(256*1024,stat.size-offset)),{bytesRead}=await file.read(buffer,0,buffer.length,offset);if(!bytesRead)throw new Error('来源会话文件不完整');offset+=bytesRead;const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);progress(offset);yield chunk}
    await verifySource(source);if(expectedHash&&hash.digest('hex')!==expectedHash)throw new Error('会话内容在导出期间发生变化')
  }finally{await file.close()}
}
export async function hashSource(source:SessionTransferSource,signal:AbortSignal,progress:(bytes:number)=>void):Promise<string>{const hash=createHash('sha256');for await(const chunk of sourceBytes(source,signal,progress))hash.update(chunk);return hash.digest('hex')}

// Destination is selected in a native save dialog. Write alongside it and
// replace only after every source, hash and destination identity still matches.
export async function writeSessionZip(path:string,manifest:SessionManifest,sources:SessionTransferSource[],signal:AbortSignal,progress:(file:number,bytes:number)=>void):Promise<void>{
  await assertUnpagedSessionSources(sources,signal)
  path=selectedPath(path);const parent=lstatSync(dirname(path)),before=optionalStamp(path),temporary=path+'.'+randomUUID()+'.tmp'
  if(!path.toLowerCase().endsWith('.zip'))throw new Error('导出文件扩展名必须为 .zip')
  if(before&&(!before.isFile()||before.isSymbolicLink()||before.nlink!==1))throw new Error('不能覆盖链接或特殊文件')
  const text=Buffer.from(JSON.stringify(manifestSchema.parse(manifest),null,2)+'\n');if(text.length>manifestMaxBytes)throw new Error('会话清单超过 8 MiB，请分批导出')
  const file=await open(temporary,'wx',0o600),zip=new yazl.ZipFile(),output=zip.outputStream as Readable,inputs=new Set<Readable>()
  const abort=()=>{output.destroy(new Error('会话导出已取消'));for(const input of inputs)input.destroy(new Error('会话导出已取消'))}
  zip.on('error',error=>output.destroy(error));signal.addEventListener('abort',abort,{once:true})
  let base=0
  try{
    signal.throwIfAborted()
    // Keep sole ownership of the FileHandle so finish does not leave a stream
    // reference that makes FileHandle.close() wait forever.
    const sink=new Writable({write(chunk,_encoding,done){file.writeFile(chunk).then(()=>done(),done)}})
    const task=pipeline(output,sink,{signal})
    // Attach rejection immediately while adding entries synchronously.
    void task.catch(()=>{})
    zip.addBuffer(text,'manifest.json',{mode:0o100600})
    for(const [index,source] of sources.entries())zip.addReadStreamLazy(manifest.sessions[index].fileEntry,{size:source.size,mtime:new Date(source.mtime),mode:0o100600},callback=>{
      const input=Readable.from(sourceBytes(source,signal,bytes=>progress(index,base+bytes),manifest.sessions[index].sha256))
      // yazl deliberately leaves source-stream errors to its caller.
      input.on('error',error=>zip.emit('error',error))
      inputs.add(input);input.once('end',()=>{base+=source.size;progress(index+1,base)});callback(null,input)
    })
    zip.end();await task;signal.throwIfAborted()
    for(const source of sources)await verifySource(source)
    await file.sync()
    const current=optionalStamp(path),afterParent=lstatSync(dirname(path))
    if(realpathSync(dirname(path))!==dirname(path)||parent.dev!==afterParent.dev||parent.ino!==afterParent.ino||!!before!==!!current||before&&current&&!sameStamp(before,current))throw new Error('导出目标在写入期间发生变化，原文件已保留')
    signal.throwIfAborted();await rename(temporary,path)
  }finally{
    signal.removeEventListener('abort',abort);output.destroy();for(const input of inputs)input.destroy()
    await Promise.allSettled([...inputs].map(input=>finished(input)));await file.close();await rm(temporary,{force:true})
  }
}
function optionalStamp(path:string):Stats|undefined{try{return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}
export function importRelative(item:SessionManifest['sessions'][number]):string{
  if(sessionRelative(item.relativeRolloutPath))return item.relativeRolloutPath
  return 'sessions/rollout-'+item.sessionId+'.jsonl'
}
