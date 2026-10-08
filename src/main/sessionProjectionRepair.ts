import {DatabaseSync} from 'node:sqlite'
import {lstatSync,realpathSync} from 'node:fs'
import {mkdir,readdir,writeFile} from 'node:fs/promises'
import {join,relative,sep,isAbsolute} from 'node:path'
import * as sqlite from 'node:sqlite'
import {probeClientDaemon} from './clientDaemon'

const PROJECTION_DB='thread_history_1.sqlite'
const STATE_DB='state_5.sqlite'
const TABLES=['thread_history_projection_state','thread_turns','thread_items','thread_realtime_items'] as const
type ProjectionTable=typeof TABLES[number]
type DbStats={threads:Set<string>;items:number;turns:number;states:number}
export interface SessionProjectionRepairResult {source:string;before:number;after:number;inserted:number;backup:string}

const regularFile=(path:string):boolean=>{try{const stat=lstatSync(path);return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1}catch{return false}}
const regularDirectory=(path:string):boolean=>{try{const stat=lstatSync(path);return stat.isDirectory()&&!stat.isSymbolicLink()}catch{return false}}
const safeTrashPath=(trash:string,path:string):boolean=>{
  const root=realpathSync(trash),candidate=realpathSync(path),part=relative(root,candidate)
  return part!== '..'&&!part.startsWith('..'+sep)&&!isAbsolute(part)&&!part.includes(`${sep}..${sep}`)
}

function tableExists(db:DatabaseSync,name:string):boolean {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(name)
}
function tableColumns(db:DatabaseSync,name:string):string[] {
  return (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{name?:unknown}>).map(row=>typeof row.name==='string'?row.name:'').filter(Boolean)
}
function readProjection(path:string):DbStats|undefined {
  if(!regularFile(path))return
  let db:DatabaseSync|undefined
  try {
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false})
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000')
    if(!tableExists(db,'thread_history_projection_state')||!tableExists(db,'thread_turns')||!tableExists(db,'thread_items'))return
    const threads=new Set<string>((db.prepare('SELECT thread_id FROM thread_history_projection_state WHERE thread_id IS NOT NULL').all() as Array<{thread_id?:unknown}>).flatMap(row=>typeof row.thread_id==='string'?[row.thread_id]:[]))
    const turns=Number((db.prepare('SELECT count(*) AS count FROM thread_turns').get() as {count:unknown}).count)
    const items=Number((db.prepare('SELECT count(*) AS count FROM thread_items').get() as {count:unknown}).count)
    const states=threads.size
    if(!Number.isSafeInteger(turns)||!Number.isSafeInteger(items))return
    return {threads,turns,items,states}
  } catch { return }
  finally { db?.close() }
}
function readStateThreads(path:string):Set<string> {
  if(!regularFile(path))return new Set()
  let db:DatabaseSync|undefined
  try {
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000')
    if(!tableExists(db,'threads'))return new Set()
    return new Set((db.prepare('SELECT id FROM threads WHERE id IS NOT NULL').all() as Array<{id?:unknown}>).flatMap(row=>typeof row.id==='string'?[row.id]:[]))
  } catch { return new Set() }
  finally { db?.close() }
}
function overlap(a:Set<string>,b:Set<string>):number { let count=0;for(const value of a)if(b.has(value))count++;return count }

interface Candidate {path:string;stats:DbStats;stateOverlap:number;missing:number;allowedThreads:Set<string>}
async function candidates(trash:string,current:DbStats,stateThreads:Set<string>):Promise<Candidate[]> {
  if(!regularDirectory(trash))return []
  const entries=await readdir(trash,{withFileTypes:true}),result:Candidate[]=[]
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue
    const source=join(trash,entry.name,'home',PROJECTION_DB),sourceState=join(trash,entry.name,'home',STATE_DB)
    if(!regularFile(source)||!regularFile(sourceState)||!safeTrashPath(trash,source)||!safeTrashPath(trash,sourceState))continue
    const stats=readProjection(source),candidateState=readStateThreads(sourceState)
    if(!stats)continue
    const stateOverlap=overlap(stateThreads,candidateState)
    const minimum=Math.max(3,Math.ceil(Math.min(stateThreads.size,candidateState.size)*0.1))
    if(stateOverlap<minimum)continue
    // Shared lineage qualifies an archive; it never authorizes importing its
    // other conversations. The current state index remains authoritative.
    const allowedThreads=new Set([...stats.threads].filter(id=>stateThreads.has(id)&&candidateState.has(id)))
    const missing=[...allowedThreads].filter(id=>!current.threads.has(id)).length
    if(!missing)continue
    result.push({path:source,stats,stateOverlap,missing,allowedThreads})
  }
  return result.sort((a,b)=>b.missing-a.missing||b.stateOverlap-a.stateOverlap||b.stats.items-a.stats.items||a.path.localeCompare(b.path))
}

