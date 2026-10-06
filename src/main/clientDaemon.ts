// Profile-scoped socket probing adapted from Cockpit codex_cli_daemon.rs.
// Connect and immediately close. Never send a command, restart, or kill a daemon.
import {lstatSync,realpathSync} from 'node:fs'
import {join,isAbsolute} from 'node:path'
import {createConnection,type Socket} from 'node:net'

export type ClientDaemonState='not_detected'|'running'|'unavailable'|'unsupported'|'cancelled'
export async function probeClientDaemon(directory:string,signal?:AbortSignal):Promise<ClientDaemonState> {
  const states:ClientDaemonState[]=[]
  for(const [folder,name]of [['app-server-control','app-server-control.sock'],['ipc','ipc.sock']]){
    const state=await probeClientSocket(directory,folder,name,signal)
    if(['running','cancelled','unsupported'].includes(state))return state
    states.push(state)
  }
  return states.includes('unavailable')?'unavailable':'not_detected'
}
async function probeClientSocket(directory:string,folderName:string,socketName:string,signal?:AbortSignal):Promise<ClientDaemonState> {
  if(signal?.aborted)return 'cancelled'
  if(process.platform!=='darwin'&&process.platform!=='linux')return 'unsupported'
  // The caller supplies an already registered directory capability, not a raw
  // renderer path. Do not follow a substituted control directory or socket.
  const control=join(directory,folderName),path=join(control,socketName)
  try{
    if(!isAbsolute(directory)||realpathSync(directory)!==directory||!lstatSync(directory).isDirectory())return 'unavailable'
    const folder=lstatSync(control)
    if(folder.isSymbolicLink()||!folder.isDirectory())return 'unavailable'
    const socket=lstatSync(path)
    if(socket.isSymbolicLink()||!socket.isSocket())return 'unavailable'
    if(Buffer.byteLength(path)>=(process.platform==='darwin'?104:108))return 'unavailable'
  }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'not_detected':'unavailable'}
  return new Promise(resolve=>{
    let socket:Socket|undefined,finished=false
    const finish=(state:ClientDaemonState)=>{
      if(finished)return
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);socket?.destroy();resolve(state)
    }
    const cancel=()=>finish('cancelled')
    const timer=setTimeout(()=>finish('unavailable'),250)
    signal?.addEventListener('abort',cancel,{once:true})
    if(signal?.aborted){cancel();return}
    try{
      socket=createConnection({path})
      socket.once('connect',()=>finish('running'))
      socket.once('error',(error:NodeJS.ErrnoException)=>finish(error.code==='ENOENT'||error.code==='ECONNREFUSED'?'not_detected':'unavailable'))
    }catch{finish('unavailable')}
  })
}

export function assertClientDaemonStopped(state:ClientDaemonState):void {
  if(state==='running')throw new Error('所选目录的 Codex 后台进程仍在运行，请先关闭使用此目录的客户端及 CLI daemon，再重新预览。未写入账号或恢复记录。')
  if(state==='unavailable')throw new Error('无法确认所选目录的 Codex 后台进程状态，请检查控制套接字的路径和权限后重试。未写入账号或恢复记录。')
  if(state==='cancelled')throw new Error('账号切换检查已取消，未写入账号或恢复记录')
}
