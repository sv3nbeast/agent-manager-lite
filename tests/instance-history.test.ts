import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {readInstanceHistory} from '../src/main/instanceHistory'

function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-history-'))),home=join(root,'home'),project=join(root,'项目')
  mkdirSync(home);mkdirSync(project);t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,home,project}
}
function state(home:string,value:Record<string,unknown>){writeFileSync(join(home,'.codex-global-state.json'),JSON.stringify(value))}
function database(home:string){
  const path=join(home,'state_5.sqlite'),db=new DatabaseSync(path)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,source TEXT,thread_source TEXT,has_user_event INTEGER,archived INTEGER,project_id TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT)')
  return{db,path,thread:(id:string,cwd:string,options:{source?:string;kind?:string;user?:number;archived?:boolean;projectId?:string}={})=>db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,cwd,options.source??'cli',options.kind??'user',options.user??1,options.archived?1:0,options.projectId??null)}
}
function rollout(home:string,id:string,cwd:string,options:{source?:unknown;archived?:boolean;tail?:string}={}){
  const folder=join(home,options.archived?'archived_sessions':'sessions');mkdirSync(folder,{recursive:true})
  const path=join(folder,'rollout-'+id+'.jsonl')
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,cwd,source:options.source??'cli'}})+'\n'+(options.tail??'{"type":"event_msg","payload":{"message":"private fixture body"}}\n'))
  return path
}

test('history preserves explicit project and projectless membership while supporting SQL server IDs and root hints',t=>{
  const f=fixture(t),gone=join(f.project,'已移除'),known={id:'legacy',name:'主要项目',rootPaths:[f.project],createdAt:1,updatedAt:2},nested={id:'nested',name:'原目录',rootPaths:[gone],createdAt:1,updatedAt:2}
  state(f.home,{'local-projects':{legacy:known,nested},'project-order':['nested','legacy'],'thread-project-assignments':{assigned:{projectKind:'local',projectId:'legacy'}},'projectless-thread-ids':['projectless'],'thread-workspace-root-hints':{hint:gone},'app-server-project-id-by-legacy-project-id-by-host':{['local:'+f.home]:{legacy:'server'}}})
  const d=database(f.home)
  d.db.prepare('INSERT INTO projects VALUES(?,?)').run('server','主要项目');d.db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('server',0,f.project)
  d.thread('assigned',gone);d.thread('sql',gone,{projectId:'server',archived:true});d.thread('hint',f.project);d.thread('nested-cwd',join(gone,'file'));d.thread('projectless',f.project,{projectId:'server'});d.thread('outside',f.root)
  d.thread('internal',f.project,{kind:'subagent'});d.thread('spawn',f.project,{source:'{"subagent":{"thread_spawn":{"parent_thread_id":"assigned"}}}'});d.thread('empty',f.project,{user:0});d.db.close()
  const before=readFileSync(d.path),metadata=readFileSync(join(f.home,'.codex-global-state.json')),result=readInstanceHistory(f.home)
  assert.equal(result.sessions,6);assert.equal(result.archived,1);assert.equal(result.unassigned,2)
  assert.deepEqual(result.projects,[{path:gone,name:'原目录',exists:false,sessions:2},{path:f.project,name:'主要项目',exists:true,sessions:2}])
  assert.deepEqual(readFileSync(d.path),before);assert.deepEqual(readFileSync(join(f.home,'.codex-global-state.json')),metadata);assert.deepEqual(result.issues,[])
})

test('history never invents displayed projects from SQL-only roots or conversation cwd',t=>{
  const f=fixture(t);state(f.home,{'local-projects':{}})
  const d=database(f.home);d.db.prepare('INSERT INTO projects VALUES(?,?)').run('server','hidden');d.db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('server',0,f.project);d.thread('a',f.project,{projectId:'server'});d.db.close()
  const result=readInstanceHistory(f.home)
  assert.equal(result.sessions,1);assert.equal(result.unassigned,1);assert.deepEqual(result.projects,[]);assert.match(result.issues.join(' '),/项目列表为空/)
})

test('SQL project IDs can match a unique displayed project with identical roots without host migration metadata',t=>{
  const f=fixture(t);state(f.home,{'local-projects':{local:{id:'local',name:'项目',rootPaths:[f.project]}}})
  const d=database(f.home);d.db.prepare('INSERT INTO projects VALUES(?,?)').run('server','same');d.db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('server',0,f.project);d.thread('a',f.root,{projectId:'server'});d.db.close()
  assert.equal(readInstanceHistory(f.home).projects[0].sessions,1)
})

test('missing databases use bounded metadata headers and exclude derived threads without parsing private bodies',t=>{
  const f=fixture(t)
  state(f.home,{'electron-saved-workspace-roots':[f.project],'electron-workspace-root-labels':{[f.project]:'旧版项目'},'projectless-thread-ids':['no-project']})
  const active=rollout(f.home,'active',f.project,{tail:'malformed private body '+Buffer.alloc(128*1024,65).toString()})
  rollout(f.home,'archived',f.project,{archived:true});rollout(f.home,'no-project',f.project);rollout(f.home,'spawn',f.project,{source:{subagent:{other:'guardian'}}})
  const before=readFileSync(active),result=readInstanceHistory(f.home)
  assert.equal(result.sessions,3);assert.equal(result.archived,1);assert.equal(result.projects[0].sessions,2);assert.equal(result.unassigned,1)
  assert.match(result.issues.join(' '),/仅统计会话头部/);assert.ok(!JSON.stringify(result).includes('private body'));assert.deepEqual(readFileSync(active),before)
})

