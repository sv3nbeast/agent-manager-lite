// Native consumer regression: synthetic loopback-only turns, isolated profiles,
// exact recovery, and copied/compressed paginated forks. No user credentials.
import assert from 'node:assert/strict'
import {zstdCompressSync} from 'node:zlib'
import {scanSessionHome} from '../src/main/instanceSessionCopy'
import {copySavedInstanceHome} from '../src/main/instanceCopySnapshot'
import {relocateCopiedProfile} from '../src/main/instanceCopy'
import {prepareRolloutProviderRecovery,applyRolloutProviderRecovery} from '../src/main/codexRolloutRecovery'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
async function main(){
const binary=process.env.CML_TEST_CODEX_BINARY??['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex','/Applications/Codex.app/Contents/Resources/codex'].find(existsSync)
if(!binary)throw Error('Set CML_TEST_CODEX_BINARY to a Codex executable with paginated app-server support')
const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-fork-consumer-'))),originalHome=join(root,'profile'),systemHome=join(root,'system'),cwd=join(root,'project')
let home=originalHome
for(const p of [home,systemHome,cwd])mkdirSync(p)
const server=createServer(async(req,res)=>{
  for await(const c of req){}
  if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404).end();return}
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic fork response',annotations:[]}]},response={id:'resp_fixture',object:'response',model:'gpt-5.5',status:'completed',output:[item],usage:{input_tokens:5,output_tokens:4,total_tokens:9}}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map((event,sequence_number)=>'data: '+JSON.stringify({...event,sequence_number})+'\n\n').join(''))
});await new Promise(r=>server.listen(0,'127.0.0.1',r))
writeFileSync(join(home,'config.toml'),`model="gpt-5.5"\nmodel_provider="codex_local_access"\n[model_providers.codex_local_access]\nname="Synthetic"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nexperimental_bearer_token="synthetic-only"\n[analytics]\nenabled=false\n[features]\nplugins=false\nremote_models=false\n`)
let child,closed,stderr='',messages=[],pending=new Map(),sequence=0
async function start(){
  stderr='';messages=[];child=spawn(binary,['app-server','--listen','stdio://'],{cwd,env:{PATH:process.env.PATH,HOME:systemHome,CODEX_HOME:home,TMPDIR:root,HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1',NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']})
  closed=new Promise(r=>child.once('close',r));let buf='';child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-10000));child.stdout.on('data',b=>{buf+=b;for(;;){const i=buf.indexOf('\n');if(i<0)break;let value;try{value=JSON.parse(buf.slice(0,i))}catch{}buf=buf.slice(i+1);if(!value)continue;if(pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result)}else messages.push(value)}})
  await rpc('initialize',{clientInfo:{name:'aml_synthetic_fork',version:'0.1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timed out '+method))},25000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
async function stop(){if(!child)return;child.stdin.end();child.kill('SIGTERM');await closed;child=undefined}
const timer=setTimeout(()=>{child?.kill('SIGKILL')},120000)
try{
  await start();const {thread}=await rpc('thread/start',{cwd,model:'gpt-5.5',historyMode:'paginated',approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Answer the synthetic fixture without tools.',developerInstructions:'Synthetic local test.',config:{mcp_servers:{},'features.plugins':false}})
  console.log('thread started',thread.id)
  await rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:'Return a fixed synthetic response.'}]})
  const until=Date.now()+20000;while(!messages.some(m=>m.method==='turn/completed')){if(Date.now()>until)throw Error('turn timeout');await new Promise(r=>setTimeout(r,50))}
  console.log('turn finished',messages.filter(m=>m.method==='turn/completed').map(m=>m.params.turn.status))
  await stop()
  const db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true}),row=db.prepare('SELECT id,rollout_path,history_mode FROM threads WHERE id=?').get(thread.id);db.close();assert.equal(row.history_mode,'paginated');console.log('stored',row.history_mode)
  await start();const fork=await rpc('thread/fork',{threadId:thread.id,excludeTurns:true});assert.ok(fork.thread?.id);console.log('valid fork',true);await stop()
  const text=readFileSync(row.rollout_path,'utf8'),first=text.indexOf('\n'),meta=JSON.parse(text.slice(0,first));meta.payload.model_provider='cml_instance';const changed=JSON.stringify(meta)+text.slice(first);writeFileSync(row.rollout_path,changed)
  console.log('shrink bytes',Buffer.byteLength(text)-Buffer.byteLength(changed))
  await start();try{await rpc('thread/fork',{threadId:thread.id,excludeTurns:true});assert.fail('fork unexpectedly succeeded')}catch(e){assert.match(e.message,/durable rollout shrank before projection/);console.log('broken fork',e.message)}await stop()
  const originalFile=join(root,'original','sessions',row.rollout_path.split('/').at(-1));mkdirSync(join(root,'original','sessions'),{recursive:true});writeFileSync(originalFile,text)
  const recovery=await prepareRolloutProviderRecovery(originalFile,row.rollout_path)
  await applyRolloutProviderRecovery(recovery)
  await start();const repaired=await rpc('thread/fork',{threadId:thread.id,excludeTurns:true});assert.ok(repaired.thread?.id);console.log('repaired fork',true);await stop()

  const config=readFileSync(join(originalHome,'config.toml'),'utf8')
  for(const compressed of [false,true]){
    if(compressed){writeFileSync(row.rollout_path+'.zst',zstdCompressSync(Buffer.from(text)));rmSync(row.rollout_path)}
    const target=join(root,compressed?'copied-compressed':'copied'),signal=new AbortController().signal
    const manifest=await scanSessionHome(originalHome,signal)
    const saved=await copySavedInstanceHome(manifest,target,signal,()=>{})
    assert.equal(saved.omittedSessions,0)
    await relocateCopiedProfile(saved,target,target,signal,'cml_instance')
    writeFileSync(join(target,'config.toml'),config.replaceAll('codex_local_access','cml_instance'))
    home=target
    await start()
    const list=await rpc('thread/list',{modelProviders:['cml_instance'],limit:100,useStateDbOnly:true,sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown']})
    assert.ok(list.data.some(item=>item.id===thread.id),'Copied thread remains visible under its destination provider')
    const copiedFork=await rpc('thread/fork',{threadId:thread.id,excludeTurns:true})
    assert.ok(copiedFork.thread?.id);console.log(compressed?'compressed copied fork':'copied fork',true)
    await stop()
  }
}catch(e){console.error(e.message);console.error(stderr.slice(-1500));process.exitCode=1}
finally{clearTimeout(timer);await stop();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
}
void main().catch(error=>{console.error(error.message);process.exitCode=1})
