import {lstatSync,realpathSync} from 'node:fs'
import {isAbsolute,join,relative,sep} from 'node:path'
import {z} from 'zod'
import type {ExternalInstanceHome,InstanceProfile} from '../shared/instances'

export const pathContains=(parent:string,child:string):boolean=>{
  const path=relative(parent,child)
  return path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)
}
export const instanceHomePath=(root:string,profile:InstanceProfile):string=>profile.externalHome?.directory??join(root,'instances',profile.id,'home')
export function validateExternalHome(root:string,home:ExternalInstanceHome):string {
  const parsed=z.object({directory:z.string().min(1),device:z.number().int().nonnegative(),inode:z.number().int().nonnegative(),previousTargetName:z.string().optional()}).strict().parse(home)
  if(!isAbsolute(parsed.directory)||pathContains(root,parsed.directory)||pathContains(parsed.directory,root))throw new Error('外部实例目录与管理器目录重叠，已保留恢复记录')
  const stat=lstatSync(parsed.directory)
  if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(parsed.directory)!==parsed.directory||stat.dev!==parsed.device||stat.ino!==parsed.inode)throw new Error('外部实例目录已被替换，尚未写入或恢复文件；请恢复原目录后重试')
  return parsed.directory
}
