import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { configKeys, previewClientConfigSchema, restoreClientConfigSchema, type ClientConfigTarget, type ClientConfigView, type ClientConfigPreview, type ConfigKey, type StoredConfigTarget } from '../shared/clientConfig'
import { Store } from './store'
import { patchToml, scalarRaw, TomlDocument, type TomlEdit } from './tomlPatch'
import { previewModelCatalogSchema, type ModelCatalogView, type CatalogImport } from '../shared/modelCatalog'
import { buildModelCatalog, builtInCatalog, catalogCapabilities, catalogMetadata, defaultModelDefinitions, parseCatalogImport, parseNativeCatalog, summarizeCatalog, templateFor, type NativeCatalog } from './modelCatalog'
import {journalSchema,configKey,displayConfigValue} from './configJournal'
import {providerView,providerEdits} from './providerConfig'
import type {ProviderConfigView} from '../shared/providerConfig'
import {instanceHomePath,validateExternalHome} from './instancePaths'
import {instanceProviderName} from './instanceProviderName'
import {effectiveModelContextWindows} from './providerModelContext'
import {chooseSessionDatabase,sessionDatabaseConfigPath} from './sessionDatabase'

const managedId = 'dd0c896c-522d-4d6a-a9af-3a6a3e10e2fd'
const hash = (text: string | null) => createHash('sha256').update(text === null ? 'missing:' : `present:${text}`).digest('hex')
interface FileDependency { path: string; revision: string }
interface CatalogFile { name: string; content: string }
interface Pending { target: ClientConfigTarget; revision: string; edits: TomlEdit[]; next: string; expiresAt: number; preview: ClientConfigPreview; dependencies: FileDependency[]; catalogFile?: CatalogFile; verify?:()=>void; providerId?:string }

export function readBounded(file: string, limit: number): string | null {
  let fd: number
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('无法安全读取配置文件，请检查权限与符号链接') }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit || stat.nlink !== 1) throw new Error('配置文件类型或大小不符合要求')
    // Bound reads even when a different process grows the file after fstat.
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count }
    if (offset > limit) throw new Error('配置文件超过大小限制')
    const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset))
    return result
  } finally { closeSync(fd) }
}
export function directory(path: string, create = false): void {
  if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('配置目录已改变或不是普通目录')
}
export function atomic(file: string, content: string): void {
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, file)
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }) }
}

