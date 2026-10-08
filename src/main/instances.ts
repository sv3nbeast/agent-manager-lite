import {accountProxyURL} from './proxyPolicy'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, renameSync, rmSync, readdirSync } from 'node:fs'
import {mkdir,rename,rm} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { instanceRevisionSchema, saveInstanceSchema, copyInstanceSchema, copyExternalInstanceSchema, attachInstanceSchema, type ExternalInstanceHome, type InstanceCopySource, type InstanceInput, type InstanceCopyView, type InstanceApplication, type InstanceProfile, type InstanceView, type InstanceLaunchPreview, type InstanceWorkingDirectory, type InstanceCopyMode } from '../shared/instances'
import { resolveServiceTier } from '../shared/serviceTier'
import { Store, type StoredAccount } from './store'
import { Gateway } from './gateway'
import { ClientConfigs, atomic, directory, readBounded } from './clientConfig'
import { providerTierForAccount } from './providerLibrary'
import { type DesktopRuntime, type DesktopPlan, type DesktopProcess } from './instanceRuntime'
import { NativeInstanceAccounts } from './nativeInstanceAccounts'
import { MacInstanceRuntime } from './cliInstanceRuntime'
import {codexInstanceAdapter,getInstanceClientAdapter} from './codexInstanceAdapter'
import {agentClientTypeSchema,resolveAgentClientType} from '../shared/agentClients'
import {scanInstanceHome,relocateCopiedProfile} from './instanceCopy'
import {copySavedInstanceHome,normalizeSessionDatabaseCopy} from './instanceCopySnapshot'
import {scanSessionHome} from './instanceSessionCopy'
import {assertClientDaemonStopped,probeClientDaemon} from './clientDaemon'
import {instanceHomePath,validateExternalHome,pathContains} from './instancePaths'
import {TomlDocument} from './tomlPatch'
import {supportsOfficialTempLogin} from './tempLogin'
import {instanceProviderName} from './instanceProviderName'
import {initializeDesktopLocale,previewDesktopLocale,systemDesktopLanguages} from './desktopLocale'
import {inspectCodexDesktopUi,inspectCodexSpeedMenu,prepareCodexSpeedMenu,readCodexSpeedMenuStatus,type CodexSpeedMenuInspection} from './codexSpeedMenu'
import {initializeDesktopServiceTier,previewDesktopServiceTier} from './desktopServiceTier'
import {readInstanceHistory} from './instanceHistory'
import {repairSessionProjection} from './sessionProjectionRepair'

