import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer, type ServerResponse} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {createAPIAccount,editAccount} from '../src/main/accounts'
import {Store} from '../src/main/store'
import {TokenAuthority} from '../src/main/tokens'
import {QuotaService} from '../src/main/quota'
import {createJSONRequest,HTTPError} from '../src/main/network'
import {parseDeepSeekUsage,parseMiniMaxUsage,parseZhipuUsage,ProviderUsageUnavailable,queryProviderUsage} from '../src/main/providerUsage'
import {exportBackupState,validateBackup} from '../src/main/dataBackupState'

const account=(baseUrl:string)=>createAPIAccount({name:'Official fixture',baseUrl,apiKey:'fixture-plan-secret',models:['fixture'],wireApi:'responses',defaultTier:'inherit',note:'',tags:[]})
const minimax={base_resp:{status_code:0},model_remains:[{model_name:'MiniMax-M2.7',current_interval_total_count:200,current_interval_usage_count:150,current_weekly_total_count:1000,current_weekly_usage_count:0,end_time:1791000000000,weekly_end_time:'1791600000'}]}
const zhipu={success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',usage:100,currentValue:25,nextResetTime:1791600000000},{type:'TOKENS_LIMIT',percentage:100,nextResetTime:'2026-10-02T12:00:00Z'},{type:'TIME_LIMIT',percentage:0}],level:'Pro'}}
const deepseek={is_available:true,balance_infos:[{currency:'USD',total_balance:'5.25'},{currency:'CNY',total_balance:'12.50',granted_balance:'2.5',topped_up_balance:'10'}]}

test('DeepSeek selects CNY without adding currencies; zero, debt and unknown are distinct',()=>{
  assert.deepEqual(parseDeepSeekUsage(deepseek,123),{source:'deepseek',updatedAt:123,unit:'CNY',remaining:12.5,balance:12.5,grantedBalance:2.5,toppedUpBalance:10,isValid:true})
  const zero=parseDeepSeekUsage({is_available:false,balance_infos:[{currency:'USD',total_balance:'0'}]})
  assert.equal(zero.remaining,0);assert.equal(zero.isValid,false);assert.equal(zero.grantedBalance,undefined)
  assert.equal(parseDeepSeekUsage({balance_infos:[{currency:'USD',total_balance:'-1'}]}).remaining,-1)
  const unknown=parseDeepSeekUsage({is_available:false})
  assert.equal(unknown.remaining,undefined);assert.equal(unknown.unit,undefined)
  assert.throws(()=>parseDeepSeekUsage({balance_infos:[{currency:'USD',total_balance:'Infinity'}]}),ProviderUsageUnavailable)
  assert.throws(()=>parseDeepSeekUsage({ok:true}),ProviderUsageUnavailable)
})

test('MiniMax retains both windows and exhaustion instead of reporting only the first',()=>{
  const value=parseMiniMaxUsage(minimax,123)
  assert.equal(value.source,'minimax');assert.equal(value.remaining,0);assert.equal(value.isValid,false);assert.equal(value.unit,'%')
  assert.deepEqual(value.windows,[
    {id:'interval',name:'周期额度',limit:200,remaining:150,remainingPercent:75,resetsAt:1791000000000},
    {id:'weekly',name:'周额度',limit:1000,remaining:0,remainingPercent:0,resetsAt:1791600000000}
  ])
  assert.equal(value.modelName,'MiniMax-M2.7')
  const camel=parseMiniMaxUsage({data:{planName:'Pro',model_remains:[{modelName:'other',remainingPercent:1},{modelName:'MiniMax-M-fixture',currentIntervalTotalCount:'100',currentIntervalUsageCount:'20',weeklyRemainingPercent:90,endTime:'2026-10-02T20:00:00+08:00'}]}})
  assert.equal(camel.remaining,20);assert.equal(camel.planName,'Pro');assert.equal(camel.windows?.[0].resetsAt,Date.parse('2026-10-02T12:00:00Z'))
  assert.equal(parseMiniMaxUsage({current_weekly_remaining_percent:150}).remaining,100)
  assert.equal(parseMiniMaxUsage({remaining_percent:-3}).remaining,0)
  assert.throws(()=>parseMiniMaxUsage({current_interval_total_count:0,current_interval_usage_count:0}),ProviderUsageUnavailable)
  assert.throws(()=>parseMiniMaxUsage({model_remains:[]}),ProviderUsageUnavailable)
})

test('Zhipu sorts token windows by reset without inventing duration or money',()=>{
  const value=parseZhipuUsage(zhipu,123)
  assert.equal(value.remaining,0);assert.equal(value.isValid,false);assert.equal(value.unit,'%');assert.equal(value.planName,'Pro')
  assert.equal(value.windows?.length,2)
  assert.equal(value.windows?.[0].remainingPercent,0);assert.equal(value.windows?.[1].remainingPercent,75)
  assert.equal(value.windows?.[0].name,'额度窗口 1');assert.equal(value.windows?.[0].limit,undefined)
  const alias=parseZhipuUsage({limits:[{type:'tokens_limit',total:'100',used:'20',remain:'80',next_reset_time:'1791000000'}]})
  assert.equal(alias.remaining,80);assert.equal(alias.windows?.[0].remaining,80)
  for(const invalid of [undefined,[],[{type:'TIME_LIMIT',percentage:1}],[{type:'TOKENS_LIMIT',remaining:10}],[{type:'TOKENS_LIMIT',usage:0,currentValue:0}]])assert.throws(()=>parseZhipuUsage({limits:invalid}),ProviderUsageUnavailable)
})

test('bad timestamps, non-finite values, excessive windows and explicit API errors are rejected or unknown',()=>{
  for(const raw of [0,-1,'','no date','2026-10-02 12:00:00','2026-02-31T12:00:00Z',Infinity,1e30])assert.equal(parseMiniMaxUsage({remaining_percent:20,end_time:raw}).windows?.[0].resetsAt,undefined)
  assert.throws(()=>parseMiniMaxUsage({remaining_percent:'Infinity'}),ProviderUsageUnavailable)
  assert.throws(()=>parseZhipuUsage({limits:Array.from({length:101},()=>({type:'TOKENS_LIMIT',percentage:20}))}),ProviderUsageUnavailable)
  for(const parse of [parseDeepSeekUsage,parseMiniMaxUsage,parseZhipuUsage]){
    for(const error of [{success:false},{code:401},{base_resp:{status_code:1004}},{error:{message:'fixture-plan-secret'}}])assert.throws(()=>parse({...deepseek,...minimax,...zhipu,...error}),error=>!String(error).includes('fixture-plan-secret')&&String(error).includes('拒绝'))
  }
})

test('official URL detection preserves origin/port, exact host boundaries and source authentication',async()=>{
  for(const [base,path,rawAuth,body] of [
    ['https://api.deepseek.com/v1','/user/balance',false,deepseek],
    ...['api.minimaxi.com','www.minimaxi.com','api.minimax.io','www.minimax.io'].map(host=>[`https://${host}/v1`,'/v1/token_plan/remains',false,minimax]),
    ...['open.bigmodel.cn','bigmodel.cn','api.z.ai','z.ai'].map(host=>[`https://${host}:8443/api/paas/v4`,'/api/monitor/usage/quota/limit',true,zhipu])
  ] as const){
    const called:string[]=[]
    await queryProviderUsage(account(String(base)),new AbortController().signal,async(url,init)=>{
      called.push(url);assert.equal(new URL(url).origin,new URL(String(base)).origin);assert.equal(new URL(url).pathname,path)
      assert.equal(new Headers(init?.headers).get('Authorization'),rawAuth?'fixture-plan-secret':'Bearer fixture-plan-secret')
      return body as Record<string,unknown>
    })
    assert.equal(called.length,1)
  }
  for(const base of ['https://api.deepseek.com.attacker.invalid/v1','https://mirror.invalid/minimax','http://api.deepseek.com/v1','https://other.api.z.ai/v1']){
    const called:string[]=[]
    await assert.rejects(queryProviderUsage(account(base),new AbortController().signal,async url=>{called.push(new URL(url).pathname);throw new HTTPError(404,'fixture')}),ProviderUsageUnavailable)
    assert.ok(called.every(path=>!path.includes('token_plan')&&!path.includes('/user/balance')&&!path.includes('/monitor/usage')))
  }
})

test('MiniMax endpoint fallback is limited to 404 or recognized missing fields, never API denials',async()=>{
  for(const absent of ['404','shape']){
    const called:string[]=[]
    const value=await queryProviderUsage(account('https://api.minimax.io/v1'),new AbortController().signal,async url=>{
      called.push(new URL(url).pathname)
      if(called.length===1){if(absent==='404')throw new HTTPError(404,'fixture');return {success:true}}
      return minimax
    })
    assert.equal(value.remaining,0);assert.deepEqual(called,['/v1/token_plan/remains','/v1/api/openplatform/coding_plan/remains'])
  }
  for(const error of [401,403,405,429,500,'body']){
    let count=0
    await assert.rejects(queryProviderUsage(account('https://api.minimax.io/v1'),new AbortController().signal,async()=>{count++;if(error==='body')return {...minimax,base_resp:{status_code:1004}};throw new HTTPError(error as number,'fixture')}),error==='body'?/服务商拒绝/:/HTTP/)
    assert.equal(count,1)
  }
  const secret=await queryProviderUsage(account('https://api.minimax.io/v1'),new AbortController().signal,async()=>({remaining_percent:20,plan_name:'fixture-plan-secret',model_name:'fixture-plan-secret'}))
  assert.equal(secret.planName,undefined);assert.equal(secret.modelName,undefined)
})

test('real HTTP refresh persists all three summaries and portable backups; failed and cancelled requests retain them',async t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-provider-plans-')),codec={encrypt:(s:string)=>Buffer.from(s),decrypt:(b:Buffer)=>b.toString()}
  let mode='ok',pending:ServerResponse|undefined
  const seen:string[]=[]
  const upstream=createServer((req,res)=>{
    seen.push(req.url!)
    if(mode==='hold'){pending=res;return}
    if(mode==='fail'){res.writeHead(429).end('fixture-plan-secret');return}
    const body=req.url==='/user/balance'?deepseek:req.url?.includes('token_plan')?minimax:zhipu
    assert.equal(req.headers.authorization,body===zhipu?'fixture-plan-secret':'Bearer fixture-plan-secret')
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const address=upstream.address();assert.ok(address&&typeof address==='object')
  const request=createJSONRequest((url,init)=>fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`,init))
  const store=new Store(root,codec),accounts=['https://api.deepseek.com','https://api.minimax.io/v1','https://api.z.ai/api/coding/paas/v4'].map(account)
  store.transaction(state=>{state.accounts=accounts;state.settings.refreshMinutes=0})
  const tokens=new TokenAuthority(store,async()=>assert.fail('No OAuth refresh for API accounts'))
  const service=new QuotaService(store,tokens,request,undefined,()=>assert.fail('Provider plan must not change OAuth scheduling'))
  t.after(async()=>{await service.stop();await tokens.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(root,{recursive:true,force:true})})
  service.start(accounts.map(a=>a.id));await service.settled()
  assert.equal(service.current().failed,0);assert.equal(seen.length,3)
  const snapshot=new Store(root,codec).snapshot()
  assert.deepEqual(snapshot.accounts.map(a=>a.providerUsage?.summary?.source),['deepseek','minimax','zhipu'])
  assert.equal(snapshot.accounts.some(a=>a.quota!==undefined),false);assert.equal(JSON.stringify(snapshot).includes('fixture-plan-secret'),false)
  const portable=validateBackup(JSON.parse(JSON.stringify(exportBackupState(store.read(),{}))))
  assert.deepEqual(portable.state.accounts.map(a=>a.providerUsage),snapshot.accounts.map(a=>a.providerUsage))
  mode='fail';service.start([accounts[1].id]);await service.settled()
  assert.equal(service.current().failed,1);assert.deepEqual(JSON.parse(JSON.stringify(store.snapshot().accounts[1].providerUsage?.summary)),snapshot.accounts[1].providerUsage?.summary)
  assert.match(store.snapshot().accounts[1].providerUsage!.error!,/429/)
  const before=store.snapshot().accounts[1].providerUsage
  mode='hold';service.start([accounts[1].id])
  const deadline=Date.now()+2000;while(!pending){assert.ok(Date.now()<deadline);await delay(5)}
  service.cancel();await service.settled();pending!.end();pending=undefined
  assert.deepEqual(store.snapshot().accounts[1].providerUsage,before)
  service.start([accounts[1].id])
  const end=Date.now()+2000;while(!pending){assert.ok(Date.now()<end);await delay(5)}
  editAccount(store,{id:accounts[1].id,revision:0,changes:{apiKey:'fixture-replaced-key'}})
  pending!.end(JSON.stringify(minimax));await service.settled()
  assert.equal(store.snapshot().accounts[1].providerUsage,undefined,'old response cannot write onto new credentials')
})
