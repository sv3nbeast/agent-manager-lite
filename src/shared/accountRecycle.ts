import {z} from 'zod'
export interface RecycledAccountSummary {id:string;accountId:string;name:string;email?:string;plan?:string;kind:'oauth'|'api_key'|'agent_identity';deletedAt:number}
export interface AccountRecyclePage {snapshotId:string;total:number;page:number;pageSize:number;items:RecycledAccountSummary[]}
export const accountRecyclePageSchema=z.object({snapshotId:z.string().uuid(),page:z.number().int().min(1),pageSize:z.number().int().min(1).max(100).default(25)}).strict()
export const accountRecyclePreviewSchema=z.object({snapshotId:z.string().uuid(),ids:z.array(z.string().uuid()).min(1).max(10000).optional(),all:z.literal(true).optional(),action:z.enum(['restore','export','purge'])}).strict().refine(value=>value.all?!value.ids:!!value.ids,'请选择账号或当前全部记录')
export type AccountRecycleInput=z.infer<typeof accountRecyclePreviewSchema>
export interface AccountRecyclePreview {ticket:string;action:AccountRecycleInput['action'];count:number;names:string[]}
export const accountRecycleApplySchema=z.object({ticket:z.string().uuid(),confirmed:z.literal(true),exportFirst:z.boolean().default(false)}).strict()
export interface AccountRecycleResult {count:number;exported:number;cancelled:boolean}
