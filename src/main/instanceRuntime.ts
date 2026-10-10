import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type {CliPackage} from './cliResolver'
import {desktopNetworkArgs,macSystemProxyEnabled,type InstanceNetworkRoute} from './desktopNetwork'
import type {CodexSpeedMenuHook} from './codexSpeedMenu'
import {CodexSpeedMenuCdpSession,markCodexSpeedMenuCdpFailure} from './codexSpeedMenuCdp'
import type {AgentClientType} from '../shared/agentClients'
import {getInstanceClientAdapter,codexDesktopEnvironment,reserveCodexCdpPort} from './codexInstanceAdapter'

const exec=promisify(execFile)
export interface DesktopPlan { clientType?:AgentClientType; application:string; executable:string; directory:string; desktopDirectory:string; workingDirectory:string; args:string[]; nonce:string;mode?:'desktop'|'cli';cliPackage?:CliPackage;networkRoute?:InstanceNetworkRoute;tempLoginHook?:{script:string;capture:string};speedMenuHook?:CodexSpeedMenuHook;desktopLocaleHook?:CodexSpeedMenuHook;/** Fixed loopback CDP port for startup-time response interception. */ cdpPort?:number }
export interface DesktopProcess { pid:number; started:string }
export interface DesktopRuntime {
  find(plan:DesktopPlan):Promise<DesktopProcess|undefined>
  launch(plan:DesktopPlan,signal:AbortSignal):Promise<DesktopProcess>
  stop(plan:DesktopPlan):Promise<void>
  focus(plan:DesktopPlan):Promise<void>
}
export function desktopEnvironment(source:NodeJS.ProcessEnv,route?:InstanceNetworkRoute):NodeJS.ProcessEnv {
  return codexDesktopEnvironment(source,route)
}
export function macLaunchArgs(plan:DesktopPlan,args:readonly string[]=plan.args):string[] {
  return getInstanceClientAdapter(plan.clientType).macLaunchArgs(plan,args)
}
// LaunchServices owns the launcher PID. Only an exact executable + private nonce
// match proves that a discovered PID belongs to this managed desktop instance.
export class MacDesktopRuntime implements DesktopRuntime {
  private readonly cdpSessions=new Map<string,CodexSpeedMenuCdpSession>()
  private supported() {if(process.platform!=='darwin')throw new Error('桌面实例当前仅在 macOS 接入，其他平台仍在迁移')}
  async find(plan:DesktopPlan):Promise<DesktopProcess|undefined> {
    getInstanceClientAdapter(plan.clientType)
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
        if(command.stdout.trim()===plan.executable && started.stdout.trim())return {pid,started:started.stdout.trim()}
      } catch { /* Candidate may have exited between snapshots. */ }
    }
  }
  async launch(plan:DesktopPlan,signal:AbortSignal):Promise<DesktopProcess> {
    getInstanceClientAdapter(plan.clientType)
    this.supported();signal.throwIfAborted()
    const env=desktopEnvironment(process.env,plan.networkRoute)
    const args=plan.networkRoute?plan.args:desktopNetworkArgs(plan.args,env,macSystemProxyEnabled())
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
    try {await exec('/usr/bin/open',macLaunchArgs(plan,args),{cwd:plan.workingDirectory,env,timeout:15_000,maxBuffer:64*1024})}
    catch {cdpSession?.close();throw new Error('启动桌面应用失败，请检查应用路径和系统启动权限')}
    // Do not abort the LaunchServices command halfway: first identify its child,
    // then cancellation can terminate only that owned process.
    const deadline=Date.now()+10_000
    while(Date.now()<deadline) {
      const child=await this.find(plan)
      if(child){
        if(signal.aborted){await this.stop(plan);throw new Error('实例启动已取消')}
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
        return child
      }
      await delay(100)
    }
    cdpSession?.close()
    throw new Error('未找到实例主进程，请检查应用是否支持独立启动后重试')
  }
  async stop(plan:DesktopPlan):Promise<void> {
    const cdp=this.cdpSessions.get(plan.nonce)
    if(cdp){cdp.close();this.cdpSessions.delete(plan.nonce)}
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
}
