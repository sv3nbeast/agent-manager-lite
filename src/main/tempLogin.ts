// Official temporary desktop login adapted from Cockpit codex_temp_login.rs.
import {randomUUID,createHash} from 'node:crypto'
import {existsSync,lstatSync,realpathSync,readdirSync,rmSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {join,isAbsolute} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {z} from 'zod'
import {Store,type StoredAccount} from './store'
import {directory,atomic,readBounded} from './clientConfig'
import {accountFromAuth} from './clientIdentity'
import {MacCodexKeyring,type CodexKeyring} from './codexKeyring'
import {sameAccount} from './accounts'
import {sameNativeAccount} from './accountIdentity'
import {TomlDocument} from './tomlPatch'
import {MacDesktopRuntime,type DesktopRuntime,type DesktopPlan} from './instanceRuntime'
import {TEMP_LOGIN_HOOK,isOfficialLoginURL} from './tempLoginHook'
import {startTempLoginSchema,tempCredentialStoreSchema,type TempCredentialStore,type TempLoginView,type TempLoginCleanup} from '../shared/tempLogin'
import type {InstanceApplication} from '../shared/instances'

const config=(mode:TempCredentialStore)=>`cli_auth_credentials_store = "${mode}"\nforced_login_method = "chatgpt"\n`
const identitySchema=z.object({device:z.number().int(),inode:z.number().int()}).strict()
const markerSchema=z.object({version:z.literal(1),id:z.string().uuid(),nonce:z.string().uuid(),application:z.string().min(1),executable:z.string().min(1),
  createdAt:z.number().finite(),folder:identitySchema,home:identitySchema,desktop:identitySchema,workspace:identitySchema,credentialStore:tempCredentialStoreSchema.optional()}).strict()
type Marker=z.infer<typeof markerSchema>
type Running={marker:Marker;plan:DesktopPlan;controller:AbortController;task?:Promise<void>;captureOffset:number;fallback:boolean}
const identity=(path:string)=>{directory(path);const stat=lstatSync(path);return {device:stat.dev,inode:stat.ino}}
const hasEntry=(path:string)=>lstatSync(path,{throwIfNoEntry:false})!==undefined
const same=(path:string,expected:z.infer<typeof identitySchema>)=>{const stat=identity(path);if(stat.device!==expected.device||stat.inode!==expected.inode)throw new Error('临时登录目录已被替换，保留文件等待处理')}
const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex')
const terminal=new Set(['idle','completed','failed','cancelled'])

// Official temporary login relies on the Codex desktop profile/auth protocol.
// The general instance picker can also register other desktop applications.
export function supportsOfficialTempLogin(application:Pick<InstanceApplication,'path'|'kind'>):boolean {
  try {
    if(application.kind==='cli'||!application.path.endsWith('.app')||!isAbsolute(application.path)||realpathSync(application.path)!==application.path)return false
    const app=lstatSync(application.path),executable=join(application.path,'Contents','MacOS','Codex'),stat=lstatSync(executable)
    return app.isDirectory()&&!app.isSymbolicLink()&&stat.isFile()&&!stat.isSymbolicLink()&&Boolean(stat.mode&0o111)&&realpathSync(executable)===executable
  }catch{return false}
}

export class OfficialTempLogin {
  private readonly root:string
  private readonly rootIdentity:z.infer<typeof identitySchema>
  private active?:Running
  private view:TempLoginView={phase:'idle',running:false}
  private cleanupView:TempLoginCleanup={removed:[],failed:[]}
  private cleaning?:Promise<TempLoginCleanup>
  private stopped=false
  private startupTimer?:NodeJS.Timeout
  private sweepTimer?:NodeJS.Timeout
  constructor(private readonly store:Store,private readonly applications:()=>InstanceApplication[],
    private readonly runtime:DesktopRuntime=new MacDesktopRuntime(),
    private readonly inUse:(id:string)=>boolean=()=>false,private readonly imported:()=>void=()=>{},
    private readonly options:{pollMs?:number;timeoutMs?:number;armTimeoutMs?:number}={},private readonly keyring:CodexKeyring=new MacCodexKeyring()){
    this.root=realpathSync(store.directory);this.rootIdentity=identity(this.root)
  }
  current():TempLoginView{return structuredClone(this.view)}
  cleanupStatus():TempLoginCleanup{return structuredClone(this.cleanupView)}
  private layout(create=false):string {
    same(this.root,this.rootIdentity)
    const root=join(this.root,'temp-login');if(!hasEntry(root)&&!create)return root
    directory(root,create);for(const name of ['sessions','markers'])directory(join(root,name),create)
    return root
  }
  private folder(id:string):string{return join(this.layout(),'sessions',id)}
  private markerFile(id:string):string{return join(this.layout(),'markers',`${id}.json`)}
  private plan(marker:Marker):DesktopPlan {
    const folder=this.folder(marker.id)
    return {application:marker.application,executable:marker.executable,nonce:marker.nonce,args:[],directory:join(folder,'home'),desktopDirectory:join(folder,'desktop'),workingDirectory:join(folder,'workspace')}
  }
  private guard(marker:Marker,cleanup=false):void {
    const folder=this.folder(marker.id)
    if(!hasEntry(folder)&&cleanup)return
    same(folder,marker.folder)
    for(const [name,key] of [['home','home'],['desktop','desktop'],['workspace','workspace']] as const){const path=join(folder,name);if(!cleanup||hasEntry(path))same(path,marker[key])}
  }
  start(raw:unknown):TempLoginView {
    const input=startTempLoginSchema.parse(raw)
    if(this.stopped)throw new Error('应用正在退出')
    if(this.active||this.cleaning)throw new Error('官方登录或清理正在进行，请稍后重试')
    const application=this.applications().find(value=>value.id===input.applicationId&&value.kind!=='cli')
    if(!application||!supportsOfficialTempLogin(application))throw new Error('所选应用不支持官方临时登录，请选择 Codex 桌面应用')
    const executable=join(application.path,'Contents','MacOS','Codex')
    this.layout(true)
    const id=randomUUID(),folder=this.folder(id);directory(folder,true)
    for(const name of ['home','desktop','workspace'])directory(join(folder,name),true)
    const marker:Marker={version:1,id,nonce:randomUUID(),application:application.path,executable,createdAt:Date.now(),folder:identity(folder),home:identity(join(folder,'home')),desktop:identity(join(folder,'desktop')),workspace:identity(join(folder,'workspace')),credentialStore:input.credentialStore}
    // Journal exists before launch. Cleanup never infers ownership from names.
    atomic(this.markerFile(id),JSON.stringify(marker))
    const plan=this.plan(marker),run:Running={marker,plan,controller:new AbortController(),captureOffset:0,fallback:false}
    this.view={id,phase:'preparing',running:true,application:application.name,expiresAt:Date.now()+(this.options.timeoutMs??600000),authStatus:input.interceptAuthUrl?'waiting':'disabled',credentialStore:input.credentialStore}
    this.active=run
    run.task=this.run(run,input.interceptAuthUrl)
    return this.current()
  }
  private parseAuth(raw:string|null,run:Running):StoredAccount|undefined {
    if(raw===null)return
    if(Buffer.byteLength(raw)>2*1024*1024)throw new Error('登录凭据超过大小限制')
    let value:StoredAccount
    try{value=accountFromAuth(raw,new TomlDocument(config(run.marker.credentialStore??'file')))}catch{return}
    if(value.kind==='api_key'||value.kind==='oauth'&&!value.credentials.accessToken)return
    return value
  }
  private fileAuth(run:Running):StoredAccount|undefined {
    this.guard(run.marker)
    return this.parseAuth(readBounded(join(run.plan.directory,'auth.json'),2*1024*1024),run)
  }
  private async candidate(run:Running):Promise<{source:'file'|'keyring';account?:StoredAccount}|undefined>{
    this.guard(run.marker)
    const mode=run.marker.credentialStore??'file'
    if(mode!=='file'){
      const present=await this.keyring.exists(run.plan.directory,run.controller.signal)
      this.guard(run.marker);run.controller.signal.throwIfAborted()
      if(present)return {source:'keyring'}
      if(mode==='keyring')return
    }
    const account=this.fileAuth(run);return account?{source:'file',account}:undefined
  }
  private async finalAuth(run:Running):Promise<StoredAccount|undefined>{
    this.guard(run.marker)
    const mode=run.marker.credentialStore??'file'
    if(mode!=='file'){
      // This is the only secret read in a keyring login. Polls use metadata;
      // rejection fails the operation instead of repeatedly prompting the user.
      const raw=await this.keyring.read(run.plan.directory,run.controller.signal)
      this.guard(run.marker);run.controller.signal.throwIfAborted()
      if(raw!==null){this.view.credentialSource='keyring';return this.parseAuth(raw,run)}
      if(mode==='keyring')return
    }
    this.view.credentialSource='file';return this.fileAuth(run)
  }
  private capture(run:Running):void {
    this.guard(run.marker)
    const raw=readBounded(join(run.plan.directory,'auth-capture.jsonl'),1024*1024)
    if(raw===null)return
    if(raw.length<run.captureOffset)run.captureOffset=0
    const end=raw.lastIndexOf('\n')+1
    for(const line of raw.slice(run.captureOffset,end).split('\n'))try{
      const value=JSON.parse(line)
      if(value.kind==='armed'&&this.view.authStatus!=='captured')this.view.authStatus='armed'
      if(value.kind==='error')this.unavailable()
      if(value.kind==='url'&&typeof value.url==='string'&&isOfficialLoginURL(value.url)){this.view.authStatus='captured';this.view.authUrl=value.url}
    }catch{/* A partially written or unknown record is not an authorization URL. */}
    run.captureOffset=end
  }
  private unavailable():void {
    this.view.authStatus='unavailable';this.view.notice='无法展示授权链接，请在临时客户端中按官方流程打开浏览器。'
  }
  private async launch(run:Running):Promise<void> {
    this.guard(run.marker);run.controller.signal.throwIfAborted();this.view.phase='launching'
    const child=await this.runtime.launch(run.plan,run.controller.signal)
    this.guard(run.marker);this.view.pid=child.pid;this.view.phase='waiting-login'
  }
  private async fallback(run:Running):Promise<void> {
    // Close/verify the owned attempt before a single retry without the hook.
    await this.runtime.stop(run.plan)
    if(await this.runtime.find(run.plan))throw new Error('临时客户端仍在运行，请重试清理')
    this.guard(run.marker);run.controller.signal.throwIfAborted()
    run.fallback=true;delete run.plan.tempLoginHook;delete this.view.authUrl;this.unavailable()
    await this.launch(run)
  }
  private save(account:StoredAccount):void {
    let result=account,updated=false
    this.store.transaction(state=>{
      const matches=state.accounts.filter(value=>sameAccount(value,account)||sameNativeAccount(value,account))
      if(matches.length>1)throw new Error('存在多个相同身份账号，请整理后重新登录')
      const existing=matches[0]
      if(existing){
        if(this.inUse(existing.id)||state.clientAuthorities?.some(value=>value.accountId===existing.id)||state.clientSwitches?.some(value=>value.accountId===existing.id))throw new Error('该账号正在使用或维护登录，请结束关联后重新登录')
        existing.credentials={...account.credentials,localAPIKey:existing.credentials.localAPIKey};existing.email=account.email??existing.email;existing.plan=account.plan??existing.plan
        existing.revision=(existing.revision??0)+1;delete existing.error;delete existing.errorAt
        result=existing;updated=true
      }else state.accounts.push(account)
    })
    this.view.accountId=result.id;this.view.email=result.email;this.view.updated=updated
  }
  private async run(run:Running,intercept:boolean):Promise<void> {
    let outcome:TempLoginView['phase']='failed',error:string|undefined,saved=false
    try{
      atomic(join(run.plan.directory,'config.toml'),config(run.marker.credentialStore??'file'))
      if(intercept){
        const script=join(run.plan.directory,'auth-hook.cjs'),capture=join(run.plan.directory,'auth-capture.jsonl')
        atomic(script,TEMP_LOGIN_HOOK);atomic(capture,'');run.plan.tempLoginHook={script,capture}
      }
      try{await this.launch(run)}catch(cause){if(!intercept||run.controller.signal.aborted)throw cause;await this.fallback(run)}
      const launchedAt=Date.now()
      let candidate:{source:'file'|'keyring';account?:StoredAccount}|undefined
      while(!candidate){
        run.controller.signal.throwIfAborted()
        if(Date.now()>=this.view.expiresAt!)throw new Error('等待官方客户端登录超时，本次登录已结束')
        if(intercept&&!run.fallback)this.capture(run)
        if(this.view.authStatus==='waiting'&&Date.now()-launchedAt>=(this.options.armTimeoutMs??20000))this.unavailable()
        candidate=await this.candidate(run)
        if(candidate)break
        if(!await this.runtime.find(run.plan)){
          if(intercept&&!run.fallback&&this.view.authStatus==='waiting'){await this.fallback(run);continue}
          throw new Error('临时客户端已关闭，未检测到完整登录凭据')
        }
        await delay(this.options.pollMs??1000,undefined,{signal:run.controller.signal})
      }
      this.view.phase='closing';await this.runtime.stop(run.plan)
      if(await this.runtime.find(run.plan))throw new Error('临时客户端仍在运行，请重试清理')
      run.controller.signal.throwIfAborted()
      // The client can rotate tokens while closing. Import its final snapshot.
      this.view.phase='importing'
      const final=await this.finalAuth(run)
      run.controller.signal.throwIfAborted()
      if(Date.now()>=this.view.expiresAt!)throw new Error('等待官方客户端登录超时，本次登录已结束')
      if(!final)throw new Error('未取得完整登录凭据，请重新登录')
      if(candidate.account&&!sameNativeAccount(final,candidate.account)&&!sameAccount(final,candidate.account))throw new Error('客户端退出时登录身份已变化，请重新登录')
      this.save(final);saved=true;outcome='completed'
      try{this.imported()}catch{this.view.notice='账号已保存，用量刷新未启动，请手动刷新'}
    }catch(cause){outcome=run.controller.signal.aborted?'cancelled':'failed';if(outcome==='failed')error=cause instanceof Error?cause.message:'临时登录失败'}
    finally{
      this.view.phase='cleaning'
      try{await this.clean(run.marker)}catch{this.view.notice='临时客户端或文件尚未清理完成，可点击重试清理；下次启动也会重试'}
      this.view={...this.view,phase:saved?'completed':outcome,running:false,error,authUrl:undefined,pid:undefined}
      if(this.active===run)this.active=undefined
    }
  }
  async cancel(id:string):Promise<void>{z.string().uuid().parse(id);if(!this.active||this.active.marker.id!==id)throw new Error('官方登录已结束或已更换');this.active.controller.abort();await this.active.task}
  async settled():Promise<void>{await this.active?.task}
  authURL(id:string):string {
    if(id!==this.active?.marker.id||terminal.has(this.view.phase)||!this.view.authUrl||!isOfficialLoginURL(this.view.authUrl))throw new Error('此登录的授权链接不可用')
    return this.view.authUrl
  }
  private async clean(marker:Marker):Promise<void> {
    this.guard(marker,true)
    const file=this.markerFile(marker.id),before=readBounded(file,16384)
    if(!before||hash(before)!==hash(JSON.stringify(marker)))throw new Error('临时登录清理记录已变化')
    const plan=this.plan(marker)
    await this.runtime.stop(plan)
    if(await this.runtime.find(plan))throw new Error('临时客户端仍在运行')
    this.guard(marker,true)
    if(readBounded(file,16384)!==before)throw new Error('临时登录清理记录已变化')
    if(marker.credentialStore&&marker.credentialStore!=='file'){
      // Derive from the canonical path recorded by this owned session, even
      // when its folder is gone. Never address the user's default Codex home.
      await this.keyring.remove(plan.directory,AbortSignal.timeout(20000))
      this.guard(marker,true)
      if(readBounded(file,16384)!==before)throw new Error('临时登录清理记录已变化')
    }
    await rm(this.folder(marker.id),{recursive:true,force:true})
    this.layout();if(readBounded(file,16384)!==before)throw new Error('临时登录清理记录已变化')
    rmSync(file)
  }
  cleanup():Promise<TempLoginCleanup> {
    if(this.cleaning)return this.cleaning
    const task=this.sweep();this.cleaning=task
    void task.finally(()=>{if(this.cleaning===task)this.cleaning=undefined}).catch(()=>{})
    return task
  }
  private async sweep():Promise<TempLoginCleanup> {
    const report:TempLoginCleanup={removed:[],failed:[]}
    try{
      const root=this.layout();if(!existsSync(root))return report
      for(const file of readdirSync(join(root,'markers'))){
        const id=file.replace(/\.json$/,'');if(!file.endsWith('.json')||!z.string().uuid().safeParse(id).success||this.active?.marker.id===id)continue
        try{
          const marker=markerSchema.parse(JSON.parse(readBounded(this.markerFile(id),16384)??''))
          if(marker.id!==id||!isAbsolute(marker.application)||!isAbsolute(marker.executable)||!['Codex','ChatGPT'].some(name=>marker.executable===join(marker.application,'Contents','MacOS',name)))throw new Error('invalid marker')
          await this.clean(marker);report.removed.push(id)
        }catch{report.failed.push({id,error:'无法确认临时目录归属或关闭进程，已保留原文件'})}
      }
      for(const id of readdirSync(join(root,'sessions')))if(!existsSync(this.markerFile(id))&&this.active?.marker.id!==id)report.failed.push({id,error:'缺少有效清理记录，已保留文件'})
    }catch{report.failed.push({id:'temp-login',error:'无法读取临时登录目录，已保留文件'})}
    finally{this.cleanupView=report}
    return structuredClone(report)
  }
  scheduleCleanup():void {
    if(this.stopped||this.startupTimer||this.sweepTimer)return
    this.startupTimer=setTimeout(()=>{this.startupTimer=undefined;void this.cleanup();this.sweepTimer=setInterval(()=>void this.cleanup(),600000);this.sweepTimer.unref()},8000)
    this.startupTimer.unref()
  }
  async stop():Promise<void>{this.stopped=true;clearTimeout(this.startupTimer);clearInterval(this.sweepTimer);this.active?.controller.abort();await this.active?.task;await this.cleaning}
}
