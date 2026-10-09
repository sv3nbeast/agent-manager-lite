import {existsSync,lstatSync,realpathSync} from 'node:fs'
import {isAbsolute,join,relative,sep} from 'node:path'
import {resolveCliRuntime} from './cliResolver'

function desktopRoot(application:string):void {
  if(!isAbsolute(application)||!application.endsWith('.app')||realpathSync(application)!==application)throw new Error('Codex 应用路径已变化，请重新选择')
  const stat=lstatSync(application)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('请选择 Codex 桌面应用')
}

export function codexDesktopExecutable(application:string):string {
  desktopRoot(application)
  const executable=['Codex','ChatGPT'].map(name=>join(application,'Contents','MacOS',name)).find(path=>existsSync(path))
  if(!executable)throw new Error('所选应用缺少 Codex 或 ChatGPT 主程序')
  const stat=lstatSync(executable)
  if(!stat.isFile()||stat.isSymbolicLink()||!(stat.mode&0o111)||realpathSync(executable)!==executable)throw new Error('所选应用缺少可执行的 Codex 主程序')
  return executable
}

export function codexBundledCli(application:string):string {
  desktopRoot(application)
  // New desktop bundles wrap this native binary in codex-cli/bin/codex. Resolve
  // the verified native location directly; never execute a selected shell script.
  const candidate=[join(application,'Contents','Resources','codex-cli','CodexCLI.app','Contents','MacOS','codex'),
    join(application,'Contents','Resources','codex')].find(path=>existsSync(path))
  if(!candidate)throw new Error('所选桌面应用缺少内置 Codex 程序，请更新应用或选择 Codex CLI')
  const executable=resolveCliRuntime(candidate).executable,inside=relative(application,executable)
  if(isAbsolute(inside)||inside==='..'||inside.startsWith('..'+sep))throw new Error('内置 Codex 程序指向应用目录之外，请重新选择')
  return executable
}
