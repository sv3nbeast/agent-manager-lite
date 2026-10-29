import type {FileHandle} from 'node:fs/promises'
import {Readable,type Transform} from 'node:stream'
import {finished} from 'node:stream/promises'
import * as zlib from 'node:zlib'

/** Paginated Codex history stores physical byte offsets in SQLite and in
 * descendant history_base records. Even a provider-only header edit changes
 * that contract. Presence of ordinal/history_base is also protected when a
 * newer client omits or changes its history_mode label. */
export function hasIndexedRolloutBytes(event:Record<string,unknown>):boolean {
  const payload=event.payload&&typeof event.payload==='object'&&!Array.isArray(event.payload)
    ?event.payload as Record<string,unknown>:event
  return payload.history_mode==='paginated'||Object.hasOwn(payload,'history_base')||Object.hasOwn(event,'ordinal')
}

export const isRolloutFile=(name:string):boolean=>/\.jsonl(?:\.zst)?$/i.test(name)

/** Read just the bounded metadata line; compressed ancestors must stay
 * compressed on disk and must not be mistaken for disposable caches. */
export async function readRolloutHeader(file:FileHandle,size:number,compressed:boolean,signal:AbortSignal):Promise<{event:Record<string,any>;bytes:Buffer}>{
  signal.throwIfAborted()
  if(!size)throw new Error('会话缺少元数据')
  const factory=(zlib as typeof zlib&{createZstdDecompress?:()=>Transform}).createZstdDecompress
  if(compressed&&!factory)throw new Error('当前运行环境不支持压缩会话读取')
  // FileHandle.createReadStream closes the caller's handle on an early break,
  // even with autoClose:false. Own the stream, never the caller's descriptor.
  const input=Readable.from((async function*(){
    for(let position=0;position<size;){
      signal.throwIfAborted()
      const buffer=Buffer.alloc(Math.min(64*1024,size-position))
      const {bytesRead}=await file.read(buffer,0,buffer.length,position)
      if(!bytesRead)throw new Error('会话文件在读取期间缩短')
      position+=bytesRead;yield buffer.subarray(0,bytesRead)
    }
  })())
  const decoder=compressed?factory!():undefined,stream=decoder??input
  const cancelled=()=>stream.destroy(new Error('会话读取已取消'))
  const failed=(error:Error)=>decoder?.destroy(error)
  input.on('error',failed);if(decoder)input.pipe(decoder)
  signal.addEventListener('abort',cancelled,{once:true})
  if(signal.aborted)cancelled()
  let prefix=Buffer.alloc(0)
  const parse=(bytes:Buffer)=>{
    let event:any
    try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''))}catch{throw new Error('会话首行不是有效的 JSON 元数据')}
    const payload=event?.payload??event
    if(event?.type!=='session_meta'||typeof (payload?.id??payload?.session_id)!=='string')throw new Error('会话首行缺少可验证的 session_meta')
    return {event,bytes}
  }
  try{
    for await(const chunk of stream){
      signal.throwIfAborted()
      const b=Buffer.from(chunk),at=b.indexOf(10),part=at<0?b:b.subarray(0,at+1)
      if(prefix.length+part.length>4*1024*1024)throw new Error('会话元数据超过 4 MiB 读取上限')
      prefix=Buffer.concat([prefix,part])
      if(at>=0)return parse(prefix)
    }
    return parse(prefix)
  }finally{
    signal.removeEventListener('abort',cancelled);input.unpipe();input.destroy();decoder?.destroy()
    await Promise.allSettled([finished(input),...decoder?[finished(decoder)]:[]])
  }
}
