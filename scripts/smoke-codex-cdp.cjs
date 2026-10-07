const {spawn}=require('node:child_process')
const {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,rmSync,realpathSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const {setTimeout:delay}=require('node:timers/promises')
const asar=require('@electron/asar')
// The Electron production bundle is a single entry file, so the smoke test
// loads the same TypeScript modules through the repository's tsx runtime.
// This keeps the probe independent of Rollup chunk names while exercising the
// exact source used by the build.
require('tsx/cjs')
const {inspectCodexDesktopUi,prepareCodexSpeedMenu,readCodexSpeedMenuStatus}=require('../src/main/codexSpeedMenu.ts')
const {CodexSpeedMenuCdpSession}=require('../src/main/codexSpeedMenuCdp.ts')
const {reserveCodexCdpPort}=require('../src/main/codexInstanceAdapter.ts')

async function main(){
if(process.platform!=='darwin') { console.log('Codex CDP smoke skipped: macOS only'); return }
const application='/Applications/ChatGPT.app',executable=join(application,'Contents/MacOS/ChatGPT'),archive=join(application,'Contents/Resources/app.asar')
const inspection=inspectCodexDesktopUi({application,executable,platform:'darwin'})
if(!inspection.supported)throw new Error(`Installed ChatGPT is not compatible: ${inspection.reason}`)
// macOS exposes /var/folders through /private; the runtime deliberately
// requires canonical private directories, so create the fixture below the
// canonical temp path rather than its symlinked spelling.
const root=mkdtempSync(join(realpathSync(tmpdir()),'cml-cdp-smoke-')),home=join(root,'home'),desktop=join(root,'desktop'),report=join(root,'report.json'),fixture=join(root,'fixture.cjs')
mkdirSync(home,{mode:0o700});mkdirSync(desktop,{mode:0o700})
const nonce='cdp-smoke-'+Date.now().toString(36)
const cdpPort=await reserveCodexCdpPort()
const hook=prepareCodexSpeedMenu({inspection,directory:home,desktopDirectory:desktop,executable,nonce})
if(!hook||hook.transport!=='cdp')throw new Error('CDP hook was not prepared')
const asset=inspection.assetURL.slice('app://-'.length),archiveAsset='webview/'+asset.slice(1)
const page=`<img src="app://-/startup.png"><script>
let navigation;
window.addEventListener('message',event=>{if(event.data?.type==='navigate-to-route')navigation=event.data});
window.dispatchEvent(new CustomEvent('codex-message-from-view',{detail:{type:'electron-set-window-mode',mode:'app'}}));
setTimeout(async()=>{
  const response=await fetch(${JSON.stringify('app://-'+asset)},{cache:'no-store'}),body=await response.text();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const params=new URLSearchParams({hash,status:String(response.status),mode:navigation?.state?.codexAppMode??'',prefill:navigation?.state?.prefillComposerMode??''});
  await fetch('app://-/report?'+params);
},0);
</script>`
writeFileSync(fixture,`const{app,protocol,BrowserWindow}=require('electron'),fs=require('node:fs'),crypto=require('node:crypto'),asar=require(${JSON.stringify(require.resolve('@electron/asar'))});
const archive=${JSON.stringify(archive)},asset=${JSON.stringify(asset)},desktop=${JSON.stringify(desktop)},report=${JSON.stringify(report)},page=${JSON.stringify(page)},source=asar.extractFile(archive,${JSON.stringify(archiveAsset)}).toString();
app.setPath('userData',desktop);protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{protocol.handle('app',async request=>{
  if(request.url==='app://-/index.html')return new Response(page,{headers:{'content-type':'text/html'}});
  if(request.url==='app://-/startup.png'){await new Promise(resolve=>setTimeout(resolve,200));return new Response('',{status:404})}
  if(request.url.startsWith('app://-/report?')){const u=new URL(request.url);fs.writeFileSync(report,JSON.stringify({hash:u.searchParams.get('hash'),status:Number(u.searchParams.get('status')),mode:u.searchParams.get('mode'),prefill:u.searchParams.get('prefill')}));return new Response('ok')}
  if(request.url==='app://-'+asset)return new Response(source,{headers:{'content-type':'text/javascript','content-length':String(Buffer.byteLength(source))}});
  return new Response('missing',{status:404})
});const win=new BrowserWindow({show:false});await win.loadURL('app://-/index.html')}).catch(error=>{fs.writeFileSync(report,JSON.stringify({startupError:error.message}));app.exit(1)});`)
// Start the browser-level CDP handshake before the fixture process. The
// session waits for the fixed port, then installs Target.setAutoAttach before
// the renderer target is created, matching Cockpit Tools' launch order.
const session=new CodexSpeedMenuCdpSession({hook,directory:home,desktopDirectory:desktop,executable,nonce,pid:undefined,cdpPort})
const sessionStart=session.start()
const child=spawn(require('electron'),[fixture,`--remote-debugging-port=${cdpPort}`,'--remote-debugging-address=127.0.0.1','--user-data-dir='+desktop],{stdio:['ignore','pipe','pipe'],detached:true})
let childError=''
child.stderr?.on('data',chunk=>{childError+=String(chunk)})
child.stdout?.on('data',chunk=>{childError+=String(chunk)})
session.setPid(child.pid)
const kill=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}}
try{
  const active=join(desktop,'DevToolsActivePort')
  for(let i=0;i<200&&!existsSync(active);i++)await delay(25)
  if(!existsSync(active))throw new Error(`DevToolsActivePort was not created${childError?`: ${childError.trim()}`:''}`)
  await sessionStart
  // An existing page may finish its original request before the browser-level
  // handshake completes. The adapter reloads that page once interception is
  // ready; wait for that verified result instead of sampling the first paint.
  for(let i=0;i<400;i++){
    if(existsSync(report)){
      try{
        const value=JSON.parse(readFileSync(report,'utf8'))
        if(value.startupError)throw new Error('fixture initial load failed: '+value.startupError)
        if(value.hash===inspection.patchedSha256&&value.mode==='codex'&&value.prefill==='local')break
      }catch(error){if(error.message?.startsWith('fixture initial load failed:'))throw error}
    }
    await delay(25)
  }
  if(!existsSync(report))throw new Error(`fixture did not report the intercepted response${childError?`: ${childError.trim()}`:''}`)
  const result=JSON.parse(readFileSync(report,'utf8'))
  if(result.status!==200||result.hash!==inspection.patchedSha256||result.mode!=='codex'||result.prefill!=='local'){
    let diagnostics=''
    try{diagnostics=readFileSync(hook.statusLog,'utf8')}catch{}
    throw new Error(`unexpected response ${JSON.stringify(result)}${diagnostics?` status=${diagnostics.trim()}`:''}`)
  }
  const status=readCodexSpeedMenuStatus({statusLog:hook.statusLog,nonce,executable,directory:home,enhancements:'speed-locale'})
  if(status.state!=='active')throw new Error(`unexpected hook status ${JSON.stringify(status)}`)
  session.close();console.log('Codex CDP smoke passed: patched renderer response and active status')
}finally{kill();await delay(150);rmSync(root,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error?.stack||error);process.exitCode=1})
