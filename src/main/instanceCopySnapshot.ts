// Capture saved history while another client can still append to its profile.
// SQLite uses a pinned read transaction; mutable JSONL uses independent APFS
// clones. Ordinary configuration and directory identities remain verified.
import {constants,existsSync,type Stats} from 'node:fs'
import {lstat,open,mkdir,chmod,realpath,rename,rm,readdir,rmdir} from 'node:fs/promises'
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

const knownThreadTables=new Set(['thread_dynamic_tools','thread_attachments','guardian_review_feedback','thread_read_receipts'])
const historyTables=['thread_history_projection_state','thread_turns','thread_items','thread_realtime_items'] as const
const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"'
function userTables(db:sqlite.DatabaseSync):string[]{return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row=>row.name)}
function columns(db:sqlite.DatabaseSync,table:string):string[]{return (db.prepare('PRAGMA table_xinfo('+quoted(table)+')').all() as {name:string;hidden?:number}[]).filter(row=>!row.hidden).map(row=>row.name)}
function filterStateDatabase(path:string,selected:ReadonlySet<string>):void{
  const db=new sqlite.DatabaseSync(path,{allowExtension:false});let transaction=false
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000')
    const names=userTables(db);if(!names.includes('threads'))throw new Error('会话索引缺少 threads 表，无法按文件夹裁剪')
    const triggers=(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[]);if(triggers.length)throw new Error('会话索引包含未知触发器，无法安全裁剪')
    if(!columns(db,'threads').includes('id')||!columns(db,'threads').includes('rollout_path'))throw new Error('会话索引结构未知，无法按文件夹裁剪')
    const threadIds=db.prepare('SELECT id FROM threads').all() as {id:unknown}[]
    if(threadIds.some(row=>typeof row.id!=='string'))throw new Error('会话索引包含无效 ID，无法按文件夹裁剪')
    const allIds=new Set((db.prepare('SELECT id FROM threads').all() as {id:unknown}[]).flatMap(row=>typeof row.id==='string'?[row.id]:[])),removed=[...allIds].filter(id=>!selected.has(id))
    const known=new Set(['threads',...knownThreadTables,'thread_spawn_edges','projects','thread_sections','project_roots'])
    for(const name of names.filter(value=>!known.has(value))){
      const cols=columns(db,name),fks=db.prepare('PRAGMA foreign_key_list('+quoted(name)+')').all() as {table:string;from:string;to:string|null}[]
      if(fks.some(fk=>known.has(fk.table)))throw new Error('未知数据库表关联会话或项目数据，无法安全裁剪：'+name)
      const refsThread=fks.some(fk=>fk.table==='threads'&&(!fk.to||fk.to==='id'))
      const threadColumn=cols.find(value=>/thread/i.test(value))
      if(refsThread&&!threadColumn)throw new Error('未知数据库表引用 threads，无法安全裁剪：'+name)
      if(threadColumn){for(const id of removed)if(db.prepare('SELECT 1 FROM '+quoted(name)+' WHERE '+quoted(threadColumn)+'=? LIMIT 1').get(id))throw new Error('未知数据库表包含会话关联，无法安全裁剪：'+name)}
      else for(const column of cols.filter(value=>/(^|_)id$/i.test(value)))for(const id of removed)if(db.prepare('SELECT 1 FROM '+quoted(name)+' WHERE '+quoted(column)+'=? LIMIT 1').get(id))throw new Error('未知数据库表可能包含会话关联，无法安全裁剪：'+name)
    }
    db.exec('BEGIN IMMEDIATE');transaction=true
    for(const name of knownThreadTables)if(names.includes(name)){if(!columns(db,name).includes('thread_id'))throw new Error('会话关联表结构未知：'+name);for(const id of removed)db.prepare('DELETE FROM '+quoted(name)+' WHERE thread_id=?').run(id)}
    if(names.includes('thread_spawn_edges')){const cols=columns(db,'thread_spawn_edges');if(!cols.includes('parent_thread_id')||!cols.includes('child_thread_id'))throw new Error('子会话关联表结构未知，无法安全裁剪');for(const id of removed)db.prepare('DELETE FROM thread_spawn_edges WHERE parent_thread_id=? OR child_thread_id=?').run(id,id)}
    for(const id of removed)db.prepare('DELETE FROM threads WHERE id=?').run(id)
    db.exec('COMMIT');transaction=false
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('会话索引裁剪后的外键检查失败')
  }catch(error){if(transaction)try{db.exec('ROLLBACK')}catch{};throw error}finally{db.close()}
}
function filterHistoryDatabase(path:string,selected:ReadonlySet<string>):void{
  const db=new sqlite.DatabaseSync(path,{allowExtension:false});let transaction=false
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000')
    const names=userTables(db);if(!names.length)return
    if(names.length!==historyTables.length||historyTables.some(name=>!names.includes(name))){
      // Legacy / future projection schemas can remain untouched when every
      // row already belongs to a selected thread. If any unknown table has a
      // missing or excluded thread identity, fail closed instead of carrying
      // hidden conversation data across a partial folder selection.
      for(const name of names){
        const threadColumn=columns(db,name).find(column=>column==='thread_id')
        if(!threadColumn){if(db.prepare('SELECT 1 FROM '+quoted(name)+' LIMIT 1').get())throw new Error('Codex 历史投影包含未知表，无法安全裁剪');continue}
        const ids=db.prepare('SELECT DISTINCT '+quoted(threadColumn)+' AS thread_id FROM '+quoted(name)).all() as {thread_id:unknown}[]
        if(ids.some(row=>typeof row.thread_id!=='string'||!selected.has(row.thread_id)))throw new Error('Codex 历史投影包含未选会话或未知表，无法安全裁剪')
      }
      return
    }
    for(const name of historyTables)if(!columns(db,name).includes('thread_id'))throw new Error('Codex 历史投影结构未知，无法安全裁剪')
    const triggers=(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[]);if(triggers.length)throw new Error('Codex 历史投影包含未知触发器，无法安全裁剪')
    const definitions=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as {name:string;sql:string|null}[]
    if(definitions.some(row=>historyTables.includes(row.name as typeof historyTables[number])&&!/thread_id/i.test(row.sql??'')))throw new Error('Codex 历史投影关联结构未知，无法安全裁剪')
    db.exec('BEGIN IMMEDIATE');transaction=true
    for(const name of historyTables){const ids=(db.prepare('SELECT DISTINCT thread_id FROM '+quoted(name)).all() as {thread_id:unknown}[]).flatMap(row=>typeof row.thread_id==='string'&&!selected.has(row.thread_id)?[row.thread_id]:[]);for(const id of ids)db.prepare('DELETE FROM '+quoted(name)+' WHERE thread_id=?').run(id)}
    db.exec('COMMIT');transaction=false
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Codex 历史投影裁剪后的外键检查失败')
  }catch(error){if(transaction)try{db.exec('ROLLBACK')}catch{};throw error}finally{db.close()}
}
/** Prune unselected conversation bodies and indexes in the private staging copy. */
export async function filterSessionSnapshot(home:string,selected:ReadonlySet<string>,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted()
  const files:string[]=[],selectedSessionCwds=new Map<string,string|undefined>()
  const walk=async(folder:string)=>{for(const entry of await readdir(folder,{withFileTypes:true})){signal.throwIfAborted();const path=join(folder,entry.name);if(entry.isSymbolicLink())throw new Error('会话快照包含链接，无法按文件夹过滤');if(entry.isDirectory())await walk(path);else if(entry.isFile()&&/\.jsonl$/i.test(entry.name))files.push(path)}}
  for(const folder of ['sessions','archived_sessions'])try{await walk(join(home,folder))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  for(const path of files){signal.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let currentId:string|undefined
    let cwd:string|undefined
    try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1)throw new Error('会话 JSONL 不是独立普通文件');const header=Buffer.alloc(32*1024);let offset=0
      while(offset<header.length){const read=await file.read(header,offset,header.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;const newline=header.indexOf(10,0);if(newline>=0){let record:unknown;try{record=JSON.parse(header.subarray(0,newline).toString('utf8'))}catch{throw new Error('会话 JSONL 首行格式未知，无法按 ID 过滤')}const value=record&&typeof record==='object'?record as {type?:unknown;payload?:{id?:unknown;session_id?:unknown;cwd?:unknown}}:undefined;if(value?.type!=='session_meta')throw new Error('会话 JSONL 首行不是会话元数据，无法按文件夹过滤');const id=value.payload?.id??value.payload?.session_id;if(typeof id!=='string'||!id)throw new Error('会话 JSONL 缺少 ID，无法按文件夹过滤');currentId=id;cwd=typeof value.payload?.cwd==='string'?value.payload.cwd:undefined;break}}
      if(!currentId)throw new Error('会话 JSONL 元数据超过 32 KiB 或缺失，无法按文件夹过滤');const after=await file.stat();if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw new Error('会话 JSONL 在筛选期间发生变化')
    }finally{await file.close()}
    if(selected.has(currentId)){
      if(selectedSessionCwds.has(currentId)&&selectedSessionCwds.get(currentId)!==cwd)throw new Error('同一会话 ID 的多个文件版本属于不同工作目录，无法按文件夹安全复制；请先在会话管理中核对冲突')
      selectedSessionCwds.set(currentId,cwd)
    }else await rm(path,{force:true})
  }
  for(const name of ['session_index.jsonl','history.jsonl','transcription-history.jsonl']){const path=join(home,name),raw=readBounded(path,64*1024*1024);if(raw===null)continue;const kept:string[]=[];for(const line of raw.split(/\r?\n/)){if(!line)continue;let row:Record<string,unknown>;try{row=JSON.parse(line)}catch{throw new Error('会话索引 JSONL 格式未知，无法按 ID 过滤')}const id=row.id??row.session_id;if(typeof id!=='string')throw new Error('会话索引 JSONL 缺少会话 ID，无法安全过滤');if(selected.has(id))kept.push(line)}atomic(path,kept.join('\n')+(kept.length?'\n':''))}
  for(const entry of (await readdir(home,{withFileTypes:true})).filter(item=>item.isFile()&&/^state_\d+\.sqlite$/i.test(item.name)))filterStateDatabase(join(home,entry.name),selected)
  for(const entry of (await readdir(home,{withFileTypes:true})).filter(item=>item.isFile()&&/^thread_history_\d+\.sqlite$/i.test(item.name)))filterHistoryDatabase(join(home,entry.name),selected)
  const statePath=join(home,copiedProjectStateFile),state=readBounded(statePath,copiedProjectStateLimit)
  if(state!==null)atomic(statePath,JSON.stringify(projectCopiedProjectState(state,{threadIds:selected}),null,2)+'\n')
}

