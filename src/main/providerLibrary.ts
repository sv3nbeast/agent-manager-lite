import { createHash, randomUUID } from 'node:crypto'
import { providerDetailsSchema, providerEndpoint, providerKeyReadSchema, providerMutationSchema, providerKeyConnection, providerKeyModels, providerKeyProtocol, providerKeyCredentialKind, type ProviderKeySettings, type ProviderDetails, type ProviderSummary } from '../shared/providerLibrary'
import type { State, Store, StoredAccount } from './store'
import type { DefaultTier } from '../shared/types'
import {invalidateProviderUsage} from './providerUsage'
import type {ProviderUsageState} from '../shared/providerUsage'

export interface StoredProviderKey extends ProviderKeySettings { id: string; name: string; apiKey: string; createdAt: number; updatedAt: number; usage?:ProviderUsageState }
export interface StoredProvider extends ProviderDetails {
  id: string; revision: number; createdAt: number; updatedAt: number
  keys: StoredProviderKey[]; excludedKeyHashes: string[]
}
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex')
function touch(provider: StoredProvider): void { provider.revision++; provider.updatedAt = Date.now() }
function allow(provider: StoredProvider, apiKey: string): void {
  provider.excludedKeyHashes = provider.excludedKeyHashes.filter(hash => hash !== fingerprint(apiKey))
}
function exclude(provider: StoredProvider, apiKey: string): void {
  provider.excludedKeyHashes = [...new Set([...provider.excludedKeyHashes, fingerprint(apiKey)])]
}
function keySettings(provider:StoredProvider,settings:ProviderKeySettings):Required<ProviderKeySettings> {
  const protocol=providerKeyProtocol(provider,settings),credentialKind=providerKeyCredentialKind(provider,settings)
  if ((protocol==='anthropic_messages') !== (credentialKind!=='openai_api_key')) throw new Error('密钥认证方式与 API 协议不匹配')
  return {models:providerKeyModels(provider,settings),protocol,credentialKind}
}
/** Freeze only missing legacy settings before a mutation can change provider defaults. */
export function materializeProviderKeys(provider:StoredProvider):boolean {
  let changed=false
  for(const key of provider.keys) {
    const effective=keySettings(provider,key)
    if(key.models===undefined||key.protocol===undefined||key.credentialKind===undefined)changed=true
    Object.assign(key,effective)
  }
  return changed
}
function accountSettings(account:StoredAccount):Required<ProviderKeySettings> {
  const protocol=account.protocol ?? (account.identityService==='anthropic'?'anthropic_messages':account.wireApi==='chat_completions'?'openai_chat_completions':'openai_responses')
  const credentialKind=account.credentialKind ?? (protocol==='anthropic_messages'?'anthropic_api_key':'openai_api_key')
  if(!['openai_api_key','anthropic_api_key','anthropic_bearer','gateway'].includes(credentialKind))throw new Error('此 API 凭据类型无法保存到供应商密钥')
  return {models:[...account.models],protocol,credentialKind:credentialKind as Required<ProviderKeySettings>['credentialKind']}
}
function sameProtocol(account:StoredAccount,provider:StoredProvider,key:StoredProviderKey):boolean {
  const actual=accountSettings(account)
  return actual.protocol===providerKeyProtocol(provider,key)&&actual.credentialKind===providerKeyCredentialKind(provider,key)
}
function ensureKey(provider:StoredProvider, apiKey:string, name:string,settings:ProviderKeySettings={}):StoredProviderKey {
  const existing=provider.keys.find(key=>key.apiKey===apiKey)
  if(existing) {
    // Idempotent submission cannot silently overwrite a key's catalogue.
    for(const field of ['models','protocol','credentialKind'] as const)if(settings[field]!==undefined&&JSON.stringify(settings[field])!==JSON.stringify(existing[field]))throw new Error('供应商已保存此密钥，请编辑现有密钥的模型或协议')
    return existing
  }
  const normalized={...settings,models:[...new Set(providerKeyModels(provider,settings))]}
  const key={id:randomUUID(),name,apiKey,...keySettings(provider,normalized),createdAt:Date.now(),updatedAt:Date.now()}
  provider.keys.push(key)
  return key
}
export function providerSummaries(state: State): ProviderSummary[] {
  const references = new Map<string, Map<string, string[]>>()
  const reusable = new Map<string, Map<string, string[]>>()
  const accountsById=new Map(state.accounts.map(account=>[account.id,account]))
  for (const account of state.accounts) {
    if (account.kind === 'api_key' && account.credentials.apiKey) {
      const endpoint = providerEndpoint(account.baseUrl)
      const connections = reusable.get(endpoint) ?? new Map<string, string[]>()
      const ids = connections.get(account.credentials.apiKey) ?? []
      ids.push(account.id); connections.set(account.credentials.apiKey, ids); reusable.set(endpoint, connections)
    }
    if (!account.providerId || !account.providerKeyId) continue
    const provider = references.get(account.providerId) ?? new Map<string, string[]>()
    const ids = provider.get(account.providerKeyId) ?? []
    ids.push(account.id); provider.set(account.providerKeyId, ids); references.set(account.providerId, provider)
  }
  return (state.providers ?? []).map(provider => ({
    id: provider.id, revision: provider.revision, name: provider.name, baseUrl: provider.baseUrl,
    models: [...provider.models], wireApi: provider.wireApi, defaultTier: provider.defaultTier,
    ...(provider.integrationType === undefined ? {} : {integrationType:provider.integrationType}),
    ...(provider.presetId === undefined ? {} : {presetId:provider.presetId}),
    ...(provider.modelContextWindows === undefined ? {} : {modelContextWindows:structuredClone(provider.modelContextWindows)}),
    ...(provider.supportsVision === undefined ? {} : {supportsVision:provider.supportsVision}),
    ...(provider.modelCapabilities === undefined ? {} : {modelCapabilities:structuredClone(provider.modelCapabilities)}),
    ...(provider.visionRoutingModel === undefined ? {} : {visionRoutingModel:provider.visionRoutingModel}),
    ...(provider.supportsWebsockets === undefined ? {} : {supportsWebsockets:provider.supportsWebsockets}),
    ...(provider.enableModePreference === undefined ? {} : {enableModePreference:provider.enableModePreference}),
    createdAt: provider.createdAt, updatedAt: provider.updatedAt,
    keys: provider.keys.map(key => ({ ...keySettings(provider,key),id: key.id, name: key.name, createdAt: key.createdAt, updatedAt: key.updatedAt,
      ...(key.usage ? {usage:structuredClone(key.usage)} : {}),
      accountIds: references.get(provider.id)?.get(key.id) ?? [],
      reusableAccountIds: (reusable.get(providerEndpoint(provider.baseUrl))?.get(key.apiKey) ?? []).filter(id=>sameProtocol(accountsById.get(id)!,provider,key)) }))
  }))
}

