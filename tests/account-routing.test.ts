import test from 'node:test'
import assert from 'node:assert/strict'
import {createAPIAccount} from '../src/main/accounts'
import {planRank,routingAccountState,subscriptionExpiryMs} from '../src/main/accountRouting'
import {parseQuota} from '../src/main/quota'

const fixture=()=>createAPIAccount({name:'Fixture',apiKey:'fixture-key',baseUrl:'http://127.0.0.1:9',models:['fixture-model'],wireApi:'responses',defaultTier:'follow',note:'',tags:[]})
test('routing observations retain unknown values and distinguish subscription expiry from token expiry',()=>{
  const account=fixture()
  assert.equal(planRank(account),undefined)
  assert.equal(routingAccountState(account).remainingQuota,undefined)
  assert.equal(subscriptionExpiryMs(account),undefined)
  account.plan='pro';account.source={auth_file_plan_type:'pro_max',subscription_active_until:'2030-10-01T00:00:00Z'}
  assert.equal(planRank(account),600)
  assert.equal(subscriptionExpiryMs(account),Date.parse('2030-10-01T00:00:00Z'))
  account.credentials.idToken='header.'+Buffer.from(JSON.stringify({exp:100,'https://api.openai.com/auth':{chatgpt_subscription_active_until:2_000_000_000}})).toString('base64url')+'.fixture'
  assert.equal(subscriptionExpiryMs(account),2_000_000_000_000,'Current identity takes precedence over imported metadata')
  delete account.credentials.idToken
  account.source.subscription_active_until='not a date with fixture-key'
  assert.equal(subscriptionExpiryMs(account),undefined)
  account.source.subscription_active_until=Infinity
  assert.equal(subscriptionExpiryMs(account),undefined)
})
test('cooldowns use observed main windows, release at reset, and retain an unknown exhausted window',()=>{
  const account=fixture(),now=2_000_000_000_000
  account.kind='oauth'
  account.quota={updatedAt:now-100,allowed:false,limitReached:true,windows:[{id:'main.primary_window',name:'短周期',usedPercent:100,allowed:false,limitReached:true,resetsAt:now+1000},{id:'main.secondary_window',name:'周周期',usedPercent:20,resetsAt:now+2000},{id:'review.primary_window',name:'审查',usedPercent:100}]}
  let state=routingAccountState(account,now)
  assert.equal(state.remainingQuota,0);assert.equal(state.cooldown?.resetAtMs,now+1000);assert.equal(state.cooldown?.exhausted,true)
  state=routingAccountState(account,now+1100)
  assert.equal(state.cooldown?.exhausted,false,'Expired reset must not permanently exhaust an account')
  account.quota.windows[1].usedPercent=100;delete account.quota.windows[1].resetsAt
  state=routingAccountState(account,now)
  assert.equal(state.cooldown?.exhausted,true);assert.equal(state.cooldown?.resetAtMs,undefined)
  account.quota={updatedAt:now,allowed:false,windows:[]}
  assert.equal(routingAccountState(account,now).cooldown?.exhausted,true)
  account.quota={updatedAt:now,windows:[{id:'review.primary_window',name:'审查',usedPercent:100}]}
  assert.equal(routingAccountState(account,now).remainingQuota,undefined)
  assert.equal(routingAccountState(account,now).cooldown,undefined)
})

test('real quota shape does not extend cooldown to a healthy week or block usable credits',()=>{
  const account=fixture(),now=2_000_000_000_000
  account.kind='oauth'
  const raw={rate_limit:{allowed:false,limit_reached:true,primary_window:{used_percent:100,reset_after_seconds:60},secondary_window:{used_percent:20,reset_after_seconds:86400}}}
  account.quota=parseQuota(raw,now).quota
  assert.equal(routingAccountState(account,now).cooldown?.resetAtMs,now+60000)
  assert.equal(routingAccountState(account,now+60001).cooldown?.exhausted,false)
  for(const credits of [{credits:{balance:'12.5'}},{credits:{unlimited:true}},{spend_control:{individual_limit:{remaining_percent:5}}},{SPEND_CONTROL:{INDIVIDUAL_LIMIT:{limit:'100',used:'99'}}}]){
    account.quota=parseQuota({...raw,...credits},now).quota
    assert.equal(routingAccountState(account,now).cooldown?.exhausted,false)
  }
  for(const credits of [{credits:{balance:'NaN'}},{credits:{balance:0}},{credits:{unlimited:'false'}},{spend_control:{individual_limit:{limit:100,used:100}}}]){
    account.quota=parseQuota({...raw,...credits},now).quota
    assert.equal(routingAccountState(account,now).cooldown?.exhausted,true)
  }
  account.quota=parseQuota({rate_limit:{primary_window:{used_percent:99.6}}},now).quota
  assert.equal(routingAccountState(account,now).cooldown?.exhausted,false,'Rounding for display must not exhaust fractional quota')
  account.quota=parseQuota({},now).quota
  assert.equal(routingAccountState(account,now).cooldown,undefined,'Unknown quota must not declare recovery')
})
