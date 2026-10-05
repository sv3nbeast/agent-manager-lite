import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,renameSync,symlinkSync,readdirSync} from 'node:fs'
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

test('staged session provider projection keeps all history fields and body bytes while indexing active and archived copies',async t=>{
  const f=fixture(t),signal=new AbortController().signal,finalHome=join(f.root,'final')
  const folders=['sessions','archived_sessions']
  const body=Buffer.from('{"type":"event_msg","payload":{"text":"中文 😀 mentions '+f.source+' and \\u0000","provider":"do-not-touch"}}\r\ninvalid literal body\n')
  const raws=new Map<string,Buffer>()
  for(const [i,folder]of folders.entries()){
    mkdirSync(join(f.source,folder));const path=join(f.source,folder,'rollout-fixture.jsonl')
    const header=JSON.stringify({type:'session_meta',timestamp:'fixture',payload:{id:'session-'+i,model_provider:i?'other_provider':'cockpit_cli_proxy',cwd:'/outside/project',title:'unchanged',extra:{model_provider:'preserve'}}})+'\r\n'
    const raw=Buffer.concat([Buffer.from(header),body]);writeFileSync(path,raw);raws.set(folder,raw)
  }
  writeFileSync(join(f.source,'config.toml'),'model_provider="cockpit_cli_proxy"\n')
  const dbPath=join(f.source,'state_5.sqlite'),db=new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,cwd TEXT,title TEXT,archived INTEGER,extra TEXT)')
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)')
  insert.run('session-0',join(f.source,'sessions','rollout-fixture.jsonl'),'cockpit_cli_proxy','/outside/project','title zero',0,'tool state')
  insert.run('session-1','archived_sessions/rollout-fixture.jsonl','other_provider','/outside/project','title one',1,'archive state')
  db.close();const original=readFileSync(dbPath)
  const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  await relocateCopiedProfile(manifest,f.target,finalHome,signal,'cml_instance')
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  const rows=copied.prepare('SELECT * FROM threads ORDER BY id').all();copied.close()
  assert.deepEqual(rows.map(row=>[row.id,row.model_provider,row.cwd,row.title,row.archived,row.extra]),[
    ['session-0','cml_instance','/outside/project','title zero',0,'tool state'],['session-1','cml_instance','/outside/project','title one',1,'archive state']])
  assert.equal(rows[0].rollout_path,join(finalHome,'sessions','rollout-fixture.jsonl'));assert.equal(rows[1].rollout_path,'archived_sessions/rollout-fixture.jsonl')
  assert.deepEqual(readFileSync(dbPath),original)
  for(const folder of folders){
    const copiedRaw=readFileSync(join(f.target,folder,'rollout-fixture.jsonl')),newline=copiedRaw.indexOf(10)
    const metadata=JSON.parse(copiedRaw.subarray(0,newline).toString()).payload
    assert.equal(metadata.model_provider,'cml_instance');assert.equal(metadata.extra.model_provider,'preserve');assert.equal(metadata.cwd,'/outside/project')
    assert.deepEqual(copiedRaw.subarray(newline+1),body);assert.equal(copiedRaw[newline-1],13)
    assert.deepEqual(readFileSync(join(f.source,folder,'rollout-fixture.jsonl')),raws.get(folder))
    assert.deepEqual(readdirSync(join(f.target,folder)),['rollout-fixture.jsonl'])
  }
  assert.equal(readFileSync(join(f.target,'config.toml'),'utf8'),'model_provider="cockpit_cli_proxy"\n')
})

test('copied provider migration rejects unknown SQLite history schemas and indexed files without session metadata',async t=>{
  const f=fixture(t),signal=new AbortController().signal
  mkdirSync(join(f.source,'sessions'));writeFileSync(join(f.source,'sessions','fixture.jsonl'),'unrecognized history format')
  const dbPath=join(f.source,'state_5.sqlite'),db=new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES(?,?)').run('fixture','sessions/fixture.jsonl');db.close()
  const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  await assert.rejects(relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal,'cml_instance'),/数据库/)
  const staged=new DatabaseSync(join(f.target,'state_5.sqlite'));staged.exec('ALTER TABLE threads ADD COLUMN model_provider TEXT');staged.close()
  await assert.rejects(relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal,'cml_instance'),/元数据/)
  assert.equal(readFileSync(join(f.source,'sessions','fixture.jsonl'),'utf8'),'unrecognized history format')
  assert.deepEqual(readdirSync(join(f.target,'sessions')),['fixture.jsonl'])
})

test('streaming metadata projection preserves a large conversation and cancels without replacing the staged rollout',async t=>{
  const f=fixture(t),signal=new AbortController().signal
  mkdirSync(join(f.source,'sessions'));const path=join(f.source,'sessions','rollout-large.jsonl')
  const header=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:'large',model_provider:'old'}})+'\n')
  const body=Buffer.alloc(16*1024*1024,65);writeFileSync(path,Buffer.concat([header,body]))
  const manifest=await scanInstanceHome(f.source,signal);await copyInstanceHome(manifest,f.target,signal,()=>{})
  const controller=new AbortController(),task=relocateCopiedProfile(manifest,f.target,join(f.root,'final'),controller.signal,'cml_instance');setImmediate(()=>controller.abort())
  await assert.rejects(task,/abort/i)
  assert.deepEqual(readFileSync(join(f.target,'sessions','rollout-large.jsonl')),readFileSync(path));assert.deepEqual(readdirSync(join(f.target,'sessions')),['rollout-large.jsonl'])
  await relocateCopiedProfile(manifest,f.target,join(f.root,'final'),signal,'cml_instance')
  const copied=readFileSync(join(f.target,'sessions','rollout-large.jsonl')),newline=copied.indexOf(10)
  assert.equal(JSON.parse(copied.subarray(0,newline).toString()).payload.model_provider,'cml_instance');assert.deepEqual(copied.subarray(newline+1),body)
})
