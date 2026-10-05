import { z } from 'zod'

export const providerIdSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/)
const text = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
export const providerURLSchema = z.string().trim().max(2000).url().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
})
export const providerFields = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'supports_websockets', 'supports_standalone_web_search',
  'env_key', 'env_key_instructions', 'experimental_bearer_token', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'] as const
export const providerChangesSchema = z.object({
  name: text.optional(), base_url: providerURLSchema.optional(), wire_api: z.literal('responses').optional(),
  supports_websockets: z.boolean().nullable().optional(), supports_standalone_web_search: z.boolean().nullable().optional(),
  request_max_retries: z.number().int().min(0).max(100).nullable().optional(),
  stream_max_retries: z.number().int().min(0).max(100).nullable().optional(),
  stream_idle_timeout_ms: z.number().int().min(1).max(3_600_000).nullable().optional()
}).strict()
export const providerAuthSchema = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('keep')}).strict(),
  z.object({mode:z.literal('none')}).strict(),
  z.object({mode:z.literal('openai')}).strict(),
  z.object({mode:z.literal('environment'),envKey:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),instructions:z.string().max(1000).optional()}).strict(),
  z.object({mode:z.literal('token'),token:z.string().trim().min(1).max(10000).refine(value=>!/[\u0000-\u001f\u007f]/.test(value))}).strict(),
  z.object({mode:z.literal('account'),accountId:z.string().uuid()}).strict()
])
export const previewProviderSchema = z.object({
  id:z.string().uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/),providerId:providerIdSchema,
  create:z.boolean(),changes:providerChangesSchema,auth:providerAuthSchema,
  makeDefault:z.boolean().default(false),serviceTier:z.enum(['fast','default','auto','flex']).nullable().optional()
}).strict().superRefine((input,ctx)=>{
  if(input.create && (!input.changes.name || !input.changes.base_url))ctx.addIssue({code:'custom',path:['changes'],message:'新 Provider 需要名称和地址'})
  if(input.serviceTier!==undefined && !input.makeDefault)ctx.addIssue({code:'custom',path:['serviceTier'],message:'请先设为默认 Provider'})
})
export type ProviderConfigInput = z.input<typeof previewProviderSchema>
export type ProviderChanges = z.infer<typeof providerChangesSchema>
export interface ProviderConfigEntry {
  id:string; values:ProviderChanges; wireApi:string|null; selected:boolean; bearerConfigured:boolean
  authMode:'none'|'environment'|'token'|'openai'|'custom'; envKey?:string; commandAuth:boolean
  extraFields:string[]; invalidFields:string[]
}
export interface ProviderConfigView {
  revision:string; providers:ProviderConfigEntry[]
  accounts:{id:string;name:string;baseUrl:string;wireApi:'responses'|'chat_completions'}[]
}
export function providerChangeLabel(key:string):string {
  if(key==='model_provider')return '默认 Provider'
  if(key==='service_tier')return '默认服务等级'
  const names:Record<string,string>={name:'显示名称',base_url:'服务地址',wire_api:'请求协议',requires_openai_auth:'使用 OpenAI 登录态',supports_websockets:'WebSocket 支持',supports_standalone_web_search:'独立网页搜索支持',env_key:'密钥环境变量',env_key_instructions:'环境变量说明',experimental_bearer_token:'Bearer 密钥',request_max_retries:'HTTP 重试次数',stream_max_retries:'流式重试次数',stream_idle_timeout_ms:'流式空闲超时'}
  const split=key.lastIndexOf('.')
  return key.startsWith('model_providers.')?`${key.slice('model_providers.'.length,split)} · ${names[key.slice(split+1)]??key.slice(split+1)}`:key
}
