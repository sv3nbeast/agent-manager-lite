import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {appendFileSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs'
import {open} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readCodexSessionLineage} from '../src/main/codexSessionLineage'

function fixture(t:{after(callback:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-codex-lineage-'))),directory=join(root,'sessions','2026','10','24')
  mkdirSync(directory,{recursive:true})
  const threadId=randomUUID(),currentRolloutId=randomUUID()
  const line=(ordinal:number,type:string,payload:Record<string,unknown>)=>JSON.stringify({timestamp:'2026-10-24T08:00:00.000Z',ordinal,type,payload})
  const parentLines=[
    line(0,'session_meta',{id:threadId,cwd:'/fixture/project',history_mode:'paginated'}),
    line(1,'event_msg',{type:'user_message',message:'ancestor question'}),
    line(2,'event_msg',{type:'agent_message',message:'ancestor answer'}),
    line(3,'event_msg',{type:'user_message',message:'must be cut off at history_base'}),
  ]
  const parent=join(directory,'rollout-2026-10-24T08-00-00-'+threadId+'.jsonl')
  writeFileSync(parent,parentLines.join('\n')+'\n')
  const endByteOffset=Buffer.byteLength(parentLines.slice(0,3).join('\n')+'\n')
  const current=join(directory,'rollout-2026-10-24T08-10-00-'+threadId+'_'+currentRolloutId+'.jsonl')
  const currentLines=[
    line(3,'session_meta',{id:threadId,cwd:'/fixture/project',history_mode:'paginated',history_base:{thread_id:threadId,end_ordinal_exclusive:3,end_byte_offset:endByteOffset}}),
    line(4,'event_msg',{type:'user_message',message:'current rollout question'}),
    line(5,'response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'current rollout answer'}]}),
    line(6,'response_item',{type:'function_call',name:'fixture tool',arguments:{query:'boundary search needle'}}),
    line(7,'response_item',{type:'function_call_output',output:'boundary search result'}),
  ]
  writeFileSync(current,currentLines.join('\n')+'\n')
  const snapshot=()=>[parent,current].map(path=>{const data=readFileSync(path);return [path,data.length,createHash('sha256').update(data).digest('hex')]})
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,parent,current,threadId,snapshot}
}

test('Codex viewer follows history_base lineage and includes inherited prefix and current rollout tail',async t=>{
  const f=fixture(t),before=f.snapshot()
  const first=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:3,query:''},new AbortController().signal)
  assert.equal(first.total,6)
  assert.deepEqual(first.messages.map(message=>message.blocks[0]?.text),['ancestor question','ancestor answer','current rollout question'])
  const second=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:2,pageSize:3,query:''},new AbortController().signal)
  assert.deepEqual(second.messages.map(message=>message.blocks[0]?.text),['current rollout answer','{"query":"boundary search needle"}','boundary search result'])
  assert.equal(second.messages[1]?.blocks[0]?.type,'tool_use')
  const found=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:'boundary search needle'},new AbortController().signal)
  assert.equal(found.total,1);assert.match(found.messages[0]?.blocks[0]?.text??'',/boundary search needle/)
  const cutOff=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:'must be cut off'},new AbortController().signal)
  assert.equal(cutOff.total,0)
  assert.deepEqual(f.snapshot(),before,'reading all lineage segments leaves source files unchanged')
})

test('Codex viewer refuses missing history_base rollouts instead of showing a partial transcript',async t=>{
  const f=fixture(t);rmSync(f.parent)
  await assert.rejects(readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:''},new AbortController().signal),/未找到 ordinal 与字节边界都匹配的祖先 rollout/)
})

