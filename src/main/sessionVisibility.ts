import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {copyFile,mkdir,readdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {z} from 'zod'
import {ClientConfigs,readBounded} from './clientConfig'
import {probeClientDaemon} from './clientDaemon'
import {safeSessionPath} from './sessionFiles'
import {TomlDocument} from './tomlPatch'
import type {ClientConfigTarget} from '../shared/clientConfig'
import {sessionVisibilityRepairApplySchema,sessionVisibilityRepairInputSchema,type SessionVisibilityRepairInput,type SessionVisibilityRepairInstanceList,type SessionVisibilityRepairInstance,type SessionVisibilityRepairItem,type SessionVisibilityRepairPreview,type SessionVisibilityRepairProviderList,type SessionVisibilityRepairProvider,type SessionVisibilityRepairSummary} from '../shared/sessionVisibility'

const DEFAULT_PROVIDER='openai'
const DEFAULT_INSTANCE='__default__'
const STATE_DB='state_5.sqlite'
const BACKUP_SUFFIX='-session-visibility-repair'
const MAX_ROLLOUT_BYTES=64*1024*1024
const MAX_BACKUPS=1

interface FileRevision {device:number;inode:number;size:number;mtimeMs:number;ctimeMs:number}
interface RolloutPlan {path:string;relativePath:string;revision:FileRevision;content:string}
interface DatabasePlan {path:string;revision:FileRevision;rows:number;rollouts:Map<string,{path:string;updatedAt?:number}>}
interface TargetPlan {
  target:ClientConfigTarget
  provider:string
  running:boolean
  databases:DatabasePlan[]
  rollouts:RolloutPlan[]
  skippedSqliteFile:boolean
  warnings:string[]
}
interface PendingRepair {ticket:string;createdAt:number;input:SessionVisibilityRepairInput;plans:TargetPlan[]}

const quote=(name:string)=>`"${name.replaceAll('"','""')}"`
const text=(value:unknown):string=>typeof value==='string'?value.trim():''
const asNumber=(value:unknown):number|undefined=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='bigint'&&value>=0n?Number(value):undefined
const identity=async(path:string):Promise<FileRevision>=>{const value=await stat(path);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1)throw new Error(`文件不是安全的普通文件：${path}`);return {device:value.dev,inode:value.ino,size:value.size,mtimeMs:value.mtimeMs,ctimeMs:value.ctimeMs}}
const sameRevision=(left:FileRevision,right:FileRevision)=>left.device===right.device&&left.inode===right.inode&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs
const throwIfAborted=(signal:AbortSignal)=>{if(signal.aborted)throw new Error('会话可见性修复已取消')}

function providerFromConfig(directory:string):string {
  const raw=readBounded(join(directory,'config.toml'),1024*1024)
  if(raw===null||!raw.trim())return DEFAULT_PROVIDER
  const value=new TomlDocument(raw).scalar(['model_provider'])
  return typeof value==='string'&&value.trim()?value.trim():DEFAULT_PROVIDER
}

function targetPath(root:string,value:string):string|undefined {
  const trimmed=value.trim();if(!trimmed)return
  const candidate=isAbsolute(trimmed)?trimmed:resolve(root,trimmed)
  const suffix=relative(root,candidate)
  if(suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))return
  return candidate
}

function tableColumns(db:DatabaseSync,table:string):Set<string>{
  const escaped=table.replaceAll('"','""')
  return new Set((db.prepare(`PRAGMA table_info("${escaped}")`).all() as Array<{name?:unknown}>).map(row=>typeof row.name==='string'?row.name:'').filter(Boolean))
}

