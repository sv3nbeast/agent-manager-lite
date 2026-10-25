import {lstat,realpath,readdir} from 'node:fs/promises'
import {basename,join,relative,sep} from 'node:path'
import {instanceStorageCategorySchema,type InstanceStorageCategory,type InstanceStorageCategoryUsage,type InstanceStorageInventory,type InstanceStorageRow} from '../shared/instanceStorage'
import type {InstanceProfile} from '../shared/instances'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const excludedRoots=new Set(['node_modules'])
export interface InstanceStorageScanLimits {maxFiles?:number;maxDirectories?:number;maxDepth?:number;timeoutMs?:number}
class StorageScanLimitError extends Error{}
function category(path:string):InstanceStorageCategory {
  const parts=path.split(/[\/]+/).filter(Boolean)
  const root=parts[0]?.toLowerCase()??''
  const name=parts.at(-1)?.toLowerCase()??''
  if(parts.some(part=>part.toLowerCase()==='workspace'))return 'workspace'
  if(/^state_\d+\.sqlite(?:-(?:wal|shm|journal))?$/i.test(name)||/^thread_history_\d+\.sqlite(?:-(?:wal|shm|journal))?$/i.test(name))return 'databases'
  if(root==='sessions'||root==='archived_sessions'||['history.jsonl','session_index.jsonl','transcription-history.jsonl','.codex-global-state.json'].includes(name)||/\.jsonl$/i.test(name))return 'sessions'
  if(root==='skills'||root==='prompts'||parts.some(part=>part.toLowerCase()==='skills'))return 'skills'
  if(['desktop','logs','cache','caches','tmp','temp','runtime'].some(part=>parts.some(value=>value.toLowerCase()===part))||/\.(?:log|cache)$/i.test(name))return 'cache'
  if(/\.(?:toml|json|yaml|yml|plist|conf|ini)$/i.test(name)||name==='auth.json')return 'config'
  return 'other'
}
type CategoryTotal={logicalBytes:number;filesystemBlocksBytes:number;files:number}
type Totals={logicalBytes:number;filesystemBlocksBytes:number;files:number;categories:Map<InstanceStorageCategory,CategoryTotal>}
function totals():Totals{return {logicalBytes:0,filesystemBlocksBytes:0,files:0,categories:new Map()}}
function addFile(row:Totals,kind:InstanceStorageCategory,size:number,blocks:number):void{
  row.logicalBytes+=size;row.files++;row.filesystemBlocksBytes+=blocks*512
  const bucket=row.categories.get(kind)??{logicalBytes:0,filesystemBlocksBytes:0,files:0}
  bucket.logicalBytes+=size;bucket.filesystemBlocksBytes+=blocks*512;bucket.files++;row.categories.set(kind,bucket)
}
function result(row:Totals):{logicalBytes:number;filesystemBlocksBytes:number;files:number;categories:InstanceStorageCategoryUsage[]}{
  return {logicalBytes:row.logicalBytes,filesystemBlocksBytes:row.filesystemBlocksBytes,files:row.files,categories:[...row.categories].map(([category,value])=>({category,...value}))}
}
async function scanTree(folder:string,relativeRoot:string,row:Totals,overall:Totals,warnings:string[],visited:Set<string>,budget:{files:number;directories:number;deadline:number;maxFiles:number;maxDirectories:number;maxDepth:number}):Promise<void>{
  if(Date.now()>budget.deadline)throw new StorageScanLimitError('存储扫描达到时间上限，已停止；可先处理超大实例目录后重新扫描')
  if(relativeRoot.split(sep).filter(Boolean).length>budget.maxDepth)throw new StorageScanLimitError('目录嵌套超过安全扫描深度，已停止扫描')
  if(++budget.directories>budget.maxDirectories)throw new StorageScanLimitError('实例目录数量超过安全扫描上限，已停止扫描')
  const rootStat=await lstat(folder)
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||await realpath(folder)!==folder)throw new Error('目录不是安全的普通目录')
  const rootKey=String(rootStat.dev)+':'+String(rootStat.ino)
  if(visited.has(rootKey)){warnings.push('检测到重复目录身份，跳过：'+relativeRoot);return}
  visited.add(rootKey)
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const child=join(folder,entry.name),rel=relativeRoot?relativeRoot+sep+entry.name:entry.name
    try{
      if(Date.now()>budget.deadline)throw new StorageScanLimitError('存储扫描达到时间上限，已停止；可先处理超大实例目录后重新扫描')
      const stat=await lstat(child)
      if(stat.isSymbolicLink())continue
      if(stat.isDirectory()){
        if(excludedRoots.has(entry.name.toLowerCase())||entry.name.toLowerCase()==='.git')continue
        await scanTree(child,rel,row,overall,warnings,visited,budget)
      }else if(stat.isFile()){
        if(++budget.files>budget.maxFiles)throw new StorageScanLimitError('文件数量超过安全扫描上限，已停止扫描；可缩小实例数据范围后重试')
        const bytes=stat.size,blocks=typeof stat.blocks==='number'?stat.blocks:Math.ceil(bytes/512),kind=category(rel)
        addFile(row,kind,bytes,blocks);addFile(overall,kind,bytes,blocks)
      }
    }catch(error){if(error instanceof StorageScanLimitError||error instanceof Error&&error.message.includes('安全扫描上限'))throw error;if(warnings.length<100)warnings.push('无法读取 '+rel+'：'+(error instanceof Error?error.message:'未知错误'))}
  }
  if(Date.now()>budget.deadline)throw new StorageScanLimitError('存储扫描达到时间上限，已停止；可先处理超大实例目录后重新扫描')
  const after=await lstat(folder)
  if(after.isSymbolicLink()||!after.isDirectory()||after.dev!==rootStat.dev||after.ino!==rootStat.ino||await realpath(folder)!==folder)throw new Error('扫描期间目录身份发生变化，已停止读取')
}

