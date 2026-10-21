import {createHash,randomUUID} from 'node:crypto'
import {lstat} from 'node:fs/promises'
import {lstatSync,realpathSync,statSync,type Stats} from 'node:fs'
import {homedir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs} from './clientConfig'
import {sessionScanSchema,sessionPageSchema,sessionSelectionSchema,sessionContentSchema,sessionStatsSchema,type SessionKind,type SessionLocation,type SessionRecord,type SessionPage,type SessionTokenResult,type SessionSource,type SessionContentPage} from '../shared/sessions'
import {openSessionFile,rolloutFiles,firstSessionEvent,sessionActivity,sessionTokens,sessionContains,sessionDigest,cleanText,sessionIdentifier,safeSessionPath} from './sessionFiles'
import {readSessionDisplay,readSessionRolloutIndex,displayTitle,displayProject} from './sessionDisplay'
import {probeClientDaemon} from './clientDaemon'
import {instanceHomePath,pathContains,validateExternalHome} from './instancePaths'
import {scanClaudeCodeSessionsAsync,verifyClaudeSessionLocation,readClaudeSessionContent,previewClaudeSessionResume,type ClaudeSessionLocation,type ClaudeSessionRecord,type ClaudeSessionResumePreview} from './claudeCodeSessions'
import {isClaudeDesktopProfile} from '../shared/instances'

