import {randomUUID} from 'node:crypto'
import {execFile as execFileCallback} from 'node:child_process'
import {chmodSync,mkdtempSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import type {ClaudeResumeSelection,DefaultClaudeSessionResumePreview} from '../shared/sessions'
import {captureClaudeExecutableIdentity,validateClaudeExecutableIdentity} from './claudeCodeCapability'
import {detectClaudeCodeApplications} from './claudeCodeInstanceAdapter'
import {validateClaudeNativeProgram} from './claudeCodeRuntime'
import {openCliTerminal,shellQuote} from './cliInstanceRuntime'
import type {SessionCatalog} from './sessions'

const execFile=promisify(execFileCallback)
const ttlMs=5*60_000
type Selection=Awaited<ReturnType<SessionCatalog['defaultClaudeResume']>>
interface Pending {ticket:string;selection:Selection;request:ClaudeResumeSelection;executable:string;identity:ReturnType<typeof captureClaudeExecutableIdentity>;expiresAt:number}

export function defaultClaudeResumeScript(input:{scriptPath:string;directory:string;homeDirectory:string;configCanonicalPath:string;configDevice:number;configInode:number;projectsDirectory:string;projectsDevice:number;projectsInode:number;projectDirectory:string;projectDevice:number;projectInode:number;executable:string;executableDevice:number;executableInode:number;executableSize:number;executableSha256:string;cwd:string;cwdCanonicalPath:string;cwdDevice:number;cwdInode:number;sessionPath:string;sessionDevice:number;sessionInode:number;sessionSize:number;sessionSha256:string;sessionId:string}):string {
  const q=shellQuote
  // Keep the user's default ~/.claude profile and normal proxy environment.
  // Remove inherited manager/API overrides so neither can impersonate the
  // default account or redirect this continuation to a managed provider.
  return [
    '#!/bin/bash','set +e',
    'for key in $(compgen -e); do case "$key" in CLAUDE_*|ANTHROPIC_*) unset "$key";; esac; done',
    'export HOME='+q(input.homeDirectory),
    'trap '+q('/bin/rm -f -- '+q(input.scriptPath)+'; /bin/rmdir -- '+q(input.directory)+' 2>/dev/null || true')+' EXIT',
    'fail(){ echo "$1" >&2; exit 73; }',
    'cd -- '+q(input.cwd)+' || fail "Claude 项目目录不可用，请重新预览。"',
    '[ "$(/bin/pwd -P)" = '+q(input.cwdCanonicalPath)+' ] || fail "Claude 项目目录已变化，请重新预览。"',
    '[ "$(/usr/bin/stat -f %d:%i .)" = '+q(input.cwdDevice+':'+input.cwdInode)+' ] || fail "Claude 项目目录已变化，请重新预览。"',
    '[ "$(cd -- "$HOME/.claude" 2>/dev/null && pwd -P)" = '+q(input.configCanonicalPath)+' ] || fail "Claude 默认配置目录已变化，请重新预览。"',
    '[ "$(/usr/bin/stat -f %d:%i "$HOME/.claude")" = '+q(input.configDevice+':'+input.configInode)+' ] || fail "Claude 默认配置目录已变化，请重新预览。"',
    '[ "$(/usr/bin/stat -f %d:%i '+q(input.projectsDirectory)+')" = '+q(input.projectsDevice+':'+input.projectsInode)+' ] || fail "Claude projects 目录已变化，请重新预览。"',
    '[ "$(/usr/bin/stat -f %d:%i '+q(input.projectDirectory)+')" = '+q(input.projectDevice+':'+input.projectInode)+' ] || fail "Claude 会话项目目录已变化，请重新预览。"',
    '[ ! -L '+q(input.sessionPath)+' ] && [ "$(/usr/bin/stat -f %d:%i:%z '+q(input.sessionPath)+')" = '+q(input.sessionDevice+':'+input.sessionInode+':'+input.sessionSize)+' ] || fail "Claude 会话文件已变化，请刷新会话列表。"',
    'sha=$(/usr/bin/shasum -a 256 '+q(input.sessionPath)+')',
    'sha=${sha%% *}',
    '[ "$sha" = '+q(input.sessionSha256)+' ] || fail "Claude 会话内容已变化，请刷新会话列表。"',
    '[ "$(/usr/bin/stat -f %d:%i:%z '+q(input.executable)+')" = '+q(input.executableDevice+':'+input.executableInode+':'+input.executableSize)+' ] || fail "Claude Code CLI 已更新，请重新预览。"',
    'sha=$(/usr/bin/shasum -a 256 '+q(input.executable)+')',
    'sha=${sha%% *}',
    '[ "$sha" = '+q(input.executableSha256)+' ] || fail "Claude Code CLI 内容已变化，请重新预览。"',
    '/usr/bin/codesign --verify --strict '+q(input.executable)+' >/dev/null 2>&1 || fail "Claude Code CLI 签名已变化，请重新检测。"',
    'signature=$(/usr/bin/codesign -dv --verbose=4 '+q(input.executable)+' 2>&1) || fail "Claude Code CLI 签名已变化，请重新检测。"',
    'printf "%s\\n" "$signature" | /usr/bin/grep -Fqx "Identifier=com.anthropic.claude-code" || fail "Claude Code CLI 不是 Anthropic 官方程序。"',
    'printf "%s\\n" "$signature" | /usr/bin/grep -Fqx "TeamIdentifier=Q6L2SF6YDW" || fail "Claude Code CLI 签名已变化，请重新检测。"',
    'printf "%s\\n" "$signature" | /usr/bin/grep -Fq "Authority=Developer ID Application: Anthropic PBC" || fail "Claude Code CLI 签名已变化，请重新检测。"',
    'matches=$(/usr/bin/find '+q(input.projectsDirectory)+' -mindepth 1 -maxdepth 1 -type d -name "ssh-*" -prune -o -mindepth 2 -maxdepth 2 -name '+q(input.sessionId+'.jsonl')+' -print | /usr/bin/wc -l | /usr/bin/tr -d " ") || fail "Claude projects 目录无法重新核验。"',
    '[ "$matches" = 1 ] || fail "Claude 会话 ID 已出现多个来源，请刷新并核对文件。"',
    q(input.executable)+' --fork-session --resume '+q(input.sessionId),
    'status=$?',
    'trap - EXIT',
    '/bin/rm -f -- '+q(input.scriptPath),
    '/bin/rmdir -- '+q(input.directory)+' 2>/dev/null || true',
    'exit "$status"','',
  ].join('\n')
}

export async function verifyDefaultClaudeResumeCli(executable:string):Promise<void>{
  validateClaudeNativeProgram(executable)
  await execFile('/usr/bin/codesign',['--verify','--strict',executable],{timeout:10_000,maxBuffer:32*1024,windowsHide:true})
  const signature=await execFile('/usr/bin/codesign',['-dv','--verbose=4',executable],{timeout:10_000,maxBuffer:32*1024,windowsHide:true}).then(result=>result.stderr)
  if(!signature.includes('Identifier=com.anthropic.claude-code')||!signature.includes('TeamIdentifier=Q6L2SF6YDW')||!signature.includes('Authority=Developer ID Application: Anthropic PBC'))throw new Error('继续默认会话只支持 Anthropic 签名的 Claude Code 原生 CLI')
  const {stdout='',stderr=''}=await execFile(executable,['--help'],{timeout:10_000,maxBuffer:128*1024,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??''},windowsHide:true})
  const help=stdout+'\n'+stderr
  if(!/(?:^|\s)--resume(?:\s|$)/m.test(help)||!/(?:^|\s)--fork-session(?:\s|$)/m.test(help))throw new Error('当前官方 Claude Code CLI 不支持安全分叉恢复；请更新 CLI 后重试')
}

