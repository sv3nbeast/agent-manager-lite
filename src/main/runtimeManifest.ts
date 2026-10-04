import type { StoredAccount } from './store'
import type { DefaultTier, Settings } from '../shared/types'
import { effectiveLocalAccountIds, type StoredLocalAccess } from '../shared/localAccess'
import { resolveServiceTier } from '../shared/serviceTier'
import { builtInCatalog, defaultModelDefinitions } from './modelCatalog'
import { routingAccountState } from './accountRouting'
import type { QuotaReserveSettings } from '../shared/localAccess'

export interface RuntimeProfile {
  id:string; port:number; account:StoredAccount; apiKey:string; defaultTier?:DefaultTier; providerTier?:DefaultTier
  pool?:{settings:StoredLocalAccess;accounts:StoredAccount[];providerTiers:Record<string,DefaultTier|undefined>;tokenUsed:Record<string,number>}
}
export interface QuotaReserveRuntimeSnapshot {
  snapshotUpdatedAtUnixSeconds?:number
  hourlyRemainingPercent?:number
  weeklyRemainingPercent?:number
  hourlyWindowPresent?:boolean
  weeklyWindowPresent?:boolean
}
export interface QuotaReserveRuntimeSpec extends QuotaReserveRuntimeSnapshot {
  hourlyThresholdPercent:number
  weeklyThresholdPercent:number
}

