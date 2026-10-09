import {z} from 'zod'
import {settingsSchema,accountInputSchema,defaultTierSchema,groupInputSchema} from '../shared/types'
import {providerDetailsSchema} from '../shared/providerLibrary'
import {instanceInputSchema} from '../shared/instances'
import {localPoolSchema,localKeyDetailsSchema} from '../shared/localAccess'
import type {State} from './store'
import type {BackupCounts} from '../shared/dataBackup'
import {wakeupScheduleSchema} from '../shared/wakeup'
import {sshAuthSchema} from '../shared/ssh'

const id=z.string().uuid(),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text=z.string().max(16384),date=z.number().finite().nonnegative()
const json=z.record(z.unknown())
const credit=z.object({unlimited:z.boolean().optional(),remaining:z.number().optional(),balance:z.number().optional(),limit:z.number().optional(),used:z.number().optional(),remainingPercent:z.number().optional(),resetsAt:date.optional()}).strict()
const resetCredit=z.object({id:text.optional(),status:text.optional(),resetType:text.optional(),grantedAt:date.optional(),expiresAt:date.optional(),redeemedAt:date.optional()}).strict()
const quota=z.object({updatedAt:date,windows:z.array(z.object({id:text,name:text,usedPercent:z.number().optional(),resetsAt:date.optional(),durationSeconds:z.number().optional(),allowed:z.boolean().optional(),limitReached:z.boolean().optional()}).strict()).max(100),allowed:z.boolean().optional(),limitReached:z.boolean().optional(),hasUsableCredits:z.boolean().optional(),credits:credit.optional(),spendLimit:credit.optional(),resetCreditsAvailable:z.number().optional(),resetCredits:z.array(resetCredit).max(100).optional(),resetCreditsNextExpiresAt:date.optional()}).strict()
const providerUsage=z.object({checkedAt:date,error:text.optional(),unavailable:z.boolean().optional(),summary:z.object({source:z.enum(['sub2api','new_api','deepseek','minimax','zhipu']),updatedAt:date,unit:text.optional(),remaining:z.number().optional(),balance:z.number().optional(),limit:z.number().optional(),used:z.number().optional(),unlimited:z.boolean().optional(),isValid:z.boolean().optional(),expiresAt:date.optional(),accessUntil:date.optional(),todayRequests:z.number().optional(),todayTokens:z.number().optional(),todayCost:z.number().optional(),totalRequests:z.number().optional(),totalTokens:z.number().optional(),totalCost:z.number().optional(),grantedBalance:z.number().optional(),toppedUpBalance:z.number().optional(),planName:text.optional(),modelName:text.optional(),windows:z.array(z.object({id:text,name:text,remainingPercent:z.number().min(0).max(100).optional(),limit:z.number().optional(),remaining:z.number().optional(),used:z.number().optional(),resetsAt:date.optional()}).strict()).max(100).optional()}).strict().optional()}).strict()
const proxy=z.object({mode:z.enum(['direct','custom','resource']),url:z.string().max(2*1024*1024).optional(),resourceId:id.optional()}).strict()
const identity=z.object({agent_runtime_id:text,agent_private_key:text,task_id:text.optional(),account_id:text,chatgpt_user_id:text,email:text.optional(),plan_type:text.optional(),chatgpt_account_is_fedramp:z.boolean()}).strict()
const account=z.object({id,name:accountInputSchema.shape.name,email:text.optional(),kind:z.enum(['oauth','api_key','agent_identity']),plan:text.optional(),baseUrl:accountInputSchema.shape.baseUrl,
  models:z.array(z.string().max(200)).max(500),wireApi:z.enum(['responses','chat_completions']),integrationType:accountInputSchema.shape.integrationType,modelContextWindows:accountInputSchema.shape.modelContextWindows,providerUsageRevision:integer.optional(),defaultTier:defaultTierSchema,note:z.string().max(2000),tags:accountInputSchema.shape.tags,createdAt:date,
  credentials:z.object({apiKey:text.optional(),accessToken:text.optional(),refreshToken:text.optional(),idToken:text.optional(),accountId:text.optional(),lastRefresh:z.string().datetime({offset:true}).optional(),localAPIKey:text.optional(),agentIdentity:identity.optional()}).strict(),
  generation:text.optional(),source:json.optional(),revision:integer.optional(),providerId:id.optional(),providerKeyId:id.optional(),proxy:proxy.optional(),quota:quota.optional(),providerUsage:providerUsage.optional(),subscriptionActiveUntil:date.optional(),subscriptionSource:z.enum(['token','web']).optional(),subscriptionQueryLastAttemptAt:date.optional(),subscriptionQueryNextRetryAt:date.optional(),subscriptionQueryLastSuccessAt:date.optional(),subscriptionQueryLastError:text.optional(),error:text.optional(),errorAt:date.optional(),needsTokenExchange:z.boolean().optional()
}).strict()
const provider=providerDetailsSchema.extend({models:accountInputSchema.shape.models.min(0),id,revision:integer,createdAt:date,updatedAt:date,keys:z.array(z.object({id,name:text,apiKey:text,createdAt:date,updatedAt:date,usage:providerUsage.optional()}).strict()).max(10000),excludedKeyHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000)}).strict()
const profile=z.object({id,revision:integer,createdAt:date,externalHome:z.object({directory:text,device:integer,inode:integer,previousTargetName:text.optional()}).strict().optional()}).passthrough().superRefine((value,ctx)=>{
  const {id:_id,revision:_revision,createdAt:_createdAt,externalHome:_external,...details}=value
  if(!instanceInputSchema.safeParse(details).success)ctx.addIssue({code:'custom',message:'实例配置无效'})
})
const catalogEntry=z.object({id:text,name:text,native:json.optional(),error:text.optional()}).strict()
const catalogNode=catalogEntry.extend({protocol:text}).strict()
const catalogGroup=catalogEntry.extend({kind:text,members:z.array(text).max(4096),definitionError:text.optional(),issues:z.array(z.object({name:text,error:text}).strict()).max(4096)}).strict()
const wakeupTask=z.object({id,revision:integer.optional(),name:z.string().max(120),enabled:z.boolean(),accountIds:z.array(id).max(100),prompt:z.string().max(16384),model:text.optional(),modelReasoningEffort:z.enum(['none','minimal','low','medium','high','xhigh']).optional(),schedule:wakeupScheduleSchema,createdAt:date,updatedAt:date,lastRunAt:date.optional(),lastStatus:z.enum(['running','success','error','cancelled']).optional(),lastMessage:text.optional(),lastSuccessCount:integer.optional(),lastFailureCount:integer.optional(),lastDurationMs:integer.optional(),nextRunAt:date.optional()}).strict()
const wakeupHistory=z.object({id,runId:id,timestamp:date,triggerType:z.enum(['startup','scheduled','quota_reset','manual_task']),taskId:id,taskName:z.string().max(120),accountId:id,accountName:z.string().max(120),accountEmail:text.optional(),success:z.boolean(),model:text.optional(),modelReasoningEffort:text.optional(),reply:text.optional(),error:text.optional(),durationMs:integer}).strict()
const wakeup=z.object({enabled:z.boolean(),tasks:z.array(wakeupTask).max(1000),history:z.array(wakeupHistory).max(300)}).strict()
const sshServer=z.object({id,name:text,host:text,port:z.number().int().min(1).max(65535),username:text,codexHome:text,auth:sshAuthSchema,syncOnCodexSwitch:z.boolean(),createdAt:date,updatedAt:date,lastSync:z.object({accountId:id,accountEmail:text.optional(),tokenGeneration:text.optional(),bundleHash:z.string().regex(/^[a-f0-9]{64}$/),syncedAt:date,verified:z.boolean(),error:text.optional()}).strict().optional()}).strict()
const portable=z.object({localDataArchives:z.array(z.object({id,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),importedAt:date,sources:z.array(z.object({path:text,format:text,files:z.array(z.object({path:text,hash:z.string().regex(/^[a-f0-9]{64}$/),content:z.unknown()}).strict()).max(20040)}).strict()).max(30)}).strict()).max(100).optional(),version:z.literal(1),settings:settingsSchema,accounts:z.array(account).max(10000),groups:z.array(groupInputSchema.extend({id,sortOrder:integer,createdAt:date,accountIds:z.array(id).max(10000)}).strict()).max(10000),
  providers:z.array(provider).max(1000).optional(),accountRecycle:z.array(z.object({id,deletedAt:date,account,groupIds:z.array(id).max(10000),providerDefault:defaultTierSchema.optional(),providerModelContextWindows:accountInputSchema.shape.modelContextWindows}).strict()).max(10000).optional(),
  localAccess:localPoolSchema.extend({revision:integer,keys:z.array(localKeyDetailsSchema.extend({id,revision:integer,createdAt:date,key:text,restoredUsageOffset:integer.optional()}).strict()).max(100)}).strict().optional(),
  instances:z.array(profile).max(100).optional(),instanceApplications:z.array(z.object({id:text,name:text,path:text,kind:z.enum(['desktop','cli']).optional()}).strict()).max(1000).optional(),instanceWorkingDirectories:z.array(z.object({id,path:text,device:integer,inode:integer}).strict()).max(1000).optional(),
  wakeup:wakeup.optional(),
  sshServers:z.object({selectedId:id.optional(),servers:z.array(sshServer).max(100)}).strict().optional(),
  proxyResources:z.array(z.object({id,revision:integer,name:text,url:z.string().max(2*1024*1024),catalog:z.object({sourceId:id,itemId:text,revision:integer,selections:z.record(text),invalid:z.boolean().optional()}).strict().optional()}).strict()).max(500).optional(),
  upstreamProxy:z.object({revision:integer,mode:z.enum(['inherit','direct','custom']),url:text.optional()}).strict().optional(),
  unifiedProxy:z.object({mode:z.enum(['off','all_accounts']),resourceId:id.optional(),snapshot:z.object({url:z.string().max(2*1024*1024),resourceRevision:integer,sourceRevision:integer}).strict().optional(),pending:z.boolean().optional(),staleError:text.optional()}).strict().optional(),
  proxyCatalogs:z.array(z.object({id,revision:integer,name:text,kind:z.enum(['manual','subscription','strategy']),strategyMembers:z.array(z.object({sourceId:id,itemId:text,name:text,sourceName:text}).strict()).max(64).optional(),catalog:z.object({nodes:z.array(catalogNode).max(4096),groups:z.array(catalogGroup).max(4096)}).strict(),updatedAt:date,default:z.object({itemId:text,selections:z.record(text)}).strict().optional(),defaultInvalidated:z.boolean().optional(),url:text.optional(),autoUpdate:z.boolean().optional(),lastAttemptAt:date.optional(),error:text.optional(),usage:z.object({upload:date,download:date,total:date,expireAt:date.optional(),at:date}).strict().optional()}).strict()).max(32).optional()
}).strict()