function sessionPredicate(columns:Set<string>,visible=true):string|undefined {
  const defects:string[]=[]
  if(columns.has('model_provider'))defects.push(`COALESCE(${quote('model_provider')},'')<>?1`)
  if(columns.has('has_user_event')&&columns.has('first_user_message'))defects.push(`(COALESCE(${quote('first_user_message')},'')<>'' AND COALESCE(${quote('has_user_event')},0)<>1)`)
  if(columns.has('thread_source')&&columns.has('first_user_message'))defects.push(`(COALESCE(${quote('first_user_message')},'')<>'' AND COALESCE(${quote('thread_source')},'')='')`)
  if(columns.has('preview')&&columns.has('first_user_message'))defects.push(`(COALESCE(${quote('preview')},'')='' AND COALESCE(${quote('first_user_message')},'')<>'')`)
  if(!defects.length)return
  let result=`(${defects.join(' OR ')})`
  if(visible){
    const filters:string[]=[]
    if(columns.has('archived'))filters.push(`COALESCE(${quote('archived')},0)=0`)
    if(columns.has('preview')&&columns.has('first_user_message'))filters.push(`(COALESCE(${quote('preview')},'')<>'' OR COALESCE(${quote('first_user_message')},'')<>'')`)
    else if(columns.has('preview'))filters.push(`COALESCE(${quote('preview')},'')<>''`)
    if(columns.has('rollout_path'))filters.push(`COALESCE(${quote('rollout_path')},'')<>''`)
    if(columns.has('source'))filters.push(`LOWER(COALESCE(${quote('source')},'')) NOT LIKE '%subagent%' AND LOWER(COALESCE(${quote('source')},'')) NOT LIKE '%internal%'`)
    if(columns.has('thread_source'))filters.push(`COALESCE(${quote('thread_source')},'')<>'ambient_suggestions'`)
    if(filters.length)result+=` AND (${filters.join(' AND ')})`
  }
  return result
}

function rolloutReferencePredicate(columns:Set<string>):string|undefined {
  if(!columns.has('model_provider')||!columns.has('id')||!columns.has('rollout_path'))return
  const filters=[`COALESCE(${quote('model_provider')},'')<>?1`,`COALESCE(${quote('rollout_path')},'')<>''`]
  if(columns.has('archived'))filters.push(`COALESCE(${quote('archived')},0)=0`)
  if(columns.has('preview')&&columns.has('first_user_message'))filters.push(`(COALESCE(${quote('preview')},'')<>'' OR COALESCE(${quote('first_user_message')},'')<>'')`)
  else if(columns.has('preview'))filters.push(`COALESCE(${quote('preview')},'')<>''`)
  if(columns.has('source'))filters.push(`LOWER(COALESCE(${quote('source')},'')) NOT LIKE '%subagent%' AND LOWER(COALESCE(${quote('source')},'')) NOT LIKE '%internal%'`)
  if(columns.has('thread_source'))filters.push(`COALESCE(${quote('thread_source')},'')<>'ambient_suggestions'`)
  return filters.join(' AND ')
}

function sessionFilter(columns:Set<string>,ids:string[],start:number):{sql:string;params:string[]} {
  if(!ids.length||!columns.has('id'))return {sql:'',params:[]}
  return {sql:` AND ${quote('id')} IN (${ids.map((_,index)=>`?${start+index}`).join(',')})`,params:ids}
}

function readRows(db:DatabaseSync,sql:string,params:string[]):Array<Record<string,unknown>> {
  return db.prepare(sql).all(...params) as Array<Record<string,unknown>>
}

function repairContent(content:string,provider:string):string|undefined {
  let found=false,changed=false
  const lines=content.split(/(?<=\n)/)
  const next=lines.map(segment=>{
    const ending=segment.endsWith('\n')?'\n':''
    const line=ending?segment.slice(0,-1):segment
    if(found||!line.trim())return segment
    try{
      const value=JSON.parse(line) as Record<string,unknown>
      if(value?.type!=='session_meta'||!value.payload||typeof value.payload!=='object')return segment
      found=true
      const payload=value.payload as Record<string,unknown>
      if(payload.model_provider===provider)return segment
      payload.model_provider=provider;changed=true
      return JSON.stringify(value)+ending
    }catch{return segment}
  }).join('')
  return changed?next:undefined
}

async function readRolloutPlan(root:string,path:string,provider:string):Promise<RolloutPlan|undefined>{
  let current:FileRevision
  try{current=await identity(path)}catch{return}
  if(current.size>MAX_ROLLOUT_BYTES)return
  const safe=await safeSessionPath(root,path);if(!safe.isFile())return
  const raw=await readFile(path,'utf8'),content=repairContent(raw,provider)
  if(content===undefined)return
  return {path,relativePath:relative(root,path),revision:current,content}
}

