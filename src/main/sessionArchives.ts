import {randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,readdirSync,rmSync,realpathSync} from 'node:fs'
import {join,relative,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs,directory} from './clientConfig'
import {SessionCatalog,type SessionTransferSource,classifySession} from './sessions'
import {SessionTransfers} from './sessionTransfers'
import {firstSessionEvent,openSessionFile,rolloutFiles,sessionIdentifier} from './sessionFiles'
import {archiveImportSchema,archiveSelectionSchema,type ArchivePreview,type ArchiveImportPreview,type ArchiveProgress} from '../shared/sessionArchives'
import {SessionZip,archiveMaxBytes,hashSource,importRelative,selectedPath,writeSessionZip,type SessionManifest,type FileStamp} from './sessionZip'
import type {SessionCopyPreview} from '../shared/sessions'

type Job={view:ArchiveProgress;controller:AbortController;task?:Promise<unknown>;sourceIds:Set<string>}
const safeError=(error:unknown)=>error instanceof Error&&/^(会话|来源|目标|导出|不能|相关|所选|请选择|Codex|每次|已有)/.test(error.message)?error.message:'会话 ZIP 操作失败，请检查文件格式、来源变化、权限与可用磁盘空间'
const within=(root:string,path:string)=>path===root||path.startsWith(root+sep)
export class SessionArchives {
  private readonly configs:ClientConfigs
  private readonly scratch:string
  private job?:Job
  private exportPending?:{view:ArchivePreview;sources:SessionTransferSource[];expires:number}
  private packagePending?:{view:ArchivePreview;path:string;stamp:FileStamp;expires:number}
  private importPending?:{view:ArchiveImportPreview;root:string;expires:number}
  private timer?:NodeJS.Timeout
  constructor(private readonly store:Store,private readonly catalog:SessionCatalog,private readonly transfers:SessionTransfers,private readonly now:()=>number=Date.now,private readonly inUse:(id:string)=>boolean=()=>false){
    this.configs=new ClientConfigs(store);this.scratch=join(realpathSync(store.directory),'session-archive-staging')
    if(existsSync(this.scratch)){directory(this.scratch);for(const entry of readdirSync(this.scratch,{withFileTypes:true}))if(entry.isDirectory()&&z.string().uuid().safeParse(entry.name).success)rmSync(join(this.scratch,entry.name),{recursive:true})}
  }
  view():ArchiveProgress|undefined{return this.job?structuredClone(this.job.view):undefined}
  busy(id:string):boolean{return !!this.job?.task&&this.job.sourceIds.has(id)}
  private available():void{if(this.job?.task)throw new Error('已有会话 ZIP 操作正在执行')}
  private begin(operation:'import'|'export',status:ArchiveProgress['status']='preparing'):Job{
    this.available();const job:Job={view:{id:randomUUID(),operation,status,files:0,totalFiles:0,bytes:0,totalBytes:0},controller:new AbortController(),sourceIds:new Set()};this.job=job;return job
  }
  private async execute<T>(job:Job,action:()=>Promise<T>):Promise<T>{
    const task=action();job.task=task
    try{return await task}catch(error){job.view.status=job.controller.signal.aborted?'cancelled':'failed';job.view.error=job.controller.signal.aborted?'操作已取消':safeError(error);throw new Error(job.view.error)}finally{job.task=undefined}
  }
  private expiry():void{clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.job?.task)this.clear()},300000);this.timer.unref()}
  private cleanup(root:string):void{directory(this.scratch);if(existsSync(root)){directory(root);rmSync(root,{recursive:true})}}
  private clear():void{
    clearTimeout(this.timer);this.exportPending=undefined;this.packagePending=undefined
    if(this.importPending){this.transfers.discard();this.cleanup(this.importPending.root);this.importPending=undefined}
    if(this.job?.view.status==='ready')this.job.view.status='cancelled'
  }
  async discard():Promise<void>{if(this.job?.task)await this.cancel(this.job.view.id);this.clear()}
  async discardPreview():Promise<void>{if(this.job?.task&&this.job.view.status==='running')return;await this.discard()}
  private sourceCurrent(source:SessionTransferSource):void{if(this.configs.identityTarget(source.targetId).directory!==source.root)throw new Error('来源目录登记已变化，请重新选择')}
  async previewExport(raw:unknown):Promise<ArchivePreview>{
    const input=archiveSelectionSchema.parse(raw);this.available();this.clear();const job=this.begin('export')
    return this.execute(job,async()=>{
      const sources=await this.catalog.transferSources(input.snapshotId,input.sessionIds,job.controller.signal),total=sources.reduce((sum,item)=>sum+item.size,0)
      if(sources.some(source=>this.inUse(source.targetId)))throw new Error('来源目录有正在执行或等待恢复的会话操作')
      if(total>archiveMaxBytes)throw new Error('所选会话超过 100 GiB，请分批导出')
      const view:ArchivePreview={ticket:randomUUID(),totalBytes:total,items:sources.map(source=>({id:source.record.id,title:source.record.title,cwd:source.record.cwd,bytes:source.size,archived:source.record.locations[0].archived,sourceName:source.record.locations[0].name}))}
      this.exportPending={view,sources,expires:this.now()+300000};Object.assign(job.view,{status:'ready',totalFiles:sources.length,totalBytes:total});this.expiry();return structuredClone(view)
    })
  }
  startExport(ticket:string,path:string):ArchiveProgress{
    z.string().uuid().parse(ticket);this.available();const pending=this.exportPending
    if(!pending||pending.view.ticket!==ticket||pending.expires<this.now())throw new Error('会话导出预览已过期')
    path=selectedPath(path)
    if([realpathSync(this.store.directory),...this.configs.targets().map(target=>target.directory)].some(root=>within(root,path)))throw new Error('导出位置须在应用数据和已登记的 Codex 目录以外')
    for(const source of pending.sources){this.sourceCurrent(source);if(this.transfers.busy(source.targetId)||this.inUse(source.targetId))throw new Error('来源目录有正在执行或等待恢复的会话操作')}
    this.exportPending=undefined;clearTimeout(this.timer);const job=this.begin('export','running');job.sourceIds=new Set(pending.sources.map(source=>source.targetId));Object.assign(job.view,{totalFiles:pending.sources.length,totalBytes:pending.view.totalBytes*2})
    void this.execute(job,async()=>{
      const signal=job.controller.signal,indexes=await this.transfers.sourceIndexes(pending.sources,signal),items:SessionManifest['sessions']=[];let bytes=0
      for(const [index,source] of pending.sources.entries()){
        const hash=await hashSource(source,signal,size=>{job.view.bytes=bytes+size});bytes+=source.size
        items.push({sessionId:source.record.id,title:source.record.title,cwd:source.record.cwd,updatedAt:Math.floor((source.record.updatedAt??source.mtime)/1000),relativeRolloutPath:relative(source.root,source.path).split(sep).join('/'),fileEntry:`files/${String(index+1).padStart(4,'0')}-${source.record.id}/rollout.jsonl`,sizeBytes:source.size,sha256:hash,sessionIndexEntry:indexes.get(source.root+'\0'+source.record.id)??{},sourceInstance:{id:source.targetId,name:source.record.locations[0].name}})
      }
      await writeSessionZip(path,{kind:'codex-session-export',packageVersion:1,exportedAt:new Date(this.now()).toISOString(),sessions:items},pending.sources,signal,(files,size)=>{job.view.files=files;job.view.bytes=bytes+size})
      job.view.status='completed';job.view.path=path
    }).catch(()=>{})
    return this.view()!
  }
  async openPackage(path:string):Promise<ArchivePreview>{
    this.available();this.clear();const job=this.begin('import')
    return this.execute(job,async()=>{
      const archive=await SessionZip.read(path,job.controller.signal)
      try{
        const view:ArchivePreview={ticket:randomUUID(),fileName:archive.path,exportedAt:archive.manifest.exportedAt,items:archive.manifest.sessions.map(item=>({id:item.sessionId,title:item.title,cwd:item.cwd,bytes:item.sizeBytes,archived:importRelative(item).startsWith('archived_sessions/'),sourceName:item.sourceInstance.name})),totalBytes:archive.manifest.sessions.reduce((sum,item)=>sum+item.sizeBytes,0)}
        this.packagePending={view,path:archive.path,stamp:archive.stamp,expires:this.now()+300000};Object.assign(job.view,{status:'ready',totalFiles:view.items.length,totalBytes:view.totalBytes});this.expiry();return structuredClone(view)
      }finally{await archive.close()}
    })
  }
  async previewImport(raw:unknown):Promise<ArchiveImportPreview>{
    const input=archiveImportSchema.parse(raw);this.available();const pending=this.packagePending
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('会话包预览已过期，请重新选择')
    if(this.importPending){this.transfers.discard();this.cleanup(this.importPending.root);this.importPending=undefined}
    const job=this.begin('import'),signal=job.controller.signal
    return this.execute(job,async()=>{
      if(this.transfers.active())throw new Error('已有会话操作正在执行')
      const archive=await SessionZip.read(pending.path,signal,pending.stamp);let root:string|undefined
      try{
        const ids=new Set(input.sessionIds),items=archive.manifest.sessions.filter(item=>ids.has(item.sessionId))
        if(items.length!==ids.size)throw new Error('所选会话不在当前会话包中')
        Object.assign(job.view,{totalFiles:items.length,totalBytes:items.reduce((sum,item)=>sum+item.sizeBytes,0)})
        directory(this.scratch,true);root=join(this.scratch,randomUUID());mkdirSync(root,{mode:0o700})
        const rootStat=lstatSync(root),sources:SessionTransferSource[]=[],indexes=new Map<string,Record<string,unknown>>();let bytes=0
        for(const [index,item] of items.entries()){
          signal.throwIfAborted();const rel=importRelative(item),folder=join(root,rel.startsWith('archived_sessions/')?'archived_sessions':'sessions');if(!existsSync(folder))mkdirSync(folder,{mode:0o700})
          // Synthetic private filenames avoid archive path traversal and retain
          // active/archived status. Publication chooses the official layout.
          const path=join(folder,'rollout-'+item.sessionId+'.jsonl')
          await archive.extract(item,path,signal,size=>{job.view.bytes=bytes+size});bytes+=item.sizeBytes
          const {file,stat}=await openSessionFile(root,path)
          try{
            const meta=await firstSessionEvent(file,stat.size,signal)
            if(meta?.type!=='session_meta'||sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)!==item.sessionId)throw new Error('会话包中的会话 ID 与文件内容不一致')
            sources.push({path,root,targetId:input.targetId,rootDevice:rootStat.dev,rootInode:rootStat.ino,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,record:{id:item.sessionId,title:item.title,cwd:item.cwd,kind:classifySession(item.title,item.cwd),updatedAt:item.updatedAt==null?stat.mtimeMs:item.updatedAt*1000,locations:[{targetId:input.targetId,name:item.sourceInstance.name,directory:root,running:false,archived:rel.startsWith('archived_sessions/'),ambiguous:false}]}})
            indexes.set(root+'\0'+item.sessionId,item.sessionIndexEntry&&typeof item.sessionIndexEntry==='object'&&!Array.isArray(item.sessionIndexEntry)?item.sessionIndexEntry as Record<string,unknown>:{})
          }finally{await file.close()}
          job.view.files=index+1
        }
        archive.verify();signal.throwIfAborted()
        const copy=await this.transfers.previewImported(input.targetId,input.applicationId,sources,indexes,signal)
        const existing=await this.existing(copy,items,signal);signal.throwIfAborted()
        const view:ArchiveImportPreview={...copy,packageTicket:pending.view.ticket,existing}
        this.importPending={view,root,expires:this.now()+300000};root=undefined;job.view.status='ready';this.expiry();return structuredClone(view)
      }finally{await archive.close();if(root)this.cleanup(root)}
    })
  }
  private async existing(copy:SessionCopyPreview,items:SessionManifest['sessions'],signal:AbortSignal):Promise<Record<string,'duplicate'|'conflict'>>{
    const wanted=new Map(items.filter(item=>copy.items.find(row=>row.id===item.sessionId)?.status==='existing').map(item=>[item.sessionId,item])),result:Record<string,'duplicate'|'conflict'>={}
    if(!wanted.size)return result
    const seen=new Set<string>(),root=copy.directory,rootStat=lstatSync(root)
    for await(const path of rolloutFiles(root,signal)){
      const {file,stat}=await openSessionFile(root,path)
      let id:string|undefined
      try{const meta=await firstSessionEvent(file,stat.size,signal);if(meta?.type==='session_meta')id=sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)}finally{await file.close()}
      if(!id||!wanted.has(id))continue
      if(seen.has(id)){result[id]='conflict';continue}seen.add(id)
      const item=wanted.get(id)!,source:SessionTransferSource={path,root,targetId:copy.targetId,rootDevice:rootStat.dev,rootInode:rootStat.ino,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,record:{id,title:item.title,cwd:item.cwd,kind:'conversation',locations:[]}}
      result[id]=stat.size===item.sizeBytes&&await hashSource(source,signal,()=>{})===item.sha256.toLowerCase()?'duplicate':'conflict'
    }
    for(const id of wanted.keys())if(!result[id])throw new Error('目标会话在预览期间变化，请重新预览')
    return result
  }
  startImport(raw:unknown):ArchiveProgress{
    const input=z.object({ticket:z.string().uuid(),clientsClosed:z.literal(true)}).strict().parse(raw);this.available();const pending=this.importPending
    if(!pending||pending.view.ticket!==input.ticket||pending.expires<this.now())throw new Error('会话导入预览已过期')
    this.transfers.start(input,'import');this.importPending=undefined;this.packagePending=undefined;clearTimeout(this.timer)
    const job=this.begin('import','running');Object.assign(job.view,{totalFiles:pending.view.items.filter(item=>item.status==='ready').length,totalBytes:pending.view.totalBytes})
    void this.execute(job,async()=>{
      try{
        await this.transfers.settled();const result=this.transfers.view().transfer!
        job.view.files=result.files;job.view.bytes=result.bytes
        if(result.status!=='completed')throw new Error(result.error??'会话导入未完成')
        job.view.status='completed';job.view.error=result.indexError
      }finally{this.cleanup(pending.root)}
    }).catch(()=>{})
    return this.view()!
  }
  async cancel(id:string):Promise<void>{
    z.string().uuid().parse(id);if(this.job?.view.id!==id)throw new Error('会话 ZIP 操作已更新')
    const job=this.job;job.controller.abort()
    if(job.view.operation==='import'&&job.view.status==='running'&&this.transfers.active())await this.transfers.cancel(this.transfers.view().transfer!.id)
    await job.task?.catch(()=>{})
    if(job.view.status==='ready')this.clear()
  }
  async settled():Promise<void>{await this.job?.task?.catch(()=>{})}
  async stop():Promise<void>{await this.discard()}
}
