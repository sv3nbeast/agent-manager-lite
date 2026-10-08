// Selected-session copy follows Cockpit sync_sessions_to_instance: skip IDs
// already present in the target; keep source files; rebuild official metadata.
import {randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,readdirSync,realpathSync} from 'node:fs'
import {join,relative,sep,resolve,isAbsolute,basename} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs,atomic,directory,readBounded} from './clientConfig'
import {TomlDocument} from './tomlPatch'
import {SessionCatalog,type SessionTransferSource} from './sessions'
import {sessionCopyPreviewSchema,sessionCopyStartSchema,type SessionCopyPreview,type SessionTransferView,type SessionTransferRecovery} from '../shared/sessions'
import type {ClientConfigTarget} from '../shared/clientConfig'
import type {InstanceApplication} from '../shared/instances'
import {rolloutFiles,openSessionFile,firstSessionEvent,sessionIdentifier,sessionLines,jsonLine} from './sessionFiles'
import {probeClientDaemon} from './clientDaemon'
import {assertUnpagedSessionSources} from './sessionPaging'
import {sessionProgram,verifySessionProgram,rebuildSessionMetadata,type SessionProgram} from './officialSessions'
import {sessionJournalSchema,sessionJournalLimit,encodeSessionJournal,stagePath,fileIdentity,textHash,sessionRelative,verifySource,copySessionRollout,publishSessionTransfer,rollbackSessionTransfer,cleanupSessionStage,checkRoot,type SessionJournal} from './sessionTransferFiles'

interface Pending {view:SessionCopyPreview;target:ClientConfigTarget;rootIdentity?:{device:number;inode:number};configHash:string;profileHash:string;sources:SessionTransferSource[];lockedIds:Set<string>;indexes?:Map<string,Record<string,unknown>>;existing:Set<string>;program:SessionProgram;expires:number}
interface Job {view:SessionTransferView;targetIds:Set<string>;controller:AbortController;task?:Promise<void>}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep)
const safeError=(error:unknown)=>error instanceof Error&&!(error as NodeJS.ErrnoException).code?error.message:'会话操作失败，请检查目录权限、来源变化和可用磁盘空间'
// Codex scans YYYY/MM/DD for live sessions and a flat archive directory. It
// ignores arbitrary folders/names even when session_meta itself is valid.
export function sessionDestination(source:SessionTransferSource,root:string,files:Pick<SessionJournal['files'][number],'relative'>[]):string{
  const match=basename(source.path).match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-fA-F0-9-]+)(?:_([a-fA-F0-9-]+))?\.jsonl$/)
  const original=match&&match[2].toLowerCase()===source.record.id.toLowerCase()&&(!match[3]||z.string().uuid().safeParse(match[3]).success)?match:undefined
  const parsed=original?Date.parse(original[1].slice(0,10)+'T'+original[1].slice(11).replaceAll('-',':')+'Z'):NaN
  const timestamp=Number.isFinite(parsed)?parsed:source.record.updatedAt??source.mtime
  const archived=relative(source.root,source.path).split(sep)[0]==='archived_sessions'
  for(let attempt=0;attempt<1000;attempt++){
    const iso=new Date(timestamp+attempt*1000).toISOString().slice(0,19),stamp=iso.replaceAll(':','-')
    const name=attempt===0&&original&&Number.isFinite(parsed)?basename(source.path):'rollout-'+stamp+'-'+source.record.id+'.jsonl'
    const rel=archived?'archived_sessions/'+name:'sessions/'+iso.slice(0,10).replaceAll('-','/')+'/'+name
    if(sessionRelative(rel)&&!existsSync(join(root,rel))&&!files.some(file=>file.relative===rel))return rel
  }
  throw new Error('目标会话文件名存在过多冲突，请先检查目标目录')
}

