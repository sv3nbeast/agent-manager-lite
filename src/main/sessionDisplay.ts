// Title/project precedence follows Cockpit codex_session_display; no DB writes.
import {DatabaseSync} from 'node:sqlite'
import {readdir,lstat} from 'node:fs/promises'
import {join,basename,resolve} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {safeSessionPath,openSessionFile,sessionLines,jsonLine,cleanText,sessionTimestamp,sessionIdentifier} from './sessionFiles'
import {readBounded} from './clientConfig'
import {configuredSessionDatabaseHome} from './sessionDatabase'

interface Display {catalog:Map<string,string>;names:Map<string,string>;previews:Map<string,string>;index:Map<string,{title:string;updatedAt?:number}>;projects:{root:string;name:string}[]}
const normalized=(value:string)=>value.replace(/\\/g,'/').replace(/\/+$/,'')
const shortTitle=(value:string)=>{const text=cleanText(value).replace(/\s+/g,' '),chars=Array.from(text);return chars.length>60?chars.slice(0,59).join('').trimEnd()+'…':text}
export function displayTitle(display:Display,id:string):string {return display.catalog.get(id)||display.names.get(id)||display.index.get(id)?.title||shortTitle(display.previews.get(id)??'')||id}
export function displayProject(display:Display,cwd:string):string|undefined{const path=normalized(cwd);return display.projects.find(item=>path===item.root||path.startsWith(item.root+'/'))?.name}

/**
 * A paginated Codex thread can have many distinct rollouts with one metadata
 * session ID. Only the database actually configured for this home can identify
 * its current segment; display-title fallbacks must not choose that segment.
 */
