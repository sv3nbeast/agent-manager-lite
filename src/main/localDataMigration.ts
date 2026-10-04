import {createHash,createDecipheriv,randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {open,lstat,realpath} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute,sep} from 'node:path'
import {homedir} from 'node:os'
import {setImmediate as yieldIO} from 'node:timers/promises'
import {z} from 'zod'
import {localDataSelectionSchema,localDataApplySchema,type LocalDataSource,type LocalDataScan,type LocalDataPreview,type LocalDataCounts} from '../shared/localDataMigration'
import {accountInputSchema,groupInputSchema,type AccountGroup} from '../shared/types'
import {providerDetailsSchema,providerEndpoint} from '../shared/providerLibrary'
import {parseAccountImport,sameAccount} from './accounts'
import {accountFromAuth,configuredProviderAuth} from './clientIdentity'
import {TomlDocument} from './tomlPatch'
import {Store,type State,type StoredAccount,type LocalDataArchive} from './store'
import type {StoredProvider} from './providerLibrary'
import {exportBackupState} from './dataBackupState'
import {MAX_DATA_BACKUP_BYTES} from './dataBackupArchive'

const FILE_LIMIT=16*1024*1024,TOTAL_LIMIT=128*1024*1024,FILE_COUNT=20040,LIFETIME=10*60_000
function stable(value:unknown):string {const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,c])=>[k,sort(c)])):v;return JSON.stringify(sort(value))}
function credentialHash(a:Record<string,unknown>):string {const t=a.tokens&&typeof a.tokens==='object'?obj(a.tokens):{};return createHash('sha256').update(stable({auth_mode:a.auth_mode??'oauth',tokens:{id_token:t.id_token??'',access_token:t.access_token??'',...(t.refresh_token==null?{}:{refresh_token:t.refresh_token})},openai_api_key:a.openai_api_key??null,agent_identity:a.agent_identity??null})).digest('base64url')}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('数据对象格式无效');return v as Record<string,unknown>}
const str=(v:unknown)=>typeof v==='string'?v:undefined
const ms=(v:unknown,fallback:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:fallback
function json(raw:string):unknown {
  let v:unknown;try{v=JSON.parse(raw.replace(/^\uFEFF/,''))}catch{throw new Error('JSON 文件格式无效')}
  let nodes=0
  function visit(x:unknown,depth:number):void{if(++nodes>1_000_000||depth>64)throw new Error('数据结构超过读取上限');if(x&&typeof x==='object')for(const [k,c] of Object.entries(x)){if(['__proto__','prototype','constructor'].includes(k))throw new Error('数据包含不安全字段');visit(c,depth+1)}}
  visit(v,0);return v
}
function message(error:unknown):string{
  if(error instanceof Error&&error.name==='ZodError')return '字段格式不受支持，请检查接口、模型、能力和名称'
  if(error instanceof Error&&error.name==='AbortError')return '操作已取消'
  // Only errors explicitly produced by this module/parser can reach the UI.
  return error instanceof MigrationError?error.message:'文件无法安全读取或格式不受支持'
}
class MigrationError extends Error {}
interface Root {path:string;name:string;format:LocalDataSource['format']}
interface FileMark {path:string;digest:string|null}
class Reader {
  readonly marks:FileMark[]=[]
  readonly files:LocalDataArchive['sources'][number]['files']=[]
  private bytes=0
  get totalBytes():number{return this.bytes}
  private constructor(readonly root:Root,private canonical:string,private identity:{dev:number;ino:number},private check:()=>void){}
  static async create(root:Root,check:()=>void):Promise<Reader>{check();const st=await lstat(root.path);if(!st.isDirectory()||st.isSymbolicLink())throw new MigrationError('来源目录必须是普通目录，不能是符号链接');return new Reader(root,await realpath(root.path),st,check)}
  private async path(name:string):Promise<string>{
    this.check();const root=await lstat(this.root.path)
    if(root.isSymbolicLink()||root.dev!==this.identity.dev||root.ino!==this.identity.ino)throw new MigrationError('来源目录已变化，请重新扫描')
    const path=resolve(this.root.path,name),rel=relative(this.root.path,path)
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new MigrationError('来源文件路径无效')
    const parts=rel.split(sep);let parent=this.root.path
    for(const part of parts.slice(0,-1)){parent=join(parent,part);try{const st=await lstat(parent);if(!st.isDirectory()||st.isSymbolicLink())throw new MigrationError('来源子目录不能是符号链接')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return path;throw e}}
    const actual=await realpath(parent);const location=relative(this.canonical,actual)
    if(location==='..'||location.startsWith(`..${sep}`)||isAbsolute(location))throw new MigrationError('来源文件越出选定目录')
    return path
  }
  async read(name:string,archive=true):Promise<string|null>{
    const path=await this.path(name);this.check()
    if(this.marks.length>=FILE_COUNT)throw new MigrationError('来源文件数量超过上限')
    let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){this.marks.push({path:name,digest:null});return null}throw new MigrationError('无法读取来源文件，请检查权限与符号链接')}
    try{
      const st=await file.stat();await this.path(name);const actual=await realpath(path),location=relative(this.canonical,actual);if(location==='..'||location.startsWith(`..${sep}`)||isAbsolute(location))throw new MigrationError('来源文件越出选定目录');if(!st.isFile()||st.nlink!==1||st.size>FILE_LIMIT)throw new MigrationError('来源文件必须是单链接普通文件，且不超过 16 MB')
      const chunks:Buffer[]=[];let size=0
      while(size<=FILE_LIMIT){this.check();const b=Buffer.alloc(Math.min(64*1024,FILE_LIMIT+1-size)),{bytesRead}=await file.read(b);if(!bytesRead)break;size+=bytesRead;this.bytes+=bytesRead;if(this.bytes>TOTAL_LIMIT)throw new MigrationError('来源总容量超过 128 MB');chunks.push(b.subarray(0,bytesRead))}
      if(size>FILE_LIMIT)throw new MigrationError('来源文件超过 16 MB')
      const after=await lstat(path);if(after.isSymbolicLink()||after.dev!==st.dev||after.ino!==st.ino)throw new MigrationError('读取期间来源文件已变化')
      const content=Buffer.concat(chunks),digest=hash(content);this.marks.push({path:name,digest})
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content)}catch{throw new MigrationError('来源文件不是有效 UTF-8 文本')}
      if(archive)this.files.push({path:name,hash:digest,content:text})
      return text
    }finally{await file.close()}
  }
  archiveJSON(name:string,value:unknown):void{const record=this.files.find(f=>f.path===name);if(record)record.content=value}
}
interface Bundle {root:Root;reader:Reader;accounts:{oldId:string;account:StoredAccount}[];providers:StoredProvider[];groups:Record<string,unknown>[];warnings:string[];errors:string[]}
interface Session {requestId:string;generation:number;scanId:string;expires:number;roots:Map<string,Root>}
interface Pending {ticket:string;expires:number;session:Session;revision:number;targetHash:string;next:State;bundles:Bundle[];preview:LocalDataPreview}
export interface LocalDataOptions {home?:string;roots?:Root[];now?:()=>number}
export class LocalDataMigration {
  private generation=0;private previewRevision=0;private session?:Session;private pending?:Pending;private timer?:NodeJS.Timeout
  private tasks=new Set<Promise<unknown>>()
  private now:()=>number
  constructor(private store:Store,private options:LocalDataOptions={}){this.now=options.now??Date.now}
  begin(requestId:string):Session{
    z.string().uuid().parse(requestId);this.clear();const session={requestId,generation:this.generation,scanId:randomUUID(),expires:this.now()+LIFETIME,roots:new Map<string,Root>()};this.session=session
    this.timer=setTimeout(()=>this.cancel(requestId),LIFETIME);this.timer.unref();return session
  }
  private clear():void{this.generation++;this.previewRevision++;this.pending=undefined;this.session=undefined;clearTimeout(this.timer)}
  cancel(requestId:string):void{z.string().uuid().parse(requestId);if(this.session?.requestId===requestId)this.clear()}
  discard(ticket:string):void{z.string().uuid().parse(ticket);if(this.pending?.ticket===ticket){this.pending=undefined;this.previewRevision++}}
  private check(session:Session,revision?:number):void{if(this.session!==session||session.generation!==this.generation||this.now()>=session.expires||revision!==undefined&&revision!==this.previewRevision)throw new MigrationError('操作已取消或预览已过期，请重新扫描')}
  private track<T>(task:Promise<T>):Promise<T>{this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task}
  async stop():Promise<void>{this.clear();await Promise.allSettled([...this.tasks])}
  scan(requestId:string):Promise<LocalDataScan>{return this.finishScan(this.begin(requestId))}
  finishScan(session:Session,selected?:string):Promise<LocalDataScan>{return this.track(this.doScan(session,selected))}
  private defaults():Root[]{
    if(this.options.roots)return this.options.roots
    const home=this.options.home??homedir(),roots:Root[]=[{path:join(home,'.antigravity_cockpit'),name:'兼容账号库',format:'account_library'},{path:join(home,'.antigravity_cockpit_dev'),name:'兼容开发账号库',format:'account_library'}]
    const old=process.platform==='darwin'?join(home,'Library','Application Support','com.antigravity.cockpit-tools'):process.platform==='win32'?join(process.env.LOCALAPPDATA??join(home,'AppData','Local'),'com.antigravity.cockpit-tools'):join(process.env.XDG_DATA_HOME??join(home,'.local','share'),'com.antigravity.cockpit-tools')
    roots.push({path:old,name:'兼容旧版账号库',format:'account_library'},{path:join(home,'.codex'),name:'本机 Codex 客户端',format:'native_client'})
    return roots
  }
  private async doScan(session:Session,selected?:string):Promise<LocalDataScan>{
    const sources:LocalDataSource[]=[]
    let roots=this.defaults()
    if(selected){const path=resolve(selected);let format:Root['format']='portable';if(await lstat(join(path,'codex_accounts.json')).catch(()=>undefined)||await lstat(join(path,'codex_model_providers.json')).catch(()=>undefined)||await lstat(join(path,'codex_account_groups.json')).catch(()=>undefined))format='account_library';else if(await lstat(join(path,'auth.json')).catch(()=>undefined)||await lstat(join(path,'config.toml')).catch(()=>undefined))format='native_client';roots=[{path,name:'所选本机数据',format}]}
    for(const root of roots){
      this.check(session);if(!await lstat(root.path).catch(()=>undefined))continue
      const id=randomUUID();session.roots.set(id,root)
      try{const b=await this.load(root,()=>this.check(session));sources.push({id,...root,accounts:b.accounts.length,providers:b.providers.length,groups:b.groups.length,issues:[...b.errors,...b.warnings]})}
      catch(e){this.check(session);sources.push({id,...root,accounts:0,providers:0,groups:0,issues:[message(e)]})}
    }
    this.check(session);return {scanId:session.scanId,sources}
  }
  preview(input:unknown):Promise<LocalDataPreview>{return this.track(this.doPreview(input))}
  private async doPreview(input:unknown):Promise<LocalDataPreview>{
    const {scanId,sourceIds}=localDataSelectionSchema.parse(input),session=this.session
    if(!session||session.scanId!==scanId)throw new MigrationError('扫描结果已过期，请重新扫描')
    this.check(session);const revision=++this.previewRevision;this.pending=undefined
    if(new Set(sourceIds).size!==sourceIds.length||sourceIds.some(id=>!session.roots.has(id)))throw new MigrationError('来源选择无效')
    const bundles:Bundle[]=[],sources:LocalDataSource[]=[]
    for(const id of sourceIds){const root=session.roots.get(id)!;let b:Bundle;try{b=await this.load(root,()=>this.check(session,revision))}catch(e){this.check(session,revision);throw new MigrationError(message(e))};bundles.push(b);if(bundles.reduce((n,x)=>n+x.reader.totalBytes,0)>TOTAL_LIMIT)throw new MigrationError('选中来源总容量超过 128 MB');sources.push({id,...root,accounts:b.accounts.length,providers:b.providers.length,groups:b.groups.length,issues:[...b.errors,...b.warnings]})}
    this.check(session,revision)
    if(bundles.reduce((n,b)=>n+b.accounts.length,0)>10000||bundles.reduce((n,b)=>n+b.providers.length,0)>1000||bundles.reduce((n,b)=>n+b.groups.length,0)>10000)throw new MigrationError('选中来源的数据数量超过单次迁移上限，请分批选择')
    const original=this.store.read(),next=structuredClone(original),counts:LocalDataCounts={addedAccounts:0,duplicateAccounts:0,addedProviders:0,mergedProviders:0,addedKeys:0,addedGroups:0,mergedGroups:0}
    const preview:LocalDataPreview={ticket:randomUUID(),newArchive:false,expiresAt:Math.min(session.expires,this.now()+LIFETIME),sources,counts,accounts:[],providers:[],warnings:bundles.flatMap(b=>b.warnings),errors:bundles.flatMap(b=>b.errors),preservedFiles:bundles.reduce((n,b)=>n+b.reader.files.length,0)}
    for(const b of bundles)await this.merge(next,b,preview,()=>this.check(session,revision))
    if(!counts.addedAccounts&&!counts.duplicateAccounts&&!preview.providers.length&&!bundles.some(b=>b.groups.length))preview.errors.push('选中来源没有可迁移的账号或供应商')
    const fingerprint=hash(JSON.stringify(bundles.map(b=>({path:b.root.path,marks:b.reader.marks}))))
    next.localDataArchives??=[]
    preview.newArchive=!next.localDataArchives.some(a=>a.fingerprint===fingerprint)
    if(preview.newArchive)next.localDataArchives.push({id:randomUUID(),fingerprint,importedAt:this.now(),sources:bundles.map(b=>({path:b.root.path,format:b.root.format,files:structuredClone(b.reader.files)}))})
    if(next.accounts.length>10000||(next.providers?.length??0)>1000||next.groups.length>10000||next.localDataArchives.length>100)preview.errors.push('迁移后数据数量超过应用上限')
    // Validate new reference relationships and ensure the complete backup remains usable.
    if(!preview.errors.length)try{const usage=Object.fromEntries((next.localAccess?.keys??[]).map(k=>[k.id,0]));const backup=exportBackupState(next,usage,this.now());if(Buffer.byteLength(JSON.stringify(backup))>MAX_DATA_BACKUP_BYTES)throw new MigrationError('迁移后完整备份超过 64 MiB，请分批整理归档后重试')}catch(error){preview.errors.push(error instanceof MigrationError?error.message:'迁移后的数据未通过完整备份校验，未写入任何数据')}
    this.check(session,revision);this.pending={ticket:preview.ticket,expires:preview.expiresAt,session,revision,targetHash:hash(JSON.stringify(original)),next,bundles,preview}
    return structuredClone(preview)
  }
  apply(input:unknown):Promise<LocalDataCounts>{return this.track(this.doApply(input))}
  private async doApply(input:unknown):Promise<LocalDataCounts>{
    const {ticket}=localDataApplySchema.parse(input),p=this.pending
    if(!p||p.ticket!==ticket||this.now()>=p.expires)throw new MigrationError('迁移预览已过期，请重新扫描')
    this.check(p.session,p.revision);if(p.preview.errors.length)throw new MigrationError('请先处理全部迁移错误，当前没有写入数据')
    for(const b of p.bundles){
      const current=await Reader.create(b.root,()=>this.check(p.session,p.revision))
      for(const m of b.reader.marks){const raw=await current.read(m.path,false),digest=raw===null?null:current.marks.at(-1)!.digest;if(digest!==m.digest)throw new MigrationError('来源数据已变化，请重新扫描并预览')}
    }
    this.check(p.session,p.revision)
    if(this.now()>=p.expires)throw new MigrationError('迁移预览已过期，请重新扫描')
    this.store.transaction(state=>{if(hash(JSON.stringify(state))!==p.targetHash)throw new MigrationError('本应用数据已变化，请重新预览');Object.assign(state,structuredClone(p.next))})
    this.discard(ticket);return structuredClone(p.preview.counts)
  }
  private async load(root:Root,check:()=>void):Promise<Bundle>{
    const reader=await Reader.create(root,check),b:Bundle={root,reader,accounts:[],providers:[],groups:[],warnings:[],errors:[]}
    const readJSON=async(name:string)=>{const raw=await reader.read(name);if(raw===null)return undefined;const value=json(raw);reader.archiveJSON(name,value);return value}
    const account=(value:unknown,oldId:string,summary?:Record<string,unknown>)=>{const original=obj(value),metadata={...original};if(summary)for(const field of ['email','plan_type','subscription_active_until','created_at','last_used'])if((metadata[field]==null||field==='email'&&!str(metadata[field])?.trim()||field==='created_at'&&typeof metadata[field]==='number'&&(metadata[field] as number)<=0)&&summary[field]!=null)metadata[field]=summary[field];const parsed=parseAccountImport(JSON.stringify(metadata));if(parsed.preview.errors.length||parsed.accounts.length!==1)throw new MigrationError('账号凭据或字段格式不受支持');parsed.accounts[0].source=original;b.accounts.push({oldId,account:parsed.accounts[0]})}
    if(root.format==='account_library'){
      const indexRaw=await readJSON('codex_accounts.json'),index=indexRaw===undefined?{}:obj(indexRaw),rows=index.accounts??[]
      if(!Array.isArray(rows)||rows.length>10000)throw new MigrationError('账号索引无效或超过 10000 项')
      let key:Buffer|undefined
      const ids=new Set<string>()
      for(const row of rows){
        check();let name='账号记录'
        try{
          const summary=obj(row),id=str(summary.id)
          if(!id||!/^[A-Za-z0-9_-]{1,128}$/.test(id)||ids.has(id))throw new MigrationError('账号索引包含非法或重复标识')
          ids.add(id);name=`账号 ${ids.size}`
          const tomb=await readJSON(`codex_account_tombstones/${id}.json`)
          if(tomb!==undefined&&obj(tomb).deleted===true){b.warnings.push(`${name} 已在来源删除，已跳过`);continue}
          const file=`codex_accounts/${id}.json`;let value=await readJSON(file)
          if(value===undefined)throw new MigrationError('索引对应的账号文件缺失')
          const envelope=obj(value)
          if(envelope.ciphertext!==undefined){
            if(envelope.version!==1||envelope.algorithm!=='AES-256-GCM'||envelope.kind!=='codex'||envelope.key_id!=='local-secure-account-storage-v1')throw new MigrationError('账号加密格式不受支持')
            if(!key){const raw=await reader.read('secure-account-storage.key',false);if(!raw)throw new MigrationError('来源加密密钥缺失，无法读取账号');key=Buffer.from(raw.trim(),'base64');if(key.length!==32)throw new MigrationError('来源加密密钥格式无效')}
            try{const nonce=Buffer.from(str(envelope.nonce)??'','base64'),cipher=Buffer.from(str(envelope.ciphertext)??'','base64');if(nonce.length!==12||cipher.length<16)throw 0;const c=createDecipheriv('aes-256-gcm',key,nonce);c.setAuthTag(cipher.subarray(-16));value=json(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([c.update(cipher.subarray(0,-16)),c.final()])))}catch{throw new MigrationError('账号解密失败，请检查来源密钥和文件完整性')}
            reader.archiveJSON(file,value)
          }
          if(tomb!==undefined){const t=obj(tomb),a=obj(value);if(typeof t.generation==='number'&&((typeof a.token_generation==='number'?a.token_generation:0)<t.generation||((a.token_generation??0)===t.generation&&typeof t.credential_hash==='string'&&t.credential_hash.length>0&&credentialHash(a)!==t.credential_hash))){b.warnings.push(`${name} 凭据代次已淘汰，已跳过`);continue}}
          account(value,id,summary)
        }catch(e){b.errors.push(`${name}：${message(e)}`)}
      }
      const providers=await readJSON('codex_model_providers.json');if(providers!==undefined)this.providers(b,providers)
      const groups=await readJSON('codex_account_groups.json');if(groups!==undefined){if(!Array.isArray(groups)||groups.length>10000)throw new MigrationError('分组文件格式无效');b.groups=groups.map(obj)}
      for(const name of ['codex_instances.json','codex_account_bindings.json']){if(await readJSON(name)!==undefined)b.warnings.push('外部实例或账号关联已归档，需要在本应用重新绑定')}
    }else if(root.format==='native_client'){
      const config=await reader.read('config.toml')??'',doc=new TomlDocument(config),auth=await reader.read('auth.json'),mode=doc.scalar(['cli_auth_credentials_store'])
      const configured=configuredProviderAuth(doc)
      if(configured===null&&['keyring','ephemeral'].includes(String(mode)))b.errors.push('当前凭据保存在系统钥匙串或临时会话，请使用官方客户端导入入口')
      else if(configured??auth){
        const raw=configured??auth!,a=accountFromAuth(raw,doc),tier=doc.scalar(['service_tier']),model=doc.scalar(['model'])
        if(['fast','priority'].includes(String(tier)))a.defaultTier='fast';else if(tier==='default')a.defaultTier='standard';else if(['standard','auto','flex'].includes(String(tier)))a.defaultTier=tier as 'standard'|'auto'|'flex'
        if(a.kind==='api_key'&&typeof model!=='string'){a.models=[];b.warnings.push('本机 API 连接未配置模型，保留空目录，请在导入后获取模型')}
        a.source=obj(json(raw));b.accounts.push({oldId:'native',account:a})
      }else b.errors.push('没有可读取的本机凭据文件')
      b.warnings.push('客户端原始配置已归档；不会自动切换账号、接管实例或修改配置')
    }else{
      const values=await readJSON('accounts.json');if(values!==undefined){const parsed=parseAccountImport(JSON.stringify(values));if(parsed.preview.errors.length)throw new MigrationError('便携账号文件中存在不支持的记录');b.accounts=parsed.accounts.map((account,i)=>({oldId:str(account.source?.id)??String(i),account}))}
      const providers=await readJSON('providers.json');if(providers!==undefined)this.providers(b,providers)
      if(new Set(b.accounts.map(a=>a.oldId)).size!==b.accounts.length)throw new MigrationError('便携账号文件包含重复来源标识，无法安全映射分组');
      const groups=await readJSON('groups.json');if(groups!==undefined){if(!Array.isArray(groups)||groups.length>10000)throw new MigrationError('分组文件格式无效');b.groups=groups.map(obj)}
    }
    for(const {account:a} of b.accounts){if(!a.models.length&&a.kind==='api_key')b.warnings.push('有 API 连接未配置模型，空目录已保留，可导入后从 API 获取');if(a.source?.boundInstanceId||a.source?.boundOauthAccountId||a.source?.bound_instance_id||a.source?.bound_oauth_account_id)b.warnings.push('外部账号关联已归档，需要重新绑定')}
    b.warnings=[...new Set(b.warnings)];check();return b
  }
  private providers(b:Bundle,value:unknown):void{
    if(!Array.isArray(value)||value.length>1000)throw new MigrationError('供应商文件格式无效或超过上限')
    for(const [index,row] of value.entries())try{
      const p=obj(row),details:Record<string,unknown>={name:p.name,baseUrl:p.baseUrl,models:p.modelCatalog??p.models??[],wireApi:p.wireApi==='chat'?'chat_completions':p.wireApi??'responses',defaultTier:p.defaultTier??'inherit'}
      for(const k of ['integrationType','presetId','modelContextWindows','supportsVision','modelCapabilities','visionRoutingModel','supportsWebsockets','enableModePreference'])if(p[k]!==null&&p[k]!==undefined)details[k]=p[k]
      const valid=providerDetailsSchema.extend({models:accountInputSchema.shape.models.min(0)}).parse(details),rawKeys=p.apiKeys??p.keys??[]
      if(!Array.isArray(rawKeys)||rawKeys.length>10000)throw new MigrationError('供应商密钥列表格式无效')
      const keys:StoredProvider['keys']=[]
      for(const item of rawKeys){const k=obj(item),apiKey=accountInputSchema.shape.apiKey.parse(k.apiKey);if(keys.some(x=>x.apiKey===apiKey)){b.warnings.push('来源供应商含重复密钥，保留首项名称；其余原数据已归档');continue}keys.push({id:randomUUID(),name:z.string().max(16384).parse(k.name??''),apiKey,createdAt:ms(k.createdAt,this.now()),updatedAt:ms(k.updatedAt,this.now())})}
      const excluded=z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).parse(p.excludedApiKeyHashes??p.excludedKeyHashes??[])
      b.providers.push({...valid,id:randomUUID(),revision:0,createdAt:ms(p.createdAt,this.now()),updatedAt:ms(p.updatedAt,this.now()),keys,excludedKeyHashes:excluded})
      if(!valid.models.length)b.warnings.push('有供应商未配置模型，空目录已保留，可导入后从 API 获取')
    }catch(e){b.errors.push(`供应商 ${index+1}：${message(e)}`)}
  }
  private async merge(state:State,b:Bundle,p:LocalDataPreview,check:()=>void):Promise<void>{
    let processed=0;const cooperate=async()=>{check();if(++processed%100===0){await yieldIO();check()}}
    state.providers??=[];const counts=p.counts,compatible=(a:StoredProvider,c:StoredProvider)=>{
      const select=(v:StoredProvider)=>{const {id,revision,createdAt,updatedAt,name,keys,excludedKeyHashes,...details}=v;return details}
      return stable(select(a))===stable(select(c))
    }
    for(const provider of b.providers){
      await cooperate()
      const existing=state.providers.find(x=>providerEndpoint(x.baseUrl)===providerEndpoint(provider.baseUrl))
      const entry:LocalDataPreview['providers'][number]={name:provider.name,baseUrl:provider.baseUrl,models:provider.models.length,keys:provider.keys.length,action:'add'};p.providers.push(entry)
      if(existing){
        if(!compatible(existing,provider)){entry.action='conflict';p.errors.push('同地址供应商的模型、协议、等级或能力配置不同，请先处理冲突再迁移');continue}
        let added=0
        for(const key of provider.keys){if(existing.keys.some(k=>k.apiKey===key.apiKey))continue;if(existing.excludedKeyHashes.includes(hash(key.apiKey))){p.warnings.push('本应用曾移除的供应商密钥已跳过，来源原数据仍归档');continue}existing.keys.push(structuredClone(key));added++;counts.addedKeys++}
        const excluded=[...new Set([...existing.excludedKeyHashes,...provider.excludedKeyHashes])]
        const changed=added>0||JSON.stringify(excluded)!==JSON.stringify(existing.excludedKeyHashes)
        existing.excludedKeyHashes=excluded
        if(changed){entry.action='merge';existing.revision++;existing.updatedAt=this.now();counts.mergedProviders++}else entry.action='duplicate'
      }else{state.providers.push(structuredClone(provider));counts.addedProviders++;counts.addedKeys+=provider.keys.length}
    }
    const mapped=new Map<string,string>()
    for(const {oldId,account} of b.accounts){
      await cooperate()
      const existing=state.accounts.find(a=>sameAccount(a,account));mapped.set(oldId,existing?.id??account.id)
      p.accounts.push({name:account.name,kind:account.kind,defaultTier:existing?.defaultTier??account.defaultTier,action:existing?'duplicate':'add'})
      if(existing){counts.duplicateAccounts++;p.warnings.push('重复账号保留本应用的凭据、备注、模型和等级；来源原数据已加密归档');continue}
      const a=structuredClone(account)
      if(a.kind==='api_key'){
        const provider=state.providers.find(x=>providerEndpoint(x.baseUrl)===providerEndpoint(a.baseUrl)&&x.keys.some(k=>k.apiKey===a.credentials.apiKey)),key=provider?.keys.find(k=>k.apiKey===a.credentials.apiKey)
        const capFields={api_model_context_windows:'modelContextWindows',api_model_capabilities:'modelCapabilities',api_supports_vision:'supportsVision',api_supports_websockets:'supportsWebsockets',api_vision_routing_model:'visionRoutingModel',api_enable_mode_preference:'enableModePreference'} as const
        const capsMatch=provider&&Object.entries(capFields).every(([from,to])=>a.source?.[from]===undefined||a.source[from]===null||JSON.stringify(a.source[from])===JSON.stringify(provider[to]))
        if(provider&&key&&a.baseUrl===provider.baseUrl&&a.wireApi===provider.wireApi&&(a.integrationType??'auto')===(provider.integrationType??'auto')&&JSON.stringify(a.models)===JSON.stringify(provider.models)&&capsMatch){a.providerId=provider.id;a.providerKeyId=key.id}
        else if(provider)p.warnings.push('部分连接与供应商的模型或能力配置不同，已保留独立连接，避免被覆盖')
      }
      state.accounts.push(a);counts.addedAccounts++
    }
    for(const raw of [...b.groups].sort((a,c)=>ms(a.sortOrder,0)-ms(c.sortOrder,0)))try{
      await cooperate()
      const details=groupInputSchema.parse({name:raw.name,quotaAutoRefreshMinutes:raw.quotaAutoRefreshMinutes!==undefined?raw.quotaAutoRefreshMinutes:raw.quotaRefreshEnabled===false?-1:null}),ids=raw.accountIds
      if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||!mapped.has(id)))throw new MigrationError('分组引用缺失或已删除的账号')
      const members=[...new Set(ids.map(id=>mapped.get(id as string)!))],existing=state.groups.find(g=>g.name===details.name)
      if(existing){if(existing.quotaAutoRefreshMinutes!==details.quotaAutoRefreshMinutes)p.warnings.push('同名分组保留本应用自动刷新策略，来源策略已归档');const nextMembers=[...new Set([...existing.accountIds,...members])];if(nextMembers.length!==existing.accountIds.length)counts.mergedGroups++;existing.accountIds=nextMembers}
      else{const group:AccountGroup={...details,id:randomUUID(),sortOrder:state.groups.length,createdAt:ms(raw.createdAt,this.now()),accountIds:members};state.groups.push(group);counts.addedGroups++}
    }catch(e){p.errors.push(`分组：${message(e)}`)}
    p.warnings=[...new Set(p.warnings)]
  }
}
