// All-session event merging follows Cockpit codex_thread_sync. Preview freezes
// merged, provider-projected files. Each home commits separately with backups.
import {randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,readdirSync,realpathSync,rmSync} from 'node:fs'
import {join,relative,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs,atomic,directory,readBounded} from './clientConfig'
import {SessionCatalog,type SessionTransferSource} from './sessions'
import {SessionTransfers,sessionDestination} from './sessionTransfers'
import {rolloutFiles,safeSessionPath} from './sessionFiles'
import {fileIdentity,textHash,verifySource,copySessionRollout} from './sessionTransferFiles'
import {hashSource} from './sessionZip'
import {mergeSessionCopies,type MergedSession} from './sessionMerge'
import {syncMetadata} from './sessionSyncMetadata'
import {createSyncJournal,encodeSyncJournal,syncJournalSchema,syncStage,verifySyncRoot,publishSync,rollbackSync,cleanupSync,type SyncJournal} from './sessionSyncFiles'
import {sessionProgram,verifySessionProgram,rebuildSessionMetadata,type SessionProgram} from './officialSessions'
import {syncPreviewSchema,syncStartSchema,type SyncPreview,type SyncView,type SyncRecovery,type SyncTargetPreview} from '../shared/sessionSync'
import type {ClientConfigTarget} from '../shared/clientConfig'
import type {InstanceApplication} from '../shared/instances'

