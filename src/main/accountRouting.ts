// Adapted from Cockpit codex_local_access_routing_pricing.rs and
// codex_local_access_sidecar_config.rs. These are observations, not credentials.
import type {StoredAccount} from './store'
import type {QuotaWindow} from '../shared/types'
import {tokenClaims} from './tokens'
import {object} from './network'

export function planRank(account:StoredAccount):number|undefined {
  const plan=account.plan?.trim().toLowerCase()
  if(!plan)return
  for(const [fragment,rank] of [['enterprise',700],['health',700],['gov',700],['teacher',700],['business',300],['team',300],['edu',700],['go',200],['plus',300]] as const)if(plan.includes(fragment))return rank
  if(plan.includes('pro')) {
    const hint=typeof account.source?.auth_file_plan_type==='string'?account.source.auth_file_plan_type:plan
    return ['promax','pro-max'].includes(hint.trim().toLowerCase().replace(/[ _]/g,'-'))?600:500
  }
  if(plan.includes('free'))return 100
}
export function subscriptionExpiryMs(account:StoredAccount):number|undefined {
  const candidates=[account.subscriptionActiveUntil,...([account.credentials.idToken,account.credentials.accessToken].map(token=>object(tokenClaims(token)['https://api.openai.com/auth']).chatgpt_subscription_active_until)),account.source?.subscription_active_until]
  for(const raw of candidates){
    if(typeof raw!=='string'&&typeof raw!=='number')continue
    const value=String(raw).trim()
    if(!value)continue
    let result:number
    if(/^\d+$/.test(value)){result=Number(value);if(result<1_000_000_000_000)result*=1000}
    else if(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))result=Date.parse(value)
    else continue
    if(Number.isSafeInteger(result)&&result>0&&result<=8_640_000_000_000_000)return result
  }
}
function remaining(window:QuotaWindow|undefined):number|undefined {
  return typeof window?.usedPercent==='number'&&Number.isFinite(window.usedPercent)?Math.round(Math.max(0,Math.min(100,100-window.usedPercent))):undefined
}
export function routingAccountState(account:StoredAccount,now=Date.now()) {
  const quota=account.quota,windows=quota?.windows??[]
  const primary=windows.find(window=>window.id==='main.primary_window'),secondary=windows.find(window=>window.id==='main.secondary_window')
  const known=[remaining(primary),remaining(secondary)].filter((value):value is number=>value!==undefined)
  // allowed/limitReached belong to the whole rate limit, not each window.
  // Do not extend a depleted short window to the reset of a healthy week.
  const exhausted=[primary,secondary].filter((window):window is QuotaWindow=>!!window&&typeof window.usedPercent==='number'&&Number.isFinite(window.usedPercent)&&window.usedPercent>=100&&(!window.resetsAt||window.resetsAt>now))
  const globallyExhausted=(quota?.allowed===false||quota?.limitReached===true)&&!known.length
  const unknownReset=exhausted.some(window=>!window.resetsAt)||globallyExhausted&&!exhausted.length
  const convert=(window:QuotaWindow|undefined)=>window?{present:true,remainingPercent:remaining(window),windowMinutes:window.durationSeconds?Math.round(window.durationSeconds/60):undefined,resetAt:window.resetsAt?Math.floor(window.resetsAt/1000):undefined}:undefined
  return {planType:account.plan,planRank:planRank(account),remainingQuota:known.length?Math.min(...known):undefined,subscriptionExpiryMs:subscriptionExpiryMs(account),
    primary:convert(primary),secondary:convert(secondary),updatedAt:quota?Math.floor(quota.updatedAt/1000):undefined,
    cooldown:quota&&account.kind!=='api_key'&&(known.length||quota.allowed!==undefined||quota.limitReached!==undefined||quota.hasUsableCredits)?{exhausted:!quota.hasUsableCredits&&(exhausted.length>0||globallyExhausted),resetAtMs:quota.hasUsableCredits||unknownReset?undefined:exhausted.length?Math.max(...exhausted.map(window=>window.resetsAt!)):undefined,updatedAtMs:quota.updatedAt}:undefined}
}
export type RoutingAccountState=ReturnType<typeof routingAccountState>
