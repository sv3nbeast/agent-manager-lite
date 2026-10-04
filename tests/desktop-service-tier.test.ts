import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeDesktopServiceTier,previewDesktopServiceTier} from '../src/main/desktopServiceTier'
import {patchToml,TomlDocument} from '../src/main/tomlPatch'

function fixture(t:{after(fn:()=>void):void},initialTier:string|undefined='priority'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-desktop-tier-'))),directory=join(root,'home'),markerPath=join(root,'desktop-service-tier.json')
  mkdirSync(directory);t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,directory,markerPath,initialTier,file:join(directory,'config.toml'),global:join(directory,'.codex-global-state.json'),auth:join(directory,'auth.json')}
}

test('preview is read only; initialization seeds Fast once while preserving credentials, global state and comments',t=>{
  const f=fixture(t),config='# 保留\r\nmodel="fixture"\r\n[desktop]\r\nlocaleOverride="zh-CN"\r\n',auth='{"OPENAI_API_KEY":"fixture-untouched"}',global='{"composer":{"serviceTier":"default"}}'
  writeFileSync(f.file,config);writeFileSync(f.auth,auth);writeFileSync(f.global,global)
  const view=previewDesktopServiceTier(f)
  assert.equal(view.tier,'priority');assert.equal(view.source,'initial');assert.equal(view.initialized,false)
  assert.equal(readFileSync(f.file,'utf8'),config);assert.equal(existsSync(f.markerPath),false)
  const saved=initializeDesktopServiceTier(f,view.revision),after=readFileSync(f.file,'utf8')
  assert.equal(saved.tier,'priority');assert.equal(saved.initialized,true);assert.equal(new TomlDocument(after).scalar(['service_tier']),'fast')
  assert.ok(after.includes('# 保留\r\n'));assert.equal(new TomlDocument(after).scalar(['desktop','localeOverride']),'zh-CN')
  assert.equal(readFileSync(f.auth,'utf8'),auth);assert.equal(readFileSync(f.global,'utf8'),global)
  initializeDesktopServiceTier({...f,initialTier:'default'});assert.equal(readFileSync(f.file,'utf8'),after)
  assert.equal(statSync(f.markerPath).mode&0o777,0o600)
})

test('existing native choice wins over initial defaults and global state is left to the native client',t=>{
  for(const tier of ['default','fast','priority','auto','flex','scale','ultrafast']){
    const f=fixture(t),source=`# native choice\nservice_tier = "${tier}"\n`
    writeFileSync(f.file,source);writeFileSync(f.global,'{"electron-persisted-atom-state":{"composer-recent-model-configurations-v1":[{"serviceTier":"priority"}]}}')
    const global=readFileSync(f.global,'utf8'),view=initializeDesktopServiceTier(f)
    assert.equal(view.source,'existing');assert.equal(view.tier,tier==='fast'?'priority':tier)
    assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(readFileSync(f.global,'utf8'),global)
  }
})

test('user choosing ordinary or removing service_tier remains respected after later launches',t=>{
  const f=fixture(t);initializeDesktopServiceTier(f)
  writeFileSync(f.file,patchToml(readFileSync(f.file,'utf8'),[{path:['service_tier'],raw:'"default"'}]))
  const normal=readFileSync(f.file,'utf8')
  assert.equal(initializeDesktopServiceTier(f).tier,'default');assert.equal(readFileSync(f.file,'utf8'),normal)
  writeFileSync(f.file,patchToml(normal,[{path:['service_tier'],raw:null}]))
  const omitted=readFileSync(f.file,'utf8'),view=initializeDesktopServiceTier(f)
  assert.equal(view.source,'initialized');assert.equal(view.tier,undefined);assert.equal(readFileSync(f.file,'utf8'),omitted)
  rmSync(f.file);initializeDesktopServiceTier(f);assert.equal(existsSync(f.file),false)
})

test('follow mode marks initialization without forcing a tier or creating config',t=>{
  const f=fixture(t,undefined),view=initializeDesktopServiceTier({...f,initialTier:undefined})
  assert.equal(view.tier,undefined);assert.equal(view.source,'initialized');assert.equal(existsSync(f.file),false)
  assert.equal(initializeDesktopServiceTier({...f,initialTier:'priority'}).tier,undefined);assert.equal(existsSync(f.file),false)
})

test('preview revision protects config, native global-state and initial preference changes before writes',t=>{
  for(const change of ['config','global','initial']){
    const f=fixture(t),view=previewDesktopServiceTier(f)
    if(change==='config')writeFileSync(f.file,'service_tier="default"\n')
    if(change==='global')writeFileSync(f.global,'{"changed":true}')
    const options=change==='initial'?{...f,initialTier:'default'}:f
    assert.throws(()=>initializeDesktopServiceTier(options,view.revision),/已变化/)
    assert.equal(existsSync(f.markerPath),false)
    if(change!=='config')assert.equal(existsSync(f.file),false)
  }
})

test('profile overrides, malformed tiers and unsafe file paths fail without replacing any account data',t=>{
  for(const source of ['profile="custom"\n','profile=false\n','service_tier=42\n','service_tier=["fast"]\n','service_tier="unknown"\n','service_tier=""\n','service_tier="unterminated']){
    const f=fixture(t);writeFileSync(f.file,source);writeFileSync(f.auth,'fixture-preserve-auth')
    assert.throws(()=>initializeDesktopServiceTier(f));assert.equal(readFileSync(f.file,'utf8'),source)
    assert.equal(readFileSync(f.auth,'utf8'),'fixture-preserve-auth');assert.equal(existsSync(f.markerPath),false)
  }
  const f=fixture(t),outside=join(f.root,'outside');writeFileSync(outside,'preserve-outside')
  symlinkSync(outside,f.file);assert.throws(()=>initializeDesktopServiceTier(f),/安全读取/);rmSync(f.file)
  symlinkSync(outside,f.markerPath);assert.throws(()=>initializeDesktopServiceTier(f),/安全读取/);rmSync(f.markerPath)
  assert.throws(()=>initializeDesktopServiceTier({...f,markerPath:join(f.directory,'marker.json')}),/受管实例目录/)
  assert.throws(()=>initializeDesktopServiceTier({...f,initialTier:'arbitrary'}),/初始速度档位/)
  assert.equal(readFileSync(outside,'utf8'),'preserve-outside');assert.equal(existsSync(f.file),false)
})

test('oversized files and corrupt initialization records preserve the current files',t=>{
  const f=fixture(t)
  writeFileSync(f.file,'x'.repeat(1024*1024+1));assert.throws(()=>initializeDesktopServiceTier(f),/大小/);rmSync(f.file)
  writeFileSync(f.markerPath,'{"version":9}');assert.throws(()=>initializeDesktopServiceTier(f),/初始化记录/)
  assert.equal(readFileSync(f.markerPath,'utf8'),'{"version":9}');assert.equal(existsSync(f.file),false)
})
