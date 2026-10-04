// Test-only loopback Mihomo VLESS endpoint; the executable must already have
// passed the production installer's pinned archive/version validation.
const fs=require('node:fs'),net=require('node:net'),{join}=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict')
let child
process.once('exit',()=>child?.kill('SIGKILL'))
async function start(directory,proxyURL){
  const active=JSON.parse(fs.readFileSync(join(directory,'proxy-engine','active.json'))),binary=join(directory,'proxy-engine',active.directory,'mihomo'),root=join(directory,'fixture-node')
  fs.mkdirSync(root,{mode:0o700})
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
  const proxy=new URL(proxyURL),uuid='11111111-2222-3333-4444-555555555555'
  const config={'log-level':'silent','mode':'rule','allow-lan':false,'dns':{enable:false},'tun':{enable:false},'geo-auto-update':false,'find-process-mode':'off',listeners:[{name:'fixture',type:'vless',listen:'127.0.0.1',port,'allow-insecure':true,users:[{uuid}]}],proxies:[{name:'fixture-proxy',type:'http',server:'127.0.0.1',port:Number(proxy.port),username:'fixture',password:'batch-password'}],rules:['MATCH,fixture-proxy']}
  child=spawn(binary,['-f','-','-d',root],{cwd:root,stdio:['pipe','ignore','ignore'],env:{PATH:'/usr/bin:/bin'}});child.stdin.end(JSON.stringify(config))
  for(let attempt=0;;attempt++){
    const ready=await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))})
    if(ready)break;assert.ok(attempt<100,'node listener timeout');await new Promise(resolve=>setTimeout(resolve,25))
  }
  return `vless://${uuid}@127.0.0.1:${port}`
}
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})}
function connectFixture(server,targetURL,onHit){
  const sockets=new Set()
  server.on('connect',(req,socket,head)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})
    assert.equal(req.url,new URL(targetURL).host);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:batch-password').toString('base64'))
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let received=head.toString();const reply=()=>{if(!received.includes('\r\n\r\n'))return false;assert.equal(/\r\nauthorization:/i.test(received),false);onHit();const body='{"ip":"203.0.113.20"}';socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nConnection: close\r\n\r\n'+body);return true}
    if(!reply())socket.on('data',chunk=>{received+=chunk;if(reply())socket.removeAllListeners('data')})
  })
  return ()=>{for(const socket of sockets)socket.destroy()}
}
module.exports={start,stop,connectFixture}
