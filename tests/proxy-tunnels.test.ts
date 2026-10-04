import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {connect} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import {ProxyTunnels} from '../src/main/proxyTunnels'
import {AccountNetwork} from '../src/main/accountNetwork'
import {Gateway} from '../src/main/gateway'
import {parseAccountImport} from '../src/main/accounts'
import {settingsSchema} from '../src/shared/types'

const binary=resolve('resources/bin/codex-proxy'),id='11111111-2222-3333-4444-555555555555'
const link=(server='fixture')=>`vless://${id}@${server}:1234`
const until=async(check:()=>boolean)=>{const end=Date.now()+7000;while(!check()){assert.ok(Date.now()<end,'timed out waiting for child cleanup');await delay(15)}}
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=mkdtempSync(join(tmpdir(),'cml-tunnels-')),engine=join(root,'fixture-engine'),directory=join(root,'runtime')
  writeFileSync(engine,`#!${process.execPath}\n`+readFileSync('tests/fixtures/mihomo-fixture.cjs','utf8'),{mode:0o700})
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const directories=()=>existsSync(directory)?readdirSync(directory):[]
  return {root,engine,directory,directories}
}
test('authenticated supervisor leases share within an account and isolate accounts; release and stop reap children',async t=>{
  const f=fixture(t);let checks=0
  const pool=new ProxyTunnels(binary,f.directory,async()=>{checks++;return f.engine},{idleMs:20})
  t.after(()=>pool.stop())
  const [a,b]=await Promise.all([pool.acquire(link(),'a'),pool.acquire(link(),'a')])
  assert.equal(a.url,b.url);assert.equal(checks,1);assert.equal(f.directories().length,1)
  const c=await pool.acquire(link(),'b');assert.notEqual(a.url,c.url);assert.equal(f.directories().length,2)
  // The real supervisor's readiness check has already authenticated; verify the
  // fixture's listener rejects an unauthenticated SOCKS greeting too.
  const port=Number(new URL(a.url).port)
  const reply=await new Promise<Buffer>((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>socket.write(Buffer.from([5,1,0])));socket.on('error',reject);socket.once('data',b=>{socket.destroy();resolve(b)})})
  assert.deepEqual(reply,Buffer.from([5,255]))
  a.release();a.release();await delay(40);assert.equal(f.directories().length,2,'another lease retains the tunnel')
  b.release();await until(()=>f.directories().length===1)
  c.release();await pool.stop();assert.deepEqual(f.directories(),[])
  await assert.rejects(pool.acquire(link(),'a'))
})
test('cancelling one waiter preserves another; queue timeout and capacity do not start extra engines',async t=>{
  const f=fixture(t);let checks=0,unblock!:()=>void
  const wait=new Promise<void>(resolve=>unblock=resolve)
  const pool=new ProxyTunnels(binary,f.directory,async()=>{checks++;await wait;return f.engine},{parallel:1,queueMs:60,capacity:2,idleMs:0})
  t.after(()=>pool.stop())
  const abort=new AbortController(),first=pool.acquire(link(),'a',abort.signal),kept=pool.acquire(link(),'a')
  const cancelled=assert.rejects(first,/取消/)
  await until(()=>checks===1);abort.abort();await cancelled
  await assert.rejects(pool.acquire(link(),'b'),/取消/)
  assert.equal(checks,1)
  unblock();const a=await kept;assert.equal(f.directories().length,1)
  const b=await pool.acquire(link(),'b')
  await assert.rejects(pool.acquire(link(),'c'),/过多/)
  a.release();b.release();await pool.stop();assert.deepEqual(f.directories(),[])
})
test('exit, invalid executable and a listening port without matching SOCKS authentication fail closed',{timeout:20000},async t=>{
  const f=fixture(t),pool=new ProxyTunnels(binary,f.directory,async()=>f.engine,{idleMs:0});t.after(()=>pool.stop())
  await assert.rejects(pool.acquire(link('fixture-exit'),'a'),/启动失败/)
  await assert.rejects(pool.acquire(link('fixture-no-auth'),'a'),/启动失败/)
  await until(()=>f.directories().length===0)
  const missing=new ProxyTunnels(binary,f.directory,async()=>join(f.root,'absent'));t.after(()=>missing.stop())
  await assert.rejects(missing.acquire(link(),'a'),/启动失败/)
})
test('unexpected engine exit retires its endpoint and a later lease starts a fresh authenticated process',async t=>{
  const f=fixture(t),pool=new ProxyTunnels(binary,f.directory,async()=>f.engine,{idleMs:0});t.after(()=>pool.stop())
  const first=await pool.acquire(link(),'a'),pid=Number(readFileSync(join(f.directory,f.directories()[0],'fixture.pid'),'utf8'))
  process.kill(pid,'SIGKILL');await until(()=>f.directories().length===0)
  const next=await pool.acquire(link(),'a');assert.notEqual(next.url,first.url)
  first.release();assert.equal(f.directories().length,1,'old lease must not retire its replacement')
  next.release();await pool.stop();assert.deepEqual(f.directories(),[])
})
test('account requests traverse the acquired tunnel; missing engine never falls back; cancellation releases the lease',async t=>{
  const f=fixture(t),pool=new ProxyTunnels(binary,f.directory,async()=>f.engine,{idleMs:0}),network=new AccountNetwork(binary,undefined,pool)
  t.after(async()=>{await network.stop();await pool.stop()})
  let hits=0,waiting=false,closed=false
  const server=createServer((req,res)=>{hits++;assert.equal(req.headers['proxy-authorization'],undefined);if(req.url==='/wait'){waiting=true;req.on('close',()=>closed=true);return}res.end('{"ok":true}')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`
  assert.deepEqual(await network.through(link())(url,{headers:{Authorization:'Bearer synthetic-account'}}),{ok:true})
  const absent=new AccountNetwork(binary);t.after(()=>absent.stop())
  await assert.rejects(absent.through(link())(url));assert.equal(hits,1)
  const control=new AbortController(),pending=network.through(link())(url+'/wait',{signal:control.signal});const rejected=assert.rejects(pending,/取消/)
  await until(()=>waiting);control.abort();await rejected;await until(()=>closed);await pool.stop();assert.deepEqual(f.directories(),[])
})
test('gateway stop cancels a pending engine acquisition and waits for cleanup without starting its sidecar',async t=>{
  const f=fixture(t);let release=()=>{},entered=false
  const pool=new ProxyTunnels(binary,f.directory,()=>{entered=true;return new Promise<string>(resolve=>{release=()=>resolve(f.engine)})})
  t.after(()=>pool.stop())
  const account=parseAccountImport('at-proxy-fixture').accounts[0];account.proxy={mode:'custom',url:link()}
  const gateway=new Gateway(binary,join(f.root,'gateway'),undefined,undefined,undefined,pool);t.after(()=>gateway.stop())
  const starting=gateway.start({id:account.id,port:0,account,apiKey:'synthetic-downstream'},settingsSchema.parse({})),rejected=assert.rejects(starting)
  await until(()=>entered);await gateway.stop();release();await rejected
  assert.equal(gateway.current().running,false);assert.equal(gateway.runtimeDirectory(),undefined);assert.deepEqual(f.directories(),[])
})
test('SIGKILL of the manager closes its lifetime pipe, reaps the engine and removes only its own runtime',{timeout:15000},async t=>{
  const f=fixture(t)
  const code=`const {ProxyTunnels}=await import('./src/main/proxyTunnels.ts').then(m=>m.default??m);const p=new ProxyTunnels(${JSON.stringify(binary)},${JSON.stringify(f.directory)},async()=>${JSON.stringify(f.engine)});await p.acquire(${JSON.stringify(link())},'fixture');console.log('ready');setInterval(()=>{},1000)`
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']})
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b)
  await until(()=>{assert.equal(child.exitCode,null,errors);return output.includes('ready')})
  const directories=f.directories();assert.equal(directories.length,1)
  const pid=Number(readFileSync(join(f.directory,directories[0],'fixture.pid'),'utf8'));process.kill(pid,0)
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.kill('SIGKILL');await closed
  await until(()=>f.directories().length===0)
  assert.throws(()=>process.kill(pid,0))
})
