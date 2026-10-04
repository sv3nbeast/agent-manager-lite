import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {Store,type StoredAccount} from '../src/main/store'
import {ProxyBatch} from '../src/main/proxyBatch'
import {ProxyResources} from '../src/main/proxyResources'
import {prepareProxyImport,normalizeProxyImportLine,proxyImportFingerprint} from '../src/main/proxyImport'
import {accountProxyURL,type StoredProxyResource} from '../src/main/proxyPolicy'
import {proxyImportOptionsSchema} from '../src/shared/proxyBatch'

const options=proxyImportOptionsSchema.parse({})
function fixture(t:{after(fn:()=>void):void}){
  const directory=mkdtempSync(join(tmpdir(),'cml-proxy-batch-')),key=randomBytes(32);let fail=false,now=Date.now()
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const codec={encrypt:(text:string)=>{if(fail)throw new Error('fixture write failure');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()])},decrypt:(bytes:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8')}}
  const store=new Store(directory,codec),busy=new Set<string>(),batch=new ProxyBatch(store,id=>busy.has(id),()=>now),resources=new ProxyResources(store)
  const add=(name:string):StoredAccount=>({id:randomUUID(),revision:0,generation:randomUUID(),name,kind:'oauth',baseUrl:'https://chatgpt.com',wireApi:'responses',models:[],tags:[],note:'',defaultTier:'inherit',createdAt:now,credentials:{accessToken:'fixture-token'}})
  const apply=(ticket:string|undefined)=>{assert.ok(ticket);batch.apply({ticket,confirmed:true})}
  return {store,batch,busy,resources,add,apply,codec,fail:(value:boolean)=>{fail=value},advance:()=>{now+=300001}}
}

test('manual proxy formats preserve IPv6, Unicode and reserved credentials without exposing them in previews',()=>{
  for(const raw of ['example.com:1080:user:pass','user:pass@example.com:1080','example.com:1080@user:pass','socks5://user:pass@example.com:1080']){
    const value=new URL(normalizeProxyImportLine(raw,options));assert.equal(value.hostname,'example.com');assert.equal(decodeURIComponent(value.username),'user');assert.equal(decodeURIComponent(value.password),'pass')
  }
  const input='[2001:db8::1]:1080:用户:p:a@ss%word',prepared=prepareProxyImport(input,{...options,format:'host_auth'},[]),url=new URL(prepared.resources[0].url)
  assert.equal(decodeURIComponent(url.username),'用户');assert.equal(decodeURIComponent(url.password),'p:a@ss%word');assert.equal(url.hostname,'[2001:db8::1]')
  for(const secret of ['p:a@ss','%word','用户'])assert.equal(JSON.stringify(prepared.preview).includes(secret),false)
  const labeled=prepareProxyImport('https://name:p%40ss@proxy.invalid#%E9%A6%99%E6%B8%AF',options,[])
  assert.equal(labeled.resources[0].name,'香港');assert.equal(labeled.preview.rows[0].address?.port,443)
  assert.equal(labeled.resources[0].url.includes('#'),false)
  const encoded=prepareProxyImport(Buffer.from('http://user:one@host:80\nhttp://user:two@host:80').toString('base64'),options,[])
  assert.equal(encoded.preview.encoded,true);assert.equal(encoded.preview.valid,2);assert.notEqual(encoded.resources[0].name,encoded.resources[1].name)
})

test('ambiguous formats require a choice; invalid rows retain line numbers and duplicate identity includes decoded credentials',()=>{
  assert.throws(()=>normalizeProxyImportLine('host:123@user:456',options),/ambiguous/)
  const chosen=prepareProxyImport('host:123@user:456',{...options,format:'host_at_auth'},[])
  assert.equal(chosen.resources.length,1);assert.equal(JSON.stringify(chosen.preview).includes('456'),false)
  const input='# comment\nhost:1080:u:one\n\ninvalid\nhost:1080:u:one\nhost:1080:u:two\nhost:123@user:456'
  const result=prepareProxyImport(input,options,[])
  assert.deepEqual([result.preview.valid,result.preview.invalid,result.preview.duplicates],[2,2,1]);assert.ok(result.preview.blocked)
  assert.equal(result.preview.rows[1].line,4);assert.equal(result.preview.rows.at(-1)?.error,'ambiguous')
  const skipped=prepareProxyImport(input,{...options,skipInvalid:true},[])
  assert.equal(skipped.preview.blocked,undefined);assert.equal(skipped.resources.length,2)
  const repeated=prepareProxyImport('host:1080:u:two',options,skipped.resources)
  assert.equal(repeated.preview.duplicates,1);assert.equal(repeated.resources.length,0)
  const retained=prepareProxyImport('host:1080:u:two',{...options,skipDuplicates:false},skipped.resources)
  assert.equal(retained.resources.length,1);assert.ok(!skipped.resources.some(r=>r.name===retained.resources[0].name))
  assert.equal(proxyImportFingerprint('http://u:%70ass@HOST:80'),proxyImportFingerprint('http://u:pass@host/'))
  assert.notEqual(proxyImportFingerprint('http://u:first@host'),proxyImportFingerprint('http://u:second@host'))
  assert.equal(proxyImportFingerprint('socks5://host:1080'),proxyImportFingerprint('socks5h://host:1080'))
})

