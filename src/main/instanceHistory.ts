import {DatabaseSync} from 'node:sqlite'
import {constants,closeSync,fstatSync,lstatSync,openSync,opendirSync,readSync,realpathSync,statSync} from 'node:fs'
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {TomlDocument} from './tomlPatch'
import type {InstanceHistorySummary} from '../shared/instances'

const MAX_STATE_BYTES=8*1024*1024
const MAX_DATABASE_BYTES=128*1024*1024
const MAX_THREADS=50000
const MAX_PROJECTS=1000
const MAX_FALLBACK_FILES=5000
const MAX_FALLBACK_ENTRIES=20000
const MAX_HEADER_BYTES=32*1024
const MAX_FALLBACK_BYTES=64*1024*1024
type ObjectValue=Record<string,unknown>
interface Project {id:string;name:string;roots:string[]}
interface Thread {id:string;cwd:string;archived:boolean;projectId?:string}
interface DatabaseHistory {threads:Thread[];projects:Project[]}

const object=(value:unknown):ObjectValue|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:undefined
const text=(value:unknown,max=4096):string=>typeof value==='string'&&value.length<=max?value:''
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'&&item.length>0&&item.length<=4096).slice(0,MAX_THREADS):[]
const existsDirectory=(path:string):boolean=>{try{return !!path&&statSync(path).isDirectory()}catch{return false}}
const inside=(root:string,path:string):boolean=>{const part=relative(root,path);return part!== '..'&&!part.startsWith('..'+sep)&&!isAbsolute(part)}
const normalized=(path:string):string=>path.replace(/\\/g,'/').replace(/\/+$/,'')||'/'
const contains=(root:string,path:string):boolean=>{const a=normalized(root),b=normalized(path);return b===a||b.startsWith(a==='/'?'/':a+'/')}
const quote=(key:string)=>`"${key}"`
const internal=(source:unknown):boolean=>{
  if(typeof source==='string')return /subagent|internal|ambient_suggestions/i.test(source)
  const value=object(source)
  return !!value&&('subagent' in value||'internal' in value)
}

// Validate every path component, including SQLite side files. SQLite must never
// follow a configured database or WAL into a different profile.
function safePath(root:string,path:string,optional=false):ReturnType<typeof lstatSync>|undefined {
  if(!inside(root,path))throw new Error('unsafe')
  let current=root
  const suffix=relative(root,path)
  for(const part of suffix?suffix.split(sep):[]){
    current=join(current,part)
    let entry:ReturnType<typeof lstatSync>
    try{entry=lstatSync(current)}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(entry.isSymbolicLink())throw new Error('unsafe')
    if(current!==path&&!entry.isDirectory())throw new Error('unsafe')
  }
  const entry=lstatSync(path)
  if(entry.isSymbolicLink()||entry.isFile()&&entry.nlink!==1)throw new Error('unsafe')
  return entry
}

function readSafe(root:string,path:string,max:number,headerOnly=false):Buffer|undefined {
  const before=safePath(root,path,true)
  if(!before)return
  if(!before.isFile()||!headerOnly&&before.size>max)throw new Error('unsafe')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const opened=fstatSync(fd)
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('unsafe')
    const size=Math.min(opened.size,max),buffer=Buffer.alloc(size)
    let read=0
    while(read<size){const count=readSync(fd,buffer,read,size-read,read);if(!count)throw new Error('changed');read+=count}
    const after=fstatSync(fd)
    if(opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs)throw new Error('changed')
    return buffer
  }finally{closeSync(fd)}
}

function readState(root:string,issue:(message:string)=>void):ObjectValue {
  try{
    const data=readSafe(root,join(root,'.codex-global-state.json'),MAX_STATE_BYTES)
    if(!data)return{}
    const value=object(JSON.parse(data.toString('utf8')))
    if(!value)throw new Error('shape')
    return value
  }catch{issue('项目元数据无法安全读取，未展示其中的内容');return{}}
}

function globalProjects(state:ObjectValue,issue:(message:string)=>void):Project[] {
  const values=object(state['local-projects']),result:Project[]=[]
  if(values){
    if(Object.keys(values).length>MAX_PROJECTS)issue('项目数量超过预览上限，仅展示前 1000 个项目')
    const order=strings(state['project-order'])
    const keys=[...new Set([...order.filter(key=>Object.hasOwn(values,key)),...Object.keys(values)])].slice(0,MAX_PROJECTS)
    for(const key of keys){
      const project=object(values[key]);if(!project)continue
      const roots=strings(project.rootPaths).filter(isAbsolute).slice(0,100)
      const id=text(project.id)||text(key),name=text(project.name,2000)
      if(id&&name)result.push({id,name,roots})
    }
    return result
  }
  // Older clients saved folders directly. Do not invent projects from thread cwd.
  const labels=object(state['electron-workspace-root-labels'])??{}
  for(const path of [...new Set(strings(state['electron-saved-workspace-roots']).filter(isAbsolute))].slice(0,MAX_PROJECTS))result.push({id:path,name:text(labels[path],2000)||basename(path)||path,roots:[path]})
  return result
}

