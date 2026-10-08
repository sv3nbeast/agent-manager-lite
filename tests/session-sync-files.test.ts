import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,lstatSync,renameSync,linkSync,existsSync,symlinkSync,appendFileSync,readdirSync} from 'node:fs'
import {join,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionCatalog,type SessionTransferSource} from '../src/main/sessions'
import {mergeSessionCopies} from '../src/main/sessionMerge'
import {createSyncJournal,syncStage,publishSync,rollbackSync,cleanupSync,encodeSyncJournal,syncJournalSchema,type SyncJournal} from '../src/main/sessionSyncFiles'
import {textHash,fileIdentity} from '../src/main/sessionTransferFiles'
const signal=()=>new AbortController().signal
const hash=(text:Buffer|string)=>createHash('sha256').update(text).digest('hex')
function fixture(t:{after(fn:()=>void|Promise<void>):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-sync-'))),home=join(root,'home'),scratch=join(root,'scratch');mkdirSync(home);mkdirSync(scratch)
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,home,scratch}
}
function source(home:string,id:string,text:string,title='fixture'):SessionTransferSource{
  mkdirSync(join(home,'sessions'),{recursive:true});const path=join(home,'sessions','rollout-'+randomUUID()+'.jsonl');writeFileSync(path,text)
  const stat=lstatSync(path),root=lstatSync(home),targetId=randomUUID()
  return {root:home,path,targetId,rootDevice:root.dev,rootInode:root.ino,...fileIdentity(stat),size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,record:{id,title,cwd:'/fixture/中文',kind:'conversation',locations:[{targetId,name:'fixture',directory:home,running:false,archived:false,ambiguous:false}]}}
}
const header=(id:string,tag='original')=>JSON.stringify({type:'session_meta',timestamp:'2026-09-30T00:00:00Z',payload:{id,cwd:'/fixture/中文',model_provider:'openai',tag}})
const event=(time:string,message:string)=>JSON.stringify({type:'event_msg',timestamp:time,payload:{type:'user_message',message}})

test('direct event merge detects actual pagination headers even without catalog metadata and never emits a flat result',async t=>{
  const f=fixture(t),id=randomUUID()
  for(const marker of [{history_mode:'paginated'},{history_base:{thread_id:randomUUID()}}]){
    const meta=JSON.parse(header(id));Object.assign(meta.payload,marker);const a=source(f.home,id,JSON.stringify(meta)+'\n'+event('2026-10-01T00:00:00Z','latest segment'))
    assert.equal(a.record.historyMode,undefined)
    await assert.rejects(mergeSessionCopies(f.scratch,[a],new Map(),signal(),()=>{}),/分段历史.*复制实例/)
    assert.deepEqual(readdirSync(f.scratch),[])
  }
  const ordinary=JSON.parse(header(id));Object.assign(ordinary.payload,{history_mode:'flat',history_base:null});const a=source(f.home,id,JSON.stringify(ordinary)+'\n'+event('2026-10-01T00:00:00Z','ordinary')),before=readFileSync(a.path)
  const [merged]=await mergeSessionCopies(f.scratch,[a],new Map(),signal(),()=>{});assert.deepEqual(readFileSync(merged.source.path),before)
})