test('proxy batch limits and unsupported structured documents fail without echoing raw secrets or flattening groups',()=>{
  assert.throws(()=>prepareProxyImport('密'.repeat(700000),options,[]),/2 MiB/)
  assert.throws(()=>prepareProxyImport('host:1080\n'.repeat(4097),options,[]),/4096/)
  for(const input of ['{"proxies":["http://u:secret@host:80"]}','proxies:\n  - name: secret','["http://u:secret@host:80"]']){
    assert.throws(()=>prepareProxyImport(input,options,[]),error=>error instanceof Error&&error.message.includes('结构化')&&!error.message.includes('secret'))
  }
  for(const input of ['http://u:private-secret@host/bad-path','host:1080:u:private-secret\u0000','socks5://host','http://host:99999','http://u:%0A@host','http://u:%zz@host','[broken]:1080']){
    const result=prepareProxyImport(input,options,[]);assert.equal(result.resources.length,0);assert.equal(result.preview.rows[0].error,'invalid');assert.equal(JSON.stringify(result.preview).includes('private-secret'),false)
  }
  const resources=Array.from({length:500},(_,i)=>({id:randomUUID(),revision:0,name:'R'+i,url:`http://host:${i+1}/`}))
  assert.match(prepareProxyImport('http://new:8000',options,resources).preview.blocked!,/500/)
})

test('import preview is isolated, cancelable, expiring, bounded and atomically encrypted without rewriting accounts',t=>{
  const f=fixture(t),account=f.add('Untouched');f.store.transaction(s=>s.accounts.push(account))
  const raw='http://fixture:batch-private-secret@localhost:1234',input={input:raw,options:{}},before=f.store.read(),preview=f.batch.previewImport(input)
  assert.deepEqual(f.store.read(),before);assert.equal(JSON.stringify(preview).includes('batch-private-secret'),false)
  f.batch.discard(preview.ticket!);assert.throws(()=>f.apply(preview.ticket),/过期/)
  const expired=f.batch.previewImport(input);f.advance();assert.throws(()=>f.apply(expired.ticket),/过期/)
  const pending=f.batch.previewImport(input);f.fail(true);assert.throws(()=>f.apply(pending.ticket),/write failure/);assert.deepEqual(f.store.read(),before)
  f.fail(false);f.apply(pending.ticket);assert.throws(()=>f.apply(pending.ticket),/过期/)
  const reopened=new Store(f.store.directory,f.codec);assert.deepEqual(reopened.read().accounts,[account]);assert.equal(reopened.read().proxyResources![0].url,raw+'/')
  assert.equal(readFileSync(join(f.store.directory,'state.vault')).includes(Buffer.from('batch-private-secret')),false)
  assert.equal(f.batch.previewImport(input).ticket,undefined)
  for(let i=0;i<10;i++)assert.ok(f.batch.previewImport({input:`http://new:${2000+i}`,options:{}}).ticket)
  assert.throws(()=>f.batch.previewImport(input),/过多/)
  f.advance();assert.ok(f.batch.previewImport({input:'http://new:9000',options:{}}).ticket)
  f.batch.stop();assert.throws(()=>f.batch.previewImport(input),/退出/)
})

test('resource edits invalidate import previews while token rotation does not; invalid input cannot silently import a partial batch',t=>{
  const f=fixture(t),account=f.add('A');f.store.transaction(s=>s.accounts.push(account))
  assert.equal(f.batch.previewImport({input:'http://host:8080\nbroken:input',options:{}}).ticket,undefined)
  const first=f.batch.previewImport({input:'http://host:8080\nbroken:input',options:{skipInvalid:true}})
  const other=f.resources.preview({action:'create',name:'Other',url:'http://other:8888'});f.resources.apply({ticket:other.ticket,confirmed:true})
  assert.throws(()=>f.apply(first.ticket),/变化/);assert.equal(f.store.read().proxyResources?.length,1)
  const next=f.batch.previewImport({input:'http://host:8080',options:{}})
  f.store.transaction(s=>{s.accounts[0].credentials.accessToken='rotated-token'})
  f.apply(next.ticket);assert.equal(f.store.read().accounts[0].credentials.accessToken,'rotated-token')
})