function reserveSpec(account:StoredAccount,settings:QuotaReserveSettings|undefined,stateReturn:ReturnType<typeof routingAccountState>):QuotaReserveRuntimeSpec|undefined {
  if(account.kind!=='oauth')return
  const threshold=settings?.[account.id]
  if(!threshold || (threshold.hourlyPercent===0 && threshold.weeklyPercent===0))return
  return {hourlyThresholdPercent:threshold.hourlyPercent,weeklyThresholdPercent:threshold.weeklyPercent,
    ...(stateReturn.updatedAt===undefined?{}:{snapshotUpdatedAtUnixSeconds:stateReturn.updatedAt}),
    ...(stateReturn.primary?{hourlyRemainingPercent:stateReturn.primary.remainingPercent,hourlyWindowPresent:true}:{hourlyWindowPresent:false}),
    ...(stateReturn.secondary?{weeklyRemainingPercent:stateReturn.secondary.remainingPercent,weeklyWindowPresent:true}:{weeklyWindowPresent:false})}
}
export function runtimeManifest(profile:RuntimeProfile,settings:Settings,controlKey:string,projectedProxies:ReadonlyMap<string,string|undefined>=new Map()) {
  const accounts=profile.pool?.accounts ?? [profile.account]
  const nativeDefaults=defaultModelDefinitions().map(model=>model.modelId)
  const hiddenNative=builtInCatalog.models.filter(model=>model.visibility==='hide').map(model=>model.slug)
  const models=(account:StoredAccount)=>account.kind==='api_key'||account.models.length?account.models:nativeDefaults
  const tiers=new Map(accounts.map(account=>[account.id,resolveServiceTier(undefined,settings.defaultTier,profile.pool?.providerTiers[account.id] ?? profile.providerTier,profile.defaultTier,account.defaultTier)]))
  const quotaReserve=new Map<string,QuotaReserveRuntimeSpec>()
  for(const account of accounts){const spec=reserveSpec(account,profile.pool?.settings.quotaReserve,routingAccountState(account));if(spec)quotaReserve.set(account.id,spec)}
  const spec=(account:StoredAccount)=>{
    const observed=routingAccountState(account)
    return {id:account.id,email:account.email??account.name,authKind:account.kind,planType:account.plan,planRank:observed.planRank,chatgptAccountId:account.credentials.accountId,
      remainingQuota:observed.remainingQuota,subscriptionExpiryMs:observed.subscriptionExpiryMs,quotaCooldown:observed.cooldown,
      ...(quotaReserve.has(account.id)?{quotaReserve:quotaReserve.get(account.id)}:{}),
      accessTokenOnly:account.kind==='oauth' && !account.credentials.idToken && !account.credentials.refreshToken,
      ...(account.kind==='api_key'?{upstreamApiKey:account.credentials.apiKey}:{authId:`${account.id}.json`})}
  }
  const provider=(account:StoredAccount)=>({baseUrl:account.baseUrl,apiKey:account.credentials.apiKey,wireApi:account.wireApi,
    proxyUrl:projectedProxies.get(account.id),
    upstreamModel:account.models[0],upstreamModels:account.models,supportsVision:true,
    ...(profile.pool?{defaultServiceTier:tiers.get(account.id)!.tier??''}:{})})
  const byId=new Map(accounts.map(account=>[account.id,account])),knownIds=new Set(byId.keys())
  const keySpecs=profile.pool?profile.pool.settings.keys.map(key=>{
    const scope=effectiveLocalAccountIds(profile.pool!.settings,key,knownIds).map(id=>byId.get(id)!)
    return {...key,tokenUsed:profile.pool!.tokenUsed[key.id]??0,accountIds:scope.map(account=>account.id),responsesWebsockets:scope.every(account=>account.kind!=='api_key'),
      modelRouting:{automatic:true,nativeModels:[...new Set(scope.filter(account=>account.kind!=='api_key').flatMap(models))],routableModels:scope.some(account=>account.kind!=='api_key')?hiddenNative:[],defaultRoute:'oauth',failurePolicy:'strict',
        routes:scope.filter(account=>account.kind==='api_key').map(account=>({id:`auto-${account.id}`,namespace:`account-${account.id}`,providerAccountId:account.id,providerGateway:provider(account),models:account.models.map(model=>({clientModel:model,upstreamModel:model}))}))}}
  }):[{id:profile.id,label:profile.account.name,key:profile.apiKey,enabled:true,accountIds:[profile.account.id],responsesWebsockets:profile.account.kind!=='api_key',
    ...(profile.account.kind==='api_key'?{providerGateway:provider(profile.account)}:{})}]
  const manifest={locale:'zh-cn',accounts:accounts.map(spec),apiKeys:[...keySpecs,{id:`${profile.id}-management`,key:controlKey,enabled:true,internal:true,accountIds:accounts.map(account=>account.id)}],
    modelIds:[...new Set(accounts.flatMap(models))],routingStrategy:profile.pool?.settings.routingStrategy ?? 'round-robin',customRoutingRules:profile.pool?.settings.customRoutingRules??[],debugLogs:false}
  const tier=tiers.get(profile.account.id)!
  const config:Record<string,unknown>={host:'127.0.0.1',port:profile.port,'api-keys':[...keySpecs.filter(key=>key.enabled).map(key=>key.key),controlKey],
    'request-log':false,'logging-to-file':false,'request-retry':0,'ws-auth':true,
    // Cockpit's application defaults differ from the sidecar fallback values.
    // Project them explicitly so a fresh install does not silently use 10s/2 tries.
    streaming:{'stream-open-timeout-ms':settings.streamOpenTimeoutSeconds*1000,'stream-idle-timeout-ms':settings.streamIdleTimeoutSeconds*1000,
      'image-stream-open-timeout-ms':settings.imageStreamOpenTimeoutSeconds*1000,'image-stream-idle-timeout-ms':settings.imageStreamIdleTimeoutSeconds*1000,'stream-open-max-attempts':1},
    codex:{'optimize-multi-agent-v2':true,'stream-bootstrap-buffering':false},
    payload:{default:!profile.pool && tier.tier?[{models:['codex','openai','openai-response'].map(protocol=>({name:'*',protocol})),params:{service_tier:tier.tier}}]:[]}}
  if(profile.pool)config.routing={'session-affinity':profile.pool.settings.sessionAffinity,'session-affinity-ttl':`${profile.pool.settings.sessionAffinityTtlMs}ms`}
  const priorities={priorityAccountIds:Object.fromEntries((profile.pool?.settings.keys??[]).map(key=>{const scope=new Set(effectiveLocalAccountIds(profile.pool!.settings,key,knownIds));return [key.id,(key.priorityAccountIds??[]).filter(id=>scope.has(id))]}))}
  return {accounts,tiers,manifest,config,priorities,quotaReserve:Object.fromEntries(quotaReserve)}
}
