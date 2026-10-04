import {isAbsolute,join} from 'node:path'
import type {MergedSession} from './sessionMerge'
import type {SyncJournal} from './sessionSyncFiles'
import {textHash} from './sessionTransferFiles'

export function syncMetadata(root:string,sessions:{merged:MergedSession;relative:string}[],indexBefore:string|null,globalBefore:string|null):{metadata:SyncJournal['metadata'];repairsWorkspace:boolean}{
  if(!sessions.length)return {metadata:[],repairsWorkspace:false}
  const replacements=new Map(sessions.map(({merged,relative})=>{
    const {source,index}=merged,row:Record<string,unknown>={...index,id:source.record.id}
    if(!['thread_name','threadName','title','name'].some(key=>typeof row[key]==='string'&&(row[key] as string).trim()))row.thread_name=source.record.title
    if(!['updated_at','updatedAt','last_updated_at','lastUpdatedAt'].some(key=>row[key]!==undefined))row.updated_at=new Date(source.record.updatedAt??source.mtime).toISOString()
    for(const key of ['rollout_path','rolloutPath','path'])if(typeof row[key]==='string')row[key]=isAbsolute(row[key])?join(root,relative):relative
    return [source.record.id,row]
  }))
  const seen=new Set<string>(),lines=(indexBefore??'').split('\n')
  for(let i=0;i<lines.length;i++)try{const row=JSON.parse(lines[i]),next=replacements.get(row.id);if(next){const merged={...row,...next};if(JSON.stringify(row)!==JSON.stringify(merged))lines[i]=JSON.stringify(merged);seen.add(row.id)}}catch{/* Unrelated and malformed index lines are retained. */}
  if(lines.at(-1)==='')lines.pop()
  for(const [id,row] of replacements)if(!seen.has(id))lines.push(JSON.stringify(row))
  let global:Record<string,unknown>
  try{global=globalBefore===null?{}:JSON.parse(globalBefore)}catch{throw new Error('同步目标全局会话状态格式无效')}
  if(!global||typeof global!=='object'||Array.isArray(global))throw new Error('同步目标全局会话状态格式无效')
  let repairsWorkspace=false
  for(const key of ['project-order','electron-saved-workspace-roots']){
    const previous=global[key];if(previous!==undefined&&(!Array.isArray(previous)||previous.some(value=>typeof value!=='string')))throw new Error('同步目标项目索引格式无效')
    const values:string[]=[...(previous as string[]|undefined)??[]]
    for(const {merged} of sessions){const cwd=merged.source.record.cwd;if(isAbsolute(cwd)&&!values.includes(cwd)){values.push(cwd);repairsWorkspace=true}}
    if(values.length||previous!==undefined)global[key]=values
  }
  const metadata:SyncJournal['metadata']=[]
  for(const item of [{name:'session_index.jsonl' as const,before:indexBefore,after:lines.join('\n')+'\n'},{name:'.codex-global-state.json' as const,before:globalBefore,after:repairsWorkspace?JSON.stringify(global,null,2)+'\n':globalBefore}]){
    if(item.after===item.before||item.after===null)continue
    if(Buffer.byteLength(item.after)>16*1024**2)throw new Error('同步目标索引超过 16 MiB，请整理索引')
    metadata.push({...item,after:item.after,beforeHash:textHash(item.before),afterHash:textHash(item.after)})
  }
  return {metadata,repairsWorkspace}
}