test('merge keeps newest metadata, merges both event branches, deduplicates JSON keys and sorts timestamps then untimed events',async t=>{
  const f=fixture(t),id=randomUUID(),shared=event('2026-10-01T01:00:00Z','共用'),a=source(f.home,id,header(id,'older')+'\n'+shared+'\n'+event('2026-10-01T02:00:00Z','甲')+'\n'+JSON.stringify({z:1,a:2})+'\nnot json\n','Older')
  const second=join(f.root,'b');mkdirSync(second);const b=source(second,id,header(id,'newer')+'\n'+event('2026-10-01T03:00:00Z','乙')+'\n'+shared+'\n'+JSON.stringify({a:2,z:1})+'\n not json \n','Newer')
  const indexes=new Map([[second+'\0'+id,{id,thread_name:'Winner',unknown:{keep:true},...JSON.parse('{"__proto__":{"keep":"literal key"}}')}]])
  const [merged]=await mergeSessionCopies(f.scratch,[a,b],indexes,signal(),()=>{}),lines=readFileSync(merged.source.path,'utf8').trimEnd().split('\n')
  assert.equal(JSON.parse(lines[0]).payload.tag,'newer');assert.deepEqual(lines.slice(1,4).map(line=>JSON.parse(line).payload.message),['共用','甲','乙']);assert.equal(lines[4],'{"a":2,"z":1}');assert.equal(lines[5],'not json');assert.equal(lines.length,6)
  assert.deepEqual(merged.index,indexes.get(second+'\0'+id));assert.equal(Object.getPrototypeOf(merged.index),Object.prototype);assert.equal(Object.hasOwn(merged.index,'__proto__'),true);assert.equal(merged.sha256,hash(readFileSync(merged.source.path)));assert.equal(merged.source.mtime,Date.parse('2026-10-01T03:00:00Z'))
  const original=readFileSync(a.path);assert.ok(original.includes('older'));assert.equal(a.record.title,'Older')
})

test('single-copy merge retains original bytes including whitespace, CRLF, duplicates and missing final newline',async t=>{
  const f=fixture(t),id=randomUUID(),text='\r\n  '+header(id)+' \r\n'+event('2026-10-01T01:00:00Z','😀中文')+'\r\n'+event('2026-10-01T01:00:00Z','😀中文'),a=source(f.home,id,text)
  const [merged]=await mergeSessionCopies(f.scratch,[a],new Map(),signal(),()=>{});assert.equal(readFileSync(merged.source.path,'utf8'),text);assert.equal(merged.sha256,hash(text))
})

test('canonical JSON does not lose distinct unsafe integers or confuse invalid raw text with encoded keys',async t=>{
  const f=fixture(t),id=randomUUID(),a=source(f.home,id,header(id)+'\n{"n":9007199254740992}\n{"n":9007199254740993}\n1\nn1\n1.0\n1e0\n'),b=source(f.home,id,header(id)+'\n{"n":9007199254740993}\n')
  const [merged]=await mergeSessionCopies(f.scratch,[a,b],new Map(),signal(),()=>{}),text=readFileSync(merged.source.path,'utf8')
  assert.equal(text.split('9007199254740993').length,2);assert.ok(text.includes('9007199254740992'));assert.ok(text.includes('\nn1\n'));assert.ok(text.includes('\n1\n'));assert.ok(text.includes('\n1.0\n'));assert.equal(text.includes('\n1e0\n'),false)
})

test('merge freshness uses the maximum event time in the full file, then length, then mtime',async t=>{
  const f=fixture(t),id=randomUUID(),a=source(f.home,id,header(id,'winner')+'\n'+event('2026-10-02T00:00:00Z','max')+'\n'+event('2026-10-01T00:00:00Z','tail')),b=source(f.home,id,header(id,'loser')+'\n'+event('2026-10-01T23:00:00Z','b'))
  const [merged]=await mergeSessionCopies(f.scratch,[a,b],new Map(),signal(),()=>{});assert.equal(JSON.parse(readFileSync(merged.source.path,'utf8').split('\n')[0]).payload.tag,'winner')
})

test('merge supports giant Unicode lines, cancels while reading and rejects changed sources before writing',async t=>{
  const f=fixture(t),id=randomUUID(),a=source(f.home,id,header(id)+'\n'+event('2026-10-01T00:00:00Z','😀'.repeat(1_100_000))),controller=new AbortController()
  await assert.rejects(mergeSessionCopies(f.scratch,[a],new Map(),controller.signal,(_files,bytes)=>{if(bytes>4*1024**2)controller.abort()}),/abort/i)
  const next=join(f.root,'next');mkdirSync(next);appendFileSync(a.path,'\n');await assert.rejects(mergeSessionCopies(next,[a],new Map(),signal(),()=>{}),/变化/)
})

