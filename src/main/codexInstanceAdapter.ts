import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { accountCompatibility, getAgentClient, resolveAgentClientType } from '../shared/agentClients'
import type { Account } from '../shared/types'
import type { InstanceApplication, InstanceProfile } from '../shared/instances'
import type { DesktopPlan } from './instanceRuntime'
import { resolveCliRuntime } from './cliResolver'
import {codexBundledCli,codexDesktopExecutable} from './codexPrograms'
import { TomlDocument } from './tomlPatch'
import {nativeProvider} from './nativeAccountProjection'
import {applyNetworkRouteEnvironment,managedDesktopNetworkArgs,networkRouteEnvironment,type InstanceNetworkRoute} from './desktopNetwork'

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

function applications(stored:readonly InstanceApplication[]):InstanceApplication[] {
  const detected=['/Applications/Codex.app','/Applications/ChatGPT.app',join(homedir(),'Applications/Codex.app'),join(homedir(),'Applications/ChatGPT.app')]
    .filter(path=>['Codex','ChatGPT'].some(name=>existsSync(join(path,'Contents/MacOS',name))))
    .map(path=>({clientType:'codex' as const,id:digest(path),name:basename(path,'.app'),path:realpathSync(path)}))
  const bundled=detected.flatMap(app=>{try{return [codexBundledCli(app.path)]}catch{return []}})
  const cli=[...bundled,'/opt/homebrew/bin/codex','/usr/local/bin/codex',
    ...(process.env.PATH??'').split(':').filter(isAbsolute).slice(0,100).map(path=>join(path,'codex'))]
    .filter(path=>existsSync(path)).map(path=>({clientType:'codex' as const,id:digest('cli:'+realpathSync(path)),name:'Codex CLI',path:realpathSync(path),kind:'cli' as const}))
  // Project legacy records without persisting a migration. Keep unsupported
  // explicit values intact so selection and execution can reject them.
  return [...new Map([...detected,...cli,...stored].map(app=>[app.path,app])).values()]
    .map(app=>({...app,clientType:app.clientType===undefined?'codex':app.clientType}))
}

function executable(app:InstanceApplication):string {
  resolveAgentClientType(app.clientType)
  if(realpathSync(app.path)!==app.path)throw new Error('所选程序路径已被替换，请重新选择')
  if(app.kind==='cli')return resolveCliRuntime(app.path).executable
  return codexDesktopExecutable(app.path)
}

function registerApplication(path:string,kind:'desktop'|'cli'):InstanceApplication {
  const canonical=realpathSync(path),application:InstanceApplication={clientType:'codex',id:digest((kind==='cli'?'cli:':'')+canonical),name:basename(canonical,'.app'),path:canonical,kind}
  executable(application)
  return application
}

function launchRuntime(application:InstanceApplication) {
  resolveAgentClientType(application.clientType)
  if(realpathSync(application.path)!==application.path)throw new Error('所选程序路径已被替换，请重新选择')
  return application.kind==='cli'?resolveCliRuntime(application.path):{executable:executable(application)}
}

export function validateCodexCliArgs(args:string[]):void {
  for(let i=0;i<args.length;i++){
    const arg=args[i]
    if(/^(--(?:cd|profile)(?:=|$)|-[Cp])/.test(arg))throw new Error('请通过实例设置选择工作目录；CLI 参数不能改用其他 Profile')
    let override:string|undefined
    if(arg==='-c'||arg==='--config')override=args[++i]??''
    else if(arg.startsWith('--config='))override=arg.slice(9)
    else if(arg.startsWith('-c'))override=arg.slice(2).replace(/^=/,'')
    if(override!==undefined){
      const at=override.indexOf('=')
      if(at<1)throw new Error('CLI 配置覆盖需要 key=value')
      const key=override.slice(0,at).trim(),doc=new TomlDocument(key+'=""')
      const protectedKeys=['cli_auth_credentials_store','model_provider','model_providers','openai_base_url','forced_login_method','forced_chatgpt_workspace_id','profile','profiles']
      if(protectedKeys.some(root=>doc.raw([root])!==null||doc.children([root]).length))throw new Error('CLI 参数不能覆盖受管账号、Provider 或凭据存储，请在账号与客户端配置页调整')
    }
  }
}

function validateApplication(profile:Pick<InstanceProfile,'clientType'|'extraArgs'|'workingDirectoryId'>,application:InstanceApplication):void {
  if(resolveAgentClientType(profile.clientType)!==resolveAgentClientType(application.clientType))throw new Error('实例客户端与所选程序不兼容')
  if(application.kind==='cli')validateCodexCliArgs(profile.extraArgs)
  if(profile.workingDirectoryId&&application.kind!=='cli')throw new Error('自定义工作目录仅用于 CLI 实例，桌面工作区请在客户端内选择')
}

function validateAccount(profile:Pick<InstanceProfile,'clientType'|'connectionMode'|'model'>,account:Pick<Account,'kind'|'wireApi'|'models'>):void {
  resolveAgentClientType(profile.clientType)
  const result=accountCompatibility(profile.clientType,account,{connectionMode:profile.connectionMode??'local_api',model:profile.model})
  if(!result.compatible)throw new Error(result.reason)
}

