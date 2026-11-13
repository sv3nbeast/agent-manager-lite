import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {History} from '../src/main/history'
import {historyOutcome,safeHistoryErrorCategory,type HistoryFilter} from '../src/shared/history'

test('history persists only safe outcome categories and filters/exports agree',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cml-history-outcome-')),h=new History(root)
 t.after(()=>{h.close();rmSync(root,{recursive:true,force:true})})
 const cases=[
  ['complete',true,200,'client_canceled','成功'],
  ['cancel',false,200,'client_canceled','客户端取消'],
  ['short',false,200,'downstream_write_error','传输中断'],
  ['eof',false,200,'stream_interrupted','流中断'],
  ['incomplete',false,200,'response_incomplete','回复未完成'],
  ['upstream',false,200,'upstream_response_failed','上游错误'],
  ['limit',false,429,'quota_or_rate_limit','额度或限流'],
  ['old',false,200,'','结果未确认'],
  ['unsafe',false,200,'SECRET_fixture_do_not_store','结果未确认']
 ] as const
 for(const [requestId,success,status,errorCategory] of cases)h.record('run',{type:'usage',requestId,success,status,errorCategory,usage:{inputTokens:10,outputTokens:2,cachedTokens:7},errorMessage:'SECRET_fixture_do_not_store'})
 const query=(outcome:HistoryFilter['outcome'])=>h.query({filter:{search:'',outcome},page:1,pageSize:25})
 const all=query('all')
 assert.equal(all.total,9);assert.equal(all.succeeded,1);assert.equal(all.outputTokens,18)
 for(const [id,,,category,label] of cases){
  const row=all.entries.find(entry=>entry.requestId===id)!
  assert.equal(historyOutcome(row).label,label)
  assert.equal(row.errorCategory,id==='complete'||id==='unsafe'?'':category)
 }
 assert.deepEqual(query('canceled').entries.map(x=>x.requestId),['cancel'])
 assert.equal(query('interrupted').total,3);assert.equal(query('upstream_error').total,2)
 assert.equal(query('error').total,8);assert.equal(query('success').total,1)
 const file=join(root,'out.csv')
 assert.equal(await h.exportCSV({search:'',outcome:'interrupted'},file,new AbortController().signal),3)
 const csv=readFileSync(file,'utf8');assert.match(csv,/"errorCategory"/);assert.match(csv,/"stream_interrupted"/);assert.doesNotMatch(csv,/SECRET/)
 const db=new DatabaseSync(join(root,'history.sqlite'),{readOnly:true})
 try {assert.equal(db.prepare("SELECT COUNT(*) n FROM requests WHERE errorCategory LIKE '%SECRET%'").get()!.n,0)}finally{db.close()}
 for(const invalid of ['SECRET_fixture_do_not_store','__proto__','constructor',null,{},1])assert.equal(safeHistoryErrorCategory(invalid),'')
})

test('old failed HTTP 200 history remains unchanged on migration, reopening, query and export',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cml-history-legacy-')),path=join(root,'history.sqlite')
 const db=new DatabaseSync(path)
 db.exec("CREATE TABLE requests (seq INTEGER PRIMARY KEY,identity TEXT UNIQUE NOT NULL,requestId TEXT NOT NULL,requestedAt INTEGER NOT NULL,model TEXT NOT NULL,upstreamModel TEXT NOT NULL,accountId TEXT NOT NULL,success INTEGER NOT NULL,status INTEGER NOT NULL,latencyMs INTEGER NOT NULL,inputTokens INTEGER NOT NULL,outputTokens INTEGER NOT NULL,cachedTokens INTEGER NOT NULL,inboundTier TEXT,outboundTier TEXT,responseTier TEXT,tierSource TEXT NOT NULL);INSERT INTO requests VALUES (1,'old:1','old200',1,'fixture','fixture','',0,200,20,100,20,80,'','default','default','instance');")
 db.close()
 let h=new History(root)
 t.after(()=>{h.close();rmSync(root,{recursive:true,force:true})})
 const read=()=>h.query({filter:{search:'',outcome:'all'},page:1,pageSize:25}).entries[0]
 assert.equal(read().success,false);assert.equal(read().errorCategory,'');assert.equal(read().inputTokens,100)
 assert.equal(historyOutcome(read()).label,'结果未确认');assert.match(historyOutcome(read()).detail,/原始记录保持不变/)
 h.close();h=new History(root);assert.equal(read().success,false)
 const file=join(root,'old.csv');await h.exportCSV({search:'',outcome:'all'},file,new AbortController().signal)
 assert.match(readFileSync(file,'utf8'),/"old200".*"0","200"/)
 const check=new DatabaseSync(path,{readOnly:true})
 try{assert.deepEqual(check.prepare('SELECT success,status,inputTokens,outputTokens,cachedTokens FROM requests').get(),Object.assign(Object.create(null),{success:0,status:200,inputTokens:100,outputTokens:20,cachedTokens:80}))}finally{check.close()}
})

test('HTTP status alone never converts an uncertain result to success',()=>{
 assert.equal(historyOutcome({success:false,status:200}).label,'结果未确认')
 assert.equal(historyOutcome({success:false,status:0}).label,'结果未确认')
 assert.equal(historyOutcome({success:false,status:502}).label,'失败')
 assert.equal(historyOutcome({success:false,status:200,errorCategory:'upstream_stream_timeout'}).label,'流超时')
 assert.equal(historyOutcome({success:false,status:200,errorCategory:'upstream_error'}).color,'red')
})
