import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {scanInstanceStorage} from '../src/main/instanceStorage'
import {saveTrashJournal} from '../src/main/sessionTrashFiles'
import {textHash} from '../src/main/sessionTransferFiles'

test('storage inventory includes journal-verified session backups and recognized UUID staging dirs read-only',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-storage-coverage-'))),trash=join(root,'session-trash'),archive=join(root,'session-archive-staging'),copies=join(root,'instance-copies')
  mkdirSync(trash);mkdirSync(archive);mkdirSync(copies);t.after(()=>rmSync(root,{recursive:true,force:true}))
  const sessionId=randomUUID(),targetId=randomUUID(),batchId=randomUUID(),folder=join(trash,batchId),sourceRoot=join(root,'source-home'),sessionPath=join(sourceRoot,'sessions','rollout-'+sessionId+'.jsonl')
  mkdirSync(join(sourceRoot,'sessions'),{recursive:true});writeFileSync(sessionPath,'original session')
  mkdirSync(folder);const backup=join(folder,'0.jsonl'),backupBytes='durable session backup';writeFileSync(backup,backupBytes)
  const rootStat=lstatSync(sourceRoot),folderStat=lstatSync(folder),sourceStat=lstatSync(sessionPath),storedStat=lstatSync(backup)
  saveTrashJournal(folder,{version:1,id:batchId,targetId,targetName:'Recovered fixture',root:sourceRoot,rootIdentity:{device:rootStat.dev,inode:rootStat.ino},backupIdentity:{device:folderStat.dev,inode:folderStat.ino},phase:'trashed',deletedAt:1234,configHash:textHash(null),selectedIds:[sessionId],allIds:[sessionId],files:[{id:sessionId,relative:'sessions/rollout-'+sessionId+'.jsonl',backup:'0.jsonl',source:{device:sourceStat.dev,inode:sourceStat.ino,size:sourceStat.size,mtime:sourceStat.mtimeMs,ctime:sourceStat.ctimeMs},stored:{device:storedStat.dev,inode:storedStat.ino,size:storedStat.size,mtime:storedStat.mtimeMs,ctime:storedStat.ctimeMs},sha256:createHash('sha256').update(backupBytes).digest('hex'),title:'Fixture thread',cwd:'/fixture'}],indexBefore:null,indexHash:textHash(null),officialFallback:true,indexPending:false,restoreFiles:[]})
  const validJournal=readFileSync(join(folder,'journal.json'))
  const archiveId=randomUUID(),copyId=randomUUID(),archiveFolder=join(archive,archiveId),copyFolder=join(copies,copyId)
  mkdirSync(archiveFolder);mkdirSync(copyFolder);writeFileSync(join(archiveFolder,'payload'),'stale archive payload');writeFileSync(join(copyFolder,'payload'),'interrupted copy payload')
  const unknownArchive=join(archive,'unrecognized-name');mkdirSync(unknownArchive);writeFileSync(join(unknownArchive,'secret'),'must not scan')
  const unknownCopy=join(copies,'unrecognized-name');mkdirSync(unknownCopy);writeFileSync(join(unknownCopy,'secret'),'must not scan')
  const before=[validJournal,readFileSync(backup),readFileSync(join(archiveFolder,'payload')),readFileSync(join(copyFolder,'payload'))]

  const result=await scanInstanceStorage(root,[],1234)
  const sessionRow=result.rows.find(row=>row.kind==='session_trash'&&row.directory===folder)
  assert.ok(sessionRow);assert.match(sessionRow.warning??'',/会话管理/)
  assert.equal(sessionRow.files,2);assert.ok(sessionRow.logicalBytes>backupBytes.length)
  assert.ok(result.rows.some(row=>row.kind==='transient_staging'&&row.directory===archiveFolder))
  assert.ok(result.rows.some(row=>row.kind==='transient_staging'&&row.directory===copyFolder))
  assert.equal(result.rows.some(row=>row.directory===unknownArchive||row.directory===unknownCopy),false)
  assert.deepEqual([readFileSync(join(folder,'journal.json')),readFileSync(backup),readFileSync(join(archiveFolder,'payload')),readFileSync(join(copyFolder,'payload'))],before)
})

test('storage inventory counts a damaged session-trash batch as unknown without discarding it',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-storage-corrupt-'))),trash=join(root,'session-trash'),id=randomUUID(),folder=join(trash,id)
  mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'journal.json'),'{ broken journal');writeFileSync(join(folder,'0.jsonl'),'preserved backup')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const before=[readFileSync(join(folder,'journal.json')),readFileSync(join(folder,'0.jsonl'))]
  const result=await scanInstanceStorage(root,[],1234),row=result.rows.find(value=>value.kind==='session_trash'&&value.directory===folder)
  assert.ok(row);assert.match(row.warning??'',/恢复记录无法确认/);assert.ok(result.warnings.some(warning=>warning.includes('恢复记录损坏')))
  assert.deepEqual([readFileSync(join(folder,'journal.json')),readFileSync(join(folder,'0.jsonl'))],before)
})
