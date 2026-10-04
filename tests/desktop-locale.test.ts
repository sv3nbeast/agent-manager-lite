import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeDesktopLocale,previewDesktopLocale,resolveDesktopLocale} from '../src/main/desktopLocale'
import {TomlDocument,patchToml} from '../src/main/tomlPatch'

function fixture(t:{after(fn:()=>void):void},systemLanguages=['zh-Hans-CN']) {
  const root=mkdtempSync(join(tmpdir(),'cml-locale-')),directory=join(root,'home'),markerPath=join(root,'desktop-locale.json')
  mkdirSync(directory);t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,directory,markerPath,systemLanguages,file:join(directory,'config.toml'),global:join(directory,'.codex-global-state.json')}
}
test('system languages resolve to bundled supported UI locales without using shell LANG',()=>{
  for(const [value,expected] of [['zh-Hans-CN','zh-CN'],['zh_Hans','zh-CN'],['zh-Hant-TW','zh-TW'],['zh-HK','zh-HK'],['en-GB','en-US'],['ja','ja-JP'],['pt-PT','pt-PT'],['fr-CA','fr-CA'],['xx-ZZ',undefined],['bad value',undefined]])assert.equal(resolveDesktopLocale(value),expected)
})
test('preview never writes; initialization keeps native auto detection and preserves the complete config',t=>{
  const f=fixture(t),source='# keep comment\nmodel="fixture"\n[desktop]\nappearanceTheme="dark"\n'
  writeFileSync(f.file,source)
  const preview=previewDesktopLocale(f);assert.equal(preview.locale,undefined);assert.equal(preview.effectiveLocale,'zh-CN');assert.equal(preview.source,'system');assert.equal(preview.initialized,false)
  assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(existsSync(f.markerPath),false)
  const result=initializeDesktopLocale(f,preview.revision),after=readFileSync(f.file,'utf8'),doc=new TomlDocument(after)
  assert.equal(result.initialized,true);assert.equal(result.source,'initialized');assert.equal(doc.raw(['desktop','localeOverride']),null);assert.equal(doc.scalar(['desktop','appearanceTheme']),'dark');assert.equal(after,source)
  assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'auto'})
  const english=initializeDesktopLocale({...f,systemLanguages:['en-US']})
  assert.equal(english.locale,undefined);assert.equal(english.effectiveLocale,'en-US');assert.equal(readFileSync(f.file,'utf8'),after)
})
test('new instances do not create a client config just to set a language',t=>{
  const f=fixture(t),view=initializeDesktopLocale(f)
  assert.equal(view.locale,undefined);assert.equal(view.effectiveLocale,'zh-CN');assert.equal(existsSync(f.file),false)
  assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'auto'})
})
test('an explicit English choice and unsupported existing value are not overwritten',t=>{
  const f=fixture(t),original='[desktop]\nlocaleOverride="en-US"\n'
  writeFileSync(f.file,original);assert.equal(initializeDesktopLocale(f).source,'existing');assert.equal(readFileSync(f.file,'utf8'),original)
  for(const raw of ['"not-a-locale"','42','["zh-CN"]']){writeFileSync(f.file,`[desktop]\nlocaleOverride=${raw}\n`);assert.equal(initializeDesktopLocale(f).source,'existing');assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).raw(['desktop','localeOverride']),raw)}
})
test('legacy top-level locale choice including null is preserved for official migration',t=>{
  const f=fixture(t)
  for(const value of ['zh-TW',null,42]) {
    rmSync(f.markerPath,{force:true});writeFileSync(f.global,JSON.stringify({localeOverride:value,'electron-persisted-atom-state':{keep:true}}))
    const before=readFileSync(f.global,'utf8'),view=initializeDesktopLocale(f)
    assert.equal(view.source,'legacy');assert.equal(view.locale,typeof value==='string'?value:undefined)
    assert.equal(readFileSync(f.global,'utf8'),before);assert.equal(existsSync(f.file),false)
  }
})
test('oversized existing and legacy language strings remain untouched and cannot poison initialization markers',t=>{
  const f=fixture(t),value='existing-user-value-'.repeat(100),original=`[desktop]\nlocaleOverride=${JSON.stringify(value)}\n`
  writeFileSync(f.file,original)
  for(let attempt=0;attempt<2;attempt++){
    const view=initializeDesktopLocale(f);assert.equal(view.source,'existing');assert.equal(view.locale,undefined)
    assert.equal(readFileSync(f.file,'utf8'),original);assert.equal(JSON.parse(readFileSync(f.markerPath,'utf8')).locale,undefined)
  }
  rmSync(f.file);rmSync(f.markerPath);const legacy=JSON.stringify({localeOverride:value});writeFileSync(f.global,legacy)
  for(let attempt=0;attempt<2;attempt++){
    const view=initializeDesktopLocale(f);assert.equal(view.source,'legacy');assert.equal(view.locale,undefined)
    assert.equal(readFileSync(f.global,'utf8'),legacy);assert.equal(existsSync(f.file),false)
    assert.equal(JSON.parse(readFileSync(f.markerPath,'utf8')).locale,undefined)
  }
})
test('user selecting auto detect by removing override remains respected after restart',t=>{
  const f=fixture(t);initializeDesktopLocale(f)
  writeFileSync(f.file,'[desktop]\nlocaleOverride="zh-CN"\n')
  assert.equal(initializeDesktopLocale(f).locale,'zh-CN')
  writeFileSync(f.file,patchToml(readFileSync(f.file,'utf8'),[{path:['desktop','localeOverride'],raw:null}]))
  const before=readFileSync(f.file,'utf8'),view=initializeDesktopLocale({...f,systemLanguages:['zh-Hans-CN']})
  assert.equal(view.source,'initialized');assert.equal(view.locale,undefined);assert.equal(readFileSync(f.file,'utf8'),before)
})
test('preferred languages skip unsupported choices and empty lists fall back to English',t=>{
  const f=fixture(t,['xx-ZZ','ko-KR']),view=initializeDesktopLocale(f)
  assert.equal(view.locale,undefined);assert.equal(view.effectiveLocale,'ko-KR');assert.equal(existsSync(f.file),false)
  const second=fixture(t,[]),fallback=initializeDesktopLocale(second)
  assert.equal(fallback.locale,undefined);assert.equal(fallback.effectiveLocale,'en-US');assert.equal(existsSync(second.file),false)
})
test('v1 system initialization migrates only its exact supported override to auto without replacing other config',t=>{
  const f=fixture(t,['en-US']),source='# keep comment\r\nmodel="fixture"\r\n[desktop]\r\nlocaleOverride="zh-CN" # original system seed\r\nappearanceTheme="dark"\r\n'
  writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  const preview=previewDesktopLocale(f)
  assert.equal(preview.locale,undefined);assert.equal(preview.source,'initialized');assert.equal(preview.effectiveLocale,'en-US')
  assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(JSON.parse(readFileSync(f.markerPath,'utf8')).version,1)
  const view=initializeDesktopLocale(f,preview.revision),after=readFileSync(f.file,'utf8')
  assert.equal(view.locale,undefined);assert.equal(view.effectiveLocale,'en-US')
  assert.equal(after,patchToml(source,[{path:['desktop','localeOverride'],raw:null}]))
  assert.equal(new TomlDocument(after).scalar(['desktop','appearanceTheme']),'dark')
  assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'auto'})
  initializeDesktopLocale(f);assert.equal(readFileSync(f.file,'utf8'),after)
})
test('v1 mismatches, original user choices and unsupported or malformed values are never migrated away',t=>{
  const f=fixture(t)
  const cases=[
    {marker:{version:1,source:'system',locale:'zh-CN'},raw:'"en-US"'},
    {marker:{version:1,source:'existing',locale:'zh-CN'},raw:'"zh-CN"'},
    {marker:{version:1,source:'legacy',locale:'zh-CN'},raw:'"zh-CN"'},
    {marker:{version:1,source:'system',locale:'not-a-locale'},raw:'"not-a-locale"'},
    {marker:{version:1,source:'system'},raw:'"zh-CN"'},
    {marker:{version:1,source:'system',locale:'zh-CN'},raw:'42'},
    {marker:{version:1,source:'system',locale:'zh-CN'},raw:'["zh-CN"]'}
  ]
  for(const {marker,raw} of cases){
    const source=`# keep\n[desktop]\nlocaleOverride=${raw}\n`
    writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify(marker))
    const view=initializeDesktopLocale(f)
    assert.equal(view.source,'existing');assert.equal(readFileSync(f.file,'utf8'),source)
    assert.equal(JSON.parse(readFileSync(f.markerPath,'utf8')).version,2)
  }
})
test('any legacy locale field prevents deleting a matching old system override',t=>{
  const f=fixture(t),source='[desktop]\nlocaleOverride="zh-CN"\n'
  for(const value of ['en-US',null,42]){
    const global=JSON.stringify({localeOverride:value,'electron-persisted-atom-state':{keep:true}})
    writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify({version:1,source:'system',locale:'zh-CN'}));writeFileSync(f.global,global)
    assert.equal(initializeDesktopLocale(f).source,'existing')
    assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(readFileSync(f.global,'utf8'),global)
    assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'existing',locale:'zh-CN'})
  }
})
test('an old system marker without an override finishes migration and never recreates the old language',t=>{
  const f=fixture(t,['ja-JP']),source='# partial migration or user chose auto\n[desktop]\nappearanceTheme="dark"\n'
  writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  const view=initializeDesktopLocale(f)
  assert.equal(view.locale,undefined);assert.equal(view.effectiveLocale,'ja-JP');assert.equal(readFileSync(f.file,'utf8'),source)
  assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'auto'})
})
test('after migration a manual choice of the former seeded language is preserved on every restart',t=>{
  const f=fixture(t),source='[desktop]\nlocaleOverride="zh-CN"\n'
  writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  initializeDesktopLocale(f);assert.equal(new TomlDocument(readFileSync(f.file,'utf8')).raw(['desktop','localeOverride']),null)
  writeFileSync(f.file,source)
  for(const languages of [['zh-Hans-CN'],['en-US']]){
    const view=initializeDesktopLocale({...f,systemLanguages:languages})
    assert.equal(view.source,'existing');assert.equal(view.locale,'zh-CN');assert.equal(readFileSync(f.file,'utf8'),source)
    assert.deepEqual(JSON.parse(readFileSync(f.markerPath,'utf8')),{version:2,source:'auto'})
  }
})
test('a malformed legacy document prevents deletion of a matching old system override',t=>{
  const f=fixture(t),source='[desktop]\nlocaleOverride="zh-CN"\n',marker=JSON.stringify({version:1,source:'system',locale:'zh-CN'})
  writeFileSync(f.file,source);writeFileSync(f.markerPath,marker);writeFileSync(f.global,'{')
  assert.throws(()=>initializeDesktopLocale(f),/原语言设置/)
  assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(readFileSync(f.markerPath,'utf8'),marker)
})
test('changing effective auto language or the migration marker invalidates a preview before writing',t=>{
  const f=fixture(t),preview=previewDesktopLocale(f)
  assert.throws(()=>initializeDesktopLocale({...f,systemLanguages:['en-US']},preview.revision),/已变化/)
  assert.equal(existsSync(f.markerPath),false);assert.equal(existsSync(f.file),false)
  const source='[desktop]\nlocaleOverride="zh-CN"\n'
  writeFileSync(f.file,source);writeFileSync(f.markerPath,JSON.stringify({version:1,source:'system',locale:'zh-CN'}))
  const migration=previewDesktopLocale(f),changedMarker=JSON.stringify({version:1,source:'existing',locale:'zh-CN'})
  writeFileSync(f.markerPath,changedMarker)
  assert.throws(()=>initializeDesktopLocale(f,migration.revision),/已变化/)
  assert.equal(readFileSync(f.file,'utf8'),source);assert.equal(readFileSync(f.markerPath,'utf8'),changedMarker)
})
test('config or legacy language changes invalidate a launch preview before any writes',t=>{
  const f=fixture(t),preview=previewDesktopLocale(f);writeFileSync(f.file,'[desktop]\nlocaleOverride="fr-FR"\n')
  assert.throws(()=>initializeDesktopLocale(f,preview.revision),/已变化/);assert.equal(existsSync(f.markerPath),false)
  const next=previewDesktopLocale(f);writeFileSync(f.global,'{"localeOverride":"zh-TW"}')
  assert.throws(()=>initializeDesktopLocale(f,next.revision),/已变化/);assert.equal(existsSync(f.markerPath),false)
})
test('unsafe links, oversized or malformed state fail without replacing user files',t=>{
  const f=fixture(t),outside=join(f.root,'outside');writeFileSync(outside,'keep')
  symlinkSync(outside,f.file);assert.throws(()=>initializeDesktopLocale(f),/安全读取/);assert.equal(readFileSync(outside,'utf8'),'keep');rmSync(f.file)
  symlinkSync(outside,f.markerPath);assert.throws(()=>initializeDesktopLocale(f),/安全读取/);rmSync(f.markerPath)
  writeFileSync(f.file,'x'.repeat(1024*1024+1));assert.throws(()=>initializeDesktopLocale(f),/大小/);rmSync(f.file)
  writeFileSync(f.global,'{');assert.throws(()=>initializeDesktopLocale(f),/原语言设置/);assert.equal(existsSync(f.markerPath),false)
  rmSync(f.global);writeFileSync(f.markerPath,'not json');assert.throws(()=>initializeDesktopLocale(f),/初始化记录/);assert.equal(existsSync(f.file),false)
})
