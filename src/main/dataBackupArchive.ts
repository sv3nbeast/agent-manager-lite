// Portable encrypted configuration archives. No system keychain dependency:
// importing on another installation re-encrypts credentials with its own vault.
import {createCipheriv,createDecipheriv,randomBytes,scrypt} from 'node:crypto'
import {open,rename,rm,realpath} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {createReadStream} from 'node:fs'
import {Readable,Transform,Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {createGzip,createGunzip} from 'node:zlib'
import {randomUUID} from 'node:crypto'
import {backupPasswordSchema} from '../shared/dataBackup'

const magic=Buffer.from('CMLBACKUP\x01')
const headerLength=magic.length+16+12
export const MAX_DATA_BACKUP_BYTES=64*1024*1024
const maxBytes=MAX_DATA_BACKUP_BYTES
export interface BackupCipher {key:Buffer;salt:Buffer}

export async function backupCipher(password:string,salt=randomBytes(16)):Promise<BackupCipher>{
  backupPasswordSchema.parse(password)
  const key=await new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)))
  return {key,salt}
}

function bound(limit:number):Transform{
  let bytes=0
  return new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;done(bytes>limit?new Error('备份超过 64 MiB 上限'):null,chunk)}})
}

export async function backupDestination(directory:string,path:string):Promise<string>{
  const destination=join(await realpath(dirname(resolve(path))),basename(path))
  const location=relative(await realpath(directory),destination)
  if(!location||location!=='..'&&!location.startsWith(`..${sep}`)&&!isAbsolute(location))throw new Error('请将备份保存在应用数据目录以外')
  return destination
}

export async function writeBackupArchive(path:string,payload:unknown,cipher:BackupCipher,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted()
  const plain=Buffer.from(JSON.stringify(payload))
  if(plain.length>maxBytes){plain.fill(0);throw new Error('备份超过 64 MiB 上限')}
  const nonce=randomBytes(12),header=Buffer.concat([magic,cipher.salt,nonce])
  const encrypted=createCipheriv('aes-256-gcm',cipher.key,nonce)
  encrypted.setAAD(header)
  const temporary=`${path}.${randomUUID()}.tmp`
  let file:Awaited<ReturnType<typeof open>>|undefined
  try{
    file=await open(temporary,'wx',0o600)
    await file.writeFile(header)
    await pipeline(Readable.from([plain]),createGzip(),encrypted,bound(maxBytes),new Writable({write(chunk:Buffer,_encoding,done){file!.writeFile(chunk).then(()=>done(),done)}}),{signal})
    await file.writeFile(encrypted.getAuthTag())
    signal.throwIfAborted();await file.sync();await file.close()
    signal.throwIfAborted();await rename(temporary,path)
  }finally{plain.fill(0);await file?.close();await rm(temporary,{force:true})}
}

export async function readBackupArchive(path:string,password:string,signal:AbortSignal):Promise<{payload:unknown;cipher:BackupCipher}>{
  signal.throwIfAborted()
  const file=await open(path,'r')
  let cipher:BackupCipher|undefined
  const chunks:Buffer[]=[]
  try{
    const before=await file.stat()
    if(!before.isFile()||before.size<headerLength+16||before.size>maxBytes+headerLength+16)throw new Error('备份文件格式或大小无效')
    const header=Buffer.alloc(headerLength),tag=Buffer.alloc(16)
    await file.read({buffer:header,position:0});await file.read({buffer:tag,position:before.size-16})
    if(!header.subarray(0,magic.length).equals(magic))throw new Error('不是受支持的 Agent Manager Lite 备份')
    cipher=await backupCipher(password,header.subarray(magic.length,magic.length+16))
    signal.throwIfAborted()
    const decrypted=createDecipheriv('aes-256-gcm',cipher.key,header.subarray(magic.length+16))
    decrypted.setAAD(header);decrypted.setAuthTag(tag)
    try{
      await pipeline(createReadStream(path,{fd:file.fd,autoClose:false,start:headerLength,end:before.size-17}),decrypted,createGunzip(),bound(maxBytes),new Writable({write(chunk:Buffer,_encoding,done){chunks.push(Buffer.from(chunk));done()}}),{signal})
    }catch(error){if(signal.aborted)signal.throwIfAborted();throw new Error('备份密码不正确、文件损坏或内容超过上限')}
    const after=await file.stat()
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('备份文件在读取期间发生变化')
    const plain=Buffer.concat(chunks)
    try{return {payload:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)),cipher}}
    catch{throw new Error('备份内容不是有效的 JSON 数据')}
    finally{plain.fill(0)}
  }catch(error){cipher?.key.fill(0);throw error}
  finally{for(const chunk of chunks)chunk.fill(0);await file.close()}
}
