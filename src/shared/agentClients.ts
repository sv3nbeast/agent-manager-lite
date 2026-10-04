import { z } from 'zod'
import type { Account } from './types'

export const agentClientTypeSchema = z.literal('codex')
export type AgentClientType = z.infer<typeof agentClientTypeSchema>

/** Missing fields belong to legacy Codex records; explicit values never fall back. */
export function resolveAgentClientType(value:unknown):AgentClientType {
  if(value===undefined)return 'codex'
  if(!agentClientTypeSchema.safeParse(value).success)throw new Error('此客户端尚未接入，请选择当前支持的 Codex')
  return 'codex'
}

export const implementedAgentClients = [{
  id:'codex' as const,name:'Codex',identityService:'openai' as const,
  capabilities:{login:true,nativeAccounts:true,localApi:true,models:true,contextWindow:true,fast:true,
    launchModes:['desktop','cli'] as const,projectDirectoryModes:['cli'] as const}
}] as const

export function getAgentClient(value:unknown) {
  resolveAgentClientType(value)
  return implementedAgentClients[0]
}

export interface AccountCompatibility {compatible:boolean;reason?:string}
export interface AccountCompatibilityOptions {connectionMode:'local_api'|'native';model?:string}
/** Static capability check; live credential ownership, proxies and refresh locks stay in their services. */
export function accountCompatibility(clientType:unknown,account:Pick<Account,'kind'|'wireApi'|'models'>,options:AccountCompatibilityOptions):AccountCompatibility {
  try {resolveAgentClientType(clientType)}catch(error){return {compatible:false,reason:error instanceof Error?error.message:'客户端尚未接入'}}
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
