// All-session event merging follows Cockpit codex_thread_sync. Preview freezes
// merged, provider-projected files. Each home commits separately with backups.
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,readdirSync,realpathSync,rmSync} from 'node:fs'
import {join,relative,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs,atomic,directory,readBounded} from './clientConfig'
import {SessionCatalog,type SessionTransferSource} from './sessions'
import type {SessionRecord} from '../shared/sessions'
import {SessionTransfers,sessionDestination} from './sessionTransfers'
import {rolloutFiles,safeSessionPath,openSessionFile,firstSessionEvent,sessionIdentifier} from './sessionFiles'
import {fileIdentity,textHash,verifySource,copySessionRollout} from './sessionTransferFiles'
import {hashSource} from './sessionZip'
import {mergeSessionCopies,type MergedSession} from './sessionMerge'
import {syncMetadata} from './sessionSyncMetadata'
import {createSyncJournal,encodeSyncJournal,syncJournalSchema,syncStage,verifySyncRoot,verifySyncFile,publishSync,rollbackSync,cleanupSync,type SyncJournal} from './sessionSyncFiles'
import {sessionProgram,verifySessionProgram,rebuildSessionMetadata,type SessionProgram} from './officialSessions'
import {legacySyncPreviewSchema,directionalSyncPreviewSchema,syncConflictScanSchema,syncStartSchema,type SyncConflictScanInput,type SyncConflictSession,type SyncPreview,type SyncView,type SyncRecovery,type SyncTargetPreview,type DirectionalSyncPreviewInput} from '../shared/sessionSync'
import type {ClientConfigTarget} from '../shared/clientConfig'
import type {InstanceApplication} from '../shared/instances'
import {assertUnpagedSessionSources} from './sessionPaging'
import {CodexSessionSources} from './codexSessionSources'
import {probeClientDaemon} from './clientDaemon'
import {inspectCodexPaginatedSession,inspectCodexPaginatedTransferTarget,transferCodexPaginatedSession,recoverCodexPaginatedTransfers} from './codexPaginatedSessionTransfer'
import {instanceHomePath} from './instancePaths'

type PlannedFile={merged:MergedSession;projected:SessionTransferSource;relative:string;sha256:string;originals:SessionTransferSource[];changed:boolean}
type Plan={target:ClientConfigTarget;view:SyncTargetPreview;rootIdentity?:{device:number;inode:number};configHash:string;profileHash:string;inventory:string;indexBefore:string|null;globalBefore:string|null;files:PlannedFile[];metadata:SyncJournal['metadata']}
type SourceGuard=
  |{kind:'instance';target:ClientConfigTarget;rootIdentity?:{device:number;inode:number};profileHash:string;configHash:string;inventory:string;indexBefore:string|null;globalBefore:string|null}
  |{kind:'external';id:string;name:string;directory:string;device:number;inode:number;inventory:string}
