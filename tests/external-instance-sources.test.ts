import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,realpathSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ExternalInstanceSources} from '../src/main/externalInstanceSources'
import type {InstanceCopySource} from '../src/shared/instances'
import type {ClientDaemonState} from '../src/main/clientDaemon'

function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-external-sources-'))),home=join(root,'home'),manager=join(root,'manager'),library=join(home,'.antigravity_cockpit')
  mkdirSync(library,{recursive:true});mkdirSync(manager)
  let now=1000
  const managed:string[]=[],states=new Map<string,ClientDaemonState>(),alive=new Set<number>()
  const scanner=new ExternalInstanceSources({home,managerRoot:manager,platform:'darwin',managedDirectories:()=>managed,now:()=>now,probeDaemon:async directory=>states.get(directory)??'not_detected',pidAlive:pid=>alive.has(pid)})
  const profile=(name:string)=>{const path=join(home,name);mkdirSync(path,{recursive:true});writeFileSync(join(path,'config.toml'),'model="fixture-model"\n');return path}
  const registry=(instances:unknown[],extra:Record<string,unknown>={})=>{const file=join(library,'codex_instances.json');writeFileSync(file,JSON.stringify({instances,...extra}));return file}
  const select=(directory:string):InstanceCopySource=>({ticket:randomUUID(),name:'original callback name',directory,history:{sessions:3,archived:1,projects:[],unassigned:3,issues:[]}})
  t.after(()=>{scanner.clear();rmSync(root,{recursive:true,force:true})})
  return{root,home,manager,library,scanner,managed,states,alive,profile,registry,select,advance:()=>{now+=300_000}}
}

test('metadata discovery lists running sources and an eligible default home without reading or exposing credentials',async t=>{
  const f=fixture(t),first=f.profile('external-a'),second=f.profile('external-b'),defaultHome=f.profile('.codex')
  const file=f.registry([{id:'upstream-original-id',name:'工作实例',userDataDir:first,launchMode:'app',lastPid:7,extraArgs:'--api-key fixture-secret',bindAccountId:'private-account-id',modelRouting:{apiKey:'fixture-routing-secret'}},{id:'cli-id',name:'CLI',userDataDir:second,launchMode:'cli',lastPid:8},{name:'Duplicate',userDataDir:first}],{defaultSettings:{lastPid:9}})
  writeFileSync(join(first,'auth.json'),'malformed private fixture credentials')
  const before=readFileSync(file);f.states.set(first,'running');f.alive.add(8)
  const found=await f.scanner.discover()
  assert.equal(found.sources.length,3);assert.equal(found.sources[0].runtimeState,'running');assert.equal(found.sources[1].runtimeState,'unknown');assert.equal(found.sources[2].runtimeState,'not_detected')
  assert.equal(found.sources[1].launchMode,'cli');assert.equal(found.sources[2].directory,defaultHome)
  assert.notEqual(found.sources[0].id,'upstream-original-id');assert.deepEqual(found.issues,[])
  const rendered=JSON.stringify(found)
  for(const secret of ['fixture-secret','private-account-id','fixture-routing-secret','malformed private fixture credentials'])assert.equal(rendered.includes(secret),false)
  assert.deepEqual(readFileSync(file),before)
  let selectedPath='';const selected=f.scanner.select({id:found.sources[0].id},directory=>{selectedPath=directory;return f.select(directory)})
  assert.equal(selectedPath,first);assert.equal(selected.name,'工作实例');assert.equal(selected.history?.sessions,3)
  assert.equal(f.scanner.select({id:found.sources[0].id},f.select).directory,first,'Read-only discovery IDs remain reusable; each actual copy preview gets its own ticket')
})

test('only discovered opaque capabilities select a directory and expiry or rescan invalidates them',async t=>{
  const f=fixture(t),path=f.profile('external');f.registry([{name:'External',userDataDir:path}])
  let source=(await f.scanner.discover()).sources[0]
  assert.throws(()=>f.scanner.select({id:randomUUID()},f.select),/过期或不存在/)
  assert.throws(()=>f.scanner.select({id:source.id,directory:path},f.select))
  assert.throws(()=>f.scanner.select({id:path},f.select))
  f.advance();assert.throws(()=>f.scanner.select({id:source.id},f.select),/过期/)
  source=(await f.scanner.discover()).sources[0];await f.scanner.discover()
  assert.throws(()=>f.scanner.select({id:source.id},f.select),/过期或不存在/)
})