test('Codex viewer shows custom tools and safe notices for unknown response items without exposing their payload',async t=>{
  const f=fixture(t),lines=readFileSync(f.current,'utf8').trimEnd().split('\n')
  lines.push(
    JSON.stringify({ordinal:8,type:'response_item',payload:{type:'custom_tool_call',name:'workspace_lookup',input:{path:'src/main.ts'}}}),
    JSON.stringify({ordinal:9,type:'response_item',payload:{type:'custom_tool_call_output',name:'workspace_lookup',output:'found implementation'}}),
    JSON.stringify({ordinal:10,type:'response_item',payload:{type:'web_search_call',action:{query:'release notes'}}}),
    JSON.stringify({ordinal:11,type:'response_item',payload:{type:'future_private_record',secret:'must-not-appear'}}),
    JSON.stringify({ordinal:12,type:'response_item',payload:{type:'reasoning',summary:'private reasoning must-not-appear'}}),
    JSON.stringify({ordinal:13,type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'future_private_block',secret:'block-must-not-appear'}]}}),
  )
  writeFileSync(f.current,lines.join('\n')+'\n')
  const page=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20},new AbortController().signal)
  assert.equal(page.total,12)
  assert.ok(page.messages.some(message=>message.blocks.some(block=>block.type==='tool_use'&&block.name==='workspace_lookup')))
  assert.ok(page.messages.some(message=>message.blocks.some(block=>block.type==='tool_result'&&block.text==='found implementation')))
  assert.ok(page.messages.some(message=>message.blocks.some(block=>block.name==='Web 搜索'&&block.text.includes('release notes'))))
  const notices=page.messages.flatMap(message=>message.blocks).filter(block=>block.type==='notice').map(block=>block.text).join('\n')
  assert.match(notices,/future_private_record/)
  assert.match(notices,/内部推理记录/)
  assert.doesNotMatch(JSON.stringify(page),/must-not-appear/)
  assert.doesNotMatch(JSON.stringify(page),/block-must-not-appear/)
})

test('Codex viewer rejects a changed history_base byte boundary',async t=>{
  const f=fixture(t),lines=readFileSync(f.current,'utf8').trimEnd().split('\n'),meta=JSON.parse(lines[0])
  meta.payload.history_base.end_byte_offset+=1;lines[0]=JSON.stringify(meta);writeFileSync(f.current,lines.join('\n')+'\n')
  await assert.rejects(readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:''},new AbortController().signal),/未找到 ordinal 与字节边界都匹配的祖先 rollout/)
})

test('Codex viewer rejects an EOF history_base whose exclusive ordinal is not after the final retained record',async t=>{
  const f=fixture(t),lines=readFileSync(f.current,'utf8').trimEnd().split('\n'),meta=JSON.parse(lines[0])
  // Point at the physical end of the ancestor file, but claim the exclusive
  // cutoff is 2 even though ordinal 2 is present in the retained prefix.
  meta.payload.history_base.end_byte_offset=readFileSync(f.parent).length
  meta.payload.history_base.end_ordinal_exclusive=2
  lines[0]=JSON.stringify(meta);writeFileSync(f.current,lines.join('\n')+'\n')
  await assert.rejects(readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:''},new AbortController().signal),/未找到 ordinal 与字节边界都匹配的祖先 rollout/)
})

test('Codex viewer follows multiple payload-wrapped history_base ancestors in ordinal order',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-codex-lineage-chain-'))),directory=join(root,'sessions','2026','10','24')
  mkdirSync(directory,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}))
  const threadId=randomUUID(),middleId=randomUUID(),latestId=randomUUID()
  const line=(ordinal:number,type:string,payload:Record<string,unknown>)=>JSON.stringify({timestamp:'2026-10-24T08:00:00.000Z',ordinal,type,payload})
  const oldestLines=[line(0,'session_meta',{id:threadId,cwd:'/fixture/project',history_mode:'paginated'}),line(1,'event_msg',{type:'user_message',message:'oldest ancestor'}),line(2,'event_msg',{type:'agent_message',message:'oldest reply'}),line(3,'event_msg',{type:'user_message',message:'exclude older tail'})]
  const oldest=join(directory,'rollout-2026-10-24T07-00-00-'+threadId+'.jsonl');writeFileSync(oldest,oldestLines.join('\n')+'\n')
  const oldestBoundary=Buffer.byteLength(oldestLines.slice(0,3).join('\n')+'\n')
  const middleLines=[line(3,'session_meta',{id:threadId,cwd:'/fixture/project',history_mode:'paginated',history_base:{thread_id:threadId,end_ordinal_exclusive:3,end_byte_offset:oldestBoundary}}),line(4,'event_msg',{type:'user_message',message:'middle turn'}),line(5,'event_msg',{type:'agent_message',message:'middle reply'}),line(6,'event_msg',{type:'user_message',message:'exclude middle tail'})]
  const middle=join(directory,'rollout-2026-10-24T08-00-00-'+threadId+'_'+middleId+'.jsonl');writeFileSync(middle,middleLines.join('\n')+'\n')
  const middleBoundary=Buffer.byteLength(middleLines.slice(0,3).join('\n')+'\n')
  const current=join(directory,'rollout-2026-10-24T09-00-00-'+threadId+'_'+latestId+'.jsonl')
  writeFileSync(current,[line(6,'session_meta',{id:threadId,cwd:'/fixture/project',history_mode:'paginated',history_base:{thread_id:middleId,end_ordinal_exclusive:6,end_byte_offset:middleBoundary}}),line(7,'event_msg',{type:'user_message',message:'latest turn'})].join('\n')+'\n')
  const page=await readCodexSessionLineage(root,current,threadId,{page:1,pageSize:20,query:''},new AbortController().signal)
  assert.equal(page.total,5);assert.deepEqual(page.messages.map(message=>message.blocks[0]?.text),['oldest ancestor','oldest reply','middle turn','middle reply','latest turn'])
})