/**
 * Codex resolves its default SQLite home relative to CODEX_HOME.  A source
 * profile may have used an internal `sqlite_home` (or an older `sqlite/`
 * layout); carrying that directory into a session-only copy without its
 * configuration makes a freshly restarted client open an empty database.
 * Normalize the copied snapshot to the canonical root so the generated
 * instance configuration can remain disposable and the same history is used
 * on every launch.  This only touches the new staging directory.
 */
export async function normalizeSessionDatabaseCopy(home:string,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted()
  const isSessionDatabase=(name:string):boolean=>/^(?:state|thread_history)_\d+\.sqlite$/i.test(name)
  const rootFiles=(await readdir(home,{withFileTypes:true})).filter(entry=>entry.isFile()&&isSessionDatabase(entry.name)).map(entry=>entry.name).sort()
  const nested:string[]=[]
  const walk=async(folder:string,depth:number):Promise<void>=>{
    signal.throwIfAborted();if(depth>8)return
    for(const entry of await readdir(folder,{withFileTypes:true})){
      signal.throwIfAborted();const path=join(folder,entry.name)
      if(entry.isDirectory())await walk(path,depth+1)
      else if(folder!==home&&entry.isFile()&&isSessionDatabase(entry.name))nested.push(path)
    }
  }
  await walk(home,0)
  if(rootFiles.length && nested.length)throw new Error('会话数据库存在多个内部副本，未创建副本')
  if(rootFiles.length)return
  // There must be one selected database directory in a session-only manifest.
  // Refuse to merge competing layouts; doing so would silently pair a stale
  // state index with a different thread-history projection.
  if(new Set(nested.map(source=>dirname(source))).size>1)throw new Error('会话数据库存在多个内部副本，未创建副本')
  const names=new Set<string>()
  for(const source of nested){
    const name=basename(source)
    if(names.has(name))throw new Error('会话数据库存在重复文件，未创建副本')
    names.add(name)
    const target=join(home,name)
    await lstat(source)
    await rename(source,target)
  }
  // Each directory is visited once even when it held both state and projection
  // files. Otherwise the second rmdir would reject an already removed folder.
  const removed=new Set<string>()
  for(const source of nested){
    let folder=dirname(source)
    while(folder!==home){
      signal.throwIfAborted()
      if(removed.has(folder)){folder=dirname(folder);continue}
      try{await rmdir(folder);removed.add(folder);folder=dirname(folder)}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOTEMPTY')break;throw error}
    }
  }
}
