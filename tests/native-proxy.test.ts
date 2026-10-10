import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request,type Server} from 'node:http'
import {connect} from 'node:net'
import {resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {NativeProxy} from '../src/main/nativeProxy'

async function listen(t:{after(fn:()=>void|Promise<void>):void},server:Server){
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address==='object')
  t.after(()=>{server.closeAllConnections();server.close()})
  return address.port
}
async function get(proxy:string,target='http://native.fixture.invalid/test'):Promise<{status:number;body:string}>{
  return new Promise((resolve,reject)=>{
    const req=request(proxy,{path:target},res=>{
      let body='';res.on('data',chunk=>{body+=chunk});res.on('end',()=>resolve({status:res.statusCode!,body}))
    })
    req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('fixture timeout')));req.end()
  })
}
test('native bridge supervises independent authenticated routes and releases only its own listener',async t=>{
  const hits:string[]=[],port=await listen(t,createServer((req,res)=>{
    assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('fixture:native-secret').toString('base64'))
    hits.push(req.url!);res.end('native-through-proxy')
  }))
  const bridge=new NativeProxy(resolve('resources/bin/codex-proxy')),upstream='http://fixture:native-secret@127.0.0.1:'+port
  const first=await bridge.acquire(upstream,'first',new AbortController().signal),second=await bridge.acquire(upstream,'second',new AbortController().signal)
  t.after(()=>Promise.all([first.stop(),second.stop()]).then(()=>{}))
  assert.notEqual(first.url,second.url);assert.equal(first.url.includes('secret'),false)
  assert.deepEqual(await get(first.url),{status:200,body:'native-through-proxy'})
  assert.deepEqual(await get(second.url),{status:200,body:'native-through-proxy'})
  assert.equal(hits.length,2)
  await first.stop();assert.equal(first.alive(),false);assert.equal(second.alive(),true)
  await assert.rejects(get(first.url));assert.equal((await get(second.url)).status,200)
})

test('native bridge never falls back to a directly reachable target when its configured upstream fails',async t=>{
  let directHits=0
  const target=await listen(t,createServer((_req,res)=>{directHits++;res.end('must not reach directly')}))
  const server=createServer(),port=await listen(t,server);await new Promise<void>(resolve=>server.close(()=>resolve()))
  const bridge=await new NativeProxy(resolve('resources/bin/codex-proxy')).acquire('http://user:private-secret@127.0.0.1:'+port,'failure',new AbortController().signal)
  t.after(()=>bridge.stop())
  const response=await get(bridge.url,'http://127.0.0.1:'+target+'/')
  assert.equal(response.status,502);assert.equal(directHits,0);assert.equal(response.body.includes('private-secret'),false)
})

test('ending native bridge stdin closes an already established CONNECT tunnel',async t=>{
  const sockets=new Set<import('node:net').Socket>(),upstream=createServer()
  upstream.on('connect',(_req,socket)=>{
    const stream=socket as import('node:net').Socket;sockets.add(stream);stream.on('close',()=>sockets.delete(stream))
    stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');stream.on('data',chunk=>stream.write(chunk))
  })
  const port=await listen(t,upstream)
  t.after(()=>{for(const socket of sockets)socket.destroy()})
  const bridge=await new NativeProxy(resolve('resources/bin/codex-proxy')).acquire('http://127.0.0.1:'+port,'tunnel',new AbortController().signal)
  t.after(()=>bridge.stop())
  const client=connect(Number(new URL(bridge.url).port),'127.0.0.1');t.after(()=>client.destroy())
  await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject)})
  let raw='';client.on('data',chunk=>{raw+=chunk})
  client.write('CONNECT native.fixture.invalid:443 HTTP/1.1\r\nHost: native.fixture.invalid:443\r\n\r\n')
  for(let n=0;!raw.includes('\r\n\r\n')&&n<300;n++)await delay(10)
  assert.match(raw,/200/)
  const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()))
  await bridge.stop();await closed;assert.equal(bridge.alive(),false)
})

test('native bridge rejects invalid configuration and pre-cancelled acquisition without leaking a URL',async()=>{
  const service=new NativeProxy(resolve('resources/bin/codex-proxy')),controller=new AbortController()
  controller.abort()
  await assert.rejects(service.acquire('http://user:private-secret@proxy.invalid:8080','cancelled',controller.signal))
  await assert.rejects(service.acquire('file://user:private-secret@proxy.invalid','invalid',new AbortController().signal),error=>!String(error).includes('private-secret'))
  await assert.rejects(new NativeProxy('/nonexistent-native-proxy-fixture').acquire('http://user:private-secret@proxy.invalid:8080','missing',new AbortController().signal),error=>!String(error).includes('private-secret'))
})