interface SourceFile {path:string;root:string;targetId:string;device:number;inode:number;rootDevice:number;rootInode:number;size:number;record:SessionRecord;duplicateOf?:string}
export interface SessionTransferSource {path:string;root:string;targetId:string;rootDevice:number;rootInode:number;device:number;inode:number;size:number;mtime:number;ctime:number;record:SessionRecord}
interface ClaudeSourceFile {target:SessionSource;profile:string;location:ClaudeSessionLocation;sessionId:string;record:ClaudeSessionRecord}
export interface CatalogClaudeResumePreview extends ClaudeSessionResumePreview {instanceRevision:number;profileFingerprint:string}
export interface SessionCatalogOptions {defaultClaudeDirectory?:string|null}
const defaultClaudeSourceId='4135f4e6-6db5-4bd4-95f7-06f4c667341a'
interface Snapshot {id:string;scannedAt:number;records:SessionRecord[];files:Map<string,SourceFile[]>;claudeFiles:Map<string,ClaudeSourceFile>;warnings:string[];sourceCounts:Record<string,number>;sources:SessionSource[]}
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
  private readonly defaultClaudeDirectory:string|null
  constructor(private readonly store:Store,private readonly running:(id:string)=>boolean=()=>false,options:SessionCatalogOptions={}){
    this.configs=new ClientConfigs(store);this.root=realpathSync(store.directory)
    this.defaultClaudeDirectory=options.defaultClaudeDirectory===undefined?join(homedir(),'.claude'):options.defaultClaudeDirectory
    if(this.defaultClaudeDirectory!==null&&(!isAbsolute(this.defaultClaudeDirectory)||resolve(this.defaultClaudeDirectory)!==this.defaultClaudeDirectory))throw new Error('默认 Claude 会话目录必须是规范绝对路径')
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
    const input=sessionScanSchema.parse(raw),sources:SessionSource[]=[...this.configs.targets().map(target=>({...target,clientType:'codex' as const})),...this.claudeTargets()]
    if(input.targetId&&!sources.some(target=>target.id===input.targetId))throw new Error('会话来源目录不存在')
    const selectedSources=sources.filter(target=>(!input.targetId||input.targetId===target.id)&&(input.clientType==='all'||input.clientType===target.clientType)),targets=selectedSources.filter(target=>target.clientType==='codex')
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
          const target=this.configs.identityTarget(selected.id),root=target.directory
          try{await lstat(root)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&target.managed){sourceCounts[target.id]=0;continue}throw error}
          const rootStat=await lstat(root),daemon=await probeClientDaemon(root,signal),targetRunning=this.running(target.id)||daemon==='running',display=await readSessionDisplay(root,signal,warn),sourceRows:{record:SessionRecord;file:SourceFile;matched:boolean}[]=[]
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
                const historyMode=meta.payload?.history_mode==='paginated'?'paginated' as const:undefined
                const location:SessionLocation={targetId:target.id,name:target.name,directory:root,running:targetRunning,archived:relative(root,path).startsWith('archived_sessions'+sep),ambiguous:false,...historyMode?{historyMode}:{}}
                const record:SessionRecord={id,title,cwd,projectName:displayProject(display,cwd),updatedAt,kind,locations:[location],clientType:'codex',...historyMode?{historyMode}:{}}
                const matched=[title,id].some(value=>value.toLowerCase().includes(input.titleQuery.toLowerCase()))&&(!input.contentQuery||await sessionContains(file,stat.size,input.contentQuery,signal))
                sourceRows.push({record,matched,file:{path,root,targetId:target.id,device:stat.dev,inode:stat.ino,rootDevice:rootStat.dev,rootInode:rootStat.ino,size:stat.size,record:structuredClone(record)}})
              }finally{await file.close()}
            }catch(error){signal.throwIfAborted();warn(`部分会话文件无法读取（${basename(path)}），请刷新或检查文件`)}
          }
          // Do not publish rows read through a replaced/deregistered home.
          this.configs.identityTarget(target.id);signal.throwIfAborted()
          const finalRoot=await lstat(root);if(finalRoot.dev!==rootStat.dev||finalRoot.ino!==rootStat.ino)throw new Error('会话目录已被替换')
          const grouped=new Map<string,typeof sourceRows>()
          for(const row of sourceRows)grouped.set(row.record.id,[...(grouped.get(row.record.id)??[]),row])
          const indexedRollouts=[...grouped.values()].some(rows=>rows.length>1)?await readSessionRolloutIndex(root,signal,warn):new Map<string,string>()
          for(const [id,rows] of grouped){
            if(rows.some(row=>row.matched))matches.add(id)
            const ordered=rows.slice().sort((a,b)=>canonical(a.file).localeCompare(canonical(b.file)))
            let identical=rows.length<2
            if(!identical&&rows.every(row=>row.file.size===ordered[0].file.size)){
              try{
                const first=await digest(ordered[0].file,signal);identical=true
                for(const row of ordered.slice(1))if(await digest(row.file,signal)!==first){identical=false;break}
              }catch{signal.throwIfAborted();identical=false}
            }
            // A native paginated thread has distinct continuation segments.
            // Its active database path, matched against safely scanned files
            // with the same metadata ID, identifies the current segment. Never
            // guess from filenames, mtime, the longest file or inactive DBs.
            const indexed=ordered.filter(row=>row.file.path===indexedRollouts.get(id)),primary=!identical&&indexed.length===1?indexed[0]:undefined
            const selected=primary?[primary]:identical?[ordered[0]]:ordered
            const retained=primary?ordered.filter(row=>row!==primary):identical?ordered.slice(1):[]
            for(const row of retained)row.file.duplicateOf=selected[0].file.path
            if(primary)primary.record.locations[0].historicalCopies=retained.length
            // Keep every physical file for full-directory sync/trash.  Actions
            // that need one source filter duplicateOf and use the canonical row.
            for(const {record,file} of selected){
              files.set(id,[...files.get(id)??[],file,...retained.map(row=>row.file)])
              const existing=records.get(id)
              if(existing){
                const location=existing.locations.find(value=>value.targetId===target.id)
                if(location)location.ambiguous=true
                else existing.locations.push(record.locations[0])
                if((record.updatedAt??0)>(existing.updatedAt??0)){const locations=existing.locations;records.set(id,{...record,locations})}
              }else records.set(id,record)
            }
            if(!identical&&!primary&&rows.length>1){
              const location=records.get(id)?.locations.find(value=>value.targetId===target.id)
              if(location)location.ambiguous=true
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
            let resumeBlockedReason=target.launchMode==='desktop'?'请在原 Claude Desktop 的 Code 页面中继续此会话':target.role==='instance'&&this.running(target.id)?'实例正在运行，请先在实例内使用 /resume，或停止实例后从这里恢复':session.conflict?'同 ID 会话存在文件冲突，请先核对来源':!scan.complete?'会话来源尚未完整读取，请刷新后重试':location.resumeBlockedReason??(!location.cwd?'会话没有保存项目工作目录':undefined)
            if(!resumeBlockedReason&&location.cwd)try{const cwd=statSync(location.cwd);if(!cwd.isDirectory())resumeBlockedReason='原项目目录不可用，请恢复目录后重试'}catch{resumeBlockedReason='原项目目录不可用，请恢复目录后重试'}
            const row:SessionRecord={
              id,clientType:'claude_code',launchMode:target.launchMode,sourceSessionId:session.id,title:location.title,cwd:location.cwd??'未知工作目录',projectName:location.cwd?basename(location.cwd):undefined,updatedAt:session.updatedAt,kind:'conversation',messageCount:session.messageCount,model:session.model,resumeMode:target.role==='default'?'default_fork':'managed',resumeBlockedReason,
              locations:[{targetId:target.id,name:target.name,directory:target.directory,running:this.running(target.id),archived:false,ambiguous:session.conflict}],
              capabilities:{open:true,transfer:false,archive:false,trash:false,visibilityRepair:false,tokens:false,contentSearch:true,content:true,resume:!resumeBlockedReason},
            }
            records.set(id,row);claudeFiles.set(id,{target,profile:identity.profile,location,sessionId:session.id,record:session})
            if((!input.contentQuery||location.contentMatched)&&[row.title,session.id].some(value=>value.toLowerCase().includes(input.titleQuery.toLowerCase())))matches.add(id)
          }
        }catch{signal.throwIfAborted();warn('实例目录已变化或无法安全读取，请刷新后重试')}
      }
      signal.throwIfAborted()
      const sorted=[...records.values()].filter(record=>matches.has(record.id)&&(input.kind==='all'||record.kind===input.kind)&&(!input.projectQuery||[record.cwd,record.projectName??''].some(value=>value.toLowerCase().includes(input.projectQuery.toLowerCase())))).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.cwd.localeCompare(b.cwd)||a.id.localeCompare(b.id))
      this.snapshot={id:randomUUID(),scannedAt:Date.now(),records:sorted,files,claudeFiles,warnings:[...warnings].slice(0,100),sourceCounts,sources}
      return this.page({snapshotId:this.snapshot.id,page:1,pageSize:25})
    }catch(error){if(signal.aborted)throw new Error('会话读取已取消');throw error}
    finally{if(this.scanning===run)this.scanning=undefined}
  }
  private current(id:string):Snapshot{const snapshot=this.snapshot;if(!snapshot||snapshot.id!==id)throw new Error('会话列表已更新，请重新读取');return snapshot}
  page(raw:unknown):SessionPage{
    const input=sessionPageSchema.parse(raw),snapshot=this.current(input.snapshotId),page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.records.length/input.pageSize)))
    return {snapshotId:snapshot.id,scannedAt:snapshot.scannedAt,total:snapshot.records.length,page,pageSize:input.pageSize,items:structuredClone(snapshot.records.slice((page-1)*input.pageSize,page*input.pageSize)),warnings:[...snapshot.warnings],sourceCounts:{...snapshot.sourceCounts},sources:structuredClone(snapshot.sources)}
  }
  private async unchanged(source:SourceFile,stat:Stats){
    const target=this.configs.identityTarget(source.targetId);if(target.directory!==source.root)throw new Error('会话来源目录已改变')
    const root=await lstat(source.root);if(root.dev!==source.rootDevice||root.ino!==source.rootInode)throw new Error('会话来源目录已被替换')
    const current=await safeSessionPath(source.root,source.path)
    if(!current.isFile()||current.nlink!==1||current.dev!==stat.dev||current.ino!==stat.ino)throw new Error('会话文件已被替换，请刷新列表')
    if(current.size!==stat.size||current.mtimeMs!==stat.mtimeMs||current.ctimeMs!==stat.ctimeMs)throw new Error('会话文件正在变化，请刷新后重试')
  }
  private async verified(source:SourceFile,id:string,signal:AbortSignal){
    signal.throwIfAborted()
    const target=this.configs.identityTarget(source.targetId);if(target.directory!==source.root)throw new Error('会话来源目录已改变')
    const root=await lstat(source.root);if(root.dev!==source.rootDevice||root.ino!==source.rootInode)throw new Error('会话来源目录已被替换')
    const opened=await openSessionFile(source.root,source.path)
    try{
      if(opened.stat.dev!==source.device||opened.stat.ino!==source.inode)throw new Error('会话文件已被替换，请刷新列表')
      const meta=await firstSessionEvent(opened.file,opened.stat.size,signal)
      if(meta?.type!=='session_meta'||sessionIdentifier(meta.payload?.id??meta.payload?.session_id??meta.id??meta.session_id)!==id)throw new Error('会话文件身份已改变，请刷新列表')
      await this.unchanged(source,opened.stat);signal.throwIfAborted();return opened
    }catch(error){await opened.file.close();throw error}
  }
  async location(raw:unknown):Promise<string>{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId)
    if(claude){
      if(claude.target.id!==input.targetId||!snapshot.records.some(record=>record.id===input.sessionId))throw new Error('会话不属于所选目录')
      const current=await this.claudeTargetIdentity(claude.target)
      if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
      const path=verifyClaudeSessionLocation(claude.location);this.current(input.snapshotId);return path
    }
    const sources=snapshot.files.get(input.sessionId)?.filter(value=>value.targetId===input.targetId&&!value.duplicateOf)??[]
    if(sources.length!==1)throw new Error(sources.length?'所选目录存在多个同 ID 会话，无法确定文件':'会话不属于所选目录')
    const opened=await this.verified(sources[0],input.sessionId,new AbortController().signal);await opened.file.close();this.current(input.snapshotId);return sources[0].path
  }
  async content(raw:unknown):Promise<SessionContentPage>{
    const input=sessionContentSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!claude||!row||claude.target.id!==input.targetId)throw new Error('所选会话不支持此正文阅读器，或不属于当前目录')
    const current=await this.claudeTargetIdentity(claude.target)
    if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
    const content=readClaudeSessionContent(claude.location,{page:input.page,pageSize:input.pageSize,query:input.query})
    this.current(input.snapshotId)
    return {snapshotId:input.snapshotId,sessionId:row.id,sourceSessionId:claude.sessionId,title:row.title,cwd:row.cwd,sourceName:claude.target.name,clientType:'claude_code',...content}
  }
  /** Resume plans are bound to the original instance/profile and snapshot.
   * Launch tickets must call this again immediately before committing launch. */
  async claudeResume(raw:unknown):Promise<CatalogClaudeResumePreview>{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!claude||!row||claude.target.id!==input.targetId)throw new Error('Claude Code 会话不属于所选实例')
    if(claude.target.role!=='instance')throw new Error('默认 Claude Code 会话未绑定管理器实例，请在原终端中继续')
    const current=await this.claudeTargetIdentity(claude.target)
    if(current.profile!==claude.profile)throw new Error('Claude Code 会话来源实例已变化，请刷新列表')
    if(claude.target.launchMode==='desktop')throw new Error('请在原 Claude Desktop 的 Code 页面中继续此会话')
    if(this.running(input.targetId))throw new Error('实例正在运行，请先在实例内使用 /resume，或停止实例后恢复')
    const selection={instanceId:input.targetId,configDirectory:claude.target.directory,cwd:claude.location.cwd??'',sessionId:claude.sessionId,sourceId:claude.location.sourceId}
    const preview=previewClaudeSessionResume({configDirectory:claude.target.directory,sessionsDirectory:claude.location.source.projects.path,instanceId:input.targetId,scannedAt:snapshot.scannedAt,records:[claude.record],warnings:[],complete:true},selection)
    this.current(input.snapshotId)
    return {...preview,instanceRevision:current.revision,profileFingerprint:createHash('sha256').update(current.profile).digest('hex')}
  }
  /** Freshly revalidate a default-profile session without ever resolving an account or managed instance. */
  async defaultClaudeResume(raw:unknown):Promise<{snapshotId:string;sessionId:string;targetId:string;location:ClaudeSessionLocation;homeDirectory:string;cwdCanonicalPath:string;cwdDevice:number;cwdInode:number;configCanonicalPath:string;configDevice:number;configInode:number;projectsDevice:number;projectsInode:number;projectDevice:number;projectInode:number}>{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),claude=snapshot.claudeFiles.get(input.sessionId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!claude||!row||claude.target.id!==input.targetId||claude.target.role!=='default'||claude.target.launchMode!=='cli'||row.resumeMode!=='default_fork')throw new Error('所选会话不是本机默认 Claude Code CLI 会话')
    if(row.capabilities?.resume!==true)throw new Error(row.resumeBlockedReason??'此会话当前不能安全继续')
    const before=await this.claudeTargetIdentity(claude.target)
    if(before.profile!==claude.profile)throw new Error('默认 Claude Code 会话目录已变化，请刷新列表')
    const scan=await scanClaudeCodeSessionsAsync(claude.target.directory)
    if(!scan.complete)throw new Error('默认 Claude Code 会话目录尚未完整读取，请刷新后重试')
    const selected=scan.records.find(value=>value.id===claude.sessionId)
    if(!selected||selected.conflict||selected.locations.length!==1)throw new Error('同 ID Claude Code 会话存在文件冲突，请先核对来源')
    const location=selected.locations[0]
    if(location.sourceId!==claude.location.sourceId)throw new Error('默认 Claude Code 会话文件已变化，请刷新列表')
    if(location.resumeBlockedReason)throw new Error(location.resumeBlockedReason)
    if(!location.cwd||!isAbsolute(location.cwd))throw new Error('会话没有有效的项目工作目录')
    const cwdCanonicalPath=realpathSync(location.cwd),cwd=statSync(location.cwd),canonical=statSync(cwdCanonicalPath)
    if(!cwd.isDirectory()||cwd.dev!==canonical.dev||cwd.ino!==canonical.ino)throw new Error('会话项目目录不可用，请恢复目录后重试')
    const after=await this.claudeTargetIdentity(claude.target)
    if(after.profile!==before.profile||JSON.stringify(after.root)!==JSON.stringify(before.root))throw new Error('默认 Claude Code 会话目录已变化，请刷新列表')
    this.current(input.snapshotId)
    return {snapshotId:input.snapshotId,sessionId:claude.sessionId,targetId:input.targetId,location:structuredClone(location),homeDirectory:dirname(location.source.config.canonicalPath),cwdCanonicalPath,cwdDevice:cwd.dev,cwdInode:cwd.ino,configCanonicalPath:location.source.config.canonicalPath,configDevice:location.source.config.device,configInode:location.source.config.inode,projectsDevice:location.source.projects.device,projectsInode:location.source.projects.inode,projectDevice:location.project.device,projectInode:location.project.inode}
  }
  originalSessionId(raw:unknown):string{
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),row=snapshot.records.find(record=>record.id===input.sessionId)
    if(!row||!row.locations.some(location=>location.targetId===input.targetId))throw new Error('会话不属于所选目录')
    return row.sourceSessionId??row.id
  }
  selectedRecords(snapshotId:string,ids:string[]):SessionRecord[]{
    const input=sessionStatsSchema.parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId)
    return [...new Set(input.sessionIds)].map(id=>{const row=snapshot.records.find(row=>row.id===id);if(!row)throw new Error('所选会话不在当前列表中，请重新选择');if(row.clientType==='claude_code')throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 会话修改操作');z.string().uuid().parse(id);return structuredClone(row)})
  }
  async transferSources(snapshotId:string,ids:string[],signal=new AbortController().signal):Promise<SessionTransferSource[]>{
    const input=sessionStatsSchema.extend({sessionIds:z.array(z.string().min(1).max(256)).min(1).max(1000)}).parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId),result:SessionTransferSource[]=[]
    for(const id of new Set(input.sessionIds)){
      const record=snapshot.records.find(row=>row.id===id)
      if(!record)throw new Error('所选会话不在当前筛选列表中，请重新选择')
      if(record.clientType==='claude_code')throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 会话复制或导出')
      const sources=(snapshot.files.get(id)??[]).filter(source=>!source.duplicateOf&&!record.locations.find(location=>location.targetId===source.targetId)?.ambiguous).sort((a,b)=>(b.record.updatedAt??0)-(a.record.updatedAt??0))
      if(!sources.length)throw new Error('所选会话存在同 ID 文件冲突，请先核对')
      const source=sources[0],opened=await this.verified(source,id,signal)
      try{result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record)})}finally{await opened.file.close()}
    }
    this.current(input.snapshotId);return result
  }
  async syncSources(snapshotId:string,signal:AbortSignal):Promise<SessionTransferSource[]>{
    const snapshot=this.current(snapshotId),result:SessionTransferSource[]=[]
    if(snapshot.claudeFiles.size)throw new Error('Claude Code 会话当前仅支持只读查看，不能使用 Codex 全目录同步')
    if(snapshot.warnings.length)throw new Error('部分会话目录读取不完整，未准备同步：'+snapshot.warnings[0])
    for(const [id,sources] of snapshot.files)for(const source of sources){
      const opened=await this.verified(source,id,signal)
      try{result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record)})}finally{await opened.file.close()}
    }
    this.current(snapshotId);return result
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
