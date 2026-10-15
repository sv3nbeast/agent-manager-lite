import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type {CliPackage} from './cliResolver'
import {desktopNetworkArgs,macSystemProxyEnabled,type InstanceNetworkRoute} from './desktopNetwork'
import type {CodexSpeedMenuHook} from './codexSpeedMenu'
import {CodexSpeedMenuCdpSession,markCodexSpeedMenuCdpFailure} from './codexSpeedMenuCdp'
import type {AgentClientType} from '../shared/agentClients'
import {getInstanceClientAdapter,codexDesktopEnvironment,reserveCodexCdpPort} from './codexInstanceAdapter'
import {claudeCodeDesktopEnvironment,claudeDesktopLaunchEnvironment,isClaudeDesktopCommandOwned} from './claudeCodeDesktopAdapter'
import {sendClaudeDesktopLoginUrl,validateClaudeDesktopLoginUrl} from './claudeDesktopLogin'
import {prepareClaudeDesktopKeychain} from './claudeDesktopKeychain'
import {prepareClaudeDesktopNetwork} from './claudeDesktopNetwork'

const exec=promisify(execFile)
interface LaunchedDesktopChild {child:ChildProcess;exited:boolean;executable:string;profile:string}
export interface DesktopPlan { clientType?:AgentClientType; application:string; executable:string; directory:string; desktopDirectory:string; workingDirectory:string; args:string[]; nonce:string;mode?:'desktop'|'cli';managedArgs?:string[];launchEnvironment?:Record<string,string>;cliPackage?:CliPackage;networkRoute?:InstanceNetworkRoute;tempLoginHook?:{script:string;capture:string};speedMenuHook?:CodexSpeedMenuHook;desktopLocaleHook?:CodexSpeedMenuHook;/** Fixed loopback CDP port for startup-time response interception. */ cdpPort?:number }
export interface DesktopProcess { pid:number; started:string }
export interface DesktopRuntime {
  find(plan:DesktopPlan):Promise<DesktopProcess|undefined>
  launch(plan:DesktopPlan,signal:AbortSignal):Promise<DesktopProcess>
  stop(plan:DesktopPlan):Promise<void>
  focus(plan:DesktopPlan):Promise<void>
  openUrl?(plan:DesktopPlan,url:string):Promise<void>
}
export function desktopEnvironment(source:NodeJS.ProcessEnv,route?:InstanceNetworkRoute):NodeJS.ProcessEnv {
  return codexDesktopEnvironment(source,route)
}
export function macLaunchArgs(plan:DesktopPlan,args:readonly string[]=plan.args):string[] {
  return getInstanceClientAdapter(plan.clientType,'desktop').macLaunchArgs(plan,args)
}
// LaunchServices owns the launcher PID. Only an exact executable + private nonce
// match proves that a discovered PID belongs to this managed desktop instance.
export class MacDesktopRuntime implements DesktopRuntime {
  private readonly cdpSessions=new Map<string,CodexSpeedMenuCdpSession>()
  private readonly launchedChildren=new Map<string,LaunchedDesktopChild>()
  constructor(private readonly claudePreparation:(plan:DesktopPlan)=>Promise<void>=async plan=>{
    await prepareClaudeDesktopKeychain(claudeDesktopLaunchEnvironment(plan).HOME)
    prepareClaudeDesktopNetwork(plan)
  }){}
  private async stopLaunchedChild(record:LaunchedDesktopChild):Promise<void>{
    const exited=()=>record.exited||record.child.exitCode!==null||record.child.signalCode!==null
    for(const signal of ['SIGTERM','SIGKILL'] as const){
      if(exited())return
      try{record.child.kill(signal)}catch{/* Keep the handle for a retry if signalling fails. */}
      const deadline=Date.now()+2000
      while(!exited()&&Date.now()<deadline)await delay(100)
    }
    if(!exited())throw new Error('启动的 Claude Desktop 尚未退出，请重试停止；后台连接已保留')
  }
  private supported() {if(process.platform!=='darwin')throw new Error('桌面实例当前仅在 macOS 接入，其他平台仍在迁移')}
  async find(plan:DesktopPlan):Promise<DesktopProcess|undefined> {
    getInstanceClientAdapter(plan.clientType,'desktop')
    this.supported()
    const result=await exec('/bin/ps',['-ww','-axo','pid=,args='],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:5000})
    const marker=`--cml-instance=${plan.nonce}`
    for(const line of result.stdout.split('\n')) {
      const match=line.match(/^\s*(\d+)\s+(.+)$/)
      if(!match || !match[2].split(/\s+/).includes(marker))continue
      const pid=Number(match[1])
      try {
        const [command,started]=await Promise.all([
          exec('/bin/ps',['-ww','-p',String(pid),'-o','comm='],{encoding:'utf8',timeout:3000}),
          exec('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:3000})
        ])
        if(command.stdout.trim()===plan.executable && started.stdout.trim()){
          if(plan.clientType==='claude_code'&&!isClaudeDesktopCommandOwned(plan,match[2]))continue
          return {pid,started:started.stdout.trim()}
        }
      } catch { /* Candidate may have exited between snapshots. */ }
    }
  }
  async launch(plan:DesktopPlan,signal:AbortSignal):Promise<DesktopProcess> {
    getInstanceClientAdapter(plan.clientType,'desktop')
    this.supported();signal.throwIfAborted()
    const claude=plan.clientType==='claude_code'
    const env=claude?{...claudeCodeDesktopEnvironment(process.env,plan.networkRoute),...claudeDesktopLaunchEnvironment(plan)}:desktopEnvironment(process.env,plan.networkRoute)
    const args=claude||plan.networkRoute?plan.args:desktopNetworkArgs(plan.args,env,macSystemProxyEnabled())
    const hook=plan.speedMenuHook??plan.desktopLocaleHook
    let cdpSession:CodexSpeedMenuCdpSession|undefined
    let cdpStart:Promise<void>|undefined
    if(hook?.transport==='cdp'){
      // The port must be known before LaunchServices starts Electron. Starting
      // the CDP handshake concurrently with `open` lets the browser-level
      // auto-attach catch the first renderer request.
      plan.cdpPort=plan.cdpPort??await reserveCodexCdpPort()
      cdpSession=new CodexSpeedMenuCdpSession({hook,directory:plan.directory,desktopDirectory:plan.desktopDirectory,executable:plan.executable,nonce:plan.nonce,pid:undefined,cdpPort:plan.cdpPort})
      cdpStart=cdpSession.start()
      // The promise is intentionally awaited only after LaunchServices has
      // produced the owned PID; attach a rejection handler now so a failed
      // optional CDP enhancement never becomes an unhandled rejection while
      // the process is still being discovered.
      void cdpStart.catch(()=>{})
    }
    let launched:LaunchedDesktopChild|undefined,accepted=false
    try {
    if(claude){
      await this.claudePreparation(plan)
      signal.throwIfAborted()
    }
    try {
      const launchArgs=macLaunchArgs(plan,args)
      if(claude){
        // Direct native launch has an explicit clean environment. LaunchServices
        // can otherwise inherit launchd's Claude credentials and HOME overrides.
        await new Promise<void>((resolve,reject)=>{
          const child=spawn(plan.executable,launchArgs.slice(launchArgs.indexOf('--args')+1),{cwd:plan.workingDirectory,env,detached:true,stdio:'ignore'})
          const record:LaunchedDesktopChild={child,exited:false,executable:plan.executable,profile:plan.desktopDirectory}
          launched=record
          const exited=()=>{record.exited=true;if(this.launchedChildren.get(plan.nonce)===record)this.launchedChildren.delete(plan.nonce)}
          child.once('exit',exited);child.once('close',exited)
          // Errors can also report failed signalling; only exit/close proves death.
          child.on('error',reject)
          child.once('spawn',()=>{this.launchedChildren.set(plan.nonce,record);child.unref();resolve()})
        })
      }else await exec('/usr/bin/open',launchArgs,{cwd:plan.workingDirectory,env,timeout:15_000,maxBuffer:64*1024})
    }
    catch {cdpSession?.close();throw new Error('启动桌面应用失败，请检查应用路径和系统启动权限')}
    // Do not abort the LaunchServices command halfway: first identify its child,
    // then cancellation can terminate only that owned process.
    const deadline=Date.now()+10_000
    while(Date.now()<deadline) {
      if(claude&&signal.aborted)throw new Error('实例启动已取消')
      const child=await this.find(plan)
      if(child){
        if(signal.aborted){await this.stop(plan);throw new Error('实例启动已取消')}
        if(claude){
          // Verify the actual runtime path, rather than trusting the presence
          // of --user-data-dir after an upstream client update.
          let observed=false
          const profileDeadline=Date.now()+10000
          while(Date.now()<profileDeadline){
            if(signal.aborted){await this.stop(plan);throw new Error('实例启动已取消')}
            if(!await this.find(plan))throw new Error('Claude Desktop 在初始化时退出')
            try {
              const files=await exec('/usr/sbin/lsof',['-p',String(child.pid),'-Fn'],{encoding:'utf8',timeout:3000,maxBuffer:2*1024*1024})
              observed=files.stdout.split('\n').some(line=>line.startsWith(`n${plan.desktopDirectory}/`))
            }catch{/* Initialization may not have opened its profile yet. */}
            if(observed)break
            await delay(200)
          }
          if(!observed){await this.stop(plan);throw new Error('当前 Claude Desktop 未使用指定数据目录，已停止该实例；请更新客户端后重试')}
        }
        if(cdpSession){
          cdpSession.setPid(child.pid)
          try {
            await cdpStart
            if(this.cdpSessions.has(plan.nonce))this.cdpSessions.get(plan.nonce)!.close()
            this.cdpSessions.set(plan.nonce,cdpSession)
          } catch {
            cdpSession.close()
            if(hook)markCodexSpeedMenuCdpFailure({hook,directory:plan.directory,desktopDirectory:plan.desktopDirectory,executable:plan.executable,nonce:plan.nonce,pid:child.pid,cdpPort:plan.cdpPort})
            // CDP is an optional compatibility enhancement. The official
            // client remains usable when the debug endpoint is unavailable.
          }
        }
        if(signal.aborted){await this.stop(plan);throw new Error('实例启动已取消')}
        accepted=true
        return child
      }
      await delay(100)
    }
    cdpSession?.close()
    throw new Error('未找到实例主进程，请检查应用是否支持独立启动后重试')
    } finally {
      // The direct child still belongs to this launch even when discovery
      // fails (for example, an upstream version rewrites its argv). Do not
      // leave it running after cancellation or a failed ownership check.
      if(!accepted&&launched&&!launched.exited&&launched.child.pid)await this.stopLaunchedChild(launched)
    }
  }
  async stop(plan:DesktopPlan):Promise<void> {
    const cdp=this.cdpSessions.get(plan.nonce)
    if(cdp){cdp.close();this.cdpSessions.delete(plan.nonce)}
    const own=this.launchedChildren.get(plan.nonce)
    if(own&&own.executable===plan.executable&&own.profile===plan.desktopDirectory)await this.stopLaunchedChild(own)
    const child=await this.find(plan)
    if(!child)return
    const signal=async(value:NodeJS.Signals)=>{
      const current=await this.find(plan)
      if(!current || current.pid!==child.pid || current.started!==child.started)return
      try {process.kill(current.pid,value)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('无法停止实例进程')}
    }
    await signal('SIGTERM')
    for(let i=0;i<50;i++){if(!await this.find(plan))return;await delay(100)}
    await signal('SIGKILL')
    for(let i=0;i<20;i++){if(!await this.find(plan))return;await delay(100)}
    throw new Error('实例仍在运行，请重试停止')
  }
  async focus(plan:DesktopPlan):Promise<void> {
    const child=await this.find(plan)
    if(!child)throw new Error('实例未运行')
    try {
      const result=await exec('/usr/bin/osascript',['-l','JavaScript','-e','ObjC.import("AppKit"); function run(argv) { const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])); return app ? app.activateWithOptions(2) : false; }',String(child.pid)],{timeout:5000,maxBuffer:4096})
      if(result.stdout.trim()!=='true')throw new Error('inactive')
    } catch {throw new Error('无法定位窗口，请从 Dock 打开该实例')}
  }
  async openUrl(plan:DesktopPlan,url:string):Promise<void> {
    if(plan.clientType!=='claude_code'||plan.mode!=='desktop')throw new Error('此操作仅用于 Claude Desktop 登录')
    validateClaudeDesktopLoginUrl(url)
    const child=await this.find(plan)
    if(!child)throw new Error('请先启动此 Claude Desktop 实例')
    await sendClaudeDesktopLoginUrl(child.pid,url)
    await this.focus(plan)
  }
}
