import { createHash, randomUUID } from 'node:crypto'
import { providerDetailsSchema, providerEndpoint, providerKeyReadSchema, providerMutationSchema, type ProviderDetails, type ProviderSummary } from '../shared/providerLibrary'
import type { State, Store, StoredAccount } from './store'
import type { DefaultTier } from '../shared/types'
import {invalidateProviderUsage} from './providerUsage'
import type {ProviderUsageState} from '../shared/providerUsage'

interface StoredProviderKey { id: string; name: string; apiKey: string; createdAt: number; updatedAt: number; usage?:ProviderUsageState }
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
function ensureKey(provider: StoredProvider, apiKey: string, name: string): StoredProviderKey {
  const existing = provider.keys.find(key => key.apiKey === apiKey)
  if (existing) return existing // Never overwrite a user's saved display name on reuse.
  const key = { id: randomUUID(), name, apiKey, createdAt: Date.now(), updatedAt: Date.now() }
  provider.keys.push(key)
  return key
}
export function providerSummaries(state: State): ProviderSummary[] {
  const references = new Map<string, Map<string, string[]>>()
  for (const account of state.accounts) {
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
    keys: provider.keys.map(key => ({ id: key.id, name: key.name, createdAt: key.createdAt, updatedAt: key.updatedAt,
      ...(key.usage ? {usage:structuredClone(key.usage)} : {}),
      accountIds: references.get(provider.id)?.get(key.id) ?? [] }))
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
    provider.keys.push({id:randomUUID(),name:account.name,apiKey:account.credentials.apiKey,createdAt:Date.now(),updatedAt:Date.now()})
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
  delete account.providerId; delete account.providerKeyId
  account.revision = (account.revision ?? 0) + 1
}
function project(account: StoredAccount, provider: StoredProvider, key: StoredProviderKey): void {
  if (account.baseUrl !== provider.baseUrl || account.credentials.apiKey !== key.apiKey
    || (account.integrationType ?? 'auto') !== (provider.integrationType ?? 'auto')) invalidateProviderUsage(account)
  account.providerId = provider.id; account.providerKeyId = key.id
  account.baseUrl = provider.baseUrl; account.wireApi = provider.wireApi; account.models = [...provider.models]
  account.credentials.apiKey = key.apiKey
  if (provider.integrationType === undefined) delete account.integrationType
  else account.integrationType = provider.integrationType
  account.revision = (account.revision ?? 0) + 1
}
function assertNoDuplicateAccounts(state: State): void {
  const seen = new Map<string, Set<string>>()
  for (const account of state.accounts) {
    if (account.kind !== 'api_key') continue
    const endpoint = providerEndpoint(account.baseUrl), apiKey = account.credentials.apiKey ?? ''
    const keys = seen.get(endpoint) ?? new Set<string>()
    if (keys.has(apiKey)) throw new Error('此修改会产生重复账号，请先处理相同接口和密钥的账号')
    keys.add(apiKey); seen.set(endpoint, keys)
  }
}

function createLinkedConnection(state:State, provider:StoredProvider, key:StoredProviderKey, name:string):void {
  const account:StoredAccount={id:randomUUID(),kind:'api_key',name,
    baseUrl:provider.baseUrl,models:[...provider.models],wireApi:provider.wireApi,defaultTier:'inherit',
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
    || account.credentials.apiKey !== key.apiKey || account.wireApi !== provider.wireApi
    || JSON.stringify(account.models) !== JSON.stringify(provider.models)) throw new Error('供应商关联已变化，请重新关联账号')
  return provider.defaultTier
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
      if (!account || account.kind !== 'api_key') throw new Error('请选择现有 API 账号')
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
        const key=ensureKey(provider,input.initialKey.apiKey,input.initialKey.name)
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
      const connectionChanged = ['baseUrl','wireApi','models'].some(field => JSON.stringify(next[field as keyof ProviderDetails]) !== JSON.stringify(provider[field as keyof ProviderDetails]))
      const integrationChanged = (next.integrationType ?? 'auto') !== (provider.integrationType ?? 'auto')
      if (next.baseUrl !== provider.baseUrl || integrationChanged) for (const key of provider.keys) delete key.usage
      const accounts = linked(state, provider)
      if (connectionChanged) stopped(accounts)
      if (input.keyChange) {
        const key = provider.keys.find(item => item.id === input.keyChange!.keyId)
        if (!key) throw new Error('密钥已删除或移动')
        if (key.apiKey !== input.keyChange.apiKey) {
          if (provider.keys.some(item => item.id !== key.id && item.apiKey === input.keyChange!.apiKey)) throw new Error('供应商已保存此密钥')
          stopped(linked(state, provider, key))
          exclude(provider, key.apiKey)
          key.apiKey = input.keyChange.apiKey; key.updatedAt = Date.now()
          allow(provider, key.apiKey); delete key.usage
        }
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
      const key=ensureKey(provider, input.apiKey, input.name)
      if(input.createConnection && !linked(state,provider,key).length)createLinkedConnection(state,provider,key,input.name || provider.name)
      allow(provider, input.apiKey); touch(provider); return
    }
    const key = provider.keys.find(key => key.id === input.keyId)
    if (!key) throw new Error('密钥已删除或移动')
    if (input.action === 'editKey') {
      if (input.apiKey !== undefined && input.apiKey !== key.apiKey) {
        if (provider.keys.some(k => k.id !== key.id && k.apiKey === input.apiKey)) throw new Error('供应商已保存此密钥')
        const accounts = linked(state, provider, key); stopped(accounts)
        exclude(provider, key.apiKey); key.apiKey = input.apiKey; allow(provider, key.apiKey); delete key.usage
        accounts.forEach(account => project(account, provider, key))
        assertNoDuplicateAccounts(state)
      }
      if (input.name !== undefined) key.name = input.name
      key.updatedAt = Date.now(); touch(provider); return
    }
    if (input.action === 'removeKey' || input.action === 'moveKey') {
      const accounts = linked(state, provider, key); stopped(accounts)
      if (input.action === 'moveKey') {
        if (input.targetId === provider.id) throw new Error('请选择不同的目标供应商')
        const target = current(input.targetId, input.targetRevision)
        const duplicate = target.keys.find(k => k.apiKey === key.apiKey)
        if (duplicate) {
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
      const previous = state.providers.find(p => p.id === account.providerId && p.id !== provider.id)
      if (previous) touch(previous)
      project(account, provider, key)
    }
    assertNoDuplicateAccounts(state)
    touch(provider)
  })
}