test('Codex viewer accepts a real paginated rollout line larger than the generic 4 MiB limit',async t=>{
  const f=fixture(t),parentLines=readFileSync(f.parent,'utf8').trimEnd().split('\n').map(value=>JSON.parse(value))
  parentLines[1].payload.message='large-message-'+ 'x'.repeat(5*1024*1024)
  writeFileSync(f.parent,parentLines.map(value=>JSON.stringify(value)).join('\n')+'\n')
  const currentLines=readFileSync(f.current,'utf8').trimEnd().split('\n').map(value=>JSON.parse(value))
  currentLines[0].payload.history_base.end_byte_offset=Buffer.byteLength(parentLines.slice(0,3).map(value=>JSON.stringify(value)).join('\n')+'\n')
  writeFileSync(f.current,currentLines.map(value=>JSON.stringify(value)).join('\n')+'\n')
  const page=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:10,query:''},new AbortController().signal)
  assert.equal(page.total,6);assert.match(page.messages[0]?.blocks[0]?.text??'',/^large-message-/);assert.ok(page.messages[0]?.truncated)
})

test('Codex viewer resolves a history_base boundary whose following record exceeds 4 MiB',async t=>{
  const f=fixture(t),parentLines=readFileSync(f.parent,'utf8').trimEnd().split('\n').map(value=>JSON.parse(value))
  parentLines[3].payload.message='oversized-unrelated-tail-'+'z'.repeat(5*1024*1024)
  writeFileSync(f.parent,parentLines.map(value=>JSON.stringify(value)).join('\n')+'\n')
  const currentLines=readFileSync(f.current,'utf8').trimEnd().split('\n').map(value=>JSON.parse(value))
  currentLines[0].payload.history_base.end_byte_offset=Buffer.byteLength(parentLines.slice(0,3).map(value=>JSON.stringify(value)).join('\n')+'\n')
  writeFileSync(f.current,currentLines.map(value=>JSON.stringify(value)).join('\n')+'\n')
  const page=await readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:10,query:''},new AbortController().signal)
  assert.equal(page.total,6)
  assert.ok(page.messages.every(message=>!message.blocks.some(block=>block.text.includes('oversized-unrelated-tail'))),'the boundary probe must not include content after history_base')
})

test('Codex viewer rejects a rollout replaced while lineage content is being read',async t=>{
  const f=fixture(t),opened=await open(f.current,'r'),original=opened.read.bind(opened),stat=await opened.stat();let changed=false
  opened.read=async(...args:Parameters<typeof opened.read>)=>{const result=await original(...args);if(!changed){changed=true;renameSync(f.current,f.current+'.replaced-during-read');writeFileSync(f.current,readFileSync(f.current+'.replaced-during-read'))}return result}
  try{await assert.rejects(readCodexSessionLineage(f.root,f.current,f.threadId,{page:1,pageSize:20,query:''},new AbortController().signal,{file:opened,size:stat.size}),/读取期间发生变化/);assert.equal(changed,true)}
  finally{opened.read=original;await opened.close()}
})
