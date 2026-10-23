import type {FileHandle} from 'node:fs/promises'
import {lstatSync} from 'node:fs'
import {basename} from 'node:path'
import {readCodexSessionContentForMerge,readCodexSessionLineageContent,type CodexRolloutSegmentSource,type CodexSessionContentPage} from './codexSessionContent'
import {firstSessionEvent,jsonLine,openSessionFile,rolloutFiles,safeSessionPath,sessionDigest,reverseSessionLines} from './sessionFiles'

interface HistoryBase {rolloutId:string;endOrdinalExclusive:number;endByteOffset:number}
interface RolloutNode {path:string;rolloutId:string;threadId:string;file:FileHandle;size:number;device:number;inode:number;mtime:number;ctime:number;initialOrdinal:number;historyBase?:HistoryBase}
interface CandidateRevision {path:string;digest:string;device:number;inode:number;size:number;mtime:number;ctime:number}
const maxLineageSegments=100
const maxPaginatedLineBytes=64*1024**2
const canonicalName=/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i
function rolloutIdentity(path:string):{threadId:string;rolloutId:string}|undefined{const match=basename(path).match(canonicalName);return match?{threadId:match[1].toLowerCase(),rolloutId:(match[2]??match[1]).toLowerCase()}:undefined}
function baseFor(content:Awaited<ReturnType<typeof readCodexSessionContentForMerge>>,threadId:string):HistoryBase|undefined{
  if(!content.hasHistoryBase)return
  const {historyBaseThreadId,historyBaseEndOrdinalExclusive:endOrdinalExclusive,historyBaseEndByteOffset:endByteOffset}=content
  if(!historyBaseThreadId||endOrdinalExclusive===undefined||endByteOffset===undefined)throw new Error('Codex rollout 的 history_base 字段不完整')
  if(!/^[0-9a-f-]{36}$/i.test(historyBaseThreadId)||!Number.isSafeInteger(endOrdinalExclusive)||endOrdinalExclusive<0||!Number.isSafeInteger(endByteOffset)||endByteOffset<0)throw new Error('Codex rollout 的 history_base 边界无效')
  const normalized=historyBaseThreadId.toLowerCase()
  // Codex writes thread_id in two supported shapes: the thread ID itself (the
  // predecessor filename has no rollout suffix), or a previous rollout ID.
  // Resolve the latter against rollout filename identities; never treat the
  // current rollout's thread component as a self-reference when it is the
  // established thread ID shared by all segments.
  return {rolloutId:normalized,endOrdinalExclusive,endByteOffset}
}
async function boundaryMatches(file:FileHandle,size:number,byteOffset:number,endOrdinalExclusive:number,signal:AbortSignal):Promise<boolean>{
  if(byteOffset>size)return false
  if(byteOffset>0){const previous=Buffer.alloc(1);const read=await file.read(previous,0,1,byteOffset-1);if(read.bytesRead!==1||previous[0]!==10)return false}
  if(byteOffset===size){
    // EOF is a valid byte boundary only when the final retained record is
    // strictly before the exclusive ordinal cutoff. Otherwise a stale or
    // malformed history_base could silently include an incomplete prefix.
    for await(const line of reverseSessionLines(file,size,signal,maxPaginatedLineBytes)){
      if(!line.length)continue
      const event=jsonLine(line)
      return !!event&&Number.isSafeInteger(event.ordinal)&&event.ordinal<endOrdinalExclusive
    }
    return false
  }
  const parts:Buffer[]=[];let length=0,offset=byteOffset,buffer=Buffer.alloc(16*1024)
  while(offset<size&&length<maxPaginatedLineBytes){signal.throwIfAborted();const count=Math.min(buffer.length,size-offset,maxPaginatedLineBytes-length),read=await file.read(buffer,0,count,offset);if(!read.bytesRead)return false;const end=buffer.subarray(0,read.bytesRead).indexOf(10);if(end>=0){if(length+end>maxPaginatedLineBytes)return false;parts.push(Buffer.from(buffer.subarray(0,end)));length+=end;const event=jsonLine(Buffer.concat(parts,length));return !!event&&Number.isSafeInteger(event.ordinal)&&event.ordinal>=endOrdinalExclusive}parts.push(Buffer.from(buffer.subarray(0,read.bytesRead)));length+=read.bytesRead;offset+=read.bytesRead}
  return false
}
async function resolveThreadBase(root:string,threadId:string,currentPath:string,base:HistoryBase,signal:AbortSignal):Promise<CandidateRevision[]>{
  const matches:CandidateRevision[]=[]
  for await(const candidate of rolloutFiles(root,signal)){const identity=rolloutIdentity(candidate);if(!identity||identity.threadId!==threadId||candidate===currentPath)continue;let opened:Awaited<ReturnType<typeof openSessionFile>>|undefined
    try{opened=await openSessionFile(root,candidate);const before=await opened.file.stat(),payloadEvent=await firstSessionEvent(opened.file,before.size,signal),payload=payloadEvent?.payload&&typeof payloadEvent.payload==='object'?payloadEvent.payload:payloadEvent;if(payloadEvent?.type!=='session_meta'||typeof payload?.id!=='string'||payload.id.toLowerCase()!==threadId||payload.history_mode!=='paginated')continue;if(!await boundaryMatches(opened.file,before.size,base.endByteOffset,base.endOrdinalExclusive,signal))continue;const digest=await sessionDigest(opened.file,before.size,signal),after=await opened.file.stat();if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Codex history_base 祖先文件在解析期间发生变化，请刷新列表');matches.push({path:candidate,digest,device:after.dev,inode:after.ino,size:after.size,mtime:after.mtimeMs,ctime:after.ctimeMs})}
    finally{if(opened)await opened.file.close()}
  }
  return matches
}
function unchanged(root:string,node:RolloutNode):void{
  const stat=lstatSync(node.path),safe=safeSessionPathSync(root,node.path)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==node.device||stat.ino!==node.inode||stat.size!==node.size||stat.mtimeMs!==node.mtime||stat.ctimeMs!==node.ctime||safe.dev!==stat.dev||safe.ino!==stat.ino||safe.size!==stat.size||safe.mtimeMs!==node.mtime||safe.ctimeMs!==node.ctime)throw new Error('Codex 分段会话在读取期间发生变化，请刷新列表')
}
function safeSessionPathSync(root:string,path:string){
  // Reuse the canonical async guard without yielding to a renderer callback.
  const {relative,resolve,sep,isAbsolute,join}=require('node:path') as typeof import('node:path')
  const {lstatSync,realpathSync}=require('node:fs') as typeof import('node:fs')
  const suffix=relative(root,path)
  if(!suffix||suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))throw new Error('Codex rollout 路径不属于所选实例')
  let current=root,stat=lstatSync(root)
  if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(root)!==root)throw new Error('Codex 实例目录已变化')
  const parts=suffix.split(sep)
  for(let index=0;index<parts.length;index++){current=join(current,parts[index]);stat=lstatSync(current);if(stat.isSymbolicLink()||index<parts.length-1&&!stat.isDirectory())throw new Error('Codex rollout 路径包含链接或异常目录')}
  return stat
}

