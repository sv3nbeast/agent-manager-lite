import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {copyInstanceHome,scanInstanceHome,relocateCopiedProfile} from '../src/main/instanceCopy'
import {copiedProjectStateFile,copiedProjectStateLimit} from '../src/main/copiedProjectState'

function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-project-copy-'))),source=join(root,'source'),target=join(root,'target'),final=join(root,'final');mkdirSync(source)
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,source,target,final}
}

test('profile copy keeps the project graph aligned with copied sessions and relocates only its local host',async t=>{
  const f=fixture(t),signal=new AbortController().signal
  mkdirSync(join(f.source,'worktrees','fixture'),{recursive:true})
  writeFileSync(join(f.source,'worktrees','fixture','app.ts'),'original project source')
  mkdirSync(join(f.source,'sessions'))
  const body='{"type":"response_item","payload":{"text":"unchanged conversation"}}\n'
  writeFileSync(join(f.source,'sessions','rollout-thread.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'thread',model_provider:'source-provider',cwd:'/external/project'}})+'\n'+body)
  const state={
    'local-projects':{legacy:{id:'legacy',name:'中文项目',rootPaths:['/external/project',join(f.source,'worktrees','fixture')],createdAt:1,updatedAt:2}},
    'project-order':['legacy'],'electron-saved-workspace-roots':['/external/project',join(f.source,'worktrees','fixture')],
    'thread-project-assignments':{thread:{projectId:'legacy',projectKind:'local'}},
    'thread-workspace-root-hints':{thread:'/external/project'},
    'app-server-project-id-by-legacy-project-id-by-host':{['local:'+f.source]:{legacy:'server-uuid'}},
    'app-server-projects-migration-by-host':{['local:'+f.source]:{version:1,projectsMigrated:true,threadAssignmentsMigrated:true,pendingThreadAssignmentIds:['thread']}},
    'permissions':{allow:true},'electron-persisted-atom-state':{locale:'en'},'auth':'not-copied'
  }
  const raw=JSON.stringify(state);writeFileSync(join(f.source,copiedProjectStateFile),raw)
  const database=join(f.source,'state_5.sqlite'),db=new DatabaseSync(database)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,cwd TEXT,project_id TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT,PRIMARY KEY(project_id,position))')
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('thread',join(f.source,'sessions','rollout-thread.jsonl'),'source-provider','/external/project',null)
  db.prepare('INSERT INTO projects VALUES(?,?)').run('server-uuid','中文项目')
  db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('server-uuid',0,'/external/project');db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('server-uuid',1,join(f.source,'worktrees','fixture'));db.close()
  const sourceDatabase=readFileSync(database),manifest=await scanInstanceHome(f.source,signal)
  assert.equal(manifest.entries.some(entry=>entry.relative.startsWith('worktrees')),false)
  let bytes=0;await copyInstanceHome(manifest,f.target,signal,(_files,count)=>{bytes=count})
  assert.equal(bytes,manifest.bytes)
  const stagedRaw=readFileSync(join(f.target,copiedProjectStateFile),'utf8')
  assert.ok(!stagedRaw.includes('permissions')&&!stagedRaw.includes('not-copied')&&!stagedRaw.includes('locale'))
  await relocateCopiedProfile(manifest,f.target,f.final,signal,'cml_instance')
  const copied=JSON.parse(readFileSync(join(f.target,copiedProjectStateFile),'utf8'))
  assert.deepEqual(copied['local-projects'],{legacy:{...state['local-projects'].legacy,rootPaths:['/external/project',join(f.source,'worktrees','fixture')]}});assert.deepEqual(copied['thread-project-assignments'],state['thread-project-assignments'])
  assert.deepEqual(copied['app-server-project-id-by-legacy-project-id-by-host'],{['local:'+f.final]:{legacy:'server-uuid'}})
  assert.deepEqual(copied['app-server-projects-migration-by-host'],{['local:'+f.final]:{version:1,projectsMigrated:true,threadAssignmentsMigrated:false,threadAssignmentsReadMigrated:false,pendingThreadAssignmentIds:['thread']}})
  const targetDb=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  assert.deepEqual(targetDb.prepare('SELECT id,name FROM projects').all().map(row=>({...row})),[{id:'server-uuid',name:'中文项目'}])
  assert.deepEqual(targetDb.prepare('SELECT project_id,position,path FROM project_roots ORDER BY position').all().map(row=>({...row})),[{project_id:'server-uuid',position:0,path:'/external/project'},{project_id:'server-uuid',position:1,path:join(f.source,'worktrees','fixture')}])
  const thread=targetDb.prepare('SELECT rollout_path,model_provider,cwd FROM threads').get()!
  assert.equal(thread.rollout_path,join(f.final,'sessions','rollout-thread.jsonl'));assert.equal(thread.model_provider,'cml_instance');assert.equal(thread.cwd,'/external/project');targetDb.close()
  assert.equal(readFileSync(join(f.source,copiedProjectStateFile),'utf8'),raw);assert.deepEqual(readFileSync(database),sourceDatabase)
  assert.equal(readFileSync(join(f.source,'worktrees','fixture','app.ts'),'utf8'),'original project source')
  assert.equal(readFileSync(join(f.target,'sessions','rollout-thread.jsonl'),'utf8').split('\n').slice(1).join('\n'),body)
})

test('unrecognized project metadata is never copied verbatim and cancellation keeps the source intact',async t=>{
  const f=fixture(t),signal=new AbortController().signal,raw='{"project-order":[42],"auth":"never-write-to-target"}'
  writeFileSync(join(f.source,copiedProjectStateFile),raw)
  let manifest=await scanInstanceHome(f.source,signal)
  await assert.rejects(copyInstanceHome(manifest,f.target,signal,()=>{}),/分组状态格式/)
  assert.equal(readFileSync(join(f.target,copiedProjectStateFile),'utf8'),'')
  assert.equal(readFileSync(join(f.source,copiedProjectStateFile),'utf8'),raw)
  rmSync(f.target,{recursive:true,force:true});const controller=new AbortController()
  manifest=await scanInstanceHome(f.source,signal)
  await assert.rejects(copyInstanceHome(manifest,f.target,controller.signal,()=>controller.abort()),/abort/i)
  assert.equal(readFileSync(join(f.target,copiedProjectStateFile),'utf8'),'')
  assert.equal(readFileSync(join(f.source,copiedProjectStateFile),'utf8'),raw)
})

test('oversized project state is refused before writing it into a new profile',async t=>{
  const f=fixture(t),signal=new AbortController().signal
  writeFileSync(join(f.source,copiedProjectStateFile),Buffer.alloc(copiedProjectStateLimit+1,32))
  const manifest=await scanInstanceHome(f.source,signal)
  await assert.rejects(copyInstanceHome(manifest,f.target,signal,()=>{}),/16 MiB/)
  assert.deepEqual(readdirSync(f.target),[])
})

test('project root migration is paged and cancellation rolls back all staged SQL changes',async t=>{
  const f=fixture(t),signal=new AbortController().signal,database=join(f.source,'state_5.sqlite'),db=new DatabaseSync(database)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT,PRIMARY KEY(project_id,position))')
  const insert=db.prepare('INSERT INTO project_roots VALUES(?,?,?)')
  db.exec('BEGIN');for(let i=0;i<750;i++)insert.run('project',i,join(f.source,'outputs',String(i)));db.exec('COMMIT');db.close()
  const sourceDatabase=readFileSync(database),manifest=await scanInstanceHome(f.source,signal)
  await copyInstanceHome(manifest,f.target,signal,()=>{})
  const controller=new AbortController(),task=relocateCopiedProfile(manifest,f.target,f.final,controller.signal);setImmediate(()=>controller.abort())
  await assert.rejects(task,/abort/i)
  const staged=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  assert.equal(staged.prepare('SELECT count(*) AS total FROM project_roots WHERE path LIKE ?').get(f.source+'/%')!.total,750)
  staged.close();assert.deepEqual(readFileSync(database),sourceDatabase)
  await relocateCopiedProfile(manifest,f.target,f.final,signal)
  const copied=new DatabaseSync(join(f.target,'state_5.sqlite'),{readOnly:true})
  assert.equal(copied.prepare('SELECT count(*) AS total FROM project_roots WHERE path LIKE ?').get(f.final+'/%')!.total,750)
  copied.close();assert.deepEqual(readFileSync(database),sourceDatabase)
})

test('an unknown project root schema fails the staged migration without altering the source',async t=>{
  const f=fixture(t),signal=new AbortController().signal,database=join(f.source,'state_5.sqlite'),db=new DatabaseSync(database)
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT); CREATE TABLE project_roots(project_id TEXT,root_path TEXT)');db.close()
  const sourceDatabase=readFileSync(database),manifest=await scanInstanceHome(f.source,signal)
  await copyInstanceHome(manifest,f.target,signal,()=>{})
  await assert.rejects(relocateCopiedProfile(manifest,f.target,f.final,signal),/数据库/)
  assert.deepEqual(readFileSync(database),sourceDatabase)
})