// Editing is an explicit, revision-bound read; routine snapshots remain summaries.
export function readProviderKey(store: Store, raw: unknown): string {
  const input = providerKeyReadSchema.parse(raw)
  const provider = store.read().providers?.find(item => item.id === input.id)
  if (!provider) throw new Error('供应商已删除，请重新打开编辑窗口')
  if (provider.revision !== input.revision) throw new Error('供应商已被修改，请重新打开编辑窗口')
  const key = provider.keys.find(item => item.id === input.keyId)
  if (!key) throw new Error('密钥已删除或移动，请重新选择')
  return key.apiKey
}

// Account imports merge into existing providers only. They neither invent providers,
// replace provider metadata nor implicitly retarget an account to another endpoint.
export function reconcileProviderKeys(state: State): void {
  const providers = new Map((state.providers ?? []).map(provider => [providerEndpoint(provider.baseUrl), provider]))
  const keys = new Map((state.providers ?? []).map(p => [p.id, new Set(p.keys.map(k=>k.apiKey))]))
  const excluded = new Map((state.providers ?? []).map(p => [p.id, new Set(p.excludedKeyHashes)]))
  const changed = new Set<StoredProvider>()
  for (const account of state.accounts) {
    if (account.kind !== 'api_key' || !account.credentials.apiKey) continue
    const provider = providers.get(providerEndpoint(account.baseUrl))
    if (!provider || keys.get(provider.id)!.has(account.credentials.apiKey)
      || excluded.get(provider.id)!.has(fingerprint(account.credentials.apiKey))) continue
    provider.keys.push({id:randomUUID(),name:account.name,apiKey:account.credentials.apiKey,...accountSettings(account),createdAt:Date.now(),updatedAt:Date.now()})
    keys.get(provider.id)!.add(account.credentials.apiKey)
    changed.add(provider)
  }
  changed.forEach(touch)
}
function linked(state: State, provider: StoredProvider, key?: StoredProviderKey): StoredAccount[] {
  return state.accounts.filter(a => a.providerId === provider.id && (!key || a.providerKeyId === key.id))
}
function detach(account: StoredAccount, provider?: StoredProvider): void {
  // Keep a detached account's effective default and connection usable on its own.
  if (account.defaultTier === 'inherit' && provider) account.defaultTier = provider.defaultTier
  // A detached connection keeps the windows it was using, including its own
  // overrides. A later provider edit cannot silently change standalone values.
  const windows = { ...(provider?.modelContextWindows ?? {}), ...(account.modelContextWindows ?? {}) }
  if (Object.keys(windows).length) account.modelContextWindows = windows
  delete account.providerId; delete account.providerKeyId
  account.revision = (account.revision ?? 0) + 1
}
function project(account: StoredAccount, provider: StoredProvider, key: StoredProviderKey): void {
  if (account.baseUrl !== provider.baseUrl || account.credentials.apiKey !== key.apiKey || !sameProtocol(account,provider,key)
    || (account.integrationType ?? 'auto') !== (provider.integrationType ?? 'auto')) invalidateProviderUsage(account)
  account.providerId = provider.id; account.providerKeyId = key.id
  account.baseUrl = provider.baseUrl; Object.assign(account,providerKeyConnection(provider,key))
  account.credentials.apiKey = key.apiKey
  if (provider.integrationType === undefined) delete account.integrationType
  else account.integrationType = provider.integrationType
  account.revision = (account.revision ?? 0) + 1
}
function assertNoDuplicateAccounts(state: State): void {
  const seen = new Map<string, Set<string>>()
  for (const account of state.accounts) {
    if (account.kind !== 'api_key') continue
    const endpoint = JSON.stringify([providerEndpoint(account.baseUrl),accountSettings(account).protocol,accountSettings(account).credentialKind]), apiKey = account.credentials.apiKey ?? ''
    const keys = seen.get(endpoint) ?? new Set<string>()
    if (keys.has(apiKey)) throw new Error('此修改会产生重复账号，请先处理相同接口和密钥的账号')
    keys.add(apiKey); seen.set(endpoint, keys)
  }
}