function sqliteCandidates(root:string):string[]{return [...new Set([join(root,'sqlite',STATE_DB),join(root,STATE_DB)])]}

async function inspectDatabase(root:string,path:string,provider:string,ids:string[],warnings:string[]):Promise<DatabasePlan|undefined>{
  let revision:FileRevision
  try{revision=await identity(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;warnings.push(`${basename(path)}：无法安全读取，已跳过`);return}
  let db:DatabaseSync|undefined
  try{
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=300')
    const columns=tableColumns(db,'threads');if(!columns.has('id')||!columns.has('model_provider'))return {path,revision,rows:0,rollouts:new Map()}
    const repair=sessionPredicate(columns),references=rolloutReferencePredicate(columns);if(!repair&&!references)return {path,revision,rows:0,rollouts:new Map()}
    const filter=sessionFilter(columns,ids,2)
    let rows=0
    if(repair){const result=readRows(db,`SELECT COUNT(*) AS count FROM ${quote('threads')} WHERE ${repair}${filter.sql}`,[provider,...filter.params]);rows=Number(result[0]?.count??0)}
    const rollouts=new Map<string,{path:string;updatedAt?:number}>()
    if(references){
      const updated=columns.has('updated_at')?quote('updated_at'):'NULL',updatedMs=columns.has('updated_at_ms')?quote('updated_at_ms'):'NULL'
      const result=readRows(db,`SELECT ${quote('rollout_path')} AS rollout_path,${updated} AS updated_at,${updatedMs} AS updated_at_ms FROM ${quote('threads')} WHERE ${references}${filter.sql}`,[provider,...filter.params])
      for(const row of result){const candidate=targetPath(root,text(row.rollout_path));if(!candidate)continue;const seconds=asNumber(row.updated_at),milliseconds=asNumber(row.updated_at_ms);const at=milliseconds!==undefined?milliseconds:seconds!==undefined?seconds*1000:undefined;rollouts.set(candidate,{path:candidate,updatedAt:at})}
    }
    return {path,revision,rows,rollouts}
  }catch(error){warnings.push(`${basename(path)}：SQLite 无法读取，已跳过（${error instanceof Error?error.message:'未知错误'}）`);return undefined}
  finally{db?.close()}
}

async function collectPlan(target:ClientConfigTarget,providerOverride:string|undefined,ids:string[],runningHint:(id:string)=>boolean):Promise<TargetPlan>{
  const actual=target // identityTarget has already validated this capability
  const provider=providerOverride??providerFromConfig(actual.directory),warnings:string[]=[],databases:DatabasePlan[]=[],rolloutMap=new Map<string,RolloutPlan>()
  let running=runningHint(actual.id)
  const daemon=await probeClientDaemon(actual.directory);if(daemon==='running')running=true
  for(const path of sqliteCandidates(actual.directory)){
    const database=await inspectDatabase(actual.directory,path,provider,ids,warnings)
    if(database){databases.push(database);for(const ref of database.rollouts.values()){const plan=await readRolloutPlan(actual.directory,ref.path,provider);if(plan)rolloutMap.set(plan.path,plan)}}
  }
  return {target:actual,provider,running,databases,rollouts:[...rolloutMap.values()].sort((a,b)=>a.relativePath.localeCompare(b.relativePath)),skippedSqliteFile:warnings.some(value=>value.includes('SQLite')),warnings}
}

function item(plan:TargetPlan,backupDir?:string):SessionVisibilityRepairItem{return {instanceId:plan.target.id,instanceName:plan.target.name,targetProvider:plan.provider,changedRolloutFileCount:plan.rollouts.length,updatedSqliteRowCount:plan.databases.reduce((sum,value)=>sum+value.rows,0),skippedSqliteFile:plan.skippedSqliteFile,running:plan.running,...backupDir?{backupDir}:{},warnings:[...plan.warnings]}}

function message(changed:number,rollouts:number,running:number,skipped:number,preview:boolean):string {
  if(!changed&&!rollouts&&!skipped)return preview?'预览完成：没有发现需要修复的可见会话。':'修复完成：没有发现需要修复的可见会话。'
  const suffix=running?`；${running} 个目录在预览时检测到正在运行，确认前必须完全退出` : ''
  return `${preview?'预览完成':'修复完成'}：预计更新 ${changed} 条 SQLite 记录、${rollouts} 个 rollout 文件${skipped?`；${skipped} 个 SQLite 文件已跳过`:''}${suffix}`
}

async function copyIfExists(source:string,target:string):Promise<boolean>{try{await stat(source);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(source,target);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}}

async function backupPlan(plan:TargetPlan):Promise<string>{
  const name=`backup-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}-${randomUUID()}${BACKUP_SUFFIX}`,root=join(plan.target.directory,name)
  await mkdir(join(root,'files'),{recursive:true,mode:0o700});await mkdir(join(root,'sqlite'),{recursive:true,mode:0o700})
  for(const rollout of plan.rollouts)await copyIfExists(rollout.path,join(root,'files',rollout.relativePath))
  const sqliteFiles:string[]=[]
  for(const database of plan.databases)for(const suffix of ['','-wal','-shm']){const target=join(root,'sqlite',relative(plan.target.directory,database.path)+suffix);if(await copyIfExists(database.path+suffix,target))sqliteFiles.push(database.path+suffix)}
  await writeFile(join(root,'manifest.json'),JSON.stringify({instanceId:plan.target.id,instanceRoot:plan.target.directory,targetProvider:plan.provider,createdAt:new Date().toISOString(),rolloutFiles:plan.rollouts.map(value=>value.relativePath),sqliteFiles},null,2)+'\n',{mode:0o600})
  return root
}

async function verifyRevision(path:string,expected:FileRevision):Promise<void>{const current=await identity(path);if(!sameRevision(current,expected))throw new Error(`修复前文件已变化，请重新预览：${path}`)}

async function atomicText(path:string,content:string):Promise<void>{const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);try{await writeFile(temporary,content,{mode:0o600});await rename(temporary,path)}finally{await rm(temporary,{force:true})}}

