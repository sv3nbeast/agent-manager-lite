// Static adaptation of openai/codex rust-v0.153.2 codex-cli/bin/codex.js.
// Only the audited launcher is accepted; no selected JavaScript is executed.
import {createHash} from 'node:crypto'
import {closeSync,constants,existsSync,fstatSync,openSync,readSync,realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {basename,dirname,join,parse} from 'node:path'

export interface CliPackage {root:string;manager:'npm'|'pnpm'|'bun'|'vite-plus'}
export interface CliResolution {executable:string;cliPackage?:CliPackage}
const auditedLauncher='61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70'
const nativeHeaders=new Set(['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca','7f454c46'])

function readProgram(path:string,limit:number):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const stat=fstatSync(fd)
    if(!stat.isFile())throw new Error('CLI 安装文件不是普通文件')
    const data=Buffer.alloc(Math.min(stat.size,limit)+1)
    let offset=0
    while(offset<data.length){const count=readSync(fd,data,offset,data.length-offset,null);if(!count)break;offset+=count}
    return data.subarray(0,offset)
  }finally{closeSync(fd)}
}
function manifest(path:string):Record<string,any> {
  const raw=readProgram(realpathSync(path),64*1024)
  if(raw.length>64*1024)throw new Error('CLI 包信息超过大小限制')
  const value=JSON.parse(raw.toString('utf8'))
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('CLI 包信息无效')
  return value
}
function isNative(path:string):boolean {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const stat=fstatSync(fd)
    if(!stat.isFile()||!(stat.mode&0o111))throw new Error('请选择可执行的原生 Codex CLI 或受支持的 npm 入口')
    const header=Buffer.alloc(4)
    return readSync(fd,header,0,4,0)===4&&nativeHeaders.has(header.toString('hex'))
  }finally{closeSync(fd)}
}
function sameRoot(path:string,root:string):boolean {try{return realpathSync(path)===root}catch{return false}}
function packageManager(root:string,entry:string):CliPackage['manager'] {
  const pnpm=(modules:string)=>existsSync(join(modules,'.modules.yaml'))&&sameRoot(join(modules,'@openai','codex'),root)
  for(const start of new Set([root,dirname(entry)])){
    for(let current=start;;current=dirname(current)){
      if(basename(current)==='packages')try{
        const metadata=manifest(join(current,'@openai','codex.json'))
        if(metadata.name==='@openai/codex'&&(!metadata.installId||typeof metadata.installId==='string')){
          const id=metadata.installId||'',install=id.startsWith('#')?join(current,'@openai','codex'+id):join(current,'@openai','codex',id)
          if([join(install,'lib','node_modules'),join(install,'node_modules')].some(modules=>sameRoot(join(modules,'@openai','codex'),root)))return 'vite-plus'
        }
      }catch{/* Optional package-manager metadata. */}
      if(pnpm(join(current,'node_modules')))return 'pnpm'
      if(current===parse(current).root)break
    }
  }
  // The terminal launch intentionally strips npm environment overrides; use
  // persistent installation ownership rather than the manager's parent shell.
  return root.includes('/.bun/install/global')||root.includes('\\.bun\\install\\global')?'bun':'npm'
}
export function resolveCliRuntime(selected:string):CliResolution {
  const entry=realpathSync(selected)
  if(isNative(entry))return {executable:entry}
  if(basename(entry)!=='codex.js'||basename(dirname(entry))!=='bin')throw new Error('请选择原生 CLI 或标准 @openai/codex npm 入口')
  const launcher=readProgram(entry,64*1024)
  if(createHash('sha256').update(launcher).digest('hex')!==auditedLauncher)throw new Error('此 CLI 启动脚本尚未适配，请选择其原生 Codex 程序')
  const root=realpathSync(join(dirname(entry),'..')),pkg=manifest(join(root,'package.json'))
  if(pkg.name!=='@openai/codex'||pkg.bin?.codex!=='bin/codex.js')throw new Error('所选脚本不是标准 @openai/codex 安装入口')
  const cpu=process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':undefined
  const target=process.platform==='darwin'?'apple-darwin':process.platform==='linux'?'unknown-linux-musl':undefined
  if(!cpu||!target)throw new Error('当前平台的 npm CLI 运行时尚未接入')
  const platformPackage=`@openai/codex-${process.platform}-${process.arch}`
  if(typeof pkg.optionalDependencies?.[platformPackage]!=='string')throw new Error('CLI 安装缺少当前平台的依赖声明')
  let vendor=join(root,'vendor')
  try{vendor=join(dirname(createRequire(entry).resolve(platformPackage+'/package.json')),'vendor')}catch{/* Official launcher also supports the legacy bundled vendor directory. */}
  const path=join(vendor,`${cpu}-${target}`,'bin','codex')
  if(!existsSync(path))throw new Error(`Codex npm 安装不完整，缺少 ${platformPackage}；请重新安装，或选择独立原生程序`)
  const executable=realpathSync(path)
  if(!isNative(executable))throw new Error('npm 包中的 Codex 不是原生可执行程序')
  return {executable,cliPackage:{root,manager:packageManager(root,selected)}}
}
