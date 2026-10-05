// Codex profile copy adapted from Cockpit instance_store::copy_dir_recursive.
// Copy regular files, report skipped links/sockets, and keep file auth isolated.
import {constants,type Stats} from 'node:fs'
import {lstat,open,opendir,realpath,mkdir,rename,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {isAbsolute,relative,sep} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {homedir} from 'node:os'
import {atomic,readBounded} from './clientConfig'
import {TomlDocument,patchToml,scalarRaw,type TomlEdit} from './tomlPatch'
import {copiedProjectStateFile,copiedProjectStateLimit,projectCopiedProjectState} from './copiedProjectState'

interface Entry {relative:string;directory:boolean;dev:number;ino:number;size:number;mtime:number;ctime:number;mode:number}
export interface CopyManifest {root:string;entries:Entry[];files:number;bytes:number;skipped:number;digest:string}
const signature=(relative:string,stat:Stats):Entry=>({relative,directory:stat.isDirectory(),dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,mode:stat.mode})
const matches=(entry:Entry,stat:Stats)=>JSON.stringify(signature(entry.relative,stat))===JSON.stringify(entry)
async function checkedDirectory(path:string):Promise<Stats>{
  const stat=await lstat(path)
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path)throw new Error('复制来源目录已改变，请重新复制')
  return stat
}
export async function scanInstanceHome(root:string,signal:AbortSignal):Promise<CopyManifest>{
  const entries:Entry[]=[],skippedEntries:Entry[]=[]
  let files=0,bytes=0,skipped=0,count=0
  async function walk(relative:string,depth:number):Promise<void>{
    signal.throwIfAborted()
    if(depth>64)throw new Error('实例目录超过 64 层，未创建副本')
    const folder=join(root,relative),before=await checkedDirectory(folder)
    entries.push(signature(relative,before))
    const names:string[]=[]
    for await(const entry of await opendir(folder)){
      signal.throwIfAborted();if(++count>100_000)throw new Error('实例目录超过 10 万项，未创建副本')
      names.push(entry.name)
    }
    for(const name of names.sort()){
      signal.throwIfAborted()
      const child=join(relative,name),stat=await lstat(join(root,child))
      // A second copy of a refresh-token chain must never become a login owner.
      // Live daemon state is regenerated; do not carry stale PID/control files.
      if(!relative&&['auth.json','app-server-control'].includes(name.toLowerCase())||!stat.isFile()&&!stat.isDirectory()){
        skipped++;skippedEntries.push(signature(child,stat));continue
      }
      if(stat.isDirectory())await walk(child,depth+1)
      else{
        files++;bytes+=stat.size
        if(bytes>100*1024**3)throw new Error('实例文件超过 100 GiB，未创建副本')
        entries.push(signature(child,stat))
      }
    }
    if(!matches(signature(relative,before),await checkedDirectory(folder)))throw new Error('复制来源目录正在变化，请停止使用后重试')
  }
  await walk('',0)
  return {root,entries,files,bytes,skipped,digest:createHash('sha256').update(JSON.stringify([entries,skippedEntries])).digest('hex')}
}
export async function copyInstanceHome(manifest:CopyManifest,target:string,signal:AbortSignal,onProgress:(files:number,bytes:number)=>void):Promise<void>{
  let files=0,bytes=0
  const buffer=Buffer.alloc(1024*1024),directories=manifest.entries.filter(entry=>entry.directory)
  for(const entry of manifest.entries){
    signal.throwIfAborted()
    const source=join(manifest.root,entry.relative),destination=join(target,entry.relative)
    await checkedDirectory(entry.relative?dirname(source):manifest.root)
    await checkedDirectory(dirname(destination))
    if(entry.directory){
      if(!matches(entry,await checkedDirectory(source)))throw new Error('复制来源目录已改变，请重新复制')
      await mkdir(destination,{mode:0o700});continue
    }
    const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{
      if(!matches(entry,await input.stat()))throw new Error(`复制来源文件已改变（${entry.relative}），请重新复制`)
      const projectState=entry.relative.toLowerCase()===copiedProjectStateFile
      if(projectState&&entry.size>copiedProjectStateLimit)throw new Error('来源项目分组状态超过 16 MiB，未创建副本')
      const projectBuffer=projectState?Buffer.alloc(entry.size):undefined
      const output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600|(entry.mode&0o111))
      try{
        let copied=0
        while(copied<entry.size){
          signal.throwIfAborted()
          const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,entry.size-copied),copied)
          if(!bytesRead)throw new Error('复制来源文件不完整，请重新复制')
          if(projectBuffer)buffer.copy(projectBuffer,copied,0,bytesRead)
          else{
            let offset=0
            while(offset<bytesRead){signal.throwIfAborted();const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset);if(!bytesWritten)throw new Error('无法写入实例副本');offset+=bytesWritten}
          }
          copied+=bytesRead;bytes+=bytesRead;onProgress(files,bytes)
        }
        if(!matches(entry,await input.stat())||!matches(entry,await lstat(source)))throw new Error(`复制期间来源文件已变化（${entry.relative}），请重新复制`)
        if(projectBuffer){
          signal.throwIfAborted()
          const raw=new TextDecoder('utf-8',{fatal:true}).decode(projectBuffer)
          const projection=Buffer.from(JSON.stringify(projectCopiedProjectState(raw,{sourceHome:manifest.root,targetHome:manifest.root}),null,2)+'\n')
          let offset=0
          while(offset<projection.length){signal.throwIfAborted();const {bytesWritten}=await output.write(projection,offset,projection.length-offset);if(!bytesWritten)throw new Error('无法写入项目分组状态');offset+=bytesWritten}
        }
        await output.utimes(new Date(entry.mtime),new Date(entry.mtime))
      }finally{await output.close()}
    }finally{await input.close()}
    files++;onProgress(files,bytes)
  }
  for(const entry of directories)if(!matches(entry,await checkedDirectory(join(manifest.root,entry.relative))))throw new Error('复制期间来源目录已变化，请重新复制')
  const after=await scanInstanceHome(manifest.root,signal)
  if(after.digest!==manifest.digest)throw new Error('复制期间来源内容已变化，未创建副本')
}

