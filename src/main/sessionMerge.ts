// Event-level merge order and freshness follow Cockpit codex_thread_sync.rs.
// SQLite spools the sort/deduplication so full conversations stay off the heap.
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync,lstatSync} from 'node:fs'
import {open} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {SessionTransferSource} from './sessions'
import {verifySource} from './sessionTransferFiles'
import {openSessionFile,sessionLines,sessionTimestamp} from './sessionFiles'
import {sourceBytes} from './sessionZip'

export interface MergedSession {source:SessionTransferSource;originals:SessionTransferSource[];index:Record<string,unknown>;sha256:string}
class NumberToken {constructor(readonly raw:string){}}
// JSON.parse's source context keeps integers above 2^53 distinct. Do not let
// a JS rounding collision silently deduplicate two different tool events.
function canonical(line:string):{key:string;parsed:any}{
  const parsed=JSON.parse(line,(key,value,context?:{source?:string})=>typeof value==='number'?new NumberToken(context?.source??(()=>{throw new Error('JSON number source unavailable')})()):value)
  const encode=(value:any):string=>{
    if(value instanceof NumberToken){if(/^-?\d+$/.test(value.raw)&&value.raw!=='-0')return 'i'+BigInt(value.raw).toString();const n=Number(value.raw);return 'f'+(Object.is(n,-0)?'-0':Number.isFinite(n)?String(n):value.raw)}
    if(Array.isArray(value))return '['+value.map(encode).join(',')+']'
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+encode(value[key])).join(',')+'}'
    return JSON.stringify(value)
  }
  return {key:'json:'+encode(parsed),parsed:JSON.parse(line)}
}
export function eventTime(value:any):number|undefined{
  for(const object of [value,value?.payload])if(object&&typeof object==='object'){
    const key=['timestamp','time','created_at','createdAt'].find(key=>Object.hasOwn(object,key))
    if(key){const result=sessionTimestamp(object[key]);if(result!==undefined)return result}
  }
}
const indexTime=(entry:Record<string,unknown>)=>['updated_at','updatedAt','last_updated_at','lastUpdatedAt'].map(key=>sessionTimestamp(entry[key])).find(value=>value!==undefined)??0
export async function mergeSessionCopies(root:string,sources:SessionTransferSource[],indexes:Map<string,Record<string,unknown>>,signal:AbortSignal,progress:(files:number,bytes:number)=>void):Promise<MergedSession[]>{
  const db=new DatabaseSync(join(root,'events.sqlite'));db.exec('PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TABLE events (thread TEXT, source INTEGER, line INTEGER, rank INTEGER, time INTEGER, key TEXT, raw TEXT); CREATE INDEX events_thread ON events(thread);')
  const insert=db.prepare('INSERT INTO events VALUES (?,?,?,0,?,?,?)'),rank=db.prepare('UPDATE events SET rank=? WHERE thread=? AND source=?'),results:MergedSession[]=[]
  const grouped=new Map<string,SessionTransferSource[]>()
  let bytes=0,files=0
  try{
    for(const source of sources){z.string().uuid().parse(source.record.id);const list=grouped.get(source.record.id)??[];list.push(source);grouped.set(source.record.id,list)}
    if(grouped.size>1000)throw new Error('同步范围超过 1000 个会话，请选择更少的目录')
    for(const [id,copies] of [...grouped].sort((a,b)=>a[0].localeCompare(b[0]))){
      const info:{source:SessionTransferSource;ordinal:number;activity:number;meta:string;index:Record<string,unknown>}[]=[];let eventCount=0
      for(const [ordinal,source] of copies.entries()){
        await verifySource(source);const {file,stat}=await openSessionFile(source.root,source.path),entry=indexes.get(source.root+'\0'+id)??{}
        let lineIndex=0,activity=0,meta:string|undefined,read=0
        try{
          db.exec('BEGIN')
          for await(const buffer of sessionLines(file,stat.size,signal,64*1024**2)){
            read+=buffer.length+1;progress(files,bytes+Math.min(read,stat.size));signal.throwIfAborted()
            const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).trim();lineIndex++;if(!text)continue
            let parsed:any,key:string
            try{const result=canonical(text);parsed=result.parsed;key=result.key}catch{key='raw:'+text}
            const timestamp=eventTime(parsed);activity=Math.max(activity,timestamp??0)
            if(parsed?.type==='session_meta'){meta??=text;continue}
            if(++eventCount>1_000_000)throw new Error('单个会话合并超过 100 万条事件，请先整理会话副本')
            insert.run(id,ordinal,lineIndex,timestamp??null,createHash('sha256').update(key).digest('hex'),text)
          }
          db.exec('COMMIT');await verifySource(source)
          if(!meta)throw new Error('会话缺少有效元数据，未准备同步')
          info.push({source,ordinal,activity:Math.max(indexTime(entry),activity)||source.mtime,meta,index:entry})
        }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}finally{await file.close()}
        bytes+=stat.size;progress(++files,bytes)
      }
      info.sort((a,b)=>b.activity-a.activity||b.source.size-a.source.size||b.source.mtime-a.source.mtime)
      for(const [index,item] of info.entries())rank.run(index,id,item.ordinal)
      const best=info[0],archived=best.source.record.locations[0].archived,folder=join(root,archived?'archived_sessions':'sessions');mkdirSync(folder,{recursive:true,mode:0o700})
      const path=join(folder,'rollout-'+id+'.jsonl'),output=await open(path,'wx',0o600),hash=createHash('sha256');let size=0
      try{
        const write=async(text:string)=>{signal.throwIfAborted();const bytes=Buffer.from(text+'\n');size+=bytes.length;if(size>100*1024**3)throw new Error('合并会话体积超过 100 GiB');hash.update(bytes);await output.writeFile(bytes)}
        if(copies.length===1){for await(const bytes of sourceBytes(best.source,signal,()=>{})){hash.update(bytes);await output.writeFile(bytes)}}
        else{
          await write(best.meta)
          for(const row of db.prepare('SELECT raw FROM (SELECT raw,time,rank,line,ROW_NUMBER() OVER(PARTITION BY key ORDER BY rank,line) AS ordinal FROM events WHERE thread=?) WHERE ordinal=1 ORDER BY time IS NULL,time,rank,line').iterate(id))await write((row as {raw:string}).raw)
        }
        const modified=Math.max(...info.map(item=>item.activity));await output.utimes(new Date(modified),new Date(modified));await output.sync()
      }finally{await output.close()}
      const stat=lstatSync(path),rootStat=lstatSync(root),record={...structuredClone(best.source.record),updatedAt:Math.max(...info.map(item=>item.activity))}
      results.push({source:{...best.source,path,root,rootDevice:rootStat.dev,rootInode:rootStat.ino,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,record},originals:copies,index:info.slice().reverse().reduce<Record<string,unknown>>((value,item)=>({...value,...item.index}),{}),sha256:hash.digest('hex')})
      db.prepare('DELETE FROM events WHERE thread=?').run(id)
    }
    return results
  }finally{db.close()}
}