test('empty profiles return zero instead of estimating sessions from project lists',t=>{
  const f=fixture(t);state(f.home,{'local-projects':{p:{id:'p',name:'空项目',rootPaths:[f.project]}}})
  assert.deepEqual(readInstanceHistory(f.home),{sessions:0,archived:0,projects:[{path:f.project,name:'空项目',exists:true,sessions:0}],unassigned:0,issues:[]})
})

test('symlinked metadata, database and profile directories do not expose outside contents',t=>{
  const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside)
  state(outside,{'local-projects':{secret:{id:'secret',name:'do-not-show',rootPaths:[f.project]}}})
  const d=database(outside);d.thread('outside',f.project);d.db.close()
  symlinkSync(join(outside,'.codex-global-state.json'),join(f.home,'.codex-global-state.json'));symlinkSync(join(outside,'state_5.sqlite'),join(f.home,'state_5.sqlite'))
  const result=readInstanceHistory(f.home)
  assert.equal(result.sessions,0);assert.deepEqual(result.projects,[]);assert.ok(result.issues.length>=2);assert.ok(!JSON.stringify(result).includes('do-not-show'))
  const linked=join(f.root,'linked');symlinkSync(outside,linked);assert.deepEqual(readInstanceHistory(linked).issues,['实例目录无法安全读取'])
})

test('configured external SQLite and WAL symlinks are rejected; diagnostics never include SQL or file contents',t=>{
  const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside)
  const d=database(outside);d.thread('outside',f.project);d.db.close()
  writeFileSync(join(f.home,'config.toml'),'sqlite_home='+JSON.stringify(outside)+'\napi_key="fixture-private-key"\n')
  let result=readInstanceHistory(f.home);assert.equal(result.sessions,0);assert.match(result.issues.join(' '),/目录外/);assert.ok(!JSON.stringify(result).includes('fixture-private-key'))
  rmSync(join(f.home,'config.toml'));writeFileSync(join(f.home,'state_5.sqlite'),'not SQLite; secret SQL body');result=readInstanceHistory(f.home)
  assert.equal(result.sessions,0);assert.ok(result.issues.length);assert.ok(!JSON.stringify(result).includes('secret SQL body'))
  rmSync(join(f.home,'state_5.sqlite'));const own=database(f.home);own.thread('own',f.project);own.db.close();symlinkSync(join(outside,'state_5.sqlite'),join(f.home,'state_5.sqlite-wal'))
  result=readInstanceHistory(f.home);assert.equal(result.sessions,0);assert.ok(result.issues.length)
})

test('safe internal sqlite_home is respected and parent-directory symlinks are rejected',t=>{
  const f=fixture(t),nested=join(f.home,'state');mkdirSync(nested);const d=database(nested);d.thread('a',f.project);d.db.close()
  writeFileSync(join(f.home,'config.toml'),'sqlite_home="state"\n');assert.equal(readInstanceHistory(f.home).sessions,1)
  rmSync(join(f.home,'config.toml'));rmSync(nested,{recursive:true});symlinkSync(f.project,nested);writeFileSync(join(f.home,'config.toml'),'sqlite_home="state"\n')
  const result=readInstanceHistory(f.home);assert.equal(result.sessions,0);assert.match(result.issues.join(' '),/安全读取/)
})

test('reading a closed WAL-mode database creates no SQLite files and retains all persisted user sessions',t=>{
  const f=fixture(t),d=database(f.home);d.db.exec('PRAGMA journal_mode=WAL');d.thread('a',f.project);d.db.close()
  const before=readdirSync(f.home).sort(),bytes=readFileSync(d.path)
  assert.deepEqual(before,['state_5.sqlite'])
  const result=readInstanceHistory(f.home)
  assert.equal(result.sessions,1);assert.deepEqual(readdirSync(f.home).sort(),before);assert.deepEqual(readFileSync(d.path),bytes)
  assert.match(result.issues.join(' '),/未保存项目分组/);assert.ok(!result.issues.join(' ').includes('尚未恢复'))
})

test('reading a live WAL database includes uncheckpointed rows without modifying persisted database or WAL data',t=>{
  const f=fixture(t),d=database(f.home);d.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');d.thread('wal-row',f.project)
  try{
    const before=new Map(readdirSync(f.home).map(name=>[name,readFileSync(join(f.home,name))]))
    assert.equal(readInstanceHistory(f.home).sessions,1)
    assert.deepEqual(readdirSync(f.home).sort(),[...before.keys()].sort())
    // SQLite can update transient reader marks in an existing SHM even for a
    // read-only connection. The persisted database and WAL must stay identical.
    for(const [name,bytes]of before)if(!name.endsWith('-shm'))assert.deepEqual(readFileSync(join(f.home,name)),bytes,name+' modified')
  }finally{d.db.close()}
})

test('a profile beneath a symbolic parent is rejected before any metadata is read',t=>{
  const f=fixture(t),linked=join(f.root,'linked-parent');symlinkSync(f.root,linked)
  assert.deepEqual(readInstanceHistory(join(linked,'home')).issues,['实例目录无法安全读取'])
})