type DirectionalSource=ClientConfigTarget&{role:'instance'|'external';device?:number;inode?:number}
type PaginatedPending={sourceId:string;sourceRole:'instance'|'external';sourceName:string;sourceInventory:string;targetId:string;sourceHome:string;targetHome:string;sessionId:string;title:string;expectedRolloutPath:string;expectedRecordFingerprint:string;expectedSourceFingerprint:string;expectedTargetFingerprint:string;rollouts:number;bytes:number;sourceProfileHash:string;targetProfileHash:string;sourceConfigHash:string;targetConfigHash:string;sourceRootIdentity:{device:number;inode:number};targetRootIdentity:{device:number;inode:number}}
type Pending={view:SyncPreview;root:string;plans:Plan[];guards:SourceGuard[];sources:SessionTransferSource[];program:SessionProgram;applicationId:string;expires:number;paginated?:PaginatedPending}
type Job={view:SyncView;ids:Set<string>;controller:AbortController;task?:Promise<unknown>}
function officialLocation(source:SessionTransferSource):boolean{
  const path=relative(source.root,source.path).split(sep).join('/'),match=path.match(/^(archived_sessions|sessions\/(\d{4})\/(\d{2})\/(\d{2}))\/rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([a-fA-F0-9-]+)(?:_([a-fA-F0-9-]+))?\.jsonl$/)
  return !!match&&match[8].toLowerCase()===source.record.id.toLowerCase()&&(!match[9]||z.string().uuid().safeParse(match[9]).success)&&(match[1]==='archived_sessions'||match.slice(2,5).join('-')===match.slice(5,8).join('-'))
}
function paginatedSession(record:SessionRecord):boolean{return record.historyMode==='paginated'||record.locations.some(location=>location.historyMode==='paginated'||location.versions?.some(version=>version.historyMode==='paginated'))}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep)
const safeError=(error:unknown)=>error instanceof Error&&/^(同步|会话|来源|目标|所选|请选择|相关|部分|Codex|已有|单个|合并|已提交)/.test(error.message)?error.message:'会话同步失败，请检查目录变化、权限和可用磁盘空间'
export class SessionSync {
  private readonly configs:ClientConfigs
  private readonly codexSessionSources:CodexSessionSources
  private readonly root:string
  private readonly scratch:string
  private pending?:Pending
  private job?:Job
  private timer?:NodeJS.Timeout
  private readonly recovery=new Map<string,SyncRecovery>()
  private readonly paginatedBackups=new Map<string,string>()
  private readonly paginatedRecovery=new Map<string,{targetId:string;targetHome:string;targetName:string;directory:string}>()
  private readonly conflictScans=new Map<string,AbortController>()
  constructor(private readonly store:Store,private readonly transfers:SessionTransfers,private readonly applications:()=>InstanceApplication[],private readonly inUse:(id:string)=>boolean=()=>false,private readonly rebuild:typeof rebuildSessionMetadata=rebuildSessionMetadata,private readonly now:()=>number=Date.now){
    this.configs=new ClientConfigs(store);this.codexSessionSources=new CodexSessionSources(store);const root=realpathSync(store.directory);this.root=join(root,'session-sync');this.scratch=join(root,'session-sync-previews')
    if(existsSync(this.scratch)){directory(this.scratch);for(const entry of readdirSync(this.scratch,{withFileTypes:true}))if(entry.isDirectory()&&z.string().uuid().safeParse(entry.name).success)rmSync(join(this.scratch,entry.name),{recursive:true})}
  }
  view():{sync?:SyncView;recoveries:SyncRecovery[]}{return {sync:this.job?structuredClone(this.job.view):undefined,recoveries:[...this.recovery.values()].map(value=>({...value,...this.paginatedRecovery.has(value.id)?{kind:'codex_paginated' as const}:{} }))}}
  busy(id:string):boolean{return !!this.job?.task&&this.job.ids.has(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id)||[...this.paginatedRecovery.values()].some(item=>item.targetId===id)}
  private free(ids:Iterable<string>):void{for(const id of ids)if(this.inUse(id)||this.transfers.busy(id)||[...this.recovery.values()].some(item=>!item.targetId||item.targetId===id)||[...this.paginatedRecovery.values()].some(item=>item.targetId===id))throw new Error('相关目录正在使用或等待恢复，请先关闭客户端并处理恢复记录')}
  private profileHash(id:string):string{return textHash(JSON.stringify(this.store.read().instances?.find(item=>item.id===id)??null))}
  private directionalSource(id:string):DirectionalSource{
    if((this.store.read().codexSessionSources??[]).some(source=>source.id===id)){const source=this.codexSessionSources.resolve(id);return {id:source.id,name:source.name,directory:source.directory,managed:false,role:'external',device:source.device,inode:source.inode}}
    let target:ClientConfigTarget
    try{target=this.configs.identityTarget(id)}catch{throw new Error('同步来源必须是已登记实例或已登记的只读 Codex 来源')}
    if(target.role!=='instance')throw new Error('同步来源必须是已登记实例或已登记的只读 Codex 来源')
    return {...target,role:'instance'}
  }
  private sourceVersionId(source:SessionTransferSource):string{return createHash('sha256').update(JSON.stringify([source.path,source.device,source.inode,source.size,source.mtime,source.ctime])).digest('hex').slice(0,32)}
  private async paginatedFileVersions(root:string,id:string,signal:AbortSignal):Promise<Array<{path:string;versionId:string}>>{
    const rootStat=lstatSync(root),found:Array<{path:string;versionId:string}>=[]
    for await(const path of rolloutFiles(root,signal)){
      signal.throwIfAborted();const stat=await safeSessionPath(root,path);if(!stat.isFile()||stat.nlink!==1)continue
      const opened=await openSessionFile(root,path)
      try{const meta=await firstSessionEvent(opened.file,opened.stat.size,signal),foundId=meta?.type==='session_meta'?sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id):undefined;if(foundId!==id)continue
        const row:SessionTransferSource={path,root,targetId:'',rootDevice:rootStat.dev,rootInode:rootStat.ino,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:{id,title:'',cwd:'',kind:'conversation',locations:[]}}
        found.push({path,versionId:this.sourceVersionId(row)})
      }finally{await opened.file.close()}
    }
    return found
  }
  private async externalCopies(source:DirectionalSource,records:SessionRecord[],selections:NonNullable<DirectionalSyncPreviewInput['sourceSelections']>,signal:AbortSignal):Promise<SessionTransferSource[]>{
    const rootStat=lstatSync(source.directory),wanted=new Set(records.map(record=>record.id)),found=new Map<string,SessionTransferSource[]>()
    for await(const path of rolloutFiles(source.directory,signal)){
      signal.throwIfAborted();const safe=await safeSessionPath(source.directory,path);if(!safe.isFile()||safe.nlink!==1)continue
      const opened=await openSessionFile(source.directory,path)
      try{
        const meta=await firstSessionEvent(opened.file,opened.stat.size,signal),id=meta?.type==='session_meta'?sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id):undefined
        if(!id||!wanted.has(id))continue
        const record=records.find(row=>row.id===id)!;if(record.historyMode==='paginated')continue
        const copy:SessionTransferSource={path,root:source.directory,targetId:source.id,rootDevice:rootStat.dev,rootInode:rootStat.ino,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(record)}
        found.set(id,[...found.get(id)??[],copy])
      }finally{await opened.file.close()}
    }
    const result:SessionTransferSource[]=[]
    for(const record of records){if(record.historyMode==='paginated')continue;const location=record.locations.find(value=>value.targetId===source.id);if(!location)continue
      const candidates=(found.get(record.id)??[]).sort((a,b)=>{const relativePath=(value:SessionTransferSource)=>relative(value.root,value.path).split(sep).join('/');return relativePath(a).startsWith('archived_sessions/')===relativePath(b).startsWith('archived_sessions/')?relativePath(a).localeCompare(relativePath(b)):relativePath(a).startsWith('archived_sessions/')?1:-1})
      const selected=selections.find(selection=>selection.sessionId===record.id)
      if(location.ambiguous){if(!selected?.versionId)throw new Error('会话 '+record.title+' 在只读来源中存在多个同 ID 文件，请选择具体版本后再同步');const choice=candidates.find(candidate=>this.sourceVersionId(candidate)===selected.versionId);if(!choice)throw new Error('所选会话版本不属于指定来源目录，请刷新列表');result.push({...choice,sourceVersionId:selected.versionId,sourceConflict:true})}
      else{if(selected)throw new Error('会话来源文件版本已变化，请刷新列表');const candidate=candidates[0];if(candidate)result.push(candidate)}
    }
    return result
  }
  private available():void{if(this.job?.task)throw new Error('已有会话同步正在执行')}
  private clear():void{clearTimeout(this.timer);if(this.pending){if(this.pending.root){directory(this.scratch);directory(this.pending.root);rmSync(this.pending.root,{recursive:true})};this.pending=undefined};if(this.job?.view.status==='ready')this.job.view.status='cancelled'}
  async discard():Promise<void>{if(this.job?.task&&this.job.view.status==='preparing')await this.cancel(this.job.view.id);if(!this.job?.task)this.clear()}
  private begin(ids:string[],status:SyncView['status']):Job{this.available();const job:Job={ids:new Set(ids),controller:new AbortController(),view:{id:randomUUID(),status,targets:[],completedTargets:[],sourceFiles:0,processedFiles:0,bytes:0,totalBytes:0,backups:[]}};this.job=job;return job}
  private async execute<T>(job:Job,action:()=>Promise<T>):Promise<T>{const task=action();job.task=task;try{return await task}catch(error){job.view.status=job.controller.signal.aborted?'cancelled':'failed';job.view.error=job.controller.signal.aborted?'同步已取消':safeError(error);throw new Error(job.view.error)}finally{job.task=undefined}}
  private async inventory(root:string,signal:AbortSignal):Promise<string>{
    if(!existsSync(root))return textHash(null)
    const rows:string[]=[]
    for await(const path of rolloutFiles(root,signal)){const stat=await safeSessionPath(root,path);rows.push(JSON.stringify([relative(root,path),stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]));if(rows.length>100000)throw new Error('同步目录超过 10 万个文件')}
    return textHash(rows.sort().join('\n'))
  }
  async conflicts(raw:unknown,signal=new AbortController().signal):Promise<SyncConflictSession[]>{
    const input=syncConflictScanSchema.parse(raw) as SyncConflictScanInput
    if(input.sourceIds.includes(input.targetId))throw new Error('目标实例不能同时作为来源')
    for(const id of [input.targetId,...input.sourceIds])if(this.busy(id)||this.transfers.busy(id))throw new Error('相关目录正在执行会话操作或等待恢复，请稍后刷新冲突列表')
    if((this.store.read().codexSessionSources??[]).some(source=>source.id===input.targetId))throw new Error('只读会话来源不能作为同步目标')
    const targets=input.sourceIds.map(id=>this.directionalSource(id)),target=this.configs.identityTarget(input.targetId)
    if(target.role!=='instance')throw new Error('同步目标必须是已登记的 Codex 实例目录')
    const directories=[...targets.map(value=>value.directory),target.directory]
    for(let i=0;i<directories.length;i++)for(const other of directories.slice(i+1))if(overlap(directories[i],other))throw new Error('同步来源和目标目录不能相互包含或别名重叠')
    if(this.conflictScans.has(input.requestId))throw new Error('冲突检查请求 ID 重复')
    const controller=new AbortController(),cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});this.conflictScans.set(input.requestId,controller)
    const scanSignal=controller.signal
    const result=new Map<string,SyncConflictSession>();let versionCount=0,choiceCount=0
    let scannedRecords=0
    try{for(const source of targets){
      scanSignal.throwIfAborted()
      const catalog=new SessionCatalog(this.store,undefined,{disableSqliteDisplay:true})
      try{
        const stopCatalog=()=>catalog.stop();scanSignal.addEventListener('abort',stopCatalog,{once:true})
        let scanned
        try{scanned=await catalog.scan({runId:input.requestId,targetId:source.id,clientType:'codex'})}finally{scanSignal.removeEventListener('abort',stopCatalog)}
        scanSignal.throwIfAborted()
        if(scanned.warnings.length)throw new Error('部分会话来源未读取完整：'+scanned.warnings[0])
        scannedRecords+=scanned.total
        if(scannedRecords>100000)throw new Error('冲突检查扫描超过 10 万条会话，请减少来源实例后重试')
        const first=catalog.page({snapshotId:scanned.snapshotId,page:1,pageSize:100}),pages=Math.ceil(first.total/100)
        for(let pageNumber=1;pageNumber<=pages;pageNumber++){
          scanSignal.throwIfAborted()
          const page=pageNumber===1?first:catalog.page({snapshotId:first.snapshotId,page:pageNumber,pageSize:100})
          for(const record of page.items){
            const locations=record.locations.filter(location=>location.targetId===source.id&&location.ambiguous&&location.versions?.length).map(location=>({targetId:location.targetId,name:location.name,directory:location.directory,ambiguous:true as const,versions:location.versions!.map(version=>({id:version.id,label:version.label,archived:version.archived,updatedAt:version.updatedAt}))}))
            if(!locations.length)continue
            versionCount+=locations.reduce((sum,location)=>sum+location.versions.length,0)
            if(versionCount>10000)throw new Error('同 ID 冲突文件版本超过 10000 个，请缩小同步范围后重试')
            choiceCount+=locations.length
            if(choiceCount>1000)throw new Error('同 ID 冲突来源超过 1000 项，请缩小同步范围后重试')
            const existing=result.get(record.id)
            if(existing){for(const location of locations)if(!existing.locations.some(value=>value.targetId===location.targetId))existing.locations.push(location)}
            else result.set(record.id,{id:record.id,title:record.title,locations})
            if(result.size>1000)throw new Error('同 ID 冲突会话超过 1000 条，请缩小同步范围后重试')
          }
        }
      }finally{catalog.stop()}
      }
      scanSignal.throwIfAborted()
      return [...result.values()].sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id))
    }finally{signal.removeEventListener('abort',cancel);if(this.conflictScans.get(input.requestId)===controller)this.conflictScans.delete(input.requestId)}
  }
  cancelConflicts(raw:unknown):void{const id=z.string().uuid().parse(raw);this.conflictScans.get(id)?.abort()}
  private validate(plan:Plan):ClientConfigTarget{
    const target=this.configs.identityTarget(plan.target.id)
    if(target.directory!==plan.target.directory||this.profileHash(target.id)!==plan.profileHash||this.transfers.config(target).hash!==plan.configHash)throw new Error('同步目标配置或实例在预览后发生变化')
    if(plan.rootIdentity){const stat=lstatSync(target.directory);if(stat.dev!==plan.rootIdentity.device||stat.ino!==plan.rootIdentity.inode)throw new Error('同步目标目录在预览后发生变化')}
    else if(existsSync(target.directory))throw new Error('同步目标目录已被其他进程创建')
    if(readBounded(join(target.directory,'session_index.jsonl'),16*1024**2)!==plan.indexBefore||readBounded(join(target.directory,'.codex-global-state.json'),16*1024**2)!==plan.globalBefore)throw new Error('同步目标索引在预览后发生变化')
    return target
  }
  private async guardSources(guards:SourceGuard[],signal:AbortSignal):Promise<void>{
    for(const guard of guards){
      signal.throwIfAborted()
      if(guard.kind==='external'){
        const source=this.codexSessionSources.resolve(guard.id),stat=lstatSync(source.directory)
        if(source.name!==guard.name||source.directory!==guard.directory||source.device!==guard.device||source.inode!==guard.inode||stat.dev!==guard.device||stat.ino!==guard.inode)throw new Error('只读会话来源登记或目录身份在预览后发生变化')
        const daemon=await probeClientDaemon(source.directory,signal);if(daemon==='running')throw new Error('只读会话来源的 Codex 后台进程仍在运行，请关闭后重试');if(daemon==='unavailable'||daemon==='unsupported')throw new Error('无法确认只读会话来源已停止，请检查目录及后台进程');signal.throwIfAborted()
        if(await this.inventory(source.directory,signal)!==guard.inventory)throw new Error('只读会话来源文件在预览后发生变化，请刷新后重试')
      }else{
        const target=this.configs.identityTarget(guard.target.id);await this.transfers.closed(target,signal)
        if(target.directory!==guard.target.directory||this.profileHash(target.id)!==guard.profileHash)throw new Error('同步来源配置或实例在预览后发生变化')
        if(this.transfers.config(target).hash!==guard.configHash||readBounded(join(target.directory,'session_index.jsonl'),16*1024**2)!==guard.indexBefore||readBounded(join(target.directory,'.codex-global-state.json'),16*1024**2)!==guard.globalBefore)throw new Error('同步来源配置或会话索引在预览后发生变化，请重新预览')
        if(guard.rootIdentity){const stat=lstatSync(target.directory);if(stat.dev!==guard.rootIdentity.device||stat.ino!==guard.rootIdentity.inode)throw new Error('同步来源目录在预览后发生变化')}
        else if(existsSync(target.directory))throw new Error('同步来源目录已被其他进程创建')
        if(await this.inventory(target.directory,signal)!==guard.inventory)throw new Error('同步来源会话在预览后发生变化，请刷新后重试')
      }
    }
  }
  async preview(raw:unknown):Promise<SyncPreview>{
    if(raw&&typeof raw==='object'&&'sourceIds'in raw)return this.previewDirectional(directionalSyncPreviewSchema.parse(raw))
    const input=legacySyncPreviewSchema.parse(raw),ids=[...new Set(input.targetIds)];if(ids.length<2)throw new Error('请选择至少两个不同的 Codex 目录')
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
      await assertUnpagedSessionSources(sources,signal)
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
        const view:SyncPreview={ticket:randomUUID(),canStart:true,sessionCount:merged.length,sourceFiles:sources.length,totalBytes:bytes,targets:plans.map(plan=>plan.view)}
        this.pending={view,root,plans,guards:[],sources,program,applicationId:input.applicationId,expires:this.now()+300000};Object.assign(job.view,{status:'ready',targets:view.targets})
        this.timer=setTimeout(()=>{if(!this.job?.task)this.clear()},300000);this.timer.unref();return structuredClone(view)
      }catch(error){directory(root);rmSync(root,{recursive:true});throw error}
    })
  }
  private async previewPaginated(input:DirectionalSyncPreviewInput,source:DirectionalSource,target:ClientConfigTarget,record:SessionRecord,snapshotId:string,application:InstanceApplication,job:Job,signal:AbortSignal):Promise<SyncPreview>{
    const profile=(id:string)=>this.store.read().instances?.find(item=>item.id===id&&item.clientType!=='claude_code')
    const sourceProfile=profile(source.id),targetProfile=profile(target.id)
    const externalSource=source.role==='external'?this.codexSessionSources.resolve(source.id):undefined
    let blocked=''
    if(source.role!=='instance'&&source.role!=='external'||target.role!=='instance'||!target.managed||!targetProfile||targetProfile.externalHome||source.role==='instance'&&(!source.managed||!sourceProfile||sourceProfile.externalHome)||source.role==='external'&&(!externalSource||externalSource.directory!==source.directory||externalSource.device!==source.device||externalSource.inode!==source.inode))blocked='Codex 分段会话仅支持受管实例或已登记的只读外部来源迁移到受管目标；默认目录和外部目标暂不支持。'
    let sourceState:Awaited<ReturnType<typeof inspectCodexPaginatedSession>>|undefined,targetState:Awaited<ReturnType<typeof inspectCodexPaginatedTransferTarget>>|undefined
    if(!blocked){
      await this.transfers.closed(source,signal);await this.transfers.closed(target,signal)
      const location=record.locations.find(item=>item.targetId===source.id)
      const selection=input.sourceSelections?.find(item=>item.sessionId===record.id&&item.targetId===source.id)
      if(input.sourceSelections?.some(item=>item.sessionId!==record.id||item.targetId!==source.id))blocked='分页会话同步一次只能指定一个来源版本。'
      if(location?.ambiguous&&!selection?.versionId)blocked='此分页会话有多个同 ID 文件，请选择当前活动版本后再继续。'
      const versions=await this.paginatedFileVersions(source.directory,record.id,signal)
      sourceState=await inspectCodexPaginatedSession({sourceHome:source.directory,sessionId:record.id},{signal})
      if(!sourceState.canTransfer)blocked||=sourceState.reason??'来源分页会话不满足安全迁移条件。'
      const selected=selection?.versionId?versions.find(item=>item.versionId===selection.versionId):undefined
      if(selection?.versionId&&!selected)blocked||='所选来源版本已变化，请刷新会话列表后重试。'
      if(selected&&selected.path!==sourceState.currentRolloutPath)blocked||='所选 JSONL 文件不是 SQLite 中记录的当前活动 rollout；为避免错配，不能迁移此版本。'
      if(!selection&&versions.length&&sourceState&&!versions.some(item=>item.path===sourceState!.currentRolloutPath))blocked||='当前 SQLite 活动 rollout 不在已扫描来源版本中，请刷新后重试。'
      if(!selection&&location?.ambiguous)blocked||='必须明确选择 SQLite 当前活动 rollout 对应的文件版本。'
      if(sourceState?.canTransfer){
        targetState=await inspectCodexPaginatedTransferTarget({sourceHome:source.directory,targetHome:target.directory,sessionId:record.id},{signal})
        if(!targetState.canReceive)blocked||=targetState.reason??'目标实例不能接收此分页会话。'
        for(const item of sourceState.rollouts){const destination=join(target.directory,relative(source.directory,item.path));if(existsSync(destination))blocked||='目标实例已存在 lineage 文件 '+relative(target.directory,destination)+'，拒绝覆盖。'}
        const targetCatalog=new SessionCatalog(this.store,undefined,{disableSqliteDisplay:true})
        try{const targetPage=await targetCatalog.scan({runId:randomUUID(),targetId:target.id,clientType:'codex'});if(targetPage.warnings.length)blocked||='目标实例会话扫描未完整，无法安全排除同 ID 文件冲突。';else if(targetCatalog.recordsForSync(targetPage.snapshotId,[record.id],[target.id]).some(item=>item.id===record.id))blocked||='目标实例已存在相同会话 ID 的 rollout 文件，拒绝覆盖或形成双重会话。'}finally{targetCatalog.stop()}
      }
    }
    const sourceIdentity=lstatSync(source.directory),targetIdentity=lstatSync(target.directory),sourceInventory=await this.inventory(source.directory,signal)
    const sources=[{id:source.id,name:source.name,directory:source.directory}],unsupportedSessions=blocked?[{id:record.id,title:record.title,sourceIds:[source.id,target.id],reason:blocked}]:[]
    const view:SyncPreview={canStart:!blocked,sessionCount:blocked?0:1,sourceFiles:blocked?0:sourceState!.rollouts.length,totalBytes:blocked?0:sourceState!.rollouts.reduce((sum,item)=>sum+item.bytes,0),targets:[{id:target.id,name:target.name,directory:target.directory,added:blocked?0:1,updated:0,unchanged:0,duplicates:0,repairsWorkspace:false,repairsIndex:false}],unsupportedSessions,directional:{sourceIds:[source.id],targetId:target.id,scope:'selected',sources,sessions:blocked?[]:[{id:record.id,title:record.title,sourceIds:[source.id],sourceFiles:sourceState!.rollouts.length,targetFiles:0,action:'add'}]},...(blocked?{}:{paginatedTransfer:{kind:'codex_paginated' as const,sourceId:source.id,targetId:target.id,rollouts:sourceState!.rollouts.length,bytes:sourceState!.rollouts.reduce((sum,item)=>sum+item.bytes,0)}})}
    job.view.status='ready';Object.assign(job.view,{targets:view.targets,sourceFiles:view.sourceFiles,totalBytes:view.totalBytes})
    if(view.canStart&&sourceState&&targetState){
      const ticket=randomUUID();view.ticket=ticket
      this.pending={view,root:'',plans:[],guards:[],sources:[],program:sessionProgram(application),applicationId:input.applicationId,expires:this.now()+300000,paginated:{sourceId:source.id,sourceRole:source.role as 'instance'|'external',sourceName:source.name,sourceInventory,targetId:target.id,sourceHome:source.directory,targetHome:target.directory,sessionId:record.id,title:record.title,expectedRolloutPath:sourceState.currentRolloutPath,expectedRecordFingerprint:sourceState.recordFingerprint,expectedSourceFingerprint:sourceState.sourceFingerprint,expectedTargetFingerprint:targetState.targetFingerprint,rollouts:sourceState.rollouts.length,bytes:sourceState.rollouts.reduce((sum,item)=>sum+item.bytes,0),sourceProfileHash:this.profileHash(source.id),targetProfileHash:this.profileHash(target.id),sourceConfigHash:textHash(readBounded(join(source.directory,'config.toml'),1024*1024)),targetConfigHash:this.transfers.config(target).hash,sourceRootIdentity:{device:sourceIdentity.dev,inode:sourceIdentity.ino},targetRootIdentity:{device:targetIdentity.dev,inode:targetIdentity.ino}}}
      this.timer=setTimeout(()=>{if(!this.job?.task)this.clear()},300000);this.timer.unref()
    }
    return structuredClone(view)
  }
  private async previewDirectional(input:DirectionalSyncPreviewInput):Promise<SyncPreview>{
    const sourceIds=[...new Set(input.sourceIds)];if(sourceIds.length!==input.sourceIds.length)throw new Error('同步来源不能重复')
    if(sourceIds.includes(input.targetId))throw new Error('目标实例不能同时作为来源')
    if((this.store.read().codexSessionSources??[]).some(source=>source.id===input.targetId))throw new Error('只读会话来源不能作为同步目标')
    const target=this.configs.identityTarget(input.targetId),sourceTargets=sourceIds.map(id=>this.directionalSource(id))
    if(target.role!=='instance')throw new Error('同步目标必须是已登记的 Codex 实例目录')
    if([...sourceTargets,target].some(value=>value.role==='default'&&value.managed))throw new Error('默认 Codex 配置目录不能作为会话同步来源或目标')
    const directories=[...sourceTargets.map(source=>source.directory),target.directory];for(let i=0;i<directories.length;i++)for(const other of directories.slice(i+1))if(overlap(directories[i],other))throw new Error('同步来源和目标目录不能相互包含或别名重叠')
    this.available();this.free([target.id,...sourceTargets.map(source=>source.id)]);this.clear();const job=this.begin([target.id,...sourceTargets.map(source=>source.id)],'preparing'),signal=job.controller.signal
    return this.execute(job,async()=>{
      const application=this.applications().find(app=>app.id===input.applicationId);if(!application)throw new Error('请选择已登记的 Codex 程序')
      if(input.scope==='selected'&&sourceTargets.length===1&&input.sessionIds.length===1){
        const single=sourceTargets[0],catalog=new SessionCatalog(this.store,undefined,{disableSqliteDisplay:true}),cancel=()=>catalog.stop();signal.addEventListener('abort',cancel,{once:true})
        try{
          const page=await catalog.scan({runId:randomUUID(),targetId:single.id,clientType:'codex'});if(page.warnings.length)throw new Error('部分会话来源未读取完整：'+page.warnings[0])
          const record=catalog.recordsForSync(page.snapshotId,input.sessionIds,[single.id]).find(row=>row.id===input.sessionIds[0])
          if(record&&paginatedSession(record))return await this.previewPaginated(input,single,target,record,page.snapshotId,application,job,signal)
        }finally{signal.removeEventListener('abort',cancel);catalog.stop()}
      }
      const program=sessionProgram(application),config=this.transfers.config(target),targetExisting=existsSync(target.directory),targetRootIdentity=targetExisting?fileIdentity(lstatSync(target.directory)):undefined,targetInventory=await this.inventory(target.directory,signal),targetIndexBefore=readBounded(join(target.directory,'session_index.jsonl'),16*1024**2),targetGlobalBefore=readBounded(join(target.directory,'.codex-global-state.json'),16*1024**2)
      if(targetExisting)await this.transfers.closed(target,signal)
      const guards:SourceGuard[]=[],sourceCopies:SessionTransferSource[]=[],sourceScopeIds=new Set<string>(),paginatedById=new Map<string,{title:string;sourceIds:string[]}>(),validatedUnsupportedChoices=new Set<string>();let activeCatalog:SessionCatalog|undefined;const stop=()=>activeCatalog?.stop();signal.addEventListener('abort',stop,{once:true})
      try{
        for(const source of sourceTargets){
          signal.throwIfAborted()
          let guard:SourceGuard
          let inventory:string
          if(source.role==='external'){
            const registered=this.codexSessionSources.resolve(source.id)
            if(registered.directory!==source.directory||registered.device!==source.device||registered.inode!==source.inode)throw new Error('只读会话来源登记在预览前发生变化')
            const stat=lstatSync(registered.directory);if(stat.dev!==registered.device||stat.ino!==registered.inode)throw new Error('只读会话来源目录已被替换')
            const daemon=await import('./clientDaemon').then(module=>module.probeClientDaemon(registered.directory,signal));if(daemon==='running')throw new Error('只读会话来源的 Codex 后台进程仍在运行，请关闭后重试');if(daemon==='unavailable'||daemon==='unsupported')throw new Error('无法确认只读会话来源已停止，请检查目录及后台进程');signal.throwIfAborted()
            inventory=await this.inventory(registered.directory,signal);guard={kind:'external',id:registered.id,name:registered.name,directory:registered.directory,device:registered.device,inode:registered.inode,inventory}
          }else{
            await this.transfers.closed(source,signal);const profileHash=this.profileHash(source.id);inventory=await this.inventory(source.directory,signal);const identity=existsSync(source.directory)?fileIdentity(lstatSync(source.directory)):undefined;guard={kind:'instance',target:source,rootIdentity:identity,profileHash,configHash:this.transfers.config(source).hash,inventory,indexBefore:readBounded(join(source.directory,'session_index.jsonl'),16*1024**2),globalBefore:readBounded(join(source.directory,'.codex-global-state.json'),16*1024**2)}
          }
          const catalog=activeCatalog=new SessionCatalog(this.store,undefined,{disableSqliteDisplay:true});try{
            const page=await catalog.scan({runId:randomUUID(),targetId:source.id,clientType:'codex'});if(page.warnings.length)throw new Error('部分会话来源未读取完整：'+page.warnings[0]);const records=catalog.recordsForSync(page.snapshotId,input.scope==='selected'?input.sessionIds:[],[source.id]),sourceSelections=(input.sourceSelections??[]).filter(selection=>selection.targetId===source.id)
            for(const record of records){sourceScopeIds.add(record.id);const location=record.locations.find(value=>value.targetId===source.id);if(!location)continue;const paginated=paginatedSession(record);if(paginated){const existing=paginatedById.get(record.id);if(existing){if(!existing.sourceIds.includes(source.id))existing.sourceIds.push(source.id)}else paginatedById.set(record.id,{title:record.title,sourceIds:[source.id]})}const selected=sourceSelections.find(selection=>selection.sessionId===record.id);if(paginated&&location.ambiguous){if(!selected?.versionId)throw new Error('分页会话存在多个同 ID 文件，请选择具体版本后再同步');if(!location.versions?.some(version=>version.id===selected.versionId))throw new Error('所选会话版本不属于指定来源目录，请刷新列表');validatedUnsupportedChoices.add(record.id+'|'+source.id+'|'+selected.versionId)}else if(selected&&!location.ambiguous)throw new Error('会话来源文件版本已变化，请刷新列表')}
            if(source.role==='instance')sourceCopies.push(...await catalog.directionalSyncSources(page.snapshotId,input.scope==='selected'?input.sessionIds:[],[source.id],signal,false,sourceSelections,true))
            else{const wanted=input.scope==='selected'?new Set(input.sessionIds):undefined;sourceCopies.push(...await this.externalCopies(source,records.filter(record=>!wanted||wanted.has(record.id)),sourceSelections,signal))}
          }finally{catalog.stop();activeCatalog=undefined}
          guards.push(guard)
          if(await this.inventory(source.directory,signal)!==inventory)throw new Error('同步扫描期间来源会话文件发生变化')
        }
        if(input.scope==='selected'){const missing=input.sessionIds.find(id=>!sourceScopeIds.has(id));if(missing)throw new Error(`所选会话未在所选来源中找到：${missing}`)}
        const ids=[...new Set(sourceCopies.map(source=>source.record.id))]
        if(!ids.length&&!paginatedById.size)throw new Error('所选来源目录中没有可同步的 Codex 会话')
        const targetCatalog=activeCatalog=new SessionCatalog(this.store,undefined,{disableSqliteDisplay:true});let targetCopies:SessionTransferSource[]=[];try{const targetPage=await targetCatalog.scan({runId:randomUUID(),targetId:target.id,clientType:'codex'});if(targetPage.warnings.length)throw new Error('部分目标会话未读取完整：'+targetPage.warnings[0]);for(const unsupported of targetCatalog.directionalSyncUnsupported(targetPage.snapshotId,[...sourceScopeIds],[target.id])){const existing=paginatedById.get(unsupported.id);if(existing){if(!existing.sourceIds.includes(target.id))existing.sourceIds.push(target.id)}else paginatedById.set(unsupported.id,{title:unsupported.title,sourceIds:[target.id]})}const unsupportedIds=new Set(paginatedById.keys()),supportedIds=ids.filter(id=>!unsupportedIds.has(id));if(supportedIds.length)targetCopies=await targetCatalog.directionalSyncSources(targetPage.snapshotId,supportedIds,[target.id],signal,false)}finally{targetCatalog.stop();activeCatalog=undefined}
        for(const selection of input.sourceSelections??[]){const copied=sourceCopies.some(source=>source.record.id===selection.sessionId&&source.targetId===selection.targetId&&source.sourceVersionId===selection.versionId),paginated=validatedUnsupportedChoices.has(selection.sessionId+'|'+selection.targetId+'|'+selection.versionId);if(!copied&&!paginated)throw new Error('所选会话来源版本未能唯一匹配，请刷新来源列表')}
        // A session is an indivisible import unit. If any chosen source or the
        // target copy uses native paginated history, skip that logical ID while
        // continuing with ordinary JSONL sessions in the same preview.
        const unsupportedSessions=[...paginatedById].map(([id,records])=>{
          const locations=[...new Set([...records.sourceIds,...sourceCopies.filter(record=>record.record.id===id).map(record=>record.targetId),...targetCopies.filter(record=>record.record.id===id).map(record=>record.targetId)])],names=locations.map(locationId=>[...sourceTargets,target].find(item=>item.id===locationId)?.name??locationId)
          return {id,title:records.title,sourceIds:locations,reason:'Codex 分段历史依赖 rollout lineage 与 SQLite 数据库组；当前尚未支持整组迁移，因此跳过此会话（涉及：'+names.join('、')+'）。'}
        })
        const unsupportedIds=new Set(paginatedById.keys()),supportedSourceCopies=sourceCopies.filter(source=>!unsupportedIds.has(source.record.id)),supportedIds=[...new Set(supportedSourceCopies.map(source=>source.record.id))],supportedTargetCopies=targetCopies.filter(source=>!unsupportedIds.has(source.record.id))
        if(!supportedIds.length){
          const view:SyncPreview={canStart:false,sessionCount:0,sourceFiles:0,totalBytes:0,targets:[],unsupportedSessions,directional:{sourceIds,targetId:target.id,scope:input.scope,sources:sourceTargets.map(source=>({id:source.id,name:source.name,directory:source.directory})),sessions:[]}}
          job.view.status='ready'
          return structuredClone(view)
        }
        const sources=[...supportedSourceCopies,...supportedTargetCopies],bytes=sources.reduce((sum,source)=>sum+source.size,0)
        if(sources.length>10000||bytes>100*1024**3)throw new Error('同步范围超过暂存限制（1 万份副本或 100 GiB），请选择更少会话')
        await assertUnpagedSessionSources(sources,signal);Object.assign(job.view,{sourceFiles:sources.length,totalBytes:bytes})
        directory(this.scratch,true);const root=join(this.scratch,randomUUID());mkdirSync(root,{mode:0o700})
        try{
          const indexes=await this.transfers.sourceIndexes(sources,signal),merged=await mergeSessionCopies(root,sources,indexes,signal,(files,done)=>{job.view.processedFiles=files;job.view.bytes=done})
          const sourceHashes=new Map<string,string>();for(const source of sources)sourceHashes.set(source.path,await hashSource(source,signal,()=>{}))
          const targetPlan:Plan={target,view:{id:target.id,name:target.name,directory:target.directory,added:0,updated:0,unchanged:0,duplicates:0,repairsWorkspace:false,repairsIndex:false},rootIdentity:targetRootIdentity,configHash:config.hash,profileHash:this.profileHash(target.id),inventory:targetInventory,indexBefore:targetIndexBefore,globalBefore:targetGlobalBefore,files:[],metadata:[]}
          const projectedRoot=join(root,target.id);mkdirSync(projectedRoot,{mode:0o700});mkdirSync(join(projectedRoot,'sessions'),{mode:0o700})
          for(const item of merged){
            const originals=item.originals.filter(source=>source.targetId===target.id),destination=join(projectedRoot,'sessions','rollout-'+item.source.record.id+'.jsonl'),copied=await copySessionRollout(item.source,destination,config.provider,signal,()=>{}),stat=lstatSync(destination),rootStat=lstatSync(projectedRoot),archived=item.source.record.locations[0].archived,existing=originals.find(source=>source.record.locations[0].archived===archived&&officialLocation(source)),rel=existing?relative(target.directory,existing.path).split(sep).join('/'):sessionDestination(item.source,target.directory,targetPlan.files),projected:SessionTransferSource={...item.source,path:destination,root:projectedRoot,targetId:target.id,rootDevice:rootStat.dev,rootInode:rootStat.ino,...fileIdentity(stat),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs}
            const changed=originals.length!==1||!existing||sourceHashes.get(originals[0]?.path??'')!==copied.sha256||Math.trunc(originals[0]?.mtime??-1)!==Math.trunc(stat.mtimeMs)
            targetPlan.files.push({merged:item,projected,relative:rel,sha256:copied.sha256,originals,changed});targetPlan.view[!originals.length?'added':changed?'updated':'unchanged']++;targetPlan.view.duplicates+=Math.max(0,originals.length-1)
          }
          const metadata=syncMetadata(target.directory,targetPlan.files,targetPlan.indexBefore,targetPlan.globalBefore);targetPlan.metadata=metadata.metadata;targetPlan.view.repairsWorkspace=metadata.repairsWorkspace;targetPlan.view.repairsIndex=metadata.metadata.some(item=>item.name==='session_index.jsonl')
          if(Buffer.byteLength(JSON.stringify(targetPlan.metadata))>38*1024**2)throw new Error('同步恢复索引超过 38 MiB，请整理索引')
          this.validate(targetPlan);if(await this.inventory(target.directory,signal)!==targetPlan.inventory)throw new Error('同步准备期间目标会话文件发生变化')
          await this.guardSources(guards,signal);verifySessionProgram(program);signal.throwIfAborted()
          const view:SyncPreview={ticket:randomUUID(),canStart:true,sessionCount:merged.length,sourceFiles:supportedSourceCopies.length,totalBytes:supportedSourceCopies.reduce((sum,source)=>sum+source.size,0),targets:[targetPlan.view],unsupportedSessions,directional:{sourceIds,targetId:target.id,scope:input.scope,sources:sourceTargets.map(source=>({id:source.id,name:source.name,directory:source.directory})),sessions:merged.map(item=>({id:item.source.record.id,title:item.source.record.title,sourceIds:[...new Set(item.originals.filter(source=>source.targetId!==target.id).map(source=>source.targetId))],sourceFiles:item.originals.filter(source=>source.targetId!==target.id).length,targetFiles:item.originals.filter(source=>source.targetId===target.id).length,action:targetPlan.files.find(file=>file.merged.source.record.id===item.source.record.id)?.changed?(item.originals.some(source=>source.targetId===target.id)?'merge':'add'):'unchanged'}))}}
          this.pending={view,root,plans:[targetPlan],guards,sources,program,applicationId:input.applicationId,expires:this.now()+300000};Object.assign(job.view,{status:'ready',targets:view.targets});this.timer=setTimeout(()=>{if(!this.job?.task)this.clear()},300000);this.timer.unref();return structuredClone(view)
        }catch(error){directory(root);rmSync(root,{recursive:true});throw error}
      }finally{signal.removeEventListener('abort',stop);activeCatalog?.stop()}
    })
  }
  start(raw:unknown):void{
    const input=syncStartSchema.parse(raw),pending=this.pending;this.available()
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('同步预览已过期，请重新预览')
    const lockedIds=[...new Set([...pending.plans.map(plan=>plan.target.id),...pending.guards.map(guard=>guard.kind==='external'?guard.id:guard.target.id),...(pending.paginated?[pending.paginated.sourceId,pending.paginated.targetId]:[])])]
    this.free(lockedIds);clearTimeout(this.timer);this.pending=undefined
    const job=this.begin(lockedIds,'running');Object.assign(job.view,{targets:pending.view.targets,sourceFiles:pending.paginated?.rollouts??pending.sources.length,totalBytes:pending.paginated?.bytes??pending.plans.reduce((sum,plan)=>sum+plan.files.filter(file=>file.changed).reduce((sum,file)=>sum+file.projected.size,0),0),transferKind:pending.paginated?'codex_paginated':'jsonl'})
    void this.execute(job,()=>pending.paginated?this.runPaginated(job,pending.paginated):this.run(job,pending)).catch(()=>{})
  }
  private async runPaginated(job:Job,pending:PaginatedPending):Promise<void>{
    const signal=job.controller.signal
    try{
      const source=pending.sourceRole==='external'?this.directionalSource(pending.sourceId):this.configs.identityTarget(pending.sourceId),target=this.configs.identityTarget(pending.targetId),sourceProfile=this.store.read().instances?.find(item=>item.id===pending.sourceId),targetProfile=this.store.read().instances?.find(item=>item.id===pending.targetId)
      if(source.role!==pending.sourceRole||source.role!=='instance'&&source.role!=='external'||target.role!=='instance'||!target.managed||!targetProfile||targetProfile.externalHome||source.role==='instance'&&(!source.managed||!sourceProfile||sourceProfile.externalHome))throw new Error('分页会话同步只允许受管实例或已登记只读来源迁移到受管实例')
      const sourceRoot=lstatSync(source.directory),targetRoot=lstatSync(target.directory)
      if(source.directory!==pending.sourceHome||target.directory!==pending.targetHome||sourceRoot.dev!==pending.sourceRootIdentity.device||sourceRoot.ino!==pending.sourceRootIdentity.inode||targetRoot.dev!==pending.targetRootIdentity.device||targetRoot.ino!==pending.targetRootIdentity.inode)throw new Error('预览后实例目录身份发生变化，请重新预览')
      if(source.role==='external'){const registered=this.codexSessionSources.resolve(source.id);if(registered.name!==pending.sourceName||registered.directory!==pending.sourceHome||registered.device!==pending.sourceRootIdentity.device||registered.inode!==pending.sourceRootIdentity.inode)throw new Error('只读来源登记或目录身份已变化，请重新预览')}
      else if(this.profileHash(source.id)!==pending.sourceProfileHash)throw new Error('预览后来源实例发生变化，请重新预览')
      if(this.profileHash(target.id)!==pending.targetProfileHash||textHash(readBounded(join(source.directory,'config.toml'),1024*1024))!==pending.sourceConfigHash||this.transfers.config(target).hash!==pending.targetConfigHash)throw new Error('预览后实例或 sqlite_home 配置发生变化，请重新预览')
      await this.transfers.closed(source,signal);await this.transfers.closed(target,signal);if(await this.inventory(source.directory,signal)!==pending.sourceInventory)throw new Error('分页会话只读来源文件在预览后发生变化，请重新预览');signal.throwIfAborted();job.view.currentTarget=target.id
      const result=await transferCodexPaginatedSession({sourceHome:source.directory,targetHome:target.directory,sessionId:pending.sessionId,expectedRolloutPath:pending.expectedRolloutPath,expectedRecordFingerprint:pending.expectedRecordFingerprint,expectedSourceFingerprint:pending.expectedSourceFingerprint,expectedTargetFingerprint:pending.expectedTargetFingerprint},{signal})
      const backupId=result.backupDirectory.split(sep).at(-1)??randomUUID();this.paginatedBackups.set(backupId,result.backupDirectory);job.view.completedTargets.push(target.id);job.view.backups.push({targetId:target.id,id:backupId});job.view.processedFiles=result.rollouts;job.view.bytes=result.bytes;job.view.status='completed'
    }finally{job.view.currentTarget=undefined}
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
      await this.guardSources(pending.guards,signal)
      for(const source of pending.sources)await verifySource(source)
      for(const plan of pending.plans){
        signal.throwIfAborted();current=undefined;job.view.currentTarget=plan.target.id
        await this.transfers.closed(this.validate(plan),signal);if(await this.inventory(plan.target.directory,signal)!==plan.inventory)throw new Error('同步目标文件在提交前发生变化')
        await this.guardSources(pending.guards,signal)
        const changed=plan.files.filter(file=>file.changed)
        if(!changed.length&&!plan.metadata.length){job.view.completedTargets.push(plan.target.id);continue}
        const target=this.configs.prepareIdentityTarget(plan.target.id)
        current=createSyncJournal(randomUUID(),target.id,target.name,target.directory,plan.configHash,pending.program)
        try{this.save(current)}catch(error){current.phase='rolled_back';await cleanupSync(current);current=undefined;throw error}
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
        await this.guardSources(pending.guards,signal)
        if(await this.inventory(target.directory,signal)!==(plan.rootIdentity?plan.inventory:textHash('')))throw new Error('同步目标会话在准备期间发生变化')
        verifySessionProgram(pending.program);signal.throwIfAborted()
        current={...current,metadata:plan.metadata,sessionIds:plan.files.map(file=>file.merged.source.record.id),phase:'prepared'};this.save(current)
        await publishSync(current,signal);const committed:SyncJournal={...current,phase:'committed'};this.save(committed);current=committed
        job.view.completedTargets.push(target.id);job.view.backups.push({targetId:target.id,id:current.id})
        try{await this.rebuild(pending.program,target.directory,current.sessionIds,signal);await cleanupSync(current);current.phase='done';this.save(current)}
        catch(error){this.needsRecovery(current,'会话已同步，需重试 Codex 索引更新或清理备份：'+safeError(error))}
      }
      signal.throwIfAborted();job.view.status='completed'
    }catch(error){
      if(current){
        if(['committed','done'].includes(current.phase))this.needsRecovery(current,'会话已同步，清理或索引更新未完成，请重试恢复')
        else try{await rollbackSync(current);current.phase='rolled_back';this.save(current);await cleanupSync(current)}catch(cause){this.needsRecovery(current,safeError(cause))}
      }
      throw error
    }finally{job.view.currentTarget=undefined;directory(pending.root);rmSync(pending.root,{recursive:true})}
  }
  async settled():Promise<void>{await this.job?.task?.catch(()=>{})}
  async cancel(id:string):Promise<void>{z.string().uuid().parse(id);if(this.job?.view.id!==id)throw new Error('同步任务已变化');this.job.controller.abort();await this.settled();if(this.pending)this.clear()}
  async stop():Promise<void>{for(const controller of this.conflictScans.values())controller.abort();this.job?.controller.abort();await this.settled();this.clear()}
  async recover():Promise<void>{
    for(const profile of this.store.read().instances??[]){
      if(profile.clientType==='claude_code'||profile.externalHome)continue
      const target=this.configs.identityTarget(profile.id),home=instanceHomePath(realpathSync(this.store.directory),profile)
      if(target.directory!==home||!existsSync(home))continue
      for(const item of await recoverCodexPaginatedTransfers(home)){
        if(item.status==='blocked'){
          const value:SyncRecovery={id:item.id,targetId:profile.id,targetName:profile.name,message:'Codex 分段会话迁移需要恢复：'+item.message+'（备份目录：'+item.directory+'）',kind:'codex_paginated'}
          this.recovery.set(item.id,value);this.paginatedRecovery.set(item.id,{targetId:profile.id,targetHome:home,targetName:profile.name,directory:item.directory})
        }else this.paginatedBackups.set(item.id,item.directory)
      }
    }
    if(!existsSync(this.root))return;directory(this.root)
    for(const entry of readdirSync(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue
      let journal:SyncJournal|undefined
      try{
        journal=this.load(entry.name);if(journal.phase==='done')continue
        const target=this.target(journal);if(this.inUse(target.id)||this.transfers.busy(target.id))throw new Error('同步目录正在使用，请停止客户端后恢复')
        await this.transfers.closed(target,new AbortController().signal)
        if(journal.phase==='rolled_back'){await cleanupSync(journal);continue}
        if(journal.phase==='committed'){this.needsRecovery(journal,'会话已同步，需继续 Codex 索引更新；合并副本已保留供恢复');continue}
        await rollbackSync(journal);journal.phase='rolled_back';this.save(journal);await cleanupSync(journal)
      }catch(error){this.recovery.set(entry.name,{id:entry.name,targetId:journal?.targetId??'',targetName:journal?.targetName??'未识别的目录',message:safeError(error)})}
    }
  }
  async retry(raw:unknown):Promise<void>{
    const input=z.object({id:z.string().uuid(),applicationId:z.string().min(1).max(100),clientsClosed:z.literal(true)}).strict().parse(raw);this.available()
    const paginated=this.paginatedRecovery.get(input.id)
    if(paginated||this.paginatedBackups.has(input.id)){
      if(!paginated)throw new Error('此 Codex 分段会话迁移已完成；备份保留供审计或手动恢复。')
      const target=this.configs.identityTarget(paginated.targetId)
      if(target.directory!==paginated.targetHome||target.role!=='instance'||!target.managed)throw new Error('Codex 分段迁移恢复目标目录已变化')
      await this.transfers.closed(target,new AbortController().signal)
      const records=await recoverCodexPaginatedTransfers(target.directory)
      const result=records.find(item=>item.id===input.id)
      if(!result)throw new Error('找不到 Codex 分段迁移恢复日志，请检查备份目录')
      if(result.status==='blocked'){
        const value:SyncRecovery={id:result.id,targetId:target.id,targetName:target.name,message:'Codex 分段会话迁移仍需处理：'+result.message+'（备份目录：'+result.directory+'）',kind:'codex_paginated'}
        this.recovery.set(result.id,value);this.paginatedRecovery.set(result.id,{...paginated,directory:result.directory});throw new Error(value.message)
      }
      this.recovery.delete(result.id);this.paginatedRecovery.delete(result.id);this.paginatedBackups.set(result.id,result.directory)
      return
    }
    const journal=this.load(input.id),target=this.target(journal);if(this.inUse(target.id)||this.transfers.busy(target.id))throw new Error('同步目录正在使用，请停止客户端后恢复')
    const application=this.applications().find(app=>app.id===input.applicationId);if(!application)throw new Error('请选择 Codex 程序')
    const program=sessionProgram(application),job=this.begin([target.id],'running')
    job.view.targets=[{id:target.id,name:target.name,directory:target.directory,added:0,updated:0,unchanged:journal.sessionIds.length,duplicates:0,repairsWorkspace:false,repairsIndex:false}];job.view.currentTarget=target.id;job.view.backups=[{targetId:target.id,id:journal.id}]
    await this.execute(job,async()=>{try{
      await this.transfers.closed(target,job.controller.signal);this.target(journal)
      if(journal.phase==='committed'){
        this.transfers.config(target)
        for(const output of journal.outputs)if(!await verifySyncFile(journal.root,join(journal.root,output.relative),output,job.controller.signal))throw new Error('已提交的目标会话缺失，合并副本仍保留在备份目录；请先恢复目标文件')
        await this.rebuild(program,target.directory,journal.sessionIds,job.controller.signal);await cleanupSync(journal);journal.program=program;journal.phase='done'
      }
      else if(journal.phase!=='done'&&journal.phase!=='rolled_back'){await rollbackSync(journal);journal.phase='rolled_back'}
      this.save(journal);await cleanupSync(journal);this.recovery.delete(journal.id);job.view.status='completed';job.view.completedTargets.push(target.id)
    }catch(error){this.needsRecovery(journal,safeError(error));throw error}finally{job.view.currentTarget=undefined}})
  }
  backupLocation(id:string):string{z.string().uuid().parse(id);const paginated=this.paginatedRecovery.get(id);if(paginated){directory(paginated.directory);return paginated.directory};const known=this.paginatedBackups.get(id);if(known){directory(known);return known};if(this.recovery.get(id)?.targetId===''){directory(this.root);const folder=join(this.root,id);directory(folder);return folder};const journal=this.load(id);this.target(journal);const folder=existsSync(syncStage(journal))?syncStage(journal):join(this.root,id);directory(folder);return folder}
}