// A raw directory copy leaves absolute rollout/model-catalog references pointing
// at the source. Only recognized local references are relocated; conversation
// text and external project working directories remain literal content.
export async function relocateCopiedProfile(manifest:CopyManifest,stagedHome:string,finalHome:string,signal:AbortSignal,targetProvider?:string):Promise<void>{
  if(targetProvider!==undefined&&(!targetProvider||targetProvider.length>200||/[\r\n\0]/.test(targetProvider)))throw new Error('副本会话 Provider 无效，未创建副本')
  const copied=new Set(manifest.entries.map(entry=>entry.relative))
  const rollouts=new Map<string,boolean>()
  if(targetProvider!==undefined)for(const entry of manifest.entries){
    const parts=entry.relative.split(sep)
    if(!entry.directory&&['sessions','archived_sessions'].includes(parts[0])&&/\.jsonl$/i.test(parts.at(-1)!))rollouts.set(entry.relative,/^rollout-.*\.jsonl$/i.test(parts.at(-1)!))
  }
  const localPath=(value:string,requireCopied=false):string|undefined=>{
    if(!isAbsolute(value))return undefined
    const suffix=relative(manifest.root,value)
    if(suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))return undefined
    if(requireCopied&&!copied.has(suffix))throw new Error('会话索引引用了未复制的来源文件，未创建副本')
    return join(finalHome,suffix)
  }
  const projectStateEntry=manifest.entries.find(entry=>!entry.directory&&entry.relative.toLowerCase()===copiedProjectStateFile)
  if(projectStateEntry){
    signal.throwIfAborted()
    const path=join(stagedHome,projectStateEntry.relative),raw=readBounded(path,copiedProjectStateLimit)
    if(raw===null)throw new Error('副本项目分组状态缺失，未创建副本')
    atomic(path,JSON.stringify(projectCopiedProjectState(raw,{sourceHome:manifest.root,targetHome:finalHome}),null,2)+'\n')
  }
  // Current Codex uses sibling <name>.config.toml layers. They must not retain
  // writable references into the original home when the profile is copied.
  const configs=manifest.entries.filter(entry=>!entry.directory&&!entry.relative.includes(sep)&&/^(?:config|[A-Za-z0-9_-]+\.config)\.toml$/i.test(entry.relative))
  for(const entry of configs){
    signal.throwIfAborted()
    const configPath=join(stagedHome,entry.relative),config=readBounded(configPath,1024*1024)
    if(config===null)throw new Error('副本配置文件缺失，未创建副本')
    const doc=new TomlDocument(config),edits:TomlEdit[]=[]
    const scopes=[[],...doc.children(['profiles']).map(name=>['profiles',name])]
    for(const scope of scopes)for(const key of ['model_catalog_json','sqlite_home','log_dir']){
      const path=[...scope,key],value=doc.scalar(path)
      if(typeof value==='string'){
        const expanded=value.startsWith('~/')?join(homedir(),value.slice(2)):value
        const next=localPath(expanded)
        const suffix=relative(manifest.root,join(manifest.root,expanded))
        if(key==='sqlite_home'&&!next&&(isAbsolute(expanded)||suffix==='..'||suffix.startsWith('..'+sep)))throw new Error('来源使用了目录外的会话数据库，请先将会话库迁入实例目录后复制')
        if(next)edits.push({path,raw:scalarRaw(next)})
      }
    }
    if(edits.length)atomic(configPath,patchToml(config,edits))
  }
  const databases=manifest.entries.filter(entry=>!entry.directory&&/^state_\d+\.sqlite$/i.test(entry.relative.split(sep).at(-1)!))
  for(const entry of databases){
    signal.throwIfAborted()
    let db:DatabaseSync|undefined
    try{
      db=new DatabaseSync(join(stagedHome,entry.relative),{allowExtension:false})
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000')
      const columns=db.prepare('PRAGMA table_info(threads)').all() as {name:string;pk:number}[]
      if(!columns.length&&targetProvider===undefined)continue
      if(!columns.some(column=>column.name==='id'&&column.pk)||!columns.some(column=>column.name==='rollout_path')||targetProvider!==undefined&&!columns.some(column=>column.name==='model_provider'))throw new Error('Unknown thread schema')
      const first=db.prepare('SELECT id, rollout_path FROM threads ORDER BY id LIMIT 250')
      const next=db.prepare('SELECT id, rollout_path FROM threads WHERE id > ? ORDER BY id LIMIT 250')
      const update=db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      const providerUpdate=targetProvider===undefined?undefined:db.prepare('UPDATE threads SET model_provider = ? WHERE id = ?')
      db.exec('BEGIN IMMEDIATE')
      try{
        let cursor:string|undefined
        for(;;){
          signal.throwIfAborted()
          const rows=(cursor===undefined?first.all():next.all(cursor)) as {id:unknown;rollout_path:unknown}[]
          if(!rows.length)break
          for(const row of rows){
            if(typeof row.id!=='string'||row.rollout_path!==null&&typeof row.rollout_path!=='string')throw new Error('Invalid thread schema')
            if(typeof row.rollout_path==='string'&&row.rollout_path){
              const relocated=localPath(row.rollout_path,true)
              if(relocated){
                update.run(relocated,row.id,row.rollout_path)
                if(targetProvider!==undefined)rollouts.set(relative(manifest.root,row.rollout_path),true)
              }
              else{
                // Relative session paths remain relative, but external absolute
                // references cannot become shared writable session files.
                const suffix=relative(manifest.root,join(manifest.root,row.rollout_path))
                if(isAbsolute(row.rollout_path)||!copied.has(suffix))throw new Error('Session outside copied profile')
                if(targetProvider!==undefined)rollouts.set(suffix,true)
              }
            }
            if(providerUpdate)providerUpdate.run(targetProvider!,row.id)
            cursor=row.id
          }
          await setImmediate()
        }
        await relocateCopiedProjectRoots(db,localPath,signal)
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
    }catch(error){
      signal.throwIfAborted()
      throw new Error('会话数据库无法迁移，或索引引用了来源目录外的会话；来源未修改，未创建副本')
    }finally{db?.close()}
  }
  if(targetProvider!==undefined)for(const [path,required]of rollouts){
    signal.throwIfAborted()
    await relocateRolloutProvider(join(stagedHome,path),targetProvider,signal,required)
  }
}