function createLinkedConnection(state:State, provider:StoredProvider, key:StoredProviderKey, name:string):void {
  if(!providerKeyModels(provider,key).length)throw new Error('请先为此密钥配置模型，再启用 API 连接')
  const account:StoredAccount={id:randomUUID(),kind:'api_key',name,
    baseUrl:provider.baseUrl,...providerKeyConnection(provider,key),defaultTier:'inherit',
    note:'',tags:[],createdAt:Date.now(),credentials:{apiKey:key.apiKey}}
  project(account,provider,key)
  state.accounts.push(account)
  assertNoDuplicateAccounts(state)
}

export function providerTierForAccount(state: State, account: StoredAccount): DefaultTier | undefined {
  if (!account.providerId) return
  const provider = state.providers?.find(p => p.id === account.providerId)
  const key = provider?.keys.find(k => k.id === account.providerKeyId)
  if (!provider || !key || account.kind !== 'api_key' || providerEndpoint(account.baseUrl) !== providerEndpoint(provider.baseUrl)
    || account.credentials.apiKey !== key.apiKey || !sameProtocol(account,provider,key)
    || account.wireApi !== providerKeyConnection(provider,key).wireApi || JSON.stringify(account.models) !== JSON.stringify(providerKeyModels(provider,key))) throw new Error('供应商关联已变化，请重新关联账号')
  return provider.defaultTier
}

function updateKey(provider:StoredProvider,key:StoredProviderKey,changes:ProviderKeySettings&{apiKey?:string},stopped:(accounts:StoredAccount[])=>void,accounts:StoredAccount[]):boolean {
  const next=keySettings(provider,{...key,...Object.fromEntries(Object.entries(changes).filter(([,value])=>value!==undefined)),
    ...(changes.models===undefined?{}:{models:[...new Set(changes.models)]})})
  const changed=(changes.apiKey!==undefined&&changes.apiKey!==key.apiKey)||JSON.stringify(next)!==JSON.stringify(keySettings(provider,key))
  if(!changed)return false
  stopped(accounts)
  if(changes.apiKey!==undefined&&changes.apiKey!==key.apiKey) {
    if(provider.keys.some(item=>item.id!==key.id&&item.apiKey===changes.apiKey))throw new Error('供应商已保存此密钥')
    exclude(provider,key.apiKey);key.apiKey=changes.apiKey;allow(provider,key.apiKey);delete key.usage
  }
  if(providerKeyProtocol(provider,key)!==next.protocol||providerKeyCredentialKind(provider,key)!==next.credentialKind)delete key.usage
  Object.assign(key,next,{updatedAt:Date.now()})
  return true
}

