import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,open,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {zstdCompressSync,zstdDecompressSync} from 'node:zlib'
import {prepareRolloutProviderRecovery,applyArchivedRolloutProviderRecovery,applyRolloutProviderRecovery} from '../src/main/codexRolloutRecovery'

async function fixture(t:{after(fn:()=>Promise<void>):void},compressed=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'aml-rollout-recovery-')));t.after(()=>rm(root,{recursive:true,force:true}))
  const source=join(root,'source','sessions','rollout-thread.jsonl'),target=join(root,'target','sessions','rollout-thread.jsonl'+(compressed?'.zst':''))
  await mkdir(join(root,'source','sessions'),{recursive:true});await mkdir(join(root,'target','sessions'),{recursive:true})
  const raw=Buffer.from(JSON.stringify({type:'session_meta',ordinal:0,payload:{id:'thread',history_mode:'paginated',model_provider:'codex_local_access'}})+'\n'+JSON.stringify({type:'event_msg',ordinal:1,payload:{text:'保留正文 😀'}})+'\n')
  const changed=Buffer.from(raw.toString().replace('codex_local_access','cml_instance')),stored=compressed?zstdCompressSync(changed):changed
  await writeFile(source,raw);await writeFile(target,stored)
  return {root,source,target,raw,changed,stored}
}
test('exact offline restoration keeps originals, bodies and SQLite intact and saves the old compressed bytes',{skip:process.platform==='win32'},async t=>{
  for(const compressed of [false,true]){
    const f=await fixture(t,compressed),database=join(f.root,'target','thread_history_1.sqlite'),sentinel=Buffer.from('projection remains untouched')
    await writeFile(database,sentinel)
    const plan=await prepareRolloutProviderRecovery(f.source,f.target)
    assert.equal(plan.summary.originalBytes-plan.summary.currentBytes,6)
    assert.deepEqual(await readFile(f.target),f.stored,'Preview does not write')
    const result=await applyRolloutProviderRecovery(plan),restored=await readFile(f.target)
    assert.deepEqual(compressed?zstdDecompressSync(restored):restored,f.raw)
    assert.deepEqual(await readFile(result.backupPath),f.stored)
    assert.deepEqual(await readFile(f.source),f.raw);assert.deepEqual(await readFile(database),sentinel)
    await assert.rejects(prepareRolloutProviderRecovery(f.source,f.target),/无需/)
  }
})
test('recovery rejects different conversation bodies, metadata identities and symlink sources',async t=>{
  const f=await fixture(t)
  await writeFile(f.target,Buffer.concat([f.changed,Buffer.from('new turn\n')]))
  await assert.rejects(prepareRolloutProviderRecovery(f.source,f.target),/正文不一致/)
  await writeFile(f.target,f.changed.toString().replace('"thread"','"other"'))
  await assert.rejects(prepareRolloutProviderRecovery(f.source,f.target),/元数据/)
  await rm(f.source);await symlink(f.target,f.source)
  await assert.rejects(prepareRolloutProviderRecovery(f.source,f.target),/链接/)
})
test('edits after preview and active file handles prevent offline recovery',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),plan=await prepareRolloutProviderRecovery(f.source,f.target)
  const active=await open(f.target,'r')
  try{await assert.rejects(applyRolloutProviderRecovery(plan),/进程占用/)}finally{await active.close()}
  await writeFile(f.target,Buffer.concat([f.changed,Buffer.from('new turn\n')]))
  await assert.rejects(applyRolloutProviderRecovery(plan),/预览后文件已变化/)
  assert.equal((await readFile(f.target)).toString().endsWith('new turn\n'),true)
})
test('a manager launch checkpoint blocks recovery even with no open database handles',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),plan=await prepareRolloutProviderRecovery(f.source,f.target)
  await writeFile(join(f.root,'launch.json'),'{}')
  await assert.rejects(applyRolloutProviderRecovery(plan),/启动记录/)
  assert.deepEqual(await readFile(f.target),f.stored)
})
test('online recovery allows only unopened immutable archived Zstandard segments and leaves launch state untouched',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,true),archived=join(f.root,'target','archived_sessions','rollout-thread.jsonl.zst')
  await mkdir(join(f.root,'target','archived_sessions'));await writeFile(archived,f.stored)
  const plan=await prepareRolloutProviderRecovery(f.source,archived),launch=join(f.root,'launch.json')
  await writeFile(launch,'active instance')
  const result=await applyArchivedRolloutProviderRecovery(plan)
  assert.deepEqual(await readFile(result.backupPath),f.stored)
  assert.deepEqual(zstdDecompressSync(await readFile(archived)),f.raw)
  assert.equal(await readFile(launch,'utf8'),'active instance')
  const active=join(f.root,'target','sessions','rollout-thread.jsonl.zst');await writeFile(active,f.stored)
  const activePlan=await prepareRolloutProviderRecovery(f.source,active)
  await assert.rejects(applyArchivedRolloutProviderRecovery(activePlan),/不可变的归档/)
})