test('batch assignment only changes selected eligible accounts, reports overwrite/same/exclusions and preserves unified policy',t=>{
  const f=fixture(t),r:StoredProxyResource={id:randomUUID(),revision:0,name:'Chosen',url:'http://fixture:secret@localhost:8080/'}
  const a=f.add('Inherited'),own={...f.add('Own'),proxy:{mode:'direct' as const}},same={...f.add('Same'),proxy:{mode:'resource' as const,resourceId:r.id}},unselected=f.add('Not selected'),api={...f.add('API'),kind:'api_key' as const},custom={...f.add('Custom'),providerId:randomUUID()},pending={...f.add('Refresh only'),credentials:{refreshToken:'fixture-refresh'}}
  f.store.transaction(s=>{s.accounts=[a,own,same,unselected,api,custom,pending];s.proxyResources=[r];s.unifiedProxy={mode:'all_accounts',resourceId:r.id}})
  const input={accountIds:[a.id,own.id,same.id,api.id,custom.id,pending.id],mode:'resource',resourceId:r.id,resourceRevision:0},preview=f.batch.previewAssignment(input)
  assert.deepEqual([preview.changed,preview.overwritten,preview.same,preview.ineligible],[2,1,1,3]);assert.equal(JSON.stringify(preview).includes('fixture:secret'),false)
  f.apply(preview.ticket);const state=f.store.read()
  assert.deepEqual(state.accounts.find(v=>v.id===unselected.id),unselected);assert.deepEqual(state.accounts.find(v=>v.id===same.id),same)
  for(const original of [api,custom,pending])assert.deepEqual(state.accounts.find(v=>v.id===original.id),original)
  assert.deepEqual(state.unifiedProxy,{mode:'all_accounts',resourceId:r.id});assert.equal(f.batch.previewAssignment(input).ticket,undefined)
  const direct=f.batch.previewAssignment({accountIds:[a.id,own.id],mode:'direct'});f.apply(direct.ticket)
  assert.equal(accountProxyURL(f.store.read().accounts[0],f.store.proxyState()),'direct')
  const inherit=f.batch.previewAssignment({accountIds:[a.id,own.id],mode:'inherit'});f.apply(inherit.ticket)
  assert.equal(accountProxyURL(f.store.read().accounts[0],f.store.proxyState()),r.url)
  assert.throws(()=>f.batch.previewAssignment({...input,accountIds:[a.id,a.id]}),/重复/)
  assert.throws(()=>f.batch.previewAssignment({...input,accountIds:[randomUUID()]}),/不存在/)
})

test('batch binding rechecks busy and stale states, rolls back failed saves and never overwrites newer token chains',t=>{
  const f=fixture(t),a=f.add('A'),b=f.add('B'),r={id:randomUUID(),revision:0,name:'Proxy',url:'http://localhost:8080/'}
  f.store.transaction(s=>{s.accounts=[a,b];s.proxyResources=[r]})
  const input={accountIds:[a.id,b.id],mode:'resource',resourceId:r.id,resourceRevision:0},before=f.store.read(),preview=f.batch.previewAssignment(input)
  f.busy.add(b.id);assert.throws(()=>f.apply(preview.ticket),/正在使用/);assert.deepEqual(f.store.read(),before);assert.equal(f.batch.previewAssignment(input).busy,1)
  f.busy.clear();f.fail(true);assert.throws(()=>f.apply(preview.ticket),/write failure/);assert.deepEqual(f.store.read(),before)
  f.fail(false);f.store.transaction(s=>{s.accounts[0].credentials.accessToken='rotated'})
  f.apply(preview.ticket);assert.equal(f.store.read().accounts[0].credentials.accessToken,'rotated')
  const stale=f.batch.previewAssignment({accountIds:[a.id,b.id],mode:'direct'});f.store.transaction(s=>{s.accounts[1].generation=randomUUID()})
  assert.throws(()=>f.apply(stale.ticket),/变化/);assert.equal(f.store.read().accounts[0].proxy?.mode,'resource')
  const changedResource=f.batch.previewAssignment({accountIds:[a.id],mode:'direct'});f.store.transaction(s=>{s.proxyResources![0].revision++})
  assert.throws(()=>f.apply(changedResource.ticket),/变化/)
  const cancelled=f.batch.previewAssignment({accountIds:[a.id],mode:'inherit'});f.batch.discard(cancelled.ticket!);assert.throws(()=>f.apply(cancelled.ticket),/过期/)
  f.store.transaction(s=>{s.unifiedProxy={mode:'all_accounts',resourceId:randomUUID()}})
  assert.throws(()=>f.batch.previewAssignment({accountIds:[a.id],mode:'inherit'}),/无效/)
  const repair=f.batch.previewAssignment({accountIds:[a.id],mode:'direct'});f.apply(repair.ticket)
  assert.equal(accountProxyURL(f.store.read().accounts[0],f.store.proxyState()),'direct')
})
