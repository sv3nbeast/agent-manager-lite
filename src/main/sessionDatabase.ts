import {DatabaseSync} from 'node:sqlite'
import {lstatSync,realpathSync} from 'node:fs'
import {join,relative,resolve,sep,isAbsolute} from 'node:path'
import {TomlDocument} from './tomlPatch'

export interface SessionDatabaseChoice {
  /** Path value suitable for Codex's sqlite_home setting. */
  value?: string
  /** Database file selected inside the instance home. */
  path?: string
  reason: 'configured-external'|'best-local'|'no-local-database'
}

interface Candidate {value:string;path:string;threads:number;visible:number;latest:number}

const regularFile=(path:string):boolean=>{
  try{const stat=lstatSync(path);return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1}
  catch{return false}
}

function databaseScore(path:string):Omit<Candidate,'value'|'path'>|undefined {
  if(!regularFile(path))return
  let db:DatabaseSync|undefined
  try{
    // A read-only connection consumes the complete WAL snapshot without taking
    // ownership of the client's writer. Never run a write pragma here.
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false})
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=100')
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").all() as {name:string}[])
    if(!tables.length)return
    const columns=new Set((db.prepare('PRAGMA table_info(threads)').all() as {name:string}[]).map(row=>row.name))
    if(!columns.has('id'))return
    const total=Number((db.prepare('SELECT count(*) AS count FROM threads').get() as {count:unknown}).count)
    const visible=columns.has('has_user_event')
      ?Number((db.prepare('SELECT count(*) AS count FROM threads WHERE has_user_event=1').get() as {count:unknown}).count)
      :total
    const latestColumn=columns.has('updated_at_ms')?'updated_at_ms':columns.has('updated_at')?'updated_at':undefined
    const latest=latestColumn?Number((db.prepare(`SELECT COALESCE(max(${latestColumn}),0) AS value FROM threads`).get() as {value:unknown}).value):0
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(visible)||!Number.isFinite(latest))return
    // Compare these fields in order, rather than adding timestamps to counts.
    // Millisecond timestamps would otherwise outweigh thousands of threads.
    return {threads:total,visible,latest}
  }catch{return}
  finally{db?.close()}
}

function localCandidate(root:string,value:string,path:string):Candidate|undefined {
  const canonical=resolve(root,path)
  const part=relative(root,canonical)
  if(part==='..'||part.startsWith('..'+sep)||isAbsolute(part))return
  // A regular SQLite file can still sit behind a substituted directory. Check
  // the complete directory chain before SQLite is allowed to open the path.
  let directory=root
  for(const segment of ['',...(part?part.split(sep):[])]){
    if(segment)directory=join(directory,segment)
    try{
      const stat=lstatSync(directory)
      if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(directory)!==directory)return
    }catch{return}
  }
  const score=databaseScore(join(canonical,'state_5.sqlite'))
  return score?{value,path:canonical,...score}:undefined
}

/** The active profile overrides the root, while inactive profiles have no effect. */
export function sessionDatabaseConfigPath(config:string|null):string[] {
  if(config){
    const doc=new TomlDocument(config),active=doc.scalar(['profile'])
    if(typeof active==='string'&&active.length&&doc.children(['profiles']).includes(active))return ['profiles',active,'sqlite_home']
  }
  return ['sqlite_home']
}

export function configuredSessionDatabaseHome(config:string|null):string|undefined {
  if(!config)return
  const doc=new TomlDocument(config),path=sessionDatabaseConfigPath(config)
  for(const scope of path.length===1?[path]:[path,['sqlite_home']]){
    const value=doc.scalar(scope)
    if(typeof value==='string'&&value.trim())return value.trim()
  }
}

/**
 * Choose the history database Codex should use for one isolated home.
 *
 * Older Cockpit/Codex profiles can contain both `<home>/state_5.sqlite` and
 * `<home>/sqlite/state_5.sqlite`. The latter is often an old snapshot with a
 * valid schema but only a fraction of the rollouts. Treating it as the default
 * makes a restart look like data loss. We compare both local candidates and
 * return a short relative value; callers journal this temporary setting so the
 * original user configuration is restored when the instance stops.
 */
export function chooseSessionDatabase(root:string,config:string|null):SessionDatabaseChoice {
  const canonical=resolve(root)
  const configured=configuredSessionDatabaseHome(config)
  let configuredPath:string|undefined
  if(configured){
    const expanded=configured.startsWith('~/')?resolve(process.env.HOME??'',configured.slice(2)):configured
    if(isAbsolute(expanded)&&!within(canonical,resolve(expanded)))return {value:configured,reason:'configured-external'}
    configuredPath=resolve(canonical,expanded)
    if(!within(canonical,configuredPath))return {value:configured,reason:'configured-external'}
  }
  const localPaths=[
    ...(configuredPath?[{value:relative(canonical,configuredPath)||'.',path:configuredPath}]:[]),
    {value:'.',path:canonical},
    {value:'sqlite',path:join(canonical,'sqlite')}
  ]
  const candidates=[...new Map(localPaths.map(item=>[resolve(item.path),item])).values()]
    .map(item=>localCandidate(canonical,item.value,item.path))
    .filter((value):value is Candidate=>!!value)
  if(!candidates.length)return {reason:'no-local-database'}
  candidates.sort((a,b)=>b.visible-a.visible||b.threads-a.threads||b.latest-a.latest||a.path.localeCompare(b.path))
  const selected=candidates[0]
  // Keep a user-selected nested local database when it is the only valid one.
  // If both standard locations are present, the fullest index is authoritative.
  return {value:selected.value==='.'?'.':relative(canonical,selected.path),path:join(selected.path,'state_5.sqlite'),reason:'best-local'}
}

function within(root:string,path:string):boolean {
  const part=relative(root,path)
  return part!== '..'&&!part.startsWith('..'+sep)&&!isAbsolute(part)
}
