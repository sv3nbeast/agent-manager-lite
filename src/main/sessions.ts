import {randomUUID} from 'node:crypto'
import {lstat} from 'node:fs/promises'
import type {Stats} from 'node:fs'
import {basename,relative,sep} from 'node:path'
import {z} from 'zod'
import {Store} from './store'
import {ClientConfigs} from './clientConfig'
import {sessionScanSchema,sessionPageSchema,sessionSelectionSchema,sessionStatsSchema,type SessionKind,type SessionLocation,type SessionRecord,type SessionPage,type SessionTokenResult} from '../shared/sessions'
import {openSessionFile,rolloutFiles,firstSessionEvent,sessionActivity,sessionTokens,sessionContains,sessionDigest,cleanText,sessionIdentifier,safeSessionPath} from './sessionFiles'
import {readSessionDisplay,readSessionRolloutIndex,displayTitle,displayProject} from './sessionDisplay'
import {probeClientDaemon} from './clientDaemon'

interface SourceFile {path:string;root:string;targetId:string;device:number;inode:number;rootDevice:number;rootInode:number;size:number;record:SessionRecord;duplicateOf?:string}
export interface SessionTransferSource {path:string;root:string;targetId:string;rootDevice:number;rootInode:number;device:number;inode:number;size:number;mtime:number;ctime:number;record:SessionRecord}
interface Snapshot {id:string;scannedAt:number;records:SessionRecord[];files:Map<string,SourceFile[]>;warnings:string[];sourceCounts:Record<string,number>}
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
  constructor(private readonly store:Store,private readonly running:(id:string)=>boolean=()=>false){this.configs=new ClientConfigs(store)}
  cancel(id:string):void{z.string().uuid().parse(id);if(this.scanning?.id===id)this.scanning.controller.abort()}
  cancelTokens(id:string):void{z.string().uuid().parse(id);if(this.snapshot?.id===id)this.statsController?.abort()}
  stop():void{this.scanning?.controller.abort();this.statsController?.abort()}
  async scan(raw:unknown):Promise<SessionPage>{
    const input=sessionScanSchema.parse(raw),targets=this.configs.targets().filter(target=>!input.targetId||input.targetId===target.id)
    if(input.targetId&&!targets.length)throw new Error('会话来源目录不存在')
    this.stop();this.snapshot=undefined
    const controller=new AbortController(),signal=controller.signal,run={id:input.runId,controller};this.scanning=run
    const warnings=new Set<string>(),files=new Map<string,SourceFile[]>(),records=new Map<string,SessionRecord>(),matches=new Set<string>(),digests=new Map<string,Promise<string>>()
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
                const record:SessionRecord={id,title,cwd,projectName:displayProject(display,cwd),updatedAt,kind,locations:[location],...historyMode?{historyMode}:{}}
                const matched=title.toLowerCase().includes(input.titleQuery.toLowerCase())&&(!input.contentQuery||await sessionContains(file,stat.size,input.contentQuery,signal))
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
      signal.throwIfAborted()
      const sorted=[...records.values()].filter(record=>matches.has(record.id)&&(input.kind==='all'||record.kind===input.kind)).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.cwd.localeCompare(b.cwd)||a.id.localeCompare(b.id))
      this.snapshot={id:randomUUID(),scannedAt:Date.now(),records:sorted,files,warnings:[...warnings].slice(0,100),sourceCounts}
      return this.page({snapshotId:this.snapshot.id,page:1,pageSize:25})
    }catch(error){if(signal.aborted)throw new Error('会话读取已取消');throw error}
    finally{if(this.scanning===run)this.scanning=undefined}
  }
  private current(id:string):Snapshot{const snapshot=this.snapshot;if(!snapshot||snapshot.id!==id)throw new Error('会话列表已更新，请重新读取');return snapshot}
  page(raw:unknown):SessionPage{
    const input=sessionPageSchema.parse(raw),snapshot=this.current(input.snapshotId),page=Math.min(input.page,Math.max(1,Math.ceil(snapshot.records.length/input.pageSize)))
    return {snapshotId:snapshot.id,scannedAt:snapshot.scannedAt,total:snapshot.records.length,page,pageSize:input.pageSize,items:structuredClone(snapshot.records.slice((page-1)*input.pageSize,page*input.pageSize)),warnings:[...snapshot.warnings],sourceCounts:{...snapshot.sourceCounts}}
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
    const input=sessionSelectionSchema.parse(raw),snapshot=this.current(input.snapshotId),sources=snapshot.files.get(input.sessionId)?.filter(value=>value.targetId===input.targetId&&!value.duplicateOf)??[]
    if(sources.length!==1)throw new Error(sources.length?'所选目录存在多个同 ID 会话，无法确定文件':'会话不属于所选目录')
    const opened=await this.verified(sources[0],input.sessionId,new AbortController().signal);await opened.file.close();this.current(input.snapshotId);return sources[0].path
  }
  selectedRecords(snapshotId:string,ids:string[]):SessionRecord[]{
    const input=sessionStatsSchema.extend({sessionIds:z.array(z.string().uuid()).min(1).max(1000)}).parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId)
    return [...new Set(input.sessionIds)].map(id=>{const row=snapshot.records.find(row=>row.id===id);if(!row)throw new Error('所选会话不在当前列表中，请重新选择');return structuredClone(row)})
  }
  async transferSources(snapshotId:string,ids:string[],signal=new AbortController().signal):Promise<SessionTransferSource[]>{
    const input=sessionStatsSchema.extend({sessionIds:z.array(z.string().min(1).max(256)).min(1).max(1000)}).parse({snapshotId,sessionIds:ids}),snapshot=this.current(input.snapshotId),result:SessionTransferSource[]=[]
    for(const id of new Set(input.sessionIds)){
      const record=snapshot.records.find(row=>row.id===id)
      if(!record)throw new Error('所选会话不在当前筛选列表中，请重新选择')
      const sources=(snapshot.files.get(id)??[]).filter(source=>!source.duplicateOf&&!record.locations.find(location=>location.targetId===source.targetId)?.ambiguous).sort((a,b)=>(b.record.updatedAt??0)-(a.record.updatedAt??0))
      if(!sources.length)throw new Error('所选会话存在同 ID 文件冲突，请先核对')
      const source=sources[0],opened=await this.verified(source,id,signal)
      try{result.push({path:source.path,root:source.root,targetId:source.targetId,rootDevice:source.rootDevice,rootInode:source.rootInode,device:opened.stat.dev,inode:opened.stat.ino,size:opened.stat.size,mtime:opened.stat.mtimeMs,ctime:opened.stat.ctimeMs,record:structuredClone(source.record)})}finally{await opened.file.close()}
    }
    this.current(input.snapshotId);return result
  }
  async syncSources(snapshotId:string,signal:AbortSignal):Promise<SessionTransferSource[]>{
    const snapshot=this.current(snapshotId),result:SessionTransferSource[]=[]
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