function databaseCandidates(root:string,issue:(message:string)=>void):string[] {
  try{
    const raw=readSafe(root,join(root,'config.toml'),1024*1024)
    if(raw){
      const configured=new TomlDocument(raw.toString('utf8')).scalar(['sqlite_home'])
      if(typeof configured==='string'&&configured.trim()){
        const path=resolve(root,configured)
        if(configured.startsWith('~')||!inside(root,path)){issue('会话数据库配置指向实例目录外，未读取该数据库');return[]}
        safePath(root,path,true)
        return[join(path,'state_5.sqlite')]
      }
    }
  }catch{issue('会话数据库配置无法安全读取，未读取该数据库');return[]}
  return[join(root,'state_5.sqlite'),join(root,'sqlite','state_5.sqlite')]
}

function readDatabase(root:string,issue:(message:string)=>void):DatabaseHistory|undefined {
  for(const path of databaseCandidates(root,issue)){
    let db:DatabaseSync|undefined
    try{
      const entry=safePath(root,path,true)
      if(!entry)continue
      if(!entry.isFile()||entry.size>MAX_DATABASE_BYTES)throw new Error('unsafe')
      const wal=safePath(root,path+'-wal',true),shm=safePath(root,path+'-shm',true)
      if(wal&&!wal.isFile()||shm&&!shm.isFile())throw new Error('unsafe')
      // Even a closed WAL-mode file can create WAL/SHM on a readOnly connection.
      // Complete live sidecars preserve committed WAL data; a closed file uses
      // immutable URI mode so inspecting it never creates SQLite side files.
      if(!!wal!==!!shm)throw new Error('missing readonly index')
      const uri=pathToFileURL(path);uri.searchParams.set('mode','ro');uri.searchParams.set('immutable','1')
      db=new DatabaseSync(wal?path:uri.href,{readOnly:true,allowExtension:false})
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=100')
      const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:unknown}[]).map(row=>row.name))
      if(!tables.has('threads'))throw new Error('schema')
      const columns=(table:string)=>new Set((db!.prepare(`PRAGMA table_info(${quote(table)})`).all() as {name:unknown}[]).map(row=>row.name))
      const threadCols=columns('threads')
      if(!threadCols.has('id'))throw new Error('schema')
      const field=(key:string)=>threadCols.has(key)?`substr(${quote(key)},1,4096) AS ${quote(key)}`:`NULL AS ${quote(key)}`
      const rows=db.prepare(`SELECT ${['id','cwd','source','thread_source','archived','has_user_event','project_id'].map(field).join(',')} FROM threads LIMIT ${MAX_THREADS+1}`).all() as ObjectValue[]
      if(rows.length>MAX_THREADS)issue('会话数量超过预览上限，仅统计前 50000 条索引记录')
      const threads:Thread[]=[]
      for(const row of rows.slice(0,MAX_THREADS)){
        const id=text(row.id,256)
        if(!id||internal(row.source)||internal(row.thread_source)||threadCols.has('has_user_event')&&Number(row.has_user_event)!==1)continue
        threads.push({id,cwd:text(row.cwd),archived:Number(row.archived)===1,projectId:text(row.project_id,256)||undefined})
      }
      if(!threadCols.has('has_user_event')||!threadCols.has('source'))issue('旧版会话索引缺少部分可见性字段，内部派生会话统计可能不完整')
      const projects:Project[]=[]
      if(tables.has('projects')&&tables.has('project_roots')){
        const projectCols=columns('projects'),rootCols=columns('project_roots')
        if(projectCols.has('id')&&projectCols.has('name')&&rootCols.has('project_id')&&rootCols.has('path')){
          const rows=db.prepare(`SELECT substr(p.id,1,256) AS id, substr(p.name,1,2000) AS name, substr(r.path,1,4096) AS path FROM projects p LEFT JOIN project_roots r ON p.id=r.project_id ${rootCols.has('position')?'ORDER BY r.position':''} LIMIT ${MAX_PROJECTS*100+1}`).all() as ObjectValue[]
          const map=new Map<string,Project>()
          for(const row of rows.slice(0,MAX_PROJECTS*100)){
            const id=text(row.id,256),name=text(row.name,2000),path=text(row.path)
            if(!id||!name)continue
            let project=map.get(id)
            if(!project){if(map.size===MAX_PROJECTS)continue;project={id,name,roots:[]};map.set(id,project)}
            if(path&&isAbsolute(path)&&!project.roots.includes(path)&&project.roots.length<100)project.roots.push(path)
          }
          projects.push(...map.values())
        }
      }
      return{threads,projects}
    }catch{issue('会话索引无法安全读取，已使用有限的会话头部预览')}
    finally{db?.close()}
  }
  return
}

