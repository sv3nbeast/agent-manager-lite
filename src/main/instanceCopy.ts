// Codex profile copy adapted from Cockpit instance_store::copy_dir_recursive.
// Copy regular files, report skipped links/sockets, and keep file auth isolated.
import {constants,type Stats} from 'node:fs'
import {lstat,open,opendir,realpath,mkdir} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {isAbsolute,relative,sep} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {homedir} from 'node:os'
import {atomic,readBounded} from './clientConfig'
import {TomlDocument,patchToml,scalarRaw,type TomlEdit} from './tomlPatch'

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
      const output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600|(entry.mode&0o111))
      try{
        let copied=0
        while(copied<entry.size){
          signal.throwIfAborted()
          const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,entry.size-copied),copied)
          if(!bytesRead)throw new Error('复制来源文件不完整，请重新复制')
          let offset=0
          while(offset<bytesRead){signal.throwIfAborted();const {bytesWritten}=await output.write(buffer,offset,bytesRead-offset);if(!bytesWritten)throw new Error('无法写入实例副本');offset+=bytesWritten}
          copied+=bytesRead;bytes+=bytesRead;onProgress(files,bytes)
        }
        if(!matches(entry,await input.stat())||!matches(entry,await lstat(source)))throw new Error(`复制期间来源文件已变化（${entry.relative}），请重新复制`)
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
export async function relocateCopiedProfile(manifest:CopyManifest,stagedHome:string,finalHome:string,signal:AbortSignal):Promise<void>{
  const copied=new Set(manifest.entries.map(entry=>entry.relative))
  const localPath=(value:string,requireCopied=false):string|undefined=>{
    if(!isAbsolute(value))return undefined
    const suffix=relative(manifest.root,value)
    if(suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))return undefined
    if(requireCopied&&!copied.has(suffix))throw new Error('会话索引引用了未复制的来源文件，未创建副本')
    return join(finalHome,suffix)
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
      if(!columns.length)continue
      if(!columns.some(column=>column.name==='id'&&column.pk)||!columns.some(column=>column.name==='rollout_path'))throw new Error('Unknown thread schema')
      const first=db.prepare('SELECT id, rollout_path FROM threads ORDER BY id LIMIT 250')
      const next=db.prepare('SELECT id, rollout_path FROM threads WHERE id > ? ORDER BY id LIMIT 250')
      const update=db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
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
              if(relocated)update.run(relocated,row.id,row.rollout_path)
              else{
                // Relative session paths remain relative, but external absolute
                // references cannot become shared writable session files.
                const suffix=relative(manifest.root,join(manifest.root,row.rollout_path))
                if(isAbsolute(row.rollout_path)||!copied.has(suffix))throw new Error('Session outside copied profile')
              }
            }
            cursor=row.id
          }
          await setImmediate()
        }
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
    }catch(error){
      signal.throwIfAborted()
      throw new Error('会话数据库无法迁移，或索引引用了来源目录外的会话；来源未修改，未创建副本')
    }finally{db?.close()}
  }
}
