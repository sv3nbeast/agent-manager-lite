// Lifecycle/SOCKS fixture only; no real node protocol is claimed by this script.
const fs=require('node:fs'),net=require('node:net'),path=require('node:path')
let raw=''
process.stdin.on('data',b=>{raw+=b; if(raw.length>65536)process.exit(2)})
process.stdin.on('end',()=>{
  const c=JSON.parse(raw),dir=process.argv[process.argv.indexOf('-d')+1],node=c.proxies[0]
  fs.writeFileSync(path.join(dir,'fixture.pid'),String(process.pid))
  if(node.server==='fixture-exit')process.exit(2)
  if(node.server==='fixture-stall'){setInterval(()=>{},1000);return}
  const peers=new Set()
  const server=net.createServer(socket=>{
    peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{})
    let buffer=Buffer.alloc(0),stage=0
    const data=chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length>65536){socket.destroy();return}
      if(stage===0){if(buffer.length<2||buffer.length<2+buffer[1])return;const supported=buffer.subarray(2,2+buffer[1]).includes(2);buffer=buffer.subarray(2+buffer[1]);if(!supported){socket.end(Buffer.from([5,255]));return}socket.write(Buffer.from([5,node.server==='fixture-no-auth'?0:2]));stage=1}
      if(stage===1){
        if(buffer.length<2)return;const n=buffer[1];if(buffer.length<n+3)return;const m=buffer[n+2];if(buffer.length<n+m+3)return
        const user=buffer.subarray(2,2+n).toString(),pass=buffer.subarray(n+3,n+3+m).toString();buffer=buffer.subarray(n+m+3)
        if(user+':'+pass!==c.authentication[0]){socket.end(Buffer.from([1,1]));return}
        socket.write(Buffer.from([1,0]));stage=2
      }
      if(stage===2){
        if(buffer.length<5)return;const type=buffer[3],length=type===1?4:type===3?1+buffer[4]:16
        if(buffer.length<6+length)return
        const port=buffer.readUInt16BE(4+length),rest=buffer.subarray(6+length)
        // This test transport always resolves into loopback.
        const remote=net.connect(port,'127.0.0.1',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(rest.length)remote.write(rest);socket.pipe(remote).pipe(socket)})
        peers.add(remote);remote.on('close',()=>peers.delete(remote));remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());socket.removeListener('data',data)
      }
    }
    socket.on('data',data)
  })
  server.listen(c['mixed-port'],'127.0.0.1')
  const quit=()=>{for(const socket of peers)socket.destroy();server.close(()=>process.exit(0))}
  process.on('SIGTERM',quit);process.on('SIGINT',quit)
})
