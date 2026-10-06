import {isAbsolute,join,relative,sep} from 'node:path'
import {excludedInstanceCopyTree} from './instanceCopyScope'

export const copiedProjectStateFile='.codex-global-state.json'
export const copiedProjectStateLimit=16*1024*1024
export interface ProjectCopyOptions {sourceHome?:string;targetHome?:string;threadIds?:ReadonlySet<string>}
type State=Record<string,unknown>
const own=(value:State,key:string)=>Object.prototype.hasOwnProperty.call(value,key)
function invalid(field:string):never{throw new Error(`来源项目分组状态格式不兼容（${field}），未创建副本`)}
function object(value:unknown,field:string):State{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid(field)
  return value as State
}
function text(value:unknown,field:string):string{if(typeof value!=='string'||value.includes('\0'))invalid(field);return value}
function list(value:unknown,field:string):string[]{if(!Array.isArray(value))invalid(field);return value.map(item=>text(item,field))}

// Codex stores project membership separately from rollout/SQLite history. Copy
// this small allowlist instead of inheriting permissions, identity, environment,
// analytics or window preferences from another desktop instance.
export function projectCopiedProjectState(raw:string,options:ProjectCopyOptions={}):State{
  if(Buffer.byteLength(raw)>copiedProjectStateLimit)invalid('size')
  let parsed:unknown
  try{parsed=JSON.parse(raw)}catch{invalid('JSON')}
  const source=object(parsed,'root'),state:State={}
  const path=(value:string):string=>{
    if(!options.sourceHome||!options.targetHome||!isAbsolute(value))return value
    const suffix=relative(options.sourceHome,value)
    // Project checkouts remain at their original paths. Only copied profile
    // data is relocated, avoiding project roots pointing at absent worktrees.
    return suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix)||excludedInstanceCopyTree(suffix)?value:join(options.targetHome,suffix)
  }
  const included=(id:string)=>!options.threadIds||options.threadIds.has(id)
  for(const key of ['electron-saved-workspace-roots','project-order'])if(own(source,key))state[key]=list(source[key],key).map(path)
  if(own(source,'electron-workspace-root-labels')){
    state['electron-workspace-root-labels']=Object.fromEntries(Object.entries(object(source['electron-workspace-root-labels'],'electron-workspace-root-labels')).map(([root,value])=>[path(root),text(value,'electron-workspace-root-labels')]))
  }
  if(own(source,'local-projects')){
    state['local-projects']=Object.fromEntries(Object.entries(object(source['local-projects'],'local-projects')).map(([id,value])=>{
      const project=object(value,'local-projects'),next:State={id:text(project.id,'local-projects.id'),name:text(project.name,'local-projects.name'),rootPaths:list(project.rootPaths,'local-projects.rootPaths').map(path)}
      for(const key of ['createdAt','updatedAt'])if(own(project,key)){
        if(typeof project[key]!=='number'||!Number.isFinite(project[key]))invalid('local-projects.'+key)
        next[key]=project[key]
      }
      return [id,next]
    }))
  }
  if(own(source,'thread-project-assignments')){
    state['thread-project-assignments']=Object.fromEntries(Object.entries(object(source['thread-project-assignments'],'thread-project-assignments')).flatMap(([id,value])=>{
      const assignment=object(value,'thread-project-assignments')
      const next={projectId:text(assignment.projectId,'thread-project-assignments.projectId'),projectKind:text(assignment.projectKind,'thread-project-assignments.projectKind')}
      return included(id)?[[id,next]]:[]
    }))
  }
  for(const key of ['projectless-thread-ids','pinned-thread-ids'])if(own(source,key))state[key]=list(source[key],key).filter(included)
  if(own(source,'pinned-project-ids'))state['pinned-project-ids']=list(source['pinned-project-ids'],'pinned-project-ids').map(path)
  for(const key of ['thread-workspace-root-hints','thread-projectless-output-directories'])if(own(source,key)){
    state[key]=Object.fromEntries(Object.entries(object(source[key],key)).flatMap(([id,value])=>{
      const next=path(text(value,key));return included(id)?[[id,next]]:[]
    }))
  }
  if(own(source,'sidebar-project-thread-orders')){
    state['sidebar-project-thread-orders']=Object.fromEntries(Object.entries(object(source['sidebar-project-thread-orders'],'sidebar-project-thread-orders')).map(([id,value])=>{
      const order=object(value,'sidebar-project-thread-orders'),next:State={threadIds:list(order.threadIds,'sidebar-project-thread-orders.threadIds').filter(included)}
      if(own(order,'sortKey')){
        if(!['created_at','updated_at'].includes(order.sortKey as string))invalid('sidebar-project-thread-orders.sortKey')
        next.sortKey=order.sortKey
      }
      return [path(id),next]
    }))
  }
  // The copied SQLite projects retain their UUIDs. Carry only the source local
  // host's legacy-to-server mapping, renamed to this independent CODEX_HOME.
  // Thread assignments must be eligible for the target's official migration;
  // a completed marker from the old instance must not suppress that migration.
  if(options.sourceHome&&options.targetHome){
    const sourceHost='local:'+options.sourceHome,targetHost='local:'+options.targetHome
    const mapKey='app-server-project-id-by-legacy-project-id-by-host'
    if(own(source,mapKey)){
      const hosts=object(source[mapKey],mapKey)
      if(own(hosts,sourceHost))state[mapKey]={[targetHost]:Object.fromEntries(Object.entries(object(hosts[sourceHost],mapKey)).map(([id,value])=>[id,text(value,mapKey)]))}
    }
    const migrationKey='app-server-projects-migration-by-host'
    if(own(source,migrationKey)){
      const hosts=object(source[migrationKey],migrationKey)
      if(own(hosts,sourceHost)){
        const migration=object(hosts[sourceHost],migrationKey),next:State={threadAssignmentsMigrated:false,threadAssignmentsReadMigrated:false}
        if(migration.version!==1)invalid(migrationKey+'.version')
        next.version=1
        if(own(migration,'projectsMigrated')){
          if(typeof migration.projectsMigrated!=='boolean')invalid(migrationKey+'.projectsMigrated')
          next.projectsMigrated=own(state,mapKey)&&migration.projectsMigrated
        }
        if(own(migration,'pendingThreadAssignmentIds'))next.pendingThreadAssignmentIds=list(migration.pendingThreadAssignmentIds,migrationKey+'.pendingThreadAssignmentIds').filter(included)
        state[migrationKey]={[targetHost]:next}
      }
    }
  }
  return state
}

export function summarizeCopiedProjectState(state:State):{projects:number;workspaceRoots:number;assignedThreads:number;projectlessThreads:number;workspaceHints:number;outputDirectories:number;orderedProjects:number}{
  const count=(key:string)=>Object.keys(state[key] as State??{}).length
  return {projects:count('local-projects'),workspaceRoots:(state['electron-saved-workspace-roots'] as unknown[]??[]).length,assignedThreads:count('thread-project-assignments'),projectlessThreads:(state['projectless-thread-ids'] as unknown[]??[]).length,workspaceHints:count('thread-workspace-root-hints'),outputDirectories:count('thread-projectless-output-directories'),orderedProjects:(state['project-order'] as unknown[]??[]).length}
}
