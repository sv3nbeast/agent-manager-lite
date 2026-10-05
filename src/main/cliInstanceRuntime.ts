// Codex CLI instances use the same isolated profile lifecycle as desktop ones.
// A private .command is opened through LaunchServices (no Apple Events access).
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chmodSync,existsSync,mkdirSync,rmdirSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {atomic,readBounded} from './clientConfig'
import {MacDesktopRuntime,type DesktopRuntime,type DesktopPlan,type DesktopProcess} from './instanceRuntime'
import {getInstanceClientAdapter} from './codexInstanceAdapter'
export {validateCodexCliArgs as validateCliArgs} from './codexInstanceAdapter'

const exec=promisify(execFile)
export const shellQuote=(value:string)=>"'"+value.replace(/'/g,"'\"'\"'")+"'"
const marker=(plan:DesktopPlan)=>`--cml-instance=${plan.nonce}`
export function cliLaunchFiles(plan:DesktopPlan){
  const prefix=join(plan.desktopDirectory,`cli-${plan.nonce}`)
  return {script:prefix+'.command',permit:prefix+'.permit',claim:prefix+'.claimed',record:prefix+'.process'}
}
export function cliLaunchScript(plan:DesktopPlan):string {
  getInstanceClientAdapter(plan.clientType).validateCliArgs(plan.args)
  const files=cliLaunchFiles(plan),q=shellQuote
  // Claim is atomic. Write the process identity before consuming the permit,
  // so cancellation can revoke a late Terminal launch without a hidden child.
  return ['#!/bin/bash','set -e',`/bin/mkdir ${q(files.claim)} || exit 1`,
    `printf '%s\\n%s\\n' "$$" "$(LC_ALL=C /bin/ps -p $$ -o lstart=)" > ${q(files.record+'.tmp')}`,
    `/bin/mv ${q(files.record+'.tmp')} ${q(files.record)}`,`/bin/rmdir ${q(files.permit)} || exit 1`,
    'for key in $(compgen -e); do case "$key" in CODEX_*|CML_TEST_*|ELECTRON_*|NODE_*|OPENAI_*|npm_config_*|__CFBundleIdentifier|XPC_SERVICE_NAME) unset "$key";; esac; done',
    ...(plan.cliPackage?[`export CODEX_MANAGED_PACKAGE_ROOT=${q(plan.cliPackage.root)}`,`export CODEX_MANAGED_BY_${plan.cliPackage.manager.toUpperCase().replace('-','_')}=1`]:[]),
    `export CODEX_HOME=${q(plan.directory)}`,`cd -- ${q(plan.workingDirectory)}`,
    `exec -a ${q(marker(plan))} ${q(plan.executable)} ${plan.args.map(q).join(' ')}`,''].join('\n')
}
export async function openCliTerminal(script:string):Promise<void> {
  await exec('/usr/bin/open',['-a','Terminal',script],{timeout:15_000,maxBuffer:4096})
}
async function processTextFiles(pid:number):Promise<string>{
  // lsof escapes non-ASCII filenames under the C locale; compare UTF-8 paths
  // without changing the locale inherited by the launched client.
  return (await exec('/usr/sbin/lsof',['-a','-p',String(pid),'-d','txt','-Fn'],{env:{...process.env,LC_ALL:'en_US.UTF-8'},timeout:3000,maxBuffer:1024*1024})).stdout
}
async function processIdentity(pid:number):Promise<{started:string;args:string}|undefined>{
  try{
    for(let attempt=0;;attempt++){
      const result=await exec('/bin/ps',['-ww','-p',String(pid),'-o','lstart=,stat=,args='],{env:{...process.env,LC_ALL:'C'},timeout:3000,maxBuffer:128*1024})
      const line=result.stdout.trim(),match=line.match(/^(.{24})\s+(\S+)(?:\s+(.*))?$/)
      if(!match)throw new Error('Invalid process snapshot')
      // A zombie has finished execution even while its parent has not reaped
      // the PID. kill(pid, 0) still succeeds and argv no longer has our nonce.
      if(match[2].startsWith('Z'))return undefined
      // The E modifier means still exiting: wait for Z/disappearance before allowing
      // profile recovery, including the client's final credential writes.
      if(match[2].includes('E')){
        if(attempt>=10)throw new Error('Process is still exiting')
        await delay(50);continue
      }
      if(!match[3])throw new Error('Invalid process arguments')
      return {started:match[1],args:match[3]}
    }
  }catch(error){
    try{process.kill(pid,0)}catch(cause){if((cause as NodeJS.ErrnoException).code==='ESRCH')return undefined}
    throw new Error('无法确认 CLI 进程状态，尚未恢复登录配置')
  }
}
export class MacCliRuntime implements DesktopRuntime {
  constructor(private readonly open:(script:string)=>Promise<void>=openCliTerminal,private readonly textFiles:(pid:number)=>Promise<string>=processTextFiles){}
  private supported(){if(process.platform!=='darwin')throw new Error('CLI 终端实例当前仅在 macOS 接入')}
  private record(plan:DesktopPlan):DesktopProcess|undefined {
    const raw=readBounded(cliLaunchFiles(plan).record,512)
    if(raw===null)return undefined
    const [pid,started]=raw.trim().split('\n').map(value=>value.trim())
    if(!/^\d+$/.test(pid)||!Number.isSafeInteger(Number(pid))||Number(pid)<2||!started||started.length!==24)throw new Error('CLI 进程记录损坏，已保留实例文件')
    return {pid:Number(pid),started}
  }
  private async owned(plan:DesktopPlan,allowShell=false):Promise<DesktopProcess|undefined> {
    const record=this.record(plan);if(!record)return
    const current=await processIdentity(record.pid)
    if(!current||current.started!==record.started)return
    if(current.args.startsWith(marker(plan)+' ')||current.args===marker(plan)){
      // argv[0] is deliberately the nonce, so ps comm cannot prove the binary.
      let files:string
      try{files=await this.textFiles(record.pid)}
      catch{const next=await processIdentity(record.pid);if(!next||next.started!==record.started)return;throw new Error('无法核对 CLI 程序，尚未恢复登录配置')}
      if(files.split('\n').includes('n'+plan.executable))return record
      // A successful mapping snapshot can lose its text files during exit.
      // Restore only after rechecking that this recorded owner is gone.
      const next=await processIdentity(record.pid)
      if(!next||next.started!==record.started)return
      throw new Error('CLI 进程与登记的程序不一致，已保留实例文件')
    }
    if(allowShell&&current.args===`/bin/bash ${cliLaunchFiles(plan).script}`)return record
    throw new Error('CLI 启动进程状态不明确，已保留实例文件')
  }
  async find(plan:DesktopPlan):Promise<DesktopProcess|undefined>{getInstanceClientAdapter(plan.clientType);this.supported();return this.owned(plan)}
  async launch(plan:DesktopPlan,signal:AbortSignal):Promise<DesktopProcess>{
    getInstanceClientAdapter(plan.clientType).validateCliArgs(plan.args)
    this.supported();signal.throwIfAborted()
    const files=cliLaunchFiles(plan)
    mkdirSync(files.permit,{mode:0o700})
    atomic(files.script,cliLaunchScript(plan));chmodSync(files.script,0o700)
    try{await this.open(files.script)}catch{throw new Error('无法打开 CLI 终端，请检查所选程序和 Terminal 应用')}
    const end=Date.now()+10_000
    while(Date.now()<end){
      if(signal.aborted){await this.stop(plan);throw new Error('CLI 实例启动已取消')}
      if(!existsSync(files.permit)){
        try{const child=await this.owned(plan);if(child)return child}catch(error){
          // The acknowledged bash PID may be between permit consumption and exec.
          if(!await this.owned(plan,true))throw error
        }
        if(this.record(plan)&&!await this.owned(plan,true))throw new Error('CLI 已退出，请在终端查看启动错误或命令结果')
      }
      await delay(50)
    }
    throw new Error('CLI 未完成启动，请检查终端；本次启动许可将撤销')
  }
  async stop(plan:DesktopPlan):Promise<void>{
    getInstanceClientAdapter(plan.clientType)
    this.supported();const files=cliLaunchFiles(plan)
    let revoked=false
    try{rmdirSync(files.permit);revoked=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    if(!revoked){
      if(existsSync(files.script)&&!this.record(plan))throw new Error('CLI 启动许可与进程记录不一致，已保留文件')
      const child=await this.owned(plan,true)
      if(child){
        const signal=async(value:NodeJS.Signals)=>{const current=await this.owned(plan,true);if(current?.pid===child.pid&&current.started===child.started){try{process.kill(child.pid,value)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}}}
        await signal('SIGTERM')
        for(let i=0;i<50&&await this.owned(plan,true);i++)await delay(100)
        if(await this.owned(plan,true))await signal('SIGKILL')
        for(let i=0;i<20&&await this.owned(plan,true);i++)await delay(100)
        if(await this.owned(plan,true))throw new Error('CLI 仍在运行，尚未恢复登录配置')
      }
    }
    rmSync(files.script,{force:true});rmSync(files.record,{force:true});rmSync(files.record+'.tmp',{force:true})
    try{rmdirSync(files.claim)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  async focus():Promise<void>{throw new Error('CLI 在 Terminal 中运行，请从终端窗口继续会话')}
}
export class MacInstanceRuntime implements DesktopRuntime {
  constructor(private readonly desktop:DesktopRuntime=new MacDesktopRuntime(),private readonly cli:DesktopRuntime=new MacCliRuntime()){}
  private service(plan:DesktopPlan){getInstanceClientAdapter(plan.clientType);return plan.mode==='cli'?this.cli:this.desktop}
  find(plan:DesktopPlan){return this.service(plan).find(plan)}
  launch(plan:DesktopPlan,signal:AbortSignal){return this.service(plan).launch(plan,signal)}
  stop(plan:DesktopPlan){return this.service(plan).stop(plan)}
  focus(plan:DesktopPlan){return this.service(plan).focus(plan)}
}
