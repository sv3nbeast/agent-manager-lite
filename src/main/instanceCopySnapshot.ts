// Capture saved history while another client can still append to its profile.
// SQLite uses a pinned read transaction; mutable JSONL uses independent APFS
// clones. Ordinary configuration and directory identities remain verified.
import {constants,existsSync,type Stats} from 'node:fs'
import {lstat,open,mkdir,chmod,realpath} from 'node:fs/promises'
import {dirname,basename,join,resolve,relative,isAbsolute,sep} from 'node:path'
import {spawn} from 'node:child_process'
import * as sqlite from 'node:sqlite'
import {scanInstanceHome,type CopyManifest,type CopyEntry} from './instanceCopy'
import {copiedProjectStateFile,copiedProjectStateLimit,projectCopiedProjectState} from './copiedProjectState'
import {atomic,readBounded} from './clientConfig'
import {excludedInstanceCopyTree} from './instanceCopyScope'

type Backup=(source:sqlite.DatabaseSync,path:string,options:{rate:number;progress:(info:{totalPages:number;remainingPages:number})=>void})=>Promise<number>
const onlineBackup=(sqlite as typeof sqlite&{backup:Backup}).backup
const sameIdentity=(entry:CopyEntry,stat:Stats)=>!stat.isSymbolicLink()&&entry.dev===stat.dev&&entry.ino===stat.ino&&entry.directory===stat.isDirectory()
const unchanged=(entry:CopyEntry,stat:Stats)=>sameIdentity(entry,stat)&&entry.size===stat.size&&entry.mtime===stat.mtimeMs&&entry.ctime===stat.ctimeMs&&entry.mode===stat.mode
const history=(path:string)=>/\.jsonl$/i.test(path)&&(['sessions','archived_sessions'].includes(path.split(sep)[0])||['history.jsonl','session_index.jsonl','transcription-history.jsonl'].includes(path.toLowerCase()))
const database=(path:string)=>/\.sqlite$/i.test(path)
async function directory(path:string,entry?:CopyEntry):Promise<void>{
  const stat=await lstat(path)
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path||entry&&!sameIdentity(entry,stat))throw new Error('复制来源目录已改变，请重新选择')
}
function snapshotBinary():string{
  const resources=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath
  return resources&&existsSync(join(resources,'app.asar'))?join(resources,'bin','codex-profile-snapshot'):resolve('resources/bin/codex-profile-snapshot')
}
async function cloneFile(sourceFd:number,parentFd:number,name:string,signal:AbortSignal):Promise<boolean>{
  signal.throwIfAborted()
  if(process.platform!=='darwin')return false
  const child=spawn(snapshotBinary(),[name],{stdio:['ignore','ignore','ignore',sourceFd,parentFd]})
  const cancel=()=>{child.kill('SIGTERM')}
  signal.addEventListener('abort',cancel,{once:true})
  if(signal.aborted)cancel()
  const timer=setTimeout(cancel,10_000)
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    signal.throwIfAborted()
    if(code===2)return false
    if(code!==0)throw new Error('无法创建独立文件快照，请检查磁盘空间和文件权限')
    return true
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel)}
}
// Only a partial final record is omitted; complete records and their original
// byte encodings are preserved. Stable non-JSON fixture/user files remain literal.
async function finishJsonl(path:string,signal:AbortSignal):Promise<number>{
  const file=await open(path,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const stat=await file.stat()
    if(!stat.size)return 0
    const chunk=Buffer.alloc(1024*1024);let position=stat.size,tail:Buffer[]=[],length=0
    while(position>0){
      signal.throwIfAborted()
      const size=Math.min(chunk.length,position);position-=size
      const {bytesRead}=await file.read(chunk,0,size,position)
      if(bytesRead!==size)throw new Error('会话快照不完整，未创建副本')
      const part=Buffer.from(chunk.subarray(0,size)),newline=part.lastIndexOf(10)
      if(newline>=0){
        const ending=Buffer.concat([part.subarray(newline+1),...tail])
        if(!ending.length)return stat.size
        try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(ending));return stat.size}catch{}
        const complete=position+newline+1
        await file.truncate(complete);return complete
      }
      tail.unshift(part);length+=size
      if(length>16*1024*1024)throw new Error('会话末尾记录超过快照范围，请等待当前写入完成后重试')
    }
    const raw=Buffer.concat(tail)
    try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));return stat.size}catch{}
    // A real rollout with no complete first record cannot become usable history.
    if(/^rollout-.*\.jsonl$/i.test(basename(path)))throw new Error('来源会话尚未保存完整元数据，请稍后重新复制')
    return stat.size
  }finally{await file.close()}
}
async function snapshotDatabase(source:string,target:string,entry:CopyEntry,signal:AbortSignal,onProgress:(bytes:number)=>void):Promise<void>{
  if(typeof onlineBackup!=='function')throw new Error('当前运行环境不支持会话数据库快照')
  await directory(dirname(source));await directory(dirname(target))
  try{await lstat(target);throw new Error('数据库快照目标已存在，未创建副本')}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  // SQLite opens by filename. Verify its identity and all companion paths before
  // and after opening, and never copy WAL/SHM bytes as independent files.
  for(const suffix of ['-wal','-shm','-journal']){
    try{const stat=await lstat(source+suffix);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('会话数据库附属文件类型不兼容')}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  let connection:sqlite.DatabaseSync|undefined,transaction=false
  try{
    const before=await lstat(source)
    if(!sameIdentity(entry,before)||!before.isFile()||before.nlink!==1)throw new Error('会话数据库来源已被替换')
    connection=new sqlite.DatabaseSync(source,{readOnly:true,allowExtension:false})
    connection.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    transaction=true;connection.prepare('SELECT rootpage FROM sqlite_schema LIMIT 1').get()
    await directory(dirname(source));await directory(dirname(target))
    if(!sameIdentity(entry,await lstat(source)))throw new Error('会话数据库来源已被替换')
    const pageSize=Number((connection.prepare('PRAGMA page_size').get() as {page_size:unknown}).page_size),deadline=Date.now()+30_000
    await onlineBackup(connection,target,{rate:128,progress:({totalPages,remainingPages})=>{
      signal.throwIfAborted();if(Date.now()>deadline)throw new Error('会话数据库快照超时，请稍后重试')
      onProgress((totalPages-remainingPages)*pageSize);signal.throwIfAborted()
    }})
    signal.throwIfAborted()
    if(!sameIdentity(entry,await lstat(source)))throw new Error('会话数据库来源已被替换')
    await chmod(target,0o600)
  }catch(error){
    signal.throwIfAborted()
    throw new Error('无法创建一致的会话数据库快照；来源未修改，未创建副本')
  }finally{if(transaction)try{connection?.exec('ROLLBACK')}catch{};connection?.close()}
}

// Reconcile only the staged index. Some clients store an alias for CODEX_HOME,
// and old deleted rollouts can remain indexed indefinitely. Resolve aliases to
// verified files inside the selected home; never copy an external session. New
// files committed between inventory and database backup must join the snapshot.
async function reconcileSnapshotIndex(path:string,root:string,entries:CopyEntry[],signal:AbortSignal):Promise<number>{
  const indexed=new Map(entries.map(entry=>[entry.relative,entry]))
  let bytes=entries.reduce((total,entry)=>total+(entry.directory?0:entry.size),0),omitted=0
  const capture=async(suffix:string):Promise<boolean>=>{
    if(!suffix||excludedInstanceCopyTree(suffix)||!history(suffix))throw new Error('会话索引引用了所选目录外或不可复制的会话，未创建副本')
    const parts=suffix.split(sep)
    if(parts.length>65)throw new Error('实例目录超过 64 层，未创建副本')
    for(let i=0;i<parts.length;i++){
      signal.throwIfAborted()
      const name=parts.slice(0,i).join(sep),folder=join(root,name)
      let stat:Stats
      try{stat=await lstat(folder)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
      await directory(folder,indexed.get(name))
      if(!indexed.has(name)){const entry={relative:name,directory:true,dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,mode:stat.mode};entries.push(entry);indexed.set(name,entry)}
    }
    let stat:Stats
    try{stat=await lstat(join(root,suffix))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
    const previous=indexed.get(suffix)
    if(!stat.isFile()||stat.isSymbolicLink()||previous&&!sameIdentity(previous,stat))throw new Error('会话索引来源文件已被替换，未创建副本')
    if(!previous){
      bytes+=stat.size
      if(bytes>100*1024**3||entries.length>=100_000)throw new Error('会话快照超过复制范围，未创建副本')
      const entry={relative:suffix,directory:false,dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,mode:stat.mode};entries.push(entry);indexed.set(suffix,entry)
    }
    return true
  }
  const inside=(suffix:string)=>suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix)
  const db=new sqlite.DatabaseSync(path,{allowExtension:false})
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000')
    const columns=db.prepare('PRAGMA table_info(threads)').all() as {name:string;pk:number}[]
    if(!columns.length)return 0
    if(!columns.some(column=>column.name==='id'&&column.pk)||!columns.some(column=>column.name==='rollout_path'))throw new Error('会话数据库格式不兼容，未创建副本')
    const first=db.prepare('SELECT id,rollout_path FROM threads ORDER BY id LIMIT 250'),next=db.prepare('SELECT id,rollout_path FROM threads WHERE id>? ORDER BY id LIMIT 250')
    const update=db.prepare('UPDATE threads SET rollout_path=? WHERE id=? AND rollout_path=?'),remove=db.prepare('DELETE FROM threads WHERE id=? AND rollout_path=?')
    db.exec('BEGIN IMMEDIATE')
    try{
      let cursor:string|undefined
      for(;;){
        signal.throwIfAborted()
        const rows=(cursor===undefined?first.all():next.all(cursor)) as {id:unknown;rollout_path:unknown}[]
        if(!rows.length)break
        for(const row of rows){
          if(typeof row.id!=='string'||row.rollout_path!==null&&typeof row.rollout_path!=='string')throw new Error('会话数据库格式不兼容，未创建副本')
          cursor=row.id
          if(!row.rollout_path)continue
          const stored=row.rollout_path as string
          let suffix=relative(root,isAbsolute(stored)?stored:join(root,stored)),alias=false
          if(!inside(suffix)){
            // Only an existing absolute alias that resolves back into this home
            // is accepted. The copy itself opens the canonical manifest path.
            if(!isAbsolute(stored))throw new Error('会话索引引用了所选目录外的会话，未创建副本')
            suffix=relative(root,await realpath(stored));alias=true
            if(!inside(suffix))throw new Error('会话索引引用了所选目录外的会话，未创建副本')
          }
          if(!await capture(suffix)){
            // A scanned file disappearing now is an active move, not a stale
            // index. Retry rather than silently discard saved history.
            if(indexed.has(suffix))throw new Error('来源会话正在移动，请稍后重新复制')
            remove.run(row.id,stored);omitted++;continue
          }
          if(alias)update.run(join(root,suffix),row.id,stored)
        }
      }
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');throw error}
  }finally{db.close()}
  return omitted
}

export async function copySavedInstanceHome(manifest:CopyManifest,target:string,signal:AbortSignal,onProgress:(files:number,bytes:number)=>void):Promise<CopyManifest&{omittedSessions:number}>{
  let files=0,bytes=0
  const entries=manifest.entries.map(entry=>({...entry})),created=new Set<string>()
  const createDirectories=async()=>{
    for(const entry of entries.filter(entry=>entry.directory)){
      signal.throwIfAborted();await directory(join(manifest.root,entry.relative),entry)
      if(created.has(entry.relative))continue
      await directory(dirname(join(target,entry.relative)))
      await mkdir(join(target,entry.relative),{mode:0o700});created.add(entry.relative)
    }
  }
  await createDirectories()
  // Freeze committed indexes before capturing rollouts. Later new threads are
  // outside this copy; all references in the pinned indexes must still resolve.
  let omittedSessions=0
  for(const entry of entries.filter(entry=>!entry.directory&&database(entry.relative))){
    signal.throwIfAborted()
    await snapshotDatabase(join(manifest.root,entry.relative),join(target,entry.relative),entry,signal,size=>onProgress(files,bytes+size))
    if(/^state_\d+\.sqlite$/i.test(basename(entry.relative)))omittedSessions+=await reconcileSnapshotIndex(join(target,entry.relative),manifest.root,entries,signal)
    const size=(await lstat(join(target,entry.relative))).size;files++;bytes+=size;onProgress(files,bytes)
  }
  await createDirectories()
  for(const entry of entries.filter(entry=>!entry.directory&&!database(entry.relative))){
    signal.throwIfAborted()
    const source=join(manifest.root,entry.relative),destination=join(target,entry.relative)
    await directory(dirname(source));await directory(dirname(destination))
    {
      const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      const parent=await open(dirname(destination),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
      try{
        const before=await input.stat(),projectState=entry.relative.toLowerCase()===copiedProjectStateFile,mutable=history(entry.relative)||projectState
        // Desktop project state is published by atomic replacement. Snapshot
        // the newly opened regular file, then validate/project its known fields.
        if(!before.isFile()||!projectState&&!sameIdentity(entry,before)||!mutable&&!unchanged(entry,before))throw new Error(`复制来源文件已改变（${entry.relative}），请重新选择`)
        const cloned=await cloneFile(input.fd,parent.fd,basename(destination),signal)
        if(!cloned){
          // Unsupported filesystems use the verified bounded copy. An active
          // writer still causes an explicit failure; no torn fallback snapshot.
          const opened={...entry,size:before.size,mtime:before.mtimeMs,ctime:before.ctimeMs}
          // Retain before/after checks around a bounded byte stream.
          const output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600|(entry.mode&0o111))
          try{
            const buffer=Buffer.alloc(1024*1024);let position=0
            while(position<before.size){signal.throwIfAborted();const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)throw new Error('来源文件不完整');let offset=0;while(offset<bytesRead){const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset);if(!bytesWritten)throw new Error('无法写入实例副本');offset+=bytesWritten};position+=bytesRead;onProgress(files,bytes+position)}
            if(!unchanged(opened,await input.stat()))throw new Error('当前磁盘不支持动态会话快照，请关闭使用来源目录的客户端与 CLI 后复制')
          }finally{await output.close()}
        }
        const named=await lstat(source)
        if(!named.isFile()||named.isSymbolicLink()||!projectState&&!sameIdentity(entry,named)||!mutable&&(!unchanged(entry,await input.stat())||!unchanged(entry,named)))throw new Error(`复制期间来源文件已变化（${entry.relative}），请重新选择`)
        await chmod(destination,0o600|(entry.mode&0o111))
        if(history(entry.relative))await finishJsonl(destination,signal)
        if(entry.relative.toLowerCase()===copiedProjectStateFile){
          const raw=readBounded(destination,copiedProjectStateLimit)
          if(raw===null)throw new Error('项目分组状态缺失')
          atomic(destination,JSON.stringify(projectCopiedProjectState(raw,{sourceHome:manifest.root,targetHome:manifest.root}),null,2)+'\n')
        }
      }finally{await parent.close();await input.close()}
    }
    const size=(await lstat(destination)).size;files++;bytes+=size;onProgress(files,bytes)
  }
  // Snapshot directories are immutable to the source. Metadata/path validation
  // operates on this finished copy, rather than comparing to later live writes.
  for(const entry of entries.filter(entry=>entry.directory))await directory(join(manifest.root,entry.relative),entry)
  const copied=await scanInstanceHome(target,signal)
  return {...copied,root:manifest.root,skipped:manifest.skipped,omittedSessions}
}
