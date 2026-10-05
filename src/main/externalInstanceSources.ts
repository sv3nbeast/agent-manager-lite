// Discover profile metadata only. Account files and conversation bodies are not
// needed to offer a copy source, and must not be read by this scanner.
import {constants,closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync,type Stats} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {z} from 'zod'
import {probeClientDaemon,type ClientDaemonState} from './clientDaemon'
import type {ExternalInstanceDiscovery,ExternalInstanceSource,InstanceCopySource} from '../shared/instances'

const MAX_REGISTRY_BYTES=4*1024*1024,MAX_RECORDS=1000,MAX_SOURCES=200,LIFETIME=5*60_000
const selectionSchema=z.object({id:z.string().uuid()}).strict()
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined
const cleanText=(value:unknown,max:number):string|undefined=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():undefined
const contains=(root:string,path:string)=>{const suffix=relative(root,path);return suffix===''||suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix)}
const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT'
const sameIdentity=(a:Stats,b:{device:number;inode:number})=>a.dev===b.device&&a.ino===b.inode

interface RegistryMark {path:string;device:number;inode:number;digest:string}
interface Candidate {view:ExternalInstanceSource;device:number;inode:number;registry?:RegistryMark;pid?:number}
interface Capability extends Candidate {expires:number}
export interface ExternalInstanceSourceOptions {
  managerRoot:string
  managedDirectories?:()=>readonly string[]
  home?:string
  platform?:NodeJS.Platform
  now?:()=>number
  probeDaemon?:(directory:string)=>Promise<ClientDaemonState>
  pidAlive?:(pid:number)=>boolean
}

function safeDirectory(path:string):Stats {
  if(!isAbsolute(path)||resolve(path)!==path)throw new Error('unsafe directory')
  let current=path
  for(;;){const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('unsafe directory');const parent=dirname(current);if(parent===current)break;current=parent}
  if(realpathSync(path)!==path)throw new Error('unsafe directory')
  return lstatSync(path)
}
function metadata(path:string):{value:Record<string,unknown>;mark:RegistryMark} {
  safeDirectory(dirname(path))
  const before=lstatSync(path)
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_REGISTRY_BYTES)throw new Error('unsafe metadata')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const opened=fstatSync(fd)
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>MAX_REGISTRY_BYTES)throw new Error('changed metadata')
    const buffer=Buffer.alloc(opened.size+1);let length=0
    while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count}
    const raw=buffer.subarray(0,length),after=fstatSync(fd),named=lstatSync(path)
    if(raw.length>MAX_REGISTRY_BYTES||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs||named.isSymbolicLink()||named.dev!==opened.dev||named.ino!==opened.ino)throw new Error('changed metadata')
    const value=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)))
    if(!value||!Array.isArray(value.instances)||value.instances.length>MAX_RECORDS)throw new Error('unsupported metadata')
    return {value,mark:{path,device:opened.dev,inode:opened.ino,digest:createHash('sha256').update(raw).digest('hex')}}
  }finally{closeSync(fd)}
}
function profilePresent(path:string):boolean {
  return ['config.toml','sessions','archived_sessions','skills','.codex-global-state.json','state_5.sqlite','auth.json'].some(name=>{
    try{const stat=lstatSync(join(path,name));return !stat.isSymbolicLink()&&(stat.isFile()||stat.isDirectory())}catch{return false}
  })
}