/** Launches an isolated Terminal command with the user's default Claude profile.
 * It never goes through Instances, managed credentials, provider proxies or lifecycle control. */
export class ClaudeDefaultSessionResume {
  private readonly pending=new Map<string,Pending>()
  constructor(private readonly catalog:SessionCatalog,private readonly options:{home?:string;cliPath?:string;now?:()=>number;open?:(script:string)=>Promise<void>;verifyCli?:(executable:string)=>Promise<void>}={}){}
  private now(){return this.options.now?.()??Date.now()}
  private cli():string{
    if(this.options.cliPath)return this.options.cliPath
    const app=detectClaudeCodeApplications({home:this.options.home,path:process.env.PATH}).find(value=>value.kind==='cli')
    if(!app)throw new Error('未找到已安装的 Claude Code 官方原生 CLI')
    return app.path
  }
  async preview(input:ClaudeResumeSelection):Promise<DefaultClaudeSessionResumePreview>{
    if(process.platform!=='darwin')throw new Error('默认 Claude CLI 分叉当前支持 macOS')
    for(const [ticket,pending] of this.pending)if(pending.expiresAt<this.now())this.pending.delete(ticket)
    const selection=await this.catalog.defaultClaudeResume(input),executable=this.cli(),identity=captureClaudeExecutableIdentity(executable)
    await (this.options.verifyCli??verifyDefaultClaudeResumeCli)(executable)
    validateClaudeExecutableIdentity(identity)
    const ticket=randomUUID(),expiresAt=this.now()+ttlMs
    this.pending.set(ticket,{ticket,selection,request:{...input},executable,identity,expiresAt})
    return {ticket,sessionId:selection.sessionId,cwd:selection.cwd,cwdCandidates:[...selection.cwdCandidates],cliApplication:executable,forkSession:true}
  }
  async discard(ticket:string):Promise<void>{this.pending.delete(ticket)}
  async start(ticket:string):Promise<{opened:true}>{
    const pending=this.pending.get(ticket)
    if(!pending||pending.expiresAt<this.now())throw new Error('默认 Claude 会话预览已过期，请重新预览')
    this.pending.delete(ticket)
    validateClaudeExecutableIdentity(pending.identity,pending.executable)
    await (this.options.verifyCli??verifyDefaultClaudeResumeCli)(pending.executable)
    validateClaudeExecutableIdentity(pending.identity,pending.executable)
    const current=await this.catalog.defaultClaudeResume(pending.request)
    if(current.location.sourceId!==pending.selection.location.sourceId||current.sourceId!==pending.selection.sourceId||current.cwd!==pending.selection.cwd||current.cwdCanonicalPath!==pending.selection.cwdCanonicalPath||current.cwdDevice!==pending.selection.cwdDevice||current.cwdInode!==pending.selection.cwdInode||current.homeDirectory!==pending.selection.homeDirectory||current.configCanonicalPath!==pending.selection.configCanonicalPath||current.configDevice!==pending.selection.configDevice||current.configInode!==pending.selection.configInode||current.projectsDevice!==pending.selection.projectsDevice||current.projectsInode!==pending.selection.projectsInode||current.projectDevice!==pending.selection.projectDevice||current.projectInode!==pending.selection.projectInode)throw new Error('默认 Claude 会话文件、项目目录或配置目录已变化，请刷新后重试')
    const directory=mkdtempSync(join(tmpdir(),'aml-claude-default-resume-'))
    chmodSync(directory,0o700)
    let script=''
    try{
      if(this.cli()!==pending.executable)throw new Error('默认 Claude Code CLI 已变化，请重新预览')
      const directoryStat=statSync(current.location.cwd!)
      if(realpathSync(current.location.cwd!)!==current.cwdCanonicalPath||directoryStat.dev!==current.cwdDevice||directoryStat.ino!==current.cwdInode)throw new Error('会话项目目录已被替换，请重新预览')
      script=join(directory,'continue.command')
      const location=current.location
      writeFileSync(script,defaultClaudeResumeScript({scriptPath:script,directory,homeDirectory:current.homeDirectory,configCanonicalPath:current.configCanonicalPath,configDevice:location.source.config.device,configInode:location.source.config.inode,projectsDirectory:location.source.projects.canonicalPath,projectsDevice:location.source.projects.device,projectsInode:location.source.projects.inode,projectDirectory:location.project.canonicalPath,projectDevice:location.project.device,projectInode:location.project.inode,executable:pending.executable,executableDevice:pending.identity.device,executableInode:pending.identity.inode,executableSize:pending.identity.size,executableSha256:pending.identity.sha256,cwd:location.cwd!,cwdCanonicalPath:current.cwdCanonicalPath,cwdDevice:current.cwdDevice,cwdInode:current.cwdInode,sessionPath:location.path,sessionDevice:location.device,sessionInode:location.inode,sessionSize:location.size,sessionSha256:location.sha256,sessionId:current.sessionId}),{flag:'wx',mode:0o700})
      chmodSync(script,0o700)
      await (this.options.open??openCliTerminal)(script)
      return {opened:true}
    }catch(error){
      if(script)rmSync(script,{force:true});rmSync(directory,{recursive:true,force:true})
      throw error
    }
  }
}
