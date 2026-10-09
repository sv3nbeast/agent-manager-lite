// Cockpit codex_official_app_server transport, with the documented initialized
// notification and verification of the actual copied IDs in thread/list.
import {spawn,type ChildProcessWithoutNullStreams,type SpawnOptionsWithoutStdio} from 'node:child_process'
import {lstatSync,realpathSync} from 'node:fs'
import {join,isAbsolute,relative,sep} from 'node:path'
import {z} from 'zod'
import {sessionRelative} from './sessionTransferFiles'
import {setTimeout as delay} from 'node:timers/promises'
import type {InstanceApplication} from '../shared/instances'
import {resolveCliRuntime} from './cliResolver'
import {codexBundledCli} from './codexPrograms'

export interface SessionProgram {path:string;device:number;inode:number;size:number;mtime:number}
export function sessionProgram(application:InstanceApplication):SessionProgram{
  if(realpathSync(application.path)!==application.path)throw new Error('Codex 程序路径已变化，请重新选择')
  const path=application.kind==='cli'?resolveCliRuntime(application.path).executable:codexBundledCli(application.path),stat=lstatSync(path)
  return {path,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs}
}
export function verifySessionProgram(program:SessionProgram):void{
  const stat=lstatSync(program.path)
  if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(program.path)!==program.path||stat.dev!==program.device||stat.ino!==program.inode||stat.size!==program.size||stat.mtimeMs!==program.mtime)throw new Error('Codex 程序在预览后发生变化，请重新选择')
}
export type SpawnSession=(path:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams
class SessionRequestError extends Error {}
type Request=(method:string,params:unknown)=>Promise<any>
const defaultSpawn:SpawnSession=(path,args,options)=>spawn(path,args,{...options,stdio:['pipe','pipe','pipe']})
async function withSessionServer<T>(program:SessionProgram,home:string,signal:AbortSignal,spawnSession:SpawnSession,action:(request:Request)=>Promise<T>):Promise<T>{
  signal.throwIfAborted();verifySessionProgram(program)
  const child=spawnSession(program.path,['app-server','--listen','stdio://','-c','cli_auth_credentials_store="file"','-c','analytics.enabled=false','-c','features.plugins=false','-c','features.remote_models=false','-c','log_dir='+JSON.stringify(join(home,'log'))],{
    cwd:home,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',CODEX_HOME:home},detached:process.platform!=='win32',windowsHide:true
  })
  let next=0,buffer=Buffer.alloc(0),failure:Error|undefined,closed=false,received=0
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  const fail=(error:Error)=>{failure??=error;for(const request of pending.values())request.reject(error);pending.clear()}
  const kill=(value:NodeJS.Signals)=>{try{if(child.pid){if(process.platform==='win32')child.kill(value);else process.kill(-child.pid,value)}}catch{}}
  const exit=new Promise<void>(resolve=>{child.once('close',()=>{closed=true;fail(new Error('Codex 索引进程已退出'));resolve()});child.once('error',()=>{fail(new Error('无法启动 Codex 索引进程'));if(!child.pid){closed=true;resolve()}})})
  child.stdin.on('error',()=>fail(new Error('Codex 索引进程输入已关闭')))
  child.stderr.resume() // No raw config, conversation or provider error text enters logs.
  child.stdout.on('data',(chunk:Buffer)=>{
    received+=chunk.length;if(received>64*1024*1024){fail(new Error('Codex 索引响应超过大小限制'));kill('SIGTERM');return}
    buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4*1024*1024){fail(new Error('Codex 索引单条响应超过大小限制'));kill('SIGTERM');return}
    for(let end=buffer.indexOf(10);end>=0;end=buffer.indexOf(10)){
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1)
      if(!line.toString().trim())continue
      try{
        const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line))
        if(event.method&&event.id!==undefined){child.stdin.write(JSON.stringify({id:event.id,error:{code:-32601,message:'This client supports session metadata only'}})+'\n');continue}
        const request=pending.get(event.id);if(!request)continue
        pending.delete(event.id)
        if(event.error)request.reject(new SessionRequestError('Codex 拒绝了会话操作，请检查程序版本和所选目录配置'))
        else if(!event.result||typeof event.result!=='object')request.reject(new Error('Codex 索引响应格式无效'))
        else request.resolve(event.result)
      }catch{fail(new Error('Codex 索引响应不是有效 JSON'));kill('SIGTERM')}
    }
  })
  const cancel=()=>{fail(new Error('会话索引更新已取消'));kill('SIGTERM')}
  signal.addEventListener('abort',cancel,{once:true})
  if(signal.aborted)cancel()
  const deadline=setTimeout(()=>{fail(new Error('Codex 会话索引更新超时'));kill('SIGTERM')},45_000)
  const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{
    if(failure||closed){reject(failure??new Error('Codex 索引进程已退出'));return}
    const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')
  })
  try{
    await request('initialize',{clientInfo:{name:'codex-manager-lite',version:'0.1.0'},capabilities:null})
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
    return await action(request)
  }finally{
    clearTimeout(deadline);signal.removeEventListener('abort',cancel);fail(new Error('Codex 索引任务结束'))
    child.stdin.end();kill('SIGTERM')
    await Promise.race([exit,delay(1000)])
    if(!closed){kill('SIGKILL');await Promise.race([exit,delay(1000)])}
  }
}