/** Read a complete paginated thread by following Codex history_base pointers.
 * Every ancestor must resolve to one immutable canonical rollout inside the
 * selected managed home; both ordinal and byte-offset cutoffs are verified. */
export async function readCodexSessionLineage(
  root:string,currentPath:string,sessionId:string,raw:{page?:number;pageSize?:number;query?:string},signal:AbortSignal,
  current?:{file:FileHandle;size:number},
):Promise<CodexSessionContentPage>{
  const rootStat=lstatSync(root)
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||require('node:fs').realpathSync(root)!==root)throw new Error('Codex 实例目录已变化')
  const selected=rolloutIdentity(currentPath)
  if(!selected||selected.threadId!==sessionId.toLowerCase())throw new Error('当前 Codex rollout 文件名与会话 ID 不匹配')
  const nodes:RolloutNode[]=[],owned:FileHandle[]=[],seen=new Set<string>(),candidatesById=new Map<string,string[]>(),candidateRevisions=new Map<string,CandidateRevision>()
  const sourceSignal=signal
  try{
    let path=currentPath,rolloutId=selected.rolloutId,provided=current
    while(true){
      sourceSignal.throwIfAborted()
      if(nodes.length>=maxLineageSegments)throw new Error('Codex 分段历史超过 100 段读取上限')
      const lineageKey=`${rolloutId}|${path}`
      if(seen.has(lineageKey))throw new Error('Codex 分段历史 lineage 存在循环引用')
      seen.add(lineageKey)
      const opened=provided??await openSessionFile(root,path);provided=undefined
      if(!current||path!==currentPath)owned.push(opened.file)
      const before=await opened.file.stat(),identity=rolloutIdentity(path)
      if(!identity||identity.rolloutId!==rolloutId||!before.isFile()||before.nlink!==1)throw new Error('Codex lineage 引用的 rollout 身份不匹配')
      const selectedRevision=candidateRevisions.get(path)
      if(selectedRevision&&(before.dev!==selectedRevision.device||before.ino!==selectedRevision.inode||before.size!==selectedRevision.size||before.mtimeMs!==selectedRevision.mtime||before.ctimeMs!==selectedRevision.ctime||await sessionDigest(opened.file,before.size,sourceSignal)!==selectedRevision.digest))throw new Error('Codex history_base 祖先文件在解析后发生变化，请刷新列表')
      const metadata=await readCodexSessionContentForMerge(opened.file,before.size,path===currentPath?sessionId:undefined,sourceSignal,maxPaginatedLineBytes)
      if(metadata.warnings.length)throw new Error('Codex rollout 包含无法解析的记录，拒绝显示不完整对话')
      if(!metadata.paginated)throw new Error('Codex history_base lineage 包含非分页会话文件')
      if(path!==currentPath&&metadata.sessionMetaId!==identity.threadId)throw new Error('Codex history_base 源 rollout 的 session ID 与文件名不匹配')
      const node:RolloutNode={path,rolloutId,threadId:identity.threadId,file:opened.file,size:before.size,device:before.dev,inode:before.ino,mtime:before.mtimeMs,ctime:before.ctimeMs,initialOrdinal:metadata.historyBaseEndOrdinalExclusive??0}
      node.historyBase=baseFor(metadata,identity.threadId)
      node.initialOrdinal=metadata.historyBaseEndOrdinalExclusive??0
      nodes.push(node)
      if(!node.historyBase)break
      let matches:CandidateRevision[]
      if(node.historyBase.rolloutId===node.threadId){
        matches=await resolveThreadBase(root,node.threadId,currentPath,node.historyBase,sourceSignal)
        if(!matches.length)throw new Error('Codex history_base 未找到 ordinal 与字节边界都匹配的祖先 rollout')
        if(new Set(matches.map(candidate=>candidate.digest)).size!==1)throw new Error('Codex history_base 的祖先 rollout 存在多个不同文件，无法安全选择')
        const candidate=matches[0];candidateRevisions.set(candidate.path,candidate);path=candidate.path;rolloutId=rolloutIdentity(path)!.rolloutId;continue
      }else rolloutId=node.historyBase.rolloutId
      let paths=candidatesById.get(rolloutId)??[]
      if(!candidatesById.has(rolloutId)){
        paths=[]
        for await(const candidate of rolloutFiles(root,sourceSignal)){const identity=rolloutIdentity(candidate);if(identity?.rolloutId===rolloutId)paths.push(candidate)}
        candidatesById.set(rolloutId,paths)
      }
      if(!paths.length)throw new Error('Codex 完整会话缺少 history_base 所引用的源 rollout：'+rolloutId)
      const revisions:CandidateRevision[]=[]
      for(const candidate of paths){const openedCandidate=await openSessionFile(root,candidate);try{const before=await openedCandidate.file.stat(),digest=await sessionDigest(openedCandidate.file,before.size,sourceSignal),after=await openedCandidate.file.stat();if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Codex history_base 源 rollout 在解析期间发生变化，请刷新列表');revisions.push({path:candidate,digest,device:after.dev,inode:after.ino,size:after.size,mtime:after.mtimeMs,ctime:after.ctimeMs})}finally{await openedCandidate.file.close()}}
      if(new Set(revisions.map(candidate=>candidate.digest)).size!==1)throw new Error('Codex history_base 源 rollout 存在多个不同文件，无法安全选择')
      for(const revision of revisions)candidateRevisions.set(revision.path,revision)
      path=revisions[0].path
    }
    const segments:CodexRolloutSegmentSource[]=nodes.slice().reverse().map((node,index,ordered)=>{
      const child=index<ordered.length-1?ordered[index+1]:undefined,base=node.historyBase
      return {file:node.file,size:node.size,maxLineBytes:maxPaginatedLineBytes,startOrdinal:base?base.endOrdinalExclusive+1:1,expectedInitialOrdinal:node.initialOrdinal,...child?.historyBase?{endOrdinalExclusive:child.historyBase.endOrdinalExclusive,expectedEndByteOffset:child.historyBase.endByteOffset}:{}}
    })
    const result=await readCodexSessionLineageContent(segments,raw,sourceSignal)
    for(const node of nodes)unchanged(root,node)
    return result
  }finally{for(const file of owned)await file.close()}
}
