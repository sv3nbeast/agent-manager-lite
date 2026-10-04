import {z} from 'zod'
import {strategyChangeSchema,type StrategyKind} from './proxyStrategy'
const id=z.string().uuid(),revision=z.number().int().nonnegative(),item=z.string().regex(/^[a-f\d]{24}$/)
const name=z.string().trim().min(1).max(80).refine(v=>!/[\p{Cc}]|:\/\/|token=|password=/iu.test(v))
const selections=z.record(item,z.string().min(1).max(256)).refine(v=>Object.keys(v).length<=512)
const ref={sourceId:id,revision},choice={...ref,itemId:item,selections}
export const catalogChangeSchema=z.discriminatedUnion('action',[
 strategyChangeSchema,
 z.object({action:z.literal('import'),name,input:z.string().min(1).max(2*1024*1024)}).strict(),
 z.object({action:z.literal('replace'),...ref,input:z.string().min(1).max(2*1024*1024)}).strict(),
 z.object({action:z.literal('rename'),...ref,name}).strict(),
 z.object({action:z.literal('auto-update'),...ref,enabled:z.boolean()}).strict(),
 z.object({action:z.literal('remove'),...ref}).strict(),
 z.object({action:z.literal('default'),...choice}).strict(),
 z.object({action:z.literal('clear-default'),...ref}).strict(),
 z.object({action:z.literal('bind'),...choice,name,resourceId:id.optional(),resourceRevision:revision.optional()}).strict(),
 z.object({action:z.literal('tls'),...ref,itemId:item,group:z.boolean(),allow:z.boolean()}).strict()
])
export type CatalogChange=z.infer<typeof catalogChangeSchema>
export const catalogPageSchema=z.object({sourceId:id.optional(),revision:revision.optional(),ticket:id.optional(),kind:z.enum(['nodes','groups','issues']),itemId:item.optional(),page:z.number().int().min(1).max(10000),pageSize:z.number().int().min(1).max(50).default(25),query:z.string().max(256).default('')}).strict().refine(v=>!!v.sourceId!==!!v.ticket)
export type CatalogPageInput=z.input<typeof catalogPageSchema>
export const catalogResolveSchema=z.object({...choice,page:z.number().int().min(1).max(10000).default(1),query:z.string().max(256).default('')}).strict()
export type CatalogResolveInput=z.input<typeof catalogResolveSchema>
export interface SubscriptionUsage {upload:number;download:number;total:number;expireAt?:number;at:number}
export interface CatalogSourceView {id:string;revision:number;name:string;kind:'manual'|'subscription'|'strategy';strategyKind?:StrategyKind;nodes:number;groups:number;invalid:number;updatedAt:number;default?:{itemId:string;selections:Record<string,string>};defaultInvalidated:boolean;resources:number;autoUpdate?:boolean;lastAttemptAt?:number;error?:string;usage?:SubscriptionUsage}
export const subscriptionRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('import'),requestId:id,name:name.optional(),url:z.string().min(1).max(8192)}).strict(),
 z.object({action:z.literal('refresh'),requestId:id,...ref}).strict()
])
export type SubscriptionRequest=z.infer<typeof subscriptionRequestSchema>
export interface SubscriptionJob {id:string;sourceId?:string;phase:'fetching'|'preview'|'completed'|'failed'|'cancelled';receivedBytes:number;totalBytes?:number;error?:string;preview?:CatalogPreview}
export interface CatalogRow {id:string;name:string;kind:'node'|'group'|'issue';protocol?:string;error?:string;memberCount?:number;issueCount?:number;insecure?:boolean;tlsAllowed?:boolean}
export interface CatalogPage {page:number;pageSize:number;total:number;rows:CatalogRow[]}
export interface CatalogResolution {ready:boolean;name:string;nodes?:number;groups?:number;selection?:{id:string;name:string;page:number;total:number;options:{name:string;error?:string}[]}}
export interface CatalogPreview {ticket:string;action:CatalogChange['action'];name:string;nodes:number;groups:number;invalid:number;affected:{id:string;name:string}[];busy:{id:string;name:string}[];resourceCount:number;invalidResources:number;clearsBindings:number;disablesUnified:boolean;tlsNames?:string[];tlsAllow?:boolean;autoUpdate?:boolean;duplicateNames?:string[];strategyNames?:string[];deferredUnified?:boolean}
export const catalogErrors:Record<string,string>={
 SUBSCRIPTION_INVALID:'目录格式无效，或超出解析限制',SUBSCRIPTION_TOO_LARGE:'目录内容不能超过 2 MiB',SUBSCRIPTION_DUPLICATE_NAME:'节点或分组名称重复，请先修改来源',PROXY_UNSUPPORTED_OPTION:'含有不支持的协议或选项',PROXY_TLS_INSECURE:'来源关闭了证书校验，尚未明确许可',SUBSCRIPTION_GROUP_STRATEGY:'不支持此分组策略',SUBSCRIPTION_PROVIDER_UNSUPPORTED:'此分组依赖未支持的远程节点提供者',SUBSCRIPTION_GROUP_OPTIONS:'分组参数不受支持或格式无效',SUBSCRIPTION_GROUP_MEMBER_MISSING:'分组引用了不存在的成员',SUBSCRIPTION_GROUP_MEMBER_UNSUPPORTED:'分组含有不可用成员',SUBSCRIPTION_GROUP_CYCLE:'分组存在循环引用',PROXY_RESOURCE_SELECTION_REQUIRED:'请明确选择手选组的成员',PROXY_RESOURCE_INVALID:'所选资源无效，或运行配置超出限制'
}