async function visitThreads(request:Request,signal:AbortSignal,visit:(rows:any[])=>boolean):Promise<void>{
  let pages=0
    for(const archived of [false,true]){
      let cursor:string|null=null
      const cursors=new Set<string>()
      for(let page=0;page<1000;page++){
        if(++pages>1000)throw new Error('Codex 索引验证超过 10 万条，请缩小目录范围')
        signal.throwIfAborted()
        const result=await request('thread/list',{cursor,limit:100,sortKey:'updated_at',sortDirection:'desc',modelProviders:[],sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'],archived,useStateDbOnly:false})
        if(!Array.isArray(result.data)||result.data.length>100)throw new Error('Codex 会话列表格式无效')
        for(const row of result.data)if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string')throw new Error('Codex 会话列表格式无效')
        if(visit(result.data))return
        if(result.nextCursor===null||result.nextCursor===undefined)break
        if(typeof result.nextCursor!=='string'||result.nextCursor.length>10000||cursors.has(result.nextCursor))throw new Error('Codex 会话列表游标无效')
        const nextCursor:string=result.nextCursor;cursor=nextCursor;cursors.add(nextCursor)
        if(page===999)throw new Error('Codex 索引验证超过 10 万条，请缩小目录范围')
      }
    }
}

export async function rebuildSessionMetadata(program:SessionProgram,home:string,ids:string[],signal:AbortSignal,spawnSession:SpawnSession=defaultSpawn):Promise<void>{
  return withSessionServer(program,home,signal,spawnSession,async request=>{
    const missing=new Set(ids)
    await visitThreads(request,signal,rows=>{for(const row of rows)missing.delete(row.id);return !missing.size})
    if(missing.size)throw new Error(`已复制文件，但 Codex 索引中仍缺少 ${missing.size} 条会话，请重试索引更新`)
  })
}

export interface OfficialDeletionEntry {id:string;parentId?:string;path?:string;descendant:boolean}
function deletionIds(ids:string[]):string[]{return [...new Set(z.array(z.string().uuid()).min(1).max(1000).parse(ids))]}
// thread/delete cascades through spawned descendants, including archives. A
// deletion caller MUST back up the complete returned closure before deleting.
export async function planSessionDeletion(program:SessionProgram,home:string,ids:string[],signal:AbortSignal,spawnSession:SpawnSession=defaultSpawn):Promise<OfficialDeletionEntry[]>{
  const selected=new Set(deletionIds(ids))
  return withSessionServer(program,home,signal,spawnSession,async request=>{
    const rows=new Map<string,OfficialDeletionEntry>()
    await visitThreads(request,signal,values=>{
      for(const value of values){
        // Migrated rollout rows may expose ancestry only in source, while the
        // top-level parentThreadId is still null in the official state database.
        const sourceParent=value.source?.subAgent?.thread_spawn?.parent_thread_id
        const parentId=value.parentThreadId??sourceParent
        if(!z.string().uuid().safeParse(value.id).success||parentId!=null&&!z.string().uuid().safeParse(parentId).success||sourceParent!=null&&value.parentThreadId!=null&&sourceParent!==value.parentThreadId)throw new Error('Codex 会话关系格式无效')
        if(value.path!=null&&typeof value.path!=='string')throw new Error('Codex 会话文件路径无效')
        const row:OfficialDeletionEntry={id:value.id,...parentId?{parentId}:{},...value.path?{path:value.path}:{},descendant:!selected.has(value.id)}
        const previous=rows.get(row.id)
        if(previous&&JSON.stringify(previous)!==JSON.stringify(row))throw new Error('Codex 返回了冲突的会话关系，请重新读取')
        rows.set(row.id,row)
      }
      return false
    })
    const children=new Map<string,string[]>()
    for(const row of rows.values())if(row.parentId)children.set(row.parentId,[...children.get(row.parentId)??[],row.id])
    const closure=new Set(selected),queue=[...selected]
    for(let i=0;i<queue.length;i++)for(const id of children.get(queue[i])??[]){if(closure.has(id))continue;closure.add(id);queue.push(id);if(closure.size>1000)throw new Error('所选会话及派生会话超过 1000 条，请缩小范围')}
    return [...closure].map(id=>{
      const row=rows.get(id)??{id,descendant:false}
      if(row.path){const rel=relative(home,row.path);if(!isAbsolute(row.path)||!sessionRelative(rel.split(sep).join('/')))throw new Error('官方索引指向所选目录之外或异常会话文件，未开始删除')}
      return row
    })
  })
}

export interface OfficialDeletionResult {deletedIds:string[];failedIds:string[]}
export async function deleteSessionThreads(program:SessionProgram,home:string,ids:string[],signal:AbortSignal,spawnSession:SpawnSession=defaultSpawn):Promise<OfficialDeletionResult>{
  const selected=deletionIds(ids)
  return withSessionServer(program,home,signal,spawnSession,async request=>{
    const result:OfficialDeletionResult={deletedIds:[],failedIds:[]}
    for(const id of selected){
      signal.throwIfAborted()
      try{await request('thread/delete',{threadId:id});result.deletedIds.push(id)}
      catch(error){if(!(error instanceof SessionRequestError))throw error;result.failedIds.push(id)}
    }
    return result
  })
}
export async function verifyDeletedSessionMetadata(program:SessionProgram,home:string,ids:string[],signal:AbortSignal,spawnSession:SpawnSession=defaultSpawn):Promise<void>{
  const selected=new Set(deletionIds(ids))
  return withSessionServer(program,home,signal,spawnSession,async request=>{
    await visitThreads(request,signal,rows=>{if(rows.some(row=>selected.has(row.id)))throw new Error('会话文件已备份，但官方索引仍显示待删除会话，请重试删除');return false})
  })
}