/** Read-only scan of manager-owned instance homes and legacy instance-trash entries. */
export async function scanInstanceStorage(root:string,profiles:InstanceProfile[],capturedAt=Date.now(),limits:InstanceStorageScanLimits={}):Promise<InstanceStorageInventory>{
  const rootStat=await lstat(root)
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||await realpath(root)!==root)throw new Error('管理器数据目录身份异常，已取消存储扫描')
  const budget={files:0,directories:0,deadline:Date.now()+(limits.timeoutMs??30_000),maxFiles:limits.maxFiles??250_000,maxDirectories:limits.maxDirectories??50_000,maxDepth:limits.maxDepth??64}
  if(!Number.isSafeInteger(budget.maxFiles)||budget.maxFiles<1||!Number.isSafeInteger(budget.maxDirectories)||budget.maxDirectories<1||!Number.isSafeInteger(budget.maxDepth)||budget.maxDepth<1||!Number.isSafeInteger(limits.timeoutMs??30_000)||(limits.timeoutMs??30_000)<1)throw new Error('存储扫描限制参数无效')
  const rows:InstanceStorageRow[]=[],warnings:string[]=[],overall=totals()
  const limitResult=():InstanceStorageInventory=>({capturedAt,logicalBytes:overall.logicalBytes,filesystemBlocksBytes:overall.filesystemBlocksBytes,allocatedEstimateConfidence:'low',files:overall.files,rows,warnings,notes:['扫描因安全上限停止；当前数字是已扫描部分，不是完整总量。','扫描仅包含管理器拥有的实例目录与 instance-trash；外部目录、工作区、钥匙串、账号数据和链接均不扫描。','filesystemBlocksBytes 根据文件系统块数估算；APFS 克隆、压缩、硬链接和系统快照会造成共享，不能视为准确可回收空间。','旧 instance-trash 没有来源 manifest，只作为 legacy 归档展示；本功能不会修改、恢复或删除任何内容。']})
  try{for(const profile of profiles){
    if(profile.externalHome||!uuid.test(profile.id))continue
    const directory=join(root,'instances',profile.id),rowTotals=totals()
    try{
      const stat=await lstat(directory)
      if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(directory)!==directory)throw new Error('不是受管实例的规范目录')
      await scanTree(directory,'',rowTotals,overall,warnings,new Set(),budget)
      rows.push({id:profile.id,kind:'managed',name:profile.name,directory,...result(rowTotals),allocatedEstimateConfidence:'low'})
    }catch(error){if(error instanceof StorageScanLimitError){rows.push({id:profile.id,kind:'managed',name:profile.name,directory,...result(rowTotals),allocatedEstimateConfidence:'low',warning:'此实例只完成部分扫描'});throw error}warnings.push('无法盘点实例 '+profile.name+'：'+(error instanceof Error?error.message:'未知错误'))}
  }}catch(error){if(error instanceof StorageScanLimitError){warnings.push(error.message);return limitResult()}throw error}
  const trash=join(root,'instance-trash')
  try{
    const trashStat=await lstat(trash)
    if(trashStat.isSymbolicLink()||!trashStat.isDirectory()||await realpath(trash)!==trash)throw new Error('实例归档目录不是管理器拥有的普通目录')
    for(const entry of await readdir(trash,{withFileTypes:true})){
      if(Date.now()>budget.deadline)throw new StorageScanLimitError('存储扫描达到时间上限，已停止；可先处理超大实例目录后重新扫描')
      if(!entry.isDirectory()||entry.isSymbolicLink())continue
      const archived=entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d{13})$/i)
      const incomplete=entry.name.match(/^incomplete-copy-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)
      if(!archived&&!incomplete){warnings.push('跳过未识别格式的归档目录：'+entry.name);continue}
      const directory=join(trash,entry.name),rowTotals=totals()
      try{
        const stat=await lstat(directory)
        if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(directory)!==directory)continue
        await scanTree(directory,'',rowTotals,overall,warnings,new Set(),budget)
        rows.push({id:archived?archived[1]:'incomplete-'+incomplete![1]+'-'+incomplete![2],kind:'legacy_trash',name:basename(entry.name),directory,...result(rowTotals),allocatedEstimateConfidence:'low',...(archived?{createdAt:Number(archived[2]),warning:'旧归档没有来源清单；仅显示，不支持通过存储清单恢复或清理'}:{warning:'未完成复制的旧归档缺少清单；仅显示，不支持通过存储清单恢复或清理'})})
      }catch(error){if(error instanceof StorageScanLimitError){rows.push({id:archived?archived[1]:'incomplete-'+incomplete![1]+'-'+incomplete![2],kind:'legacy_trash',name:basename(entry.name),directory,...result(rowTotals),allocatedEstimateConfidence:'low',warning:'此归档只完成部分扫描，来源元数据不可用'});throw error}warnings.push('无法盘点旧归档 '+entry.name+'：'+(error instanceof Error?error.message:'未知错误'))}
    }
  }catch(error){if(error instanceof StorageScanLimitError){warnings.push(error.message);return limitResult()}if((error as NodeJS.ErrnoException).code!=='ENOENT')warnings.push('无法读取实例归档目录：'+(error instanceof Error?error.message:'未知错误'))}
  rows.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name))
  return {capturedAt,logicalBytes:overall.logicalBytes,filesystemBlocksBytes:overall.filesystemBlocksBytes,allocatedEstimateConfidence:'low',files:overall.files,rows,warnings,notes:['扫描仅包含管理器拥有的实例目录与 instance-trash；外部目录、工作区、钥匙串、账号数据和链接均不扫描。','filesystemBlocksBytes 根据文件系统块数估算；APFS 克隆、压缩、硬链接和系统快照会造成共享，不能视为准确可回收空间。','旧 instance-trash 没有来源 manifest，只作为 legacy 归档展示；本功能不会修改、恢复或删除任何内容。']}
}
