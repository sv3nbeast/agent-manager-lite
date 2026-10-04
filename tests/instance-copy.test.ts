import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,renameSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {copyInstanceHome,scanInstanceHome,relocateCopiedProfile} from '../src/main/instanceCopy'
import {DatabaseSync} from 'node:sqlite'
import {TomlDocument} from '../src/main/tomlPatch'

function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-copy-'))),source=join(root,'source'),target=join(root,'target');mkdirSync(source)
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,source,target}
}
test('large profile file copy is bounded, reports bytes and responds to cancellation mid-file',async t=>{
  const f=fixture(t),controller=new AbortController();writeFileSync(join(f.source,'large'),Buffer.alloc(8*1024*1024,1))
  const manifest=await scanInstanceHome(f.source,controller.signal);let observed=0
  await assert.rejects(copyInstanceHome(manifest,f.target,controller.signal,(_files,bytes)=>{observed=bytes;controller.abort()}),/abort/i)
  assert.equal(observed,1024*1024);assert.equal(readFileSync(join(f.target,'large')).length,observed);assert.equal(readFileSync(join(f.source,'large')).length,8*1024*1024)
})
test('copy detects source mutation and substituted directories instead of reading outside its source',async t=>{
  const f=fixture(t),signal=new AbortController().signal;mkdirSync(join(f.source,'nested'));writeFileSync(join(f.source,'nested','file'),'first')
  const manifest=await scanInstanceHome(f.source,signal)
  renameSync(join(f.source,'nested'),join(f.source,'moved'));symlinkSync(join(f.source,'moved'),join(f.source,'nested'))
  await assert.rejects(copyInstanceHome(manifest,f.target,signal,()=>{}),/改变/)
  rmSync(join(f.source,'nested'));renameSync(join(f.source,'moved'),join(f.source,'nested'));rmSync(f.target,{recursive:true,force:true})
  const next=await scanInstanceHome(f.source,signal)
  await assert.rejects(copyInstanceHome(next,f.target,signal,files=>{if(files===1)writeFileSync(join(f.source,'nested','file'),'changed')}),/变化/)
})

test('file login exclusion is case insensitive on case-insensitive filesystems',async t=>{
  const f=fixture(t),signal=new AbortController().signal;writeFileSync(join(f.source,'AUTH.JSON'),'fixture-sensitive-login')
  const manifest=await scanInstanceHome(f.source,signal);assert.equal(manifest.files,0);assert.equal(manifest.skipped,1)
  await copyInstanceHome(manifest,f.target,signal,()=>{});assert.throws(()=>readFileSync(join(f.target,'AUTH.JSON')),/ENOENT/)
})

test('copy relocates actual SQLite rollout references and managed catalogs without changing source or conversation content',async t=>{
  const f=fixture(t),signal=new AbortController().signal,session=join(f.source,'sessions','fixture.jsonl'),dbPath=join(f.source,'state_5.sqlite')
  mkdirSync(join(f.source,'sessions'));writeFileSync(session,'conversation mentions '+f.source+' without path rewriting')
  writeFileSync(join(f.source,'catalog.json'),'{"models":[]}')
  writeFileSync(join(f.source,'config.toml'),'# preserve comments\nmodel_catalog_json='+JSON.stringify(join(f.source,'catalog.json'))+'\ncustom="keep"\n')
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, extra TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('a',session,'/external/project','unchanged')
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('b','sessions/fixture.jsonl','/external/project','relative')
  db.close();const original=readFileSync(dbPath)
  const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  const finalHome=join(f.root,'final-home');await relocateCopiedProfile(manifest,f.target,finalHome,signal)
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  const rows=copied.prepare('SELECT * FROM threads ORDER BY id').all();copied.close()
  assert.equal(rows[0].rollout_path,join(finalHome,'sessions','fixture.jsonl'));assert.equal(rows[0].cwd,'/external/project');assert.equal(rows[0].extra,'unchanged')
  assert.equal(rows[1].rollout_path,'sessions/fixture.jsonl');assert.deepEqual(readFileSync(dbPath),original)
  assert.equal(new TomlDocument(readFileSync(join(f.target,'config.toml'),'utf8')).scalar(['model_catalog_json']),join(finalHome,'catalog.json'))
  assert.equal(readFileSync(join(f.target,'sessions','fixture.jsonl'),'utf8'),'conversation mentions '+f.source+' without path rewriting')
})

