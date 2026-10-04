import {createHash,randomUUID} from 'node:crypto'
import {join,basename} from 'node:path'
import {realpathSync} from 'node:fs'
import {z} from 'zod'
import type {Store,State} from './store'
import {directory} from './clientConfig'
import {backupRequestSchema,type BackupPreview,type BackupResult,type BackupRestoreResult} from '../shared/dataBackup'
import {backupCipher,backupDestination,readBackupArchive,writeBackupArchive,type BackupCipher} from './dataBackupArchive'
import {backupCounts,effectiveKeyUsage,exportBackupState,validateBackup,type DataBackupBundle} from './dataBackupState'

const fingerprint=(state:State)=>createHash('sha256').update(JSON.stringify(state)).digest('hex')
interface Pending {ticket:string;bundle:DataBackupBundle;cipher:BackupCipher;fingerprint:string;expires:number}
export class DataBackups {
  private pending?:Pending
  private timer?:NodeJS.Timeout
  private operation?:{id:string;controller:AbortController;task:Promise<unknown>}
  private cancelled=new Map<string,number>()
  private stopped=false
  applying=false
  restartRequired=false
  constructor(private readonly store:Store,private readonly rawUsage:(ids:string[])=>Record<string,number>,private readonly assertReady:()=>void=()=>{},private readonly now=Date.now){}
  private snapshot():DataBackupBundle{
    const state=this.store.read(),ids=state.localAccess?.keys.map(k=>k.id)??[]
    return exportBackupState(state,effectiveKeyUsage(state,this.rawUsage(ids)),this.now())
  }
  private clear():void{this.pending?.cipher.key.fill(0);this.pending=undefined;clearTimeout(this.timer)}
  discard(ticket?:string):void{
    if(ticket!==undefined&&z.string().uuid().parse(ticket)!==this.pending?.ticket)return
    if(this.applying)throw new Error('恢复正在进行，请先取消操作')
    // Closing a dialog must also invalidate an in-flight preview, otherwise it
    // could publish a fresh ticket after the user has already dismissed it.
    this.operation?.controller.abort();this.clear()
  }
  private run<T>(id:string,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    z.string().uuid().parse(id)
    if(this.stopped||this.restartRequired)throw new Error('应用正在重启或退出')
    if(this.operation)throw new Error('已有备份操作正在进行')
    for(const [key,at] of this.cancelled)if(this.now()-at>300000)this.cancelled.delete(key)
    if(this.cancelled.delete(id))throw new Error('备份操作已取消')
    const operation={id,controller:new AbortController(),task:Promise.resolve() as Promise<unknown>}
    this.operation=operation
    const task=Promise.resolve().then(()=>action(operation.controller.signal)).finally(()=>{if(this.operation===operation)this.operation=undefined})
    operation.task=task;return task
  }
  export(raw:unknown,path:string):Promise<BackupResult>{
    const input=backupRequestSchema.parse(raw)
    return this.run(input.requestId,async signal=>{
      const destination=await backupDestination(this.store.directory,path)
      const payload=this.snapshot(),cipher=await backupCipher(input.password)
      try{await writeBackupArchive(destination,payload,cipher,signal);return {path:destination,counts:backupCounts(payload.state)}}
      finally{cipher.key.fill(0)}
    })
  }
  preview(raw:unknown,path:string):Promise<BackupPreview>{
    const input=backupRequestSchema.parse(raw)
    return this.run(input.requestId,async signal=>{
      this.clear()
      const read=await readBackupArchive(path,input.password,signal)
      try{
        signal.throwIfAborted()
        const bundle=validateBackup(read.payload),ticket=randomUUID(),current=this.store.read()
        this.pending={ticket,bundle,cipher:read.cipher,fingerprint:fingerprint(current),expires:this.now()+300000}
        this.timer=setTimeout(()=>this.clear(),300000);this.timer.unref()
        return {ticket,fileName:basename(path),exportedAt:bundle.exportedAt,incoming:backupCounts(bundle.state),current:backupCounts(current),sourceConnections:bundle.sourceConnections,sourceDirectories:bundle.sourceDirectories}
      }catch(error){read.cipher.key.fill(0);throw error}
    })
  }
  apply(raw:unknown):Promise<BackupRestoreResult>{
    const input=z.object({ticket:z.string().uuid(),requestId:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(raw)
    return this.run(input.requestId,async signal=>{
      const pending=this.pending
      if(!pending||pending.ticket!==input.ticket||pending.expires<=this.now())throw new Error('备份预览已过期，请重新选择文件')
      clearTimeout(this.timer)
      this.applying=true
      try{
        const ready=()=>{
          this.assertReady()
          const state=this.store.read()
          if(state.clientAuthorities?.length||state.clientSwitches?.length)throw new Error('请先解除客户端凭据关联，并恢复原生账号切换后再还原备份')
          if(fingerprint(state)!==pending.fingerprint)throw new Error('当前数据已变化，请重新预览备份')
          signal.throwIfAborted()
        }
        ready()
        const current=this.snapshot(),ids=pending.bundle.state.localAccess?.keys.map(k=>k.id)??[],rawUsage=this.rawUsage(ids)
        const existingUsage=effectiveKeyUsage(this.store.read(),rawUsage),restored=structuredClone(pending.bundle.state)
        for(const key of restored.localAccess?.keys??[]){
          const total=Math.max(pending.bundle.localKeyUsage[key.id]??0,existingUsage[key.id]??0)
          key.restoredUsageOffset=Math.max(0,total-(rawUsage[key.id]??0))
        }
        for(const account of restored.accounts)account.generation=randomUUID()
        const root=join(realpathSync(this.store.directory),'data-backups');directory(root,true)
        const rollbackPath=join(root,`before-restore-${this.now()}-${randomUUID()}.cmlbackup`)
        await writeBackupArchive(rollbackPath,current,pending.cipher,signal)
        ready()
        // Only materialize the manager-owned empty layout. No source client
        // files are copied, and existing destination files remain untouched.
        // Without this, Instances.recover() treats portable definitions with
        // no local folder as broken recovery records on the next startup.
        if(restored.instances?.length){
          const root=join(realpathSync(this.store.directory),'instances');directory(root,true)
          for(const instance of restored.instances){
            const folder=join(root,instance.id);directory(folder,true)
            for(const name of ['home','desktop','workspace'])directory(join(folder,name),true)
          }
        }
        this.store.transaction(state=>{
          // Local file registrations/recovery ownership are not portable. Keep
          // the destination's registrations; no external files are read/written.
          const local={configTargets:state.configTargets,clientAuthorities:state.clientAuthorities,clientSwitches:state.clientSwitches}
          for(const key of Object.keys(state))delete (state as unknown as Record<string,unknown>)[key]
          Object.assign(state,restored,local)
        })
        this.restartRequired=true
        return {rollbackPath,counts:backupCounts(restored),restartRequired:true}
      }finally{this.applying=false;this.clear()}
    })
  }
  cancel(id:string):void{
    z.string().uuid().parse(id)
    if(this.operation?.id===id)this.operation.controller.abort()
    else {if(this.cancelled.size>=64)this.cancelled.delete(this.cancelled.keys().next().value!);this.cancelled.set(id,this.now())}
  }
  async stop():Promise<void>{this.stopped=true;this.operation?.controller.abort();await this.operation?.task.catch(()=>{});this.clear()}
}
