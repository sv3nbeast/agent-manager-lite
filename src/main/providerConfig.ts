// Client projection adapted from Cockpit ee816002 codex_account_model_catalog.rs.
// Provider library/multi-key reconciliation is tracked separately in MIGRATION_MATRIX.
import {createHash} from 'node:crypto'
import {providerChangesSchema,providerFields,providerURLSchema,previewProviderSchema,type ProviderConfigView,type ProviderConfigEntry,type ProviderChanges} from '../shared/providerConfig'
import type {ClientConfigTarget} from '../shared/clientConfig'
import type {Store,StoredAccount} from './store'
import {TomlDocument,scalarRaw,type TomlEdit} from './tomlPatch'

const reserved=new Set(['openai','ollama','lmstudio','amazon-bedrock'])
const endpoint=(value:string)=>{const url=new URL(providerURLSchema.parse(value));return `${url.origin}${url.pathname.replace(/\/+$/,'')}`}
const fingerprint=(account:StoredAccount|undefined)=>createHash('sha256').update(JSON.stringify(account?[account.id,account.kind,account.baseUrl,account.wireApi,account.credentials.apiKey]:null)).digest('hex')
const path=(id:string,key:string)=>['model_providers',id,key]
const commandAuth=(doc:TomlDocument,id:string)=>doc.raw(path(id,'auth'))!==null||doc.children(path(id,'auth')).length>0

export function providerView(doc:TomlDocument,revision:string,store:Store):ProviderConfigView {
  const providers=doc.children(['model_providers']).map(id=>{
    const values:ProviderChanges={},invalidFields:string[]=[]
    for(const key of Object.keys(providerChangesSchema.shape) as (keyof ProviderChanges)[]) {
      const raw=doc.raw(path(id,key)),value=doc.scalar(path(id,key))
      if(raw===null)continue
      if(value===null){invalidFields.push(key);continue}
      const parsed=providerChangesSchema.shape[key].safeParse(value)
      if(parsed.success && parsed.data!==undefined)Object.assign(values,{[key]:parsed.data})
      else invalidFields.push(key)
    }
    const env=doc.scalar(path(id,'env_key')),bearerConfigured=doc.raw(path(id,'experimental_bearer_token'))!==null,
      openai=doc.scalar(path(id,'requires_openai_auth'))===true,command=commandAuth(doc,id)
    const authMode:ProviderConfigEntry['authMode']=command || [!!env,bearerConfigured,openai].filter(Boolean).length>1?'custom':env?'environment':bearerConfigured?'token':openai?'openai':'none'
    return {id,values,wireApi:typeof doc.scalar(path(id,'wire_api'))==='string'?String(doc.scalar(path(id,'wire_api'))):null,
      selected:doc.scalar(['model_provider'])===id,bearerConfigured,authMode,commandAuth:command,
      envKey:typeof env==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env)?env:undefined,
      extraFields:doc.children(['model_providers',id]).filter(key=>!providerFields.includes(key as typeof providerFields[number])),invalidFields}
  })
  return {revision,providers,accounts:store.read().accounts.filter(account=>account.kind==='api_key'&&!!account.credentials.apiKey).map(account=>({id:account.id,name:account.name,baseUrl:account.baseUrl,wireApi:account.wireApi}))}
}

export function providerEdits(input:unknown,store:Store,sourceFor:(id:string)=>{target:ClientConfigTarget;source:string|null;revision:string}) {
  const parsed=previewProviderSchema.parse(input),{target,source,revision}=sourceFor(parsed.id)
  if(revision!==parsed.revision)throw new Error('配置已被其他程序修改，请重新读取后预览')
  const doc=new TomlDocument(source??''),id=parsed.providerId
  if(reserved.has(id.toLowerCase()))throw new Error('内建 Provider ID 不能覆盖，请使用自定义 ID')
  const exists=doc.children(['model_providers']).includes(id)
  if(parsed.create===exists)throw new Error(parsed.create?'此 Provider 已存在，请编辑现有配置':'Provider 已不存在，请重新读取')
  if(parsed.create&&doc.children(['model_providers']).length>=100)throw new Error('最多管理 100 个 Provider')
  const values={...parsed.changes}
  if(parsed.create)values.wire_api='responses'
  const edits:TomlEdit[]=Object.entries(values).filter(([,value])=>value!==undefined).map(([key,value])=>({path:path(id,key),raw:scalarRaw(value!)}))
  let verify:(()=>void)|undefined
  const auth=parsed.auth
  if(auth.mode!=='keep') {
    if(commandAuth(doc,id))throw new Error('此 Provider 使用命令鉴权，请保留现有鉴权或先在原配置中移除命令配置')
    const authHeader=['http_headers','env_http_headers'].some(field=>doc.children(path(id,field)).some(key=>['authorization','x-api-key','api-key'].includes(key.toLowerCase())))
    if(authHeader)throw new Error('此 Provider 存在自定义鉴权请求头，请先处理原配置中的鉴权头，再切换鉴权方式')
    for(const key of ['env_key','env_key_instructions','experimental_bearer_token','requires_openai_auth'])edits.push({path:path(id,key),raw:null})
    const set=(key:string,value:string|boolean)=>{edits.find(edit=>edit.path[2]===key)!.raw=scalarRaw(value)}
    if(auth.mode==='openai')set('requires_openai_auth',true)
    else {
      set('requires_openai_auth',false)
      if(auth.mode==='environment') {set('env_key',auth.envKey);if(auth.instructions)set('env_key_instructions',auth.instructions)}
      if(auth.mode==='token')set('experimental_bearer_token',auth.token)
      if(auth.mode==='account') {
        const account=store.read().accounts.find(account=>account.id===auth.accountId)
        if(!account||account.kind!=='api_key'||!account.credentials.apiKey)throw new Error('API 账号凭据不可用，请重新选择')
        if(account.wireApi!=='responses')throw new Error('此账号使用 Chat Completions，请通过本地 API 的 Responses 转换入口接入')
        const url=values.base_url??doc.scalar(path(id,'base_url'))
        if(typeof url!=='string'||endpoint(url)!==endpoint(account.baseUrl))throw new Error('目标地址必须与所选 API 账号一致')
        const wire=values.wire_api??doc.scalar(path(id,'wire_api'))??'responses'
        if(wire!=='responses')throw new Error('使用账号凭据时，请将客户端协议设为 Responses')
        set('experimental_bearer_token',account.credentials.apiKey)
        const expected=fingerprint(account)
        verify=()=>{if(fingerprint(store.read().accounts.find(value=>value.id===auth.accountId))!==expected)throw new Error('账号连接信息或凭据已改变，请重新预览')}
      }
    }
  }
  if(parsed.makeDefault) {
    edits.push({path:['model_provider'],raw:scalarRaw(id)})
    if(parsed.serviceTier!==undefined)edits.push({path:['service_tier'],raw:scalarRaw(parsed.serviceTier)})
  }
  return {target,source,edits:edits.filter(edit=>doc.raw(edit.path)!==edit.raw),verify,providerId:id}
}