type Backup=typeof sqlite&{backup?:(source:DatabaseSync,path:string,options:{rate:number;progress:(info:{totalPages:number;remainingPages:number})=>void})=>Promise<number>}
async function backupDatabase(source:string,target:string):Promise<void> {
  const backup=(sqlite as Backup).backup
  if(typeof backup!=='function')throw new Error('当前运行环境不支持会话数据库备份')
  const db=new DatabaseSync(source,{readOnly:true,allowExtension:false})
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000')
    await backup(db,target,{rate:256,progress:()=>{}})
  } finally { db.close() }
}
function commonColumns(target:DatabaseSync,source:DatabaseSync,table:ProjectionTable):string[]|undefined {
  const left=tableColumns(target,table),right=tableColumns(source,table)
  if(!left.length||JSON.stringify(left)!==JSON.stringify(right))return
  return left
}

async function mergeProjection(home:string,targetPath:string,sourcePath:string,backupPath:string,allowedThreads:Set<string>):Promise<number|undefined> {
  await backupDatabase(targetPath,backupPath)
  // Backup yields to the event loop. Recheck just before opening a writer so a
  // client started during the snapshot is left completely untouched.
  if(await probeClientDaemon(home)!=='not_detected')return
  const target=new DatabaseSync(targetPath,{allowExtension:false})
  let attached=false
  try {
    target.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON')
    target.prepare('ATTACH DATABASE ? AS recovery_source').run(sourcePath);attached=true
    const source=new DatabaseSync(sourcePath,{readOnly:true,allowExtension:false})
    try {
      target.exec('BEGIN IMMEDIATE')
      target.exec('CREATE TEMP TABLE recovery_allowed_threads(thread_id TEXT PRIMARY KEY)')
      const allow=target.prepare('INSERT INTO recovery_allowed_threads(thread_id) VALUES(?)')
      for(const id of allowedThreads)allow.run(id)
      const before=Number((target.prepare('SELECT count(*) AS count FROM thread_history_projection_state').get() as {count:unknown}).count)
      for(const table of TABLES){
        if(!tableExists(target,table)||!tableExists(source,table))continue
        const columns=commonColumns(target,source,table);if(!columns)throw new Error(`会话投影表结构不一致：${table}`)
        if(!columns.includes('thread_id'))throw new Error(`会话投影表缺少线程归属：${table}`)
        const quote=(column:string)=>`"${column.replaceAll('"','""')}"`
        target.exec(`INSERT OR IGNORE INTO main."${table}" (${columns.map(quote).join(',')}) SELECT ${columns.map(column=>'s.'+quote(column)).join(',')} FROM recovery_source."${table}" AS s JOIN temp.recovery_allowed_threads AS a ON a.thread_id=s.thread_id`)
      }
      const absent=Number((target.prepare('SELECT count(*) AS count FROM recovery_allowed_threads AS a WHERE NOT EXISTS(SELECT 1 FROM thread_history_projection_state AS s WHERE s.thread_id=a.thread_id)').get() as {count:unknown}).count)
      if(absent)throw new Error('会话投影恢复后校验失败')
      const integrity=(target.prepare('PRAGMA integrity_check').get() as {integrity_check?:unknown})?.integrity_check
      if(integrity!=='ok')throw new Error('会话投影数据库校验失败')
      if(target.prepare('PRAGMA foreign_key_check').all().length)throw new Error('会话投影引用校验失败')
      const after=Number((target.prepare('SELECT count(*) AS count FROM thread_history_projection_state').get() as {count:unknown}).count)
      target.exec('COMMIT')
      return Math.max(0,after-before)
    } catch(error){try{target.exec('ROLLBACK')}catch{};throw error}
    finally {source.close()}
  } finally {
    if(attached)try{target.exec('DETACH DATABASE recovery_source')}catch{}
    target.close()
  }
}

/**
 * Recover a missing Codex history projection from an archived managed copy.
 * The caller and this module both verify that the client is stopped.
 * Rollout JSONL and state_5.sqlite remain untouched; rows are merged by their
 * primary keys so newer rows already present in the target always win.
 */
export async function repairSessionProjection(home:string,trash:string):Promise<SessionProjectionRepairResult|undefined> {
  if(!regularDirectory(home)||!regularDirectory(trash))return
  home=realpathSync(home);trash=realpathSync(trash)
  if(await probeClientDaemon(home)!=='not_detected')return
  const targetPath=join(home,PROJECTION_DB),statePath=join(home,STATE_DB),current=readProjection(targetPath),stateThreads=readStateThreads(statePath)
  if(!current||stateThreads.size<3)return
  const options=await candidates(trash,current,stateThreads),selected=options[0]
  if(!selected)return
  const backupDir=join(home,'.session-projection-recovery'),backupPath=join(backupDir,`${Date.now()}-${PROJECTION_DB}`)
  await mkdir(backupDir,{recursive:true,mode:0o700})
  try {
    const inserted=await mergeProjection(home,targetPath,selected.path,backupPath,selected.allowedThreads)
    if(inserted===undefined)return
    const after=readProjection(targetPath);if(!after)throw new Error('会话投影恢复后无法读取结果')
    await writeFile(join(backupDir,'manifest.json'),JSON.stringify({source:selected.path,target:targetPath,before:current.states,after:after.states,createdAt:new Date().toISOString()},null,2)+'\n',{mode:0o600})
    return {source:selected.path,before:current.states,after:after.states,inserted,backup:backupPath}
  } catch(error) {
    // Leave the backup for inspection and surface the error to the caller;
    // never remove or overwrite the original archive source.
    throw error
  }
}