// Project paths in the official SQLite store must agree with the copied desktop
// project state. The project UUIDs and root ordering remain unchanged.
async function relocateCopiedProjectRoots(db:DatabaseSync,localPath:(value:string)=>string|undefined,signal:AbortSignal):Promise<void>{
  const columns=db.prepare('PRAGMA table_info(project_roots)').all() as {name:string;pk:number}[]
  if(!columns.length)return
  const primary=columns.filter(column=>column.pk).map(column=>column.name)
  if(!['project_id','position','path'].every(key=>columns.some(column=>column.name===key))||primary.length!==2||!['project_id','position'].every(key=>primary.includes(key)))throw new Error('Unknown project root schema')
  const first=db.prepare('SELECT project_id, position, path FROM project_roots ORDER BY project_id, position LIMIT 250')
  const next=db.prepare('SELECT project_id, position, path FROM project_roots WHERE project_id > ? OR (project_id = ? AND position > ?) ORDER BY project_id, position LIMIT 250')
  const update=db.prepare('UPDATE project_roots SET path = ? WHERE project_id = ? AND position = ? AND path = ?')
  let cursor:{id:string;position:number}|undefined
  for(;;){
    signal.throwIfAborted()
    const rows=(cursor?next.all(cursor.id,cursor.id,cursor.position):first.all()) as {project_id:unknown;position:unknown;path:unknown}[]
    if(!rows.length)break
    for(const row of rows){
      if(typeof row.project_id!=='string'||typeof row.position!=='number'||!Number.isSafeInteger(row.position)||typeof row.path!=='string')throw new Error('Invalid project root schema')
      const relocated=localPath(row.path)
      if(relocated)update.run(relocated,row.project_id,row.position,row.path)
      cursor={id:row.project_id,position:row.position}
    }
    await setImmediate()
  }
}