export type PortableState=Omit<State,'configTargets'|'clientAuthorities'|'clientSwitches'>
export interface DataBackupBundle {schema:'codex-manager-lite.data-backup';version:1;exportedAt:number;state:PortableState;localKeyUsage:Record<string,number>;sourceConnections:number;sourceDirectories:number}
const bundle=z.object({schema:z.literal('codex-manager-lite.data-backup'),version:z.literal(1),exportedAt:date,state:portable,localKeyUsage:z.record(id,integer),sourceConnections:integer,sourceDirectories:integer}).strict()

function boundedJSON(value:unknown):void{
  let count=0
  const visit=(value:unknown,depth:number):void=>{
    if(++count>1000000||depth>64)throw new Error('备份结构超过上限')
    if(typeof value==='number'&&!Number.isFinite(value))throw new Error('备份数字无效')
    if(!value||typeof value!=='object')return
    for(const [key,child] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('备份包含无效字段');visit(child,depth+1)}
  }
  visit(value,0)
}
function unique(rows:{id:string}[]):void{if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('备份包含重复标识')}
export function validateBackup(value:unknown):DataBackupBundle{
  boundedJSON(value)
  const result=bundle.safeParse(value)
  if(!result.success)throw new Error('备份内容格式无效或版本不受支持')
  const parsed=result.data as unknown as DataBackupBundle
  const s=parsed.state
  for(const rows of [s.accounts,s.groups,s.providers??[],s.instances??[],s.instanceApplications??[],s.instanceWorkingDirectories??[],s.localAccess?.keys??[],s.proxyResources??[],s.proxyCatalogs??[],s.accountRecycle??[],s.sshServers?.servers??[]])unique(rows)
  if(s.sshServers?.selectedId&&!s.sshServers.servers.some(server=>server.id===s.sshServers!.selectedId))throw new Error('备份 SSH 服务器选择无效')
  if(s.wakeup){unique(s.wakeup.tasks);unique(s.wakeup.history)}
  for(const p of s.providers??[])unique(p.keys)
  for(const source of s.proxyCatalogs??[])unique([...source.catalog.nodes,...source.catalog.groups])
  const known=new Set(s.accounts.map(a=>a.id))
  for(const a of [...s.accounts,...(s.accountRecycle??[]).map(entry=>entry.account)]){
    if(a.kind!=='api_key'&&a.modelContextWindows!==undefined)throw new Error('登录账号不支持 API 连接上下文配置')
  }
  for(const entry of s.accountRecycle??[])if(entry.account.kind!=='api_key'&&entry.providerModelContextWindows!==undefined)throw new Error('登录账号不支持供应商上下文快照')
  for(const a of s.accounts){
    if(a.kind==='api_key'&&!a.credentials.apiKey||a.kind==='oauth'&&!a.credentials.accessToken&&!a.credentials.refreshToken||a.kind==='agent_identity'&&!a.credentials.agentIdentity)throw new Error('备份账号缺少凭据')
    if(!!a.providerId!==!!a.providerKeyId)throw new Error('备份供应商关联不一致')
    if(a.providerId){const p=s.providers?.find(p=>p.id===a.providerId),key=p?.keys.find(k=>k.id===a.providerKeyId);if(a.kind!=='api_key'||!p||!key||a.credentials.apiKey!==key.apiKey||a.baseUrl!==p.baseUrl||a.wireApi!==p.wireApi||(a.integrationType??'auto')!==(p.integrationType??'auto')||JSON.stringify(a.models)!==JSON.stringify(p.models))throw new Error('备份供应商关联不一致')}
  }
  for(const group of s.groups)if(group.accountIds.some(id=>!known.has(id)))throw new Error('备份分组引用缺失账号')
  for(const task of s.wakeup?.tasks??[])if(task.accountIds.some(id=>!known.has(id)))throw new Error('备份任务引用缺失账号')
  const pool=s.localAccess
  if(pool){
    const allowed=new Set(pool.accountIds)
    if(pool.accountIds.some(id=>!known.has(id))||pool.customRoutingRules?.some(rule=>!allowed.has(rule.accountId)))throw new Error('备份账号池范围无效')
    for(const accountId of Object.keys(pool.quotaReserve??{})){
      const account=s.accounts.find(value=>value.id===accountId)
      if(!account || !allowed.has(accountId) || account.kind!=='oauth')throw new Error('备份额度储备范围无效')
    }
    for(const key of pool.keys){const scope=new Set(key.inheritAccountPool?pool.accountIds:key.accountIds);if(key.accountIds.some(id=>!allowed.has(id))||key.priorityAccountIds?.some(id=>!scope.has(id)))throw new Error('备份密钥范围无效');if(!Object.hasOwn(parsed.localKeyUsage,key.id))throw new Error('备份缺少密钥用量')}
  }
  return parsed
}
export function backupCounts(s:PortableState):BackupCounts{return {accounts:s.accounts.length,groups:s.groups.length,providers:s.providers?.length??0,localKeys:s.localAccess?.keys.length??0,instances:s.instances?.length??0,recycledAccounts:s.accountRecycle?.length??0}}
export function exportBackupState(state:State,usage:Record<string,number>,now=Date.now()):DataBackupBundle{
  const {configTargets,clientAuthorities,clientSwitches,...portable}=state
  return validateBackup({schema:'codex-manager-lite.data-backup',version:1,exportedAt:now,state:portable,localKeyUsage:usage,sourceConnections:(clientAuthorities?.length??0)+(clientSwitches?.length??0),sourceDirectories:configTargets?.length??0})
}
export function effectiveKeyUsage(state:State,raw:Record<string,number>):Record<string,number>{
  const offsets=new Map(state.localAccess?.keys.map(k=>[k.id,k.restoredUsageOffset??0]))
  return Object.fromEntries(Object.entries(raw).map(([id,total])=>{
    const offset=offsets.get(id)??0
    if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(offset)||offset<0)throw new Error('密钥用量无效，请检查调用记录后重试')
    return [id,Math.min(Number.MAX_SAFE_INTEGER,total+offset)]
  }))
}
