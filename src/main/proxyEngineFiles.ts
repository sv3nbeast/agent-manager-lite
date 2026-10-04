// Adapted from Cockpit codex_proxy_engine_{archive,install}.rs at ee816002.
import {constants,type Stats} from 'node:fs'
import {open,lstat,chmod,type FileHandle} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {get} from 'node:https'
import {Readable,Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {createGunzip} from 'node:zlib'
import * as yauzl from 'yauzl'
import type {EngineErrorCode} from '../shared/proxyEngine'

export const compressedLimit=128*1024**2,extractedLimit=512*1024**2
export class EngineError extends Error {constructor(readonly code:EngineErrorCode){super(code)}}
export function fail(code:EngineErrorCode):never{throw new EngineError(code)}
export function safeEngineError(error:unknown,fallback:EngineErrorCode='ENGINE_INSTALL_IO'):EngineErrorCode{return error instanceof EngineError?error.code:fallback}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
export async function regularFile(path:string,limit:number):Promise<FileHandle>{
  const before=await lstat(path)
  if(!before.isFile()||before.nlink!==1)fail('ENGINE_INSTALL_ARCHIVE')
  if(before.size>limit)fail('ENGINE_INSTALL_TOO_LARGE')
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{const current=await file.stat();if(!current.isFile()||!same(current,before))fail('ENGINE_INSTALL_VERIFY');return file}catch(error){await file.close();throw error}
}
export async function* fileChunks(file:FileHandle,limit:number,signal:AbortSignal):AsyncGenerator<Buffer>{
  const before=await file.stat();let offset=0
  while(true){signal.throwIfAborted();const buffer=Buffer.alloc(65536),{bytesRead}=await file.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;if(offset>limit)fail('ENGINE_INSTALL_TOO_LARGE');yield buffer.subarray(0,bytesRead)}
  if(!same(before,await file.stat()))fail('ENGINE_INSTALL_VERIFY')
}
export async function hashFile(path:string,limit:number,signal:AbortSignal):Promise<string>{
  const file=await regularFile(path,limit),hash=createHash('sha256')
  try{for await(const chunk of fileChunks(file,limit,signal))hash.update(chunk);return hash.digest('hex')}finally{await file.close()}
}
export function approvedEngineURL(value:string):boolean{
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)}catch{return false}
}
// Node HTTPS deliberately receives neither account headers nor process proxy settings.
export async function downloadEngine(url:string,signal:AbortSignal,redirects=0):Promise<Readable>{
  if(!approvedEngineURL(url)||redirects>5)fail('ENGINE_INSTALL_DOWNLOAD')
  signal.throwIfAborted()
  const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
    const request=get(url,{signal,agent:false,headers:{'User-Agent':'Codex-Manager-Lite','Accept':'application/octet-stream'}},resolve)
    const connect=setTimeout(()=>request.destroy(new EngineError('ENGINE_INSTALL_TIMEOUT')),10000)
    request.once('socket',socket=>{socket.once('secureConnect',()=>clearTimeout(connect))})
    request.once('close',()=>clearTimeout(connect));request.once('error',reject)
    request.setTimeout(20000,()=>request.destroy(new EngineError('ENGINE_INSTALL_TIMEOUT')))
  })
  if([301,302,303,307,308].includes(response.statusCode??0)){
    const location=response.headers.location;response.destroy()
    if(!location)fail('ENGINE_INSTALL_DOWNLOAD')
    return downloadEngine(new URL(location,url).toString(),signal,redirects+1)
  }
  if(response.statusCode!==200){response.destroy();fail('ENGINE_INSTALL_DOWNLOAD')}
  if(Number(response.headers['content-length'])>compressedLimit){response.destroy();fail('ENGINE_INSTALL_TOO_LARGE')}
  return response
}
export async function copyArchive(source:Readable,target:string,signal:AbortSignal,progress:(bytes:number)=>void):Promise<void>{
  let file:FileHandle|undefined,bytes=0
  try{
    file=await open(target,'wx',0o600)
    const sink=new Writable({write(chunk,_encoding,done){bytes+=chunk.length;if(bytes>compressedLimit){done(new EngineError('ENGINE_INSTALL_TOO_LARGE'));return}file!.writeFile(chunk).then(()=>{progress(bytes);done()},done)}})
    await pipeline(source,sink,{signal});signal.throwIfAborted();await file.sync()
  }finally{source.destroy();await file?.close()}
}
function safeEntry(name:string):boolean{
  return name.length>0&&name.length<4096&&!/[\\:\x00-\x1f\x7f]/.test(name)&&name.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
}
const allowedName=(name:string)=>/^(?:LICENSE|NOTICE)(?:[.-][A-Za-z0-9._-]{0,63})?$/.test(name)
export async function extractEngine(path:string,output:string,asset:string,signal:AbortSignal,limit=extractedLimit):Promise<Record<string,string>>{
  const file=await regularFile(path,compressedLimit),files:Record<string,string>={};let total=0
  async function consume(input:Readable,name?:string,expected?:number){
    const hash=createHash('sha256');let written=0,dest:FileHandle|undefined
    try{
      if(name){if(Object.keys(files).some(other=>other.toLowerCase()===name.toLowerCase()))fail('ENGINE_INSTALL_ARCHIVE');dest=await open(join(output,name),'wx',0o600)}
      const sink=new Writable({write(chunk,_encoding,done){written+=chunk.length;total+=chunk.length;if(total>limit||expected!==undefined&&written>expected){done(new EngineError('ENGINE_INSTALL_TOO_LARGE'));return}hash.update(chunk);if(dest)dest.writeFile(chunk).then(()=>done(),done);else done()}})
      await pipeline(input,sink,{signal});signal.throwIfAborted()
      if(expected!==undefined&&written!==expected)fail('ENGINE_INSTALL_ARCHIVE')
      if(dest){await dest.sync();files[name!]=hash.digest('hex')}
    }finally{input.destroy();await dest?.close()}
  }
  try{
    if(asset.endsWith('.zip')){
      const zip=await yauzl.fromFdPromise(file.fd,{autoClose:false,strictFileNames:true,validateEntrySizes:true})
      // The FileHandle owns the descriptor. Do not zip.close() it a second time.
      zip.on('error',()=>{})
      const names=new Set<string>(),upstream=asset.replace(/-v[^/-]+\.zip$/,'.exe')
      if(zip.entryCount>128)fail('ENGINE_INSTALL_TOO_LARGE')
      for await(const entry of zip.eachEntry()){
        signal.throwIfAborted();const directory=entry.fileName.endsWith('/'),name=directory?entry.fileName.slice(0,-1):entry.fileName,kind=(entry.externalFileAttributes>>>16)&0o170000
        if(!safeEntry(name)||names.has(name.toLowerCase())||entry.isEncrypted()||![0,8].includes(entry.compressionMethod)||kind!==0&&kind!==(directory?0o040000:0o100000))fail('ENGINE_INSTALL_ARCHIVE')
        names.add(name.toLowerCase())
        if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize>limit-total)fail('ENGINE_INSTALL_TOO_LARGE')
        if(directory){if(entry.uncompressedSize!==0)fail('ENGINE_INSTALL_ARCHIVE');continue}
        const base=name.split('/').at(-1)!,renamed=base===upstream?'mihomo.exe':base
        await consume(await zip.openReadStreamPromise(entry),renamed==='mihomo.exe'||allowedName(renamed)?renamed:undefined,entry.uncompressedSize)
      }
    }else if(asset.endsWith('.gz')&&!asset.endsWith('.tar.gz')){
      const gunzip=createGunzip(),source=Readable.from(fileChunks(file,compressedLimit,signal))
      const inflating=pipeline(source,gunzip,{signal});void inflating.catch(()=>{})
      try{await consume(gunzip,'mihomo');await inflating}finally{source.destroy();gunzip.destroy();await inflating.catch(()=>{})}
    }else fail('ENGINE_INSTALL_ARCHIVE')
    const binary=asset.endsWith('.zip')?'mihomo.exe':'mihomo'
    if(!files[binary])fail('ENGINE_INSTALL_ARCHIVE')
    await chmod(join(output,binary),0o700);signal.throwIfAborted();return files
  }catch(error){if(signal.aborted)throw signal.reason;throw new EngineError(safeEngineError(error,'ENGINE_INSTALL_ARCHIVE'))}finally{await file.close()}
}
