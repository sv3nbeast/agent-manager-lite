import {accountProxyURL} from './proxyPolicy'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { emptyLocalAccess, effectiveLocalAccountIds, localAccessMutationSchema, type LocalAccessView, type StoredLocalAccess } from '../shared/localAccess'
import { Store, type StoredAccount } from './store'
import { Gateway } from './gateway'
import { providerTierForAccount } from './providerLibrary'
import { routingAccountState } from './accountRouting'

export const localPoolId='c3827f70-f7d7-419f-a066-9fbf03b6aa94'
const secret=()=>`cml-${randomBytes(32).toString('hex')}`
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class LocalAccess {
  private preparing?:{controller:AbortController;ids:string[];task:Promise<void>;single:boolean}
  private appliedRevision?:number
  private error?:string
  constructor(private readonly store:Store,private readonly gateway:Gateway,private readonly prepare:(id:string)=>Promise<StoredAccount>,
    private readonly usage:(ids:string[])=>Record<string,number>) {}
  usesAccount(id:string):boolean {return this.preparing?.ids.includes(id)===true || this.gateway.usesAccount(id)}
  private state():StoredLocalAccess {
    const value=this.store.read().localAccess
    if (!value) return emptyLocalAccess()
    // Drop an early, never-supported OAuth binding hint if an unreleased
    // development vault contains one. It never widened a key's scope.
    const {boundOauthAccountId:_legacyBinding,...rest}=value as StoredLocalAccess & {boundOauthAccountId?:string}
    return {...rest,customRoutingRules:rest.customRoutingRules??[],quotaReserve:rest.quotaReserve??{},keys:rest.keys??[]}
  }
  view():LocalAccessView {
    const state=this.state(),status=this.gateway.current(),accounts=this.store.read().accounts,known=new Set(accounts.map(account=>account.id)),poolIds=new Set(state.accountIds)
    let usage:Record<string,number>|undefined,usageError:string|undefined
    try{usage=this.usage(state.keys.map(key=>key.id))}catch{usageError='无法读取密钥用量，请检查调用记录存储后重试；当前用量未知'}
    return {...state,customRoutingRules:state.customRoutingRules??[],quotaReserve:state.quotaReserve??{},accountInfo:accounts.filter(account=>poolIds.has(account.id)).map(account=>{const value=routingAccountState(account);return {id:account.id,remainingPercent:value.remainingQuota,expiresAt:value.subscriptionExpiryMs}}),keys:state.keys.map(({key:_key,...value})=>({...value,priorityAccountIds:value.priorityAccountIds??[],tokenUsed:usage?usage[value.id]??0:null,
      effectiveAccountIds:effectiveLocalAccountIds(state,value,known)})),
      running:status.running&&status.profileId===localPoolId,starting:Boolean(this.preparing&&!this.preparing.single),singleStarting:Boolean(this.preparing?.single),port:status.profileId===localPoolId?status.port:undefined,
      error:this.error ?? usageError ?? (status.profileId===localPoolId?status.error??status.quotaSyncError:undefined),appliedRevision:this.appliedRevision}
  }
  mutate(raw:unknown):void {
    const input=localAccessMutationSchema.parse(raw)
    if(this.preparing || this.gateway.current().running && this.gateway.current().profileId===localPoolId)throw new Error('请先停止账号池服务，再修改账号范围或密钥')
    this.store.transaction(state=>{
      const pool=state.localAccess ?? emptyLocalAccess(),known=new Set(state.accounts.map(account=>account.id))
      if(input.action==='savePool') {
        if(input.revision!==pool.revision)throw new Error('账号池已变化，请重新读取')
        if(input.settings.accountIds.some(id=>!known.has(id)))throw new Error('所选账号已不存在')
        if(input.settings.customRoutingRules?.some(rule=>!input.settings.accountIds.includes(rule.accountId)))throw new Error('调度规则只能配置账号池内的账号')
        const reserve=input.settings.quotaReserve??{}
        delete (pool as StoredLocalAccess & {boundOauthAccountId?:string}).boundOauthAccountId
        for(const [accountId,threshold] of Object.entries(reserve)){
          const account=state.accounts.find(value=>value.id===accountId)
          if(!account || !input.settings.accountIds.includes(accountId))throw new Error('额度储备只能配置账号池内的账号')
          if(account.kind!=='oauth')throw new Error('额度储备只适用于 OAuth 账号')
          if(threshold.hourlyPercent===0 && threshold.weeklyPercent===0)delete reserve[accountId]
        }
        if(pool.keys.some(key=>!key.inheritAccountPool && key.accountIds.some(id=>!input.settings.accountIds.includes(id))))throw new Error('账号仍被密钥独立范围引用，请先修改该密钥')
        if(pool.keys.some(key=>key.priorityAccountIds?.some(id=>!input.settings.accountIds.includes(id))))throw new Error('账号仍被密钥优先顺序引用，请先修改该密钥')
        Object.assign(pool,{...input.settings,quotaReserve:reserve})
      } else {
        const current=input.action==='createKey'?undefined:pool.keys.find(key=>key.id===input.id)
        if(input.action!=='createKey' && (!current || current.revision!==input.revision))throw new Error('密钥已变化或不存在，请重新编辑')
        if(input.action==='deleteKey')pool.keys=pool.keys.filter(key=>key.id!==input.id)
        else if(input.action==='rotateKey'){current!.key=secret();current!.revision++}
        else {
          if(!input.details.inheritAccountPool && !input.details.accountIds.length)throw new Error('独立账号范围至少选择一个账号')
          if(input.details.accountIds.some(id=>!known.has(id)||!pool.accountIds.includes(id)))throw new Error('密钥只能选择账号池内的账号')
          const scope=input.details.inheritAccountPool?pool.accountIds:input.details.accountIds
          if(input.details.priorityAccountIds?.some(id=>!known.has(id)||!scope.includes(id)))throw new Error('优先账号必须在此密钥的账号范围内')
          if(pool.keys.some(key=>key.id!==current?.id&&key.label.toLowerCase()===input.details.label.toLowerCase()))throw new Error('密钥名称已存在')
          if(current)Object.assign(current,input.details,{revision:current.revision+1})
          else {if(pool.keys.length>=100)throw new Error('最多创建 100 把本地密钥');pool.keys.push({...input.details,id:randomUUID(),revision:0,key:secret(),createdAt:Date.now()})}
        }
      }
      pool.revision++;state.localAccess=pool
    })
    this.error=undefined
  }
  key(id:string):string {
    const key=this.state().keys.find(key=>key.id===z.string().uuid().parse(id))
    if(!key)throw new Error('密钥不存在');return key.key
  }
  private fingerprint():string {
    const state=this.store.read(),pool=this.state()
    return hash([pool,state.settings,pool.accountIds.map(id=>{const a=state.accounts.find(account=>account.id===id);return a&&[id,a.kind,a.baseUrl,a.models,a.wireApi,a.defaultTier,a.providerId,a.providerKeyId,a.credentials.apiKey,accountProxyURL(a,state),providerTierForAccount(state,a)]})])
  }
  start():void {
    if(this.preparing || this.gateway.current().running)throw new Error('已有本地服务运行或正在启动，请先停止')
    const pool=this.state()
    if(!pool.accountIds.length || !pool.keys.some(key=>key.enabled))throw new Error('请先选择账号并创建至少一把启用的本地密钥')
    const currentAccounts=this.store.read().accounts
    if(pool.accountIds.some(id=>!currentAccounts.some(account=>account.id===id)))throw new Error('账号池存在已移除的账号，请重新保存范围')
    const runtimeIds=[...pool.accountIds]
    const controller=new AbortController(),pending={controller,ids:runtimeIds,task:Promise.resolve(),single:false}
    const fingerprint=this.fingerprint();this.error=undefined;this.preparing=pending
    pending.task=(async()=>{
      try {
        for(const id of runtimeIds){controller.signal.throwIfAborted();await this.prepare(id)}
        controller.signal.throwIfAborted()
        if(fingerprint!==this.fingerprint())throw new Error('账号池、连接或设置已变化，请重新启动')
        const state=this.store.read(),accounts=runtimeIds.map(id=>state.accounts.find(account=>account.id===id)!)
        await this.gateway.start({id:localPoolId,port:state.settings.port,account:accounts[0],apiKey:'',
          pool:{settings:pool,accounts,providerTiers:Object.fromEntries(accounts.map(account=>[account.id,providerTierForAccount(state,account)])),tokenUsed:this.usage(pool.keys.map(key=>key.id))}},state.settings,controller.signal)
        for(const account of accounts){
          const current=this.store.read().accounts.find(value=>value.id===account.id)!
          await this.gateway.updateCredentials(current)
          this.gateway.updateRoutingAccount(this.store.read().accounts.find(value=>value.id===account.id)!)
        }
        this.appliedRevision=pool.revision
      } catch(error) {
        this.error=controller.signal.aborted?undefined:error instanceof Error?error.message:'账号池启动失败'
        await this.gateway.stop().catch(()=>{this.error='登录状态保存失败，请重试停止；运行文件已保留'})
      } finally {if(this.preparing===pending)this.preparing=undefined}
    })()
  }
  async startSingle(id:string):Promise<void> {
    z.string().uuid().parse(id)
    if(this.preparing || this.gateway.current().running)throw new Error('已有本地服务运行或正在启动，请先停止')
    if(!this.store.read().accounts.some(account=>account.id===id))throw new Error('账号已删除，请重新选择')
    const controller=new AbortController(),pending={controller,ids:[id],task:Promise.resolve(),single:true}
    this.preparing=pending;this.error=undefined
    pending.task=(async()=>{
      try {
        await this.prepare(id);controller.signal.throwIfAborted()
        let account=this.store.read().accounts.find(value=>value.id===id)
        if(!account)throw new Error('账号已删除，请重新选择')
        if(!account.credentials.localAPIKey){
          this.store.transaction(state=>{state.accounts.find(value=>value.id===id)!.credentials.localAPIKey=secret()})
          account=this.store.read().accounts.find(value=>value.id===id)!
        }
        const state=this.store.read()
        await this.gateway.start({id,account,providerTier:providerTierForAccount(state,account),port:state.settings.port,apiKey:account.credentials.localAPIKey!},state.settings,controller.signal)
        await this.gateway.updateCredentials(this.store.read().accounts.find(value=>value.id===id)!)
        this.gateway.updateRoutingAccount(this.store.read().accounts.find(value=>value.id===id)!)
      }catch(error){
        await this.gateway.stop();throw error
      }finally{if(this.preparing===pending)this.preparing=undefined}
    })()
    await pending.task
  }
  async settled():Promise<void>{await this.preparing?.task}
  async stop():Promise<void>{this.preparing?.controller.abort();await this.preparing?.task.catch(()=>{});await this.gateway.stop();this.error=undefined}
}