function headerThreads(root:string,issue:(message:string)=>void):Thread[] {
  const result=new Map<string,Thread>();let visited=0,entries=0,bytes=0,limited=false
  const walk=(folder:string,archived:boolean,depth:number)=>{
    if(limited)return
    try{
      const info=safePath(root,folder,true);if(!info)return
      if(!info.isDirectory()||depth>8)throw new Error('unsafe')
      const directory=opendirSync(folder)
      try{let entry:ReturnType<typeof directory.readSync>
      while((entry=directory.readSync())!==null){
        if(limited)break
        if(++entries>MAX_FALLBACK_ENTRIES){limited=true;break}
        const path=join(folder,entry.name)
        if(entry.isSymbolicLink()){issue('部分会话文件为链接，未读取链接目标');continue}
        if(entry.isDirectory()){walk(path,archived,depth+1);continue}
        if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue
        if(++visited>MAX_FALLBACK_FILES||bytes>=MAX_FALLBACK_BYTES){limited=true;break}
        try{
          const buffer=readSafe(root,path,Math.min(MAX_HEADER_BYTES,MAX_FALLBACK_BYTES-bytes),true)
          if(!buffer)continue;bytes+=buffer.length
          const end=buffer.indexOf(10)
          if(end<0){issue('部分会话头部不完整或超过预览长度，未计入');continue}
          const event=object(JSON.parse(buffer.subarray(0,end).toString('utf8'))),payload=object(event?.payload)
          const id=text(payload?.id??payload?.session_id,256)
          if(event?.type!=='session_meta'||!payload||!id||internal(payload.source)||internal(payload.thread_source)||text(payload.parent_thread_id))continue
          if(!result.has(id))result.set(id,{id,cwd:text(payload.cwd),archived,projectId:text(payload.project_id,256)||undefined})
        }catch{issue('部分会话头部无法安全读取，未计入')}
      }}finally{directory.closeSync()}
    }catch{issue('部分会话目录无法安全读取，未读取其中内容')}
  }
  walk(join(root,'sessions'),false,0);walk(join(root,'archived_sessions'),true,0)
  if(visited)issue('缺少可用会话索引，仅统计会话头部；未读取正文，无法确认所有会话是否包含用户消息')
  if(limited)issue('会话头部预览达到安全上限，当前数量可能少于实际历史')
  return[...result.values()]
}

/** Read only metadata for user-facing main threads. sessions includes archived;
 * archived is its subset. Never read conversation bodies or expose SQL errors. */
export function readInstanceHistory(home:string):InstanceHistorySummary {
  const summary:InstanceHistorySummary={sessions:0,archived:0,projects:[],unassigned:0,issues:[]}
  const issues=new Set<string>(),issue=(message:string)=>issues.add(message),root=resolve(home)
  try{const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(root)!==root)throw new Error('unsafe')}
  catch{summary.issues=['实例目录无法安全读取'];return summary}
  const state=readState(root,issue),projects=globalProjects(state,issue),database=readDatabase(root,issue)
  const threads=database?.threads??headerThreads(root,issue)
  if(!projects.length&&threads.length)issue(database?.projects.length?'客户端项目列表为空，历史会话尚未恢复项目分组':'未保存项目分组，会话将显示在最近')
  const byId=new Map(projects.map((project,index)=>[project.id,index]))
  const sqlProjects=new Map(database?.projects.map(project=>[project.id,project])??[])
  const hostMaps=object(state['app-server-project-id-by-legacy-project-id-by-host'])
  const map=object(hostMaps?.['local:'+root])??{}
  const serverToLocal=new Map<string,number>()
  for(const [legacy,server]of Object.entries(map)){const index=byId.get(legacy);if(index!==undefined&&typeof server==='string')serverToLocal.set(server,index)}
  const assignments=object(state['thread-project-assignments'])??{},projectless=new Set(strings(state['projectless-thread-ids']))
  const hints=object(state['thread-workspace-root-hints'])??{}
  const rootMatch=(path:string):number|undefined=>{
    if(!path||!isAbsolute(path))return
    let selected:number|undefined,length=-1
    projects.forEach((project,index)=>{for(const root of project.roots)if(contains(root,path)&&root.length>length){selected=index;length=root.length}})
    return selected
  }
  summary.projects=projects.map(project=>({path:project.roots[0]??'',name:project.name,exists:project.roots.some(existsDirectory),sessions:0}))
  for(const thread of threads){
    summary.sessions++;if(thread.archived)summary.archived++
    let project:number|undefined
    const assignment=object(assignments[thread.id])
    if(!projectless.has(thread.id)){
      if(assignment){if(assignment.projectKind==='local')project=byId.get(text(assignment.projectId))}
      else if(thread.projectId){
        project=byId.get(thread.projectId)??serverToLocal.get(thread.projectId)
        if(project===undefined){
          const stored=sqlProjects.get(thread.projectId)
          const matches=stored?projects.flatMap((value,index)=>value.roots.length===stored.roots.length&&value.roots.every(root=>stored.roots.includes(root))?[index]:[]):[]
          if(matches.length===1)project=matches[0]
        }
      }else project=rootMatch(text(hints[thread.id])||thread.cwd)
    }
    if(project===undefined)summary.unassigned++;else summary.projects[project].sessions++
  }
  summary.issues=[...issues]
  return summary
}