function copiedSessionProvider(profile:Pick<InstanceProfile,'clientType'|'connectionMode'>,account:Pick<Account,'kind'>):string {
  resolveAgentClientType(profile.clientType)
  return profile.connectionMode==='native'?(account.kind==='api_key'?nativeProvider:'openai'):'cml_instance'
}

export function codexDesktopEnvironment(source:NodeJS.ProcessEnv,route?:InstanceNetworkRoute):NodeJS.ProcessEnv {
  const env={...source}
  for(const key of Object.keys(env))if(/^(?:CODEX_|CML_TEST_|CML_TEMP_LOGIN_|CML_CODEX_SPEED_MENU_|ELECTRON_|NODE_|OPENAI_|npm_config_)/.test(key)||['__CFBundleIdentifier','XPC_SERVICE_NAME'].includes(key))delete env[key]
  return applyNetworkRouteEnvironment(env,route)
}

export function codexMacLaunchArgs(plan:DesktopPlan,args:readonly string[]=plan.args):string[] {
  resolveAgentClientType(plan.clientType)
  const hook=plan.tempLoginHook
  if(hook&&[hook.script,hook.capture].some(value=>/[\r\n\0"\\]/.test(value)))throw new Error('临时登录路径包含不支持的字符')
  if(plan.speedMenuHook&&plan.desktopLocaleHook)throw new Error('同一实例只能加载一份组合界面兼容脚本')
  const speed=plan.speedMenuHook??plan.desktopLocaleHook
  if(speed&&[speed.script,speed.manifest,speed.statusLog,...Object.values(speed.env)].some(value=>/[\r\n\0"\\]/.test(value)))throw new Error('速度菜单兼容路径包含不支持的字符')
  if(speed?.transport&&speed.transport!=='preload'&&speed.transport!=='cdp')throw new Error('速度菜单兼容方式无效')
  if(speed?.transport==='cdp'&&plan.cdpPort!==undefined&&(!Number.isInteger(plan.cdpPort)||plan.cdpPort<1||plan.cdpPort>65535))throw new Error('CDP 调试端口无效')
  if(speed&&Object.keys(speed.env).some(key=>!/^CML_CODEX_SPEED_MENU_[A-Z_]+$/.test(key)))throw new Error('速度菜单启动环境无效')
  const scripts=[...(hook?[hook.script]:[]),...(speed&&speed.transport!=='cdp'?[speed.script]:[])]
  const cdp=Boolean(speed?.transport==='cdp')
  return ['-n','-a',plan.application,'--env',`CODEX_HOME=${plan.directory}`,'--env',`CODEX_ELECTRON_USER_DATA_PATH=${plan.desktopDirectory}`,
    ...Object.entries(networkRouteEnvironment(plan.networkRoute)).flatMap(([key,value])=>['--env',`${key}=${value}`]),
    ...(scripts.length?['--env',`NODE_OPTIONS=${scripts.map(script=>`--require="${script}"`).join(' ')}`]:[]),
    ...(hook?['--env',`CML_TEMP_LOGIN_CAPTURE=${hook.capture}`]:[]),
    ...(speed?Object.entries(speed.env).flatMap(([key,value])=>['--env',`${key}=${value}`]):[]),
    '--args',`--user-data-dir=${plan.desktopDirectory}`,`--cml-instance=${plan.nonce}`,...(cdp?[`--remote-debugging-port=${plan.cdpPort??0}`,'--remote-debugging-address=127.0.0.1']:[]),...managedDesktopNetworkArgs(args,plan.networkRoute)]
}

/**
 * Reserve a loopback port before LaunchServices starts Electron.  The listener
 * is closed immediately so Electron can bind it; the fixed value still avoids
 * the startup race caused by `--remote-debugging-port=0`, where the CDP client
 * only learns the port after the first renderer request has already started.
 */
export async function reserveCodexCdpPort():Promise<number> {
  return await new Promise((resolve,reject)=>{
    const server=createServer()
    const fail=(error:Error)=>{try{server.close()}catch{};reject(error)}
    server.once('error',fail)
    server.listen({host:'127.0.0.1',port:0},()=>{
      const address=server.address()
      if(!address||typeof address==='string'||!Number.isInteger(address.port)||address.port<1){fail(new Error('CDP 调试端口无效'));return}
      server.close(error=>error?reject(error):resolve(address.port))
    })
  })
}

export const codexInstanceAdapter={client:getAgentClient('codex'),applications,registerApplication,executable,launchRuntime,validateApplication,validateAccount,
  desktopEnvironment:codexDesktopEnvironment,macLaunchArgs:codexMacLaunchArgs,validateCliArgs:validateCodexCliArgs,copiedSessionProvider}

/** Add verified clients here, rather than branching in each lifecycle method. */
export function getInstanceClientAdapter(clientType:unknown) {
  resolveAgentClientType(clientType)
  return codexInstanceAdapter
}
