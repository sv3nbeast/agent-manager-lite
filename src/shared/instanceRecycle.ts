import { z } from 'zod'
import type { InstanceProfile } from './instances'

export const instanceArchiveManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  archivedAt: z.number().int().positive(),
  profile: z.record(z.unknown()),
  externalHome: z.object({ directory: z.string().min(1), device: z.number().int().nonnegative(), inode: z.number().int().nonnegative(), previousTargetName: z.string().optional() }).optional(),
}).strict()
export type InstanceArchiveManifest = z.infer<typeof instanceArchiveManifestSchema>

export interface InstanceArchiveView {
  id: string
  directory: string
  name: string
  archivedAt: number
  profile?: InstanceProfile
  recoverable: boolean
  externalHome?: { directory: string; device: number; inode: number }
  warning?: string
}

export const instanceArchiveSelectionSchema = z.object({ id: z.string().uuid(), directory: z.string().min(1).max(4096) }).strict()
export type InstanceArchiveSelection = z.infer<typeof instanceArchiveSelectionSchema>
