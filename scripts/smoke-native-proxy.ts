// Real Codex app-server and Electron consumers, synthetic native credentials,
// and disposable profiles. The macOS sandbox permits only the bridge listener;
// every upstream fixture refuses destinations outside its local test origins.
import assert from 'node:assert/strict'
import {spawn,execFileSync,type ChildProcess} from 'node:child_process'
import {createHash,X509Certificate} from 'node:crypto'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {createServer as httpServer,request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http'
import {createServer as httpsServer} from 'node:https'
import {createRequire} from 'node:module'
import {connect,createServer as tcpServer,type Socket,type Server} from 'node:net'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createInterface} from 'node:readline'
import {parseAccountImport} from '../src/main/accounts'
import {authFor,nativeConfig} from '../src/main/nativeAccountProjection'
import {NativeProxy,type NativeProxyLease} from '../src/main/nativeProxy'
import {codexMacLaunchArgs} from '../src/main/codexInstanceAdapter'
import {networkRouteEnvironment,type InstanceNetworkRoute} from '../src/main/desktopNetwork'
import {codexBundledCli} from '../src/main/codexPrograms'
import {resolveCliRuntime} from '../src/main/cliResolver'
import {settingsSchema} from '../src/shared/types'

const user='fixture-user',password='synthetic-proxy-password'
const accountId='synthetic-native-proxy-account',email='native-proxy@example.invalid'
const basic='Basic '+Buffer.from(`${user}:${password}`).toString('base64')
const destination='fixture.invalid',plainPort=18443,securePort=18444
const plainURL=`http://${destination}:${plainPort}`,secureURL=`https://${destination}:${securePort}`

async function timeout<T>(promise:Promise<T>,message:string,ms=15000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})])}
  finally{clearTimeout(timer)}
}
async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})})
  const address=server.address();assert.ok(address&&typeof address==='object');return address.port
}
async function stop(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()))
  child.stdin?.end();child.kill('SIGTERM')
  const timer=setTimeout(()=>child.kill('SIGKILL'),1000)
  try{await closed}finally{clearTimeout(timer)}
}
function sandbox(port:number):string {
  return `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${port}"))`
}

