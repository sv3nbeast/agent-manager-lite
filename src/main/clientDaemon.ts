// Profile-scoped socket probing adapted from Cockpit codex_cli_daemon.rs.
// Connect and immediately close. Never send a command, restart, or kill a daemon.
import {lstatSync,realpathSync,symlinkSync,unlinkSync} from 'node:fs'
import {join,isAbsolute} from 'node:path'
import {randomBytes} from 'node:crypto'
import {createConnection,type Socket} from 'node:net'

// macOS sockaddr_un.sun_path holds 104 bytes, Linux 108. connect() can only
// use a path that fits; a longer path cannot be reached directly.
const SUN_PATH_LIMIT=process.platform==='darwin'?104:108
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
  }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'not_detected':'unavailable'}
  // A socket whose absolute path exceeds sun_path cannot be reached by connect()
  // directly even though a live daemon may have bound it from a shorter relative
  // path. Probe liveness through a short-lived symlink so an over-long path never
  // masks a dead socket (whose file lingers after the client exits) as
  // 'unavailable' — which would permanently block stop and native restore.
  if(Buffer.byteLength(path)>=SUN_PATH_LIMIT)return probeViaShortLink(path,signal)
  return connectProbe(path,signal)
}
// Connect through a random short-named symlink to the already validated socket.
// connect() copies only the symlink path into sun_path and resolves it in the
// kernel, so the real over-long target is still reached.
async function probeViaShortLink(target:string,signal?:AbortSignal):Promise<ClientDaemonState> {
  if(signal?.aborted)return 'cancelled'
  // Keep the link under /tmp with a short name: connect() copies this string
  // into sun_path, so it must fit the limit regardless of how deep the real
  // socket lives. /tmp is always present on the only platforms probed here.
  let link:string|undefined
  for(let attempt=0;attempt<5&&!link;attempt++){
    const candidate=`/tmp/.cml-dp-${randomBytes(8).toString('hex')}.sock`
    if(Buffer.byteLength(candidate)>=SUN_PATH_LIMIT)return 'unavailable'
    try{symlinkSync(target,candidate);link=candidate}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')return 'unavailable'}
  }
  if(!link)return 'unavailable'
  try{return await connectProbe(link,signal)}
  finally{try{unlinkSync(link)}catch{/* best-effort cleanup of our own probe symlink */}}
}
function connectProbe(connectPath:string,signal?:AbortSignal):Promise<ClientDaemonState> {
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
      socket=createConnection({path:connectPath})
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
