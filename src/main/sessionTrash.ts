// Cross-home trash orchestration. Only registered capabilities and short-lived
// previews reach destructive methods; raw filesystem paths never enter IPC.
import {randomUUID} from 'node:crypto'
import {existsSync,lstatSync,readdirSync,realpathSync} from 'node:fs'
import {join,relative,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs,directory} from './clientConfig'
import {SessionCatalog,type SessionTransferSource} from './sessions'
import {SessionTransfers} from './sessionTransfers'
import {openSessionFile,firstSessionEvent,rolloutFiles,safeSessionPath} from './sessionFiles'
import {fileIdentity,textHash,verifySource} from './sessionTransferFiles'
import {sessionProgram,verifySessionProgram,type SessionProgram,type OfficialDeletionEntry} from './officialSessions'
import {prepareTrashBatch,deleteTrashOriginals,restoreTrashBatch,purgeTrashBatch,loadTrashJournal,discardTrashPreparation,checkTrashHome,saveTrashJournal,officialTrashRuntime,importTrashBackup,verifyBackup,type TrashJournal,type TrashRuntime} from './sessionTrashFiles'
import {scanLegacyTrash,verifyLegacyTrash,importedBatchId,type LegacyTrashSource,type LegacyTrashEntry} from './legacySessionTrash'
import {trashPreviewSchema,trashActionSchema,trashPageSchema,legacyTrashImportSchema,type LegacyTrashPage,type LegacyTrashRow,type LegacyTrashGroup,type TrashPreview,type TrashTargetPreview,type TrashRecord,type TrashPage,type TrashJob,type TrashRecovery,type TrashState} from '../shared/sessionTrash'
import type {ClientConfigTarget} from '../shared/clientConfig'
import type {InstanceApplication} from '../shared/instances'

interface HomePlan {target:ClientConfigTarget;rootIdentity:{device:number;inode:number};configHash:string;profileHash:string;inventory:string;sources:SessionTransferSource[];closure:OfficialDeletionEntry[];officialPlan:boolean}
interface BatchPlan {id:string;revision:string;sessionIds:string[];targetId:string;configHash?:string;profileHash?:string}
type ImportHome=Pick<HomePlan,'target'|'configHash'|'profileHash'>&{rootIdentity?:HomePlan['rootIdentity']}
interface ImportPlan {source:LegacyTrashSource;homes:ImportHome[];files:{entry:LegacyTrashEntry;targetId:string;batchId:string;duplicate?:string}[]}
interface Pending {view:TrashPreview;homes?:HomePlan[];batches?:BatchPlan[];importPlan?:ImportPlan;program?:SessionProgram;applicationId?:string;expires:number;registry:string}
interface Job {view:TrashJob;ids:Set<string>;controller:AbortController;task?:Promise<unknown>}
interface Snapshot {id:string;rows:TrashRecord[];batches:BatchPlan[]}
const err=(error:unknown)=>error instanceof Error&&!(error instanceof SyntaxError)&&!(error as NodeJS.ErrnoException).code&&!('issues' in error)?error.message:'会话废纸篓操作失败，请检查目录、权限及可用磁盘空间'
const unfinished=(journal:TrashJournal)=>!['trashed','restored'].includes(journal.phase)||journal.indexPending
const remaining=(journal:TrashJournal)=>journal.allIds.filter(id=>!journal.removedIds?.includes(id)&&!journal.restoredIds?.includes(id))
const revision=(journal:TrashJournal)=>textHash(JSON.stringify(journal))
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep)

