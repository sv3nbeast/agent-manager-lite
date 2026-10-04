import {z} from 'zod'
const id=z.string().uuid(),itemId=z.string().min(1).max(64)
export const strategyKinds=['select','fallback','url-test','load-balance'] as const
export type StrategyKind=typeof strategyKinds[number]
export const strategyLabels:Record<StrategyKind,string>={select:'手动选择',fallback:'故障转移','url-test':'自动测速选择','load-balance':'负载均衡'}
export const strategyHints:Record<StrategyKind,string>={select:'绑定出口时明确选择一个成员。',fallback:'按成员顺序使用可用节点，前项恢复后优先使用前项。','url-test':'定期检测成员，按延迟与容差选择可用节点。','load-balance':'由引擎按连接目标分配节点，同一次连接不会拆分。'}
export const strategyFields:Record<StrategyKind,readonly string[]>={select:[],fallback:['url','interval','timeout','lazy'],'url-test':['url','interval','timeout','tolerance','lazy'],'load-balance':['url','interval','lazy']}
const healthURL=z.string().max(2048).refine(raw=>{if(/[\p{Cc}]/u.test(raw))return false;if(!raw.trim())return true;try{const url=new URL(raw.trim());return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password&&!raw.includes('#')&&!/[\p{Cc}]/u.test(raw)}catch{return false}},'健康检查地址须为不含凭据或片段的 HTTP / HTTPS URL').transform(raw=>raw.trim())
export const strategyOptionsSchema=z.object({url:healthURL.optional(),interval:z.number().int().min(30).max(3600).optional(),timeout:z.number().int().min(1).max(30).optional(),tolerance:z.number().int().min(0).max(1000).optional(),lazy:z.boolean().optional()}).strict()
export type StrategyOptions=z.infer<typeof strategyOptionsSchema>
export interface StrategyMember {sourceId:string;itemId:string}
export interface StrategyRecord extends StrategyMember {name:string;sourceName:string}
export const strategyChangeSchema=z.object({action:z.literal('strategy'),sourceId:id.optional(),revision:z.number().int().nonnegative().optional(),name:z.string().trim().min(1).max(80).refine(s=>!/[\p{Cc}]|:\/\//u.test(s)),kind:z.enum(strategyKinds),members:z.array(z.object({sourceId:id,itemId}).strict()).min(1).max(64).refine(a=>new Set(a.map(m=>JSON.stringify([m.sourceId,m.itemId]))).size===a.length),options:strategyOptionsSchema}).strict()
export type StrategyChange=z.infer<typeof strategyChangeSchema>
export const strategyCandidatesSchema=z.object({sourceId:id.optional(),query:z.string().max(256).default(''),page:z.number().int().min(1).max(10000).default(1)}).strict()
export type StrategyCandidatesInput=z.input<typeof strategyCandidatesSchema>
export interface StrategyCandidate extends StrategyRecord {protocol:string;server?:string;port?:number;notice:boolean}
export interface StrategyCandidates {page:number;total:number;rows:StrategyCandidate[]}
export interface StrategyEditorMember extends StrategyRecord {available:boolean;savedCopy:boolean}
export interface StrategyEditor {sourceId:string;revision:number;name:string;kind:StrategyKind;options:StrategyOptions;members:StrategyEditorMember[]}