// Match the session-visibility repair's first session_meta record, but stream the
// remaining conversation verbatim. Only staged copies are passed to this helper;
// it never opens rollout references in the source or outside the copied manifest.
async function relocateRolloutProvider(path:string,provider:string,signal:AbortSignal,required:boolean):Promise<void>{
  await checkedDirectory(dirname(path));signal.throwIfAborted()
  const input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  const temporary=join(dirname(path),`.copy-session-${randomUUID()}`)
  let output:Awaited<ReturnType<typeof open>>|undefined
  try{
    const before=await input.stat()
    if(!before.isFile()||before.nlink!==1)throw new Error('会话文件类型不兼容，未创建副本')
    const buffer=Buffer.alloc(1024*1024)
    let prefix=Buffer.alloc(0),position=0,inspected=0,meta:{value:Record<string,unknown>;start:number;end:number;ending:string}|undefined
    for(;;){
      signal.throwIfAborted()
      const {bytesRead}=await input.read(buffer,0,buffer.length,position);position+=bytesRead
      if(bytesRead)prefix=Buffer.concat([prefix,buffer.subarray(0,bytesRead)])
      while(inspected<prefix.length){
        const newline=prefix.indexOf(10,inspected),end=newline<0?prefix.length:newline+1
        if(newline<0&&bytesRead)break
        const segment=prefix.subarray(inspected,end),ending=segment.at(-1)===10?(segment.at(-2)===13?'\r\n':'\n'):''
        let value:unknown
        try{value=JSON.parse(segment.subarray(0,segment.length-ending.length).toString('utf8').replace(/^\uFEFF/,''))}catch{}
        if(value&&typeof value==='object'&&!Array.isArray(value)&&(value as Record<string,unknown>).type==='session_meta'){
          const record=value as Record<string,unknown>,payload=record.payload
          if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('会话元数据格式不兼容，未创建副本')
          meta={value:record,start:inspected,end,ending};break
        }
        inspected=end
      }
      if(meta||!bytesRead)break
      if(prefix.length>=8*1024*1024)throw new Error('会话元数据超过可迁移范围，未创建副本')
    }
    if(!meta){if(required)throw new Error('会话缺少可识别的元数据，未创建副本');return}
    const payload=meta.value.payload as Record<string,unknown>
    if(payload.model_provider===provider)return
    payload.model_provider=provider
    output=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    const write=async(content:Buffer)=>{
      let offset=0
      while(offset<content.length){signal.throwIfAborted();const {bytesWritten}=await output!.write(content,offset,content.length-offset);if(!bytesWritten)throw new Error('无法写入会话元数据');offset+=bytesWritten}
    }
    await write(prefix.subarray(0,meta.start));await write(Buffer.from(JSON.stringify(meta.value)+meta.ending));await write(prefix.subarray(meta.end))
    for(;;){
      signal.throwIfAborted()
      const {bytesRead}=await input.read(buffer,0,buffer.length,position)
      if(!bytesRead)break
      position+=bytesRead;await write(buffer.subarray(0,bytesRead))
    }
    if(!matches(signature('',before),await input.stat())||!matches(signature('',before),await lstat(path)))throw new Error('副本会话文件已变化，未创建副本')
    await output.utimes(before.atime,before.mtime);await output.close();output=undefined
    signal.throwIfAborted();await rename(temporary,path)
  }finally{await output?.close();await input.close();await rm(temporary,{force:true})}
}
