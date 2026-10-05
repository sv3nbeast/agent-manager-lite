import {createHash} from 'node:crypto'
import {lstatSync,openSync,closeSync,readFileSync,writeSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import {dirname,join} from 'node:path'
import type {CodexSpeedMenuHook} from './codexSpeedMenu'

type Replacement={begin:string;end:string;before:string;after:string}
type Manifest={version:1;home:string;desktopDirectory:string;executable:string;nonce:string;url:string;sourceSha256:string;patchedSha256:string;enhancements:'speed'|'locale'|'speed-locale';replacements:Replacement[];replacementCount:number;replacementsSha256:string;patchedBody?:string;patchedBodySha256?:string}
type StatusKind='hook-loaded'|'patched'|'original'|'disabled'

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const privateFile=(path:string):boolean=>{
  try{
    const stat=lstatSync(path)
    return stat.isFile()&&!stat.isSymbolicLink()&&(!process.getuid||stat.uid===process.getuid())&&!(stat.mode&0o022)
  }catch{return false}
}
const privateDirectory=(path:string):boolean=>{
  try{
    const stat=lstatSync(path)
    return stat.isDirectory()&&!stat.isSymbolicLink()&&(!process.getuid||stat.uid===process.getuid())&&!(stat.mode&0o022)
  }catch{return false}
}

function status(path:string,scope:{home:string;desktopDirectory:string;executable:string;nonce:string;pid?:number},kind:StatusKind,reason?:string):void {
  try{
    if(!privateDirectory(join(path,'..'))||!privateFile(path))return
    const fd=openSync(path,'a')
    try{
      const stat=lstatSync(path)
      if(!stat.isFile()||stat.size>128*1024||stat.mode&0o022)return
      writeSync(fd,JSON.stringify({time:Date.now(),...(scope.pid===undefined?{}:{pid:scope.pid}),mainThread:true,threadId:0,nonce:scope.nonce,executable:scope.executable,directory:scope.home,kind,...(reason?{reason}:{})})+'\n')
    }finally{closeSync(fd)}
  }catch{/* A status failure must never stop the client. */}
}

function readManifest(hook:CodexSpeedMenuHook):Manifest {
  if(!hook.manifestSha256||!privateFile(hook.manifest))throw new Error('manifest')
  const body=readFileSync(hook.manifest,'utf8')
  if(body.length>32768||hash(body)!==hook.manifestSha256)throw new Error('manifest')
  const value=JSON.parse(body) as Manifest
  if(value.version!==1||!Array.isArray(value.replacements)||value.replacements.length!==value.replacementCount||hash(JSON.stringify(value.replacements))!==value.replacementsSha256)throw new Error('manifest')
  if(hook.transport==='cdp'){
    const expectedBody=join(dirname(hook.manifest),'patched.js')
    if(value.patchedBody!==expectedBody||typeof value.patchedBodySha256!=='string'||!privateFile(expectedBody)||hash(readFileSync(expectedBody))!==value.patchedBodySha256)throw new Error('manifest body')
  }
  for(const replacement of value.replacements){
    if(!replacement||typeof replacement.begin!=='string'||typeof replacement.end!=='string'||typeof replacement.before!=='string'||typeof replacement.after!=='string')throw new Error('manifest')
  }
  return value
}

function applyPatch(source:string,replacements:readonly Replacement[]):string {
  let result=source
  for(const replacement of replacements){
    const start=result.indexOf(replacement.begin)
    if(start<0||result.indexOf(replacement.begin,start+1)!==-1)throw new Error('patch start')
    const end=result.indexOf(replacement.end,start+replacement.begin.length)
    if(end<0)throw new Error('patch end')
    const body=result.slice(start,end)
    if(body.split(replacement.before).length!==2)throw new Error('patch count')
    result=result.slice(0,start)+body.replace(replacement.before,replacement.after)+result.slice(end)
  }
  return result
}

function headerValue(headers:readonly {name:string;value?:string}[],name:string):string|undefined {
  return headers.find(value=>value.name.toLowerCase()===name)?.value
}

function patchedHeaders(headers:readonly {name:string;value?:string}[],body:Buffer,digest:string):{name:string;value:string}[] {
  const removed=new Set(['content-length','content-md5','digest','content-digest','etag','last-modified'])
  const result=headers.filter(value=>!removed.has(value.name.toLowerCase())).map(value=>({name:value.name,value:value.value??''}))
  if(!result.some(value=>value.name.toLowerCase()==='content-type'))result.push({name:'content-type',value:'text/javascript'})
  result.push({name:'content-length',value:String(body.byteLength)},{name:'etag',value:`"${digest}"`})
  return result
}

type CdpMessage={id?:number;method?:string;params?:any;result?:any;error?:{message?:string};sessionId?:string}
type CdpSocket=WebSocket & {addEventListener(type:'open'|'message'|'close'|'error',listener:(event:any)=>void,options?:{once?:boolean}):void}

// The official desktop uses a memory router, so native history.state does not
// select the product surface. Wait for its application-ready message, then send
// the same host navigation event as the official Codex entry point. The router
// handlers are registered before the app-ready effect. Only a root launch is
// adapted, once per document; explicit initial routes and later Work choices
// retain their own navigation state.
export const codexStartupNavigationSource=`(() => {
  try {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof window.dispatchEvent !== "function") return;
    let scheduled = false, sent = false;
    const eventName = "codex-message-from-view";
    const rootLaunch = () => {
      if (location.pathname !== "/" && location.pathname !== "/index.html") return false;
      const queryRoute = new URL(location.href).searchParams.get("initialRoute")?.trim();
      const metaRoute = document.querySelector('meta[name="initial-route"]')?.content?.trim();
      return (!queryRoute || queryRoute === "/") && (!metaRoute || metaRoute === "/");
    };
    const ready = event => {
      if (sent || scheduled || event?.detail?.type !== "electron-set-window-mode" || event.detail.mode !== "app") return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (sent) return;
        try {
          if (!rootLaunch()) { window.removeEventListener(eventName, ready); return; }
          window.dispatchEvent(new MessageEvent("message", { data: {
            type: "navigate-to-route", path: "/", replace: true,
            state: { codexAppMode: "codex", prefillComposerMode: "local" }
          } }));
          sent = true;
          window.removeEventListener(eventName, ready);
        } catch {}
      });
    };
    window.addEventListener(eventName, ready);
  } catch {}
})();`;

export interface CodexSpeedMenuCdpOptions {
  hook:CodexSpeedMenuHook
  directory:string
  desktopDirectory:string
  executable:string
  nonce:string
  pid?:number
  /** Fixed loopback port passed to Electron before launch. */
  cdpPort?:number
}

export function markCodexSpeedMenuCdpFailure(options:CodexSpeedMenuCdpOptions):void {
  status(options.hook.statusLog,{home:options.directory,desktopDirectory:options.desktopDirectory,executable:options.executable,nonce:options.nonce,pid:options.pid},'disabled','cdp')
}

/**
 * Response-stage CDP adapter for Codex releases that disable Electron's
 * NODE_OPTIONS/--require fuse. It only touches the audited renderer asset and
 * returns the official bytes for every mismatch.
 */
export class CodexSpeedMenuCdpSession {
  private socket?:CdpSocket
  private nextId=0
  private readonly pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  private readonly attached=new Set<string>()
  private readonly attachedTargets=new Set<string>()
  private readonly pendingReload=new Set<string>()
  private closed=false
  private patched=false
  private readonly manifest:Manifest
  private readonly scope:{home:string;desktopDirectory:string;executable:string;nonce:string;pid?:number}

  constructor(private readonly options:CodexSpeedMenuCdpOptions){
    this.manifest=readManifest(options.hook)
    if(options.hook.transport!=='cdp'||this.manifest.executable!==options.executable||this.manifest.desktopDirectory!==options.desktopDirectory||this.manifest.home!==options.directory||this.manifest.nonce!==options.nonce)throw new Error('manifest scope')
    this.scope={home:options.directory,desktopDirectory:options.desktopDirectory,executable:options.executable,nonce:options.nonce,pid:options.pid}
  }

  setPid(pid:number):void { if(Number.isInteger(pid)&&pid>0)this.scope.pid=pid }

  private call(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
    if(!this.socket||this.socket.readyState!==WebSocket.OPEN) return Promise.reject(new Error('CDP closed'))
    const id=++this.nextId
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout'))},10_000)
      this.pending.set(id,{resolve,reject,timer})
      try{this.socket!.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error instanceof Error?error:new Error('CDP send failed'))}
    })
  }

  private safeWebSocket(value:unknown,port:number,kind:'browser'|'target'):string|undefined {
    if(typeof value!=='string')return
    try{
      const url=new URL(value)
      if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!==String(port))return
      if(kind==='browser'&&!url.pathname.startsWith('/devtools/browser/'))return
      if(kind==='target'&&!url.pathname.startsWith('/devtools/page/'))return
      return url.toString()
    }catch{return}
  }

  private async pageEndpoint(port:number):Promise<string|undefined>{
    try{
      const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(750)})
      if(!response.ok)return
      const targets=await response.json() as Array<{type?:unknown;webSocketDebuggerUrl?:unknown}>
      const target=targets.find(value=>(value.type==='page'||value.type==='webview')&&this.safeWebSocket(value.webSocketDebuggerUrl,port,'target'))
      return target?this.safeWebSocket(target.webSocketDebuggerUrl,port,'target'):undefined
    }catch{return}
  }

  private async endpoint():Promise<{url:string;mode:'browser'|'target'}>{
    let port=this.options.cdpPort
    let activeBody:string|undefined
    if(port===undefined){
      const active=join(this.options.desktopDirectory,'DevToolsActivePort')
      for(let i=0;i<120;i++){
        try{if(privateFile(active)){activeBody=readFileSync(active,'utf8');break}}catch{/* Chromium may be replacing the file. */}
        await delay(50)
      }
      if(!activeBody)throw new Error('CDP port file')
      const [portText]=activeBody.trim().split(/\r?\n/)
      port=Number(portText)
    }
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('CDP port')
    // Cockpit Tools connects to the browser websocket on the fixed loopback
    // port and enables auto-attach before the page target is created. This is
    // the only reliable way to catch Codex's first app-initial request.
    const deadline=Date.now()+10_000
    for(;Date.now()<deadline;){
      try{
        const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(750)})
        if(response.ok){
          const value=await response.json() as {webSocketDebuggerUrl?:unknown}
          const browser=this.safeWebSocket(value.webSocketDebuggerUrl,port,'browser')
          if(browser)return {url:browser,mode:'browser'}
        }
      }catch{/* The browser endpoint may not exist until Electron binds the port. */}
      const target=await this.pageEndpoint(port)
      if(target)return {url:target,mode:'target'}
      await delay(50)
    }
    throw new Error('CDP target')
  }

  private async reloadRoot(sessionId:string|undefined):Promise<void>{
    const key=sessionId??'direct'
    if(!this.pendingReload.has(key))return
    try{
      const frames=await this.call('Page.getFrameTree',{},sessionId)
      const url=frames.frameTree?.frame?.url
      if(typeof url!=='string'||!url.startsWith('app://-/'))return
      const state=await this.call('Runtime.evaluate',{expression:'document.readyState',returnByValue:true},sessionId)
      if(state.result?.value!=='complete'||!this.pendingReload.delete(key))return
      // Reloading while Electron's initial loadURL is unresolved rejects that
      // promise and opens its fatal startup dialog. Let did-finish-load settle
      // in the host before requesting our single renderer reload.
      await delay(25)
      await this.call('Page.reload',{ignoreCache:true},sessionId)
    }catch{}
  }

  private async configure(sessionId:string|undefined,targetInfo:any):Promise<void>{
    const key=sessionId??'direct'
    if(this.attached.has(key))return
    this.attached.add(key)
    if(typeof targetInfo?.targetId==='string')this.attachedTargets.add(targetInfo.targetId)
    const page=targetInfo?.type==='page'||targetInfo?.type==='webview'
    if(page){
        await this.call('Fetch.enable',{patterns:[{urlPattern:this.manifest.url+'*',requestStage:'Request'}]},sessionId)
        // Register the startup listener before the single early reload.
        // A release failure must not prevent the audited renderer response from
        // loading; the speed hook remains useful even on older CDP targets.
        try{
          await this.call('Page.enable',{},sessionId)
          await this.call('Page.addScriptToEvaluateOnNewDocument',{source:codexStartupNavigationSource},sessionId)
        }catch{}
    }
    // If the browser target already existed before the fixed-port handshake
    // completed, its first app:// request may have escaped interception. One
    // early reload after Fetch.enable closes that unavoidable launch window;
    // the request is then fulfilled from the verified patched bytes. This is
    // limited to the renderer target and runs at most once per target.
    if(page){
      this.pendingReload.add(key)
      // attachedToTarget.url is a snapshot. A completed existing document can
      // reload now; an initial document must first emit loadEventFired.
      await this.reloadRoot(sessionId)
    }
  }

  private async fulfill(sessionId:string|undefined,params:any,body:Buffer,headers:readonly {name:string;value?:string}[],digest:string):Promise<boolean>{
    const responseCode=Number.isInteger(params.responseStatusCode)?params.responseStatusCode:200
    try{
      await this.call('Fetch.fulfillRequest',{requestId:params.requestId,responseCode,responseHeaders:patchedHeaders(headers,body,digest),body:body.toString('base64')},sessionId)
      return true
    }catch{
      try{await this.call('Fetch.continueResponse',{requestId:params.requestId},sessionId)}catch{try{await this.call('Fetch.continueRequest',{requestId:params.requestId},sessionId)}catch{/* The target may have gone away. */}}
      return false
    }
  }

  private async continue(sessionId:string|undefined,requestId:string):Promise<void>{
    try{await this.call('Fetch.continueResponse',{requestId},sessionId)}catch{try{await this.call('Fetch.continueRequest',{requestId},sessionId)}catch{/* The target may have gone away. */}}
  }

  private async paused(sessionId:string|undefined,params:any):Promise<void>{
    if(params.request?.url!==this.manifest.url){try{await this.call('Fetch.continueRequest',{requestId:params.requestId},sessionId)}catch{};return}
    if(!Number.isInteger(params.responseStatusCode)){
      try{
        const body=readFileSync(String(this.manifest.patchedBody))
        if(hash(body)!==this.manifest.patchedBodySha256||hash(body)!==this.manifest.patchedSha256)throw new Error('patched body')
        if(!await this.fulfill(sessionId,params,body,[],this.manifest.patchedSha256))throw new Error('fulfill')
        this.patched=true;status(this.options.hook.statusLog,this.scope,'patched')
      }catch{status(this.options.hook.statusLog,this.scope,'original','cdpResponse');try{await this.call('Fetch.continueRequest',{requestId:params.requestId},sessionId)}catch{}}
      return
    }
    try{
      if(params.responseStatusCode!==200||headerValue(params.responseHeaders??[],'content-encoding')){await this.continue(sessionId,params.requestId);status(this.options.hook.statusLog,this.scope,'original','response');return}
      const body=readFileSync(String(this.manifest.patchedBody))
      if(hash(body)!==this.manifest.patchedBodySha256||hash(body)!==this.manifest.patchedSha256)throw new Error('patched body')
      const source=body.toString('utf8')
      if(!await this.fulfill(sessionId,params,body,params.responseHeaders??[],this.manifest.patchedSha256))throw new Error('fulfill')
      this.patched=true;status(this.options.hook.statusLog,this.scope,'patched')
    }catch{status(this.options.hook.statusLog,this.scope,'original','cdpResponse');await this.continue(sessionId,params.requestId)}
  }

  private async message(event:any):Promise<void>{
    let value:CdpMessage
    try{value=JSON.parse(typeof event.data==='string'?event.data:Buffer.from(event.data).toString('utf8'))}catch{return}
    if(value.id!==undefined){const task=this.pending.get(value.id);if(!task)return;this.pending.delete(value.id);clearTimeout(task.timer);if(value.error)task.reject(new Error(value.error.message||'CDP error'));else task.resolve(value.result);return}
    // Flattened target commands carry sessionId at the envelope level, while
    // Target.attachedToTarget carries it inside params.
    const sessionId=(value.sessionId??value.params?.sessionId) as string|undefined
    if(value.method==='Target.attachedToTarget'&&sessionId){await this.configure(sessionId,value.params.targetInfo);return}
    if(value.method==='Target.detachedFromTarget'&&sessionId){this.attached.delete(sessionId);this.pendingReload.delete(sessionId);return}
    if(value.method==='Page.loadEventFired'){await this.reloadRoot(sessionId);return}
    if(value.method==='Fetch.requestPaused'){await this.paused(sessionId,value.params)}
  }

  async start():Promise<void>{
    try{
      const endpoint=await this.endpoint()
      const socket=new WebSocket(endpoint.url) as CdpSocket
      this.socket=socket
      socket.addEventListener('message',event=>{void this.message(event).catch(()=>{markCodexSpeedMenuCdpFailure(this.options);this.close()})})
      socket.addEventListener('close',()=>{this.closed=true;for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(new Error('CDP closed'))}this.pending.clear()})
      await new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',()=>reject(new Error('CDP connect')),{once:true})})
      status(this.options.hook.statusLog,this.scope,'hook-loaded')
      if(endpoint.mode==='browser')await this.call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'page'},{type:'webview'},{exclude:true}]})
      else await this.configure(undefined,{type:'page'})
    }catch(error){
      markCodexSpeedMenuCdpFailure(this.options);this.close();throw error
    }
  }

  close():void{
    if(this.closed)return
    this.closed=true
    for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(new Error('CDP closed'))}
    this.pending.clear()
    try{this.socket?.close()}catch{}
    this.socket=undefined
  }
}
