import assert from 'node:assert/strict'
import {test} from 'node:test'
import {lstatSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync,readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../src/main/store'
import {CodexSessionSources} from '../src/main/codexSessionSources'
import {ClientConfigs} from '../src/main/clientConfig'
import {exportBackupState} from '../src/main/dataBackupState'

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-codex-session-sources-'))),manager=join(root,'manager'),source=join(root,'external-codex')
  mkdirSync(source);mkdirSync(join(source,'sessions'));writeFileSync(join(source,'sessions','example.jsonl'),'unchanged\n')
  const codec={encrypt:(text:string)=>Buffer.from(text),decrypt:(data:Buffer)=>data.toString()}
  const store=new Store(manager,codec)
  return {root,manager,source,codec,store}
}

test('external source persists independently of config targets and is excluded from portable backup',t=>{
  const f=fixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}))
  const before=lstatSync(f.source),treeBefore=readdirSync(f.source).sort(),contentBefore=readFileSync(join(f.source,'sessions','example.jsonl'),'utf8')
  const registry=new CodexSessionSources(f.store,()=>1234),registered=registry.register(f.source,'Other Codex')
  assert.equal(registered.readOnly,true);assert.equal(registered.available,true);assert.equal(registered.createdAt,1234)
  assert.deepEqual(new ClientConfigs(f.store).targets().filter(target=>target.directory===f.source),[])
  assert.deepEqual(f.store.read().configTargets??[],[])
  const reopened=new Store(f.manager,f.codec),afterRestart=new CodexSessionSources(reopened).list()
  assert.equal(afterRestart.length,1);assert.equal(afterRestart[0].id,registered.id);assert.equal(afterRestart[0].enabled,true)
  const portable=exportBackupState(reopened.read(),{})
  assert.equal('codexSessionSources' in portable.state,false)
  assert.equal(lstatSync(f.source).ino,before.ino);assert.deepEqual(readdirSync(f.source).sort(),treeBefore);assert.equal(readFileSync(join(f.source,'sessions','example.jsonl'),'utf8'),contentBefore)
})

test('directory replacement fails closed and can only be recovered by explicit remove and reselect',t=>{
  const f=fixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}))
  const registry=new CodexSessionSources(f.store),registered=registry.register(f.source)
  const moved=join(f.root,'old-source');renameSync(f.source,moved);mkdirSync(f.source);mkdirSync(join(f.source,'sessions'))
  assert.throws(()=>registry.resolve(registered.id),/已被替换或身份发生变化/)
  assert.equal(registry.list()[0].available,false)
  assert.throws(()=>registry.register(f.source),/已被替换/)
  registry.disable(registered.id);assert.equal(registry.list()[0].enabled,false);assert.throws(()=>registry.resolve(registered.id),/已停用/)
  assert.throws(()=>registry.enable(registered.id),/已被替换/)
  registry.remove(registered.id);assert.equal(registry.list().length,0)
  assert.equal(readFileSync(join(moved,'sessions','example.jsonl'),'utf8'),'unchanged\n')
})

test('registration rejects symlinks, managed/config overlaps and overlapping external roots',t=>{
  const f=fixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}))
  const registry=new CodexSessionSources(f.store),alias=join(f.root,'source-link');symlinkSync(f.source,alias)
  assert.throws(()=>registry.register(alias),/不能使用符号链接/)
  const managed=join(f.manager,'instances','fixture','home');mkdirSync(managed,{recursive:true})
  f.store.transaction(state=>{state.instances=[{id:'22222222-2222-4222-8222-222222222222',name:'Fixture',applicationId:'test',accountId:'',connectionMode:'native',defaultTier:'inherit',model:'',extraArgs:[],revision:0,createdAt:1} as never]})
  assert.throws(()=>registry.register(managed),/管理器数据、实例目录或客户端配置/)
  const config=join(f.root,'client-config');mkdirSync(config);mkdirSync(join(config,'child'));f.store.transaction(state=>{state.configTargets=[{id:'11111111-1111-4111-8111-111111111111',name:'config',directory:config,managed:false,device:lstatSync(config).dev,inode:lstatSync(config).ino}]})
  assert.throws(()=>registry.register(join(config,'child')),/管理器数据、实例目录或客户端配置/)
  const parent=join(f.root,'external-root');mkdirSync(join(parent,'sessions'),{recursive:true})
  const first=registry.register(parent);assert.ok(first.id)
  const child=join(parent,'nested');mkdirSync(child)
  assert.throws(()=>registry.register(child),/不能相同或相互重叠/)
})