export class ExternalInstanceSources {
  private generation=0
  private capabilities=new Map<string,Capability>()
  private readonly now:()=>number
  constructor(private readonly options:ExternalInstanceSourceOptions){this.now=options.now??Date.now}
  clear():void {this.generation++;this.capabilities.clear()}
  private excluded(path:string):boolean {
    return [this.options.managerRoot,...this.options.managedDirectories?.()??[]].some(value=>{
      const root=resolve(value);return contains(root,path)||contains(path,root)
    })
  }
  private roots():{path:string;name:string}[] {
    const home=resolve(this.options.home??homedir()),platform=this.options.platform??process.platform
    const legacy=platform==='darwin'?join(home,'Library','Application Support','com.antigravity.cockpit-tools'):platform==='win32'?join(home,'AppData','Local','com.antigravity.cockpit-tools'):join(home,'.local','share','com.antigravity.cockpit-tools')
    return [{path:join(home,'.antigravity_cockpit'),name:'本机其他工具'},{path:join(home,'.antigravity_cockpit_dev'),name:'本机其他工具（开发版）'},{path:legacy,name:'本机其他工具（旧版）'}]
  }
  async discover():Promise<ExternalInstanceDiscovery> {
    this.clear();const generation=this.generation,candidates:Candidate[]=[],issues=new Set<string>(),seen=new Set<string>()
    let defaultPid:number|undefined
    const add=(path:unknown,name:unknown,sourceName:string,launchMode:unknown,registry?:RegistryMark,pid?:unknown,clientType?:unknown)=>{
      if(clientType!==undefined&&clientType!=='codex'){issues.add('部分来源使用尚未支持的客户端，未列入列表');return}
      const directory=cleanText(path,4096),title=cleanText(name,120)
      if(!directory||!isAbsolute(directory)||!title||!['app','desktop','cli',undefined].includes(launchMode as string|undefined)){issues.add('部分实例记录格式不受支持，未列入列表');return}
      const canonical=resolve(directory)
      if(this.excluded(canonical)||seen.has(canonical))return
      try{
        const stat=safeDirectory(canonical)
        if(!profilePresent(canonical)){issues.add('部分来源没有可用的 Codex 配置或历史目录，未列入列表');return}
        if(candidates.length>=MAX_SOURCES){issues.add('本机来源超过 200 个，仅显示前 200 个');return}
        seen.add(canonical)
        candidates.push({view:{id:randomUUID(),name:title,directory:canonical,sourceName,clientType:'codex',launchMode:launchMode==='cli'?'cli':'desktop',runtimeState:'unknown'},device:stat.dev,inode:stat.ino,registry,...typeof pid==='number'&&Number.isSafeInteger(pid)&&pid>0?{pid}:{}})
      }catch(error){if(!absent(error))issues.add('部分来源目录无法安全读取，未列入列表')}
    }
    for(const root of this.roots()){
      try{
        const {value,mark}=metadata(join(root.path,'codex_instances.json'))
        const defaults=object(value.defaultSettings)
        if(defaultPid===undefined&&typeof defaults?.lastPid==='number')defaultPid=defaults.lastPid
        for(const raw of value.instances as unknown[]){
          const item=object(raw)
          if(!item){issues.add('部分实例记录格式不受支持，未列入列表');continue}
          if(['clientType','client_type'].some(key=>Object.hasOwn(item,key)&&item[key]!=='codex')){issues.add('部分来源使用尚未支持的客户端，未列入列表');continue}
          add(item.userDataDir,item.name,root.name,item.launchMode,mark,item.lastPid,Object.hasOwn(item,'clientType')?item.clientType:item.client_type)
        }
      }catch(error){if(!absent(error))issues.add(`${root.name}的实例列表无法安全读取，请检查格式、权限和文件大小`)}
    }
    const defaultHome=join(resolve(this.options.home??homedir()),'.codex')
    add(defaultHome,'默认 Codex','本机 Codex','desktop',undefined,defaultPid)
    const probe=this.options.probeDaemon??probeClientDaemon
    const alive=this.options.pidAlive??((pid:number)=>{try{process.kill(pid,0);return true}catch{return false}})
    for(let offset=0;offset<candidates.length;offset+=16){
      if(generation!==this.generation)throw new Error('扫描结果已更新，请重新扫描本机来源')
      await Promise.all(candidates.slice(offset,offset+16).map(async candidate=>{
        try{const state=await probe(candidate.view.directory);candidate.view.runtimeState=state==='running'?'running':state==='not_detected'&&(!candidate.pid||!alive(candidate.pid))?'not_detected':'unknown'}catch{candidate.view.runtimeState='unknown'}
      }))
    }
    if(generation!==this.generation)throw new Error('扫描结果已更新，请重新扫描本机来源')
    const expires=this.now()+LIFETIME
    this.capabilities=new Map(candidates.map(candidate=>[candidate.view.id,{...candidate,expires}]))
    return {sources:candidates.map(candidate=>({...candidate.view})),issues:[...issues]}
  }
  select(raw:unknown,selectDirectory:(directory:string)=>InstanceCopySource):InstanceCopySource {
    const {id}=selectionSchema.parse(raw),source=this.capabilities.get(id)
    if(!source||this.now()>=source.expires)throw new Error('本机来源选择已过期或不存在，请重新扫描')
    try{if(this.excluded(source.view.directory)||!sameIdentity(safeDirectory(source.view.directory),source))throw new Error('changed')}
    catch{throw new Error('本机来源目录已变化或无法安全读取，请重新扫描')}
    if(source.registry){
      try{
        const current=metadata(source.registry.path).mark
        if(current.device!==source.registry.device||current.inode!==source.registry.inode||current.digest!==source.registry.digest)throw new Error('changed')
      }catch{throw new Error('本机实例列表已变化或无法安全读取，请重新扫描')}
    }
    const selected=selectDirectory(source.view.directory)
    return {...selected,name:source.view.name}
  }
}
