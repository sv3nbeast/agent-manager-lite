import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,lstatSync,symlinkSync,appendFileSync,createWriteStream} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {gzipSync} from 'node:zlib'
import {createHash,randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {setTimeout as delay} from 'node:timers/promises'
import * as yazl from 'yazl'
import {ProxyEngine,pinnedEngine,verifyEngineVersion} from '../src/main/proxyEngine'
import {EngineError,approvedEngineURL,extractEngine,regularFile,compressedLimit} from '../src/main/proxyEngineFiles'
import {engineActive} from '../src/shared/proxyEngine'

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),signal=()=>new AbortController().signal
type Dependencies=NonNullable<ConstructorParameters<typeof ProxyEngine>[1]>
function fixture(t:{after(fn:()=>void|Promise<void>):void},options:Dependencies={}){
  const root=mkdtempSync(join(tmpdir(),'cml-engine-')),script=Buffer.from('#!/bin/sh\nprintf "Mihomo Meta v1.19.31 fixture\\n"\n'),bytes=gzipSync(script),archive=join(root,'official.gz')
  writeFileSync(archive,bytes);const spec={version:'1.19.31',target:'fixture',asset:{file:'mihomo-fixture-v1.19.31.gz',sha256:hash(bytes),size:bytes.length},url:'https://github.com/fixture.gz'}
  const deps={spec,...options},engine=new ProxyEngine(join(root,'data'),deps),engines=[engine]
  t.after(async()=>{for(const item of engines)await item.stop();rmSync(root,{recursive:true,force:true})})
  return {root,bytes,script,archive,spec,engine,newEngine(extra:Dependencies={}){const next=new ProxyEngine(join(root,'data'),{...deps,...extra});engines.push(next);return next}}
}
async function until(predicate:()=>boolean|Promise<boolean>){const end=Date.now()+5000;while(!await predicate()){assert.ok(Date.now()<end,'condition timeout');await delay(5)}}
const aborted=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})

