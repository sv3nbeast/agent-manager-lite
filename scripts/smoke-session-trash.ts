// Optional actual official protocol check. All profiles and history are temporary;
// this invokes no model turn, account login, keychain or existing client.
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync} from 'node:fs'
import {join,isAbsolute} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog} from '../src/main/sessions'
import {sessionProgram,planSessionDeletion,rebuildSessionMetadata,verifyDeletedSessionMetadata} from '../src/main/officialSessions'
import {prepareTrashBatch,deleteTrashOriginals,restoreTrashBatch,purgeTrashBatch,officialTrashRuntime,loadTrashJournal} from '../src/main/sessionTrashFiles'
import {textHash} from '../src/main/sessionTransferFiles'

async function main(){
  const binary=process.env.CML_TEST_CODEX_BINARY
  assert.ok(binary&&isAbsolute(binary)&&existsSync(binary),'Set CML_TEST_CODEX_BINARY to the verified official executable')
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-trash-cli-'))),home=join(root,'home'),trash=join(root,'trash');mkdirSync(home);mkdirSync(trash)
  try{
    const store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),target=configs.register(home),catalog=new SessionCatalog(store),program=sessionProgram({id:'fixture',path:binary,name:'Official CLI',kind:'cli'}),signal=new AbortController().signal
    const parent=randomUUID(),child=randomUUID(),grandchild=randomUUID(),unrelated=randomUUID(),when='2026-10-01T08:00:00Z'
    const create=(id:string,parentId?:string,archived=false)=>{
      const folder=archived?join(home,'archived_sessions'):join(home,'sessions','2026','10','01');mkdirSync(folder,{recursive:true})
      const file=join(folder,`rollout-2026-10-01T08-00-00-${id}.jsonl`)
      const meta={type:'session_meta',timestamp:when,payload:{id,session_id:parentId?parent:id,parent_thread_id:parentId??null,timestamp:when,cwd:root,originator:'codex_cli_rs',cli_version:'0.153.2',source:parentId?{subagent:{thread_spawn:{parent_thread_id:parentId,depth:parentId===parent?1:2}}}:'cli',model_provider:'openai'}}
      writeFileSync(file,[meta,{type:'event_msg',timestamp:when,payload:{type:'user_message',message:'Synthetic trash protocol fixture 中文 '+id,images:[],local_images:[],text_elements:[]}},{type:'response_item',timestamp:when,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic trash protocol fixture 中文 '+id}]}}].map(row=>JSON.stringify(row)+'\n').join(''))
      return file
    }
    const files=[create(parent),create(child,parent),create(grandchild,child,true),create(unrelated)],before=files.map(file=>readFileSync(file)),mtimes=files.map(file=>lstatSync(file).mtimeMs)
    writeFileSync(join(home,'session_index.jsonl'),[parent,child,grandchild,unrelated].map(id=>JSON.stringify({id,thread_name:'Fixture '+id,updated_at:when,custom_field:'preserve'})+'\n').join(''))
    await rebuildSessionMetadata(program,home,[parent,child,grandchild,unrelated],signal)
    const closure=await planSessionDeletion(program,home,[parent],signal)
    assert.deepEqual(closure.map(row=>row.id),[parent,child,grandchild]);assert.deepEqual(closure.map(row=>row.descendant),[false,true,true])
    console.log('Official 0.153.2 thread/list confirms parent -> child -> archived grandchild; unrelated thread excluded.')
    const page=await catalog.scan({runId:randomUUID(),targetId:target.id});assert.deepEqual(page.warnings,[])
    const sources=(await catalog.syncSources(page.snapshotId,signal)).filter(source=>closure.some(row=>row.id===source.record.id))
    const {folder}=await prepareTrashBatch(trash,{targetId:target.id,targetName:'Temporary home',root:home,sources,selectedIds:[parent],closure,configHash:textHash(null)},signal)
    const deleted=await deleteTrashOriginals(folder,program,signal)
    assert.equal(deleted.phase,'trashed');assert.equal(deleted.officialFallback,false);assert.equal(deleted.indexPending,false)
    for(const file of files.slice(0,3))assert.equal(existsSync(file),false)
    assert.deepEqual(readFileSync(files[3]),before[3]);await verifyDeletedSessionMetadata(program,home,[parent,child,grandchild],signal)
    console.log('Official thread/delete deleted the full persisted subtree after every rollout was backed up; both active/archive listings confirm absence, unrelated bytes unchanged.')
    const restored=await restoreTrashBatch(folder,program,signal)
    assert.equal(restored.phase,'restored');assert.equal(restored.indexPending,false)
    for(const [index,file] of files.entries()){assert.deepEqual(readFileSync(file),before[index]);assert.ok(Math.abs(lstatSync(file).mtimeMs-mtimes[index])<1)}
    const restoredClosure=await planSessionDeletion(program,home,[parent],signal)
    assert.deepEqual(restoredClosure.map(row=>row.id),[parent,child,grandchild]);assert.ok(readFileSync(join(home,'session_index.jsonl'),'utf8').includes('custom_field'))
    purgeTrashBatch(folder);assert.equal(existsSync(folder),false);assert.ok(existsSync(files[0]));assert.equal(existsSync(join(home,'auth.json')),false)
    const secondPage=await catalog.scan({runId:randomUUID(),targetId:target.id}),secondSources=(await catalog.syncSources(secondPage.snapshotId,signal)).filter(source=>restoredClosure.some(row=>row.id===source.record.id))
    const fallback=await prepareTrashBatch(trash,{targetId:target.id,targetName:'Temporary home',root:home,sources:secondSources,selectedIds:[parent],closure:restoredClosure,configHash:textHash(null)},signal)
    let indexDeferred=false
    try{await deleteTrashOriginals(fallback.folder,program,signal,{...officialTrashRuntime,plan:async()=>{throw new Error('Synthetic unavailable app-server')},remove:async()=>assert.fail('No cascading official delete when its scope cannot be confirmed')})}
    catch(error){assert.match(String(error),/官方索引更新未完成/);indexDeferred=true}
    for(const file of files.slice(0,3))assert.equal(existsSync(file),false)
    assert.equal(loadTrashJournal(fallback.folder).officialFallback,true)
    await restoreTrashBatch(fallback.folder,program,signal)
    for(const [index,file] of files.entries())assert.deepEqual(readFileSync(file),before[index])
    purgeTrashBatch(fallback.folder)
    console.log('Official planning unavailable: verified files-only removal, no cascading call, indexed restore succeeds; removal index deferred='+indexDeferred+'.')
    catalog.stop()
    console.log('Restore passed: byte-identical rollouts, original timestamps, unknown index fields and parent relationships; official list sees all restored IDs; explicit cleanup leaves live files intact. No model turn or credentials used.')
  }finally{rmSync(root,{recursive:true,force:true})}
}
void main().catch(error=>{console.error(error);process.exitCode=1})
