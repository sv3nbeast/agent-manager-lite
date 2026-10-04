import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { History, csvCell } from '../src/main/history'
import { DatabaseSync } from 'node:sqlite'

test('100,000 usage events remain paginated, filter/export agree, credentials never enter history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-history-'))
  let history = new History(directory)
  try {
    for (let i = 0; i < 100000; i++) history.record('run', { type:'usage', requestId:`req-${i}`, requestedAtMs:1000+i, model:i % 2 ? 'model-b' : 'model-a', success:i % 2 === 0,
      inboundServiceTier:'', outboundServiceTier:'priority', tierSource:'global', usage:{inputTokens:3,outputTokens:2,cachedTokens:1},
      errorMessage:'SECRET_should_not_be_saved', apiKey:'SECRET_should_not_be_saved', body:'SECRET_should_not_be_saved' })
    history.record('run', {type:'usage',requestId:'req-0',model:'duplicate'})
    const filter = { search:'model-a', outcome:'success' as const, from:1000,to:1099 }
    const page = history.query({filter,page:2,pageSize:7})
    assert.equal(page.entries.length,7); assert.equal(page.total,50); assert.equal(page.succeeded,50)
    assert.equal(page.inputTokens,150); assert.equal(page.cachedTokens,50)
    assert.deepEqual(page.report.models.map(row=>row.key),['model-a'])
    assert.deepEqual(page.report.models[0],{key:'model-a',requests:50,succeeded:50,inputTokens:150,outputTokens:100,cachedTokens:50,totalTokens:250})
    assert.deepEqual(page.report.tiers[0],{key:'priority',requests:50,succeeded:50,inputTokens:150,outputTokens:100,cachedTokens:50,totalTokens:250})
    assert.equal(page.entries[0].requestId,'req-84')
    assert.equal(page.entries[0].inboundTier,''); assert.equal(page.entries[0].responseTier,null)
    assert.equal(page.entries[0].outboundTier,'priority')
    assert.equal(history.query({filter:{search:'',outcome:'all'},page:4000,pageSize:25}).entries.length,25)
    const file = join(directory,'export.csv')
    assert.equal(await history.exportCSV(filter,file,new AbortController().signal),50)
    const rows = readFileSync(file,'utf8').trim().split('\r\n')
    assert.equal(rows.length,51); assert.match(rows[1],/req-98/)
    assert.ok(rows.every(row => !row.includes('SECRET')))
    history.close(); history = new History(directory)
    assert.equal(history.query({filter:{search:'',outcome:'all'},page:1,pageSize:25}).total,100000)
    assert.equal(history.error,undefined)
    assert.equal(readFileSync(join(directory,'history.sqlite')).includes('SECRET'),false)
    assert.throws(() => history.query({filter:{search:'',outcome:'all'},page:1,pageSize:100000}))
    assert.throws(() => history.query({filter:{search:'',outcome:'all',from:10,to:1},page:1,pageSize:25}))
    const controller = new AbortController()
    writeFileSync(file,'original')
    const exporting = history.exportCSV({search:'',outcome:'all'},file,controller.signal)
    setTimeout(() => controller.abort(),1)
    await assert.rejects(exporting,/abort/i)
    assert.equal(readFileSync(file,'utf8'),'original')
    assert.equal(readdirSync(directory).some(name=>name.endsWith('.tmp')),false)
    assert.equal(csvCell('=1+2'),'"\'=1+2"')
    assert.equal(csvCell('  @SUM(1)'),'"\'  @SUM(1)"')
    assert.equal(csvCell('Unicode 🧪,"quoted"'),'"Unicode 🧪,""quoted"""')
  } finally { history.close(); rmSync(directory,{recursive:true,force:true}) }
})

test('legacy history migrates without losing rows and failed commits cannot silently undercount a key',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'cml-history-migration-')),path=join(directory,'history.sqlite')
  const legacy=new DatabaseSync(path)
  legacy.exec(`CREATE TABLE requests (
    seq INTEGER PRIMARY KEY, identity TEXT UNIQUE NOT NULL, requestId TEXT NOT NULL, requestedAt INTEGER NOT NULL,
    model TEXT NOT NULL, upstreamModel TEXT NOT NULL, accountId TEXT NOT NULL, success INTEGER NOT NULL,
    status INTEGER NOT NULL, latencyMs INTEGER NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
    cachedTokens INTEGER NOT NULL, inboundTier TEXT, outboundTier TEXT, responseTier TEXT, tierSource TEXT NOT NULL);
    INSERT INTO requests VALUES (1,'old:1','old-request',1,'fixture','fixture','old-account',1,200,5,8,2,3,'','priority',NULL,'global');`)
  legacy.close()
  let history=new History(directory)
  const blocker=new DatabaseSync(path)
  try{
    const old=history.query({filter:{search:'old-request',outcome:'all'},page:1,pageSize:25}).entries[0]
    assert.equal(old.totalTokens,10);assert.equal(old.apiKeyId,'');assert.equal(old.responseTier,null)
    const event={type:'usage',requestId:'new',apiKeyId:'scoped-key',apiKeyLabel:'工作密钥',success:true,usage:{inputTokens:3,outputTokens:2,totalTokens:7}}
    history.record('run',event);history.record('run',event)
    blocker.exec('BEGIN IMMEDIATE')
    assert.throws(()=>history.keyTokenUsage(['scoped-key']),/保存失败/)
    blocker.exec('ROLLBACK')
    assert.deepEqual(history.keyTokenUsage(['scoped-key']),{'scoped-key':7})
    assert.equal(history.error,undefined)
    assert.equal(history.query({filter:{search:'工作密钥',outcome:'all'},page:1,pageSize:25}).total,1)
    history.close();history=new History(directory)
    assert.deepEqual(history.keyTokenUsage(['scoped-key']),{'scoped-key':7})
    assert.equal(history.query({filter:{search:'old-request',outcome:'all'},page:1,pageSize:25}).entries[0].totalTokens,10)
  }finally{blocker.close();history.close();rmSync(directory,{recursive:true,force:true})}
})