test('pinned platforms and HTTPS redirect allowlist cannot accept credentials, arbitrary hosts or protocols',()=>{
  for(const platform of ['darwin','linux','win32'] as const)for(const arch of ['arm64','x64'] as const){const value=pinnedEngine(platform,arch)!;assert.ok(value);assert.match(value.asset.sha256,/^[a-f0-9]{64}$/);assert.equal(value.version,'1.19.31');assert.ok(approvedEngineURL(value.url))}
  assert.equal(pinnedEngine('aix','x64'),undefined);assert.equal(pinnedEngine('linux','ia32'),undefined)
  for(const url of ['http://github.com/file','https://user:secret@github.com/file','https://github.com:444/file','https://github.com.evil/file','file:///etc/passwd','https://127.0.0.1/'])assert.equal(approvedEngineURL(url),false)
  assert.ok(approvedEngineURL('https://release-assets.githubusercontent.com/a?signature=fixture'))
})
test('constructing and reading status create no directory, process, download or vault; unsupported platform is explicit',async t=>{
  const f=fixture(t,{download:async()=>{assert.fail('status must not download')},verify:async()=>{assert.fail('status must not execute')}})
  const first=f.engine.status();assert.equal(f.engine.status(),first)
  for(let i=0;i<3;i++){const state=await f.engine.status();assert.equal(state.phase,'idle');assert.equal(state.installedVersion,null)}
  assert.equal(existsSync(join(f.root,'data')),false)
  await assert.rejects(f.engine.preflight(),/PROXY_ENGINE_MISSING/)
  const unsupported=f.newEngine({unsupported:true});assert.equal((await unsupported.status()).supported,false);assert.throws(()=>unsupported.begin(),/UNSUPPORTED/)
})
test('hash-verified gzip imports run real version checks, publish atomically, reopen and keep private permissions',async t=>{
  const f=fixture(t);assert.equal(f.engine.begin(f.archive).phase,'importing');const done=await f.engine.wait()
  assert.equal(done.phase,'completed',JSON.stringify(done));assert.equal(done.receivedBytes,f.bytes.length)
  assert.equal(done.installedVersion,'1.19.31');const path=await f.engine.preflight()
  assert.deepEqual(readFileSync(path),f.script);assert.equal((lstatSync(path).mode&0o777),0o700)
  assert.equal(lstatSync(f.engine.root).mode&0o777,0o700);assert.equal(lstatSync(join(f.engine.root,'active.json')).mode&0o777,0o600)
  assert.ok(readdirSync(f.engine.root).every(name=>!name.startsWith('staging-')))
  assert.equal(await f.newEngine().preflight(),path);assert.equal(JSON.stringify(done).includes(f.root),false)
  assert.equal(existsSync(join(f.root,'data','state.vault')),false)
})
test('checksum failure does not execute payload or replace a working release; retry and repairs keep old binary available',async t=>{
  let checks=0;const f=fixture(t,{verify:async(...args)=>{checks++;await verifyEngineVersion(...args)}})
  f.engine.begin(f.archive);assert.equal((await f.engine.wait()).phase,'completed');const pointer=readFileSync(join(f.engine.root,'active.json'))
  const invalid=join(f.root,'private-secret.gz');writeFileSync(invalid,gzipSync('malicious fixture bytes'))
  f.engine.begin(invalid);const failed=await f.engine.wait();assert.equal(failed.error,'ENGINE_INSTALL_CHECKSUM');assert.equal(checks,1)
  assert.equal(failed.installedVersion,'1.19.31');assert.deepEqual(readFileSync(join(f.engine.root,'active.json')),pointer);assert.equal(JSON.stringify(failed).includes('private-secret'),false)
  const old=await f.engine.preflight();f.engine.begin(f.archive);assert.equal((await f.engine.wait()).phase,'completed');assert.ok(existsSync(old));assert.notEqual(await f.engine.preflight(),old)
})
test('symlinks, special files and oversized archives fail before extraction; cancellation before start leaves no files',async t=>{
  const f=fixture(t),link=join(f.root,'linked.gz');symlinkSync(f.archive,link)
  f.engine.begin(link);assert.equal((await f.engine.wait()).error,'ENGINE_INSTALL_ARCHIVE')
  f.engine.begin(f.root);assert.equal((await f.engine.wait()).error,'ENGINE_INSTALL_ARCHIVE')
  await assert.rejects(regularFile(f.archive,1),/TOO_LARGE/)
  const state=f.engine.begin(f.archive);f.engine.cancel(state.jobId!);assert.equal((await f.engine.wait()).phase,'cancelled')
  assert.equal(existsSync(join(f.engine.root,'active.json')),false);assert.deepEqual(readdirSync(f.engine.root),[])
})
test('in-flight download stays busy until canceled worker settles; stopping and timeouts kill work without publication',async t=>{
  let started=false;const f=fixture(t,{download:async(_url,signal)=>{started=true;return aborted(signal)}})
  const current=f.engine.begin();await until(()=>started);assert.throws(()=>f.newEngine().begin(),/BUSY/)
  f.engine.cancel('00000000-0000-4000-8000-000000000000');assert.ok(engineActive(await f.engine.status()))
  f.engine.cancel(current.jobId!);assert.throws(()=>f.engine.begin(),/BUSY/);assert.equal((await f.engine.wait()).phase,'cancelled')
  const timeout=f.newEngine({installTimeout:20});timeout.begin();assert.equal((await timeout.wait()).error,'ENGINE_INSTALL_TIMEOUT')
  f.engine.begin();await f.engine.stop();assert.equal((await f.engine.status()).phase,'cancelled');assert.throws(()=>f.engine.begin(),/STOPPED/)
  assert.deepEqual(readdirSync(f.engine.root),[])
})
test('streamed download, cancellation during extraction/version check and untrusted errors never activate an incomplete install',async t=>{
  const f=fixture(t,{download:async()=>Readable.from([f.bytes.subarray(0,5),f.bytes.subarray(5)])});f.engine.begin();assert.equal((await f.engine.wait()).phase,'completed')
  const old=readFileSync(join(f.engine.root,'active.json'));let entered=false
  const checking=f.newEngine({verify:async(_binary,_version,signal)=>{entered=true;return aborted(signal)}}),job=checking.begin(f.archive)
  await until(()=>entered);checking.cancel(job.jobId!);assert.equal((await checking.wait()).phase,'cancelled');assert.deepEqual(readFileSync(join(f.engine.root,'active.json')),old)
  const failing=f.newEngine({download:async()=>{throw new Error('upstream leaked-secret '+f.root)}});failing.begin();const state=await failing.wait();assert.equal(state.error,'ENGINE_INSTALL_DOWNLOAD');assert.equal(JSON.stringify(state).includes('leaked-secret'),false)
})
test('preflight rechecks hashes without caching completed success, shares concurrent checks and rejects repair races',async t=>{
  const f=fixture(t);f.engine.begin(f.archive);await f.engine.wait();const path=await f.engine.preflight()
  const check=f.engine.preflight();assert.equal(f.engine.preflight(),check);assert.throws(()=>f.engine.begin(),/BUSY/);await check
  appendFileSync(path,'tampered');await assert.rejects(f.engine.preflight(),/VERIFY/)
  f.engine.begin(f.archive);await f.engine.wait();assert.notEqual(await f.engine.preflight(),path)
  const hanging=f.newEngine({preflightTimeout:25,verify:async(_binary,_version,signal)=>aborted(signal)});await assert.rejects(hanging.preflight(),/PROXY_ENGINE_TIMEOUT/)
  const record=JSON.parse(readFileSync(join(f.engine.root,'active.json'),'utf8'));record.directory='../escape';writeFileSync(join(f.engine.root,'active.json'),JSON.stringify(record));assert.equal((await f.engine.status()).error,'ENGINE_INSTALL_VERIFY');await assert.rejects(f.engine.preflight(),/VERIFY/)
})
test('version verification is bounded, exact, cancellable and receives no inherited credentials or proxy overrides',async t=>{
  const f=fixture(t),bin=join(f.root,'probe');const old=process.env.MIHOMO_FIXTURE_SECRET;process.env.MIHOMO_FIXTURE_SECRET='private-env'
  t.after(()=>{if(old===undefined)delete process.env.MIHOMO_FIXTURE_SECRET;else process.env.MIHOMO_FIXTURE_SECRET=old})
  writeFileSync(bin,'#!/bin/sh\n[ -z "$MIHOMO_FIXTURE_SECRET" ] || exit 7\nprintf "Mihomo Meta v1.19.31 fixture\\n"\n',{mode:0o700});await verifyEngineVersion(bin,'1.19.31',signal())
  for(const version of ['1.19.310','1.19.3','1.19.31-evil'])await assert.rejects(verifyEngineVersion(bin,version,signal()),/VERSION/)
  writeFileSync(bin,'#!/bin/sh\nwhile :; do :; done\n');await assert.rejects(verifyEngineVersion(bin,'1.19.31',signal(),30),/START_TIMEOUT/)
  const cancel=new AbortController(),task=verifyEngineVersion(bin,'1.19.31',cancel.signal);cancel.abort(new EngineError('ENGINE_INSTALL_CANCELLED'));await assert.rejects(task,/CANCELLED/)
})
test('explicit reinstall cleans only marked abandoned staging directories and retains unowned files and release history',async t=>{
  const f=fixture(t),id=randomUUID(),stage=join(f.engine.root,'staging-'+id),unowned=join(f.engine.root,'staging-'+randomUUID()),external=join(f.root,'external')
  mkdirSync(stage,{recursive:true});mkdirSync(unowned);mkdirSync(external)
  writeFileSync(join(stage,'owner.json'),JSON.stringify({kind:'codex-manager-proxy-engine-install',id}));writeFileSync(join(stage,'download.archive'),'unfinished')
  writeFileSync(join(unowned,'keep'),'unowned');writeFileSync(join(external,'keep'),'external');symlinkSync(external,join(f.engine.root,'staging-'+randomUUID()))
  await f.engine.status();assert.ok(existsSync(stage))
  f.engine.begin(f.archive);assert.equal((await f.engine.wait()).phase,'completed');assert.equal(existsSync(stage),false)
  assert.equal(readFileSync(join(unowned,'keep'),'utf8'),'unowned');assert.equal(readFileSync(join(external,'keep'),'utf8'),'external')
})
async function zipFile(path:string,entries:{name:string;body?:string;mode?:number}[]){const zip=new yazl.ZipFile(),task=pipeline(zip.outputStream,createWriteStream(path));for(const entry of entries)zip.addBuffer(Buffer.from(entry.body??'fixture'),entry.name,{mode:entry.mode??0o100600});zip.end();await task}
test('Windows ZIP executable name, license preservation and bounded unused entries use safe extraction',async t=>{
  const f=fixture(t),zip=join(f.root,'fixture.zip'),output=join(f.root,'extract');mkdirSync(output)
  const name='mihomo-windows-amd64-v1-v1.19.31.zip'
  await zipFile(zip,[{name:'pkg/mihomo-windows-amd64-v1.exe'},{name:'pkg/LICENSE',body:'license fixture'},{name:'pkg/ignored.txt'}])
  const files=await extractEngine(zip,output,name,signal());assert.deepEqual(Object.keys(files),['mihomo.exe','LICENSE']);assert.equal(files['mihomo.exe'],hash('fixture'));assert.equal(readFileSync(join(output,'LICENSE'),'utf8'),'license fixture')
  const tiny=join(f.root,'tiny');mkdirSync(tiny);await assert.rejects(extractEngine(zip,tiny,name,signal(),2),/TOO_LARGE/)
})
test('archive extraction rejects links, duplicates, traversal, gzip bombs/truncation and cancels streaming decompression',async t=>{
  const f=fixture(t),zip=join(f.root,'bad.zip')
  const cases=[[{name:'mihomo.exe'},{name:'mihomo.exe'}],[{name:'mihomo.exe',mode:0o120777}],[{name:'CON.txt'},{name:'mihomo.exe'}],[{name:'mihomo.exe'},{name:'NOTICE',mode:0o020600}]]
  for(const [i,entries] of cases.entries()){await zipFile(zip,entries);const out=join(f.root,'out'+i);mkdirSync(out);await assert.rejects(extractEngine(zip,out,'engine.zip',signal()),/ARCHIVE/)}
  await zipFile(zip,[{name:'good00.exe'}]);writeFileSync(zip,Buffer.from(readFileSync(zip).toString('latin1').replaceAll('good00.exe','../bad.exe'),'latin1'))
  const traversal=join(f.root,'traversal');mkdirSync(traversal);await assert.rejects(extractEngine(zip,traversal,'engine.zip',signal()))
  const bomb=join(f.root,'bomb.gz');writeFileSync(bomb,gzipSync(Buffer.alloc(1024*1024)));const out=join(f.root,'bomb');mkdirSync(out);await assert.rejects(extractEngine(bomb,out,'engine.gz',signal(),100),/TOO_LARGE/)
  const invalid=join(f.root,'invalid');mkdirSync(invalid);writeFileSync(bomb,f.bytes.subarray(0,-6));await assert.rejects(extractEngine(bomb,invalid,'engine.gz',signal()),/ARCHIVE/)
  const cancel=new AbortController();cancel.abort(new EngineError('ENGINE_INSTALL_CANCELLED'));const canceled=join(f.root,'canceled');mkdirSync(canceled);await assert.rejects(extractEngine(f.archive,canceled,'engine.gz',cancel.signal),/CANCELLED/)
  assert.ok(compressedLimit<512*1024**2)
})