export interface InstanceSpeedMenuServices {inspect:typeof inspectCodexSpeedMenu;prepare:typeof prepareCodexSpeedMenu;readStatus:typeof readCodexSpeedMenuStatus;inspectLocale?:typeof inspectCodexSpeedMenu;inspectCombined?:typeof inspectCodexSpeedMenu;inspectFeatures?:typeof inspectCodexDesktopUi}
const defaultSpeedMenuServices:InstanceSpeedMenuServices={inspectFeatures:inspectCodexDesktopUi,inspect:inspectCodexSpeedMenu,inspectLocale:options=>inspectCodexSpeedMenu({...options,enhancements:'locale'}),inspectCombined:options=>inspectCodexSpeedMenu({...options,enhancements:'speed-locale'}),prepare:prepareCodexSpeedMenu,readStatus:readCodexSpeedMenuStatus}
type Running={profile:InstanceProfile;plan:DesktopPlan;status:InstanceView['status'];controller:AbortController;gateway?:Gateway;child?:DesktopProcess;task?:Promise<void>;stopping?:Promise<void>;error?:string;startedAt?:number;backup?:string;nativeTier?:string;initialTier?:string;speedMenuInspection?:CodexSpeedMenuInspection;localeInspection?:CodexSpeedMenuInspection;ultraInspection?:CodexSpeedMenuInspection;clientVersion?:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const resolveCompatibleApplication=(application:InstanceApplication)=>{try {resolveAgentClientType(application.clientType);return true}catch{return false}}
const checkpointSchema=z.object({clientType:agentClientTypeSchema.optional(),nonce:z.string().uuid(),backup:z.string().regex(/^\d{13}-[a-f0-9-]{36}$/).optional(),connectionMode:z.enum(['local_api','native']).optional(),nativeTier:z.string().optional()}).strict()

export class Instances {
  private readonly root:string
  private readonly active=new Map<string,Running>()
  private readonly previews=new Map<string,{preview:InstanceLaunchPreview;fingerprint:string;expiresAt:number}>()
  private readonly recoveryErrors=new Map<string,string>()
  private readonly notices=new Map<string,string>()
  private refreshing?:Promise<void>
  private copy?:{view:InstanceCopyView;accountId:string;controller:AbortController;task?:Promise<void>}
  private externalCopySource?:{view:InstanceCopySource;device:number;inode:number;expires:number;purpose:'copy'|'attach'}
  private attaching=new Set<AbortController>()
  constructor(private readonly store:Store,private readonly gatewayFactory:(profile:InstanceProfile)=>Gateway,
    private readonly prepareAccount:(id:string)=>Promise<StoredAccount>,private readonly runtime:DesktopRuntime=new MacInstanceRuntime(),
    private readonly nativeAccounts?:NativeInstanceAccounts,private readonly now:()=>number=Date.now,private readonly externalBusy:(id:string)=>boolean=()=>false,
    private readonly systemLanguages:readonly string[]=systemDesktopLanguages(),private readonly speedMenuServices:InstanceSpeedMenuServices=defaultSpeedMenuServices) {this.root=realpathSync(store.directory)}
  applications():InstanceApplication[] {
    const stored=this.store.read().instanceApplications ?? []
    return codexInstanceAdapter.applications(stored)
      .map(application=>({...application,supportsTempLogin:resolveCompatibleApplication(application)&&supportsOfficialTempLogin(application)}))
  }
  registerApplication(path:string,kind:'desktop'|'cli'='desktop'):InstanceApplication {
    const application=codexInstanceAdapter.registerApplication(path,kind)
    this.store.transaction(state=>{const existing=state.instanceApplications ?? [];if(existing.length>=30 && !existing.some(app=>app.id===application.id))throw new Error('最多登记 30 个应用');state.instanceApplications=[...existing.filter(app=>app.id!==application.id),application]})
    return application
  }
  workingDirectories():InstanceWorkingDirectory[]{return this.store.read().instanceWorkingDirectories??[]}
  registerWorkingDirectory(path:string):InstanceWorkingDirectory {
    const canonical=realpathSync(path);directory(canonical)
    const stat=lstatSync(canonical),old=this.workingDirectories().find(item=>item.path===canonical)
    if(old&&old.device===stat.dev&&old.inode===stat.ino)return old
    const item={id:randomUUID(),path:canonical,device:stat.dev,inode:stat.ino}
    this.store.transaction(state=>{const previous=state.instanceWorkingDirectories??[];if(previous.length>=100)throw new Error('最多登记 100 个工作目录');state.instanceWorkingDirectories=[...previous,item]})
    return item
  }
  private workingDirectory(profile:InstanceProfile,folder:string):string {
    if(!profile.workingDirectoryId)return join(folder,'workspace')
    const item=this.workingDirectories().find(value=>value.id===profile.workingDirectoryId)
    if(!item)throw new Error('工作目录未登记，请重新选择')
    directory(item.path);const stat=lstatSync(item.path)
    if(stat.dev!==item.device||stat.ino!==item.inode||realpathSync(item.path)!==item.path)throw new Error('工作目录已被替换，请重新选择')
    return item.path
  }
  private profile(id:string):InstanceProfile {
    const profile=this.store.read().instances?.find(instance=>instance.id===z.string().uuid().parse(id))
    if(!profile)throw new Error('实例不存在')
    return profile
  }
  private folder(id:string,create=false):string {
    directory(this.root)
    const parent=join(this.root,'instances'),folder=join(parent,id)
    directory(parent,create);directory(folder,create)
    for(const name of ['home','desktop','workspace'])directory(join(folder,name),create)
    return folder
  }
  private copying():boolean {return !!this.copy&&['scanning','copying'].includes(this.copy.view.status)}
  private copyingTarget(id:string):boolean {
    if(!this.copying())return false
    const state=this.store.read(),source=this.copy!.view
    return source.sourceId===id||state.configTargets?.some(target=>target.id===id&&target.directory===source.sourceDirectory)===true||state.instances?.some(profile=>profile.id===id&&profile.externalHome?.directory===source.sourceDirectory)===true
  }
  copyView():InstanceCopyView|undefined {return this.copy?structuredClone(this.copy.view):undefined}
  inUse(id:string,includeExternal=true):boolean {return this.active.has(id) || this.recoveryErrors.has(id)||this.copyingTarget(id)||includeExternal&&this.externalBusy(id)}
  usesAccount(id:string):boolean {return this.copying()&&this.copy!.accountId===id||[...this.active.values()].some(value=>value.profile.accountId===id) || (this.store.read().instances ?? []).some(profile=>profile.accountId===id && this.recoveryErrors.has(profile.id))}
  usesNativeAccountOutside(id:string,targetId:string):boolean {return [...this.active.values()].some(value=>value.profile.connectionMode==='native'&&value.profile.id!==targetId&&value.profile.accountId===id)||(this.store.read().instances??[]).some(profile=>profile.connectionMode==='native'&&profile.id!==targetId&&profile.accountId===id&&this.recoveryErrors.has(profile.id))}
  accountIds():string[] {return [...new Set([...this.active.values()].filter(value=>value.gateway?.current().running||value.profile.connectionMode==='native'&&value.status==='running').map(value=>value.profile.accountId))]}
  views():InstanceView[] {
    const applications=this.applications(),state=this.store.read()
    return (state.instances ?? []).map(profile=>{
      let clientType:unknown=profile.clientType,clientError:string|undefined
      try {clientType=resolveAgentClientType(profile.clientType)}catch(error){clientError=error instanceof Error?error.message:'客户端尚未接入'}
      const run=this.active.get(profile.id),gateway=run?.gateway?.current()
      const hook=run?.plan.speedMenuHook??run?.plan.desktopLocaleHook
      const featureStatus=(feature:'speed'|'locale'|'ultra',inspection?:CodexSpeedMenuInspection)=>run&&hook&&inspection?.supported?this.speedMenuServices.readStatus({statusLog:hook.statusLog,nonce:run.plan.nonce,executable:run.plan.executable,directory:run.plan.directory,pid:run.child?.pid,feature}):undefined
      const menu=featureStatus('speed',run?.speedMenuInspection),locale=featureStatus('locale',run?.localeInspection),ultra=featureStatus('ultra',run?.ultraInspection)
      const speedMenu:InstanceView['speedMenu']=menu?.state??(run?.speedMenuInspection?'unavailable':undefined)
      const menuNotice=menu?.state==='fallback'?menu.reason:run?.speedMenuInspection&&!run.speedMenuInspection.supported?run.speedMenuInspection.reason:undefined
      const localeState=locale?.state??(run?.localeInspection?'unavailable':undefined)
      const localeNotice=localeState==='fallback'?locale?.reason:run?.localeInspection&&!run.localeInspection.supported?run.localeInspection.reason:undefined
      const ultraState=ultra?.state??(run?.ultraInspection?'unavailable':undefined)
      const ultraNotice=ultraState==='fallback'?ultra?.reason:run?.ultraInspection&&!run.ultraInspection.supported?run.ultraInspection.reason:undefined
      return {...profile,clientType,copying:this.copyingTarget(profile.id),connectionMode:profile.connectionMode??'local_api',directory:instanceHomePath(this.root,profile),desktopDirectory:join(this.root,'instances',profile.id,'desktop'),
        launchMode:applications.find(app=>app.id===profile.applicationId)?.kind??'desktop',workingDirectory:profile.workingDirectoryId?this.workingDirectories().find(value=>value.id===profile.workingDirectoryId)?.path:join(this.root,'instances',profile.id,'workspace'),
        accountName:state.accounts.find(account=>account.id===profile.accountId)?.name,applicationName:applications.find(app=>app.id===profile.applicationId)?.name,
        status:clientError?'error':run?.status ?? (this.recoveryErrors.has(profile.id)?'error':'stopped'),pid:run?.child?.pid,startedAt:run?.startedAt,error:clientError ?? run?.error ?? gateway?.quotaSyncError ?? this.recoveryErrors.get(profile.id),notice:[...new Set([this.notices.get(profile.id),menuNotice,localeNotice,ultraNotice].filter(Boolean))].join('；')||undefined,port:gateway?.port,appliedTier:profile.connectionMode==='native'?run?.nativeTier:gateway?.defaultTier,
        speedMenu,initialTier:run?.initialTier,desktopLocaleCompatibility:localeState,ultraCompatibility:ultraState,clientVersion:run?.clientVersion}
    })
  }
  private validateDetails(details:InstanceInput,id:string):void {
    const adapter=getInstanceClientAdapter(details.clientType)
    const application=this.applications().find(app=>app.id===details.applicationId)
    if(!application)throw new Error('请先选择已检测或登记的桌面应用或 CLI 程序')
    adapter.validateApplication(details,application)
    if(details.workingDirectoryId)this.workingDirectory({...details,id,revision:0,createdAt:0},'')
    const account=this.store.read().accounts.find(account=>account.id===details.accountId)
    if(!account)throw new Error('绑定账号不存在')
    adapter.validateAccount(details,account)
  }
  save(raw:unknown,creationId?:string,externalHome?:ExternalInstanceHome):void {
    const input=saveInstanceSchema.parse(raw),id=input.id ?? creationId ?? randomUUID()
    if(input.id){const old=this.profile(id);if(resolveAgentClientType(old.clientType)!==input.details.clientType)throw new Error('更换客户端请创建新实例');if(old.revision!==input.revision)throw new Error('实例已变化，请重新编辑');if(this.inUse(id))throw new Error('请先停止实例')}
    this.validateDetails(input.details,id)
    const fresh=!input.id
    if(fresh)this.folder(id,true)
    try {
      this.store.transaction(state=>{
        const instances=state.instances ?? []
        if(instances.some(item=>item.id!==id && item.name.toLowerCase()===input.details.name.toLowerCase()))throw new Error('实例名称已存在')
        if(fresh && instances.length>=100)throw new Error('最多管理 100 个实例')
        const previous=instances.find(item=>item.id===id)
        const home=previous?.externalHome??externalHome
        const profile:InstanceProfile={...input.details,id,revision:(previous?.revision ?? -1)+1,createdAt:previous?.createdAt ?? Date.now(),...(home?{externalHome:home}:{})}
        state.instances=[...instances.filter(item=>item.id!==id),profile]
        if(fresh&&externalHome)state.configTargets=(state.configTargets??[]).filter(target=>target.id!==id)
      })
    } catch(error){if(fresh)rmSync(join(this.root,'instances',id),{recursive:true,force:true});throw error}
    this.previews.delete(id)
  }
  startCopy(raw:unknown):void {
    const input=copyInstanceSchema.parse(raw),source=this.profile(input.id)
    getInstanceClientAdapter(source.clientType)
    if(this.copying())throw new Error('已有实例正在复制，请完成或取消后重试')
    if(this.inUse(source.id)||source.revision!==input.revision)throw new Error('来源实例正在运行或已变化，请先停止并刷新')
    if(this.store.read().clientSwitches?.some(item=>item.targetId===source.id)||this.store.read().clientAuthorities?.some(item=>item.targetId===source.id))throw new Error('来源实例仍有登录恢复或凭据关联，请先处理')
    if(existsSync(join(this.folder(source.id),'launch.json')))throw new Error('来源实例仍有启动恢复记录，请先重开管理器处理')
    const sourceHome=source.externalHome?validateExternalHome(this.root,source.externalHome):join(this.folder(source.id),'home')
    this.beginCopy({id:source.id,name:source.name,directory:sourceHome},input.details,input.copyMode,()=>{
      if(this.profile(source.id).revision!==input.revision)throw new Error('来源实例已变化，请重新复制')
      if(source.externalHome)validateExternalHome(this.root,source.externalHome)
    })
  }
  // Native choosers or validated discovery capabilities call this; the renderer receives a short-lived
  // capability, never an IPC accepting an arbitrary filesystem path.
  selectCopySource(selected:string,purpose:'copy'|'attach'='copy'):InstanceCopySource {
    this.externalCopySource=undefined
    const canonical=realpathSync(selected);directory(canonical)
    if(pathContains(this.root,canonical)||pathContains(canonical,this.root))throw new Error('所选目录不能包含本管理器数据目录或位于其中；受管实例请使用卡片入口')
    if(purpose==='copy'&&!['config.toml','auth.json','sessions','skills'].some(name=>existsSync(join(canonical,name))))throw new Error('所选目录没有 Codex 配置、登录文件、会话或技能，请选择 CODEX_HOME 目录')
    const stat=lstatSync(canonical),view={ticket:randomUUID(),name:basename(canonical),directory:canonical,history:readInstanceHistory(canonical)}
    const source={view,device:stat.dev,inode:stat.ino,expires:this.now()+300_000,purpose}
    this.verifyExternalSource(source)
    this.externalCopySource=source
    return structuredClone(view)
  }
  private verifyExternalSource(source:NonNullable<Instances['externalCopySource']>):void {
    const path=source.view.directory;directory(path)
    const stat=lstatSync(path)
    if(stat.dev!==source.device||stat.ino!==source.inode||realpathSync(path)!==path)throw new Error('复制来源目录已被替换，请重新选择')
    const instances=(this.store.read().instances??[]).filter(profile=>profile.externalHome?.directory===path)
    const ids=new Set([...(this.store.read().configTargets??[]).filter(target=>target.directory===path).map(target=>target.id),...instances.map(profile=>profile.id)])
    if([...ids].some(id=>this.active.has(id)||this.recoveryErrors.has(id)||this.externalBusy(id)))throw new Error('所选目录的实例仍在运行或等待恢复，请先处理')
    if(this.copying()&&this.copy!.view.sourceDirectory===path&&this.copy!.view.sourceId!==source.view.ticket)throw new Error('此目录正在复制，请完成或取消后重试')
    if(this.store.read().clientSwitches?.some(record=>ids.has(record.targetId))||this.store.read().clientAuthorities?.some(binding=>ids.has(binding.targetId)))throw new Error('来源目录仍有登录恢复或凭据关联，请先处理后复制')
  }
  startExternalCopy(raw:unknown):void {
    const input=copyExternalInstanceSchema.parse(raw),source=this.externalCopySource
    if(!source||source.purpose!=='copy'||source.view.ticket!==input.ticket||source.expires<this.now())throw new Error('复制来源选择已过期，请重新选择目录')
    this.verifyExternalSource(source)
    this.beginCopy({id:source.view.ticket,name:source.view.name,directory:source.view.directory,external:true},input.details,input.copyMode,()=>this.verifyExternalSource(source))
    this.externalCopySource=undefined
  }
  async attachExisting(raw:unknown):Promise<void> {
    const input=attachInstanceSchema.parse(raw),source=this.externalCopySource
    getInstanceClientAdapter(input.details.clientType)
    if(!source||source.purpose!=='attach'||source.view.ticket!==input.ticket||source.expires<this.now())throw new Error('已有目录选择已过期，请重新选择')
    this.verifyExternalSource(source)
    const controller=new AbortController();this.attaching.add(controller)
    try{
      const daemon=await probeClientDaemon(source.view.directory,controller.signal)
      controller.signal.throwIfAborted();assertClientDaemonStopped(daemon)
      if(this.externalCopySource!==source||source.expires<this.now())throw new Error('所选目录已改变、过期或已使用，请重新选择')
      this.verifyExternalSource(source)
      const state=this.store.read(),path=source.view.directory
      if(state.instances?.some(profile=>profile.externalHome&&(pathContains(profile.externalHome.directory,path)||pathContains(path,profile.externalHome.directory))))throw new Error('此目录已被实例使用或与另一个外部实例目录重叠')
      const previous=state.configTargets?.find(target=>target.directory===path),id=previous?.id??randomUUID()
      if(previous&&(previous.device!==source.device||previous.inode!==source.inode))throw new Error('已登记配置目录的身份不一致，请先重新选择客户端配置目录')
      if(existsSync(join(this.root,'instances',id)))throw new Error('此目录存在旧实例管理记录，请先处理恢复记录')
      new TomlDocument(readBounded(join(path,'config.toml'),1024*1024)??'')
      this.save({details:input.details},id,{directory:path,device:source.device,inode:source.inode,...previous?{previousTargetName:previous.name}:{}})
      this.externalCopySource=undefined
    }finally{this.attaching.delete(controller)}
  }
  private beginCopy(source:{id:string;name:string;directory:string;external?:boolean},details:InstanceInput,copyMode:InstanceCopyMode,verify:()=>void):void {
    if(this.copying())throw new Error('已有实例正在复制，请完成或取消后重试')
    if(this.store.read().instances?.some(item=>item.name.toLowerCase()===details.name.toLowerCase()))throw new Error('实例名称已存在')
    if((this.store.read().instances?.length??0)>=100)throw new Error('最多管理 100 个实例')
    this.validateDetails(details,source.id)
    const account=this.store.read().accounts.find(value=>value.id===details.accountId)!
    const copiedSessionProvider=getInstanceClientAdapter(details.clientType).copiedSessionProvider(details,account)
    const id=randomUUID(),controller=new AbortController(),sourceHome=source.directory
    const view:InstanceCopyView={id,sourceId:source.id,sourceName:source.name,sourceDirectory:sourceHome,external:source.external,name:details.name,copyMode,status:'scanning',files:0,bytes:0,totalFiles:0,totalBytes:0,skipped:0}
    const job={view,controller,accountId:details.accountId,task:undefined as Promise<void>|undefined};this.copy=job
    job.task=(async()=>{
      const staging=join(this.root,'instance-copies',id),target=join(this.root,'instances',id)
      let promoted=false,published=false,created=false,identity:{dev:number;ino:number}|undefined
      try{
        verify()
        controller.signal.throwIfAborted()
        const manifest=copyMode==='sessions'
          ?await scanSessionHome(sourceHome,controller.signal)
          :await scanInstanceHome(sourceHome,controller.signal,true)
        Object.assign(view,{status:'copying',totalFiles:manifest.files,totalBytes:manifest.bytes,skipped:manifest.skipped})
        directory(join(this.root,'instance-copies'),true)
        await mkdir(staging,{mode:0o700});created=true;identity=lstatSync(staging)
        atomic(join(staging,'copy.json'),JSON.stringify({id,sourceId:source.id,...source.external?{external:true,sourceName:source.name}:{}}))
        const stagingHome=join(staging,'home')
        const saved=await copySavedInstanceHome(manifest,stagingHome,controller.signal,(files,bytes)=>Object.assign(view,{files,bytes}))
        if(copyMode==='sessions')await normalizeSessionDatabaseCopy(stagingHome,controller.signal)
        // Re-scan after normalizing an internal sqlite_home.  The relocation
        // step must see the canonical target paths and still retain the source
        // root for validating any rollout/database references.
        const normalized=copyMode==='sessions'
          ?{...await scanInstanceHome(stagingHome,controller.signal),root:manifest.root,skipped:saved.skipped,omittedSessions:saved.omittedSessions}
          :saved
        Object.assign(view,{totalFiles:normalized.files,totalBytes:normalized.bytes,skipped:normalized.skipped,omittedSessions:normalized.omittedSessions})
        await relocateCopiedProfile(normalized,stagingHome,join(target,'home'),controller.signal,copiedSessionProvider)
        controller.signal.throwIfAborted()
        verify()
        await mkdir(join(staging,'desktop'),{mode:0o700});await mkdir(join(staging,'workspace'),{mode:0o700})
        // Publish only a complete independent directory. A durable marker lets
        // recovery distinguish a staged/published copy after abrupt exit.
        directory(join(this.root,'instances'),true);if(existsSync(target))throw new Error('目标实例目录已存在，请重新复制')
        await rename(staging,target);promoted=true;controller.signal.throwIfAborted()
        this.save({details},id);published=true
        rmSync(join(target,'copy.json'),{force:true});Object.assign(view,{status:'completed',targetId:id})
      }catch(error){
        if(!published&&created)try{
          const folder=promoted?target:staging
          if(existsSync(folder)){
            const current=lstatSync(folder)
            if(current.dev!==identity?.dev||current.ino!==identity.ino||realpathSync(folder)!==folder)throw new Error('Copy directory identity changed')
            await rm(folder,{recursive:true,force:true})
          }
        }catch{view.error='未完成副本已保留，重开管理器后会归档'}
        view.status=published?'completed':controller.signal.aborted?'cancelled':'failed'
        if(published){view.targetId=id;view.error='实例已创建，待重开管理器清理复制标记'}
        else if(!view.error&&!controller.signal.aborted)view.error=error instanceof Error&&!["ENOENT","EACCES","EPERM","ENOSPC"].includes((error as NodeJS.ErrnoException).code??'')?error.message:'无法复制实例，请检查来源文件、目录权限和可用磁盘空间'
      }
    })().finally(()=>{job.task=undefined})
  }
  async cancelCopy(id:string):Promise<void>{
    z.string().uuid().parse(id)
    if(this.copy?.view.id!==id)throw new Error('复制任务已变化，请刷新')
    if(this.copying()){this.copy.controller.abort();await this.copy.task}
  }
  remove(raw:unknown):void {
    const {id,revision}=instanceRevisionSchema.parse(raw),profile=this.profile(id)
    if(this.store.read().clientSwitches?.some(record=>record.targetId===id))throw new Error('请先恢复此实例的原生账号切换')
    const hasAuthority=this.store.read().clientAuthorities?.some(binding=>binding.targetId===id)
    if(hasAuthority&&!profile.externalHome)throw new Error('请先解除此实例的客户端凭据关联')
    if(this.inUse(id) || profile.revision!==revision)throw new Error('实例正在运行或已变化，请先停止并刷新')
    const folder=this.folder(id),trash=join(this.root,'instance-trash');directory(trash,true)
    const archived=join(trash,`${id}-${Date.now()}`)
    renameSync(folder,archived)
    try {this.store.transaction(state=>{
      state.instances=state.instances!.filter(value=>value.id!==id)
      if(profile.externalHome&&(profile.externalHome.previousTargetName||hasAuthority)){
        const home=profile.externalHome
        state.configTargets=[...(state.configTargets??[]).filter(target=>target.id!==id),{id,name:home.previousTargetName??profile.name,directory:home.directory,managed:false,device:home.device,inode:home.inode}]
      }
    })}
    catch(error){renameSync(archived,folder);throw error}
    this.previews.delete(id)
  }
  private plan(profile:InstanceProfile,nonce:string):DesktopPlan {
    const adapter=getInstanceClientAdapter(profile.clientType)
    const application=this.applications().find(app=>app.id===profile.applicationId)
    if(!application)throw new Error('桌面应用已不可用，请重新选择')
    adapter.validateApplication(profile,application)
    const folder=this.folder(profile.id)
    const runtime=adapter.launchRuntime(application),workingDirectory=this.workingDirectory(profile,folder)
    directory(workingDirectory)
    const home=profile.externalHome?validateExternalHome(this.root,profile.externalHome):join(folder,'home')
    return {clientType:adapter.client.id,application:application.path,...runtime,directory:home,desktopDirectory:join(folder,'desktop'),workingDirectory,args:profile.extraArgs,nonce,mode:application.kind??'desktop'}
  }
  private context(profile:InstanceProfile,nonce:string=randomUUID()) {
    const adapter=getInstanceClientAdapter(profile.clientType)
    if(this.store.read().clientSwitches?.some(record=>record.targetId===profile.id))throw new Error('请先恢复此目录的原生账号切换')
    if(profile.connectionMode!=='native'&&this.store.read().clientAuthorities?.some(binding=>binding.targetId===profile.id))throw new Error('此目录正在维护原生登录，请先解除凭据关联后再使用本地 API 启动模式')
    const plan=this.plan(profile,nonce),folder=this.folder(profile.id),state=this.store.read(),account=state.accounts.find(value=>value.id===profile.accountId)
    if(!account)throw new Error('绑定账号已删除，请重新选择')
    adapter.validateAccount(profile,account)
    if(profile.connectionMode==='native'){
      if(!this.nativeAccounts)throw new Error('原生账号服务不可用')
      this.nativeAccounts.validate(profile)
    }
    const configs=new ClientConfigs(this.store),view=configs.view(profile.id)
    const modelContext=configs.instanceModelContext(profile.id,profile.model)
    const providerTier=providerTierForAccount(state,account)
    const providerName=instanceProviderName(state,account)
    const language=plan.mode==='cli'?undefined:previewDesktopLocale(this.localeOptions(profile.id,plan))
    const tier=resolveServiceTier(undefined,state.settings.defaultTier,providerTier,profile.defaultTier,account.defaultTier)
    const desktopUi=plan.mode==='cli'?undefined:this.speedMenuServices.inspectFeatures?.({application:plan.application,executable:plan.executable,features:profile.connectionMode==='native'?['locale']:['locale','speed','ultra']})
    const feature=(name:'speed'|'locale'|'ultra'):CodexSpeedMenuInspection|undefined=>desktopUi?{...desktopUi,supported:desktopUi.featureSupport?.[name].supported===true,reason:desktopUi.featureSupport?.[name].reason??desktopUi.reason}:undefined
    const clientMenu=plan.mode!=='cli'&&profile.connectionMode!=='native'?(desktopUi?feature('speed'):this.speedMenuServices.inspect({application:plan.application,executable:plan.executable})):undefined
    // The renderer compatibility hook is what exposes the Normal / Fast
    // selector for manager-owned local providers. A model catalog can omit
    // `service_tiers` for a newly released or provider-routed model even when
    // the upstream accepts the tier request (for example gpt-5.6-sol-wm).
    // Using that catalog field as a hard gate made the selector disappear.
    // Keep the inspected client capability authoritative; the selected tier
    // is still carried by the gateway and can be rejected upstream when it is
    // genuinely unsupported.
    const speedMenu=clientMenu
    const localeCandidate=plan.mode==='cli'?undefined:desktopUi?feature('locale'):this.speedMenuServices.inspectLocale?.({application:plan.application,executable:plan.executable})
    const ultraCompatibility=plan.mode!=='cli'&&profile.connectionMode!=='native'?feature('ultra'):undefined
    const combined=!desktopUi&&speedMenu?.supported&&localeCandidate?.supported?this.speedMenuServices.inspectCombined?.({application:plan.application,executable:plan.executable}):undefined
    const localeCompatibility=!desktopUi&&localeCandidate?.supported&&speedMenu?.supported&&!combined?.supported?{...localeCandidate,supported:false,reason:combined?.reason??'当前客户端组合界面适配未就绪，保留原页面语言'}:localeCandidate
    const compatibility=desktopUi??(combined?.supported?combined:speedMenu?.supported?speedMenu:localeCompatibility)
    const speedPreference=speedMenu?.supported?previewDesktopServiceTier(this.speedPreferenceOptions(profile.id,plan,tier.tier)):undefined
    const initialTier=speedPreference?speedPreference.tier:tier.tier
    const history=readInstanceHistory(plan.directory)
    const fingerprint=digest([profile,view.revision,plan.application,plan.executable,plan.cliPackage,lstatSync(plan.executable).mtimeMs,lstatSync(plan.executable).ino,lstatSync(plan.workingDirectory).ino,
      ...[folder,plan.directory,plan.desktopDirectory].map(path=>[lstatSync(path).dev,lstatSync(path).ino]),
      account.id,account.kind,account.baseUrl,account.models,account.wireApi,account.credentials.apiKey,account.providerId,account.providerKeyId,providerName,language?.revision,modelContext.revision,accountProxyURL(account,state),tier,
      profile.connectionMode==='native'?readBounded(join(plan.directory,'auth.json'),2*1024*1024):null,speedMenu?.fingerprint,speedPreference?.revision,localeCandidate?.fingerprint,combined?.fingerprint,compatibility?.fingerprint,history])
    return {account,configs,view,tier,plan,fingerprint,providerName,language,modelContext,speedMenu,speedPreference,initialTier,localeCompatibility,ultraCompatibility,compatibility,history}
  }
  private localeOptions(id:string,plan:DesktopPlan) {return {directory:plan.directory,markerPath:join(this.folder(id),'desktop-locale.json'),systemLanguages:this.systemLanguages}}
  private speedPreferenceOptions(id:string,plan:DesktopPlan,initialTier?:string) {return {directory:plan.directory,markerPath:join(this.folder(id),'desktop-speed-preference.json'),initialTier}}
  previewHistory(raw:unknown) {
    const {id,revision}=instanceRevisionSchema.parse(raw),profile=this.profile(id)
    if(profile.revision!==revision||this.inUse(id))throw new Error('实例已变化或正在运行，请停止并刷新后查看会话来源')
    getInstanceClientAdapter(profile.clientType)
    return readInstanceHistory(instanceHomePath(this.root,profile))
  }
  preview(raw:unknown):InstanceLaunchPreview {
    const {id,revision}=instanceRevisionSchema.parse(raw),profile=this.profile(id)
    if(profile.revision!==revision || this.inUse(id))throw new Error('实例已变化或正在运行，请刷新后重试')
    const context=this.context(profile),preview:InstanceLaunchPreview={clientType:resolveAgentClientType(profile.clientType),ticket:randomUUID(),instanceId:id,name:profile.name,application:context.plan.application,
      executable:context.plan.executable,directory:context.plan.directory,desktopDirectory:context.plan.desktopDirectory,workingDirectory:context.plan.workingDirectory,args:[...profile.extraArgs],
      accountName:context.account.name,providerName:context.providerName,desktopLocale:context.language?.locale,desktopEffectiveLocale:context.language?.effectiveLocale,desktopLocaleSource:context.language?.source,
      effectiveContextWindow:context.modelContext.window,effectiveAutoCompactTokenLimit:context.modelContext.compact,contextWindowSource:context.modelContext.origin,
      model:profile.model,tier:context.initialTier,tierSource:context.speedPreference?.source==='existing'?'client':context.tier.source,connectionMode:profile.connectionMode??'local_api',launchMode:context.plan.mode??'desktop',externalHome:!!profile.externalHome,
      speedMenuAvailable:context.speedMenu?.supported,speedMenuReason:context.speedMenu?.reason,speedPreferenceSource:context.speedPreference?.source,
      desktopLocaleCompatibilityAvailable:context.localeCompatibility?.supported,desktopLocaleCompatibilityReason:context.localeCompatibility?.reason,
      ultraAvailable:context.ultraCompatibility?.supported,ultraReason:context.ultraCompatibility?.reason,clientVersion:context.compatibility?.version,
      history:context.history}
    this.previews.set(id,{preview,fingerprint:context.fingerprint,expiresAt:Date.now()+300_000})
    return structuredClone(preview)
  }
  start(ticket:string):void {
    z.string().uuid().parse(ticket)
    const entry=[...this.previews.entries()].find(([,value])=>value.preview.ticket===ticket)
    if(!entry || entry[1].expiresAt<Date.now())throw new Error('启动预览已过期，请重新预览')
    const [id,pending]=entry,profile=this.profile(id),context=this.context(profile)
    if(this.inUse(id))throw new Error('实例已有启动或运行任务')
    this.previews.delete(id)
    if(context.fingerprint!==pending.fingerprint)throw new Error('账号、配置、会话或应用已变化，请重新预览')
    const run:Running={profile,plan:context.plan,status:'preparing',controller:new AbortController(),initialTier:context.initialTier,speedMenuInspection:context.speedMenu,localeInspection:context.localeCompatibility,ultraInspection:context.ultraCompatibility,clientVersion:context.compatibility?.version}
    this.notices.delete(id)
    this.active.set(id,run)
    run.task=this.launch(run,context.view.revision,pending.fingerprint).finally(()=>{run.task=undefined})
  }
  private checkpoint(run:Running):void {atomic(join(this.folder(run.profile.id),'launch.json'),JSON.stringify({clientType:resolveAgentClientType(run.profile.clientType),nonce:run.plan.nonce,backup:run.backup,connectionMode:run.profile.connectionMode??'local_api',nativeTier:run.nativeTier}))}
  private async launch(run:Running,revision:string,fingerprint:string):Promise<void> {
    try {
      if(run.profile.externalHome&&run.profile.connectionMode!=='native')assertClientDaemonStopped(await probeClientDaemon(run.plan.directory,run.controller.signal))
      if(run.profile.connectionMode==='native')await this.nativeAccounts!.prepare(run.profile,run.controller.signal)
      await this.prepareAccount(run.profile.accountId)
      // A clean stop followed by a start in the same manager process does not
      // pass through recover(). Apply the same projection repair after account
      // preparation (which is also the cancellation boundary) and before the
      // client is launched. This keeps startup cancellation deterministic.
      if (!run.profile.externalHome && !run.controller.signal.aborted &&
        await probeClientDaemon(run.plan.directory,run.controller.signal)==='not_detected') {
        try {
          const repaired=await repairSessionProjection(run.plan.directory,join(this.root,'instance-trash'))
          if (repaired) this.notices.set(run.profile.id,`已恢复 ${repaired.inserted} 条会话历史索引；原数据库备份已保留`)
        } catch (error) {
          this.notices.set(run.profile.id,'会话历史索引自动恢复失败，原文件已保留；请在客户端完全退出后重试')
          console.warn('session projection recovery failed',run.profile.id,error)
        }
      }
      run.controller.signal.throwIfAborted()
      let context=this.context(run.profile,run.plan.nonce)
      if(context.fingerprint!==fingerprint)throw new Error('实例配置在凭据准备期间已变化，请重新启动')
      if(context.language){
        initializeDesktopLocale(this.localeOptions(run.profile.id,run.plan),context.language.revision)
        context=this.context(run.profile,run.plan.nonce);fingerprint=context.fingerprint;revision=context.view.revision
      }
      if(context.speedMenu?.supported){
        if(!context.speedPreference)throw new Error('速度偏好预览已变化，请重新启动')
        initializeDesktopServiceTier(this.speedPreferenceOptions(run.profile.id,run.plan,context.tier.tier),context.speedPreference.revision)
        context=this.context(run.profile,run.plan.nonce);fingerprint=context.fingerprint;revision=context.view.revision
        run.initialTier=context.initialTier
      }
      if(context.compatibility?.supported){
        const hook=this.speedMenuServices.prepare({inspection:context.compatibility,directory:run.plan.directory,desktopDirectory:run.plan.desktopDirectory,executable:run.plan.executable,nonce:run.plan.nonce})
        if(!hook)throw new Error('客户端界面兼容资源已变化，请重新预览启动')
        if(context.speedMenu?.supported)run.plan.speedMenuHook=hook
        else run.plan.desktopLocaleHook=hook
      }
      if(run.profile.connectionMode==='native'){
        run.nativeTier=context.tier.tier
        const contextPreview=context.configs.previewInstanceContext(run.profile.id,context.view.revision,run.profile.model)
        context.configs.apply(contextPreview.ticket,backup=>{run.backup=backup;this.checkpoint(run)})
        context=this.context(run.profile,run.plan.nonce);fingerprint=context.fingerprint
        // The nonce is durable before the encrypted auth transaction starts.
        // A crash at any later boundary can locate only this launch's journal.
        this.checkpoint(run)
        await this.nativeAccounts!.inject(run.profile,run.plan.nonce,context.tier.tier,run.controller.signal,()=>{
          if(this.context(run.profile,run.plan.nonce).fingerprint!==fingerprint)throw new Error('实例设置在等待凭据写入期间已变化，请重新预览')
        })
        run.controller.signal.throwIfAborted();run.status='starting'
        run.child=await this.runtime.launch(run.plan,run.controller.signal)
        run.controller.signal.throwIfAborted();run.status='running';run.startedAt=Date.now()
        return
      }
      const localKey=`cml-instance-${randomBytes(32).toString('hex')}`
      const gateway=this.gatewayFactory(run.profile);run.gateway=gateway
      const account={...context.account,models:[run.profile.model,...context.account.models.filter(model=>model!==run.profile.model)]}
      const status=await gateway.start({id:run.profile.id,port:0,account,apiKey:localKey,defaultTier:run.plan.speedMenuHook?'standard':run.profile.defaultTier,
        providerTier:providerTierForAccount(this.store.read(),context.account)},this.store.read().settings,run.controller.signal)
      run.controller.signal.throwIfAborted()
      gateway.updateRoutingAccount(this.store.read().accounts.find(value=>value.id===run.profile.accountId)!)
      if(run.profile.externalHome)assertClientDaemonStopped(await probeClientDaemon(run.plan.directory,run.controller.signal))
      if(this.context(run.profile,run.plan.nonce).fingerprint!==fingerprint)throw new Error('实例供应商或配置在连接准备期间已变化，请重新预览启动')
      const preview=context.configs.previewInstanceConnection(run.profile.id,revision,{port:status.port!,key:localKey,model:run.profile.model,tier:run.plan.speedMenuHook?context.initialTier:status.defaultTier,manageServiceTier:!run.plan.speedMenuHook})
      context.configs.apply(preview.ticket,backup=>{run.backup=backup;this.checkpoint(run)})
      run.status='starting'
      run.child=await this.runtime.launch(run.plan,run.controller.signal)
      run.controller.signal.throwIfAborted()
      await gateway.updateCredentials(this.store.read().accounts.find(value=>value.id===run.profile.accountId)!)
      run.status='running';run.startedAt=Date.now()
    } catch(error) {
      run.error=run.controller.signal.aborted?'实例启动已取消':error instanceof Error ? error.message:'实例启动失败'
      run.status='error'
      try {await this.cleanup(run);if(run.controller.signal.aborted)this.active.delete(run.profile.id)}catch(cause) {run.error='实例清理未完成，文件已保留：'+(cause instanceof Error?cause.message:'请重试停止')}
    }
  }
  private async cleanup(run:Running):Promise<void> {
    await this.runtime.stop(run.plan)
    await run.gateway?.stop()
    if(run.profile.connectionMode==='native'){
      if(!this.nativeAccounts)throw new Error('原生登录恢复服务不可用，文件已保留')
      await this.nativeAccounts.restore(run.profile,run.plan.nonce)
    }
    if(run.backup) {
      if(run.profile.externalHome)assertClientDaemonStopped(await probeClientDaemon(validateExternalHome(this.root,run.profile.externalHome)))
      const configs=new ClientConfigs(this.store),restore=configs.previewRestore({id:run.profile.id,backup:run.backup},true)
      if(restore.conflicts.length)this.notices.set(run.profile.id,'实例已停止，之后手工修改的配置已保留；原配置仍可在客户端配置页查看备份')
      configs.apply(restore.ticket);run.backup=undefined
    }
    const hookParent=join(run.plan.desktopDirectory,'cml-speed-menu'),hookFolder=join(hookParent,run.plan.nonce)
    if(existsSync(hookFolder)){
      directory(run.plan.desktopDirectory);directory(hookParent);directory(hookFolder)
      if(realpathSync(hookFolder)!==hookFolder)throw new Error('速度兼容目录已变化，文件已保留')
      rmSync(hookFolder,{recursive:true,force:true})
    }
    rmSync(join(this.folder(run.profile.id),'launch.json'),{force:true})
    run.child=undefined
  }
  async stop(id:string):Promise<void> {
    this.profile(id)
    if(this.recoveryErrors.has(id))throw new Error(this.recoveryErrors.get(id))
    const run=this.active.get(id)
    if(!run)return
    if(run.stopping)return run.stopping
    run.controller.abort();run.status='stopping'
    run.stopping=(async()=>{await run.task;try{await this.cleanup(run);this.active.delete(id)}catch(cause){run.status='error';run.error='停止或恢复配置失败，文件已保留：'+(cause instanceof Error?cause.message:'请检查后重试');throw new Error(run.error)}})().finally(()=>{run.stopping=undefined})
    return run.stopping
  }
  async focus(id:string):Promise<void> {const run=this.active.get(id);if(!run || run.status!=='running')throw new Error('实例未运行');await this.runtime.focus(run.plan)}
  async updateCredentials(account:StoredAccount):Promise<void> {await Promise.all([...this.active.values()].map(run=>run.gateway?.updateCredentials(account)))}
  updateRoutingAccount(account:StoredAccount):void {
    let failure:unknown
    for(const run of this.active.values())try{run.gateway?.updateRoutingAccount(account)}catch(error){failure=error}
    if(failure)throw failure
  }
  syncCredentials():void {for(const run of this.active.values())run.gateway?.syncCredentials()}
  async settled(id:string):Promise<void> {await this.active.get(id)?.task}
  async refresh():Promise<void> {
    if(this.refreshing)return this.refreshing
    this.refreshing=(async()=>{for(const run of this.active.values())if(run.status==='running'){
      if(!await this.runtime.find(run.plan)) {
        try {await this.stop(run.profile.id)}catch{run.status='error';run.error='实例已退出，但配置或登录状态未保存，请重试停止'}
      } else if(run.profile.connectionMode!=='native'&&!run.gateway?.current().running && run.status==='running') {
        run.status='error';run.error='实例本地连接已退出，请停止后重新启动'
      }
    }})().finally(()=>{this.refreshing=undefined})
    return this.refreshing
  }
  async recover():Promise<void> {
    // Unpublished copies are preserved in the existing archive, never exposed
    // as usable instances. A committed profile retains its complete directory.
    for(const parent of ['instance-copies','instances']){
      const folder=join(this.root,parent)
      if(!existsSync(folder))continue
      directory(folder)
      for(const name of readdirSync(folder)){
        if(!z.string().uuid().safeParse(name).success)continue
        const child=join(folder,name)
        try{
          const stat=lstatSync(child)
          if(stat.isSymbolicLink()||!stat.isDirectory())continue
          if(realpathSync(child)!==child)continue
          const marker=readBounded(join(child,'copy.json'),4096)
          if(!marker)continue
          const data=z.object({id:z.string().uuid(),sourceId:z.string().uuid(),external:z.literal(true).optional(),sourceName:z.string().max(255).optional()}).strict().parse(JSON.parse(marker))
          if(data.id!==name)continue
          const profile=parent==='instances'?this.store.read().instances?.find(item=>item.id===name):undefined
          if(profile){getInstanceClientAdapter(profile.clientType);rmSync(join(child,'copy.json'));continue}
          const trash=join(this.root,'instance-trash');directory(trash,true)
          renameSync(child,join(trash,`incomplete-copy-${name}-${randomUUID()}`))
          this.notices.set(data.sourceId,'上次未完成的实例副本已归档到 instance-trash，来源保留，可重新复制')
          if(data.external&&!this.copy)this.copy={view:{id:data.id,sourceId:data.sourceId,sourceName:data.sourceName??'外部目录',name:'未完成副本',external:true,status:'failed',files:0,bytes:0,totalFiles:0,totalBytes:0,skipped:0,error:'上次未完成的外部目录副本已归档到 instance-trash，请重新选择来源后复制'},accountId:'',controller:new AbortController()}
        }catch{/* Keep malformed or inaccessible recovery data for inspection. */}
      }
    }
    for(const profile of this.store.read().instances ?? []) {
      try {
        getInstanceClientAdapter(profile.clientType)
        // Older sessions-only copies retained rollout JSONL and state_5.sqlite
        // but omitted Codex's thread-history projection. Recover it from an
        // archived managed copy before a new client process can open the home.
        // A running or inaccessible daemon is left untouched for a later
        // restart; this path never kills or rewrites an active client.
        if (!profile.externalHome) {
          const home=instanceHomePath(this.root,profile),daemon=await probeClientDaemon(home)
          if (daemon==='not_detected') {
            try {
              const repaired=await repairSessionProjection(home,join(this.root,'instance-trash'))
              if (repaired) this.notices.set(profile.id,`已恢复 ${repaired.inserted} 条会话历史索引；原数据库备份已保留`)
            } catch (error) {
              this.notices.set(profile.id,'会话历史索引自动恢复失败，原文件已保留；请在客户端完全退出后重试')
              console.warn('session projection recovery failed',profile.id,error)
            }
          }
        }
        const content=readBounded(join(this.folder(profile.id),'launch.json'),4096)
        if(!content){if(this.store.read().clientSwitches?.some(record=>record.targetId===profile.id&&record.instanceNonce))throw new Error('原生恢复记录缺少启动归属');continue}
        const saved=checkpointSchema.parse(JSON.parse(content))
        if(resolveAgentClientType(saved.clientType)!==resolveAgentClientType(profile.clientType))throw new Error('实例客户端与恢复记录不一致')
        const plan=this.plan(profile,saved.nonce)
        if((saved.connectionMode??'local_api')!==(profile.connectionMode??'local_api'))throw new Error('实例启动模式与恢复记录不一致')
        const run:Running={profile,plan,status:'error',controller:new AbortController(),backup:saved.backup,nativeTier:saved.nativeTier,error:'检测到上次运行的实例，请停止并回收登录状态后重新启动'}
        this.active.set(profile.id,run);run.child=await this.runtime.find(run.plan)
        if(!run.child){await this.cleanup(run);this.active.delete(profile.id)}
      } catch {this.recoveryErrors.set(profile.id,'上次实例记录无法安全恢复，已保留原目录；请检查应用路径与 launch.json 后重开管理器')}
    }
  }
  async closeAll():Promise<void> {for(const controller of this.attaching)controller.abort();if(this.copying())await this.cancelCopy(this.copy!.view.id);const results=await Promise.allSettled([...this.active.keys()].map(id=>this.stop(id)));if(results.some(result=>result.status==='rejected'))throw new Error('部分实例未停止或恢复，请逐项检查')}
}
