import {z} from 'zod'
export const tempCredentialStoreSchema=z.enum(['file','keyring','auto'])
export type TempCredentialStore=z.infer<typeof tempCredentialStoreSchema>
export const startTempLoginSchema=z.object({applicationId:z.string().min(1).max(128),interceptAuthUrl:z.boolean().default(true),credentialStore:tempCredentialStoreSchema.default('file')}).strict()
export type StartTempLogin=z.input<typeof startTempLoginSchema>
export type TempLoginPhase='idle'|'preparing'|'launching'|'waiting-login'|'importing'|'closing'|'cleaning'|'completed'|'failed'|'cancelled'
export interface TempLoginView {
  id?:string;phase:TempLoginPhase;running:boolean;application?:string;expiresAt?:number;pid?:number
  authStatus?:'disabled'|'waiting'|'armed'|'captured'|'unavailable';authUrl?:string
  accountId?:string;email?:string;updated?:boolean;error?:string;notice?:string
  credentialStore?:TempCredentialStore;credentialSource?:'file'|'keyring'
}
export interface TempLoginCleanup {removed:string[];failed:{id:string;error:string}[]}
