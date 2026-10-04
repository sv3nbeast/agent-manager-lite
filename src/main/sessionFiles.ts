// Read-only rollout/index traversal adapted from Cockpit codex_session_manager.
import {constants,type Stats} from 'node:fs'
import {lstat,open,opendir,realpath,type FileHandle} from 'node:fs/promises'
import {join,relative,isAbsolute,sep} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import type {SessionTokens} from '../shared/sessions'

const chunkSize=64*1024,maxLine=4*1024*1024
export const cleanText=(value:unknown,limit=2000):string=>typeof value==='string'?Array.from(value.trim()).slice(0,limit).join(''):''
export const sessionIdentifier=(value:unknown):string|undefined=>{if(typeof value!=='string')return;const id=value.trim();return id&&id.length<=256&&!/[\x00-\x1f\x7f]/.test(id)?id:undefined}
export const jsonLine=(line:Buffer):Record<string,any>|undefined=>{try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));return value&&typeof value==='object'&&!Array.isArray(value)?value:undefined}catch{return}}
export async function safeSessionPath(root:string,path:string):Promise<Stats>{
  const suffix=relative(root,path)
  if(suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))throw new Error('会话路径不属于所选目录')
  let current=root,stat=await lstat(root)
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root)throw new Error('会话目录已被替换')
  const parts=suffix?suffix.split(sep):[]
  for(let index=0;index<parts.length;index++){
    current=join(current,parts[index]);stat=await lstat(current)
    if(stat.isSymbolicLink()||index<parts.length-1&&!stat.isDirectory())throw new Error('会话路径包含链接或异常目录')
  }
  return stat
}
export async function openSessionFile(root:string,path:string):Promise<{file:FileHandle;stat:Stats}>{
  const expected=await safeSessionPath(root,path)
  if(!expected.isFile()||expected.nlink!==1)throw new Error('会话文件不是独立普通文件')
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.dev!==expected.dev||stat.ino!==expected.ino)throw new Error('会话文件已被替换');return {file,stat}}
  catch(error){await file.close();throw error}
}
export async function* sessionLines(file:FileHandle,size:number,signal:AbortSignal,lineLimit=maxLine):AsyncGenerator<Buffer>{
  let offset=0,pendingLength=0
  let pending:Buffer[]=[]
  const buffer=Buffer.alloc(chunkSize)
  while(offset<size){
    signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,size-offset),offset)
    if(!bytesRead)throw new Error('会话文件正在变化，请刷新');offset+=bytesRead
    let start=0
    for(let end=0;end<bytesRead;end++)if(buffer[end]===10){
      const part=buffer.subarray(start,end);if(pendingLength+part.length>lineLimit)throw new Error(`会话单行超过 ${lineLimit/1024**2} MiB`)
      yield Buffer.concat([...pending,part],pendingLength+part.length)
      pending=[];pendingLength=0;start=end+1
    }
    if(start<bytesRead){pendingLength+=bytesRead-start;if(pendingLength>lineLimit)throw new Error(`会话单行超过 ${lineLimit/1024**2} MiB`);pending.push(Buffer.from(buffer.subarray(start,bytesRead)))}
  }
  if(pendingLength)yield Buffer.concat(pending,pendingLength)
}
export async function firstSessionEvent(file:FileHandle,size:number,signal:AbortSignal):Promise<Record<string,any>|undefined>{
  for await(const line of sessionLines(file,Math.min(size,maxLine+1),signal))if(line.toString().trim())return jsonLine(line)
}
export async function* reverseSessionLines(file:FileHandle,size:number,signal:AbortSignal,maxBytes=Infinity):AsyncGenerator<Buffer>{
  let offset=size,read=0,prefix=Buffer.alloc(0),oversized=false
  while(offset>0&&read<maxBytes){
    signal.throwIfAborted();const count=Math.min(chunkSize,offset,maxBytes-read);offset-=count;read+=count
    const buffer=Buffer.alloc(count);const result=await file.read(buffer,0,count,offset)
    if(result.bytesRead!==count)throw new Error('会话文件正在变化，请刷新')
    let end=count
    for(let i=count-1;i>=0;i--)if(buffer[i]===10){
      if(!oversized&&end-i-1+prefix.length<=maxLine)yield Buffer.concat([buffer.subarray(i+1,end),prefix])
      prefix=Buffer.alloc(0);oversized=false;end=i
    }
    if(!oversized){prefix=Buffer.concat([buffer.subarray(0,end),prefix]);if(prefix.length>maxLine){prefix=Buffer.alloc(0);oversized=true}}
  }
  if(offset===0&&prefix.length&&!oversized)yield prefix
}
export function sessionTimestamp(value:unknown):number|undefined{
  if(typeof value==='string'&&!/^-?\d+$/.test(value)){const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:undefined}
  const number=typeof value==='number'?value:typeof value==='string'?Number(value):NaN
  if(!Number.isFinite(number)||number<=0)return
  const milliseconds=number>10_000_000_000_000?number/1000:number>10_000_000_000?number:number*1000
  return Number.isSafeInteger(Math.trunc(milliseconds))?Math.trunc(milliseconds):undefined
}
export async function sessionActivity(file:FileHandle,size:number,signal:AbortSignal):Promise<number|undefined>{
  for await(const line of reverseSessionLines(file,size,signal,4*1024*1024)){
    const event=jsonLine(line);if(!event)continue
    for(const object of [event,event.payload??{}])for(const key of ['timestamp','time','created_at','createdAt']){const value=sessionTimestamp(object[key]);if(value!==undefined)return value}
  }
}
export async function sessionTokens(file:FileHandle,size:number,signal:AbortSignal):Promise<SessionTokens|undefined>{
  for await(const line of reverseSessionLines(file,size,signal)){
    if(!line.includes('token_count'))continue
    const event=jsonLine(line);if(event?.type!=='event_msg'||event.payload?.type!=='token_count')continue
    const usage=event.payload.info?.total_token_usage
    if(!usage)continue
    const values=[usage.input_tokens,usage.output_tokens,usage.total_tokens]
    if(values.every(value=>Number.isSafeInteger(value)&&value>=0))return {input:values[0],output:values[1],total:values[2]}
  }
}
export async function sessionContains(file:FileHandle,size:number,query:string,signal:AbortSignal):Promise<boolean>{
  const needle=Buffer.from(query),ascii=/^[\x00-\x7f]*$/.test(query),buffer=Buffer.alloc(chunkSize)
  const normalized=ascii?Buffer.from(query.toLowerCase()):needle
  let offset=0,carry=Buffer.alloc(0)
  while(offset<size){
    signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!bytesRead)break;offset+=bytesRead
    const haystack=Buffer.concat([carry,buffer.subarray(0,bytesRead)])
    if(ascii)for(let i=0;i<haystack.length;i++)if(haystack[i]>=65&&haystack[i]<=90)haystack[i]+=32
    if(haystack.includes(normalized))return true
    carry=haystack.subarray(Math.max(0,haystack.length-needle.length+1))
  }
  return false
}
export async function* rolloutFiles(root:string,signal:AbortSignal):AsyncGenerator<string>{
  let count=0
  async function* walk(path:string,depth:number):AsyncGenerator<string>{
    signal.throwIfAborted();if(depth>64)throw new Error('会话目录超过 64 层')
    const stat=await safeSessionPath(root,path);if(!stat.isDirectory())throw new Error('会话目录类型异常')
    for await(const entry of await opendir(path)){
      signal.throwIfAborted();if(++count>200000)throw new Error('会话目录超过 20 万项，请缩小目录范围')
      const child=join(path,entry.name)
      if(entry.isDirectory())yield* walk(child,depth+1)
      else if(entry.isFile()&&entry.name.startsWith('rollout-')&&entry.name.endsWith('.jsonl'))yield child
      if(count%100===0)await setImmediate()
    }
  }
  for(const folder of ['sessions','archived_sessions'])try{yield* walk(join(root,folder),0)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
