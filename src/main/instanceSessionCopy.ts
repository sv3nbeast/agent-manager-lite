// A session-only copy intentionally selects the small, portable history set
// instead of walking the complete CODEX_HOME.  Client configuration, auth,
// skills, caches and desktop state are regenerated for the new instance.
import {type Stats} from 'node:fs'
import {lstat,opendir,readdir,realpath} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname,join,relative,resolve,sep,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {readBounded} from './clientConfig'
import {configuredSessionDatabaseHome} from './sessionDatabase'
import {excludedInstanceCopyTree} from './instanceCopyScope'
import type {CopyEntry,CopyManifest} from './instanceCopy'

const signature=(relativePath:string,stat:Stats):CopyEntry=>({relative:relativePath,directory:stat.isDirectory(),dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,mode:stat.mode})
const inside=(root:string,path:string)=>{const part=relative(root,path);return part!== '..'&&!part.startsWith('..'+sep)&&!isAbsolute(part)}
const regularFile=(stat:Stats)=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1
const regularDirectory=(stat:Stats)=>stat.isDirectory()&&!stat.isSymbolicLink()
// The thread index and its paginated history projection are a pair.  Copying
// only state_*.sqlite leaves the UI with a tiny/recent subset after restart,
// even though the JSONL rollout files are present.  Keep unrelated SQLite
// stores (logs, queue, memories, etc.) out of a session-only copy.
const sessionDatabaseName=(name:string):boolean=>/^(?:state|thread_history)_\d+\.sqlite$/i.test(name)

async function checkedDirectory(path:string):Promise<Stats>{
  const stat=await lstat(path)
  if(!regularDirectory(stat)||await realpath(path)!==path)throw new Error('复制来源目录已改变，请重新复制')
  return stat
}

/**
 * Select only Codex history.  The SQLite database is required for current
 * clients to retain project assignment and archived-thread metadata; JSONL is
 * retained as the conversation body.  All other files are deliberately absent
 * from the manifest, so a 9 GiB profile never becomes a 9 GiB copy operation.
 */
export async function scanSessionHome(root:string,signal:AbortSignal):Promise<CopyManifest>{
  const canonical=resolve(root)
  await checkedDirectory(canonical)
  const entries:CopyEntry[]=[]
  const seen=new Set<string>()
  let files=0,bytes=0,count=0
  const addDirectory=async(relativePath:string):Promise<void>=>{
    const normalized=relativePath.replaceAll('/',sep)
    if(seen.has(normalized))return
    const stat=await checkedDirectory(join(canonical,normalized))
    seen.add(normalized);entries.push(signature(normalized,stat))
  }
  const addParents=async(relativePath:string):Promise<void>=>{
    const parts=relativePath?relativePath.split(sep):[]
    for(let index=0;index<parts.length;index++)await addDirectory(parts.slice(0,index+1).join(sep))
  }
  const addFile=async(relativePath:string):Promise<void>=>{
    signal.throwIfAborted()
    const normalized=relativePath.replaceAll('/',sep)
    if(!normalized||excludedInstanceCopyTree(normalized)||seen.has(normalized))return
    const path=join(canonical,normalized),stat=await lstat(path)
    if(!regularFile(stat))throw new Error(`会话文件类型不兼容（${normalized}），未创建副本`)
    await addParents(dirname(normalized)=== '.'?'':dirname(normalized))
    if(++count>100_000)throw new Error('会话文件超过 10 万项，未创建副本')
    if(bytes+stat.size>100*1024**3)throw new Error('会话快照超过 100 GiB，未创建副本')
    seen.add(normalized);entries.push(signature(normalized,stat));files++;bytes+=stat.size
  }
  const walkJsonl=async(relativePath:string):Promise<void>=>{
    signal.throwIfAborted()
    const path=join(canonical,relativePath),stat=await lstat(path)
    if(!regularDirectory(stat))throw new Error(`会话目录类型不兼容（${relativePath}），未创建副本`)
    await addDirectory(relativePath)
    const names:string[]=[]
    for await(const entry of await opendir(path)){signal.throwIfAborted();names.push(entry.name)}
    for(const name of names.sort()){
      signal.throwIfAborted()
      const child=join(relativePath,name),childStat=await lstat(join(canonical,child))
      if(regularDirectory(childStat))await walkJsonl(child)
      else if(regularFile(childStat)&&/\.jsonl$/i.test(name))await addFile(child)
      else if(!regularFile(childStat)&&!regularDirectory(childStat))throw new Error(`会话目录包含不支持的文件（${child}），未创建副本`)
    }
  }
  await addDirectory('')
  for(const name of ['.codex-global-state.json','history.jsonl','session_index.jsonl','transcription-history.jsonl']){
    const path=join(canonical,name)
    try{const stat=await lstat(path);if(regularFile(stat))await addFile(name);else if(regularDirectory(stat))throw new Error(`会话索引类型不兼容（${name}），未创建副本`)}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  for(const name of ['sessions','archived_sessions']){
    const path=join(canonical,name)
    try{await lstat(path);await walkJsonl(name)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }

  // sqlite_home is a client setting, so read it only to locate the source
  // database; never copy the config itself.  Newer Codex profiles can put the
  // setting under a named profile, so inspect the active profile and root
  // configuration only. An external database cannot be safely
  // relocated by this manifest and is rejected rather than silently
  // producing a copy with missing history.
  const config=readBounded(join(canonical,'config.toml'),1024*1024)
  const configured=configuredSessionDatabaseHome(config)
  const configuredDirectory=configured
    ?configured.startsWith('~/')?join(homedir(),configured.slice(2))
      :isAbsolute(configured)?resolve(configured):resolve(canonical,configured)
    :undefined
  if(configuredDirectory&&!inside(canonical,configuredDirectory))throw new Error('会话数据库位于实例目录外，无法只迁移会话；请先将会话数据库放回实例目录')
  // With no explicit setting, prefer the canonical CODEX_HOME database. The
  // legacy `sqlite/` fallback is considered only when the root has no state
  // database. This prevents a copy from carrying two independent indexes that
  // diverge after the first restart.
  const rootDatabaseNames:string[]=[]
  for(const name of await readdir(canonical).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return[] as string[];throw error}))if(/^state_\d+\.sqlite$/i.test(name))rootDatabaseNames.push(name)
  const databaseDirectories=configuredDirectory?[configuredDirectory]:rootDatabaseNames.length?[canonical]:[join(canonical,'sqlite')]
  const uniqueDirectories=[...new Set(databaseDirectories)]
  for(const databaseDirectory of uniqueDirectories){
    if(!inside(canonical,databaseDirectory))throw new Error('会话数据库位于实例目录外，无法只迁移会话；请先将会话数据库放回实例目录')
    try{
      const stat=await lstat(databaseDirectory)
      if(!regularDirectory(stat))throw new Error('会话数据库目录类型不兼容，未创建副本')
      const names:string[]=[]
      for await(const entry of await opendir(databaseDirectory)){signal.throwIfAborted();names.push(entry.name)}
      for(const name of names.sort())if(sessionDatabaseName(name))await addFile(relative(canonical,join(databaseDirectory,name)))
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  const digest=createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  return {root:canonical,entries,files,bytes,skipped:0,digest}
}
