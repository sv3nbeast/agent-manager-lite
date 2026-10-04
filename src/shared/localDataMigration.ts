import {z} from 'zod'
import type {Account,AppSnapshot} from './types'

export const localDataSelectionSchema=z.object({scanId:z.string().uuid(),sourceIds:z.array(z.string().uuid()).min(1).max(30)}).strict()
export const localDataApplySchema=z.object({ticket:z.string().uuid(),confirmed:z.literal(true)}).strict()
export interface LocalDataSource {
  id:string;name:string;path:string;format:'account_library'|'native_client'|'portable'
  accounts:number;providers:number;groups:number;issues:string[]
}
export interface LocalDataScan {scanId:string;sources:LocalDataSource[]}
export interface LocalDataCounts {addedAccounts:number;duplicateAccounts:number;addedProviders:number;mergedProviders:number;addedKeys:number;addedGroups:number;mergedGroups:number}
export interface LocalDataPreview {
  ticket:string;expiresAt:number;newArchive:boolean;sources:LocalDataSource[];counts:LocalDataCounts
  accounts:{name:string;kind:Account['kind'];defaultTier?:Account['defaultTier'];action:'add'|'duplicate'}[]
  providers:{name:string;baseUrl:string;models:number;keys:number;action:'add'|'merge'|'duplicate'|'conflict'}[]
  warnings:string[];errors:string[];preservedFiles:number
}
export interface LocalDataResult extends LocalDataCounts {snapshot:AppSnapshot}
