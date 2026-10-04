import {z} from 'zod'

export const backupPasswordSchema=z.string().min(8).max(1024)
export const backupRequestSchema=z.object({requestId:z.string().uuid(),password:backupPasswordSchema}).strict()
export interface BackupCounts {accounts:number;groups:number;providers:number;localKeys:number;instances:number;recycledAccounts:number}
export interface BackupPreview {
  ticket:string;fileName:string;exportedAt:number;incoming:BackupCounts;current:BackupCounts
  sourceConnections:number;sourceDirectories:number
}
export interface BackupResult {path:string;counts:BackupCounts}
export interface BackupRestoreResult {rollbackPath:string;counts:BackupCounts;restartRequired:true}
