import {lstatSync,realpathSync} from 'node:fs'
import {basename,isAbsolute,relative,resolve,sep} from 'node:path'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {StoredCodexSessionSource,Store} from './store'
import {instanceHomePath} from './instancePaths'

export interface CodexSessionSourceView extends StoredCodexSessionSource {enabled:boolean;available:boolean;readOnly:true;issue?:string}
const uuid=z.string().uuid()
const cleanName=(value:string)=>{const name=value.trim();if(!name||name.length>120||/[\x00-\x1f\x7f]/.test(name))throw new Error('会话来源名称无效');return name}
const contains=(parent:string,child:string):boolean=>{const path=relative(parent,child);return path===''||(path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path))}
const overlaps=(a:string,b:string):boolean=>contains(a,b)||contains(b,a)
const existingCanonical=(path:string):string|undefined=>{try{return realpathSync(path)}catch{return undefined}}

/** External Codex homes are registered for read-only session discovery. This service never writes into them. */
export class CodexSessionSources {
  private readonly managerRoot:string
  constructor(private readonly store:Store,private readonly now=Date.now){this.managerRoot=realpathSync(store.directory)}

  register(selectedDirectory:string,name?:string):CodexSessionSourceView {
    if(typeof selectedDirectory!=='string'||!isAbsolute(selectedDirectory)||resolve(selectedDirectory)!==selectedDirectory)throw new Error('请选择规范的绝对会话目录')
    const stat=lstatSync(selectedDirectory)
    if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(selectedDirectory)!==selectedDirectory)throw new Error('会话来源必须是稳定的普通目录，不能使用符号链接')
    const directory=selectedDirectory
    const state=this.store.read()
    const forbidden=[this.managerRoot,...(state.configTargets??[]).map(target=>target.directory),...(state.instances??[]).map(profile=>instanceHomePath(this.managerRoot,profile))]
    for(const path of forbidden){
      const canonical=existingCanonical(path)??resolve(path)
      if(overlaps(directory,canonical))throw new Error('会话来源不能与管理器数据、实例目录或客户端配置目录相同或重叠')
    }
    const records=state.codexSessionSources??[]
    const existing=records.find(source=>source.directory===directory)
    if(existing){
      if(existing.device!==stat.dev||existing.inode!==stat.ino)throw new Error('该会话来源目录已被替换，请先移除失效登记后重新选择')
      return this.view(this.store.read().codexSessionSources!.find(source=>source.id===existing.id)!)
    }
    for(const path of records.map(source=>source.directory)){if(overlaps(directory,existingCanonical(path)??resolve(path)))throw new Error('外部会话来源目录不能相同或相互重叠')}
    if(records.length>=100)throw new Error('最多登记 100 个外部 Codex 会话来源')
    const record:StoredCodexSessionSource={id:randomUUID(),name:cleanName((name??basename(directory))||directory),directory,device:stat.dev,inode:stat.ino,createdAt:this.now(),enabled:true}
    this.store.transaction(next=>{
      const current=next.codexSessionSources??[]
      if(current.some(source=>source.directory===directory))throw new Error('会话来源已登记')
      next.codexSessionSources=[...current,record]
    })
    this.assertIdentity(record)
    return this.view(record)
  }

  list():CodexSessionSourceView[]{
    return (this.store.read().codexSessionSources??[]).map(source=>{
      try{this.assertIdentity(source);return this.view(source)}
      catch(error){return {...source,enabled:source.enabled!==false,available:false,readOnly:true,issue:error instanceof Error?error.message:'会话来源不可用'}}
    })
  }

  resolve(id:string):StoredCodexSessionSource {
    const parsed=uuid.parse(id),source=(this.store.read().codexSessionSources??[]).find(value=>value.id===parsed)
    if(!source)throw new Error('外部 Codex 会话来源不存在')
    if(source.enabled===false)throw new Error('外部 Codex 会话来源已停用')
    this.assertIdentity(source)
    return structuredClone(source)
  }

  disable(id:string):void {
    const parsed=uuid.parse(id);if(!(this.store.read().codexSessionSources??[]).some(source=>source.id===parsed))throw new Error('外部 Codex 会话来源不存在')
    this.store.transaction(state=>{state.codexSessionSources=(state.codexSessionSources??[]).map(source=>source.id===parsed?{...source,enabled:false}:source)})
  }

  enable(id:string):void {
    const parsed=uuid.parse(id),record=(this.store.read().codexSessionSources??[]).find(source=>source.id===parsed)
    if(!record)throw new Error('外部 Codex 会话来源不存在')
    this.assertIdentity(record)
    this.store.transaction(state=>{state.codexSessionSources=(state.codexSessionSources??[]).map(source=>source.id===parsed?{...source,enabled:true}:source)})
  }

  remove(id:string):void {
    const parsed=uuid.parse(id)
    if(!(this.store.read().codexSessionSources??[]).some(source=>source.id===parsed))throw new Error('外部 Codex 会话来源不存在')
    this.store.transaction(state=>{state.codexSessionSources=(state.codexSessionSources??[]).filter(source=>source.id!==parsed)})
  }

  private assertIdentity(source:StoredCodexSessionSource):void {
    const path=source.directory
    if(!isAbsolute(path)||resolve(path)!==path)throw new Error('会话来源路径不是规范绝对路径')
    const stat=lstatSync(path)
    if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(path)!==path||stat.dev!==source.device||stat.ino!==source.inode)throw new Error('会话来源目录已被替换或身份发生变化，已停止读取')
  }

  private view(source:StoredCodexSessionSource):CodexSessionSourceView {
    try{this.assertIdentity(source);return {...structuredClone(source),enabled:source.enabled!==false,available:true,readOnly:true}}
    catch(error){return {...structuredClone(source),available:false,readOnly:true,issue:error instanceof Error?error.message:'会话来源不可用'}}
  }
}