type PlannedFile={merged:MergedSession;projected:SessionTransferSource;relative:string;sha256:string;originals:SessionTransferSource[];changed:boolean}
type Plan={target:ClientConfigTarget;view:SyncTargetPreview;rootIdentity?:{device:number;inode:number};configHash:string;profileHash:string;inventory:string;indexBefore:string|null;globalBefore:string|null;files:PlannedFile[];metadata:SyncJournal['metadata']}
type Pending={view:SyncPreview;root:string;plans:Plan[];sources:SessionTransferSource[];program:SessionProgram;applicationId:string;expires:number}
type Job={view:SyncView;ids:Set<string>;controller:AbortController;task?:Promise<unknown>}
function officialLocation(source:SessionTransferSource):boolean{
  const path=relative(source.root,source.path).split(sep).join('/'),match=path.match(/^(archived_sessions|sessions\/(\d{4})\/(\d{2})\/(\d{2}))\/rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([a-fA-F0-9-]+)(?:_([a-fA-F0-9-]+))?\.jsonl$/)
  return !!match&&match[8].toLowerCase()===source.record.id.toLowerCase()&&(!match[9]||z.string().uuid().safeParse(match[9]).success)&&(match[1]==='archived_sessions'||match.slice(2,5).join('-')===match.slice(5,8).join('-'))
}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep)
const safeError=(error:unknown)=>error instanceof Error&&/^(同步|会话|来源|目标|所选|请选择|相关|部分|Codex|已有|单个|合并)/.test(error.message)?error.message:'会话同步失败，请检查目录变化、权限和可用磁盘空间'
export class SessionSync {
  private readonly configs:ClientConfigs
  private readonly root:string
  private readonly scratch:string
  private pending?:Pending
  private job?:Job
  private timer?:NodeJS.Timeout
  private readonly recovery=new Map<string,SyncRecovery>()
  constructor(private readonly store:Store,private readonly transfers:SessionTransfers,private readonly applications:()=>InstanceApplication[],private readonly inUse:(id:string)=>boolean=()=>false,private readonly rebuild:typeof rebuildSessionMetadata=rebuildSessionMetadata,private readonly now:()=>number=Date.now){
    this.configs=new ClientConfigs(store);const root=realpathSync(store.directory);this.root=join(root,'session-sync');this.scratch=join(root,'session-sync-previews')
    if(existsSync(this.scratch)){directory(this.scratch);for(const entry of readdirSync(this.scratch,{withFileTypes:true}))if(entry.isDirectory()&&z.string().uuid().safeParse(entry.name).success)rmSync(join(this.scratch,entry.name),{recursive:true})}
  }
  view():{sync?:SyncView;recoveries:SyncRecovery[]}{return {sync:this.job?structuredClone(this.job.view):undefined,recoveries:[...this.recovery.values()].map(value=>({...value}))}}
  busy(id:string):boolean{return !!this.job?.task&&this.job.ids.has(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id)}
  private free(ids:Iterable<string>):void{for(const id of ids)if(this.inUse(id)||this.transfers.busy(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id))throw new Error('相关目录正在使用或等待恢复，请先关闭客户端并处理恢复记录')}
  private profileHash(id:string):string{return textHash(JSON.stringify(this.store.read().instances?.find(item=>item.id===id)??null))}
  private available():void{if(this.job?.task)throw new Error('已有会话同步正在执行')}
  private clear():void{clearTimeout(this.timer);if(this.pending){directory(this.scratch);directory(this.pending.root);rmSync(this.pending.root,{recursive:true});this.pending=undefined};if(this.job?.view.status==='ready')this.job.view.status='cancelled'}
  async discard():Promise<void>{if(this.job?.task&&this.job.view.status==='preparing')await this.cancel(this.job.view.id);if(!this.job?.task)this.clear()}
  private begin(ids:string[],status:SyncView['status']):Job{this.available();const job:Job={ids:new Set(ids),controller:new AbortController(),view:{id:randomUUID(),status,targets:[],completedTargets:[],sourceFiles:0,processedFiles:0,bytes:0,totalBytes:0,backups:[]}};this.job=job;return job}
  private async execute<T>(job:Job,action:()=>Promise<T>):Promise<T>{const task=action();job.task=task;try{return await task}catch(error){job.view.status=job.controller.signal.aborted?'cancelled':'failed';job.view.error=job.controller.signal.aborted?'同步已取消':safeError(error);throw new Error(job.view.error)}finally{job.task=undefined}}
  private async inventory(root:string,signal:AbortSignal):Promise<string>{
    if(!existsSync(root))return textHash(null)
    const rows:string[]=[]
    for await(const path of rolloutFiles(root,signal)){const stat=await safeSessionPath(root,path);rows.push(JSON.stringify([relative(root,path),stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]));if(rows.length>100000)throw new Error('同步目录超过 10 万个文件')}
    return textHash(rows.sort().join('\n'))
  }
  private validate(plan:Plan):ClientConfigTarget{
    const target=this.configs.identityTarget(plan.target.id)
    if(target.directory!==plan.target.directory||this.profileHash(target.id)!==plan.profileHash||this.transfers.config(target).hash!==plan.configHash)throw new Error('同步目标配置或实例在预览后发生变化')
    if(plan.rootIdentity){const stat=lstatSync(target.directory);if(stat.dev!==plan.rootIdentity.device||stat.ino!==plan.rootIdentity.inode)throw new Error('同步目标目录在预览后发生变化')}
    else if(existsSync(target.directory))throw new Error('同步目标目录已被其他进程创建')
    if(readBounded(join(target.directory,'session_index.jsonl'),16*1024**2)!==plan.indexBefore||readBounded(join(target.directory,'.codex-global-state.json'),16*1024**2)!==plan.globalBefore)throw new Error('同步目标索引在预览后发生变化')
    return target
  }
  async preview(raw:unknown):Promise<SyncPreview>{
    const input=syncPreviewSchema.parse(raw),ids=[...new Set(input.targetIds)];if(ids.length<2)throw new Error('请选择至少两个不同的 Codex 目录')
    this.available();this.free(ids);this.clear();const job=this.begin(ids,'preparing'),signal=job.controller.signal
    return this.execute(job,async()=>{
      const targets=ids.map(id=>this.configs.identityTarget(id)),application=this.applications().find(app=>app.id===input.applicationId);if(!application)throw new Error('请选择已登记的 Codex 程序')
      for(let i=0;i<targets.length;i++)for(const other of targets.slice(i+1))if(overlap(targets[i].directory,other.directory))throw new Error('同步目录不能相互包含')
      const program=sessionProgram(application),plans:Plan[]=[],sources:SessionTransferSource[]=[]
      for(const target of targets){
        await this.transfers.closed(target,signal);const config=this.transfers.config(target)
        const plan:Plan={target,view:{id:target.id,name:target.name,directory:target.directory,added:0,updated:0,unchanged:0,duplicates:0,repairsWorkspace:false,repairsIndex:false},rootIdentity:existsSync(target.directory)?fileIdentity(lstatSync(target.directory)):undefined,configHash:config.hash,profileHash:this.profileHash(target.id),inventory:await this.inventory(target.directory,signal),indexBefore:readBounded(join(target.directory,'session_index.jsonl'),16*1024**2),globalBefore:readBounded(join(target.directory,'.codex-global-state.json'),16*1024**2),files:[],metadata:[]}
        const catalog=new SessionCatalog(this.store),cancel=()=>catalog.stop();signal.addEventListener('abort',cancel,{once:true})
        try{signal.throwIfAborted();const page=await catalog.scan({runId:randomUUID(),targetId:target.id});sources.push(...await catalog.syncSources(page.snapshotId,signal))}finally{signal.removeEventListener('abort',cancel);catalog.stop()}
        this.validate(plan);if(await this.inventory(target.directory,signal)!==plan.inventory)throw new Error('同步扫描期间会话文件发生变化');plans.push(plan)
      }
      const bytes=sources.reduce((sum,source)=>sum+source.size,0)
      if(sources.length>10000||bytes>100*1024**3||bytes*targets.length>100*1024**3)throw new Error('同步范围超过暂存限制（1 万份副本或 100 GiB），请选择更少目录')
      Object.assign(job.view,{sourceFiles:sources.length,totalBytes:bytes});directory(this.scratch,true);const root=join(this.scratch,randomUUID());mkdirSync(root,{mode:0o700})
      try{
        const indexes=await this.transfers.sourceIndexes(sources,signal),merged=await mergeSessionCopies(root,sources,indexes,signal,(files,bytes)=>{job.view.processedFiles=files;job.view.bytes=bytes})
        const originalHashes=new Map<string,string>();for(const source of sources)originalHashes.set(source.path,await hashSource(source,signal,()=>{}))
        for(const plan of plans){
          signal.throwIfAborted();this.validate(plan);const projectedRoot=join(root,plan.target.id);mkdirSync(projectedRoot,{mode:0o700});mkdirSync(join(projectedRoot,'sessions'),{mode:0o700});const provider=this.transfers.config(plan.target).provider
          for(const item of merged){
            const originals=item.originals.filter(source=>source.targetId===plan.target.id),destination=join(projectedRoot,'sessions','rollout-'+item.source.record.id+'.jsonl'),copied=await copySessionRollout(item.source,destination,provider,signal,()=>{}),stat=lstatSync(destination),rootStat=lstatSync(projectedRoot)
            const archived=item.source.record.locations[0].archived,existing=originals.find(source=>source.record.locations[0].archived===archived&&officialLocation(source)),rel=existing?relative(plan.target.directory,existing.path).split(sep).join('/'):sessionDestination(item.source,plan.target.directory,plan.files)
            const projected:SessionTransferSource={...item.source,path:destination,root:projectedRoot,rootDevice:rootStat.dev,rootInode:rootStat.ino,...fileIdentity(stat),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs}
            const changed=originals.length!==1||originals[0]!==existing||originalHashes.get(originals[0].path)!==copied.sha256||Math.trunc(originals[0].mtime)!==Math.trunc(stat.mtimeMs)
            plan.files.push({merged:item,projected,relative:rel,sha256:copied.sha256,originals,changed});plan.view[!originals.length?'added':changed?'updated':'unchanged']++;plan.view.duplicates+=Math.max(0,originals.length-1)
          }
          const result=syncMetadata(plan.target.directory,plan.files,plan.indexBefore,plan.globalBefore);plan.metadata=result.metadata;plan.view.repairsWorkspace=result.repairsWorkspace;plan.view.repairsIndex=result.metadata.some(item=>item.name==='session_index.jsonl')
          // Bound the journal before offering a confirmation; Unicode escaping
          // and before/after metadata can exceed the nominal source size.
          const journalEstimate=JSON.stringify(plan.metadata);if(Buffer.byteLength(journalEstimate)>38*1024**2)throw new Error('同步恢复索引超过 38 MiB，请整理索引')
        }
        for(const plan of plans){this.validate(plan);if(await this.inventory(plan.target.directory,signal)!==plan.inventory)throw new Error('同步准备期间会话文件发生变化')}
        verifySessionProgram(program);signal.throwIfAborted()
        const view:SyncPreview={ticket:randomUUID(),sessionCount:merged.length,sourceFiles:sources.length,totalBytes:bytes,targets:plans.map(plan=>plan.view)}
        this.pending={view,root,plans,sources,program,applicationId:input.applicationId,expires:this.now()+300000};Object.assign(job.view,{status:'ready',targets:view.targets})
        this.timer=setTimeout(()=>{if(!this.job?.task)this.clear()},300000);this.timer.unref();return structuredClone(view)
      }catch(error){directory(root);rmSync(root,{recursive:true});throw error}
    })
  }
  start(raw:unknown):void{
    const input=syncStartSchema.parse(raw),pending=this.pending;this.available()
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('同步预览已过期，请重新预览')
    this.free(pending.plans.map(plan=>plan.target.id));clearTimeout(this.timer);this.pending=undefined
    const job=this.begin(pending.plans.map(plan=>plan.target.id),'running');Object.assign(job.view,{targets:pending.view.targets,sourceFiles:pending.sources.length,totalBytes:pending.plans.reduce((sum,plan)=>sum+plan.files.filter(file=>file.changed).reduce((sum,file)=>sum+file.projected.size,0),0)})
    void this.execute(job,()=>this.run(job,pending)).catch(()=>{})
  }
  private save(journal:SyncJournal):void{const raw=encodeSyncJournal(journal);directory(this.root,true);directory(join(this.root,journal.id),true);atomic(join(this.root,journal.id,'journal.json'),raw)}
  private load(id:string):SyncJournal{z.string().uuid().parse(id);directory(this.root);directory(join(this.root,id));const journal=syncJournalSchema.parse(JSON.parse(readBounded(join(this.root,id,'journal.json'),40*1024**2)??''));if(journal.id!==id)throw new Error('同步恢复记录身份不一致');return journal}
  private target(journal:SyncJournal):ClientConfigTarget{const target=this.configs.identityTarget(journal.targetId);if(target.directory!==journal.root)throw new Error('同步恢复记录不属于已登记目录');verifySyncRoot(journal);return target}
  private needsRecovery(journal:SyncJournal,message:string):void{this.recovery.set(journal.id,{id:journal.id,targetId:journal.targetId,targetName:journal.targetName,message})}
  private async run(job:Job,pending:Pending):Promise<void>{
    const signal=job.controller.signal;let current:SyncJournal|undefined
    try{
      const application=this.applications().find(app=>app.id===pending.applicationId);if(!application||sessionProgram(application).path!==pending.program.path)throw new Error('Codex 程序登记已变化');verifySessionProgram(pending.program)
      for(const plan of pending.plans){await this.transfers.closed(this.validate(plan),signal);if(await this.inventory(plan.target.directory,signal)!==plan.inventory)throw new Error('同步预览后会话文件发生变化')}
      for(const source of pending.sources)await verifySource(source)
      for(const plan of pending.plans){
        signal.throwIfAborted();current=undefined;job.view.currentTarget=plan.target.id
        await this.transfers.closed(this.validate(plan),signal);if(await this.inventory(plan.target.directory,signal)!==plan.inventory)throw new Error('同步目标文件在提交前发生变化')
        const changed=plan.files.filter(file=>file.changed)
        if(!changed.length&&!plan.metadata.length){job.view.completedTargets.push(plan.target.id);continue}
        const target=this.configs.prepareIdentityTarget(plan.target.id)
        current=createSyncJournal(randomUUID(),target.id,target.name,target.directory,plan.configHash,pending.program)
        try{this.save(current)}catch(error){current.phase='rolled_back';cleanupSync(current);current=undefined;throw error}
        for(const file of changed)for(const original of file.originals){await verifySource(original);current.originals.push({relative:relative(current.root,original.path).split(sep).join('/'),stage:'old-'+current.originals.length+'.jsonl',...fileIdentity(lstatSync(original.path)),size:original.size,sha256:await hashSource(original,signal,()=>{})})}
        this.save(current)
        const provider=this.transfers.config(target).provider
        for(const [index,file] of changed.entries()){
          signal.throwIfAborted();this.target(current)
          const stage='new-'+index+'.jsonl',before=job.view.bytes,copied=await copySessionRollout(file.projected,join(syncStage(current),stage),provider,signal,bytes=>{job.view.bytes=before+bytes})
          if(copied.sha256!==file.sha256)throw new Error('同步暂存内容与预览不一致')
          current.outputs.push({relative:file.relative,stage,...copied});this.save(current);job.view.processedFiles++
        }
        await this.transfers.closed(target,signal);this.target(current)
        if(await this.inventory(target.directory,signal)!==(plan.rootIdentity?plan.inventory:textHash('')))throw new Error('同步目标会话在准备期间发生变化')
        verifySessionProgram(pending.program);signal.throwIfAborted()
        current={...current,metadata:plan.metadata,sessionIds:plan.files.map(file=>file.merged.source.record.id),phase:'prepared'};this.save(current)
        await publishSync(current,signal);const committed:SyncJournal={...current,phase:'committed'};this.save(committed);current=committed
        job.view.completedTargets.push(target.id);job.view.backups.push({targetId:target.id,id:current.id});cleanupSync(current)
        try{await this.rebuild(pending.program,target.directory,current.sessionIds,signal);current.phase='done';this.save(current)}
        catch(error){current.phase='committed';this.needsRecovery(current,'会话已同步，需重试 Codex 索引更新：'+safeError(error))}
      }
      signal.throwIfAborted();job.view.status='completed'
    }catch(error){
      if(current){
        if(['committed','done'].includes(current.phase))this.needsRecovery(current,'会话已同步，清理或索引更新未完成，请重试恢复')
        else try{await rollbackSync(current);current.phase='rolled_back';this.save(current);cleanupSync(current)}catch(cause){this.needsRecovery(current,safeError(cause))}
      }
      throw error
    }finally{job.view.currentTarget=undefined;directory(pending.root);rmSync(pending.root,{recursive:true})}
  }
  async settled():Promise<void>{await this.job?.task?.catch(()=>{})}
  async cancel(id:string):Promise<void>{z.string().uuid().parse(id);if(this.job?.view.id!==id)throw new Error('同步任务已变化');this.job.controller.abort();await this.settled();if(this.pending)this.clear()}
  async stop():Promise<void>{this.job?.controller.abort();await this.settled();this.clear()}
  async recover():Promise<void>{
    if(!existsSync(this.root))return;directory(this.root)
    for(const entry of readdirSync(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue
      let journal:SyncJournal|undefined
      try{
        journal=this.load(entry.name);if(journal.phase==='done')continue
        const target=this.target(journal);if(this.inUse(target.id)||this.transfers.busy(target.id))throw new Error('同步目录正在使用，请停止客户端后恢复')
        await this.transfers.closed(target,new AbortController().signal)
        if(journal.phase==='rolled_back'){cleanupSync(journal);continue}
        if(journal.phase==='committed'){cleanupSync(journal);this.needsRecovery(journal,'会话已同步，需继续 Codex 索引更新');continue}
        await rollbackSync(journal);journal.phase='rolled_back';this.save(journal);cleanupSync(journal)
      }catch(error){this.recovery.set(entry.name,{id:entry.name,targetId:journal?.targetId??'',targetName:journal?.targetName??'未识别的目录',message:safeError(error)})}
    }
  }
  async retry(raw:unknown):Promise<void>{
    const input=z.object({id:z.string().uuid(),applicationId:z.string().min(1).max(100),clientsClosed:z.literal(true)}).strict().parse(raw);this.available()
    const journal=this.load(input.id),target=this.target(journal);if(this.inUse(target.id)||this.transfers.busy(target.id))throw new Error('同步目录正在使用，请停止客户端后恢复')
    const application=this.applications().find(app=>app.id===input.applicationId);if(!application)throw new Error('请选择 Codex 程序')
    const program=sessionProgram(application),job=this.begin([target.id],'running')
    job.view.targets=[{id:target.id,name:target.name,directory:target.directory,added:0,updated:0,unchanged:journal.sessionIds.length,duplicates:0,repairsWorkspace:false,repairsIndex:false}];job.view.currentTarget=target.id;job.view.backups=[{targetId:target.id,id:journal.id}]
    await this.execute(job,async()=>{try{
      await this.transfers.closed(target,job.controller.signal);this.target(journal)
      if(journal.phase==='committed'){this.transfers.config(target);cleanupSync(journal);await this.rebuild(program,target.directory,journal.sessionIds,job.controller.signal);journal.program=program;journal.phase='done'}
      else if(journal.phase!=='done'&&journal.phase!=='rolled_back'){await rollbackSync(journal);journal.phase='rolled_back'}
      this.save(journal);cleanupSync(journal);this.recovery.delete(journal.id);job.view.status='completed';job.view.completedTargets.push(target.id)
    }catch(error){this.needsRecovery(journal,safeError(error));throw error}finally{job.view.currentTarget=undefined}})
  }
  backupLocation(id:string):string{z.string().uuid().parse(id);if(this.recovery.get(id)?.targetId===''){directory(this.root);const folder=join(this.root,id);directory(folder);return folder};const journal=this.load(id);this.target(journal);const folder=existsSync(syncStage(journal))?syncStage(journal):join(this.root,id);directory(folder);return folder}
}