async function applyDatabase(database:DatabasePlan,provider:string,ids:string[],signal:AbortSignal):Promise<number>{
  throwIfAborted(signal);let db:DatabaseSync|undefined
  try{
    db=new DatabaseSync(database.path,{allowExtension:false});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE')
    const columns=tableColumns(db,'threads');if(!columns.has('id')||!columns.has('model_provider')){db.exec('ROLLBACK');return 0}
    const repair=sessionPredicate(columns);if(!repair){db.exec('COMMIT');return 0}
    const set:string[]=[`${quote('model_provider')}=?1`]
    if(columns.has('has_user_event')&&columns.has('first_user_message'))set.push(`${quote('has_user_event')}=CASE WHEN COALESCE(${quote('first_user_message')},'')<>'' THEN 1 ELSE ${quote('has_user_event')} END`)
    if(columns.has('thread_source')&&columns.has('first_user_message'))set.push(`${quote('thread_source')}=CASE WHEN COALESCE(${quote('thread_source')},'')='' AND COALESCE(${quote('first_user_message')},'')<>'' THEN 'user' ELSE ${quote('thread_source')} END`)
    if(columns.has('preview')&&columns.has('first_user_message'))set.push(`${quote('preview')}=CASE WHEN COALESCE(${quote('preview')},'')='' THEN ${quote('first_user_message')} ELSE ${quote('preview')} END`)
    const filter=sessionFilter(columns,ids,2),result=db.prepare(`UPDATE ${quote('threads')} SET ${set.join(',')} WHERE ${repair}${filter.sql}`).run(provider,...filter.params) as {changes?:number}
    throwIfAborted(signal);db.exec('COMMIT');return Number(result.changes??0)
  }catch(error){try{db?.exec('ROLLBACK')}catch{};throw error}finally{db?.close()}
}

