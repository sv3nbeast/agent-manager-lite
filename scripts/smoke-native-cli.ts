// Optional native consumer integration. Only temporary file-mode profiles, fake
// API credentials and loopback HTTP are used. No installed client is modified.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MacCliRuntime} from '../src/main/cliInstanceRuntime'
import {resolveCliRuntime} from '../src/main/cliResolver'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {ClientSwitches} from '../src/main/clientSwitch'
import {TokenAuthority} from '../src/main/tokens'
import {createAPIAccount,importParsedAccounts} from '../src/main/accounts'

async function main(){
const selected=process.env.CML_TEST_CODEX_BINARY
assert.ok(selected&&isAbsolute(selected)&&existsSync(selected),'Set CML_TEST_CODEX_BINARY to a native Codex CLI binary or supported npm entry')
const resolved=resolveCliRuntime(selected)
const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-native-consumer-'))),client=join(root,'client'),workspace=join(root,'workspace')
mkdirSync(client);mkdirSync(workspace)
const seen:{path:string;key:string|undefined;tier:unknown;model:unknown}[]=[]
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.endsWith('/responses')){res.writeHead(404).end();return}
  await new Promise(resolve=>setTimeout(resolve,300)) // Keep the process observable during launch.
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(chunks).toString())
  seen.push({path:req.url,key:req.headers.authorization,tier:body.service_tier,model:body.model})
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture-ok',annotations:[]}]}
  const response={id:'resp_fixture',object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}
  const events=[
    {type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'fixture-ok'},
    {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'fixture-ok'},
    {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response}
  ]
  res.writeHead(200,{'Content-Type':'text/event-stream'})
  res.end(events.map((event,sequence_number)=>'data: '+JSON.stringify({...event,sequence_number})+'\n\n').join(''))
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const address=server.address();assert.ok(address&&typeof address==='object')
const store=new Store(join(root,'vault'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),configs=new ClientConfigs(store),target=configs.register(client)
const tokens=new TokenAuthority(store,async()=>assert.fail('This API fixture cannot use OAuth'))
const switches=new ClientSwitches(store,configs,tokens)
const children=new Set<ReturnType<typeof spawn>>()
async function run(extra:string[]=[]){
  // CODEX_HOME has its documented meaning for this child only. Never inherit
  // API keys, gateway overrides or plugin settings from the host environment.
  const launcher=join(root,'launcher-'+randomUUID());mkdirSync(launcher)
  let child:ReturnType<typeof spawn>|undefined,output='',done:Promise<number|null>|undefined,timer:ReturnType<typeof setTimeout>|undefined
  const runtime=new MacCliRuntime(async script=>{
    child=spawn('/bin/bash',[script],{cwd:workspace,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe']})
    children.add(child)
    child.stdout!.on('data',data=>{output+=data.toString().slice(0,20000-output.length)});child.stderr!.on('data',data=>{output+=data.toString().slice(0,20000-output.length)})
    timer=setTimeout(()=>child!.kill('SIGKILL'),20000)
    done=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('close',resolve)})
  })
  const plan={application:selected!,...resolved,directory:client,desktopDirectory:launcher,workingDirectory:workspace,nonce:randomUUID(),mode:'cli' as const,
    args:['exec','--json','--ephemeral','--ignore-rules','--skip-git-repo-check','--sandbox','read-only',...extra,'Reply with fixture-ok. Do not use tools.']}
  try{
    const active=await runtime.launch(plan,new AbortController().signal)
    assert.equal(active.pid,child!.pid)
    const code=await done;assert.equal(code,0,output);assert.ok(output.includes('fixture-ok'),output)
    assert.equal(await runtime.find(plan),undefined)
  }catch(error){console.error('Isolated fixture CLI output:',output);throw error}
  finally{if(timer)clearTimeout(timer);await runtime.stop(plan);if(child)children.delete(child)}
}
try{
  writeFileSync(join(client,'config.toml'),'cli_auth_credentials_store="file"\nmodel="gpt-5.5"\nweb_search="disabled"\n[analytics]\nenabled=false\n')
  const first=createAPIAccount({name:'Native first',apiKey:'fixture-first-key',baseUrl:`http://127.0.0.1:${address.port}/first/v1`,models:['gpt-5.5'],wireApi:'responses',defaultTier:'fast',tags:[],note:''})
  const second=createAPIAccount({name:'Native second',apiKey:'fixture-second-key',models:['gpt-5.5'],wireApi:'responses',tags:[],note:'',baseUrl:`http://127.0.0.1:${address.port}/second/v1`,defaultTier:'standard'})
  // createAPIAccount validates the public input; do not pass stored fields.
  importParsedAccounts(store,[first,second])
  await switches.applyWhenClosed({ticket:switches.preview({targetId:target.id,accountId:first.id}).ticket,clientClosed:true})
  await run();await run(['-c','service_tier="default"']);await run(['-c','service_tier="flex"']);await run(['-c','service_tier="auto"'])
  await switches.applyWhenClosed({ticket:switches.preview({targetId:target.id,accountId:second.id}).ticket,clientClosed:true})
  await run()
  // Observe the actual native consumer: only Fast emits a tier in this build.
  // Explicit non-Fast JSON preservation is verified separately at our gateway.
  assert.deepEqual(seen,[
    {path:'/first/v1/responses',key:'Bearer fixture-first-key',tier:'priority',model:'gpt-5.5'},
    {path:'/first/v1/responses',key:'Bearer fixture-first-key',tier:undefined,model:'gpt-5.5'},
    {path:'/first/v1/responses',key:'Bearer fixture-first-key',tier:undefined,model:'gpt-5.5'},
    {path:'/first/v1/responses',key:'Bearer fixture-first-key',tier:undefined,model:'gpt-5.5'},
    {path:'/second/v1/responses',key:'Bearer fixture-second-key',tier:undefined,model:'gpt-5.5'}
  ])
  console.log('Native Codex CLI passed: generated terminal command, verified native PID, file config, real SSE reply, API endpoint/key switch, Fast=priority; native Standard/flex/auto omit the field in this CLI build, so non-Fast propagation is not claimed; only loopback fixture upstream.')
}finally{
  for(const child of children)child.kill('SIGKILL')
  await tokens.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
  rmSync(root,{recursive:true,force:true})
}

}
void main().catch(error=>{console.error(error);process.exitCode=1})
