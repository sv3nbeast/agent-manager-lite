import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {History} from '../src/main/history'

test('built sidecar records delivered completion as success and midstream close as canceled in real history',{timeout:25000},async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-history-wire-'))),model='fixture-history'
 const history=new History(root),events:Record<string,any>[]=[]
 let mode='clean'
 const upstream=createServer(async(req,res)=>{
  for await(const _chunk of req){}
  res.writeHead(200,{'content-type':'text/event-stream'})
  if(mode==='partial'){res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')}
  else res.write('data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}\n\n')
  if(mode==='clean'){res.end();return}
  const timeout=setTimeout(()=>res.end(),5000)
  res.once('close',()=>clearTimeout(timeout))
 })
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
 const address=upstream.address();assert.ok(address&&typeof address==='object')
 mkdirSync(join(root,'auth'),{mode:0o700})
 writeFileSync(join(root,'config.json'),JSON.stringify({host:'127.0.0.1',port:0,'auth-dir':join(root,'auth'),'api-keys':['fixture-client'],'request-log':false,'logging-to-file':false}),{mode:0o600})
 writeFileSync(join(root,'manifest.json'),JSON.stringify({accounts:[],modelIds:[model],debugLogs:false,apiKeys:[{id:'fixture-key',key:'fixture-client',enabled:true,providerGateway:{baseUrl:'http://127.0.0.1:'+address.port,apiKey:'fixture-upstream',wireApi:'responses',upstreamModel:model,upstreamModels:[model]}}]}),{mode:0o600})
 const child=spawn(resolve('resources/bin/codex-proxy'),['-config',join(root,'config.json'),'-manifest',join(root,'manifest.json'),'-parent-pid',String(process.pid)],{cwd:root,env:{PATH:process.env.PATH,HOME:root},stdio:['ignore','pipe','pipe']})
 const exit=new Promise<void>(resolve=>child.once('close',()=>resolve()))
 child.stderr.resume()
 let port=0,spawnError:Error|undefined
 child.once('error',error=>{spawnError=error})
 const lines=createInterface({input:child.stdout})
 lines.on('line',line=>{try{const e=JSON.parse(line);if(e.type==='ready')port=e.port;if(e.type==='usage'){events.push(e);history.record('fixture',e)}}catch{}})
 const wait=async(fn:()=>boolean)=>{const end=Date.now()+8000;while(!fn()){if(spawnError)throw spawnError;if(Date.now()>end)throw Error('history wire fixture timed out');await delay(10)}}
 try{
  await wait(()=>port>0)
  for(const current of ['clean','completed_then_close','partial']){
   mode=current;const before=events.length
   await new Promise<void>((resolve,reject)=>{
    let received=''
    const req=request({hostname:'127.0.0.1',port,path:'/v1/responses',method:'POST',headers:{authorization:'Bearer fixture-client','content-type':'application/json'}},res=>{
     assert.equal(res.statusCode,200)
     res.on('data',chunk=>{received+=chunk;if(current!=='clean'&&received.includes('\n\n')){res.destroy();req.destroy();resolve()}})
     res.on('end',resolve);res.on('error',err=>received?resolve():reject(err))
    })
    req.on('error',err=>received?resolve():reject(err));req.setTimeout(8000,()=>req.destroy(Error('request timeout')))
    req.end(JSON.stringify({model,input:'synthetic',stream:true}))
   })
   await wait(()=>events.length>before)
   const e=events[before],success=current!=='partial'
   assert.equal(e.success,success,JSON.stringify({current,status:e.status,errorCategory:e.errorCategory}))
   assert.equal(e.errorCategory,success?undefined:'client_canceled')
   const page=history.query({filter:{search:e.requestId,outcome:'all'},page:1,pageSize:25})
   assert.equal(page.total,1);assert.equal(page.entries[0].success,success)
   assert.equal(page.entries[0].errorCategory,success?'':'client_canceled')
   if(success){assert.equal(page.entries[0].inputTokens,10);assert.equal(page.entries[0].outputTokens,3)}
  }
  assert.equal(history.query({filter:{search:'',outcome:'canceled'},page:1,pageSize:25}).total,1)
 }finally{
  lines.close()
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),1000);await exit;clearTimeout(kill)}
  upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()))
  history.close();rmSync(root,{recursive:true,force:true})
 }
})