test('strict sync catalog retains same-home duplicate files while selected copy uses the canonical body',async t=>{
  const f=fixture(t),id=randomUUID();source(f.home,id,header(id)+'\n');source(f.home,id,header(id)+'\n')
  const store=new Store(join(f.root,'data'),{encrypt:text=>Buffer.from(text),decrypt:data=>data.toString()}),configs=new ClientConfigs(store),target=configs.register(f.home),catalog=new SessionCatalog(store),page=await catalog.scan({runId:randomUUID(),targetId:target.id})
  assert.equal((await catalog.syncSources(page.snapshotId,signal())).length,2);assert.equal((await catalog.transferSources(page.snapshotId,[id])).length,1)
})

function prepared(f:ReturnType<typeof fixture>):SyncJournal{
  const program={path:join(f.root,'codex'),device:1,inode:1,size:1,mtime:1},journal=createSyncJournal(randomUUID(),randomUUID(),'Fixture',f.home,textHash(null),program),rel='sessions/rollout-original.jsonl',old=join(f.home,rel),replacement=join(syncStage(journal),'new-0.jsonl')
  mkdirSync(join(f.home,'sessions'));writeFileSync(old,'original\n');writeFileSync(replacement,'merged\n')
  const entry=(path:string,stage:string)=>({relative:rel,stage,...fileIdentity(lstatSync(path)),size:lstatSync(path).size,sha256:hash(readFileSync(path))})
  journal.originals.push(entry(old,'old-0.jsonl'));journal.outputs.push(entry(replacement,'new-0.jsonl'));journal.sessionIds=[randomUUID()]
  journal.metadata=[{name:'session_index.jsonl',before:null,after:'new index\n',beforeHash:textHash(null),afterHash:textHash('new index\n')}];journal.phase='prepared';return journal
}

test('publication keeps exact original backup; committed cleanup keeps backups and removes extra new-file links',async t=>{
  const f=fixture(t),journal=prepared(f);await publishSync(journal,signal());assert.equal(readFileSync(join(f.home,journal.outputs[0].relative),'utf8'),'merged\n');assert.equal(readFileSync(join(syncStage(journal),'old-0.jsonl'),'utf8'),'original\n')
  assert.throws(()=>cleanupSync(journal),/不能清理/);journal.phase='committed';cleanupSync(journal);cleanupSync(journal);assert.equal(lstatSync(join(f.home,journal.outputs[0].relative)).nlink,1);assert.equal(existsSync(join(syncStage(journal),'old-0.jsonl')),true);await assert.rejects(rollbackSync(journal),/不能撤回/)
})

test('partial and full precommit publication roll back repeatedly without losing originals',async t=>{
  const f=fixture(t),journal=prepared(f),backup=join(syncStage(journal),'old-0.jsonl'),destination=join(f.home,journal.originals[0].relative)
  renameSync(destination,backup);await rollbackSync(journal);await rollbackSync(journal);assert.equal(readFileSync(destination,'utf8'),'original\n')
  await publishSync(journal,signal());await rollbackSync(journal);await rollbackSync(journal);assert.equal(readFileSync(destination,'utf8'),'original\n');assert.equal(existsSync(join(f.home,'session_index.jsonl')),false)
  journal.phase='rolled_back';cleanupSync(journal);cleanupSync(journal);assert.equal(existsSync(syncStage(journal)),false)
})

test('recovery refuses changed user content and changed parent directories and keeps backups',async t=>{
  const f=fixture(t),journal=prepared(f);await publishSync(journal,signal());writeFileSync(join(f.home,journal.outputs[0].relative),'user content\n')
  await assert.rejects(rollbackSync(journal),/修改|变化/);assert.equal(readFileSync(join(syncStage(journal),'old-0.jsonl'),'utf8'),'original\n');assert.equal(readFileSync(join(f.home,journal.outputs[0].relative),'utf8'),'user content\n')
  renameSync(join(f.home,'sessions'),join(f.home,'moved'));symlinkSync(join(f.home,'moved'),join(f.home,'sessions'));await assert.rejects(rollbackSync(journal),/链接|变化/)
})

