import { z } from 'zod'
import type { Account } from './types'
import { claudeCodeClient, claudeCodeClientType, type ClaudeCodeCredentialKind } from './claudeCode'

/**
 * A client type identifies the product family. Desktop/CLI are separate
 * launch choices within that family; the persisted Claude type retains its
 * original value so existing instances and credentials keep their identity.
 */
export const agentClientTypeSchema = z.enum(['codex', claudeCodeClientType])
export type AgentClientType = z.infer<typeof agentClientTypeSchema>

/** Missing fields belong to legacy Codex records; explicit values never fall back. */
export function resolveAgentClientType(value:unknown):AgentClientType {
  if(value===undefined)return 'codex'
  const parsed=agentClientTypeSchema.safeParse(value)
  if(!parsed.success)throw new Error('此客户端尚未接入，请选择当前支持的客户端')
  return parsed.data
}

export const implementedAgentClients = [{
  id:'codex' as const,name:'Codex',identityService:'openai' as const,
  capabilities:{login:true,nativeAccounts:true,localApi:true,models:true,contextWindow:true,fast:true,
    launchModes:['desktop','cli'] as const,projectDirectoryModes:['cli'] as const}
},claudeCodeClient] as const

/** Descriptors used by diagnostics and compatibility checks, not creation UI. */
export const plannedAgentClients = [] as const

export function getAgentClient(value:unknown) {
  const type=resolveAgentClientType(value)
  if(type==='claude_code')return claudeCodeClient
  return implementedAgentClients[0]
}

/** The view includes the effective inherited/default proxy without exposing its credentials. */
export function hasInstanceUpstreamProxy(account:Pick<Account,'egressProxy'>|undefined):boolean {
  const proxy=account?.egressProxy
  return !!proxy&&(!!proxy.invalid||proxy.mode==='custom'||proxy.mode==='resource'||!!proxy.protocol||!!proxy.server||!!proxy.catalog)
}

/** Recommendation for a new draft only; persisted/legacy modes must not be migrated. */
export function recommendedInstanceConnectionMode(clientType:unknown,account:Pick<Account,'kind'|'egressProxy'>|undefined):'native'|'local_api' {
  const client=getAgentClient(clientType)
  return clientType==='claude_code'||client.capabilities.nativeAccounts&&account?.kind==='oauth'?'native':'local_api'
}

export interface AccountCompatibility {compatible:boolean;reason?:string}
export interface AccountCompatibilityOptions {connectionMode:'local_api'|'native'|'client_login';model?:string}
/** Static capability check; live credential ownership, proxies and refresh locks stay in their services. */
export function accountCompatibility(clientType:unknown,account:Pick<Account,'kind'|'wireApi'|'models'|'identityService'|'credentialKind'|'protocol'>,options:AccountCompatibilityOptions):AccountCompatibility {
  if(options.connectionMode==='client_login')return {compatible:false,reason:'Claude Desktop 在客户端内独立登录，不绑定管理器中的 API 或 CLI 订阅凭据'}
  let type:AgentClientType
  try {type=resolveAgentClientType(clientType)}catch(error){return {compatible:false,reason:error instanceof Error?error.message:'客户端尚未接入'}}
  if(type==='claude_code') {
    if(account.identityService!=='anthropic')return {compatible:false,reason:'Claude Code 只能使用 Anthropic 身份或兼容网关凭据，不能复用 OpenAI 账号'}
    if(account.protocol!=='anthropic_messages')return {compatible:false,reason:'Claude Code 需要 Anthropic Messages 协议，不能复用 OpenAI 协议账号'}
    const kind=account.credentialKind as ClaudeCodeCredentialKind|undefined
    if(options.connectionMode==='local_api')return {compatible:false,reason:'Claude Code 当前不支持管理器本地 API 转换，请使用 CLI 原生连接'}
    if(account.kind==='api_key'&&!['anthropic_api_key','anthropic_bearer','gateway'].includes(kind??''))return {compatible:false,reason:'此 API 凭据未声明为 Anthropic Messages 连接'}
    if(account.kind==='oauth')return {compatible:false,reason:'Claude 订阅登录与刷新仍在独立验证；当前请选择 API Key 或 Bearer 连接'}
    if(account.kind==='agent_identity')return {compatible:false,reason:'Agent Identity 仅适用于其所属身份服务，不能用于 Claude Code'}
    if(!['oauth','api_key'].includes(account.kind))return {compatible:false,reason:'Claude Code 凭据类型尚未接入'}
    if(options.model!==undefined&&account.models.length>0&&!account.models.includes(options.model))return {compatible:false,reason:'账号未声明支持当前 Claude 模型'}
    return {compatible:true}
  }
  if(account.identityService!==undefined&&account.identityService!=='openai')return {compatible:false,reason:'Codex 只能使用 OpenAI 身份服务账号'}
  if(!['oauth','api_key','agent_identity'].includes(account.kind))return {compatible:false,reason:'此凭据类型尚未接入 Codex'}
  if(options.connectionMode==='native') {
    if(account.kind==='agent_identity')return {compatible:false,reason:'Agent Identity 仅支持本地 API 接入，请切换实例的账号接入方式'}
    if(account.kind==='api_key'&&(account.wireApi!=='responses'||options.model!==undefined&&!account.models.includes(options.model)))
      return {compatible:false,reason:'原生 API 接入需要 Responses 协议和账号支持的模型，请改用本地 API 或调整模型'}
  }
  // The local sidecar supports Responses and Chat Completions, including the
  // existing explicit custom-model override. It does not duplicate a key.
  return {compatible:true}
}