test('metadata edits, replacement directories and newly managed profiles reject stale selections',async t=>{
  const f=fixture(t),path=f.profile('external');f.registry([{name:'External',userDataDir:path}])
  let source=(await f.scanner.discover()).sources[0],called=0
  const select=(directory:string)=>{called++;return f.select(directory)}
  f.registry([{name:'Edited',userDataDir:path}]);assert.throws(()=>f.scanner.select({id:source.id},select),/实例列表已变化/)
  source=(await f.scanner.discover()).sources[0];renameSync(path,path+'-original');f.profile('external')
  assert.throws(()=>f.scanner.select({id:source.id},select),/目录已变化/)
  source=(await f.scanner.discover()).sources[0];f.managed.push(path)
  assert.throws(()=>f.scanner.select({id:source.id},select),/目录已变化/)
  assert.equal(called,0)
})

test('discovery excludes managed overlaps, symlink directories, unknown clients and unsupported launch modes',async t=>{
  const f=fixture(t),good=f.profile('good'),managed=f.profile('already-managed'),linked=join(f.home,'linked')
  f.managed.push(managed);symlinkSync(good,linked)
  writeFileSync(join(f.manager,'config.toml'),'fixture=true')
  f.registry([{name:'Good',userDataDir:good},{name:'Managed',userDataDir:managed},{name:'Manager',userDataDir:f.manager},{name:'Parent',userDataDir:f.home},{name:'Link',userDataDir:linked},{name:'Unknown client',userDataDir:f.profile('unsupported'),clientType:'claude'},{name:'Explicit null',userDataDir:f.profile('null-client'),clientType:null},{name:'Unknown launch',userDataDir:f.profile('unknown-mode'),launchMode:'future'}])
  const found=await f.scanner.discover()
  assert.deepEqual(found.sources.map(source=>source.name),['Good'])
  assert.ok(found.issues.some(issue=>issue.includes('客户端')));assert.ok(found.issues.some(issue=>issue.includes('安全读取')))
})

test('corrupt, linked and oversized metadata stays untouched and produces bounded generic issues',async t=>{
  const f=fixture(t),file=join(f.library,'codex_instances.json')
  for(const raw of ['{ malformed fixture-private',JSON.stringify({instances:Array.from({length:1001},()=>({name:'large'}))}),' '.repeat(4*1024*1024+1)]){
    writeFileSync(file,raw);const found=await f.scanner.discover()
    assert.deepEqual(found.sources,[]);assert.equal(found.issues.length,1);assert.equal(JSON.stringify(found).includes('fixture-private'),false);assert.equal(readFileSync(file,'utf8'),raw)
  }
  const target=join(f.root,'metadata.json');writeFileSync(target,JSON.stringify({instances:[]}));rmSync(file);symlinkSync(target,file)
  assert.equal((await f.scanner.discover()).issues.length,1)
})

test('discovery does not traverse beyond its fixed metadata roots and reports source limits',async t=>{
  const f=fixture(t),other=join(f.home,'not-a-known-library');mkdirSync(other)
  const external=f.profile('external');writeFileSync(join(other,'codex_instances.json'),JSON.stringify({instances:[{name:'Must not discover',userDataDir:external}]}))
  assert.equal((await f.scanner.discover()).sources.length,0)
  const records=Array.from({length:201},(_,index)=>({name:`Source ${index}`,userDataDir:f.profile('many-'+index)}));f.registry(records)
  let active=0,peak=0
  const scanner=new ExternalInstanceSources({home:f.home,managerRoot:f.manager,probeDaemon:async()=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return 'not_detected'}})
  const found=await scanner.discover();assert.equal(found.sources.length,200);assert.ok(found.issues.some(issue=>issue.includes('200')));assert.equal(peak,16)
})

test('unavailable runtime evidence stays unknown and concurrent scans cannot publish stale capabilities',async t=>{
  const f=fixture(t),path=f.profile('external');f.registry([{name:'External',userDataDir:path}]);f.states.set(path,'unavailable')
  assert.equal((await f.scanner.discover()).sources[0].runtimeState,'unknown')
  let complete!:(state:ClientDaemonState)=>void,calls=0
  const scanner=new ExternalInstanceSources({home:f.home,managerRoot:f.manager,probeDaemon:async()=>{if(++calls===1)return new Promise(resolve=>{complete=resolve});return 'not_detected'}})
  const first=scanner.discover(),rejected=assert.rejects(first,/扫描结果已更新/),latest=await scanner.discover();complete('running');await rejected
  assert.equal(latest.sources[0].runtimeState,'not_detected');assert.equal(scanner.select({id:latest.sources[0].id},f.select).directory,path)
})