test('cancel/config/metadata changes while asynchronous file hashes are running prevent any publication',async t=>{
  for(const change of ['config','metadata','file','cancel']){
    const f=fixture(t),journal=prepared(f),controller=new AbortController(),task=publishSync(journal,controller.signal)
    if(change==='config')writeFileSync(join(f.home,'config.toml'),'model_provider="changed"')
    if(change==='metadata')writeFileSync(join(f.home,'session_index.jsonl'),'user update')
    if(change==='file')appendFileSync(join(f.home,journal.originals[0].relative),'user')
    if(change==='cancel')controller.abort()
    await assert.rejects(task);assert.equal(existsSync(join(syncStage(journal),'old-0.jsonl')),false);assert.ok(readFileSync(join(f.home,journal.originals[0].relative),'utf8').startsWith('original'))
  }
})

test('journal rejects duplicate paths/stages, traversal and invalid metadata hashes',t=>{
  const f=fixture(t),journal=prepared(f);assert.equal(syncJournalSchema.parse(JSON.parse(encodeSyncJournal(journal))).id,journal.id)
  for(const invalid of [{...journal,outputs:[...journal.outputs,...journal.outputs]},{...journal,originals:[{...journal.originals[0],stage:'new-0.jsonl'}]},{...journal,outputs:[{...journal.outputs[0],relative:'../outside'}]},{...journal,metadata:[{...journal.metadata[0],afterHash:textHash('bad')}]}])assert.throws(()=>encodeSyncJournal(invalid))
})

test('persisted journals recover after actual SIGKILL at prepared, renamed and published boundaries',async t=>{
  for(const boundary of ['prepared','renamed','published']){
    const f=fixture(t),journal=prepared(f),path=join(f.root,'journal.json');writeFileSync(path,encodeSyncJournal(journal))
    const child=spawn(process.execPath,['--import','tsx','tests/fixtures/session-sync-crash.ts',path,boundary],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',value=>{stderr+=value})
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()))
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('fixture timeout '+stderr))},5000);child.once('error',error=>{clearTimeout(timer);reject(error)});child.stdout.once('data',data=>{clearTimeout(timer);assert.match(String(data),/fixture-ready/);resolve()});child.once('close',()=>{clearTimeout(timer);reject(new Error('fixture exited '+stderr))})})
    child.kill('SIGKILL');await closed
    const recovered=syncJournalSchema.parse(JSON.parse(readFileSync(path,'utf8')));await rollbackSync(recovered);recovered.phase='rolled_back';cleanupSync(recovered)
    assert.equal(readFileSync(join(f.home,recovered.originals[0].relative),'utf8'),'original\n');assert.equal(existsSync(join(f.home,'session_index.jsonl')),false);assert.equal(existsSync(syncStage(recovered)),false)
  }
})

test('one thousand conversations merge without truncation and the documented limit fails before emitting partial output',async t=>{
  const f=fixture(t),sources:SessionTransferSource[]=[]
  for(let i=0;i<1000;i++){const id=randomUUID();sources.push(source(f.home,id,header(id)+'\n'+event('2026-10-01T00:00:00Z','会话 '+i)))}
  let readFiles=0;const result=await mergeSessionCopies(f.scratch,sources,new Map(),signal(),files=>{readFiles=files})
  assert.equal(result.length,1000);assert.equal(readFiles,1000);assert.equal(new Set(result.map(item=>item.source.record.id)).size,1000)
  for(const item of [result[0],result[999]])assert.equal(readFileSync(item.source.path).equals(readFileSync(item.originals[0].path)),true)
  const excess=join(f.root,'excess');mkdirSync(excess);const id=randomUUID();await assert.rejects(mergeSessionCopies(excess,[...sources,source(f.home,id,header(id))],new Map(),signal(),()=>{}),/1000/)
  assert.equal(existsSync(join(excess,'sessions')),false)
})