async function main(){
  assert.equal(process.platform,'darwin','Native proxy smoke requires macOS sandbox-exec to deny non-fixture network')
  const binary=process.env.CML_TEST_CODEX_BINARY?resolveCliRuntime(process.env.CML_TEST_CODEX_BINARY).executable:
    codexBundledCli(['/Applications/ChatGPT.app','/Applications/Codex.app'].find(existsSync)??'/Applications/Codex.app')
  const electron=createRequire(import.meta.url)('electron') as string
  const helper=resolve('resources/bin/codex-proxy')
  assert.ok(existsSync(helper),'Run npm run build:proxy before the native proxy smoke')
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-native-proxy-')))
  const children=new Set<ChildProcess>(),sockets=new Set<Socket>(),servers=new Set<Server>()
  const leases=new Set<NativeProxyLease>(),originRequests:{path:string;native:boolean}[]=[]
  const failOnExit=()=>{for(const child of children)child.kill('SIGKILL')}
  process.once('exit',failOnExit)
  const track=(server:Server)=>{
    servers.add(server)
    server.on('connection',(socket:Socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})})
    return server
  }
  try{
    const claims={sub:'synthetic-native-proxy-user',email,exp:Math.floor(Date.now()/1000)+86400,
      'https://api.openai.com/auth':{chatgpt_account_id:accountId,chatgpt_user_id:'synthetic-native-proxy-user',chatgpt_plan_type:'plus'}}
    const jwt=[{alg:'none'},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')+'.fixture'
    const source={auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:jwt,id_token:jwt,refresh_token:'synthetic-refresh-token',account_id:accountId},last_refresh:new Date().toISOString()}
    const origin=(request:IncomingMessage,response:ServerResponse)=>{
      assert.equal(request.headers['proxy-authorization'],undefined,'Proxy credentials must not reach the origin')
      originRequests.push({path:request.url??'',native:request.headers.authorization===`Bearer ${jwt}`})
      response.setHeader('Content-Type','application/json')
      response.end(JSON.stringify(request.url?.startsWith('/desktop/')?{fixture:true}:{
        accounts:[{id:accountId,workspace_backend_origin:'https://chatgpt.com',account_routing_override:'NO_CONSTRAINT'}],plugins:[],enabled:false}))
    }
    const plain=await listen(track(httpServer(origin)))
    const certificate=join(root,'cert.pem'),key=join(root,'key.pem'),opensslConfig=join(root,'openssl.cnf')
    writeFileSync(opensslConfig,`[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${destination}\n[ext]\nsubjectAltName=DNS:${destination}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n`)
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','1','-config',opensslConfig],{stdio:'ignore',timeout:10000})
    const secure=await listen(track(httpsServer({key:readFileSync(key),cert:readFileSync(certificate)},origin)))
    const spki=createHash('sha256').update(new X509Certificate(readFileSync(certificate)).publicKey.export({type:'spki',format:'der'})).digest('base64')
    const targetPort=(host:string,port:number)=>host===destination?(port===plainPort?plain:port===securePort?secure:undefined):undefined
    const tunnel=(client:Socket,port:number,head:Buffer,onReady:()=>void)=>{
      const remote=connect(port,'127.0.0.1',()=>{onReady();if(head.length)remote.write(head);client.pipe(remote).pipe(client)})
      sockets.add(remote);remote.on('close',()=>sockets.delete(remote));remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy())
    }
    const electronScript=join(root,'electron-fixture.cjs')
    writeFileSync(electronScript,`const {app,net,session}=require('electron'),fs=require('node:fs');
app.setPath('userData',process.env.CML_FIXTURE_DESKTOP);app.dock?.hide();
app.whenReady().then(async()=>{
  const result=[];
  for(const url of ${JSON.stringify([plainURL+'/desktop/http',secureURL+'/desktop/https'])}){
    const response=await net.fetch(url,{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
    const route=await session.defaultSession.resolveProxy(url);
    result.push({route,status:response.status,body:await response.json()});
  }
  fs.writeSync(1,JSON.stringify({fixture:result})+'\\n');app.exit(0);
}).catch(()=>{fs.writeSync(2,'Electron native proxy fixture failed\\n');app.exit(1)});
`)

    async function runCodex(label:string,proxy:string,route:InstanceNetworkRoute){
      const directory=join(root,label+'-codex');mkdirSync(directory,{mode:0o700})
      const account=parseAccountImport(JSON.stringify(source)).accounts[0]
      account.proxy={mode:'custom',url:proxy}
      const state={version:1 as const,settings:settingsSchema.parse({}),accounts:[account],groups:[]}
      const base=`cli_auth_credentials_store="file"\nchatgpt_base_url="${plainURL}/backend-api"\n[analytics]\nenabled=false\n[features]\nplugins=false\nremote_models=false\n`
      writeFileSync(join(directory,'auth.json'),authFor(account,null,state,true),{mode:0o600})
      writeFileSync(join(directory,'config.toml'),nativeConfig(base,account,state,[]).config,{mode:0o600})
      assert.equal(route.mode,'proxy')
      const child=spawn('/usr/bin/sandbox-exec',['-p',sandbox(Number(new URL((route as {url:string}).url).port)),binary,'app-server','--stdio'],{
        cwd:directory,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CODEX_HOME:directory,TMPDIR:directory,LANG:'en_US.UTF-8',RUST_LOG:'off',...networkRouteEnvironment(route)},stdio:['pipe','pipe','pipe']})
      children.add(child);child.stderr.resume()
      const lines=createInterface({input:child.stdout}),pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
      let next=0
      const fail=(error:Error)=>{for(const request of pending.values())request.reject(error);pending.clear()}
      child.once('error',fail);child.once('close',()=>fail(new Error('Synthetic app-server exited')));child.stdin.on('error',fail)
      lines.on('line',line=>{try{const event=JSON.parse(line),request=pending.get(event.id);if(request){pending.delete(event.id);event.error?request.reject(new Error(event.error.message)):request.resolve(event.result)}}catch{fail(new Error('Invalid app-server fixture response'))}})
      const rpc=(method:string,params:unknown)=>timeout(new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')}),'Native account fixture timed out')
      try{
        await rpc('initialize',{clientInfo:{name:'cml-native-proxy-smoke',version:'0.1.0'}})
        child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
        const identity=await rpc('account/read',{refreshToken:false})
        assert.equal(identity.account.type,'chatgpt');assert.equal(identity.account.email,email)
        assert.equal(identity.account.planType,'plus');assert.equal(identity.requiresOpenaiAuth,true)
      }finally{await stop(child);lines.close();children.delete(child)}
    }

    async function runElectron(label:string,route:InstanceNetworkRoute){
      const directory=join(root,label+'-desktop');mkdirSync(directory,{mode:0o700})
      const launch=codexMacLaunchArgs({clientType:'codex',application:'fixture.app',executable:electron,directory,desktopDirectory:directory,workingDirectory:directory,
        args:['--no-proxy-server','--proxy-bypass-list=*'],nonce:'native-proxy-'+label,networkRoute:route})
      const flags=launch.slice(launch.indexOf('--args')+1)
      const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:directory,LANG:'en_US.UTF-8',CML_FIXTURE_DESKTOP:directory}
      for(let i=0;i<launch.indexOf('--args');i++)if(launch[i]==='--env'){
        const value=launch[++i],at=value.indexOf('=');env[value.slice(0,at)]=value.slice(at+1)
      }
      assert.equal(route.mode,'proxy')
      const proxyURL=(route as {url:string}).url
      assert.equal(env.HTTPS_PROXY,proxyURL)
      assert.equal(flags.some(value=>value.includes(password)),false)
      // Chromium cannot enter a nested macOS sandbox. This windowless fixture
      // uses the outer fixture-only OS sandbox for its entire process tree.
      const child=spawn('/usr/bin/sandbox-exec',['-p',sandbox(Number(new URL(proxyURL).port)),electron,electronScript,...flags,'--no-sandbox','--disable-gpu',`--ignore-certificate-errors-spki-list=${spki}`],{
        cwd:directory,env,stdio:['ignore','pipe','pipe']})
      children.add(child);let output='',diagnostics=''
      child.stdout.on('data',chunk=>output=(output+chunk).slice(-16384));child.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-2048))
      try{
        const code=await timeout(new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}),'Electron fixture timed out',20000)
        assert.equal(code,0,`Isolated Electron failed: ${diagnostics}`)
        const line=output.split('\n').find(value=>value.startsWith('{"fixture":'));assert.ok(line,'Electron did not report its network results')
        const result=JSON.parse(line).fixture;assert.equal(result.length,2)
        for(const entry of result){assert.equal(entry.route,`PROXY 127.0.0.1:${new URL(proxyURL).port}`,JSON.stringify(result));assert.equal(entry.status,200);assert.deepEqual(entry.body,{fixture:true})}
      }finally{await stop(child);children.delete(child)}
    }

    for(const scheme of ['http','socks5','socks5h'] as const){
      let authenticated=0,connected=0
      let upstream:Server
      if(scheme==='http'){
        const server=httpServer((request,response)=>{
          if(request.headers['proxy-authorization']!==basic){response.writeHead(407);response.end();return}
          authenticated++
          const url=new URL(request.url??'',plainURL),port=targetPort(url.hostname,Number(url.port||80))
          if(url.protocol!=='http:'||!port){response.writeHead(502);response.end();return}
          const headers={...request.headers};delete headers['proxy-authorization']
          const forwarded=httpRequest({host:'127.0.0.1',port,path:url.pathname+url.search,method:request.method,headers},remote=>{response.writeHead(remote.statusCode??502,remote.headers);remote.pipe(response)})
          forwarded.on('error',()=>{response.writeHead(502);response.end()});request.pipe(forwarded)
        })
        server.on('connect',(request,socket,head)=>{
          if(request.headers['proxy-authorization']!==basic){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return}
          authenticated++
          const url=new URL('http://'+request.url),port=targetPort(url.hostname,Number(url.port||80))
          if(!port){socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return}
          connected++;tunnel(socket as Socket,port,head,()=>socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'))
        })
        upstream=track(server)
      }else upstream=track(tcpServer(socket=>{
        let stage=0,buffer=Buffer.alloc(0)
        const data=(chunk:Buffer)=>{
          buffer=Buffer.concat([buffer,chunk])
          for(;;){
            if(stage===0){
              if(buffer.length<2||buffer.length<2+buffer[1])return
              assert.equal(buffer[0],5);assert.ok(buffer.subarray(2,2+buffer[1]).includes(2),'Upstream SOCKS must authenticate')
              buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,2]));stage=1
            }else if(stage===1){
              if(buffer.length<2||buffer.length<3+buffer[1])return
              const length=3+buffer[1]+buffer[2+buffer[1]];if(buffer.length<length)return
              assert.equal(buffer[0],1);assert.equal(buffer.subarray(2,2+buffer[1]).toString(),user)
              assert.equal(buffer.subarray(3+buffer[1],length).toString(),password)
              authenticated++;buffer=buffer.subarray(length);socket.write(Buffer.from([1,0]));stage=2
            }else{
              if(buffer.length<5)return
              assert.equal(buffer[0],5);assert.equal(buffer[1],1)
              const length=buffer[3]===3?7+buffer[4]:buffer[3]===1?10:22;if(buffer.length<length)return
              const host=buffer[3]===3?buffer.subarray(5,5+buffer[4]).toString():buffer[3]===1?[...buffer.subarray(4,8)].join('.'):'::1'
              const port=targetPort(host,buffer.readUInt16BE(length-2)),head=buffer.subarray(length)
              socket.removeListener('data',data)
              if(!port){socket.end(Buffer.from([5,5,0,1,127,0,0,1,0,0]));return}
              connected++;tunnel(socket,port,head,()=>socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0])));return
            }
          }
        }
        socket.on('data',data)
      }))
      const upstreamPort=await listen(upstream),proxy=`${scheme}://${user}:${password}@127.0.0.1:${upstreamPort}`
      const lease=await new NativeProxy(helper).acquire(proxy,'native-proxy-smoke-'+scheme,new AbortController().signal)
      leases.add(lease);assert.ok(lease.alive());assert.equal(lease.url.includes(password),false)
      const route:InstanceNetworkRoute={mode:'proxy',url:lease.url},before=originRequests.length
      await runCodex(scheme,proxy,route);await runElectron(scheme,route)
      const observed=originRequests.slice(before)
      assert.ok(observed.some(request=>request.path==='/backend-api/wham/accounts/check'&&request.native),'Native account request did not traverse the selected proxy')
      assert.ok(observed.some(request=>request.path==='/desktop/http'));assert.ok(observed.some(request=>request.path==='/desktop/https'))
      assert.ok(authenticated>=3);assert.ok(connected>=1,'HTTPS CONNECT did not traverse the selected proxy')
      await lease.stop();leases.delete(lease);assert.equal(lease.alive(),false)
      const reachable=await new Promise<boolean>(resolve=>{const socket=connect(Number(new URL(lease.url).port),'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))})
      assert.equal(reachable,false,'Stopped native bridge must release its listener')
      console.log(`${scheme}: installed Codex recognized native ChatGPT email/plan; Electron HTTP and HTTPS CONNECT followed production proxy settings; upstream authentication and bridge cleanup verified.`)
    }
    console.log('Native proxy smoke passed with synthetic credentials, disposable profiles, a pinned fixture TLS certificate, and fixture-only network. HTTPS upstream proxy TLS is covered separately by the Go bridge integration tests.')
  }finally{
    for(const child of children)await stop(child)
    for(const lease of leases)await lease.stop()
    for(const socket of sockets)socket.destroy()
    for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()))
    rmSync(root,{recursive:true,force:true});process.removeListener('exit',failOnExit)
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1})