export class SessionTrash {
  private readonly configs:ClientConfigs
  private readonly root:string
  private pending?:Pending
  private job?:Job
  private snapshot?:Snapshot
  private legacy?:{id:string;source:LegacyTrashSource;rows:LegacyTrashRow[];groups:LegacyTrashGroup[];expires:number}
  private readonly recoveries=new Map<string,TrashRecovery>()
  constructor(private readonly store:Store,private readonly catalog:SessionCatalog,private readonly transfers:SessionTransfers,private readonly applications:()=>InstanceApplication[],private readonly inUse:(id:string)=>boolean=()=>false,private readonly runtime:TrashRuntime=officialTrashRuntime,private readonly now:()=>number=Date.now){this.configs=new ClientConfigs(store);this.root=join(realpathSync(store.directory),'session-trash')}
  state():TrashState{return {job:this.job?structuredClone(this.job.view):undefined,recoveries:[...this.recoveries.values()].map(row=>({...row}))}}
  busy(id:string):boolean{return !!this.job?.task&&this.job.ids.has(id)||[...this.recoveries.values()].some(row=>!row.targetId||row.targetId===id)}
  active():boolean{return !!this.job?.task}
  private available():void{if(this.job?.task)throw new Error('已有废纸篓操作正在执行')}
  private free(ids:Iterable<string>,recovery=false):void{for(const id of ids)if(this.inUse(id)||this.transfers.busy(id)||!recovery&&this.busy(id))throw new Error('相关目录正在使用或等待恢复，请先停止客户端并处理恢复任务')}
  private registry():string{return textHash(JSON.stringify(this.configs.targets()))}
  private profile(id:string):string{return textHash(JSON.stringify(this.store.read().instances?.find(row=>row.id===id)??null))}
  private begin(action:TrashJob['action'],ids:string[],status:TrashJob['status']):Job{this.available();const job:Job={ids:new Set(ids),controller:new AbortController(),view:{id:randomUUID(),action,status,completedTargets:[],targets:ids.length,bytes:0,totalBytes:0}};this.job=job;return job}
  private async execute<T>(job:Job,action:()=>Promise<T>):Promise<T>{const task=action();job.task=task;try{return await task}catch(error){job.view.status=job.controller.signal.aborted?'cancelled':'failed';job.view.error=job.controller.signal.aborted?'操作已取消；已完成的目录保留，未完成项请查看恢复任务':err(error);throw new Error(job.view.error)}finally{job.task=undefined}}
  async settled():Promise<void>{await this.job?.task?.catch(()=>{})}
  async cancel(id:string):Promise<void>{z.string().uuid().parse(id);if(this.job?.view.id!==id)throw new Error('废纸篓任务已变化');this.job.controller.abort();await this.settled();this.pending=undefined}
  async discard():Promise<void>{if(this.job?.task&&this.job.view.status==='preparing')await this.cancel(this.job.view.id);this.pending=undefined;if(this.job?.view.status==='ready')this.job.view.status='cancelled'}
  async stop():Promise<void>{this.job?.controller.abort();await this.settled();this.pending=undefined;this.legacy=undefined}
  private folder(id:string):string{z.string().uuid().parse(id);directory(this.root);return join(this.root,id)}
  private target(journal:TrashJournal):ClientConfigTarget{const target=this.configs.identityTarget(journal.targetId);if(target.directory!==journal.root)throw new Error('废纸篓来源不属于当前登记目录');checkTrashHome(journal);this.transfers.config(target);return target}
  private program(id:string):SessionProgram{const app=this.applications().find(app=>app.id===id);if(!app)throw new Error('请选择已登记的 Codex 程序');return sessionProgram(app)}
  private async inventory(root:string,signal:AbortSignal,budget?:{files:number}):Promise<string>{const rows:string[]=[];for await(const path of rolloutFiles(root,signal)){const stat=await safeSessionPath(root,path);rows.push(JSON.stringify([relative(root,path),stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]));if(rows.length>100000||budget&&++budget.files>100000)throw new Error('扫描范围超过 10 万个会话文件')};return textHash(rows.sort().join('\n'))}
  private validate(home:ImportHome):ClientConfigTarget{
    const target=this.configs.identityTarget(home.target.id),stat=lstatSync(target.directory,{throwIfNoEntry:false})
    const sameRoot=home.rootIdentity?!!stat&&stat.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===home.rootIdentity.device&&stat.ino===home.rootIdentity.inode:target.managed&&!stat
    if(target.directory!==home.target.directory||!sameRoot||this.transfers.config(target).hash!==home.configHash||this.profile(target.id)!==home.profileHash)throw new Error('目录、配置或实例在预览后发生变化')
    return target
  }
  private recovery(id:string,journal:TrashJournal|undefined,message:string):void{this.recoveries.set(id,{id,targetId:journal?.targetId??'',targetName:journal?.targetName??'未识别目录',phase:journal?.phase??'invalid',message,canResume:!!journal&&!journal.imported&&['backed_up','deleting','trashed'].includes(journal.phase),canRestore:!!journal&&journal.phase!=='preparing'})}
  private inspect():TrashJournal[]{
    const result:TrashJournal[]=[];this.recoveries.clear();if(!existsSync(this.root))return result;directory(this.root)
    const entries=readdirSync(this.root,{withFileTypes:true});if(entries.length>10000)throw new Error('废纸篓超过 1 万个批次，请先整理备份')
    for(const entry of entries){if(!z.string().uuid().safeParse(entry.name).success)continue;let journal:TrashJournal|undefined
      try{
        if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('废纸篓批次目录已变化')
        journal=loadTrashJournal(this.folder(entry.name))
        // These markers follow successful file + index restoration or explicit
        // permanent cleanup. Reclaim only private completed backup entries.
        if(!unfinished(journal)){
          const cleanup=[...new Set([...(journal.restoredIds??[]),...(journal.removedIds??[])])]
          if(cleanup.length){purgeTrashBatch(this.folder(entry.name),cleanup);if(!existsSync(this.folder(entry.name)))continue;journal=loadTrashJournal(this.folder(entry.name))}
        }
        if(unfinished(journal))this.recovery(entry.name,journal,journal.phase==='preparing'?journal.imported?'导入备份过程中退出，旧备份与原会话未改动':'备份过程中退出，删除尚未开始':'会话操作未完成，请继续处理或恢复原文件')
        result.push(journal)
      }catch(error){this.recovery(entry.name,journal,err(error))}
    }
    return result
  }
  recover():void{this.available();this.inspect()}
  list():TrashPage{
    this.available();const batches=this.inspect(),rows=new Map<string,TrashRecord>(),plans:BatchPlan[]=[]
    for(const journal of batches){if(unfinished(journal))continue;const ids=remaining(journal);if(!ids.length)continue;plans.push({id:journal.id,revision:revision(journal),sessionIds:ids,targetId:journal.targetId})
      for(const id of ids){const files=journal.files.filter(file=>file.id===id);if(!files.length)continue;const latest=files.reduce((a,b)=>(a.updatedAt??0)>(b.updatedAt??0)?a:b)
        let row=rows.get(id);if(!row){row={id,title:latest.title,cwd:latest.cwd,deletedAt:journal.deletedAt,bytes:0,copies:0,locations:[]};rows.set(id,row)}
        if(journal.deletedAt>row.deletedAt){row.deletedAt=journal.deletedAt;row.title=latest.title;row.cwd=latest.cwd}
        row.bytes+=files.reduce((sum,file)=>sum+file.stored.size,0);row.copies+=files.length
        if(!row.locations.some(location=>location.id===journal.targetId))row.locations.push({id:journal.targetId,name:journal.targetName,directory:journal.root})
      }
    }
    if(rows.size>100000)throw new Error('废纸篓超过 10 万个会话，请先整理备份')
    this.snapshot={id:randomUUID(),rows:[...rows.values()].sort((a,b)=>b.deletedAt-a.deletedAt||a.id.localeCompare(b.id)),batches:plans}
    return this.page({snapshotId:this.snapshot.id,page:1,pageSize:25})
  }
  page(raw:unknown):TrashPage{const input=trashPageSchema.parse(raw),snapshot=this.snapshot;if(!snapshot||snapshot.id!==input.snapshotId)throw new Error('废纸篓列表已更新，请刷新');const page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.rows.length/input.pageSize)));return {snapshotId:snapshot.id,total:snapshot.rows.length,page,pageSize:input.pageSize,items:structuredClone(snapshot.rows.slice((page-1)*input.pageSize,page*input.pageSize))}}
  async selectLegacy(path:string):Promise<LegacyTrashPage>{
    this.available();this.pending=undefined;this.legacy=undefined
    const job=this.begin('import',[],'preparing')
    return this.execute(job,async()=>{
      const source=await scanLegacyTrash(path,job.controller.signal,(_files,bytes)=>{job.view.bytes=bytes}),rows=new Map<string,LegacyTrashRow>(),groups=new Map<string,LegacyTrashGroup>()
      for(const entry of source.entries){
        groups.set(entry.groupId,{id:entry.groupId,name:entry.sourceName,originalRoot:entry.originalRoot})
        let row=rows.get(entry.id);if(!row){row={id:entry.id,title:entry.title,copies:0,bytes:0,deletedAt:entry.deletedAt,groupIds:[]};rows.set(entry.id,row)}
        if(entry.deletedAt>row.deletedAt){row.title=entry.title;row.deletedAt=entry.deletedAt};row.copies++;row.bytes+=entry.stamp.size;if(!row.groupIds.includes(entry.groupId))row.groupIds.push(entry.groupId)
      }
      this.legacy={id:randomUUID(),source,rows:[...rows.values()].sort((a,b)=>b.deletedAt-a.deletedAt||a.id.localeCompare(b.id)),groups:[...groups.values()],expires:this.now()+300000};job.view.status='ready'
      return this.legacyPage({snapshotId:this.legacy.id,page:1})
    })
  }
  legacyPage(raw:unknown):LegacyTrashPage{
    const input=trashPageSchema.parse(raw),snapshot=this.legacy;if(!snapshot||snapshot.id!==input.snapshotId||snapshot.expires<this.now())throw new Error('旧废纸篓预览已过期，请重新选择')
    const page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.rows.length/input.pageSize)))
    return {snapshotId:snapshot.id,root:snapshot.source.root,total:snapshot.rows.length,copies:snapshot.source.entries.length,bytes:snapshot.rows.reduce((sum,row)=>sum+row.bytes,0),page,pageSize:input.pageSize,items:structuredClone(snapshot.rows.slice((page-1)*input.pageSize,page*input.pageSize)),groups:structuredClone(snapshot.groups)}
  }
  async discardLegacy():Promise<void>{await this.discard();this.legacy=undefined}
  async previewLegacy(raw:unknown):Promise<TrashPreview>{
    const input=legacyTrashImportSchema.parse(raw),snapshot=this.legacy;this.available();this.pending=undefined
    if(!snapshot||snapshot.id!==input.snapshotId||snapshot.expires<this.now())throw new Error('旧废纸篓预览已过期，请重新选择')
    const ids=new Set(input.sessionIds),selected=snapshot.source.entries.filter(entry=>ids.has(entry.id)),sourceIds=new Set(selected.map(entry=>entry.groupId)),mapping=new Map(input.mappings.map(row=>[row.sourceId,row.targetId]))
    if(new Set(selected.map(entry=>entry.id)).size!==ids.size||mapping.size!==input.mappings.length||mapping.size!==sourceIds.size||[...sourceIds].some(id=>!mapping.has(id)))throw new Error('请选择当前列表中的会话，并为每个所选来源指定一个已登记目标')
    this.inspect();const targetIds=[...new Set(mapping.values())];this.free(targetIds)
    const registry=this.registry(),job=this.begin('import',targetIds,'preparing'),signal=job.controller.signal
    return this.execute(job,async()=>{
      await verifyLegacyTrash(snapshot.source,signal,selected)
      const homes:ImportHome[]=targetIds.map(id=>{const target=this.configs.identityTarget(id),stat=lstatSync(target.directory,{throwIfNoEntry:false});return {target,rootIdentity:stat?fileIdentity(stat):undefined,configHash:this.transfers.config(target).hash,profileHash:this.profile(id)}}),files:ImportPlan['files']=[],seen=new Set<string>()
      for(const entry of selected){
        const targetId=mapping.get(entry.groupId)!,batchId=importedBatchId(entry.key,targetId);if(seen.has(batchId))continue;seen.add(batchId)
        const folder=join(this.root,batchId);let duplicate:string|undefined
        if(existsSync(folder)){const journal=loadTrashJournal(folder);if(journal.imported?.key!==entry.key||journal.targetId!==targetId||unfinished(journal))throw new Error('已有导入备份未完成或发生变化，请先处理恢复任务');await verifyBackup(folder,journal,signal);duplicate=revision(journal)}
        files.push({entry,targetId,batchId,duplicate})
      }
      if(existsSync(this.root)&&readdirSync(this.root).length+files.filter(file=>!file.duplicate).length>10000)throw new Error('导入后废纸篓批次超过 1 万，请先整理')
      const targets=homes.map(home=>{const rows=files.filter(file=>file.targetId===home.target.id&&!file.duplicate);return {id:home.target.id,name:home.target.name,directory:home.target.directory,sessions:new Set(rows.map(file=>file.entry.id)).size,descendants:0,copies:rows.length,bytes:rows.reduce((sum,file)=>sum+file.entry.stamp.size,0),officialPlan:true}})
      for(const home of homes)this.validate(home);if(this.registry()!==registry)throw new Error('目标目录登记发生变化，请重新预览');signal.throwIfAborted()
      const view:TrashPreview={ticket:randomUUID(),action:'import',requested:ids.size,sessions:ids.size,copies:targets.reduce((n,row)=>n+row.copies,0),bytes:targets.reduce((n,row)=>n+row.bytes,0),targets,titles:snapshot.rows.filter(row=>ids.has(row.id)).slice(0,20).map(row=>row.title),skippedCopies:selected.length-files.filter(file=>!file.duplicate).length}
      this.pending={view,importPlan:{source:snapshot.source,homes,files},expires:this.now()+300000,registry};Object.assign(job.view,{status:'ready',totalBytes:view.bytes});return structuredClone(view)
    })
  }
  async previewTrash(raw:unknown):Promise<TrashPreview>{
    const input=trashPreviewSchema.parse(raw),selected=this.catalog.selectedRecords(input.snapshotId,input.sessionIds);this.available();this.pending=undefined
    const targets=this.configs.targets().filter(target=>existsSync(target.directory)),registry=this.registry();this.free(targets.map(target=>target.id))
    const job=this.begin('trash',targets.map(target=>target.id),'preparing'),signal=job.controller.signal
    return this.execute(job,async()=>{
      const program=this.program(input.applicationId),homes:HomePlan[]=[],parents=new Map<string,string>(),requested=new Set(selected.map(row=>row.id)),wanted=new Set(requested),budget={files:0}
      for(let i=0;i<targets.length;i++)for(const other of targets.slice(i+1))if(overlaps(targets[i].directory,other.directory))throw new Error('废纸篓来源目录不能相互包含')
      for(const row of targets){
        const target=this.configs.identityTarget(row.id);await this.transfers.closed(target,signal);const config=this.transfers.config(target)
        const home:HomePlan={target,rootIdentity:fileIdentity(lstatSync(target.directory)),configHash:config.hash,profileHash:this.profile(target.id),inventory:await this.inventory(target.directory,signal,budget),sources:[],closure:[],officialPlan:true}
        const catalog=new SessionCatalog(this.store),cancel=()=>catalog.stop();signal.addEventListener('abort',cancel,{once:true})
        try{const page=await catalog.scan({runId:randomUUID(),targetId:target.id});home.sources=await catalog.syncSources(page.snapshotId,signal)}finally{signal.removeEventListener('abort',cancel);catalog.stop()}
        for(const source of home.sources){
          const {file,stat}=await openSessionFile(source.root,source.path)
          try{const event=await firstSessionEvent(file,stat.size,signal),payload=event?.payload,sourceParent=payload?.source?.subagent?.thread_spawn?.parent_thread_id,parent=payload?.parent_thread_id??sourceParent
            if(sourceParent!=null&&payload?.parent_thread_id!=null&&sourceParent!==payload.parent_thread_id)throw new Error('会话文件包含矛盾的派生关系')
            if(parent!=null){z.string().uuid().parse(parent);if(parents.has(source.record.id)&&parents.get(source.record.id)!==parent)throw new Error('会话副本包含矛盾的派生关系');parents.set(source.record.id,parent)}
          }finally{await file.close()}
        }
        try{home.closure=await this.runtime.plan(program,target.directory,[...requested],signal)}catch(error){signal.throwIfAborted();home.officialPlan=false}
        for(const entry of home.closure){wanted.add(entry.id);if(entry.parentId){if(parents.has(entry.id)&&parents.get(entry.id)!==entry.parentId)throw new Error('官方索引与会话文件的派生关系不一致');parents.set(entry.id,entry.parentId)}}
        if(wanted.size>1000)throw new Error('所选会话及派生会话超过 1000 条，请缩小范围')
        homes.push(home)
      }
      let changed=true;while(changed){changed=false;for(const [id,parent] of parents)if(wanted.has(parent)&&!wanted.has(id)){wanted.add(id);changed=true;if(wanted.size>1000)throw new Error('所选会话及派生会话超过 1000 条，请缩小范围')}}
      const affected:HomePlan[]=[],views:TrashTargetPreview[]=[]
      for(const home of homes){
        const sources=home.sources.filter(source=>wanted.has(source.record.id));this.validate(home)
        if(await this.inventory(home.target.directory,signal)!==home.inventory)throw new Error('预览期间会话文件发生变化')
        if(!sources.length)continue
        const ids=[...new Set(sources.map(source=>source.record.id))]
        const closure=ids.map(id=>({...home.closure.find(row=>row.id===id),id,descendant:!requested.has(id),parentId:parents.get(id)}))
        home.sources=sources;home.closure=closure;affected.push(home)
        views.push({id:home.target.id,name:home.target.name,directory:home.target.directory,sessions:ids.length,descendants:ids.filter(id=>!requested.has(id)).length,copies:sources.length,bytes:sources.reduce((sum,file)=>sum+file.size,0),officialPlan:home.officialPlan})
      }
      const sources=affected.flatMap(home=>home.sources),bytes=views.reduce((sum,row)=>sum+row.bytes,0)
      if(!sources.length||sources.length>10000||bytes>100*1024**3)throw new Error('每次支持 1–10000 份副本、最多 100 GiB')
      if(this.registry()!==registry)throw new Error('会话目录登记在预览期间变化，请重新预览')
      verifySessionProgram(program);signal.throwIfAborted()
      const view:TrashPreview={ticket:randomUUID(),action:'trash',requested:requested.size,sessions:new Set(sources.map(file=>file.record.id)).size,copies:sources.length,bytes,targets:views,titles:selected.slice(0,20).map(row=>row.title)}
      this.pending={view,homes:affected,program,applicationId:input.applicationId,expires:this.now()+300000,registry};Object.assign(job.view,{status:'ready',targets:affected.length,totalBytes:bytes});return structuredClone(view)
    })
  }
  async previewAction(raw:unknown):Promise<TrashPreview>{
    const input=trashActionSchema.parse(raw);this.available();this.pending=undefined
    const snapshot=this.snapshot;if(!snapshot||snapshot.id!==input.snapshotId)throw new Error('废纸篓列表已更新，请刷新')
    const ids=new Set(input.all?snapshot.rows.map(row=>row.id):input.sessionIds!),rows=snapshot.rows.filter(row=>ids.has(row.id));if(!rows.length||rows.length!==ids.size)throw new Error('所选会话不在当前废纸篓列表中')
    if(input.action==='restore'&&(!input.applicationId||!input.clientsClosed))throw new Error('请选择 Codex 程序并确认已关闭相关客户端')
    const batches=snapshot.batches.filter(batch=>batch.sessionIds.some(id=>ids.has(id))).map<BatchPlan>(batch=>({...batch,sessionIds:batch.sessionIds.filter(id=>ids.has(id))})),targetIds=[...new Set(batches.map(batch=>batch.targetId))];this.free(targetIds)
    const job=this.begin(input.action,targetIds,'preparing'),signal=job.controller.signal
    return this.execute(job,async()=>{
      const program=input.action==='restore'?this.program(input.applicationId!):undefined,targets=new Map<string,TrashTargetPreview>()
      for(const batch of batches){const journal=loadTrashJournal(this.folder(batch.id));if(revision(journal)!==batch.revision||unfinished(journal))throw new Error('废纸篓内容已变化，请刷新')
        if(input.action==='restore'){const target=this.target(journal);await this.transfers.closed(target,signal);batch.configHash=this.transfers.config(target).hash;batch.profileHash=this.profile(target.id)}
        let row=targets.get(journal.targetId);if(!row){row={id:journal.targetId,name:journal.targetName,directory:journal.root,sessions:0,descendants:0,copies:0,bytes:0,officialPlan:true};targets.set(journal.targetId,row)}
        const files=journal.files.filter(file=>batch.sessionIds.includes(file.id));row.sessions+=batch.sessionIds.length;row.copies+=files.length;row.bytes+=files.reduce((sum,file)=>sum+file.stored.size,0)
      }
      signal.throwIfAborted();const values=[...targets.values()],view:TrashPreview={ticket:randomUUID(),action:input.action,requested:ids.size,sessions:ids.size,copies:values.reduce((n,row)=>n+row.copies,0),bytes:values.reduce((n,row)=>n+row.bytes,0),targets:values,titles:rows.slice(0,20).map(row=>row.title)}
      this.pending={view,batches,program,applicationId:input.applicationId,expires:this.now()+300000,registry:this.registry()};Object.assign(job.view,{status:'ready',totalBytes:view.bytes});return structuredClone(view)
    })
  }
  start(raw:unknown):void{
    const input=z.object({ticket:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(raw),pending=this.pending;this.available()
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('废纸篓预览已过期，请重新预览')
    this.free(pending.view.targets.map(row=>row.id));if(this.registry()!==pending.registry)throw new Error('目录登记已变化，请重新预览')
    this.pending=undefined;const job=this.begin(pending.view.action,pending.view.targets.map(row=>row.id),'running');job.view.totalBytes=pending.view.bytes
    void this.execute(job,()=>this.run(job,pending)).catch(()=>{})
  }
  private async run(job:Job,pending:Pending):Promise<void>{
    const signal=job.controller.signal
    try{
      if(pending.program){if(!pending.applicationId||this.program(pending.applicationId).path!==pending.program.path)throw new Error('Codex 程序登记已变化');verifySessionProgram(pending.program)}
      if(pending.importPlan){
        const plan=pending.importPlan
        await verifyLegacyTrash(plan.source,signal,plan.files.map(file=>file.entry));for(const home of plan.homes)this.validate(home)
        signal.throwIfAborted()
        // Only explicit confirmation may create a missing manager-owned home.
        // Preview records its absence, so another process creating it invalidates
        // the ticket. External homes must already exist and remain registered.
        for(const home of plan.homes)if(!home.rootIdentity){
          this.validate(home);const target=this.configs.prepareIdentityTarget(home.target.id)
          home.rootIdentity=fileIdentity(lstatSync(target.directory))
        }
        directory(this.root,true)
        for(const home of plan.homes){
          this.validate(home)
          for(const file of plan.files.filter(file=>file.targetId===home.target.id)){
            signal.throwIfAborted();this.validate(home);const folder=this.folder(file.batchId)
            if(file.duplicate){const journal=loadTrashJournal(folder);if(revision(journal)!==file.duplicate)throw new Error('已有导入备份在预览后变化');await verifyBackup(folder,journal,signal);continue}
            const before=job.view.bytes
            await importTrashBackup(this.root,{id:file.batchId,targetId:home.target.id,targetName:home.target.name,root:home.target.directory,configHash:home.configHash,file:file.entry},signal,bytes=>{job.view.bytes=before+bytes})
            job.view.importedCopies=(job.view.importedCopies??0)+1
          }
          job.view.completedTargets.push(home.target.id)
        }
        await verifyLegacyTrash(plan.source,signal,plan.files.map(file=>file.entry))
      }else if(pending.homes){
        for(const home of pending.homes){await this.transfers.closed(this.validate(home),signal);if(await this.inventory(home.target.directory,signal)!==home.inventory)throw new Error('预览后会话文件发生变化')}
        directory(this.root,true)
        for(const home of pending.homes){
          signal.throwIfAborted();await this.transfers.closed(this.validate(home),signal)
          if(await this.inventory(home.target.directory,signal)!==home.inventory)throw new Error('删除前会话文件发生变化')
          for(const source of home.sources)await verifySource(source)
          const before=job.view.bytes,{folder,journal}=await prepareTrashBatch(this.root,{targetId:home.target.id,targetName:home.target.name,root:home.target.directory,sources:home.sources,selectedIds:[...new Set(home.sources.map(file=>file.record.id))],closure:home.closure,configHash:home.configHash},signal,bytes=>{job.view.bytes=before+bytes})
          // Recheck daemon after potentially large backups and before destruction.
          await this.transfers.closed(this.validate(home),signal)
          try{await deleteTrashOriginals(folder,pending.program!,signal,this.runtime)}catch(error){const saved=loadTrashJournal(folder);this.recovery(journal.id,saved,err(error));if(saved.phase!=='trashed'||signal.aborted)throw error}
          if(loadTrashJournal(folder).officialFallback)job.view.fallbackTargets=(job.view.fallbackTargets??0)+1
          job.view.completedTargets.push(home.target.id)
        }
      }else{
        // Validate every batch before the first irreversible removal/restoration.
        for(const batch of pending.batches!){const journal=loadTrashJournal(this.folder(batch.id));if(revision(journal)!==batch.revision)throw new Error('废纸篓内容在预览后发生变化');if(pending.view.action==='restore'){const target=this.target(journal);await this.transfers.closed(target,signal);if(this.transfers.config(target).hash!==batch.configHash||this.profile(target.id)!==batch.profileHash)throw new Error('恢复目标配置在预览后变化')}}
        const processed=new Set<string>()
        for(const batch of pending.batches!){
          signal.throwIfAborted();const folder=this.folder(batch.id),journal=loadTrashJournal(folder);if(revision(journal)!==batch.revision)throw new Error('废纸篓批次已变化')
          if(pending.view.action==='restore'){const target=this.target(journal);await this.transfers.closed(target,signal);if(this.transfers.config(target).hash!==batch.configHash||this.profile(target.id)!==batch.profileHash)throw new Error('恢复目标配置在预览后变化');journal.configHash=batch.configHash!;saveTrashJournal(folder,journal);await restoreTrashBatch(folder,pending.program!,signal,this.runtime,batch.sessionIds)}
          purgeTrashBatch(folder,batch.sessionIds)
          job.view.bytes+=journal.files.filter(file=>batch.sessionIds.includes(file.id)).reduce((sum,file)=>sum+file.stored.size,0)
          processed.add(batch.id)
          if(pending.batches!.filter(value=>value.targetId===batch.targetId).every(value=>processed.has(value.id)))job.view.completedTargets.push(batch.targetId)
        }
      }
      job.view.status='completed'
    }finally{this.snapshot=undefined;this.inspect()}
  }
  async recoverBatch(raw:unknown):Promise<void>{
    const input=z.object({id:z.string().uuid(),mode:z.enum(['resume','restore','discard']),applicationId:z.string().min(1).max(100).optional(),clientsClosed:z.literal(true)}).strict().parse(raw);this.available();this.pending=undefined
    const folder=this.folder(input.id),journal=loadTrashJournal(folder)
    if(input.mode==='discard'&&journal.imported){
      // Import preparation never writes the destination home. Its private
      // partial backup can be discarded even if that home no longer exists.
      this.free([journal.targetId],true);const job=this.begin('recover',[journal.targetId],'running')
      await this.execute(job,async()=>{try{discardTrashPreparation(folder);job.view.completedTargets=[journal.targetId];job.view.status='completed'}finally{this.snapshot=undefined;this.inspect()}});return
    }
    const target=this.target(journal);this.free([target.id],true)
    const program=input.mode==='discard'?undefined:this.program(input.applicationId??''),job=this.begin('recover',[target.id],'running')
    await this.execute(job,async()=>{try{await this.transfers.closed(target,job.controller.signal);this.target(journal)
      if(input.mode==='discard')discardTrashPreparation(folder)
      else if(input.mode==='resume')await deleteTrashOriginals(folder,program!,job.controller.signal,this.runtime)
      else{journal.configHash=this.transfers.config(target).hash;saveTrashJournal(folder,journal);await restoreTrashBatch(folder,program!,job.controller.signal,this.runtime);const restored=loadTrashJournal(folder);purgeTrashBatch(folder,restored.restoredIds??restored.allIds)}
      job.view.completedTargets=[target.id];job.view.status='completed'
    }finally{this.snapshot=undefined;this.inspect()}})
  }
  backupLocation(id:string):string{const folder=this.folder(id);directory(folder);if(!this.recoveries.has(id))loadTrashJournal(folder);return folder}
}
