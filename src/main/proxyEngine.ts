// Installer/preflight semantics adapted from Cockpit ee816002. Engine binaries
// are independent, pinned upstream downloads, never loaded from PATH.
import {mkdir,lstat,chmod,readdir,rename,rm,open} from 'node:fs/promises'
import {join,resolve,dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {Readable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import {z} from 'zod'
import pins from './mihomo-assets.json'
import {engineActive,type EngineStatus,type EngineErrorCode} from '../shared/proxyEngine'
import {EngineError,fail,safeEngineError,compressedLimit,extractedLimit,regularFile,fileChunks,hashFile,copyArchive,downloadEngine,extractEngine} from './proxyEngineFiles'

export interface EngineAsset {file:string;sha256:string;size:number}
interface EngineSpec {version:string;target:string;asset:EngineAsset;url:string}
export function pinnedEngine(platform=process.platform,arch=process.arch):EngineSpec|undefined{
  const cpu=arch==='arm64'?'aarch64':arch==='x64'?'x86_64':undefined
  const os=platform==='darwin'?'apple-darwin':platform==='win32'?'pc-windows-msvc':platform==='linux'?'unknown-linux-gnu':undefined
  if(!cpu||!os)return
  const target=`${cpu}-${os}`,asset=(pins.assets as Record<string,EngineAsset>)[target]
  return asset?{version:pins.version,target,asset,url:pins.assetBaseUrl+asset.file}:undefined
}
const recordSchema=z.object({directory:z.string().regex(/^release-[0-9a-f-]{36}$/).refine(v=>z.string().uuid().safeParse(v.slice(8)).success),version:z.string(),target:z.string(),archiveSha256:z.string().regex(/^[0-9a-f]{64}$/),files:z.record(z.string().regex(/^(?:mihomo(?:\.exe)?|(?:LICENSE|NOTICE)(?:[.-][A-Za-z0-9._-]{0,63})?)$/),z.string().regex(/^[0-9a-f]{64}$/))}).strict()
type Installed=z.infer<typeof recordSchema>
// App.requestSingleInstanceLock owns each production data directory. This guard
// also serializes services in one process; retired releases are kept until the
// runtime's process leases are migrated, so repairs cannot unlink running code.
const operations=new Set<string>()
async function privateDirectory(path:string){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail('ENGINE_INSTALL_IO');await chmod(path,0o700)}
async function smallJSON(path:string){const file=await regularFile(path,32768);try{return JSON.parse(await file.readFile('utf8'))}finally{await file.close()}}
async function writeAtomic(path:string,value:unknown){
  const temp=path+'.'+randomUUID()+'.tmp',file=await open(temp,'wx',0o600)
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();await file.close();await rename(temp,path)}finally{await file.close();await rm(temp,{force:true})}
}
async function clearAbandoned(root:string,signal:AbortSignal){
  for(const item of await readdir(root,{withFileTypes:true})){
    signal.throwIfAborted()
    if(!item.isDirectory()||!item.name.startsWith('staging-')||!z.string().uuid().safeParse(item.name.slice(8)).success)continue
    const directory=join(root,item.name)
    let owner
    try{owner=await smallJSON(join(directory,'owner.json'))}catch{continue}
    if(owner?.kind==='codex-manager-proxy-engine-install'&&owner.id===item.name.slice(8))await rm(directory,{recursive:true,force:true})
  }
}
export async function verifyEngineVersion(binary:string,version:string,signal:AbortSignal,timeout=3000):Promise<void>{
  signal.throwIfAborted()
  await new Promise<void>((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={PATH:process.platform==='win32'?'': '/usr/bin:/bin'}
    if(process.platform==='win32'&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot
    const child=spawn(binary,['-v'],{cwd:dirname(binary),env,stdio:['ignore','pipe','ignore'],windowsHide:true})
    let output='',failure:unknown
    const stop=(error:unknown)=>{failure??=error;child.kill('SIGKILL')}
    const aborted=()=>stop(signal.reason),timer=setTimeout(()=>stop(new EngineError('ENGINE_INSTALL_START_TIMEOUT')),timeout)
    signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted()
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length>65536)stop(new EngineError('ENGINE_INSTALL_START_FAILED'));else output+=chunk.toString('utf8')})
    child.once('error',()=>{failure??=new EngineError('ENGINE_INSTALL_START_FAILED')})
    child.once('close',code=>{
      clearTimeout(timer);signal.removeEventListener('abort',aborted)
      if(failure)reject(failure)
      else if(code!==0)reject(new EngineError('ENGINE_INSTALL_START_FAILED'))
      else if(!new RegExp('^Mihomo\\s+Meta\\s+v?'+version.replace(/\./g,'\\.')+'(?:\\s|$)').test(output.trim()))reject(new EngineError('ENGINE_INSTALL_VERSION'))
      else resolve()
    })
  })
}
// Dependencies can be supplied only by main-process tests, never by IPC or env.
interface EngineDependencies {spec?:EngineSpec;unsupported?:boolean;download?:typeof downloadEngine;verify?:typeof verifyEngineVersion;installTimeout?:number;preflightTimeout?:number}
export class ProxyEngine {
  readonly root:string
  private readonly spec:EngineSpec|undefined
  private state:EngineStatus
  private job?:{id:string;control:AbortController;task:Promise<void>;publishing:boolean}
  private statusRead?:Promise<EngineStatus>
  private check?:{control:AbortController;task:Promise<string>}
  private stopped=false
  constructor(directory:string,private readonly dependencies:EngineDependencies={}){
    this.root=resolve(directory,'proxy-engine');this.spec=dependencies.unsupported?undefined:dependencies.spec??pinnedEngine()
    this.state={supported:!!this.spec,version:this.spec?.version??pins.version,installedVersion:null,assetName:this.spec?.asset.file??null,archiveBytes:this.spec?.asset.size??null,jobId:null,phase:'idle',receivedBytes:0,totalBytes:null,error:null}
  }
  private async installed():Promise<Installed|undefined>{
    let stat
    try{stat=await lstat(this.root)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('ENGINE_INSTALL_VERIFY')
    let raw:unknown
    try{raw=await smallJSON(join(this.root,'active.json'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    const parsed=recordSchema.safeParse(raw);if(!parsed.success)fail('ENGINE_INSTALL_VERIFY')
    const value=parsed.data,spec=this.spec
    if(!spec||value.version!==spec.version||value.target!==spec.target||value.archiveSha256!==spec.asset.sha256)return
    const directory=join(this.root,value.directory),ds=await lstat(directory)
    if(!ds.isDirectory()||ds.isSymbolicLink()||!value.files[this.binaryName()])fail('ENGINE_INSTALL_VERIFY')
    const record=recordSchema.safeParse(await smallJSON(join(directory,'installed.json')))
    if(!record.success||JSON.stringify(record.data)!==JSON.stringify(value))fail('ENGINE_INSTALL_VERIFY')
    for(const name of Object.keys(value.files)){const file=await regularFile(join(directory,name),extractedLimit);await file.close()}
    return value
  }
  private binaryName(){return this.spec?.asset.file.endsWith('.zip')?'mihomo.exe':'mihomo'}
  status():Promise<EngineStatus>{
    if(this.statusRead)return this.statusRead
    const task=(async()=>{
      let installed:Installed|undefined,error:EngineErrorCode|null=null
      try{installed=await this.installed()}catch{error='ENGINE_INSTALL_VERIFY'}
      const result={...this.state,installedVersion:installed?.version??null}
      if(error&&!engineActive(result)){result.phase='failed';result.error=error}
      return result
    })();this.statusRead=task
    void task.finally(()=>{if(this.statusRead===task)this.statusRead=undefined});return task
  }
  begin(local?:string):EngineStatus{
    if(this.stopped)fail('PROXY_ENGINE_STOPPED')
    if(!this.spec)fail('ENGINE_INSTALL_UNSUPPORTED')
    if(this.job||this.check||operations.has(this.root))fail('ENGINE_INSTALL_BUSY')
    operations.add(this.root)
    const id=randomUUID(),control=new AbortController()
    this.state={...this.state,jobId:id,phase:local?'importing':'downloading',receivedBytes:0,totalBytes:this.spec.asset.size,error:null}
    const job={id,control,publishing:false,task:Promise.resolve()};this.job=job
    const timer=setTimeout(()=>{if(!job.publishing)control.abort(new EngineError('ENGINE_INSTALL_TIMEOUT'))},this.dependencies.installTimeout??300000)
    job.task=this.install(local,id,control.signal,()=>{control.signal.throwIfAborted();job.publishing=true;this.state.phase='installing'}).then(()=>{
      this.state.phase='completed';this.state.installedVersion=this.spec!.version
    },error=>{this.state.error=safeEngineError(control.signal.aborted?control.signal.reason:error);this.state.phase=this.state.error==='ENGINE_INSTALL_CANCELLED'?'cancelled':'failed'}).finally(()=>{clearTimeout(timer);operations.delete(this.root);if(this.job===job)this.job=undefined})
    return {...this.state}
  }
  cancel(id:string):void{z.string().uuid().parse(id);if(this.job?.id===id&&!this.job.publishing)this.job.control.abort(new EngineError('ENGINE_INSTALL_CANCELLED'))}
  async wait():Promise<EngineStatus>{await this.job?.task;return this.status()}
  async stop():Promise<void>{this.stopped=true;this.check?.control.abort(new EngineError('PROXY_ENGINE_STOPPED'));if(this.job&&!this.job.publishing)this.cancel(this.job.id);await Promise.allSettled([this.job?.task,this.check?.task])}
  preflight():Promise<string>{
    if(this.stopped)return Promise.reject(new EngineError('PROXY_ENGINE_STOPPED'))
    if(this.check)return this.check.task
    if(this.job||operations.has(this.root))return Promise.reject(new EngineError('ENGINE_INSTALL_BUSY'))
    const control=new AbortController(),timer=setTimeout(()=>control.abort(new EngineError('PROXY_ENGINE_TIMEOUT')),this.dependencies.preflightTimeout??15000)
    const task=(async()=>{
      const installed=await this.installed();control.signal.throwIfAborted();if(!installed)fail('PROXY_ENGINE_MISSING')
      const directory=join(this.root,installed.directory)
      for(const [name,hash] of Object.entries(installed.files))if(await hashFile(join(directory,name),extractedLimit,control.signal)!==hash)fail('ENGINE_INSTALL_VERIFY')
      const binary=join(directory,this.binaryName());await (this.dependencies.verify??verifyEngineVersion)(binary,this.spec!.version,control.signal)
      control.signal.throwIfAborted();if(this.job)fail('ENGINE_INSTALL_BUSY');return binary
    })().catch(error=>{throw new EngineError(safeEngineError(control.signal.aborted?control.signal.reason:error,'ENGINE_INSTALL_VERIFY'))}).finally(()=>{clearTimeout(timer);if(this.check?.task===task)this.check=undefined})
    this.check={control,task};return task
  }
  private async install(local:string|undefined,id:string,signal:AbortSignal,publish:()=>void):Promise<void>{
    const spec=this.spec!,stage=join(this.root,'staging-'+id),release=join(this.root,'release-'+id);let committed=false,created=false
    try{
      signal.throwIfAborted();await privateDirectory(this.root);await clearAbandoned(this.root,signal);await mkdir(stage,{mode:0o700});created=true
      await writeAtomic(join(stage,'owner.json'),{kind:'codex-manager-proxy-engine-install',id})
      const archive=join(stage,'download.archive'),output=join(stage,'engine');await mkdir(output,{mode:0o700})
      if(local){
        const source=await regularFile(local,compressedLimit)
        try{this.state.totalBytes=(await source.stat()).size;await copyArchive(Readable.from(fileChunks(source,compressedLimit,signal)),archive,signal,n=>{this.state.receivedBytes=n})}finally{await source.close()}
      }else{
        try{await copyArchive(await (this.dependencies.download??downloadEngine)(spec.url,signal),archive,signal,n=>{this.state.receivedBytes=n})}catch(error){if(signal.aborted)throw signal.reason;throw new EngineError(safeEngineError(error,'ENGINE_INSTALL_DOWNLOAD'))}
      }
      signal.throwIfAborted();this.state.phase='verifying'
      if(await hashFile(archive,compressedLimit,signal)!==spec.asset.sha256)fail('ENGINE_INSTALL_CHECKSUM')
      signal.throwIfAborted();this.state.phase='extracting'
      const files=await extractEngine(archive,output,spec.asset.file,signal)
      signal.throwIfAborted();this.state.phase='checking'
      await (this.dependencies.verify??verifyEngineVersion)(join(output,this.binaryName()),spec.version,signal,30000)
      const record:Installed={directory:'release-'+id,version:spec.version,target:spec.target,archiveSha256:spec.asset.sha256,files}
      await writeAtomic(join(output,'installed.json'),record)
      publish()
      for(let attempt=0;;attempt++)try{await rename(output,release);break}catch(error){if(attempt>=11||!['EACCES','EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await delay(Math.min(50*2**attempt,500))}
      await writeAtomic(join(this.root,'active.json'),record);committed=true
    }finally{if(created){await rm(stage,{recursive:true,force:true}).catch(()=>{});if(!committed)await rm(release,{recursive:true,force:true}).catch(()=>{})}}
  }
}
