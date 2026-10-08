import {z} from 'zod'
import {configKeys,type ConfigKey} from '../shared/clientConfig'
import {providerFields,providerIdSchema,providerURLSchema} from '../shared/providerConfig'
import {TomlDocument} from './tomlPatch'

const rootKey=z.enum([...configKeys,'model_catalog_json','cli_auth_credentials_store','forced_login_method','sqlite_home'])
const raw=z.string().max(65536).nullable()
const profileName=z.string().min(1).max(200).refine(value=>!/[\u0000-\u001f\u007f]/.test(value))
export const configPathSchema=z.union([z.tuple([rootKey]),z.tuple([z.literal('model_providers'),providerIdSchema,z.enum(providerFields)]),z.tuple([z.literal('profiles'),profileName,z.literal('sqlite_home')])])
const base={target:z.string().uuid(),id:z.string().regex(/^\d{13}-[a-f0-9-]{36}$/),createdAt:z.number().int().positive(),
  kind:z.enum(['apply','restore']),beforeHash:z.string(),afterHash:z.string(),status:z.enum(['prepared','applied']),
  projectedFile:z.object({device:z.number(),inode:z.number()}).strict()}
export const journalSchema=z.union([
  z.object({...base,version:z.literal(1),edits:z.array(z.object({key:rootKey,before:raw,after:raw}).strict()).max(7)}).strict()
    .transform(value=>({...value,edits:value.edits.map(({key,...edit})=>({...edit,path:[key]})),providerGuards:[] as {providerId:string;after:string}[]})),
  z.object({...base,version:z.literal(2),edits:z.array(z.object({path:configPathSchema,before:raw,after:raw}).strict()).max(32),
    providerGuards:z.array(z.object({providerId:providerIdSchema,after:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(10)}).strict()
])
export function configKey(path:string[]):ConfigKey {
  return (path.length===1?path[0]:`${path[0]}.${JSON.stringify(path[1])}.${path[2]}`) as ConfigKey
}
export function displayConfigValue(path:string[],raw:string|null):string {
  if(raw===null)return '未设置'
  const value=new TomlDocument(`value = ${raw}`).scalar(['value'])
  if(path[0]==='openai_base_url'&&!providerURLSchema.safeParse(value).success)return '已设置（地址包含自定义内容）'
  if(path[0]==='model_providers') {
    if(['experimental_bearer_token','env_key_instructions'].includes(path[2]))return '已设置（内容隐藏）'
    if(path[2]==='base_url' && !providerURLSchema.safeParse(value).success)return '已设置（地址包含自定义内容）'
  }
  return value===null?'自定义值':String(value).slice(0,240)
}
