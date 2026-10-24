import {createHash,randomUUID} from 'node:crypto'
import {lstat,type FileHandle} from 'node:fs/promises'
import {existsSync,lstatSync,realpathSync,statSync,type Stats} from 'node:fs'
import {homedir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs} from './clientConfig'
import type {ClientConfigTarget} from '../shared/clientConfig'
import {sessionScanSchema,sessionPageSchema,sessionSelectionSchema,claudeResumeSelectionSchema,codexResumeSelectionSchema,sessionContentSchema,sessionStatsSchema,type SessionCopySourceSelection,type SessionKind,type SessionLocation,type SessionRecord,type SessionPage,type SessionTokenResult,type SessionSource,type SessionContentPage,type CodexResumeTicketSource} from '../shared/sessions'
import {openSessionFile,rolloutFiles,firstSessionEvent,sessionActivity,sessionTokens,sessionContains,sessionDigest,cleanText,sessionIdentifier,safeSessionPath} from './sessionFiles'
import {readSessionDisplay,readSessionRolloutIndex,displayTitle,displayProject} from './sessionDisplay'
import {probeClientDaemon} from './clientDaemon'
import {instanceHomePath,pathContains,validateExternalHome} from './instancePaths'
import {scanClaudeCodeSessionsAsync,verifyClaudeSessionLocation,readClaudeSessionContent,previewClaudeSessionResume,type ClaudeSessionLocation,type ClaudeSessionRecord,type ClaudeSessionResumePreview} from './claudeCodeSessions'
import {isClaudeDesktopProfile} from '../shared/instances'
import {readCodexSessionContent,readCodexSessionContentForMerge,readCodexSessionLineageContent} from './codexSessionContent'
import {readCodexSessionLineage} from './codexSessionLineage'
import {CodexSessionSources} from './codexSessionSources'