export async function readSessionRolloutIndex(root:string,signal:AbortSignal,warn:(message:string)=>void):Promise<Map<string,string>>{
  const result=new Map<string,string>(),configPath=join(root,'config.toml')
  let db:DatabaseSync|undefined
  const config=async():Promise<string|null>=>{
    try{
      const before=await safeSessionPath(root,configPath)
      if(!before.isFile()||before.nlink!==1)throw new Error('Unexpected config')
      const content=readBounded(configPath,1024*1024),after=await safeSessionPath(root,configPath)
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Config changed')
      return content
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
  }
  try{
    signal.throwIfAborted()
    const beforeConfig=await config(),configured=configuredSessionDatabaseHome(beforeConfig)
    // No external sqlite_home or symlink is followed. Inactive profiles and
    // stale databases in the alternate sqlite/ folder cannot resolve a thread.
    if(configured?.startsWith('~/'))return result
    const home=resolve(root,configured??'.')
    await safeSessionPath(root,home)
    const path=join(home,'state_5.sqlite')
    let before
    try{before=await safeSessionPath(root,path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error}
    if(!before.isFile()||before.nlink!==1)throw new Error('Unexpected database')
    for(const suffix of ['-wal','-shm'])try{const stat=await safeSessionPath(root,path+suffix);if(!stat.isFile()||stat.nlink!==1)throw new Error('Unexpected database side file')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=300')
    const version=()=>Number((db!.prepare('PRAGMA data_version').get() as {data_version:unknown}).data_version),beforeVersion=version()
    const columns=new Set((db.prepare('PRAGMA table_info(threads)').all() as {name:string}[]).map(row=>row.name))
    if(!columns.has('id')||!columns.has('rollout_path'))return result
    const repeated=new Set<string>();let count=0
    for(const value of db.prepare("SELECT id,rollout_path FROM threads WHERE typeof(id)='text' AND length(id) BETWEEN 1 AND 256 LIMIT 100001").iterate()){
      signal.throwIfAborted();if(++count>100000)throw new Error('Database exceeds limit')
      const row=value as Record<string,unknown>
      const id=sessionIdentifier(row.id);if(!id)continue
      if(row.id!==id){result.delete(id);repeated.add(id);continue}
      // Reject duplicate index IDs even when only one row has a usable path.
      if(result.has(id)||repeated.has(id)){result.delete(id);repeated.add(id);continue}
      const path=row.rollout_path
      if(typeof path!=='string'||!path.length||path.length>8192||/[\x00-\x1f\x7f]/.test(path)){repeated.add(id);continue}
      result.set(id,resolve(root,path))
      if(count%250===0)await setImmediate()
    }
    const after=await safeSessionPath(root,path)
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||version()!==beforeVersion||await config()!==beforeConfig)throw new Error('Database or config changed')
    signal.throwIfAborted();return result
  }catch{signal.throwIfAborted();warn('当前会话索引无法安全读取，保留多文件选择保护');return new Map()}
  finally{db?.close()}
}
export async function readSessionDisplay(root:string,signal:AbortSignal,warn:(message:string)=>void):Promise<Display>{
  const result:Display={catalog:new Map(),names:new Map(),previews:new Map(),index:new Map(),projects:[]},local=new Set<string>()
  try{
    const {file,stat}=await openSessionFile(root,join(root,'session_index.jsonl'))
    try{let count=0;for await(const line of sessionLines(file,stat.size,signal)){
      if(++count>200000)throw new Error('会话索引超过 20 万行')
      const value=jsonLine(line),id=sessionIdentifier(value?.id);if(!id)continue
      const title=['thread_name','threadName','title','name'].map(key=>cleanText(value?.[key])).find(Boolean)??''
      const updatedAt=['updated_at','updatedAt','last_updated_at','lastUpdatedAt'].map(key=>sessionTimestamp(value?.[key])).find(value=>value!==undefined)
      result.index.set(id,{title,updatedAt})
    }}finally{await file.close()}
  }catch(error){signal.throwIfAborted();if((error as NodeJS.ErrnoException).code!=='ENOENT')warn('会话标题索引无法完整读取，已使用其他展示信息')}
  const candidates:string[]=[]
  for(const sub of ['sqlite','']){
    const folder=join(root,sub)
    try{await safeSessionPath(root,folder);const entries=await readdir(folder,{withFileTypes:true});for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name)))if(entry.isFile()&&(sub?/\.(sqlite|db)$/i.test(entry.name):/^state_\d+\.sqlite$/i.test(entry.name)))candidates.push(join(folder,entry.name))}
    catch(error){signal.throwIfAborted();if((error as NodeJS.ErrnoException).code!=='ENOENT')warn('会话展示数据库目录无法读取')}
  }
  if(candidates.length>100)throw new Error('会话展示数据库超过 100 个，请缩小目录范围')
  for(const path of candidates){
    signal.throwIfAborted();let db:DatabaseSync|undefined
    try{
      const before=await safeSessionPath(root,path);if(!before.isFile()||before.nlink!==1)throw new Error('Unexpected database')
      for(const suffix of ['-wal','-shm'])try{const stat=await safeSessionPath(root,path+suffix);if(!stat.isFile()||stat.nlink!==1)throw new Error('Unexpected database side file')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      db=new DatabaseSync(path,{readOnly:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=300')
      const after=await lstat(path);if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('Database replaced')
      const columns=(table:string)=>new Set((db!.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name))
      const expr=(fields:Set<string>,key:string)=>fields.has(key)?`substr(COALESCE(${key}, ''),1,2000)`:"''"
      async function rows(sql:string,consume:(row:Record<string,unknown>)=>void){let count=0;for(const row of db!.prepare(sql+' LIMIT 100001').iterate()){
        signal.throwIfAborted();if(++count>100000)throw new Error('Database exceeds limit');consume(row as Record<string,unknown>);if(count%250===0)await setImmediate()
      }}
      const stateDatabase=/^state_\d+\.sqlite$/i.test(basename(path)),threads=stateDatabase?columns('threads'):new Set<string>()
      if(threads.has('id'))await rows(`SELECT id, ${expr(threads,'name')} AS name, ${expr(threads,'title')} AS title, ${expr(threads,'preview')} AS preview FROM threads WHERE typeof(id)='text' AND length(id) BETWEEN 1 AND 256`,row=>{
        const id=sessionIdentifier(row.id);if(!id)return
        const name=cleanText(row.name)||cleanText(row.title),preview=cleanText(row.preview)
        if(name&&!result.names.has(id))result.names.set(id,name)
        if(preview&&!result.previews.has(id))result.previews.set(id,preview)
      })
      const catalog=columns('local_thread_catalog')
      if(catalog.has('thread_id')&&catalog.has('display_title'))await rows(`SELECT thread_id AS id, ${expr(catalog,'display_title')} AS title, ${expr(catalog,'host_id')} AS host FROM local_thread_catalog WHERE typeof(thread_id)='text' AND length(thread_id) BETWEEN 1 AND 256`,row=>{
        const id=sessionIdentifier(row.id),title=cleanText(row.title),host=cleanText(row.host)
        if(!id||!title||host!=='local'&&local.has(id))return
        result.catalog.set(id,title);if(host==='local')local.add(id)
      })
      const projects=columns('projects'),roots=columns('project_roots')
      if(stateDatabase&&projects.has('id')&&projects.has('name')&&roots.has('project_id')&&roots.has('path'))await rows("SELECT r.path AS root, substr(p.name,1,2000) AS name FROM project_roots r JOIN projects p ON p.id = r.project_id WHERE typeof(r.path)='text' AND length(r.path) BETWEEN 1 AND 2000",row=>{
        const root=normalized(cleanText(row.root)),name=cleanText(row.name);if(root&&name&&!result.projects.some(item=>item.root===root))result.projects.push({root,name})
      })
    }catch{signal.throwIfAborted();warn('部分会话展示数据库无法读取，已使用索引或会话 ID')}
    finally{db?.close()}
  }
  result.projects.sort((a,b)=>b.root.length-a.root.length||a.root.localeCompare(b.root))
  return result
}
