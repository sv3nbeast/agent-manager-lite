import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync,rmSync,realpathSync,symlinkSync,readFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {chooseSessionDatabase,configuredSessionDatabaseHome} from '../src/main/sessionDatabase'

function db(path:string,visible:number,total=visible,latest=0){
  const database=new DatabaseSync(path)
  database.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,has_user_event INTEGER,updated_at_ms INTEGER)')
  for(let i=0;i<total;i++)database.prepare('INSERT INTO threads VALUES(?,?,?)').run(String(i),i<visible?1:0,latest+i)
  database.close()
}
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-session-database-')));t.after(()=>rmSync(root,{recursive:true,force:true}));return root
}

test('chooses the complete root index when an older sqlite fallback is also present',t=>{
  const root=fixture(t);mkdirSync(join(root,'sqlite'));db(join(root,'state_5.sqlite'),4,4);db(join(root,'sqlite','state_5.sqlite'),1,1)
  assert.deepEqual(chooseSessionDatabase(root,null),{value:'.',path:join(root,'state_5.sqlite'),reason:'best-local'})
})

test('uses a nested database when it is the only valid local index',t=>{
  const root=fixture(t);mkdirSync(join(root,'sqlite'));db(join(root,'sqlite','state_5.sqlite'),2)
  assert.deepEqual(chooseSessionDatabase(root,null),{value:'sqlite',path:join(root,'sqlite','state_5.sqlite'),reason:'best-local'})
})

test('rejects an external sqlite_home without opening or changing the source',t=>{
  const root=fixture(t),external=join(root,'..','outside-session-db')
  assert.deepEqual(chooseSessionDatabase(root,`sqlite_home=${JSON.stringify(external)}\n`),{value:external,reason:'configured-external'})
})

test('reads sqlite_home from the active named profile',t=>{
  const root=fixture(t),nested=join(root,'profiles','work')
  mkdirSync(nested,{recursive:true});db(join(nested,'state_5.sqlite'),3)
  const config='profile="work"\n[profiles.work]\nsqlite_home="profiles/work"\n[profiles.other]\nsqlite_home="profiles/other"\n'
  assert.deepEqual(chooseSessionDatabase(root,config),{value:'profiles/work',path:join(root,'profiles','work','state_5.sqlite'),reason:'best-local'})
})

test('a newer small index cannot outweigh a complete index with millisecond timestamps',t=>{
  const root=fixture(t);mkdirSync(join(root,'sqlite'))
  db(join(root,'state_5.sqlite'),20,20,1_700_000_000_000)
  db(join(root,'sqlite','state_5.sqlite'),1,1,1_720_000_000_000)
  assert.equal(chooseSessionDatabase(root,'sqlite_home="sqlite"\n').value,'.')
})

test('recency breaks ties only after visible and total thread counts',t=>{
  const root=fixture(t);mkdirSync(join(root,'sqlite'))
  db(join(root,'state_5.sqlite'),2,2,1_700_000_000_000)
  db(join(root,'sqlite','state_5.sqlite'),2,2,1_720_000_000_000)
  assert.equal(chooseSessionDatabase(root,null).value,'sqlite')
})

test('inactive profile sqlite_home cannot override the active profile or default root',t=>{
  const root=fixture(t);db(join(root,'state_5.sqlite'),3)
  const config='profile="work"\n[profiles.work]\nmodel="gpt-5.5"\n[profiles.other]\nsqlite_home="/fixture/unrelated"\n'
  assert.equal(configuredSessionDatabaseHome(config),undefined)
  assert.equal(configuredSessionDatabaseHome('sqlite_home="root-db"\n'+config),'root-db')
  assert.equal(chooseSessionDatabase(root,config).value,'.')
})

test('a symlinked local database directory cannot select or mutate an external index',t=>{
  const root=fixture(t),outside=fixture(t),outsidePath=join(outside,'state_5.sqlite')
  db(join(root,'state_5.sqlite'),2);db(outsidePath,20)
  symlinkSync(outside,join(root,'sqlite'),'dir')
  const before=readFileSync(outsidePath),files=readdirSync(outside)
  assert.equal(chooseSessionDatabase(root,null).value,'.')
  assert.equal(chooseSessionDatabase(root,'sqlite_home="sqlite"\n').value,'.')
  assert.deepEqual(readFileSync(outsidePath),before);assert.deepEqual(readdirSync(outside),files)
})

test('a substituted intermediate directory and an aliased root are not local database candidates',t=>{
  const root=fixture(t),outside=fixture(t),nested=join(outside,'nested')
  mkdirSync(nested);db(join(nested,'state_5.sqlite'),4)
  symlinkSync(outside,join(root,'profiles'),'dir')
  assert.deepEqual(chooseSessionDatabase(root,'sqlite_home="profiles/nested"\n'),{reason:'no-local-database'})
  const alias=join(root,'alias');symlinkSync(nested,alias,'dir')
  assert.deepEqual(chooseSessionDatabase(alias,null),{reason:'no-local-database'})
})