interface SourceFile {path:string;root:string;targetId:string;device:number;inode:number;rootDevice:number;rootInode:number;size:number;mtime:number;ctime:number;record:SessionRecord;duplicateOf?:string}
export interface SessionTransferSource {path:string;root:string;targetId:string;rootDevice:number;rootInode:number;device:number;inode:number;size:number;mtime:number;ctime:number;record:SessionRecord;sourceVersionId?:string;sourceConflict?:boolean}
interface ClaudeSourceFile {target:SessionSource;profile:string;location:ClaudeSessionLocation;sessionId:string;record:ClaudeSessionRecord}
export interface CatalogClaudeResumePreview extends ClaudeSessionResumePreview {instanceRevision:number;profileFingerprint:string}
export interface SessionCatalogOptions {defaultCodexDirectory?:string|null;defaultClaudeDirectory?:string|null;disableSqliteDisplay?:boolean;codexSessionSources?:CodexSessionSources}
const defaultClaudeSourceId='4135f4e6-6db5-4bd4-95f7-06f4c667341a'
const defaultCodexSourceId='61f5fc85-e814-4f63-9f9f-b96d94fcf51a'
interface Snapshot {id:string;scannedAt:number;records:SessionRecord[];files:Map<string,SourceFile[]>;claudeFiles:Map<string,ClaudeSourceFile>;warnings:string[];sourceCounts:Record<string,number>;sources:SessionSource[]}
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function hasPaginatedHistory(record:SessionRecord):boolean{return record.historyMode==='paginated'||record.locations.some(location=>location.historyMode==='paginated'||location.versions?.some(version=>version.historyMode==='paginated'))}
class SessionLimitError extends Error {}
export const classifySession=(title:string,cwd:string):SessionKind=>{
  const name=title.toLowerCase(),path=cwd.toLowerCase()
  if(['subagent','sub-agent','agent run'].some(value=>name.includes(value))||['/subagent','\\subagent','subagent/','subagent\\'].some(value=>path.includes(value)))return 'subagent'
  if(['external','imported','cli run'].some(value=>name.includes(value))||['imported','/external','\\external'].some(value=>path.includes(value)))return 'external'
  return 'conversation'
}
export class SessionCatalog {
  private snapshot?:Snapshot
  private scanning?:{id:string;controller:AbortController}
  private statsController?:AbortController
  private readonly configs:ClientConfigs
  private readonly root:string
  private readonly defaultCodexDirectory:string|null
  private readonly defaultClaudeDirectory:string|null
  private readonly disableSqliteDisplay:boolean
  private readonly externalCodexSources:CodexSessionSources
  constructor(private readonly store:Store,private readonly running:(id:string)=>boolean=()=>false,options:SessionCatalogOptions={}){
    this.configs=new ClientConfigs(store);this.root=realpathSync(store.directory)
    this.defaultCodexDirectory=options.defaultCodexDirectory===undefined?join(homedir(),'.codex'):options.defaultCodexDirectory
    this.defaultClaudeDirectory=options.defaultClaudeDirectory===undefined?join(homedir(),'.claude'):options.defaultClaudeDirectory
    this.disableSqliteDisplay=options.disableSqliteDisplay===true
    this.externalCodexSources=options.codexSessionSources??new CodexSessionSources(store)
    if(this.defaultCodexDirectory!==null&&(!isAbsolute(this.defaultCodexDirectory)||resolve(this.defaultCodexDirectory)!==this.defaultCodexDirectory))throw new Error('默认 Codex 会话目录必须是规范绝对路径')
    if(this.defaultClaudeDirectory!==null&&(!isAbsolute(this.defaultClaudeDirectory)||resolve(this.defaultClaudeDirectory)!==this.defaultClaudeDirectory))throw new Error('默认 Claude 会话目录必须是规范绝对路径')
  }
  private defaultCodexTarget():SessionSource|undefined {
    const directory=this.defaultCodexDirectory
    if(!directory)return
    try{
      const root=lstatSync(directory)
      if(root.isSymbolicLink()||!root.isDirectory()||realpathSync(directory)!==directory)return
      const registered=this.configs.targets()
      if(registered.some(target=>target.id===defaultCodexSourceId||target.directory===directory))return
      return {id:defaultCodexSourceId,name:'本机默认 Codex 会话目录',directory,managed:false,role:'default',clientType:'codex',readOnly:true,description:'只读扫描 ~/.codex 的会话文件和 JSONL 标题索引；不读取 SQLite，避免创建或改动 WAL/SHM 文件。不会参与复制、同步、删除或配置修改。'}
    }catch{return}
  }
  private codexIdentityTarget(id:string):ClientConfigTarget {
    if(id!==defaultCodexSourceId){
      if((this.store.read().codexSessionSources??[]).some(source=>source.id===id)){const source=this.externalCodexSources.resolve(id);return {id:source.id,name:source.name,directory:source.directory,managed:false,role:'external'}}
      return this.configs.identityTarget(id)
    }
    const target=this.defaultCodexTarget()
    if(!target)throw new Error('本机默认 Codex 会话目录已变化或不可安全读取，请刷新列表')
    return {id:target.id,name:target.name,directory:target.directory,managed:false,role:'default'}
  }
  private externalCodexSource(id:string):boolean{return (this.store.read().codexSessionSources??[]).some(source=>source.id===id&&source.enabled)}
  private readOnlyCodexSource(id:string):boolean{
    if(id===defaultCodexSourceId||this.externalCodexSource(id))return true
    try{return this.defaultCodexDirectory!==null&&this.codexIdentityTarget(id).directory===this.defaultCodexDirectory}catch{return false}
  }
  /** Path guard for file outputs that must stay outside discover-only homes. */
  isReadOnlySourcePath(path:string):boolean {
    const candidate=resolve(path)
    return [this.defaultCodexDirectory,this.defaultClaudeDirectory,...(this.store.read().codexSessionSources??[]).map(source=>source.directory)].some(directory=>!!directory&&(candidate===directory||pathContains(directory,candidate)))
  }
  private defaultClaudeTarget():SessionSource|undefined {
    const directory=this.defaultClaudeDirectory
    if(!directory)return
    // Discover only the native local transcript tree. Neither credentials nor
    // global Claude settings are needed to establish this read-only source.
    try{
      const root=lstatSync(directory),projects=lstatSync(join(directory,'projects'))
      if(root.isSymbolicLink()||!root.isDirectory()||projects.isSymbolicLink()||!projects.isDirectory()||realpathSync(directory)!==directory)return
      if(this.store.read().instances?.some(profile=>profile.clientType==='claude_code'&&(pathContains(directory,instanceHomePath(this.root,profile))||pathContains(instanceHomePath(this.root,profile),directory))))return
      return {id:defaultClaudeSourceId,name:'默认 Claude Code 目录',directory,managed:false,role:'default',clientType:'claude_code',launchMode:'cli',readOnly:true,description:'本机默认目录中的本地 Claude Code 会话；账号和运行方式由原客户端管理。'}
    }catch{return}
  }
  private claudeTargets():SessionSource[]{
    const initial=this.defaultClaudeTarget()
    return [...(initial?[initial]:[]),...(this.store.read().instances??[]).filter(profile=>profile.clientType==='claude_code').map(profile=>({
      id:profile.id,name:'实例 · '+profile.name+(isClaudeDesktopProfile(profile)?' · Claude Desktop Code':' · Claude Code CLI'),directory:instanceHomePath(this.root,profile),managed:!profile.externalHome,role:'instance',clientType:'claude_code',readOnly:true,launchMode:isClaudeDesktopProfile(profile)?'desktop':'cli',
      description:isClaudeDesktopProfile(profile)?'仅显示此实例已保存的本地 Code 会话；Chat、Cowork 和远程会话由原客户端管理。':'浏览、搜索本地 Claude Code 会话；可在停止的原实例中恢复对话。',
    } satisfies SessionSource))]
  }
  private async claudeTargetIdentity(target:SessionSource):Promise<{profile:string;revision:number;root?:{device:number;inode:number}}>{
    if(target.role==='default'){
      const current=this.defaultClaudeTarget()
      if(!current||current.id!==target.id||current.directory!==target.directory)throw new Error('默认 Claude Code 会话目录已变化，请刷新列表')
      const stat=lstatSync(current.directory)
      return {profile:JSON.stringify(current),revision:0,root:{device:stat.dev,inode:stat.ino}}
    }
    const profile=this.store.read().instances?.find(profile=>profile.id===target.id&&profile.clientType==='claude_code')
    if(!profile||instanceHomePath(this.root,profile)!==target.directory)throw new Error('Claude Code 会话来源实例已变化')
    if(profile.externalHome)validateExternalHome(this.root,profile.externalHome)
    try{
      const stat=profile.externalHome?await lstat(target.directory):await safeSessionPath(this.root,target.directory)
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Claude Code 实例目录不是稳定的普通目录')
      return {profile:JSON.stringify(profile),revision:profile.revision,root:{device:stat.dev,inode:stat.ino}}
    }catch(error){
      if(!profile.externalHome&&(error as NodeJS.ErrnoException).code==='ENOENT')return {profile:JSON.stringify(profile),revision:profile.revision}
      throw error
    }
  }
  cancel(id:string):void{z.string().uuid().parse(id);if(this.scanning?.id===id)this.scanning.controller.abort()}
  cancelTokens(id:string):void{z.string().uuid().parse(id);if(this.snapshot?.id===id)this.statsController?.abort()}
  stop():void{this.scanning?.controller.abort();this.statsController?.abort()}
  async scan(raw:unknown):Promise<SessionPage>{
    const input=sessionScanSchema.parse(raw),defaultCodex=this.defaultCodexTarget(),externalSources:SessionSource[]=this.externalCodexSources.list().map(source=>({...source,managed:false,role:'source' as const,clientType:'codex' as const,readOnly:true,description:source.available?source.enabled?'已登记的外部 Codex 会话目录；只读浏览，可作为单向导入来源。':'已停用的只读会话来源。':source.issue??'来源不可用。'})),sources:SessionSource[]=[...this.configs.targets().map(target=>({...target,clientType:'codex' as const})),...(defaultCodex?[defaultCodex]:[]),...externalSources,...this.claudeTargets()]
    if(input.targetId&&!sources.some(target=>target.id===input.targetId))throw new Error('会话来源目录不存在')
    const selectedSources=sources.filter(target=>(!input.targetId||input.targetId===target.id)&&(input.clientType==='all'||input.clientType===target.clientType)),targets=selectedSources.filter(target=>target.clientType==='codex'&&(target.role!=='source'||target.enabled!==false&&target.available!==false))
    if(input.targetId){const chosen=sources.find(target=>target.id===input.targetId);if(chosen?.role==='source'&&(chosen.enabled===false||chosen.available===false))throw new Error(chosen.issue??'此只读会话来源已停用或不可用，请在来源管理中检查')}
    this.stop();this.snapshot=undefined
    const controller=new AbortController(),signal=controller.signal,run={id:input.runId,controller};this.scanning=run
    const warnings=new Set<string>(),files=new Map<string,SourceFile[]>(),claudeFiles=new Map<string,ClaudeSourceFile>(),records=new Map<string,SessionRecord>(),matches=new Set<string>(),digests=new Map<string,Promise<string>>()
    const digest=async(source:SourceFile,signal:AbortSignal):Promise<string>=>{
      const cached=digests.get(source.path);if(cached)return cached
      const pending=(async()=>{
        const opened=await openSessionFile(source.root,source.path)
        try{
          if(opened.stat.dev!==source.device||opened.stat.ino!==source.inode||opened.stat.size!==source.size)throw new Error('会话文件已被替换')
          const value=await sessionDigest(opened.file,opened.stat.size,signal)
          await this.unchanged(source,opened.stat)
          return value
        }finally{await opened.file.close()}
      })()
      digests.set(source.path,pending);return pending
    }
    const canonical=(source:SourceFile):string=>{
      const path=relative(source.root,source.path),archived=path.startsWith('archived_sessions'+sep)
      // Prefer the live sessions tree.  A lexical path tie-breaker keeps the
      // choice independent of directory enumeration order.
      return `${archived?'1':'0'}\0${path}`
    }
    let fileCount=0
    const sourceCounts:Record<string,number>={}
    try{
      for(const selected of targets){
        signal.throwIfAborted()
        let complete=true
        const warn=(message:string)=>{complete=false;if(warnings.size<99)warnings.add(`${selected.name}：${message}`);else warnings.add('其他读取提示已省略，请选择单个目录检查')}
        try{
          const target=this.codexIdentityTarget(selected.id),root=target.directory
          try{await lstat(root)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&target.managed){sourceCounts[target.id]=0;continue}throw error}
          const rootStat=await lstat(root),daemon=selected.role==='source'?'not_detected':await probeClientDaemon(root,signal),targetRunning=selected.role==='source'?false:this.running(target.id)||daemon==='running',readOnly=this.readOnlyCodexSource(target.id),useSqlite=!readOnly&&!this.disableSqliteDisplay,display=await readSessionDisplay(root,signal,warn,{sqlite:useSqlite}),sourceRows:{record:SessionRecord;file:SourceFile;matched:boolean}[]=[]
          for await(const path of rolloutFiles(root,signal)){
            signal.throwIfAborted();if(++fileCount>100000)throw new SessionLimitError('会话文件超过 10 万条，请选择单个目录')
            try{
              const {file,stat}=await openSessionFile(root,path)
              try{
                const meta=await firstSessionEvent(file,stat.size,signal)
                if(meta?.type!=='session_meta')continue
                const id=sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)
                if(!id)continue
                const cwd=cleanText(meta.payload?.cwd)||'未知工作目录',title=displayTitle(display,id),kind=classifySession(title,cwd)
                const indexed=display.index.get(id)?.updatedAt,activity=await sessionActivity(file,stat.size,signal)
                const updatedAt=indexed!==undefined&&(activity===undefined||Math.abs(indexed-activity)<=3600000)?indexed:activity??stat.mtimeMs
                const historyMode=meta.payload?.history_mode==='paginated'||typeof meta.payload?.history_base?.thread_id==='string'&&!!meta.payload.history_base.thread_id?'paginated' as const:undefined
                const location:SessionLocation={targetId:target.id,name:target.name,directory:root,running:targetRunning,archived:relative(root,path).startsWith('archived_sessions'+sep),ambiguous:false,...historyMode?{historyMode}:{}}
                // Codex resume is offered only after the active SQLite index
                // identifies the exact physical rollout; read-only sources and
                // paginated histories stay viewable but cannot launch by ID.
                const record:SessionRecord={id,title,cwd,projectName:displayProject(display,cwd),updatedAt,kind,locations:[location],clientType:'codex',capabilities:{open:true,transfer:!readOnly,archive:!readOnly,trash:!readOnly,visibilityRepair:!readOnly,tokens:true,contentSearch:true,content:true,resume:false},...historyMode?{historyMode}:{},...(historyMode?{syncBlockedReason:'Codex 分段会话目前仅支持单条迁移；全量或多选同步会跳过，需要明确选择 SQLite 当前活动 rollout。'}:{})}
                const matchesTitle=[title,id].some(value=>value.toLowerCase().includes(input.titleQuery.toLowerCase()))
                // Never search a single paginated segment as though it were a
                // complete transcript. Verified lineage search is performed
                // after the source's active rollout has been resolved.
                const matched=matchesTitle&&(!input.contentQuery||(historyMode==='paginated'?false:await sessionContains(file,stat.size,input.contentQuery,signal)))
                sourceRows.push({record,matched,file:{path,root,targetId:target.id,device:stat.dev,inode:stat.ino,rootDevice:rootStat.dev,rootInode:rootStat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,record:structuredClone(record)}})
              }finally{await file.close()}
            }catch(error){signal.throwIfAborted();warn(`部分会话文件无法读取（${basename(path)}），请刷新或检查文件`)}
          }
          // Do not publish rows read through a replaced/deregistered home.
          this.codexIdentityTarget(target.id);signal.throwIfAborted()
          const finalRoot=await lstat(root);if(finalRoot.dev!==rootStat.dev||finalRoot.ino!==rootStat.ino)throw new Error('会话目录已被替换')
          const grouped=new Map<string,typeof sourceRows>()
          for(const row of sourceRows)grouped.set(row.record.id,[...(grouped.get(row.record.id)??[]),row])
          const selectedProfile=selected.role==='instance'?this.store.read().instances?.find(profile=>profile.id===selected.id&&profile.clientType!=='claude_code'&&!profile.externalHome):undefined
          const selectedApplication=selectedProfile&&this.store.read().instanceApplications?.find(application=>application.id===selectedProfile.applicationId)
          const needsRolloutIndex=selectedApplication?.kind==='cli'||[...grouped.values()].some(rows=>rows.length>1||!!input.contentQuery&&rows.some(row=>row.record.historyMode==='paginated'))
          const indexedRollouts=needsRolloutIndex&&useSqlite?await readSessionRolloutIndex(root,signal,warn):new Map<string,string>()
          for(const [id,rows] of grouped){
            const ordered=rows.slice().sort((a,b)=>canonical(a.file).localeCompare(canonical(b.file)))
            let identical=rows.length<2
            if(!identical&&rows.every(row=>row.file.size===ordered[0].file.size)){
              try{
                const first=await digest(ordered[0].file,signal);identical=true
                for(const row of ordered.slice(1))if(await digest(row.file,signal)!==first){identical=false;break}
              }catch{signal.throwIfAborted();identical=false}
            }
            // Resolve the current rollout through the active SQLite index when
            // available. Read-only/default homes cannot open SQLite, so a
            // single physical candidate may be used as an explicit lineage
            // entrypoint; ambiguous candidates remain fail-closed.
            const indexed=ordered.filter(row=>row.file.path===indexedRollouts.get(id)),primary=indexed.length===1?indexed[0]:undefined
            let contentMatched=false
            if(input.contentQuery.trim()&&rows.some(row=>row.record.historyMode==='paginated')){
              // Search every independently verified candidate lineage. A
              // read-only/default home has no authority to consult SQLite to
              // choose one rollout, but that must not hide the conversation
              // when an older segment contains the requested text. Keep the
              // location ambiguous so the user still chooses which version
              // to inspect; search never resolves or merges candidates.
              const candidates=primary?.record.historyMode==='paginated'?[primary]:identical?[ordered[0]]:ordered.filter(row=>row.record.historyMode==='paginated')
              let unreadable=false
              for(const candidate of candidates){
                if(candidate.record.historyMode!=='paginated')continue
                try{
                  const handle=await openSessionFile(root,candidate.file.path)
                  try{const page=await readCodexSessionLineage(root,candidate.file.path,id,{page:1,pageSize:1,query:input.contentQuery},signal,{file:handle.file,size:handle.stat.size});contentMatched ||= page.total>0}
                  finally{await handle.file.close()}
                }catch{signal.throwIfAborted();unreadable=true}
              }
              if(unreadable)warn('一个或多个 Codex 分段历史无法完整验证，正文搜索结果可能不完整；请打开会话并选择具体文件版本')
            }
            const titleMatched=rows.some(row=>[row.record.title,id].some(value=>value.toLowerCase().includes(input.titleQuery.toLowerCase())))
            if(titleMatched&&(rows.some(row=>row.matched)||contentMatched))matches.add(id)
            const selected=primary?[primary]:identical?[ordered[0]]:ordered
            if(!primary&&!identical&&rows.length>1){
              const conflictLocation:SessionLocation={targetId:target.id,name:target.name,directory:root,running:targetRunning,archived:false,ambiguous:true,versions:ordered.map(row=>({id:this.versionId(row.file),label:relative(root,row.file.path).split(sep).join('/'),archived:row.record.locations[0].archived,updatedAt:row.record.updatedAt,historyMode:row.record.historyMode}))}
              // Keep every conflicting physical file in the snapshot. The UI
              // can only send a version ID; the main process resolves it back
              // to one of these scanned, identity-checked files.
              files.set(id,[...files.get(id)??[],...ordered.map(row=>row.file)])
              const existing=records.get(id)
              if(existing){const location=existing.locations.find(value=>value.targetId===target.id);if(location)Object.assign(location,conflictLocation);else existing.locations.push(conflictLocation)}
              else records.set(id,{...structuredClone(ordered[0].record),locations:[conflictLocation]})
              continue
            }
            const retained=primary?ordered.filter(row=>row!==primary):identical?ordered.slice(1):[]
            for(const row of retained)row.file.duplicateOf=selected[0].file.path
            if(primary)primary.record.locations[0].historicalCopies=retained.length
            // Keep every physical file for full-directory sync/trash.  Actions
            // that need one source filter duplicateOf and use the canonical row.
            for(const {record,file} of selected){
              const profile=target.role==='instance'?this.store.read().instances?.find(value=>value.id===target.id&&value.clientType!=='claude_code'):undefined
              const application=profile&&this.store.read().instanceApplications?.find(value=>value.id===profile.applicationId)
              let cwdAvailable=false;try{const cwdStat=lstatSync(record.cwd);cwdAvailable=cwdStat.isDirectory()&&!cwdStat.isSymbolicLink()&&realpathSync(record.cwd)===record.cwd}catch{}
            const isCurrentCli=!!primary&&primary.file.path===file.path&&!!profile&&!profile.externalHome&&application?.kind==='cli'&&!readOnly&&!targetRunning&&isAbsolute(record.cwd)&&cwdAvailable&&!record.locations[0].archived
              if(isCurrentCli){record.capabilities={...(record.capabilities??{open:true,transfer:true,archive:true,trash:true,visibilityRepair:true,tokens:true,contentSearch:true,content:true}),resume:true};record.resumeMode='managed';record.launchMode='cli'}
              files.set(id,[...files.get(id)??[],file,...retained.map(row=>row.file)])
              const existing=records.get(id)
              if(existing){
                const location=existing.locations.find(value=>value.targetId===target.id)
                if(location&&!location.versions?.length)location.ambiguous=true
                else existing.locations.push(record.locations[0])
                if((record.updatedAt??0)>(existing.updatedAt??0)){const locations=existing.locations;records.set(id,{...record,locations})}
              }else records.set(id,record)
            }
          }
          if(complete)sourceCounts[target.id]=grouped.size
        }catch(error){signal.throwIfAborted();if(error instanceof SessionLimitError)throw error;warn(error instanceof Error&&error.message.includes('超过')?error.message:'目录已变化或无法读取，请在客户端配置中核对')}
      }
      for(const target of selectedSources.filter(target=>target.clientType==='claude_code')){
        signal.throwIfAborted()
        const warn=(message:string)=>{if(warnings.size<99)warnings.add(target.name+'：'+message);else warnings.add('其他读取提示已省略，请选择单个目录检查')}
        try{
          const identity=await this.claudeTargetIdentity(target)
          const scan=await scanClaudeCodeSessionsAsync(target.directory,{instanceId:target.role==='instance'?target.id:undefined,signal,contentQuery:input.contentQuery})
          signal.throwIfAborted()
          const current=await this.claudeTargetIdentity(target)
          if(current.profile!==identity.profile||JSON.stringify(current.root)!==JSON.stringify(identity.root)||scan.source&&(scan.source.config.canonicalPath!==target.directory||scan.source.config.device!==identity.root?.device||scan.source.config.inode!==identity.root?.inode))throw new Error('Claude Code 会话来源实例已变化')
          for(const warning of scan.warnings)warn(warning)
          if(scan.complete)sourceCounts[target.id]=scan.records.reduce((count,record)=>count+record.locations.length,0)
          for(const session of scan.records)for(const location of session.locations){
            // A native session ID can recur in different instances and projects.
            // UI identity never grants Codex mutation capabilities to this file.
            const id='claude:'+createHash('sha256').update(JSON.stringify([target.id,location.projectDirectory,session.id,location.path])).digest('hex')
            if(records.has(id)){warn('会话标识冲突，未合并不同客户端的记录');continue}
            const cwdCandidates=location.cwdCandidates??(location.cwd?[location.cwd]:[])
            const cwdAvailableCandidates=(location.cwdCandidateIdentities??[]).filter(identity=>{try{const live=statSync(identity.path);return live.isDirectory()&&live.dev===identity.device&&live.ino===identity.inode&&realpathSync(identity.path)===identity.canonicalPath}catch{return false}}).map(identity=>identity.path)
            let resumeBlockedReason=target.launchMode==='desktop'?'请在原 Claude Desktop 的 Code 页面中继续此会话':target.role==='instance'&&this.running(target.id)?'实例正在运行，请先在实例内使用 /resume，或停止实例后从这里恢复':session.conflict?'同 ID 会话存在文件冲突，请先核对来源':!scan.complete?'会话来源尚未完整读取，请刷新后重试':location.resumeBlockedReason??(!cwdCandidates.length?'会话没有保存项目工作目录':!cwdAvailableCandidates.length?'原项目目录不可用，请恢复其中一个目录后重试':undefined)
            const row:SessionRecord={
              id,clientType:'claude_code',launchMode:target.launchMode,sourceSessionId:session.id,title:location.title,cwd:location.cwd??'未知工作目录',cwdCandidates,cwdAvailableCandidates,resumeSourceId:location.sourceId,projectName:location.cwd?basename(location.cwd):undefined,updatedAt:session.updatedAt,kind:'conversation',messageCount:session.messageCount,model:session.model,resumeMode:target.role==='default'?'default_fork':'managed',resumeBlockedReason,resumeIncludesAncestors:location.resumeIncludesAncestors,
              locations:[{targetId:target.id,name:target.name,directory:target.directory,running:this.running(target.id),archived:false,ambiguous:session.conflict}],
              capabilities:{open:true,transfer:false,archive:false,trash:false,visibilityRepair:false,tokens:false,contentSearch:true,content:true,resume:!resumeBlockedReason},
            }
            records.set(id,row);claudeFiles.set(id,{target,profile:identity.profile,location,sessionId:session.id,record:session})
            if((!input.contentQuery||location.contentMatched)&&[row.title,session.id].some(value=>value.toLowerCase().includes(input.titleQuery.toLowerCase())))matches.add(id)
          }
        }catch{signal.throwIfAborted();warn('实例目录已变化或无法安全读取，请刷新后重试')}
      }
      signal.throwIfAborted()
      const sorted=[...records.values()].map(record=>{
        if(record.clientType!=='codex')return record
        const writable=record.locations.some(location=>!this.readOnlyCodexSource(location.targetId)),conflicted=record.locations.some(location=>location.ambiguous)
        const paginated=record.historyMode==='paginated'
        const externalSync=record.locations.some(location=>this.externalCodexSource(location.targetId))
        // Paginated sessions can be selected for the dedicated single-session
        // transfer path. Bulk/full sync still reports them as unsupported.
        return {...record,capabilities:{...record.capabilities,open:true,transfer:writable&&!conflicted,syncSource:writable||externalSync,archive:writable&&!conflicted,trash:writable&&!conflicted,visibilityRepair:writable&&!conflicted,tokens:true,contentSearch:true,content:true}}
      }).filter(record=>matches.has(record.id)&&(input.kind==='all'||record.kind===input.kind)&&(!input.projectQuery||[record.cwd,record.projectName??''].some(value=>value.toLowerCase().includes(input.projectQuery.toLowerCase())))).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.cwd.localeCompare(b.cwd)||a.id.localeCompare(b.id))
      this.snapshot={id:randomUUID(),scannedAt:Date.now(),records:sorted,files,claudeFiles,warnings:[...warnings].slice(0,100),sourceCounts,sources}
      return this.page({snapshotId:this.snapshot.id,page:1,pageSize:25})
    }catch(error){if(signal.aborted)throw new Error('会话读取已取消');throw error}
    finally{if(this.scanning===run)this.scanning=undefined}
  }
  private current(id:string):Snapshot{const snapshot=this.snapshot;if(!snapshot||snapshot.id!==id)throw new Error('会话列表已更新，请重新读取');return snapshot}
  private versionId(source:SourceFile):string{return createHash('sha256').update(JSON.stringify([source.path,source.device,source.inode,source.size,source.mtime,source.ctime])).digest('hex').slice(0,32)}
  page(raw:unknown):SessionPage{
    const input=sessionPageSchema.parse(raw),snapshot=this.current(input.snapshotId),page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.records.length/input.pageSize)))
    return {snapshotId:snapshot.id,scannedAt:snapshot.scannedAt,total:snapshot.records.length,page,pageSize:input.pageSize,items:structuredClone(snapshot.records.slice((page-1)*input.pageSize,page*input.pageSize)),warnings:[...snapshot.warnings],sourceCounts:{...snapshot.sourceCounts},sources:structuredClone(snapshot.sources)}
  }
  private async unchanged(source:SourceFile,stat:Stats){
    const target=this.codexIdentityTarget(source.targetId);if(target.directory!==source.root)throw new Error('会话来源目录已改变')
    const root=await lstat(source.root);if(root.dev!==source.rootDevice||root.ino!==source.rootInode)throw new Error('会话来源目录已被替换')
    const current=await safeSessionPath(source.root,source.path)
    if(!current.isFile()||current.nlink!==1||current.dev!==stat.dev||current.ino!==stat.ino)throw new Error('会话文件已被替换，请刷新列表')
    if(current.size!==stat.size||current.mtimeMs!==stat.mtimeMs||current.ctimeMs!==stat.ctimeMs)throw new Error('会话文件正在变化，请刷新后重试')
  }
  private async verified(source:SourceFile,id:string,signal:AbortSignal){
    signal.throwIfAborted()
    const target=this.codexIdentityTarget(source.targetId);if(target.directory!==source.root)throw new Error('会话来源目录已改变')
    const root=await lstat(source.root);if(root.dev!==source.rootDevice||root.ino!==source.rootInode)throw new Error('会话来源目录已被替换')
    let opened:{file:FileHandle;stat:Stats}
    try{opened=await openSessionFile(source.root,source.path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('会话文件已变化或被移除，请刷新列表');throw error}
    try{
      if(opened.stat.dev!==source.device||opened.stat.ino!==source.inode)throw new Error('会话文件已被替换，请刷新列表')
      const meta=await firstSessionEvent(opened.file,opened.stat.size,signal)
      if(meta?.type!=='session_meta'||sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)!==id)throw new Error('会话文件身份已改变，请刷新列表')
      await this.unchanged(source,opened.stat);signal.throwIfAborted();return opened
    }catch(error){await opened.file.close();throw error}
  }
  async location(raw:unknown,action:'location'|'file'='file'):Promise<string>{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId)
    if(claude){
      if(claude.target.id!==input.targetId||!snapshot.records.some(record=>record.id===input.sessionId))throw new Error('会话不属于所选目录')
      const current=await this.claudeTargetIdentity(claude.target)
      if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
      const path=verifyClaudeSessionLocation(claude.location);this.current(input.snapshotId);return path
    }
    const allSources=snapshot.files.get(input.sessionId)?.filter(value=>value.targetId===input.targetId)??[]
    const sources=allSources.filter(value=>!value.duplicateOf)
    const location=snapshot.records.find(record=>record.id===input.sessionId)?.locations.find(value=>value.targetId===input.targetId)
    if(!location)throw new Error('会话不属于所选目录')
    if(action==='location'&&location.versions?.length){
      const rootSource=allSources[0]
      if(!rootSource)throw new Error('会话来源已变化，请刷新列表')
      const target=this.codexIdentityTarget(input.targetId)
      if(target.directory!==rootSource.root)throw new Error('会话来源目录已改变')
      const root=await lstat(rootSource.root)
      if(root.dev!==rootSource.rootDevice||root.ino!==rootSource.rootInode)throw new Error('会话来源目录已被替换')
      this.current(input.snapshotId);return rootSource.root
    }
    if(location.versions?.length){const version=location.versions.find(value=>value.id===input.versionId);if(!version)throw new Error('此会话存在多个同 ID 文件，请选择具体版本');const chosen=allSources.find(source=>this.versionId(source)===version.id);if(!chosen)throw new Error('会话文件版本已变化，请刷新列表');const opened=await this.verified(chosen,input.sessionId,new AbortController().signal);try{if(opened.stat.size!==chosen.size||opened.stat.mtimeMs!==chosen.mtime||opened.stat.ctimeMs!==chosen.ctime)throw new Error('会话文件版本已变化，请刷新列表')}finally{await opened.file.close()};this.current(input.snapshotId);return chosen.path}
    if(sources.length!==1)throw new Error(sources.length?'所选目录存在多个同 ID 会话文件，请刷新后选择版本':'会话不属于所选目录')
    const opened=await this.verified(sources[0],input.sessionId,new AbortController().signal);await opened.file.close();this.current(input.snapshotId);return sources[0].path
  }
  async content(raw:unknown):Promise<SessionContentPage>{
    const input=sessionContentSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!row||!row.locations.some(location=>location.targetId===input.targetId))throw new Error('所选会话不属于当前目录')
    if(!claude){
      const location=row.locations.find(value=>value.targetId===input.targetId)!,sources=snapshot.files.get(input.sessionId)?.filter(value=>value.targetId===input.targetId&&!value.duplicateOf)??[]
      let source:SourceFile|undefined
      if(sources.length===1)source=sources[0]
      else if(location.versions?.length){const version=location.versions.find(value=>value.id===input.versionId);if(!version)throw new Error('所选 Codex 会话存在多个同 ID 文件冲突，请选择具体版本');source=sources.find(value=>this.versionId(value)===version.id);if(!source)throw new Error('所选会话文件版本已变化，请刷新列表')}
      if(!source)throw new Error('所选 Codex 会话存在文件冲突，请先选择具体版本')
      const opened=await this.verified(source,input.sessionId,new AbortController().signal)
      try{if(opened.stat.size!==source.size||opened.stat.mtimeMs!==source.mtime||opened.stat.ctimeMs!==source.ctime)throw new Error('会话文件已变化，请刷新列表');const paginated=source.record.historyMode==='paginated',content=paginated?await readCodexSessionLineage(source.root,source.path,input.sessionId,{page:input.page,pageSize:input.pageSize,query:input.query},new AbortController().signal,{file:opened.file,size:opened.stat.size}):await readCodexSessionContent(opened.file,opened.stat.size,{page:input.page,pageSize:input.pageSize,query:input.query});await this.unchanged(source,opened.stat);this.current(input.snapshotId);return {snapshotId:input.snapshotId,sessionId:row.id,sourceSessionId:row.id,title:source.record.title,cwd:source.record.cwd,sourceName:location.versions?.length?location.name+' · '+relative(source.root,source.path).split(sep).join('/'):location.name,clientType:'codex',...content}}finally{await opened.file.close()}
    }
    if(claude.target.id!==input.targetId)throw new Error('所选会话不属于当前目录')
    const current=await this.claudeTargetIdentity(claude.target)
    if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
    const content=readClaudeSessionContent(claude.location,{page:input.page,pageSize:input.pageSize,query:input.query})
    this.current(input.snapshotId)
    return {snapshotId:input.snapshotId,sessionId:row.id,sourceSessionId:claude.sessionId,title:row.title,cwd:row.cwd,sourceName:claude.target.name,clientType:'claude_code',...content}
  }
  async codexResumeSource(raw:unknown):Promise<CodexResumeTicketSource>{
    const input=codexResumeSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),row=snapshot.records.find(value=>value.id===input.sessionId),sources=snapshot.files.get(input.sessionId)??[]
    if(!row||row.clientType!=='codex'||row.resumeMode!=='managed'||row.capabilities?.resume!==true||row.launchMode!=='cli')throw new Error(row?.resumeBlockedReason??'此 Codex 会话当前不能安全恢复')
    if(row.locations.length!==1||row.locations[0].targetId!==input.targetId||row.locations[0].ambiguous)throw new Error('Codex 会话存在多个来源或同 ID 文件冲突，请先选择并核对来源')
    const profile=this.store.read().instances?.find(value=>value.id===input.targetId&&value.clientType!=='claude_code')
    const application=profile&&this.store.read().instanceApplications?.find(value=>value.id===profile.applicationId)
    if(!profile||profile.externalHome||application?.kind!=='cli'||profile.revision<0)throw new Error('仅支持已登记的受管 Codex CLI 实例恢复')
    if(this.running(profile.id))throw new Error('Codex 实例正在运行，请先停止后重试')
    const target=this.codexIdentityTarget(profile.id),source=sources.find(value=>value.targetId===profile.id&&!value.duplicateOf)
    if(target.directory!==source?.root||!source||source.record.locations[0].archived)throw new Error('此会话不是受管 Codex CLI 当前可恢复的 rollout')
    const indexed=await readSessionRolloutIndex(source.root,new AbortController().signal,()=>{})
    if(indexed.get(input.sessionId)!==source.path)throw new Error('无法确认此 rollout 是当前会话，请刷新列表后重试')
    if(!isAbsolute(row.cwd)||!existsSync(row.cwd))throw new Error('会话原项目目录不可用，请恢复目录后重试')
    const cwdCanonicalPath=realpathSync(row.cwd),cwdStat=statSync(row.cwd)
    if(!cwdStat.isDirectory()||lstatSync(row.cwd).isSymbolicLink())throw new Error('会话项目目录不是稳定的普通目录')
    const opened=await this.verified(source,input.sessionId,new AbortController().signal)
    let lineage:CodexResumeTicketSource['lineage']
    try{
      if(opened.stat.size!==source.size||opened.stat.mtimeMs!==source.mtime||opened.stat.ctimeMs!==source.ctime)throw new Error('会话文件已变化，请刷新列表')
      if(source.record.historyMode==='paginated'){
        await readCodexSessionLineage(source.root,source.path,input.sessionId,{page:1,pageSize:1},new AbortController().signal,{file:opened.file,size:opened.stat.size},files=>{lineage=files})
        if(!lineage?.length||lineage[0].path!==source.path)throw new Error('无法验证 Codex 分段会话的完整历史，拒绝恢复')
      }
    }finally{await opened.file.close()}
    this.current(input.snapshotId)
    return {snapshotId:input.snapshotId,targetId:profile.id,sessionId:input.sessionId,path:source.path,root:source.root,rootDevice:source.rootDevice,rootInode:source.rootInode,device:source.device,inode:source.inode,size:source.size,mtime:source.mtime,ctime:source.ctime,cwd:row.cwd,cwdCanonicalPath,cwdDevice:cwdStat.dev,cwdInode:cwdStat.ino,instanceRevision:profile.revision,profileFingerprint:fingerprint(profile),...(lineage?{lineage}:{})}
  }
  /** Resume plans are bound to the original instance/profile and snapshot.
   * Launch tickets must call this again immediately before committing launch. */
  async claudeResume(raw:unknown):Promise<CatalogClaudeResumePreview>{
    const input=claudeResumeSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!claude||!row||claude.target.id!==input.targetId)throw new Error('Claude Code 会话不属于所选实例')
    if(claude.target.role!=='instance')throw new Error('默认 Claude Code 会话未绑定管理器实例，请在原终端中继续')
    const current=await this.claudeTargetIdentity(claude.target)
    if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
    if(claude.target.launchMode==='desktop')throw new Error('请在原 Claude Desktop 的 Code 页面中继续此会话')
    if(this.running(input.targetId))throw new Error('实例正在运行，请先在实例内使用 /resume，或停止实例后恢复')
    if(row.capabilities?.resume!==true&&!row.resumeBlockedReason?.startsWith('实例正在运行'))throw new Error(row.resumeBlockedReason??'此 Claude 会话当前不能安全继续')
    if(input.sourceId!==claude.location.sourceId||!row.cwdAvailableCandidates?.some(value=>resolve(value)===resolve(input.cwd)))throw new Error('所选项目目录或 Claude 会话来源已变化，请刷新后重新选择')
    const selection={instanceId:input.targetId,configDirectory:claude.target.directory,cwd:input.cwd,sessionId:claude.sessionId,sourceId:input.sourceId}
    const preview=previewClaudeSessionResume({configDirectory:claude.target.directory,sessionsDirectory:claude.location.source.projects.path,instanceId:input.targetId,scannedAt:snapshot.scannedAt,records:[claude.record],warnings:[],complete:true},selection)
    this.current(input.snapshotId)
    return {...preview,instanceRevision:current.revision,profileFingerprint:createHash('sha256').update(current.profile).digest('hex')}
  }
  /** Freshly revalidate a default-profile session without ever resolving an account or managed instance. */
  async defaultClaudeResume(raw:unknown):Promise<{snapshotId:string;sessionId:string;targetId:string;sourceId:string;cwd:string;cwdCandidates:string[];location:ClaudeSessionLocation;homeDirectory:string;cwdCanonicalPath:string;cwdDevice:number;cwdInode:number;configCanonicalPath:string;configDevice:number;configInode:number;projectsDevice:number;projectsInode:number;projectDevice:number;projectInode:number}>{
    const input=claudeResumeSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!claude||!row||claude.target.id!==input.targetId||claude.target.role!=='default'||claude.target.launchMode!=='cli'||row.resumeMode!=='default_fork')throw new Error('所选会话不是本机默认 Claude Code CLI 会话')
    if(row.capabilities?.resume!==true)throw new Error(row.resumeBlockedReason??'此会话当前不能安全继续')
    const before=await this.claudeTargetIdentity(claude.target)
    if(before.profile!==claude.profile)throw new Error('默认 Claude Code 会话目录已变化，请刷新列表')
    const scan=await scanClaudeCodeSessionsAsync(claude.target.directory)
    if(!scan.complete)throw new Error('默认 Claude Code 会话目录尚未完整读取，请刷新后重试')
    const selected=scan.records.find(value=>value.id===claude.sessionId)
    if(!selected||selected.conflict||selected.locations.length!==1)throw new Error('同 ID Claude Code 会话存在文件冲突，请先核对来源')
    const location=selected.locations[0]
    if(input.sourceId!==claude.location.sourceId||input.sourceId!==location.sourceId||!(location.cwdCandidates??(location.cwd?[location.cwd]:[])).some(value=>resolve(value)===resolve(input.cwd))||!row.cwdAvailableCandidates?.some(value=>resolve(value)===resolve(input.cwd)))throw new Error('所选项目目录或默认 Claude 会话来源已变化，请刷新后重新选择')
    const beforeCwd=claude.location.cwdCandidateIdentities?.find(value=>value.path===input.cwd),afterCwd=location.cwdCandidateIdentities?.find(value=>value.path===input.cwd)
    if(!beforeCwd||!afterCwd||beforeCwd.canonicalPath!==afterCwd.canonicalPath||beforeCwd.device!==afterCwd.device||beforeCwd.inode!==afterCwd.inode)throw new Error('默认 Claude 项目目录身份已变化，请刷新后重新选择')
    if(location.sourceId!==claude.location.sourceId)throw new Error('默认 Claude Code 会话文件已变化，请刷新列表')
    if(location.resumeBlockedReason)throw new Error(location.resumeBlockedReason)
    if(!isAbsolute(input.cwd))throw new Error('会话没有有效的项目工作目录')
    const cwdCanonicalPath=realpathSync(input.cwd),cwd=statSync(input.cwd),canonical=statSync(cwdCanonicalPath)
    if(!cwd.isDirectory()||cwd.dev!==canonical.dev||cwd.ino!==canonical.ino)throw new Error('会话项目目录不可用，请恢复目录后重试')
    const after=await this.claudeTargetIdentity(claude.target)
    if(after.profile!==before.profile||JSON.stringify(after.root)!==JSON.stringify(before.root))throw new Error('默认 Claude Code 会话目录已变化，请刷新列表')
    this.current(input.snapshotId)
    return {snapshotId:input.snapshotId,sessionId:claude.sessionId,targetId:input.targetId,sourceId:input.sourceId,cwd:input.cwd,cwdCandidates:row.cwdAvailableCandidates??[],location:{...structuredClone(location),cwd:input.cwd},homeDirectory:dirname(location.source.config.canonicalPath),cwdCanonicalPath,cwdDevice:cwd.dev,cwdInode:cwd.ino,configCanonicalPath:location.source.config.canonicalPath,configDevice:location.source.config.device,configInode:location.source.config.inode,projectsDevice:location.source.projects.device,projectsInode:location.source.projects.inode,projectDevice:location.project.device,projectInode:location.project.inode}
  }
  originalSessionId(raw:unknown):string{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!row||!row.locations.some(location=>location.targetId===input.targetId))throw new Error('会话不属于所选目录')
    return row.sourceSessionId??row.id
  }
  selectedRecords(snapshotId:string,ids:string[]):SessionRecord[]{
    const input=sessionStatsSchema.parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId)
    return [...new Set(input.sessionIds)].map(id=>{const row=snapshot.records.find(row=>row.id===id);if(!row)throw new Error('所选会话不在当前列表中，请重新选择');if(row.clientType==='claude_code')throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 会话修改操作');if(row.locations.every(location=>this.readOnlyCodexSource(location.targetId)))throw new Error('本机默认 Codex 会话来源仅支持只读查看，不能使用批量修改操作');if(row.locations.some(location=>location.ambiguous))throw new Error('所选会话存在同 ID 文件冲突，请先逐个核对版本');z.string().uuid().parse(id);return structuredClone(row)})
  }
  async transferSources(snapshotId:string,ids:string[],signal=new AbortController().signal):Promise<SessionTransferSource[]>{
    const input=sessionStatsSchema.extend({sessionIds:z.array(z.string().min(1).max(256)).min(1).max(1000)}).parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId),result:SessionTransferSource[]=[]
    for(const id of new Set(input.sessionIds)){
      const record=snapshot.records.find(row=>row.id===id)
      if(!record)throw new Error('所选会话不在当前筛选列表中，请重新选择')
      if(record.clientType==='claude_code')throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 会话复制或导出')
      if(record.locations.some(location=>location.ambiguous))throw new Error('所选会话在至少一个目录中存在同 ID 文件冲突，不能自动改从其他目录复制；请使用指定来源的同步或先核对冲突')
      const sources=(snapshot.files.get(id)??[]).filter(source=>!this.readOnlyCodexSource(source.targetId)&&!source.duplicateOf&&!record.locations.find(location=>location.targetId===source.targetId)?.ambiguous).sort((a,b)=>(b.record.updatedAt??0)-(a.record.updatedAt??0))
      if(!sources.length){if((snapshot.files.get(id)??[]).every(source=>this.readOnlyCodexSource(source.targetId)))throw new Error('本机默认 Codex 会话来源仅支持只读查看，不能复制或导出');throw new Error('所选会话存在同 ID 文件冲突，请先核对')}
      const source=sources[0],opened=await this.verified(source,id,signal)
      try{result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record)})}finally{await opened.file.close()}
    }
    this.current(input.snapshotId);return result
  }
  /** Resolve each requested Codex file version from the immutable scan snapshot.
   * Callers provide only logical IDs and target/version IDs, never filesystem paths. */
  async selectedTransferSources(snapshotId:string,selections:SessionCopySourceSelection[],signal=new AbortController().signal):Promise<SessionTransferSource[]>{
    const input=z.object({snapshotId:z.string().uuid(),selections:z.array(z.object({sessionId:z.string().min(1).max(256),targetId:z.string().uuid(),versionId:z.string().regex(/^[a-f0-9]{32}$/).optional()}).strict()).min(1).max(1000)}).strict().parse({snapshotId,selections}),snapshot=this.current(input.snapshotId),result:SessionTransferSource[]=[],seen=new Set<string>()
    for(const selection of input.selections){
      if(seen.has(selection.sessionId))throw new Error('同一目标不能重复选择同 ID 会话的多个来源，请只选择一个来源版本')
      seen.add(selection.sessionId)
      const record=snapshot.records.find(row=>row.id===selection.sessionId)
      if(!record)throw new Error('所选会话不在当前筛选列表中，请重新选择')
      if(record.clientType==='claude_code')throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 会话复制或导出')
      if(this.readOnlyCodexSource(selection.targetId))throw new Error('本机默认 Codex 会话来源仅支持只读查看，不能复制或导出')
      const location=record.locations.find(value=>value.targetId===selection.targetId)
      if(!location)throw new Error('所选会话不属于指定来源目录')
      const all=snapshot.files.get(selection.sessionId)?.filter(source=>source.targetId===selection.targetId)??[]
      let source:SourceFile|undefined
      if(location.versions?.length){
        if(!selection.versionId)throw new Error('此会话存在多个同 ID 文件，请选择具体版本')
        const version=location.versions.find(value=>value.id===selection.versionId)
        if(!version)throw new Error('所选会话版本不属于指定来源目录，请刷新列表')
        source=all.find(value=>this.versionId(value)===version.id)
        if(!source)throw new Error('所选会话文件版本已变化，请刷新列表')
      }else{
        if(selection.versionId)throw new Error('所选会话已不再包含指定冲突版本，请刷新列表')
        const candidates=all.filter(value=>!value.duplicateOf)
        if(candidates.length!==1)throw new Error(candidates.length?'所选来源目录仍存在同 ID 文件冲突，请刷新列表并指定版本':'会话不属于所选目录')
        source=candidates[0]
      }
      if(source.record.historyMode==='paginated')throw new Error('会话使用分段历史，当前单会话复制不能保留完整记录。')
      const opened=await this.verified(source,selection.sessionId,signal)
      try{
        if(opened.stat.size!==source.size||opened.stat.mtimeMs!==source.mtime||opened.stat.ctimeMs!==source.ctime)throw new Error('会话文件版本已变化，请刷新列表')
        result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record),sourceVersionId:this.versionId(source),sourceConflict:!!location.versions?.length})
      }finally{await opened.file.close()}
    }
    this.current(input.snapshotId);return result
  }
  async syncSources(snapshotId:string,signal:AbortSignal):Promise<SessionTransferSource[]>{
    const snapshot=this.current(snapshotId),result:SessionTransferSource[]=[]
    if(snapshot.claudeFiles.size)throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 全目录同步')
    if(snapshot.warnings.length)throw new Error('部分会话目录读取不完整，未准备同步：'+snapshot.warnings[0])
    for(const [id,sources] of snapshot.files)for(const source of sources){
      if(source.targetId===defaultCodexSourceId||this.externalCodexSource(source.targetId))continue
      const opened=await this.verified(source,id,signal)
      try{result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record)})}finally{await opened.file.close()}
    }
    this.current(snapshotId);return result
  }
  async directionalSyncSources(snapshotId:string,ids:string[],targetIds:string[],signal:AbortSignal,requireEachId:boolean,selections:SessionCopySourceSelection[]=[],requireConflictChoices=true):Promise<SessionTransferSource[]>{
    const input=sessionStatsSchema.extend({sessionIds:z.array(z.string().uuid()).max(1000),targetIds:z.array(z.string().uuid()).min(1).max(100)}).parse({snapshotId,sessionIds:ids,targetIds}),snapshot=this.current(input.snapshotId),result:SessionTransferSource[]=[],found=new Set<string>()
    if(snapshot.warnings.length)throw new Error('部分会话目录读取不完整，未准备同步：'+snapshot.warnings[0])
    const chosen=new Map<string,SessionCopySourceSelection>()
    for(const selection of selections){const key=selection.sessionId+'|'+selection.targetId;if(chosen.has(key))throw new Error('同一会话来源重复选择');chosen.set(key,selection)}
    if([...chosen.values()].some(selection=>!input.targetIds.includes(selection.targetId)||ids.length>0&&!input.sessionIds.includes(selection.sessionId)))throw new Error('会话文件选择不属于当前同步范围')
    const wanted=input.sessionIds.length?new Set(input.sessionIds):new Set(snapshot.records.filter(row=>row.clientType!=='claude_code').map(row=>row.id))
    for(const id of wanted){
      const record=snapshot.records.find(row=>row.id===id)
      if(!record){if(requireEachId)throw new Error('所选会话不在当前扫描结果中，请刷新后重新选择');continue}
      if(record.clientType==='claude_code')throw new Error('Claude Code 会话当前不支持同步到 Codex 实例')
      z.string().uuid().parse(id)
      for(const targetId of input.targetIds){
        const location=record.locations.find(value=>value.targetId===targetId)
        if(!location)continue
        if(hasPaginatedHistory(record))continue
        const selected=chosen.get(id+'|'+targetId)
        if(location.ambiguous&&requireConflictChoices&&!selected?.versionId)throw new Error('会话 '+record.title+' 在来源实例“'+location.name+'”存在多个同 ID 文件，请选择具体版本后再同步')
        if(selected?.versionId&&!location.ambiguous)throw new Error('会话来源文件版本已变化，请刷新列表')
      }
      if(record.historyMode==='paginated'){found.add(id);continue}
      for(const source of snapshot.files.get(id)??[]){
        if(!input.targetIds.includes(source.targetId)||source.targetId===defaultCodexSourceId)continue
        const selected=chosen.get(id+'|'+source.targetId)
        if(source.duplicateOf&&!chosen.has(id+'|'+source.targetId))continue
        if(requireConflictChoices&&record.locations.find(value=>value.targetId===source.targetId)?.ambiguous&&!chosen.has(id+'|'+source.targetId))throw new Error('会话 '+record.title+' 在来源实例存在多个同 ID 文件，请选择具体版本后再同步')
        let resolved=source
        const location=record.locations.find(value=>value.targetId===source.targetId)
        if(location?.versions?.length&&selected?.versionId){
          if(!selected?.versionId)throw new Error('会话 '+record.title+' 在来源实例“'+location.name+'”存在多个同 ID 文件，请选择具体版本后再同步')
          const version=location.versions.find(value=>value.id===selected.versionId)
          if(!version)throw new Error('所选会话版本不属于指定来源目录，请刷新列表')
          const candidate=snapshot.files.get(id)?.find(value=>value.targetId===source.targetId&&this.versionId(value)===version.id)
          if(!candidate)throw new Error('所选会话文件版本已变化，请刷新列表')
          if(source.path!==candidate.path)continue
          resolved=candidate
        }
        const opened=await this.verified(resolved,id,signal)
        try{result.push({path:resolved.path,root:resolved.root,targetId:resolved.targetId,rootDevice:resolved.rootDevice,rootInode:resolved.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(resolved.record),sourceVersionId:this.versionId(resolved),sourceConflict:!!location?.versions?.length});found.add(id)}finally{await opened.file.close()}
      }
    }
    if(requireEachId){const missing=input.sessionIds.find(id=>!found.has(id));if(missing)throw new Error(`所选来源实例中找不到会话 ${missing}`)}
    this.current(input.snapshotId);return result
  }
  recordsForSync(snapshotId:string,ids:string[],targetIds:string[]):SessionRecord[]{
    const snapshot=this.current(snapshotId),wanted=ids.length?new Set(ids):undefined
    if(snapshot.warnings.length)throw new Error('部分会话目录读取不完整，未准备同步：'+snapshot.warnings[0])
    return snapshot.records.filter(record=>record.clientType==='codex'&&(!wanted||wanted.has(record.id))&&record.locations.some(location=>targetIds.includes(location.targetId))).map(record=>structuredClone(record))
  }
  directionalSyncUnsupported(snapshotId:string,ids:string[],targetIds:string[]):Array<{id:string;title:string;sourceIds:string[];reason:string}>{
    const snapshot=this.current(snapshotId),wanted=ids.length?new Set(ids):undefined,result:Array<{id:string;title:string;sourceIds:string[];reason:string}>=[]
    for(const record of snapshot.records){
      if(record.clientType!=='codex'||!hasPaginatedHistory(record)||wanted&&!wanted.has(record.id))continue
      const sourceIds=record.locations.filter(location=>targetIds.includes(location.targetId)&&location.targetId!==defaultCodexSourceId).map(location=>location.targetId)
      if(sourceIds.length)result.push({id:record.id,title:record.title,sourceIds,reason:record.syncBlockedReason??'Codex 分段会话目前仅支持单条迁移；全量或多选同步会跳过，需要明确选择 SQLite 当前活动 rollout。'})
    }
    return result
  }
  async tokenStats(raw:unknown):Promise<SessionTokenResult[]>{
    const input=sessionStatsSchema.parse(raw),snapshot=this.current(input.snapshotId)
    this.statsController?.abort();const controller=new AbortController();this.statsController=controller
    try{
      const results:SessionTokenResult[]=[]
      for(const id of new Set(input.sessionIds)){
        controller.signal.throwIfAborted();this.current(input.snapshotId)
        if(!snapshot.records.some(record=>record.id===id))throw new Error('会话不在当前筛选列表中')
        if(snapshot.records.find(record=>record.id===id)?.capabilities?.tokens===false){results.push({id,error:'Claude Code 会话用量尚未接入'});continue}
        let found:SessionTokenResult|undefined,failed=false
        const record=snapshot.records.find(record=>record.id===id)!
        if(record.locations.some(location=>location.ambiguous)){results.push({id,error:'此会话存在同 ID 文件冲突，请先逐个核对版本'});continue}
        for(const location of record.locations){
          if(location.ambiguous){failed=true;continue}
          const source=snapshot.files.get(id)!.find(value=>value.targetId===location.targetId&&!value.duplicateOf)!
          try{const {file,stat}=await this.verified(source,id,controller.signal);try{const tokens=await sessionTokens(file,stat.size,controller.signal);await this.unchanged(source,stat);controller.signal.throwIfAborted();if(tokens){found={id,tokens,targetId:source.targetId};break}}finally{await file.close()}}
          catch{controller.signal.throwIfAborted();failed=true}
        }
        results.push(found??{id,...failed?{error:'部分会话文件无法读取，请刷新后重试'}:{}})
      }
      this.current(input.snapshotId);return results
    }catch(error){if(controller.signal.aborted)throw new Error('会话用量读取已取消');throw error}
    finally{if(this.statsController===controller)this.statsController=undefined}
  }
}
