// Codex Auth addressing and temporary-item operations from Cockpit
// codex_account_projection.rs; only the caller's canonical home is addressed.
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
export const keychainAccount=(directory:string)=>`cli|${createHash('sha256').update(directory).digest('hex').slice(0,16)}`
export interface CodexKeyring {
  exists(directory:string,signal:AbortSignal):Promise<boolean>
  read(directory:string,signal:AbortSignal):Promise<string|null>
  remove(directory:string,signal:AbortSignal):Promise<void>
}
export type SecurityCommand=(args:string[],signal:AbortSignal,timeout:number,limit:number)=>Promise<{code:string|number;stdout:string}>
const command:SecurityCommand=(args,signal,timeout,maxBuffer)=>new Promise((resolve,reject)=>{
  if(process.platform!=='darwin'){reject(new Error('此平台的系统凭据库尚未接入'));return}
  execFile('/usr/bin/security',args,{encoding:'utf8',timeout,maxBuffer,signal,windowsHide:true},(error,stdout)=>{
    if(signal.aborted){reject(new Error('系统凭据操作已取消'));return}
    // Do not propagate security's stderr/command errors: they may contain data.
    resolve({code:error?(error as {code?:string|number}).code??'failed':0,stdout:typeof stdout==='string'?stdout:''})
  })
})
export class MacCodexKeyring implements CodexKeyring {
  constructor(private readonly execute:SecurityCommand=command){}
  private async run(directory:string,operation:'exists'|'read'|'remove',signal:AbortSignal):Promise<{code:string|number;stdout:string}>{
    signal.throwIfAborted()
    const args=[operation==='remove'?'delete-generic-password':'find-generic-password','-s','Codex Auth','-a',keychainAccount(directory),...(operation==='read'?['-w']:[])]
    let result:{code:string|number;stdout:string}
    try{result=await this.execute(args,signal,operation==='exists'?5000:20000,operation==='read'?2*1024*1024:64*1024)}
    catch{throw new Error(signal.aborted?'系统凭据操作已取消':'系统凭据操作失败，请检查系统凭据库权限后重试')}
    signal.throwIfAborted()
    if(result.code!==0&&result.code!==44)throw new Error('系统凭据操作失败或未获授权，请检查系统凭据库后重试')
    return result
  }
  async exists(directory:string,signal:AbortSignal):Promise<boolean>{return(await this.run(directory,'exists',signal)).code===0}
  async read(directory:string,signal:AbortSignal):Promise<string|null>{
    const result=await this.run(directory,'read',signal)
    if(Buffer.byteLength(result.stdout)>2*1024*1024)throw new Error('系统凭据超过大小限制')
    return result.code===44?null:result.stdout.trim()||null
  }
  async remove(directory:string,signal:AbortSignal):Promise<void>{await this.run(directory,'remove',signal)}
}
