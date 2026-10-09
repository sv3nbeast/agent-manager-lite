// Installed Codex consumer check with invented credentials and disposable file
// profiles. macOS sandbox permits only the fixture server; no real login occurs.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {existsSync,mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createInterface} from 'node:readline'
import {parseAccountImport} from '../src/main/accounts'
import {authFor,nativeConfig} from '../src/main/nativeAccountProjection'
import {codexBundledCli} from '../src/main/codexPrograms'
import {resolveCliRuntime} from '../src/main/cliResolver'
import {settingsSchema} from '../src/shared/types'

async function main(){
  assert.equal(process.platform,'darwin','This identity smoke requires macOS sandbox-exec to block non-fixture network access')
  const binary=process.env.CML_TEST_CODEX_BINARY?resolveCliRuntime(process.env.CML_TEST_CODEX_BINARY).executable:
    codexBundledCli(['/Applications/ChatGPT.app','/Applications/Codex.app'].find(existsSync)??'/Applications/Codex.app')
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-native-identity-')))
  const accountId='cml-synthetic-account',email='identity-fixture@example.invalid'
  const claims={sub:'cml-synthetic-user',email,exp:Math.floor(Date.now()/1000)+86400,
    'https://api.openai.com/auth':{chatgpt_account_id:accountId,chatgpt_user_id:'cml-synthetic-user',chatgpt_plan_type:'plus'}}
  const jwt=[{alg:'none'},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')+'.fixture'
  const source={auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:jwt,id_token:jwt,refresh_token:'synthetic-refresh-token',account_id:accountId},last_refresh:'2020-01-01T00:00:00Z'}
  const account=parseAccountImport(JSON.stringify(source)).accounts[0]
  const state={version:1 as const,settings:settingsSchema.parse({}),accounts:[account],groups:[]}
  const paths:string[]=[]
  const server=createServer((request,response)=>{
    paths.push(request.url??'')
    response.writeHead(200,{'Content-Type':'application/json'})
    // The protocol requires an HTTPS origin in routing metadata. This is only
    // a declared fixture origin; sandbox-exec denies every external connection.
    response.end(JSON.stringify({accounts:[{id:accountId,workspace_backend_origin:'https://chatgpt.com',account_routing_override:'NO_CONSTRAINT'}],plugins:[],enabled:false}))
  })
  const children=new Set<ReturnType<typeof spawn>>()
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();assert.ok(address&&typeof address==='object')
    const base=`cli_auth_credentials_store="file"\nchatgpt_base_url="http://127.0.0.1:${address.port}/backend-api"\n[analytics]\nenabled=false\n[features]\nplugins=false\nremote_models=false\n`
    const native=nativeConfig(base,account,state,[]).config
    async function run(label:string,auth:string,config:string){
      const home=join(root,label);mkdirSync(home)
      writeFileSync(join(home,'auth.json'),auth,{mode:0o600});writeFileSync(join(home,'config.toml'),config,{mode:0o600})
      const profile=`(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${address.port}"))`
      const child=spawn('/usr/bin/sandbox-exec',['-p',profile,binary,'app-server','--stdio'],{
        cwd:home,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CODEX_HOME:home,TMPDIR:home,LANG:'en_US.UTF-8',RUST_LOG:'off'},stdio:['pipe','pipe','pipe']})
      children.add(child);child.stderr.resume()
      const lines=createInterface({input:child.stdout}),pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
      let id=0
      const fail=(error:Error)=>{for(const entry of pending.values())entry.reject(error);pending.clear()}
      const closed=new Promise<void>(resolve=>child.once('close',()=>{fail(new Error('Synthetic app-server exited'));resolve()}))
      child.on('error',fail);child.stdin.on('error',fail)
      lines.on('line',line=>{try{const event=JSON.parse(line),entry=pending.get(event.id);if(entry){pending.delete(event.id);event.error?entry.reject(new Error(event.error.message)):entry.resolve(event.result)}}catch{fail(new Error('Invalid fixture RPC response'))}})
      const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({id:next,method,params})+'\n')})
      const timer=setTimeout(()=>{fail(new Error('Synthetic identity check timed out'));child.kill('SIGKILL')},15000)
      try{
        await request('initialize',{clientInfo:{name:'cml-native-identity-smoke',version:'0.1.0'}})
        child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
        const authStatus=await request('getAuthStatus',{includeToken:false,refreshToken:false})
        const identity=label==='missing-timestamp'?null:await request('account/read',{refreshToken:false})
        return {authStatus,identity}
      }finally{
        clearTimeout(timer);child.stdin.end();child.kill('SIGTERM')
        const kill=setTimeout(()=>child.kill('SIGKILL'),1000)
        await closed;clearTimeout(kill);lines.close();children.delete(child)
      }
    }
    const missing=structuredClone(source) as Partial<typeof source>;delete missing.last_refresh
    const control=await run('missing-timestamp',JSON.stringify(missing),native)
    assert.equal(control.authStatus.authMethod,null)
    const projected=authFor(account,null)
    assert.equal(JSON.parse(projected).last_refresh,new Date(source.last_refresh).toISOString())
    const recognized=await run('projected-native',projected,native)
    assert.equal(recognized.authStatus.authMethod,'chatgpt')
    assert.equal(recognized.identity.account.type,'chatgpt');assert.equal(recognized.identity.account.email,email)
    assert.equal(recognized.identity.account.planType,'plus');assert.equal(recognized.identity.requiresOpenaiAuth,true)
    const legacy=parseAccountImport(JSON.stringify(missing)).accounts[0],legacyAuth=authFor(legacy,null)
    assert.equal(JSON.parse(legacyAuth).last_refresh,'1970-01-01T00:00:00.000Z')
    const legacyResult=await run('legacy-native',legacyAuth,native)
    assert.equal(legacyResult.authStatus.authMethod,'chatgpt');assert.equal(legacyResult.identity.account.type,'chatgpt')
    const api=`model_provider="cml_instance"\nforced_login_method="api"\n${base}\n[model_providers.cml_instance]\nname="ChatGPT"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nexperimental_bearer_token="synthetic-gateway-key"\n`
    const local=await run('local-api',projected,api)
    assert.equal(local.authStatus.authMethod,null);assert.equal(local.identity.account,null);assert.equal(local.identity.requiresOpenaiAuth,false)
    assert.ok(paths.includes('/backend-api/wham/accounts/check'))
    console.log('Installed Codex identity passed: missing timestamp control, projected ChatGPT email/plan, conservative legacy timestamp, and anonymous local API mode; synthetic credentials, disposable homes, fixture-only network.')
  }finally{
    for(const child of children)child.kill('SIGKILL')
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
    rmSync(root,{recursive:true,force:true})
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1})