async function restoreBackup(root:string,target:string):Promise<void>{
  const files=join(root,'files'),sqlite=join(root,'sqlite')
  async function walk(source:string,base:string){let entries:Awaited<ReturnType<typeof readdir>>;try{entries=await readdir(source,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error};for(const entry of entries){const from=join(source,entry.name),relativePath=relative(base,from),to=join(target,relativePath);if(entry.isDirectory())await walk(from,base);else await mkdir(dirname(to),{recursive:true,mode:0o700}).then(()=>copyFile(from,to))}}
  await walk(files,files)
  await walk(sqlite,sqlite)
}

async function pruneBackups(root:string):Promise<void>{let entries:Awaited<ReturnType<typeof readdir>>;try{entries=await readdir(root,{withFileTypes:true})}catch{return};const backups:string[]=[];for(const entry of entries)if(entry.isDirectory()&&entry.name.endsWith(BACKUP_SUFFIX))backups.push(entry.name);backups.sort().reverse();for(const old of backups.slice(MAX_BACKUPS))await rm(join(root,old),{recursive:true,force:true})}

export class SessionVisibilityRepair {
  private pending?:PendingRepair
  private running=new Map<string,AbortController>()
  constructor(private readonly configs:ClientConfigs,private readonly runningTarget:(id:string)=>boolean=()=>false){}
  stop():void { if(this.pending)this.pending=undefined; for(const controller of this.running.values())controller.abort(); this.running.clear() }
  cancel(ticket:string):void {z.string().uuid().parse(ticket);this.running.get(ticket)?.abort();if(this.pending?.ticket===ticket)this.pending=undefined}
  discard(ticket:string):void {z.string().uuid().parse(ticket);if(this.running.has(ticket))throw new Error('修复正在执行，请先取消');if(this.pending?.ticket===ticket)this.pending=undefined}
  async instances():Promise<SessionVisibilityRepairInstanceList>{
    const list:SessionVisibilityRepairInstance[]=[]
    for(const target of this.configs.targets()){const provider=providerFromConfig(this.configs.identityTarget(target.id).directory);const daemon=await probeClientDaemon(target.directory);list.push({id:target.id,name:target.name,directory:target.directory,currentProvider:provider,running:daemon==='running'||this.runningTarget(target.id),isDefault:target.id===DEFAULT_INSTANCE})}
    return {defaultInstanceId:DEFAULT_INSTANCE,instances:list}
  }
  async providers():Promise<SessionVisibilityRepairProviderList>{
    const sources=new Map<string,Set<'config'|'sqlite'>>(),targets=this.configs.targets();const defaultProvider=targets.length?providerFromConfig(this.configs.identityTarget(targets[0].id).directory):DEFAULT_PROVIDER
    const add=(id:string,source:'config'|'sqlite')=>{const value=id.trim();if(!value||value.length>200||/[\x00-\x1f\x7f]/.test(value))return;(sources.get(value)??(sources.set(value,new Set()),sources.get(value)!)).add(source)}
    for(const target of targets){const root=this.configs.identityTarget(target.id).directory;add(providerFromConfig(root),'config');for(const path of sqliteCandidates(root)){try{const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});const columns=tableColumns(db,'threads');if(columns.has('model_provider'))for(const row of db.prepare(`SELECT DISTINCT ${quote('model_provider')} AS provider FROM ${quote('threads')} WHERE COALESCE(${quote('model_provider')},'')<>''`).all() as Array<{provider?:unknown}>)if(typeof row.provider==='string')add(row.provider,'sqlite');db.close()}catch{}}}
    const providers:[string,Set<'config'|'sqlite'>][]=[...sources.entries()];providers.sort((a,b)=>(a[0]===defaultProvider?-1:b[0]===defaultProvider?1:a[0].localeCompare(b[0])));return {defaultProvider,providers:providers.map(([id,set])=>({id,sources:[...set].sort(),isDefault:id===defaultProvider}))}
  }
  async preview(raw:unknown):Promise<SessionVisibilityRepairPreview>{
    const input=sessionVisibilityRepairInputSchema.parse(raw);if(this.pending)throw new Error('已有会话可见性修复预览，请先取消或确认')
    const targets=this.configs.targets().filter(target=>!input.targetIds.length||input.targetIds.includes(target.id));if(input.targetIds.length!==targets.length)throw new Error('所选会话目录不存在')
    if(!targets.length)throw new Error('未找到可修复的 Codex 配置目录')
    const plans:TargetPlan[]=[];for(const target of targets)plans.push(await collectPlan(this.configs.identityTarget(target.id),input.targetProvider,input.sessionIds,this.runningTarget))
    const ticket=randomUUID(),createdAt=Date.now();this.pending={ticket,createdAt,input,plans};const items=plans.map(value=>item(value));const changed=items.reduce((sum,value)=>sum+value.updatedSqliteRowCount,0),rollouts=items.reduce((sum,value)=>sum+value.changedRolloutFileCount,0),skipped=items.filter(value=>value.skippedSqliteFile).length,running=items.filter(value=>value.running).length
    return {ticket,mode:'quick',createdAt,instanceCount:plans.length,changedRolloutFileCount:rollouts,updatedSqliteRowCount:changed,skippedSqliteFileCount:skipped,runningInstanceCount:running,items,warnings:plans.flatMap(value=>value.warnings),message:message(changed,rollouts,running,skipped,true)}
  }
  async apply(raw:unknown):Promise<SessionVisibilityRepairSummary>{
    const input=sessionVisibilityRepairApplySchema.parse(raw),pending=this.pending;if(!pending||pending.ticket!==input.ticket)throw new Error('修复预览已过期，请重新预览');this.pending=undefined
    const controller=new AbortController();this.running.set(input.ticket,controller);const backups:string[]=[];const resultItems:SessionVisibilityRepairItem[]=[]
    try{
      for(const plan of pending.plans){throwIfAborted(controller.signal);const target=this.configs.identityTarget(plan.target.id);if(plan.running||this.runningTarget(target.id)){throw new Error(`${target.name} 正在运行，请先完全退出 Codex 客户端或 CLI daemon；未写入任何文件`)}
        for(const database of plan.databases)await verifyRevision(database.path,database.revision);for(const rollout of plan.rollouts)await verifyRevision(rollout.path,rollout.revision)
        const hasChanges=plan.rollouts.length>0||plan.databases.some(value=>value.rows>0);if(!hasChanges){resultItems.push(item(plan));continue}
        const backup=await backupPlan(plan);backups.push(backup);try{
          let updated=0;for(const database of plan.databases){if(database.rows){updated+=await applyDatabase(database,plan.provider,pending.input.sessionIds,controller.signal);await setImmediate()}}
          for(const rollout of plan.rollouts){throwIfAborted(controller.signal);await atomicText(rollout.path,rollout.content);await setImmediate()}
          resultItems.push({...item(plan,backup),updatedSqliteRowCount:updated})
        }catch(error){await restoreBackup(backup,target.directory).catch(restoreError=>{throw new Error(`${error instanceof Error?error.message:'修复失败'}；自动回滚失败：${restoreError instanceof Error?restoreError.message:'未知错误'}；备份目录：${backup}`)});throw new Error(`${error instanceof Error?error.message:'修复失败'}；已自动回滚，备份目录：${backup}`)}
        await pruneBackups(target.directory)
      }
      const changed=resultItems.reduce((sum,value)=>sum+value.updatedSqliteRowCount,0),rollouts=resultItems.reduce((sum,value)=>sum+value.changedRolloutFileCount,0),skipped=resultItems.filter(value=>value.skippedSqliteFile).length,running=resultItems.filter(value=>value.running).length
      return {ticket:input.ticket,mode:'quick',instanceCount:resultItems.length,changedRolloutFileCount:rollouts,updatedSqliteRowCount:changed,skippedSqliteFileCount:skipped,runningInstanceCount:running,items:resultItems,warnings:resultItems.flatMap(value=>value.warnings),backupDirs:backups,message:message(changed,rollouts,running,skipped,false)}
    }catch(error){if(controller.signal.aborted)throw new Error('会话可见性修复已取消，已保留预览前文件；如已生成备份可从备份目录恢复');throw error}finally{this.running.delete(input.ticket)}
  }
}