export class SessionTransfers {
  private readonly configs:ClientConfigs
  private readonly root:string
  private pending?:Pending
  private generation=0
  private previewController?:AbortController
  private job?:Job
  private readonly recovery=new Map<string,SessionTransferRecovery>()
  constructor(private readonly store:Store,private readonly catalog:SessionCatalog,private readonly applications:()=>InstanceApplication[],
    private readonly inUse:(id:string)=>boolean=()=>false,private readonly rebuild:typeof rebuildSessionMetadata=rebuildSessionMetadata,
    private readonly now:()=>number=Date.now){this.configs=new ClientConfigs(store);this.root=join(realpathSync(store.directory),'session-transfers')}
  view():{transfer?:SessionTransferView;recoveries:SessionTransferRecovery[]}{return {transfer:this.job?structuredClone(this.job.view):undefined,recoveries:[...this.recovery.values()].map(value=>({...value}))}}
  active():boolean{return !!this.job?.task}
  busy(id:string):boolean{return !!this.job?.task&&this.job.targetIds.has(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id)}
  private profileHash(id:string):string{return textHash(JSON.stringify(this.store.read().instances?.find(instance=>instance.id===id)??null))}
  private assertFree(ids:Iterable<string>):void{for(const id of ids)if(this.inUse(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id))throw new Error('相关目录正在使用或等待恢复，请先停止客户端并处理恢复记录')}
  async closed(target:ClientConfigTarget,signal:AbortSignal):Promise<void>{
    if(!existsSync(target.directory)&&target.managed)return
    const state=await probeClientDaemon(target.directory,signal)
    if(state==='cancelled')signal.throwIfAborted()
    if(state!=='not_detected')throw new Error(state==='running'?'所选目录的 Codex 后台进程仍在运行，请关闭后重试':'无法确认会话目录已停止，请检查目录及后台进程')
  }
  private async existingIds(root:string,signal:AbortSignal):Promise<Set<string>>{
    const ids=new Set<string>();if(!existsSync(root))return ids
    let count=0
    for await(const path of rolloutFiles(root,signal)){
      if(++count>100000)throw new Error('目标目录会话文件超过 10 万条')
      const {file,stat}=await openSessionFile(root,path)
      try{const meta=await firstSessionEvent(file,stat.size,signal);if(meta?.type==='session_meta'){const id=sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id);if(id)ids.add(id)}}finally{await file.close()}
    }
    return ids
  }
  config(target:ClientConfigTarget):{hash:string;provider:string}{
    const raw=readBounded(join(target.directory,'config.toml'),1024*1024),doc=new TomlDocument(raw??''),provider=doc.scalar(['model_provider'])??'openai',sqlite=doc.scalar(['sqlite_home'])
    if(typeof provider!=='string'||!provider.trim()||provider.length>200||/[\x00-\x1f\x7f]/.test(provider))throw new Error('目标模型供应商配置无效')
    // Official indexing must not follow a database override outside this home.
    if(sqlite!==null){
      if(typeof sqlite!=='string'||sqlite.startsWith('~'))throw new Error('请先在客户端配置中将会话数据库设为所选目录内的路径')
      const path=resolve(target.directory,sqlite)
      if(path!==target.directory&&!path.startsWith(target.directory+sep))throw new Error('目标使用了目录外的会话数据库，未修改目标')
      let current=target.directory
      for(const part of relative(target.directory,path).split(sep).filter(Boolean)){
        current=join(current,part)
        try{const stat=lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('会话数据库目录包含链接或异常路径')}
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error}
      }
    }
    return {hash:textHash(raw),provider}
  }
  async preview(raw:unknown):Promise<SessionCopyPreview>{
    const input=sessionCopyPreviewSchema.parse(raw);this.discard();const generation=this.generation,controller=new AbortController();this.previewController=controller
    const sources=await this.catalog.transferSources(input.snapshotId,input.sessionIds,controller.signal)
    return this.buildPreview(input,sources,controller,generation)
  }
  // Internal only: ZIP entries are already verified/extracted into a private
  // workspace. They are never registered as user homes or accepted over IPC.
  async previewImported(targetId:string,applicationId:string,sources:SessionTransferSource[],indexes:Map<string,Record<string,unknown>>,signal?:AbortSignal):Promise<SessionCopyPreview>{
    this.discard();const generation=this.generation,controller=new AbortController();this.previewController=controller
    const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
    try{return await this.buildPreview({targetId,applicationId},sources,controller,generation,indexes)}finally{signal?.removeEventListener('abort',cancel)}
  }
  private async buildPreview(input:{targetId:string;applicationId:string},sources:SessionTransferSource[],controller:AbortController,generation:number,indexes?:Map<string,Record<string,unknown>>):Promise<SessionCopyPreview>{
    if(this.job?.task)throw new Error('已有会话操作正在执行，请完成或取消后重试')
    const target=this.configs.identityTarget(input.targetId),application=this.applications().find(item=>item.id===input.applicationId)
    if(!application)throw new Error('请选择已检测或登记的 Codex 程序')
    const ids=new Set([target.id,...(indexes?[]:sources.map(source=>source.targetId))])
    if(!sources.length||sources.length>1000)throw new Error('每次请选择 1–1000 个会话')
    if(sources.some(source=>!z.string().uuid().safeParse(source.record.id).success))throw new Error('所选会话 ID 不符合 Codex 格式，请先打开文件检查')
    this.assertFree(ids)
    for(const source of sources)if(source.root!==target.directory&&overlap(source.root,target.directory))throw new Error('来源与目标目录不能相互包含')
    controller.signal.throwIfAborted()
    const config=this.config(target),program=sessionProgram(application),existing=await this.existingIds(target.directory,controller.signal)
    await assertUnpagedSessionSources(sources.filter(source=>!existing.has(source.record.id)),controller.signal)
    const view:SessionCopyPreview={ticket:randomUUID(),targetId:target.id,targetName:target.name,directory:target.directory,applicationName:application.name,provider:config.provider,items:sources.map(source=>({id:source.record.id,title:source.record.title,sourceName:source.record.locations[0].name,sourceDirectory:source.root,bytes:source.size,status:existing.has(source.record.id)?'existing':'ready'})),totalBytes:sources.filter(source=>!existing.has(source.record.id)).reduce((sum,source)=>sum+source.size,0)}
    if(view.totalBytes>100*1024**3)throw new Error('所选会话超过 100 GiB，请分批复制')
    if(generation!==this.generation)throw new Error('会话复制预览已更新，请重新选择')
    this.pending={view,target,rootIdentity:existsSync(target.directory)?fileIdentity(lstatSync(target.directory)):undefined,configHash:config.hash,profileHash:this.profileHash(target.id),sources,lockedIds:ids,indexes,existing,program,expires:this.now()+300000}
    return structuredClone(view)
  }
  discard():void{this.generation++;this.pending=undefined;this.previewController?.abort();this.previewController=undefined}
  start(raw:unknown,operation:'copy'|'import'='copy'):void{
    const input=sessionCopyStartSchema.parse(raw),pending=this.pending
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('会话复制预览已过期，请重新预览')
    if((pending.indexes?'import':'copy')!==operation)throw new Error('会话预览不属于此操作，请重新预览')
    if(this.job?.task)throw new Error('已有会话操作正在执行')
    const ids=pending.lockedIds;this.assertFree(ids);this.discard()
    const sources=pending.sources.filter(source=>!pending.existing.has(source.record.id)),job:Job={view:{id:randomUUID(),targetId:pending.target.id,targetName:pending.target.name,status:'copying',files:0,totalFiles:sources.length,bytes:0,totalBytes:pending.view.totalBytes,skipped:pending.sources.length-sources.length},targetIds:ids,controller:new AbortController()}
    this.job=job;job.task=this.copy(job,pending,sources).finally(()=>{job.task=undefined})
  }
  private save(journal:SessionJournal):void{const raw=encodeSessionJournal(journal);directory(this.root,true);const folder=join(this.root,journal.id);directory(folder,true);atomic(join(folder,'journal.json'),raw)}
  private load(id:string):SessionJournal{z.string().uuid().parse(id);directory(this.root);directory(join(this.root,id));const raw=readBounded(join(this.root,id,'journal.json'),sessionJournalLimit);const journal=sessionJournalSchema.parse(JSON.parse(raw??''));if(journal.id!==id)throw new Error('会话恢复记录身份不一致');return journal}
  private target(journal:SessionJournal):ClientConfigTarget{const target=this.configs.identityTarget(journal.targetId);if(target.directory!==journal.root)throw new Error('恢复记录不属于当前目标目录');checkRoot(journal);return target}
  private async copy(job:Job,pending:Pending,sources:SessionTransferSource[]):Promise<void>{
    const signal=job.controller.signal;let journal:SessionJournal|undefined
    try{
      const initial=this.configs.identityTarget(pending.target.id)
      if(initial.directory!==pending.target.directory||this.config(initial).hash!==pending.configHash||this.profileHash(initial.id)!==pending.profileHash)throw new Error('目标配置或实例在预览后发生变化')
      if(pending.rootIdentity){const stat=lstatSync(initial.directory);if(stat.dev!==pending.rootIdentity.device||stat.ino!==pending.rootIdentity.inode)throw new Error('目标目录在预览后发生变化')}
      else if(existsSync(initial.directory))throw new Error('目标目录已由其他进程创建，请重新预览')
      verifySessionProgram(pending.program)
      for(const id of job.targetIds){const target=this.configs.identityTarget(id);await this.closed(target,signal);this.configs.identityTarget(id)}
      for(const source of sources)await verifySource(source)
      if(!sources.length){job.view.status='completed';return}
      const target=this.configs.prepareIdentityTarget(initial.id),root=target.directory,existing=await this.existingIds(root,signal)
      if(sources.some(source=>existing.has(source.record.id)))throw new Error('目标已有新增的同 ID 会话，请重新预览')
      const staging=join(root,'.cml-session-transfer-'+job.view.id);mkdirSync(staging,{mode:0o700})
      journal={version:1,id:job.view.id,phase:'preparing',targetId:target.id,targetName:target.name,root,rootIdentity:fileIdentity(lstatSync(root)),stageIdentity:fileIdentity(lstatSync(staging)),configHash:pending.configHash,program:pending.program,sessionIds:sources.map(source=>source.record.id),files:[],metadata:[],createdAt:this.now()}
      this.save(journal)
      const indexBefore=readBounded(join(root,'session_index.jsonl'),16*1024*1024),globalBefore=readBounded(join(root,'.codex-global-state.json'),8*1024*1024)
      const sourceIndexes=pending.indexes??await this.sourceIndexes(sources,signal)
      let baseBytes=0
      for(const [index,source] of sources.entries()){
        signal.throwIfAborted();this.target(journal)
        const stage=index+'.jsonl',copied=await copySessionRollout(source,join(staging,stage),pending.view.provider,signal,bytes=>{job.view.bytes=baseBytes+bytes})
        const rel=sessionDestination(source,root,journal.files)
        journal.files.push({stage,relative:rel,...copied});this.save(journal);baseBytes+=source.size;job.view.files=index+1
      }
      const prepared:SessionJournal={...journal,phase:'prepared',metadata:this.metadata(sources,sourceIndexes,indexBefore,globalBefore,journal)}
      encodeSessionJournal(prepared)
      for(const id of job.targetIds)await this.closed(this.configs.identityTarget(id),signal)
      for(const source of sources)await verifySource(source)
      signal.throwIfAborted();this.target(journal)
      const finalExisting=await this.existingIds(root,signal);if(sources.some(source=>finalExisting.has(source.record.id)))throw new Error('复制期间目标出现了同 ID 会话，请重新预览')
      signal.throwIfAborted();this.save(prepared);journal=prepared;job.view.status='committing'
      publishSessionTransfer(journal);const committed:SessionJournal={...journal,phase:'committed'};this.save(committed);journal=committed;cleanupSessionStage(journal)
      job.view.status='indexing';this.catalog.stop()
      try{await this.rebuild(pending.program,root,journal.sessionIds,signal);journal.phase='done';this.save(journal)}
      catch(error){job.view.indexError=safeError(error);this.recovery.set(journal.id,{id:journal.id,targetId:target.id,targetName:target.name,message:'会话文件已复制，需重试 Codex 索引更新：'+job.view.indexError})}
      job.view.status='completed'
    }catch(error){
      job.view.error=safeError(error)
      if(journal&&['committed','done'].includes(journal.phase)){
        job.view.status='completed';job.view.indexError='会话已复制，清理或索引更新未完成，请重试恢复'
        this.recovery.set(journal.id,{id:journal.id,targetId:journal.targetId,targetName:journal.targetName,message:job.view.indexError})
      }else if(journal)try{await rollbackSessionTransfer(journal);journal.phase='rolled_back';this.save(journal);job.view.status=signal.aborted?'cancelled':'failed'}
      catch(cause){job.view.status='recovery_required';job.view.error=safeError(cause);this.recovery.set(journal.id,{id:journal.id,targetId:journal.targetId,targetName:journal.targetName,message:job.view.error})}
      else job.view.status=signal.aborted?'cancelled':'failed'
    }
  }
  async sourceIndexes(sources:SessionTransferSource[],signal:AbortSignal):Promise<Map<string,Record<string,unknown>>>{
    const result=new Map<string,Record<string,unknown>>()
    let selectedBytes=0
    for(const root of new Set(sources.map(source=>source.root))){
      const selected=new Set(sources.filter(source=>source.root===root).map(source=>source.record.id))
      let count=0
      try{const {file,stat}=await openSessionFile(root,join(root,'session_index.jsonl'));try{for await(const line of sessionLines(file,stat.size,signal)){if(++count>200000)throw new Error('来源会话索引超过 20 万行');const row=jsonLine(line),id=sessionIdentifier(row?.id);if(row&&id&&selected.has(id)){selectedBytes+=line.length;if(selectedBytes>32*1024*1024)throw new Error('所选会话索引超过 32 MiB，请分批复制');result.set(root+'\0'+id,row)}}}finally{await file.close()}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }
    return result
  }
  private metadata(sources:SessionTransferSource[],indexes:Map<string,Record<string,unknown>>,indexBefore:string|null,globalBefore:string|null,journal:SessionJournal):SessionJournal['metadata']{
    const replacements=new Map(sources.map((source,index)=>{
      const row:Record<string,unknown>={...indexes.get(source.root+'\0'+source.record.id),id:source.record.id,thread_name:source.record.title,updated_at:new Date(source.record.updatedAt??source.mtime).toISOString(),cwd:source.record.cwd}
      for(const key of ['rollout_path','rolloutPath','path'])if(typeof row[key]==='string')row[key]=isAbsolute(row[key])?join(journal.root,journal.files[index].relative):journal.files[index].relative
      return [source.record.id,row]
    }))
    const seen=new Set<string>(),lines=(indexBefore??'').split('\n')
    for(let index=0;index<lines.length;index++)try{const row=JSON.parse(lines[index]),next=replacements.get(row.id);if(next){lines[index]=JSON.stringify({...row,...next});seen.add(row.id)}}catch{/* Preserve unrelated and malformed index lines verbatim. */}
    if(lines.at(-1)==='')lines.pop()
    for(const [id,entry] of replacements)if(!seen.has(id))lines.push(JSON.stringify(entry))
    const global=globalBefore===null?{}:JSON.parse(globalBefore)
    if(!global||typeof global!=='object'||Array.isArray(global))throw new Error('目标全局会话状态格式无效，未覆盖原文件')
    for(const key of ['project-order','electron-saved-workspace-roots']){
      if(global[key]!==undefined&&(!Array.isArray(global[key])||global[key].some((value:unknown)=>typeof value!=='string')))throw new Error('目标项目索引格式无效，未覆盖原文件')
      const values:string[]=[...(global[key]??[])]
      for(const source of sources)if(isAbsolute(source.record.cwd)&&!values.includes(source.record.cwd))values.push(source.record.cwd)
      if(values.length||global[key]!==undefined)global[key]=values
    }
    return [{name:'session_index.jsonl',before:indexBefore,after:lines.join('\n')+'\n'},{name:'.codex-global-state.json',before:globalBefore,after:JSON.stringify(global,null,2)+'\n'}].map(item=>{if(Buffer.byteLength(item.after)>16*1024*1024)throw new Error('目标会话索引超过 16 MiB，请分批复制');return {...item,name:item.name as 'session_index.jsonl'|'.codex-global-state.json',beforeHash:textHash(item.before),afterHash:textHash(item.after)}})
  }
  async cancel(id:string):Promise<void>{z.string().uuid().parse(id);if(this.job?.view.id!==id)throw new Error('会话操作已更新');this.job.controller.abort();await this.job.task}
  async settled():Promise<void>{await this.job?.task}
  async stop():Promise<void>{this.discard();this.job?.controller.abort();await this.job?.task}
  async recover():Promise<void>{
    if(!existsSync(this.root))return;directory(this.root)
    for(const entry of readdirSync(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue
      let journal:SessionJournal|undefined
      try{
        journal=this.load(entry.name);if(['done','rolled_back'].includes(journal.phase))continue
        const target=this.target(journal);this.assertFree([target.id]);await this.closed(target,new AbortController().signal)
        if(journal.phase==='committed'){cleanupSessionStage(journal);this.recovery.set(journal.id,{id:journal.id,targetId:journal.targetId,targetName:journal.targetName,message:'会话文件已复制，需继续 Codex 索引更新'});continue}
        await rollbackSessionTransfer(journal);journal.phase='rolled_back';this.save(journal)
      }catch(error){this.recovery.set(entry.name,{id:entry.name,targetId:journal?.targetId??'',targetName:journal?.targetName??'未识别的目录',message:safeError(error)})}
    }
  }
  async retry(raw:unknown):Promise<void>{
    const input=z.object({id:z.string().uuid(),applicationId:z.string().min(1).max(100),clientsClosed:z.literal(true)}).strict().parse(raw)
    if(this.job?.task)throw new Error('请先完成当前会话操作')
    const journal=this.load(input.id),target=this.target(journal)
    if(this.inUse(target.id))throw new Error('目标目录仍在使用，请先停止客户端')
    const application=this.applications().find(app=>app.id===input.applicationId);if(!application)throw new Error('请选择 Codex 程序')
    const program=sessionProgram(application),job:Job={view:{id:journal.id,targetId:target.id,targetName:target.name,status:'indexing',files:journal.files.length,totalFiles:journal.files.length,bytes:0,totalBytes:0,skipped:0},targetIds:new Set([target.id]),controller:new AbortController()}
    this.job=job
    job.task=(async()=>{try{
      await this.closed(target,job.controller.signal);this.target(journal)
      if(journal.phase==='committed'){
        this.config(target);cleanupSessionStage(journal);await this.rebuild(program,target.directory,journal.sessionIds,job.controller.signal);journal.program=program;journal.phase='done'
      }else if(journal.phase!=='done'&&journal.phase!=='rolled_back'){await rollbackSessionTransfer(journal);journal.phase='rolled_back'}
      this.save(journal);this.recovery.delete(journal.id);job.view.status=journal.phase==='done'?'completed':'cancelled'
    }catch(error){job.view.status='recovery_required';job.view.error=safeError(error);this.recovery.set(journal.id,{id:journal.id,targetId:target.id,targetName:target.name,message:job.view.error})}})().finally(()=>{job.task=undefined})
    await job.task
  }
  backupLocation(id:string):string{z.string().uuid().parse(id);directory(this.root);const folder=join(this.root,id);directory(folder);if(!this.recovery.has(id))this.target(this.load(id));return folder}
}