test('copy refuses malformed or externally shared session indexes and cancels multi-page SQLite migration',async t=>{
  const f=fixture(t),signal=new AbortController().signal;mkdirSync(join(f.source,'sessions'));writeFileSync(join(f.source,'sessions','fixture.jsonl'),'fixture')
  const dbPath=join(f.source,'state_5.sqlite'),db=new DatabaseSync(dbPath);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)')
  const insert=db.prepare('INSERT INTO threads VALUES(?,?)');for(let i=0;i<1200;i++)insert.run(String(i).padStart(5,'0'),join(f.source,'sessions','fixture.jsonl'))
  db.close();const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  const controller=new AbortController(),task=relocateCopiedProfile(manifest,f.target,join(f.root,'final'),controller.signal);setImmediate(()=>controller.abort())
  await assert.rejects(task,/abort/i)
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'));assert.equal(copied.prepare('SELECT DISTINCT rollout_path FROM threads').all().length,1)
  assert.equal(copied.prepare('SELECT rollout_path FROM threads LIMIT 1').get()!.rollout_path,join(f.source,'sessions','fixture.jsonl'))
  copied.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run('/another/profile/session.jsonl','00000');copied.close()
  await assert.rejects(relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal),/目录外/)
  writeFileSync(join(f.target,'state_5.sqlite'),'invalid database')
  await assert.rejects(relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal),/数据库/)
})

test('copy prevents a configured external session database from becoming shared by the new instance',async t=>{
  const f=fixture(t),signal=new AbortController().signal
  for(const value of ['/outside/shared-sqlite','../another-instance','..','nested/../..','~/external-db']){
    writeFileSync(join(f.source,'config.toml'),'sqlite_home='+JSON.stringify(value)+'\n')
    const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
    await assert.rejects(relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal),/目录外/)
    rmSync(f.target,{recursive:true,force:true})
  }
  for(const value of ['..foo','nested/../..foo','.',join(f.source,'future-database')]){
    writeFileSync(join(f.source,'config.toml'),'sqlite_home='+JSON.stringify(value)+'\n')
    const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
    const finalHome=join(f.root,'final');await relocateCopiedProfile(manifest,f.target,finalHome,signal)
    const copied=new TomlDocument(readFileSync(join(f.target,'config.toml'),'utf8'))
    assert.equal(copied.scalar(['sqlite_home']),value===join(f.source,'future-database')?join(finalHome,'future-database'):value)
    rmSync(f.target,{recursive:true,force:true})
  }
})

test('named profile config layers relocate internal paths and cannot share an external session database',async t=>{
  const f=fixture(t),signal=new AbortController().signal,finalHome=join(f.root,'final')
  const named='# named layer\nlog_dir='+JSON.stringify(join(f.source,'future-logs'))+'\nmodel_catalog_json='+JSON.stringify(join(f.source,'models.json'))+'\ncustom="keep"\n'
  writeFileSync(join(f.source,'work-profile.config.toml'),named)
  writeFileSync(join(f.source,'other.toml'),'log_dir='+JSON.stringify(f.source)+'\n')
  const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  await relocateCopiedProfile(manifest,f.target,finalHome,signal)
  const copied=new TomlDocument(readFileSync(join(f.target,'work-profile.config.toml'),'utf8'))
  assert.equal(copied.scalar(['log_dir']),join(finalHome,'future-logs'));assert.equal(copied.scalar(['model_catalog_json']),join(finalHome,'models.json'))
  assert.equal(copied.scalar(['custom']),'keep');assert.equal(readFileSync(join(f.source,'work-profile.config.toml'),'utf8'),named)
  assert.equal(readFileSync(join(f.target,'other.toml'),'utf8'),readFileSync(join(f.source,'other.toml'),'utf8'))
  writeFileSync(join(f.target,'work-profile.config.toml'),'sqlite_home="/external/database"\n')
  await assert.rejects(relocateCopiedProfile(manifest,f.target,finalHome,signal),/目录外/)
})