// Synchronous Store transactions are serialized by the Electron main loop. The
// revision check and all account/key writes commit in one encrypted atomic save.
export function mutateProvider(store: Store, raw: unknown, inUse: (id: string) => boolean = () => false): void {
  const input = providerMutationSchema.parse(raw)
  store.transaction(state => {
    state.providers ??= []
    const current = (id: string, revision: number): StoredProvider => {
      const provider = state.providers!.find(p => p.id === id)
      if (!provider) throw new Error('供应商已删除')
      if (provider.revision !== revision) throw new Error('供应商已被修改，请重新打开操作窗口')
      return provider
    }
    const stopped = (accounts: StoredAccount[]) => {
      if (accounts.some(a => inUse(a.id))) throw new Error('请先停止关联账号的本地服务，再修改连接或解除关联')
    }
    const accountById = (id: string, revision: number) => {
      const account = state.accounts.find(a => a.id === id)
      if (!account || account.kind !== 'api_key') throw new Error('请选择现有 API 连接')
      if ((account.revision ?? 0) !== revision) throw new Error('账号已被修改，请重新打开操作窗口')
      return account
    }
    const uniqueEndpoint = (baseUrl: string, id?: string) => {
      if (state.providers!.some(p => p.id !== id && providerEndpoint(p.baseUrl) === providerEndpoint(baseUrl))) throw new Error('此接口地址的供应商已存在')
    }
    if (input.action === 'reconcile') { reconcileProviderKeys(state); return }
    if (input.action === 'create') {
      uniqueEndpoint(input.details.baseUrl)
      const provider:StoredProvider={ ...input.details, models: [...new Set(input.details.models)], id: randomUUID(), revision: 0,
        createdAt: Date.now(), updatedAt: Date.now(), keys: [], excludedKeyHashes: [] }
      state.providers.push(provider)
      if(input.initialKey) {
        const key=ensureKey(provider,input.initialKey.apiKey,input.initialKey.name,input.initialKey)
        if(input.initialKey.createConnection)createLinkedConnection(state,provider,key,input.initialKey.name || provider.name)
      }
      reconcileProviderKeys(state)
      return
    }
    if (input.action === 'unlinkAccount') {
      const account = accountById(input.accountId, input.accountRevision)
      stopped([account])
      const provider = state.providers.find(p => p.id === account.providerId)
      detach(account, provider)
      if (provider) touch(provider)
      return
    }
    const provider = current(input.id, input.revision)
    materializeProviderKeys(provider)
    if (input.action === 'update') {
      if (input.clearModelContextWindows && input.changes.modelContextWindows !== undefined) throw new Error('上下文窗口不能同时清空和设置')
      const next = providerDetailsSchema.parse({name:provider.name,baseUrl:provider.baseUrl,
        models:provider.models,wireApi:provider.wireApi,defaultTier:provider.defaultTier,
        ...(provider.integrationType === undefined ? {} : {integrationType:provider.integrationType}),
        ...(provider.presetId === undefined ? {} : {presetId:provider.presetId}),
        ...(provider.modelContextWindows === undefined ? {} : {modelContextWindows:provider.modelContextWindows}),
        ...(provider.supportsVision === undefined ? {} : {supportsVision:provider.supportsVision}),
        ...(provider.modelCapabilities === undefined ? {} : {modelCapabilities:provider.modelCapabilities}),
        ...(provider.visionRoutingModel === undefined ? {} : {visionRoutingModel:provider.visionRoutingModel}),
        ...(provider.supportsWebsockets === undefined ? {} : {supportsWebsockets:provider.supportsWebsockets}),
        ...(provider.enableModePreference === undefined ? {} : {enableModePreference:provider.enableModePreference}),
        ...Object.fromEntries(Object.entries(input.changes).filter(([,value]) => value !== undefined)) })
      if (input.clearModelContextWindows) delete next.modelContextWindows
      next.models = [...new Set(next.models)]
      uniqueEndpoint(next.baseUrl, provider.id)
      const connectionChanged = ['baseUrl'].some(field => JSON.stringify(next[field as keyof ProviderDetails]) !== JSON.stringify(provider[field as keyof ProviderDetails]))
      const integrationChanged = (next.integrationType ?? 'auto') !== (provider.integrationType ?? 'auto')
      if (next.baseUrl !== provider.baseUrl || integrationChanged) for (const key of provider.keys) delete key.usage
      const accounts = linked(state, provider)
      if (connectionChanged) stopped(accounts)
      if(input.keyChange) {
        const key=provider.keys.find(item=>item.id===input.keyChange!.keyId)
        if(!key)throw new Error('密钥已删除或移动')
        updateKey(provider,key,input.keyChange,stopped,linked(state,provider,key))
      }
      if (input.clearModelContextWindows) delete provider.modelContextWindows
      Object.assign(provider, next)
      for (const account of accounts) {
        if (!connectionChanged && !integrationChanged && account.providerKeyId !== input.keyChange?.keyId) continue
        const key = provider.keys.find(k => k.id === account.providerKeyId)
        if (!key) throw new Error('关联密钥缺失，请先解除关联')
        project(account, provider, key)
      }
      assertNoDuplicateAccounts(state)
      touch(provider)
      return
    }
    if (input.action === 'delete') {
      const accounts = linked(state, provider); stopped(accounts)
      accounts.forEach(account => detach(account, provider))
      state.providers = state.providers.filter(p => p.id !== provider.id)
      return
    }
    if (input.action === 'addKey') {
      const key=ensureKey(provider, input.apiKey, input.name,input)
      if(input.createConnection && !linked(state,provider,key).length)createLinkedConnection(state,provider,key,input.name || provider.name)
      allow(provider, input.apiKey); touch(provider); return
    }
    const key = provider.keys.find(key => key.id === input.keyId)
    if (!key) throw new Error('密钥已删除或移动')
    if(input.action==='editKey') {
      const accounts=linked(state,provider,key)
      const changed=updateKey(provider,key,input,stopped,accounts)
      if(changed)accounts.forEach(account=>project(account,provider,key))
      assertNoDuplicateAccounts(state)
      if(input.name!==undefined)key.name=input.name
      key.updatedAt=Date.now();touch(provider);return
    }
    if (input.action === 'removeKey' || input.action === 'moveKey') {
      const accounts = linked(state, provider, key); stopped(accounts)
      if (input.action === 'moveKey') {
        if (input.targetId === provider.id) throw new Error('请选择不同的目标供应商')
        const target = current(input.targetId, input.targetRevision)
        materializeProviderKeys(target)
        const duplicate = target.keys.find(k => k.apiKey === key.apiKey)
        if (duplicate) {
          if(JSON.stringify(keySettings(target,duplicate))!==JSON.stringify(keySettings(provider,key)))throw new Error('两边密钥的模型或协议不同，请先统一配置；源密钥已保留')
          if (key.name && duplicate.name && key.name !== duplicate.name) throw new Error('两边的密钥名称不同，请先统一名称再移动；源密钥已保留')
          if (!duplicate.name) duplicate.name = key.name
          duplicate.updatedAt = Date.now()
        } else { const {usage:_usage,...moved}=key;target.keys.push({ ...moved, updatedAt: Date.now() }) }
        allow(target, key.apiKey); touch(target)
      }
      accounts.forEach(account => detach(account, provider))
      provider.keys = provider.keys.filter(k => k.id !== key.id)
      exclude(provider, key.apiKey); touch(provider); return
    }
    if (input.action === 'createAccount') {
      createLinkedConnection(state,provider,key,input.name)
    } else {
      const account = accountById(input.accountId, input.accountRevision)
      stopped([account])
      if(!sameProtocol(account,provider,key))throw new Error('API 连接与密钥的协议或认证方式不同，请选择兼容连接')
      const previous = state.providers.find(p => p.id === account.providerId && p.id !== provider.id)
      if (previous) touch(previous)
      project(account, provider, key)
    }
    assertNoDuplicateAccounts(state)
    touch(provider)
  })
}
