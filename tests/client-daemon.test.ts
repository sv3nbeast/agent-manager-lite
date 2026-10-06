import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,symlinkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {createServer,type Socket} from 'node:net'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {probeClientDaemon,assertClientDaemonStopped} from '../src/main/clientDaemon'

const unix=process.platform==='darwin'||process.platform==='linux'
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  // Short path for the 104-byte macOS Unix socket limit; never a user's profile.
  const root=realpathSync(mkdtempSync('/tmp/cml-daemon-')),client=join(root,"profile ' $;`中文")
  mkdirSync(client);mkdirSync(join(client,'app-server-control'))
  const socket=join(client,'app-server-control','app-server-control.sock')
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,client,socket}
}
test('daemon probe is profile scoped, sends no protocol data and never runs shell commands',{skip:!unix},async t=>{
  const f=fixture(t),other=fixture(t),connections=new Set<Socket>();let count=0,bytes=0
  const server=createServer(socket=>{count++;connections.add(socket);socket.on('data',chunk=>bytes+=chunk.length);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{})})
  t.after(()=>{for(const socket of connections)socket.destroy();server.close()})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(f.socket,resolve)})
  assert.equal(await probeClientDaemon(f.client),'running')
  assert.equal(await probeClientDaemon(other.client),'not_detected')
  assert.equal(await probeClientDaemon(f.client),'running')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(count,2);assert.equal(bytes,0);assert.equal(server.listening,true)
  const cancel=new AbortController();cancel.abort()
  assert.equal(await probeClientDaemon(f.client,cancel.signal),'cancelled')
  assert.equal(count,2)
})
test('missing and stale daemon sockets do not block; unsafe or malformed socket paths remain unavailable',{skip:!unix},async t=>{
  const f=fixture(t)
  assert.equal(await probeClientDaemon(f.client),'not_detected')
  writeFileSync(f.socket,'not a socket')
  assert.equal(await probeClientDaemon(f.client),'unavailable');rmSync(f.socket)
  const child=spawn(process.execPath,['-e',"require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready\\n'))",f.socket],{stdio:['ignore','pipe','pipe']})
  t.after(()=>child.kill('SIGKILL'))
  const ready=await Promise.race([once(child.stdout!,'data').then(([data])=>String(data)),once(child,'error').then(([error])=>{throw error})])
  assert.equal(ready,'ready\n');const exited=once(child,'exit');child.kill('SIGKILL');await exited
  assert.ok(existsSync(f.socket));assert.equal(await probeClientDaemon(f.client),'not_detected')
  const other=fixture(t);rmSync(other.socket,{force:true});symlinkSync(f.socket,other.socket)
  assert.equal(await probeClientDaemon(other.client),'unavailable')
  rmSync(join(other.client,'app-server-control'),{recursive:true});symlinkSync(join(f.client,'app-server-control'),join(other.client,'app-server-control'))
  assert.equal(await probeClientDaemon(other.client),'unavailable')
  assert.equal(await probeClientDaemon('relative-profile'),'unavailable')
})
test('daemon status blocks live, failed and cancelled probes without treating absent detection as proof of closure',()=>{
  assert.throws(()=>assertClientDaemonStopped('running'),/仍在运行/)
  assert.throws(()=>assertClientDaemonStopped('unavailable'),/无法确认/)
  assert.throws(()=>assertClientDaemonStopped('cancelled'),/已取消/)
  assert.doesNotThrow(()=>assertClientDaemonStopped('not_detected'))
  assert.doesNotThrow(()=>assertClientDaemonStopped('unsupported'))
})
test('current Codex ipc socket blocks reuse of a profile even without the older app-server-control socket',{skip:!unix},async t=>{
  const f=fixture(t);mkdirSync(join(f.client,'ipc'))
  const path=join(f.client,'ipc','ipc.sock'),server=createServer(socket=>socket.end())
  t.after(()=>server.close())
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)})
  assert.equal(await probeClientDaemon(f.client),'running')
  assert.throws(()=>assertClientDaemonStopped('running'),/仍在运行/)
  assert.equal(server.listening,true)
})