export class ClientConfigs {
  private readonly root: string
  private pending?: Pending
  private importedCatalog?: { target: string; ticket: string; catalog: NativeCatalog; expiresAt: number }
  constructor(private readonly store: Store, private readonly now = Date.now, private readonly inUse:(id:string)=>boolean=()=>false) { this.root = realpathSync(store.directory) }
  targets(): ClientConfigTarget[] {
    return [{ id: managedId, name: '默认 Codex 目录', description:'客户端配置使用的默认目录，与实例的独立目录分开。', role:'default', directory: join(this.root, 'clients', 'default'), managed: true },
      ...(this.store.read().instances ?? []).map(instance=>({id:instance.id,name:`实例 · ${instance.name}`,role:'instance' as const,directory:instanceHomePath(this.root,instance),managed:!instance.externalHome})),
      ...(this.store.read().configTargets ?? []).map(({ device: _device, inode: _inode, ...target }) => ({...target,role:'external' as const}))]
  }
  register(selectedDirectory: string): ClientConfigTarget {
    const canonical = realpathSync(selectedDirectory)
    directory(canonical)
    const existing = this.targets().find(target => target.directory === canonical)
    if(existing&&this.store.read().instances?.some(instance=>instance.id===existing.id))return this.target(existing.id)
    const stat = lstatSync(canonical)
    const stored = this.store.read().configTargets ?? []
    const previous = stored.find(target => target.id === existing?.id)
    if (existing?.managed || existing && previous?.device === stat.dev && previous.inode === stat.ino) return existing
    if(existing&&this.inUse(existing.id))throw new Error('此目录正在使用或等待恢复，不能重新登记')
    if(existing&&(this.store.read().clientSwitches?.some(record=>record.targetId===existing.id)||this.store.read().clientAuthorities?.some(binding=>binding.targetId===existing.id)))throw new Error('此目录仍有登录关联或恢复记录，请先恢复原目录并处理该关联')
    if (stored.length >= 100 && !existing) throw new Error('最多管理 100 个客户端目录')
    const target: StoredConfigTarget = { id: randomUUID(), name: '已选择的客户端', directory: canonical, managed: false, device: stat.dev, inode: stat.ino }
    // Validate before registration. Only a native directory picker supplies paths.
    new TomlDocument(readBounded(join(canonical, 'config.toml'), 1024 * 1024) ?? '')
    this.store.transaction(state => { state.configTargets = [...(state.configTargets ?? []).filter(value => value.directory !== canonical), target] })
    return this.targets().find(value => value.id === target.id)!
  }
  private target(id: string, create = false): ClientConfigTarget {
    const target = this.targets().find(value => value.id === z.string().uuid().parse(id))
    if (!target) throw new Error('客户端目录不存在')
    if (target.managed) {
      const paths=target.id===managedId ? [join(this.root,'clients'),target.directory] : [join(this.root,'instances'),join(this.root,'instances',target.id),target.directory]
      for (const path of paths) {
        if (!existsSync(path) && !create) break
        directory(path, create)
      }
    } else {
      const instance=this.store.read().instances?.find(instance=>instance.id===id)
      if(instance?.externalHome){validateExternalHome(this.root,instance.externalHome);return target}
      const stored = this.store.read().configTargets!.find(value => value.id === id)!
      directory(target.directory)
      const stat = lstatSync(target.directory)
      if (stat.dev !== stored.device || stat.ino !== stored.inode || realpathSync(target.directory) !== target.directory) throw new Error('客户端目录已被替换，请重新选择目录')
    }
    return target
  }
  private source(target: ClientConfigTarget): string | null { return readBounded(join(target.directory, 'config.toml'), 1024 * 1024) }
  // Main-process capability for explicit identity reads; no raw path IPC.
  identityTarget(id:string):ClientConfigTarget {return this.target(id)}
  prepareIdentityTarget(id:string):ClientConfigTarget {return this.target(id,true)}
  providers(id:string):ProviderConfigView {
    const source=this.source(this.target(id))
    return providerView(new TomlDocument(source??''),hash(source),this.store)
  }
  previewProvider(input:unknown):ClientConfigPreview {
    // Validation happens before accessing a renderer-supplied target.
    const result=providerEdits(input,this.store,id=>{
      const target=this.target(id),source=this.source(target)
      return {target,source,revision:hash(source)}
    })
    const preview=this.stage(result.target,result.source,result.edits,'apply',[])
    this.pending!.verify=result.verify
    this.pending!.providerId=result.providerId
    return preview
  }
  private catalogFolder(target: ClientConfigTarget, create = false): string {
    let path = this.root
    for (const part of ['model-catalogs',target.id]) {
      path = join(path,part)
      if (!existsSync(path) && !create) continue
      directory(path,create)
    }
    return path
  }
  private catalogSource(target: ClientConfigTarget, source: string | null) {
    const document = new TomlDocument(source ?? ''), raw = document.scalar(['model_catalog_json'])
    const reference = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
    let catalog = structuredClone(builtInCatalog), dependency: FileDependency | undefined, error: string | undefined, managed = false
    if (reference) {
      const expanded = reference.startsWith('~/') ? join(homedir(),reference.slice(2)) : reference
      const path = isAbsolute(expanded) ? expanded : resolve(target.directory,expanded)
      try {
        const content = readBounded(path,16 * 1024 * 1024)
        dependency = {path,revision:hash(content)}
        if (content === null) throw new Error('模型目录文件不存在')
        catalog = parseNativeCatalog(content)
        managed = dirname(path) === this.catalogFolder(target) && /^[a-f0-9]{64}\.json$/.test(basename(path))
          && basename(path,'.json') === createHash('sha256').update(content).digest('hex')
        if (!managed) delete catalog._codex_manager_lite
      } catch (cause) { error = cause instanceof Error && cause.message.startsWith('模型目录') ? cause.message : '模型目录无法安全读取或格式错误，原文件已保留' }
    }
    return { catalog, reference, dependency, managed, error, revision:hash(JSON.stringify([hash(source),reference ?? null,dependency?.revision ?? error ?? null])) }
  }
  catalogView(id: string): ModelCatalogView {
    const target = this.target(id), source = this.source(target), current = this.catalogSource(target,source)
    let models = defaultModelDefinitions(), error = current.error
    if (current.reference && !error) {
      try { models = summarizeCatalog(current.catalog) } catch { error = '模型目录条目无法读取，请导入有效目录或关闭自定义目录' }
    }
    const model = new TomlDocument(source ?? '').scalar(['model'])
    return { revision:current.revision,source:current.reference ? current.managed ? 'managed' : 'external' : 'official',
      reference:current.reference,models,capabilities:catalogCapabilities(models,current.catalog),defaults:defaultModelDefinitions(),
      defaultCapabilities:catalogCapabilities(defaultModelDefinitions(),builtInCatalog),
      defaultModelId:typeof model === 'string' ? model : null, customized:current.managed && !!catalogMetadata(current.catalog),error }
  }
  importCatalog(id: string, file: string): CatalogImport {
    this.target(id)
    const content = readBounded(file,16 * 1024 * 1024)
    if (content === null) throw new Error('模型目录文件不存在')
    const catalog = parseCatalogImport(content)
    // Only runtime ownership established by our content-addressed path can use
    // previousModel metadata. A user-selected file cannot manufacture ownership.
    delete catalog._codex_manager_lite
    const models = summarizeCatalog(catalog), ticket = randomUUID()
    this.importedCatalog = {target:id,ticket,catalog,expiresAt:this.now()+300_000}
    return {ticket,models,capabilities:catalogCapabilities(models,catalog),fileName:basename(file)}
  }
  previewCatalog(input: unknown): ClientConfigPreview {
    const parsed = previewModelCatalogSchema.parse(input), target = this.target(parsed.id), source = this.source(target)
    const current = this.catalogSource(target,source), doc = new TomlDocument(source ?? '')
    if (parsed.revision !== current.revision) throw new Error('配置或模型目录已改变，请重新读取后预览')
    const metadata = current.managed && !current.error ? catalogMetadata(current.catalog) : undefined
    if (!parsed.enabled) {
      const edits: TomlEdit[] = [{path:['model_catalog_json'],raw:null}]
      if (metadata && doc.raw(['model']) === metadata.managedModel) edits.push({path:['model'],raw:metadata.previousModel})
      return this.stage(target,source,edits.filter(edit=>doc.raw(edit.path)!==edit.raw),'apply',[])
    }
    let base = current.catalog
    if (parsed.importTicket) {
      const imported = this.importedCatalog
      if (!imported || imported.target !== target.id || imported.ticket !== parsed.importTicket || imported.expiresAt < this.now()) throw new Error('导入目录预览已过期，请重新选择文件')
      base = imported.catalog
    } else if (parsed.reset) base = builtInCatalog
    else if (current.error) throw new Error('当前目录无法读取，请先导入有效目录或重置编辑内容')
    if (parsed.defaultModelId && !parsed.models.some(model=>model.modelId === parsed.defaultModelId) && parsed.defaultModelId !== 'gpt-reserve') throw new Error('默认模型必须在当前目录中')
    const previousModel = metadata ? metadata.previousModel : doc.raw(['model']), managedModel = scalarRaw(parsed.defaultModelId)
    const catalog = buildModelCatalog(parsed.models,base,previousModel,managedModel)
    // Explicit repair gets a fresh immutable file even when reconstructing the
    // same definitions. Preserve the missing/tampered reference for inspection.
    if (current.error) (catalog._codex_manager_lite as Record<string,unknown>).recoveryId = randomUUID()
    const content = JSON.stringify(catalog,null,2)+'\n'
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('生成的模型目录超过 16 MiB，请减少条目或使用更小的模板')
    const name = createHash('sha256').update(content).digest('hex')+'.json', path = join(this.catalogFolder(target),name)
    const edits = [{path:['model_catalog_json'],raw:scalarRaw(path)},{path:['model'],raw:managedModel}].filter(edit=>doc.raw(edit.path)!==edit.raw)
    const preview = this.stage(target,source,edits,'apply',[],current.dependency ? [current.dependency] : [],{name,content})
    preview.catalogModels = summarizeCatalog(catalog).map(model=>model.modelId)
    this.pending!.preview = structuredClone(preview)
    return preview
  }
  private backups(target: ClientConfigTarget, create = false): string | undefined {
    let path = this.root
    for (const part of ['config-backups', target.id]) {
      path = join(path, part)
      if (!existsSync(path) && !create) return undefined
      directory(path, create)
    }
    return path
  }
  private journal(target: ClientConfigTarget, id: string, allowUntouched = false) {
    const base = this.backups(target)
    if (!base) throw new Error('配置备份不存在')
    const folder = join(base, id); directory(folder)
    let journal:ReturnType<typeof journalSchema.parse>
    try {journal=journalSchema.parse(JSON.parse(readBounded(join(folder, 'change.json'), 2*1024*1024) ?? 'null'))}
    catch {throw new Error('配置备份格式错误或无法读取，原文件已保留')}
    if (journal.target !== target.id || journal.id !== id) throw new Error('配置备份不匹配')
    if (journal.status === 'prepared') {
      // Instance checkpoint may precede the config rename. A byte-identical
      // original requires no restore, including a still-missing original file.
      if (allowUntouched && hash(this.source(target)) === journal.beforeHash) return journal
      // A crash after client rename but before marking the journal committed
      // is recoverable only when the exact projected file is still in place.
      // Merely finding the same field values does not prove write ownership.
      const stat = lstatSync(join(target.directory, 'config.toml'))
      if (stat.dev !== journal.projectedFile.device || stat.ino !== journal.projectedFile.inode || hash(this.source(target)) !== journal.afterHash) throw new Error('此备份尚未确认写入，原文件备份已保留')
    }
    return journal
  }
  view(id: string): ClientConfigView {
    const target = this.target(id), source = this.source(target), doc = new TomlDocument(source ?? '')
    const base = this.backups(target)
    const revisions = base ? readdirSync(base).filter(name => /^\d{13}-[a-f0-9-]{36}$/.test(name)).sort().reverse().slice(0, 100).flatMap(name => {
      try { const journal = this.journal(target, name); return [{ id: name, createdAt: journal.createdAt, kind: journal.kind }] } catch { return [] }
    }) : []
    const profile = doc.scalar(['profile'])
    return { target, exists: source !== null, revision: hash(source), values: Object.fromEntries(configKeys.map(key => [key, doc.scalar([key])])),
      providers: [...new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', ...doc.children(['model_providers'])])],
      activeProfile: typeof profile === 'string' ? profile.slice(0, 200) : undefined, revisions }
  }
  preview(input: unknown): ClientConfigPreview {
    const parsed = previewClientConfigSchema.parse(input), target = this.target(parsed.id), source = this.source(target)
    if (parsed.revision !== hash(source)) throw new Error('配置已被其他程序修改，请重新读取后预览')
    const doc = new TomlDocument(source ?? ''), changes = parsed.changes
    if (changes.model_context_window !== undefined) {
      changes.model_auto_compact_token_limit = changes.model_context_window === null ? null
        : changes.model_auto_compact_token_limit ?? Math.floor(changes.model_context_window * 0.9)
    }
    if (changes.model_provider && !this.view(target.id).providers.includes(changes.model_provider)) throw new Error('请先在客户端配置中定义此 Provider')
    const edits = Object.entries(changes).filter(([, value]) => value !== undefined).map(([key, value]) => ({ path: [key], raw: scalarRaw(value!) }))
      .filter(edit => doc.raw(edit.path) !== edit.raw)
    return this.stage(target, source, edits, 'apply', [])
  }
  // Internal launch projection only. The renderer has no IPC for raw edits,
  // arbitrary endpoints or credentials in an instance's private config.
  instanceModelContext(id:string,model:string) {
    const state=this.store.read(),instance=state.instances?.find(instance=>instance.id===id)
    const account=state.accounts.find(account=>account.id===instance?.accountId)
    if(!instance||!account)throw new Error('实例或绑定账号不存在')
    const target=this.target(id),source=this.source(target),doc=new TomlDocument(source??'')
    const catalog=this.catalogSource(target,source)
    if(catalog.error)throw new Error(catalog.error)
    const {windows,providerWindows,connectionWindows}=effectiveModelContextWindows(state,account),override=windows?.[model]
    const template=templateFor(model,catalog.catalog)
    const configured=doc.scalar(['model_context_window']),configuredCompact=doc.scalar(['model_auto_compact_token_limit'])
    const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>1
    const window=override??(positive(configured)?configured:positive(template.model.context_window)?template.model.context_window:undefined)
    let compact=override===undefined
      ?typeof configuredCompact==='number'&&Number.isSafeInteger(configuredCompact)&&configuredCompact>0?configuredCompact
        :positive(configured)?undefined:typeof template.model.auto_compact_token_limit==='number'?template.model.auto_compact_token_limit:undefined
      :Math.floor(override*0.9)
    const origin: 'connection'|'provider'|'config'|'catalog'|'template'=connectionWindows&&Object.hasOwn(connectionWindows,model)?'connection':override!==undefined?'provider':positive(configured)?'config':template.known?'catalog':'template'
    let catalogFile:CatalogFile|undefined
    // Model settings belong to the selected model, including later selections
    // inside Codex. A top-level launch override would leak to every model.
    if(windows&&Object.keys(windows).length){
      const generated=structuredClone(catalog.catalog)
      delete generated._codex_manager_lite
      const globalWindow=doc.raw(['model_context_window'])!==null,globalCompact=doc.raw(['model_auto_compact_token_limit'])!==null
      // Model discovery can contain hundreds of IDs. Unconfigured unknown IDs
      // keep the client's normal template fallback; duplicate full instructions
      // only when preserving a pre-existing global override requires it.
      const requiredModels=globalWindow||globalCompact?account.models:account.models.filter(id=>Object.hasOwn(windows,id))
      const modelIds=[...new Set([...requiredModels,model])]
      if(modelIds.some(id=>id.length>128))throw new Error('模型名称超过 Codex 模型目录支持的 128 字符，请调整名称或清除上下文覆盖')
      if(new Set(modelIds.map(id=>id.toLowerCase())).size!==modelIds.length)throw new Error('模型名称仅大小写不同，Codex 模型目录无法区分，请统一名称后重试')
      for(const id of modelIds){
        const existing=generated.models.find(entry=>entry.slug.toLowerCase()===id.toLowerCase())
        // Preserve the connection's actual model spelling when matching a native
        // case-insensitive catalog entry; requests still use that exact ID.
        if(existing){existing.slug=id;continue}
        const entry=templateFor(id,catalog.catalog).model
        Object.assign(entry,{slug:id,display_name:id,description:id,visibility:'list',supported_in_api:true,priority:1000+generated.models.length})
        generated.models.push(entry)
      }
      if(globalWindow&&!positive(configured)||globalCompact&&!(typeof configuredCompact==='number'&&Number.isSafeInteger(configuredCompact)&&configuredCompact>0))throw new Error('实例全局上下文或压缩阈值无效，请先核对客户端配置')
      for(const entry of generated.models){
        const specific=windows[entry.slug]
        const fallback=specific??(positive(configured)?configured:entry.context_window)
        if(specific!==undefined||globalWindow){
          if(!positive(fallback))throw new Error('模型目录上下文无效，请先核对客户端配置')
          const limit=specific!==undefined?Math.floor(specific*0.9):globalCompact?configuredCompact:Math.floor(fallback*0.9)
          if(typeof limit!=='number'||limit<=0||limit>=fallback)throw new Error('实例压缩阈值必须小于上下文窗口，请先核对客户端配置')
          Object.assign(entry,{context_window:fallback,max_context_window:fallback,auto_compact_token_limit:limit})
        }else if(globalCompact){
          if(typeof fallback!=='number'||typeof configuredCompact!=='number'||configuredCompact>=fallback)throw new Error('实例全局压缩阈值超出模型窗口，请先核对客户端配置')
          entry.auto_compact_token_limit=configuredCompact
        }
      }
      if(generated.model_overrides)generated.model_overrides=structuredClone(generated.models)
      const content=JSON.stringify(generated,null,2)+'\n'
      if(Buffer.byteLength(content)>16*1024*1024)throw new Error('生成的实例模型目录超过 16 MiB，请减少上下文覆盖模型或调整原有全局上下文设置')
      parseNativeCatalog(content)
      catalogFile={name:createHash('sha256').update(content).digest('hex')+'.json',content}
      if(override===undefined&&positive(configured)&&!globalCompact)compact=Math.floor(configured*0.9)
    }
    const supportsFast=Array.isArray(template.model.service_tiers)&&template.model.service_tiers.some(tier=>tier&&typeof tier==='object'&&tier.id==='priority')
    return {window,compact,origin,override,dependency:catalog.dependency,catalogFile,supportsFast,
      revision:hash(JSON.stringify([model,catalog.revision,instance.accountId,account.kind,account.providerId,account.providerKeyId,providerWindows??null,connectionWindows??null,window,compact,origin,catalogFile?.name]))}
  }
  // Native instances reuse the ordinary config journal, independently of their
  // encrypted auth transaction. This keeps later hand edits out of restoration.
  previewInstanceContext(id:string,revision:string,model:string):ClientConfigPreview {
    const target=this.target(id),source=this.source(target),doc=new TomlDocument(source??'')
    if(hash(source)!==revision)throw new Error('实例配置已变化，请重新预览启动')
    const context=this.instanceModelContext(id,model)
    const sessionDatabase=chooseSessionDatabase(target.directory,source)
    const edits:TomlEdit[]=[
      ...(sessionDatabase.value===undefined?[]:[{path:sessionDatabaseConfigPath(source),raw:scalarRaw(sessionDatabase.value)}]),
      ...(context.catalogFile===undefined?[]:[
        {path:['model_catalog_json'],raw:scalarRaw(join(this.catalogFolder(target),context.catalogFile.name))},
        {path:['model_context_window'],raw:null},
        {path:['model_auto_compact_token_limit'],raw:null}
      ])
    ]
    const preview=this.stage(target,source,edits.filter(edit=>doc.raw(edit.path)!==edit.raw),'apply',[],context.dependency?[context.dependency]:[],context.catalogFile)
    this.pending!.verify=()=>{if(this.instanceModelContext(id,model).revision!==context.revision)throw new Error('实例连接、供应商上下文或模型目录已变化，请重新预览启动')}
    return preview
  }
  previewInstanceConnection(id:string, revision:string, connection:{port:number;key:string;model:string;tier?:string;manageServiceTier?:boolean}):ClientConfigPreview {
    const state=this.store.read(),instance=state.instances?.find(instance=>instance.id===id)
    if(!instance)throw new Error('实例不存在')
    const account=state.accounts.find(account=>account.id===instance.accountId)
    if(!account)throw new Error('绑定账号已删除，请重新选择')
    const providerName=instanceProviderName(state,account),attribution=JSON.stringify([instance.accountId,account.kind,account.providerId,account.providerKeyId,providerName])
    const target=this.target(id),source=this.source(target)
    if(hash(source)!==revision)throw new Error('实例配置已变化，请重新预览启动')
    const doc=new TomlDocument(source ?? '')
    if(doc.scalar(['profile']))throw new Error('实例配置启用了 Profile，请先移除该覆盖后再使用本地网关绑定')
    const provider='cml_instance'
    // Refuse hidden custom headers/query parameters on the reserved connection.
    if(doc.children(['model_providers',provider]).some(key=>!['name','base_url','wire_api','requires_openai_auth','supports_websockets','experimental_bearer_token'].includes(key)))throw new Error('实例专用 Provider 含额外字段，请先移除自定义覆盖')
    const context=this.instanceModelContext(id,connection.model)
    const sessionDatabase=chooseSessionDatabase(target.directory,source)
    const values:[string[],string|number|boolean|null][]=[
      [['model'],connection.model],[['model_provider'],provider],
      [['cli_auth_credentials_store'],'file'],[['forced_login_method'],'api'],
      [['model_providers',provider,'name'],providerName],[['model_providers',provider,'base_url'],`http://127.0.0.1:${connection.port}/v1`],
      [['model_providers',provider,'wire_api'],'responses'],[['model_providers',provider,'requires_openai_auth'],false],
      [['model_providers',provider,'supports_websockets'],false],[['model_providers',provider,'experimental_bearer_token'],connection.key]
    ]
    if(sessionDatabase.value!==undefined)values.push([['sqlite_home'],sessionDatabase.value])
    // Compatible native speed menus own this persistent preference. Omit it
    // from the temporary connection journal so stopping restores the reserved
    // provider/key independently of later speed choices. Other callers retain
    // the existing projection and restoration behavior.
    if(connection.manageServiceTier!==false)values.push([['service_tier'],connection.tier==='priority'?'fast':connection.tier??null])
    if(context.catalogFile)values.push([['model_catalog_json'],join(this.catalogFolder(target),context.catalogFile.name)],[['model_context_window'],null],[['model_auto_compact_token_limit'],null])
    const preview=this.stage(target,source,values.map(([path,value])=>({path,raw:scalarRaw(value)})).filter(edit=>doc.raw(edit.path)!==edit.raw),'apply',[],context.dependency?[context.dependency]:[],context.catalogFile)
    this.pending!.verify=()=>{
      const current=this.store.read(),profile=current.instances?.find(profile=>profile.id===id),active=current.accounts.find(account=>account.id===profile?.accountId)
      if(!active||JSON.stringify([profile?.accountId,active.kind,active.providerId,active.providerKeyId,instanceProviderName(current,active)])!==attribution)throw new Error('实例供应商关联或名称已变化，请重新预览启动')
      if(this.instanceModelContext(id,connection.model).revision!==context.revision)throw new Error('实例连接、供应商上下文或模型目录已变化，请重新预览启动')
    }
    return preview
  }
  previewRestore(input: unknown, allowUntouched = false): ClientConfigPreview {
    const parsed = restoreClientConfigSchema.parse(input), target = this.target(parsed.id), source = this.source(target)
    const doc = new TomlDocument(source ?? ''), journal = this.journal(target, parsed.backup, allowUntouched)
    if (allowUntouched && journal.status === 'prepared' && hash(source) === journal.beforeHash) return this.stage(target,source,[],'restore',[])
    const edits: TomlEdit[] = [], conflicts: ConfigKey[] = [], dependencies: FileDependency[] = []
    for (const edit of journal.edits) {
      if (doc.raw(edit.path) === edit.after) edits.push({ path: edit.path, raw: edit.before })
      else if (doc.raw(edit.path) !== edit.before) conflicts.push(configKey(edit.path))
    }
    for(const guard of journal.providerGuards) {
      if(hash(doc.subtree(['model_providers',guard.providerId]))===guard.after && !conflicts.some(key=>key==='model_provider'||key==='service_tier'))continue
      // Restore connection settings together; a later change to any provider
      // field (including unknown authentication headers) keeps the whole group.
      const group=journal.edits.filter(edit=>edit.path[0]==='model_providers'&&edit.path[1]===guard.providerId || ['model_provider','service_tier'].includes(edit.path[0]))
      for(const edit of group)if(!conflicts.includes(configKey(edit.path)))conflicts.push(configKey(edit.path))
      for(let i=edits.length-1;i>=0;i--)if(group.some(edit=>JSON.stringify(edit.path)===JSON.stringify(edits[i].path)))edits.splice(i,1)
    }
    const catalogEdit = edits.find(edit=>edit.path[0]==='model_catalog_json')
    if (catalogEdit?.raw) {
      const restoring = this.catalogSource(target,patchToml(source ?? '',[catalogEdit]))
      if (restoring.error) conflicts.push('model_catalog_json')
      else if (restoring.dependency) dependencies.push(restoring.dependency)
    }
    if (conflicts.includes('model_catalog_json')) {
      for (let i=edits.length-1;i>=0;i--) if (['model_catalog_json','model','model_context_window','model_auto_compact_token_limit'].includes(edits[i].path[0])) {
        if (!conflicts.includes(edits[i].path[0] as ConfigKey)) conflicts.push(edits[i].path[0] as ConfigKey)
        edits.splice(i,1)
      }
    }
    const contextKeys: ConfigKey[] = ['model_context_window', 'model_auto_compact_token_limit']
    if (conflicts.some(key => contextKeys.includes(key))) {
      for (let i = edits.length - 1; i >= 0; i--) if (contextKeys.includes(edits[i].path[0] as ConfigKey)) {
        conflicts.push(edits[i].path[0] as ConfigKey); edits.splice(i, 1)
      }
    }
    const candidate = new TomlDocument(patchToml(source ?? '', edits))
    const window = candidate.scalar(['model_context_window']), threshold = candidate.scalar(['model_auto_compact_token_limit'])
    // A threshold unchanged by the selected operation is absent from its diff.
    // Still preserve a later user edit when rolling back only the window would
    // make that threshold invalid.
    if (typeof window === 'number' && typeof threshold === 'number' && threshold >= window) {
      for (let i = edits.length - 1; i >= 0; i--) if (contextKeys.includes(edits[i].path[0] as ConfigKey)) {
        conflicts.push(edits[i].path[0] as ConfigKey); edits.splice(i, 1)
      }
    }
    let original:string|undefined
    if(!conflicts.length&&hash(source)===journal.afterHash){
      const saved=readBounded(join(this.backups(target)!,parsed.backup,'original.toml'),1024*1024)
      if(saved===null||hash(saved)!==journal.beforeHash&&!(saved===''&&hash(null)===journal.beforeHash))throw new Error('配置原文备份已改变，已保留当前配置')
      original=saved
    }
    const preview=this.stage(target, source, edits, 'restore', conflicts, dependencies)
    // Only use the exact original when the entire current file is still ours;
    // the usual preview/commit revision checks keep concurrent edits intact.
    if(original!==undefined)this.pending!.next=original
    return preview
  }
  private stage(target: ClientConfigTarget, source: string | null, edits: TomlEdit[], kind: 'apply' | 'restore', conflicts: ConfigKey[], dependencies: FileDependency[] = [], catalogFile?: CatalogFile): ClientConfigPreview {
    const doc = new TomlDocument(source ?? '')
    const preview: ClientConfigPreview = { ticket: randomUUID(), target, kind, conflicts, changes: edits.map(edit => ({ key: configKey(edit.path), before: displayConfigValue(edit.path,doc.raw(edit.path)), after: displayConfigValue(edit.path,edit.raw) })) }
    this.pending = { target, revision: hash(source), edits, next: patchToml(source ?? '', edits), expiresAt: this.now() + 300_000, preview, dependencies, catalogFile }
    return structuredClone(preview)
  }
  discard(): void { this.pending = undefined }
  apply(ticket: string, beforeCommit?: (backup: string) => void): ClientConfigView {
    const pending = this.pending
    if (!pending || pending.preview.ticket !== z.string().uuid().parse(ticket) || pending.expiresAt < this.now()) throw new Error('配置预览已过期，请重新预览')
    if(this.inUse(pending.target.id))throw new Error('请先停止实例或恢复原生账号切换，再修改其客户端配置')
    this.pending = undefined
    const target = this.target(pending.target.id), source = this.source(target)
    if (hash(source) !== pending.revision) throw new Error('配置已被其他程序修改，请重新读取后预览')
    const verifyDependencies = () => {
      pending.verify?.()
      for (const dependency of pending.dependencies) if (hash(readBounded(dependency.path,16 * 1024 * 1024)) !== dependency.revision) throw new Error('模型目录已被其他程序修改，请重新预览')
    }
    verifyDependencies()
    if (!pending.edits.length) return this.view(target.id)
    if (pending.catalogFile) {
      const folder = this.catalogFolder(target,true), path = join(folder,pending.catalogFile.name)
      const existing = readBounded(path,16 * 1024 * 1024)
      if (existing !== null && existing !== pending.catalogFile.content) throw new Error('受管模型目录被外部修改，原文件已保留')
      if (existing === null) atomic(path,pending.catalogFile.content)
    }
    // Persist the original and the field journal before touching the client.
    // Even if the process exits after rename, a subsequent launch can restore.
    const base = this.backups(target, true)!, createdAt = this.now()
    const previous = readdirSync(base).filter(name => /^\d{13}-[a-f0-9-]{36}$/.test(name)).sort().at(-1)
    const stamp = Math.max(createdAt, previous ? Number(previous.slice(0, 13)) + 1 : 0)
    const id = `${stamp}-${randomUUID()}`
    this.target(target.id, true)
    const folder = join(base, id); directory(folder, true)
    const temporary = join(target.directory, `.cml-${randomUUID()}.tmp`)
    let fd: number | undefined, committed = false
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      writeFileSync(fd, pending.next); fsyncSync(fd)
      const projected = fstatSync(fd); closeSync(fd); fd = undefined
      const doc = new TomlDocument(source ?? '')
      const nextDoc=new TomlDocument(pending.next)
      const journal = journalSchema.parse({ version: 2, id, target: target.id, createdAt, kind: pending.preview.kind, status: 'prepared',
        projectedFile: {device:projected.dev,inode:projected.ino}, beforeHash: pending.revision, afterHash: hash(pending.next),
        edits: pending.edits.map(edit => ({ path:edit.path, before: doc.raw(edit.path), after: edit.raw })),
        providerGuards:[...new Set([...pending.edits.filter(edit=>edit.path[0]==='model_providers').map(edit=>edit.path[1]),...(pending.providerId?[pending.providerId]:[])])].map(providerId=>({providerId,after:hash(nextDoc.subtree(['model_providers',providerId]))})) })
      atomic(join(folder, 'original.toml'), source ?? '')
      atomic(join(folder, 'change.json'), JSON.stringify(journal))
      // Recheck after durable backup creation; ordinary editor races are refused.
      this.target(target.id)
      if (hash(this.source(target)) !== pending.revision) throw new Error('备份期间配置已改变，原文件未覆盖；请重新预览')
      verifyDependencies()
      // Internal lifecycle hook: durably link the instance checkpoint before
      // replacing its config. No renderer IPC exposes this callback.
      beforeCommit?.(id)
      this.target(target.id)
      if (hash(this.source(target)) !== pending.revision) throw new Error('提交前配置已改变，请重新预览')
      verifyDependencies()
      renameSync(temporary, join(target.directory, 'config.toml')); committed = true
      atomic(join(folder, 'change.json'), JSON.stringify({ ...journal, status: 'applied' }))
    } catch (error) {
      if (committed) throw new Error('配置已写入，备份状态保存未完成；原文件备份已保留，请重新读取配置')
      throw error
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }) }
    return this.view(target.id)
  }
}
