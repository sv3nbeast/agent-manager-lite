// Optional real Codex consumer test: persistent conversation -> managed copy ->
// resume from the copy against loopback SSE. No existing profile is opened.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync,realpathSync,existsSync,readFileSync,readdirSync,mkdirSync,copyFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {join,isAbsolute,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {Store} from '../src/main/store'
import {Instances} from '../src/main/instances'
import {MacCliRuntime,MacInstanceRuntime} from '../src/main/cliInstanceRuntime'
import {TokenAuthority} from '../src/main/tokens'
import {NativeInstanceAccounts} from '../src/main/nativeInstanceAccounts'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'
import {SessionCatalog} from '../src/main/sessions'
import {SessionTransfers} from '../src/main/sessionTransfers'
import {SessionArchives} from '../src/main/sessionArchives'
import {ClientConfigs} from '../src/main/clientConfig'
import {SessionSync} from '../src/main/sessionSync'

async function main(){
  const binary=process.env.CML_TEST_CODEX_BINARY
  assert.ok(binary&&isAbsolute(binary)&&existsSync(binary),'Set CML_TEST_CODEX_BINARY to an existing Codex executable')
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-copy-consumer-'))),received:Record<string,unknown>[]=[]
  const upstream=createServer(async(req,res)=>{
    if(req.method!=='POST'||!req.url?.endsWith('/responses')){res.writeHead(404).end();return}
    let raw='';for await(const chunk of req)raw+=chunk
    assert.equal(req.headers.authorization,'Bearer fixture-copy-api');const body=JSON.parse(raw);received.push(body)
    await new Promise(resolve=>setTimeout(resolve,300))
    const text=received.length===1?'fixture-first-turn':'fixture-resumed-turn'
    const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}
    const response={id:'resp_fixture',object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:4,output_tokens:2,total_tokens:6}}
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},
      {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text},
      {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]},
      {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}]
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map((event,sequence_number)=>'data: '+JSON.stringify({...event,sequence_number})+'\n\n').join(''))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();assert.ok(address&&typeof address==='object')
  const store=new Store(join(root,'data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),tokens=new TokenAuthority(store,async()=>assert.fail('No real OAuth'))
  const children=new Set<ReturnType<typeof spawn>>();let current:{output:string;done:Promise<number|null>}|undefined
  const cli=new MacCliRuntime(async script=>{
    const child=spawn('/bin/bash',[script],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});children.add(child)
    const state={output:'',done:Promise.resolve(null) as Promise<number|null>};current=state
    child.stdout!.on('data',data=>{state.output+=data.toString().slice(0,100000-state.output.length)});child.stderr!.on('data',data=>{state.output+=data.toString().slice(0,100000-state.output.length)})
    const timer=setTimeout(()=>child.kill('SIGKILL'),20_000)
    state.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{clearTimeout(timer);children.delete(child);resolve(code)})})
  })
  const instances=new Instances(store,()=>assert.fail('Native copy must not start a gateway'),id=>tokens.ensure(id),new MacInstanceRuntime(undefined,cli),new NativeInstanceAccounts(store,tokens))
  const importStore=new Store(join(root,'import-data'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),importTokens=new TokenAuthority(importStore,async()=>assert.fail('No real OAuth'))
  const importedInstances=new Instances(importStore,()=>assert.fail('Native copy must not start a gateway'),id=>importTokens.ensure(id),new MacInstanceRuntime(undefined,cli),new NativeInstanceAccounts(importStore,importTokens))
  const account=createAPIAccount({name:'Fixture copy',apiKey:'fixture-copy-api',baseUrl:`http://127.0.0.1:${address.port}/v1`,models:['gpt-5.5'],wireApi:'responses',defaultTier:'fast'});importParsedAccounts(store,[account])
  const app=instances.registerApplication(binary,'cli'),args=['-c','features.plugins=false','-c','features.remote_models=false','-c','analytics.enabled=false','exec','--json','--ignore-rules','--skip-git-repo-check','--sandbox','read-only']
  async function run(id:string,service=instances){
    const instance=service.views().find(value=>value.id===id)!;current=undefined
    service.start(service.preview({id,revision:instance.revision}).ticket);await service.settled(id)
    const child=current as {output:string;done:Promise<number|null>}|undefined;assert.ok(child,'CLI was not dispatched')
    assert.equal(await child.done,0,child.output);await service.refresh()
    assert.equal(service.views().find(value=>value.id===id)?.status,'stopped',JSON.stringify(service.views()))
    return child.output
  }
  function files(directory:string,prefix=''):Record<string,string>{
    const snapshot:Record<string,string>={}
    for(const entry of readdirSync(join(directory,prefix),{withFileTypes:true})){
      const path=join(prefix,entry.name)
      if(entry.isDirectory())Object.assign(snapshot,files(directory,path))
      else if(entry.isFile())snapshot[path]=createHash('sha256').update(readFileSync(join(directory,path))).digest('hex')
    }
    return snapshot
  }
  try{
    instances.save({details:{name:'Source',applicationId:app.id,accountId:account.id,connectionMode:'native',defaultTier:'fast',model:'gpt-5.5',extraArgs:[...args,'Remember fixture-first-turn. Do not use tools.']}})
    const source=instances.views()[0],output=await run(source.id)
    const event=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(event=>event.type==='thread.started')
    assert.ok(event?.thread_id,output);assert.ok(output.includes('fixture-first-turn'),output)
    const {id,revision,name:_name,...details}=store.read().instances![0]
    instances.startCopy({id,revision,details:{applicationId:details.applicationId,accountId:details.accountId,connectionMode:details.connectionMode,defaultTier:details.defaultTier,model:details.model,name:'Copy',extraArgs:[...args,'resume',event.thread_id,'Continue the earlier fixture conversation. Do not use tools.']}})
    const deadline=Date.now()+10_000
    while(['scanning','copying'].includes(instances.copyView()!.status)){if(Date.now()>deadline)throw new Error('Copy timed out');await new Promise(resolve=>setTimeout(resolve,20))}
    assert.equal(instances.copyView()!.status,'completed',instances.copyView()!.error)
    const target=instances.views().find(value=>value.id===instances.copyView()!.targetId)!
    assert.equal(existsSync(join(target.directory,'auth.json')),false)
    const before=files(source.directory)
    const resumed=await run(target.id);assert.ok(resumed.includes('fixture-resumed-turn'),resumed)
    assert.equal(received.length,2);assert.ok(JSON.stringify(received[1].input).includes('fixture-first-turn'),'Resumed request must carry the previous assistant reply')
    assert.equal(received[1].service_tier,'priority');assert.deepEqual(files(source.directory),before,'Resuming a copy must not alter any source session or database file')
    assert.equal(existsSync(join(target.directory,'auth.json')),false)
    importParsedAccounts(importStore,[account]);const importedApp=importedInstances.registerApplication(binary,'cli')
    const selected=importedInstances.selectCopySource(source.directory)
    importedInstances.startExternalCopy({ticket:selected.ticket,sourceClosed:true,details:{applicationId:importedApp.id,accountId:account.id,connectionMode:'native',defaultTier:'fast',model:'gpt-5.5',name:'External copy',extraArgs:[...args,'resume',event.thread_id,'Continue the earlier fixture conversation. Do not use tools.']}})
    const importDeadline=Date.now()+10_000
    while(['scanning','copying'].includes(importedInstances.copyView()!.status)){if(Date.now()>importDeadline)throw new Error('External copy timed out');await new Promise(resolve=>setTimeout(resolve,20))}
    assert.equal(importedInstances.copyView()!.status,'completed',importedInstances.copyView()!.error)
    const imported=importedInstances.views()[0],importedOutput=await run(imported.id,importedInstances)
    assert.ok(importedOutput.includes('fixture-resumed-turn'),importedOutput);assert.equal(received.length,3)
    assert.ok(JSON.stringify(received[2].input).includes('fixture-first-turn'));assert.equal(received[2].service_tier,'priority')
    assert.deepEqual(files(source.directory),before);assert.equal(existsSync(join(imported.directory,'auth.json')),false)
    const attachSource=importedInstances.selectCopySource(source.directory,'attach'),originalConfig=existsSync(join(source.directory,'config.toml'))?readFileSync(join(source.directory,'config.toml'),'utf8'):undefined
    await importedInstances.attachExisting({ticket:attachSource.ticket,sourceClosed:true,details:{applicationId:importedApp.id,accountId:account.id,connectionMode:'native',defaultTier:'fast',model:'gpt-5.5',name:'Existing directory',extraArgs:[...args,'resume',event.thread_id,'Continue the existing fixture conversation. Do not use tools.']}})
    const attached=importedInstances.views().find(value=>value.externalHome)!
    assert.equal(attached.directory,source.directory);assert.deepEqual(files(source.directory),before)
    const attachedOutput=await run(attached.id,importedInstances)
    assert.ok(attachedOutput.includes('fixture-resumed-turn'),attachedOutput);assert.equal(received.length,4)
    assert.ok(JSON.stringify(received[3].input).includes('fixture-first-turn'));assert.equal(received[3].service_tier,'priority')
    assert.equal(existsSync(join(source.directory,'auth.json')),false)
    assert.equal(existsSync(join(source.directory,'config.toml'))?readFileSync(join(source.directory,'config.toml'),'utf8'):undefined,originalConfig)
    const beforeDetach=files(source.directory)
    importedInstances.remove({id:attached.id,revision:attached.revision})
    assert.deepEqual(files(source.directory),beforeDetach,'Detaching must preserve every existing directory file')
    const sessions=new SessionCatalog(store),page=await sessions.scan({runId:randomUUID(),titleQuery:'',contentQuery:'fixture-first-turn',kind:'all'})
    assert.deepEqual(page.warnings,[]);assert.equal(page.total,1)
    assert.equal(page.items[0].id,event.thread_id);assert.equal(page.items[0].locations.length,2)
    assert.ok(page.items[0].title.includes('fixture-first-turn'),JSON.stringify(page.items))
    const usage=await sessions.tokenStats({snapshotId:page.snapshotId,sessionIds:[event.thread_id]})
    assert.deepEqual(usage[0].tokens,{input:8,output:4,total:12})
    const location=await sessions.location({snapshotId:page.snapshotId,sessionId:event.thread_id,targetId:source.id})
    assert.ok(location.startsWith(source.directory+'/sessions/'))
    console.log('Real CLI session catalog passed: actual rollout metadata, SQLite title, content search, merged source/copy locations and cumulative Token usage (8 input / 4 output / 12 total).')
    instances.save({details:{name:'Selected session only',applicationId:app.id,accountId:account.id,connectionMode:'native',defaultTier:'fast',model:'gpt-5.5',extraArgs:[...args,'resume',event.thread_id,'Continue the selected fixture conversation. Do not use tools.']}})
    const selectedOnly=instances.views().find(instance=>instance.name==='Selected session only')!
    assert.deepEqual(readdirSync(selectedOnly.directory),[])
    const transfers=new SessionTransfers(store,sessions,()=>instances.applications(),id=>instances.inUse(id)),copyPreview=await transfers.preview({snapshotId:page.snapshotId,sessionIds:[event.thread_id],targetId:selectedOnly.id,applicationId:app.id}),sourceBeforeSelected=files(source.directory)
    transfers.start({ticket:copyPreview.ticket,clientsClosed:true});await transfers.settled()
    assert.equal(transfers.view().transfer?.status,'completed',JSON.stringify(transfers.view()));assert.equal(transfers.view().transfer?.indexError,undefined,JSON.stringify(transfers.view()));assert.equal(transfers.view().recoveries.length,0)
    assert.equal(existsSync(join(selectedOnly.directory,'auth.json')),false)
    assert.equal(existsSync(join(selectedOnly.directory,'config.toml')),false)
    const copiedSessions=await sessions.scan({runId:randomUUID(),targetId:selectedOnly.id});assert.equal(copiedSessions.total,1);assert.equal(copiedSessions.items[0].id,event.thread_id)
    const selectedOutput=await run(selectedOnly.id);assert.ok(selectedOutput.includes('fixture-resumed-turn'),selectedOutput);assert.equal(received.length,5)
    assert.ok(JSON.stringify(received[4].input).includes('fixture-first-turn'));assert.equal(received[4].service_tier,'priority');assert.deepEqual(files(source.directory),sourceBeforeSelected)
    console.log('Real selected-session copy passed: empty target, official app-server index lists actual copied ID, native CLI resumes previous assistant content with Fast=priority; no source changes or account/config copying.')
    const archives=new SessionArchives(store,sessions,transfers),zipPage=await sessions.scan({runId:randomUUID(),targetId:source.id}),zipBefore=files(source.directory)
    const zipPreview=await archives.previewExport({snapshotId:zipPage.snapshotId,sessionIds:[event.thread_id]}),zipPath=join(root,'sessions.zip')
    archives.startExport(zipPreview.ticket,zipPath);await archives.settled();assert.equal(archives.view()?.status,'completed',JSON.stringify(archives.view()))
    execFileSync('python3',['-c',`import sys,zipfile,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 m=json.loads(z.read('manifest.json'));assert m['kind']=='codex-session-export' and m['packageVersion']==1
 assert len(z.namelist())==len(m['sessions'])+1
 for s in m['sessions']:
  raw=z.read(s['fileEntry']);assert len(raw)==s['sizeBytes'];assert hashlib.sha256(raw).hexdigest()==s['sha256']
  assert json.loads(raw.splitlines()[0])['payload']['id']==s['sessionId']
`,zipPath],{timeout:10000})
    instances.save({details:{name:'ZIP session only',applicationId:app.id,accountId:account.id,connectionMode:'native',defaultTier:'fast',model:'gpt-5.5',extraArgs:[...args,'resume',event.thread_id,'Continue the ZIP fixture conversation. Do not use tools.']}})
    const zipTarget=instances.views().find(instance=>instance.name==='ZIP session only')!,packagePreview=await archives.openPackage(zipPath),importPreview=await archives.previewImport({ticket:packagePreview.ticket,targetId:zipTarget.id,applicationId:app.id,sessionIds:[event.thread_id]})
    archives.startImport({ticket:importPreview.ticket,clientsClosed:true});await archives.settled();assert.equal(archives.view()?.status,'completed',JSON.stringify(archives.view()));assert.equal(archives.view()?.error,undefined,JSON.stringify(archives.view()))
    assert.equal(existsSync(join(zipTarget.directory,'auth.json')),false);assert.equal(existsSync(join(zipTarget.directory,'config.toml')),false)
    const zipOutput=await run(zipTarget.id);assert.ok(zipOutput.includes('fixture-resumed-turn'),zipOutput);assert.equal(received.length,6);assert.ok(JSON.stringify(received[5].input).includes('fixture-first-turn'));assert.equal(received[5].service_tier,'priority');assert.deepEqual(files(source.directory),zipBefore)
    await archives.stop()
    console.log('Real ZIP round trip passed: Python independently verifies Cockpit v1/bytes/SHA256; selected archive import indexes in an empty home; native Codex resumes previous content with Fast=priority; no source changes or auth/config copying.')
    const archiveSource=join(root,'archived-source'),archiveTarget=join(root,'archived-target');mkdirSync(join(archiveSource,'archived_sessions','legacy-nested'),{recursive:true});mkdirSync(archiveTarget)
    copyFileSync(location,join(archiveSource,'archived_sessions','legacy-nested','rollout-noncanonical.jsonl'))
    const archiveBefore=files(archiveSource),configs=new ClientConfigs(store),archivedFrom=configs.register(archiveSource),archivedTo=configs.register(archiveTarget),archivePage=await sessions.scan({runId:randomUUID(),targetId:archivedFrom.id})
    assert.equal(archivePage.items[0].locations[0].archived,true)
    const archivePreview=await transfers.preview({snapshotId:archivePage.snapshotId,sessionIds:[event.thread_id],targetId:archivedTo.id,applicationId:app.id})
    transfers.start({ticket:archivePreview.ticket,clientsClosed:true});await transfers.settled()
    assert.equal(transfers.view().transfer?.indexError,undefined,JSON.stringify(transfers.view()));assert.equal(transfers.view().transfer?.status,'completed')
    const archivedCopy=await sessions.scan({runId:randomUUID(),targetId:archivedTo.id});assert.equal(archivedCopy.total,1);assert.equal(archivedCopy.items[0].locations[0].archived,true)
    const archivedLocation=await sessions.location({snapshotId:archivedCopy.snapshotId,sessionId:event.thread_id,targetId:archivedTo.id});assert.equal(join(archiveTarget,'archived_sessions',basename(archivedLocation)),archivedLocation);assert.deepEqual(files(archiveSource),archiveBefore)
    const sync=new SessionSync(store,transfers,()=>instances.applications(),id=>instances.inUse(id))
    // Both same-ID copies have diverged through real turns: selectedOnly has a
    // selected-conversation prompt; zipTarget has an independent ZIP prompt.
    const syncPreview=await sync.preview({targetIds:[selectedOnly.id,zipTarget.id],applicationId:app.id})
    assert.equal(syncPreview.sessionCount,1)
    sync.start({ticket:syncPreview.ticket,clientsClosed:true});await sync.settled()
    assert.equal(sync.view().sync?.status,'completed',JSON.stringify(sync.view()));assert.deepEqual(sync.view().recoveries,[])
    const repeat=await sync.preview({targetIds:[selectedOnly.id,zipTarget.id],applicationId:app.id})
    assert.ok(repeat.targets.every(target=>target.added===0&&target.updated===0&&target.unchanged===1),JSON.stringify(repeat));await sync.discard()
    for(const target of [selectedOnly,zipTarget]){
      const beforeRequest=received.length
      const resumed=await run(target.id);assert.ok(resumed.includes('fixture-resumed-turn'),resumed);assert.equal(received.length,beforeRequest+1)
      const body=received.at(-1)!;assert.equal(body.service_tier,'priority')
      assert.ok(JSON.stringify(body.input).includes('Continue the selected fixture conversation.'),'Synced resume must include the selected-copy branch')
      assert.ok(JSON.stringify(body.input).includes('Continue the ZIP fixture conversation.'),'Synced resume must include the ZIP branch')
      assert.ok(JSON.stringify(body.input).includes('fixture-first-turn'))
      assert.equal(existsSync(join(target.directory,'auth.json')),false)
    }
    await sync.stop()
    console.log('Real all-session sync passed: two real same-ID conversation branches merged, official indexes rebuilt, repeat preview has no rollout changes, both native CLI homes resume both branches with Fast=priority.')
    await transfers.stop();sessions.stop()
    console.log('Real archived selected copy passed: noncanonical nested source becomes the official flat archive layout; actual ID is visible in archived thread/list, source bytes unchanged.')
    console.log('Real Codex instance copy passed: managed/external copies and directly attached existing home resume prior content; Fast=priority, source unchanged by copies/registration, login restored and every file retained on detach; only temporary profiles and loopback SSE.')
  }finally{
    await instances.closeAll().catch(()=>{})
    await importedInstances.closeAll().catch(()=>{})
    for(const child of children){try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{}}
    await tokens.stop();await importTokens.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(root,{recursive:true,force:true})
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1})
