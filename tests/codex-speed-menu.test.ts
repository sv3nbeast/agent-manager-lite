import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,lstatSync,symlinkSync,existsSync,appendFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {runInNewContext} from 'node:vm'
import {execFileSync} from 'node:child_process'
import {inspectCodexSpeedMenu,prepareCodexSpeedMenu,readCodexSpeedMenuStatus,type CodexSpeedMenuReader,type CodexSpeedMenuHook,type CodexSpeedMenuEnhancements} from '../src/main/codexSpeedMenu'

const originalHash='34a75db63c7137eb4caecdba1f36d631c10c7912487e532fd5e9dafb175bb9be',patchedHash='5d8a7434e2ce686bcf359ea16d7d889bc0df9ec4c513d0222992ff7d038807a8'
const localePatchedHash='f76d1b5e0f1ef29951cf301d1bf31f9155fbebd79e35fcb48c8a203ade2b8754',combinedPatchedHash='a21d5bf01e4280636727813c12f77fa45d87cb555606712f9c4fb98b9ef06b30'
const target='app://-/assets/app-initial-a498f911edeb.js'
const localeSource="function Wal(e){let t=(0,Kal.c)(24),{children:n,localeOverride:r}=e,i=xf($),{data:a}=vf(sBc),o=K_(`72216192`),s;t[0]===o?s=t[1]:(s=o?.get(`enable_i18n`,!1),t[0]=o,t[1]=s);let c=s,l=o?.get(`locale_source`,`IDE`),u=a?.ideLocale,d=a?.systemLocale,f=r2(r),p;bb0:{if(r){p=r;break bb0}if(l===`SYSTEM`){p=d;break bb0}if(l===`FIRST_AVAILABLE`){if(u!==void 0&&!r2(u)){p=u;break bb0}if(d!==void 0&&!r2(d)){p=d;break bb0}p=void 0;break bb0}p=u}let m=p,h;t[2]===m?h=t[3]:(h=Val(n2(m)??Yal),t[2]=m,t[3]=h);let g=h,_;bb1:{if(f){_=void 0;break bb1}try{let e;t[4]===m?e=t[5]:(e=fvs(m),t[4]=m,t[5]=e),_=e}catch{$t.error(`Failed to resolve preferred locale`),_=void 0}}let v=_,y;t[6]!==v?.locale||t[7]!==g?(y=()=>Val(v?.locale??g),t[6]=v?.locale,t[7]=g,t[8]=y):y=t[8],v?.locale;let b;t[9]===y?b=t[10]:(b=y(),t[9]=y,t[10]=b);let x=b,S,C;t[11]===x?(S=t[12],C=t[13]):(S=()=>{document.documentElement.lang=x,document.documentElement.dir=gL(x)},C=[x],t[11]=x,t[12]=S,t[13]=C),(0,qal.useEffect)(S,C);let[w,T]=(0,qal.useState)(null),E,D;t[14]!==v||t[15]!==c||t[16]!==x||t[17]!==i?(D=()=>{let e=!1;return c&&(async()=>{if(v)try{let t=await pvs(v);e||(T({locale:x,messages:t}),Ug(i,$4t,{resolvedLocale:x,bestMatchLocale:v.locale}))}catch{$t.error(`Failed to load locale messages`,{safe:{locale:v.locale},sensitive:{}}),e||T(null)}})(),()=>{e=!0}},E=[v,c,x,i],t[14]=v,t[15]=c,t[16]=x,t[17]=i,t[18]=E,t[19]=D):(E=t[18],D=t[19]),(0,qal.useEffect)(D,E);let O;bb2:{if(!c){O=void 0;break bb2}O=w?.locale===x?w.messages:void 0}let k=O,A;return t[20]!==n||t[21]!==k||t[22]!==x?(A=(0,Jal.jsx)(xne,{locale:x,defaultLocale:Yal,messages:k,onError:Gal,children:n}),t[20]=n,t[21]=k,t[22]=x,t[23]=A):A=t[23],A}"
// Relevant original release functions, kept here to exercise failed/missing
// identity responses separately from a successful custom-provider response.
const source=[
  'function TRa(e){let t=(0,ERa.c)(6),n=vf(oD),r=e?.hostId??n,i=ZC(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=bf(Ob,s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1,f;return t[3]!==u||t[4]!==d?(f={isServiceTierAllowed:d,isLoading:u},t[3]=u,t[4]=d,t[5]=f):f=t[5],f}var ERa;',
  'function Yqt(e,{runtime:t,storage:n},r,i){let a=null;return{async readServiceTier(i){for(;a!=null;)await a.catch(()=>void 0);return r(),qqt(e.requestClient,e.logger,i,async()=>{if(e.getHostId()===`local`&&await n.readGlobalState(`use-copilot-auth-if-available`)===!0&&await t.isCopilotApiAvailable())return!1;let[r,i]=await Promise.all([e.getAccount({priority:`critical`}),e.getAuthMethod({priority:`critical`}).catch(()=>null)]);return i!==`personalAccessToken`&&r.account?.type===`chatgpt`})}}}function Xqt(){return 0;}',
  localeSource+'function Gal(){}',
  'async function Qdi(e,t){let n=await KI(e,t);if(n!==`chatgpt`)return!1;let r=await Iun(e,t,{priority:`critical`});return e.query.setData(Ob,{authMethod:n,hostId:t},r),r.requirements?.featureRequirements?.fast_mode!==!1}async function $di(e){return 0;}'
].join('\n')
const patched=source.replace('a=i?.authMethod===`chatgpt`,o=','a=i?.authMethod===`chatgpt`||i?.authMethod===`apikey`||r===`local`&&i?.authMethod===null&&i?.requiresAuth===!1,o=').replace('let[r,i]=await Promise.all([e.getAccount({priority:`critical`}),e.getAuthMethod({priority:`critical`}).catch(()=>null)]);return i!==`personalAccessToken`&&r.account?.type===`chatgpt`','let[r,i]=await Promise.all([e.getAccount({priority:`critical`}),e.getAuthMethod({priority:`critical`}).catch(()=>void 0)]);return i!==`personalAccessToken`&&(r.account?.type===`chatgpt`||r.account?.type===`apiKey`||e.getHostId()===`local`&&i===null&&r.account===null&&r.requiresOpenaiAuth===!1)').replace('if(n!==`chatgpt`)return!1;','if(n!==`chatgpt`&&n!==`apikey`){if(n!==null||t!==`local`)return!1;let a;try{a=await ep(e,t).getAccount({priority:`critical`})}catch{return!1}if(a?.account!==null||a?.requiresOpenaiAuth!==!1)return!1;}')
const localePatch=(body:string)=>body.replace('let c=s,l=o?.get(`locale_source`,`IDE`)','let c=!0,l=a?.systemLocale?`SYSTEM`:`IDE`')
const localePatched=localePatch(source),combinedPatched=localePatch(patched)
const hash=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex')
function fixture(t:{after(fn:()=>void):void},enhancements:CodexSpeedMenuEnhancements='speed') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-speed-menu-'))),application=join(root,'Codex.app'),executable=join(application,'Contents','MacOS','Codex')
  const directory=join(root,'home'),desktopDirectory=join(root,'desktop'),nonce=randomUUID()
  mkdirSync(directory,{mode:0o700});mkdirSync(desktopDirectory,{mode:0o700})
  const entries=new Map<string,Buffer>([
    ['package.json',Buffer.from(JSON.stringify({name:'openai-codex-electron',version:'26.915.31945',main:'.vite/build/early-bootstrap.js'}))],
    ['webview/index.html',Buffer.from('<meta content="script-src &#39;self&#39;"><script type="module" src="./assets/index.js"></script>')],
    ['.vite/build/early-bootstrap.js',Buffer.from('Promise.resolve().then(()=>require("./bootstrap-DF0QwAxC.js"));')],
    ['.vite/build/bootstrap-DF0QwAxC.js',Buffer.from('require("electron");o.protocol.handle(`app`,handler);process.env.CODEX_ELECTRON_USER_DATA_PATH;')],
    ['webview/assets/app-initial-a498f911edeb.js',Buffer.from(source)]
  ])
  let identity='identity-1',wires=[Buffer.from([1,8,49,49,49,49,48,49,48,48])]
  const digest=(body:string|Buffer)=>String(body)===source?originalHash:String(body)===patched?patchedHash:String(body)===localePatched?localePatchedHash:String(body)===combinedPatched?combinedPatchedHash:hash(body)
  const reader:CodexSpeedMenuReader={canonical:p=>p,identity:p=>p+identity,file:()=>Buffer.alloc(0),archive:(_p,e)=>{const result=entries.get(e);if(!result)throw Error('absent fixture');return result},fuseWires:()=>wires,digest}
  const options={application,executable,platform:'darwin' as const,enhancements}
  const inspect=()=>inspectCodexSpeedMenu(options,reader)
  const prepare=()=>prepareCodexSpeedMenu({inspection:inspect(),directory,desktopDirectory,executable,nonce})!
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,application,executable,directory,desktopDirectory,nonce,entries,reader,options,inspect,prepare,digest,setIdentity:(value:string)=>{identity=value},setWires:(value:Buffer[])=>{wires=value}}
}
function runHook(f:ReturnType<typeof fixture>,hook:CodexSpeedMenuHook,changes:{env?:Record<string,string>;argv?:string[];executable?:string;type?:string;pid?:number;mainThread?:boolean;threadId?:number;cryptoDigest?:(value:string)=>string}={}) {
  const handles=new Map<string,(request:any)=>Promise<Response>|Response>()
  const protocol={handle(scheme:string,handler:(request:any)=>Promise<Response>|Response){handles.set(scheme,handler)}}
  const electron={protocol},module={_load:(request:string)=>request==='electron'?electron:{fixture:true}}
  const fixtureCrypto={createHash:()=>{let value='';return {update(body:string|Buffer){value+=body.toString();return this},digest:()=>changes.cryptoDigest?.(value)??f.digest(value)}}}
  const proc={type:changes.type??'browser',execPath:changes.executable??f.executable,argv:changes.argv??[f.executable,'--cml-instance='+f.nonce,'--user-data-dir='+f.desktopDirectory],env:{CODEX_HOME:f.directory,CODEX_ELECTRON_USER_DATA_PATH:f.desktopDirectory,...hook.env,...changes.env},pid:changes.pid??12345,getuid:process.getuid?.bind(process)}
  const req=(name:string)=>name==='node:worker_threads'?{isMainThread:changes.mainThread??true,threadId:changes.threadId??0}:name==='node:module'?module:name==='node:crypto'?fixtureCrypto: name==='node:fs'?require('node:fs'):undefined
  runInNewContext(readFileSync(hook.script,'utf8'),{require:req,process:proc,Buffer,Headers,Response},{timeout:1000})
  module._load('electron')
  return {handles,protocol,module,scope:{statusLog:hook.statusLog,nonce:f.nonce,executable:f.executable,directory:f.directory,pid:proc.pid}}
}
function response(body=source,headers:Record<string,string>={},status=200) {
  return new Response(body,{status,statusText:'OK',headers:{'content-type':'text/javascript','content-length':String(Buffer.byteLength(body)),'content-security-policy':"script-src 'self'",'etag':'"original"','content-md5':'old-digest','x-fixture':'retained',...headers}})
}

test('inspection recognizes only the audited API UI release and fingerprints all checked resources',t=>{
  const f=fixture(t),first=f.inspect()
  assert.equal(first.supported,true);assert.equal(first.assetURL,target);assert.equal(first.sourceSha256,originalHash);assert.equal(first.patchedSha256,patchedHash)
  assert.equal(f.inspect().fingerprint,first.fingerprint)
  f.setIdentity('identity-2');assert.notEqual(f.inspect().fingerprint,first.fingerprint)
  const before=f.inspect().fingerprint
  f.entries.set('.vite/build/bootstrap-DF0QwAxC.js',Buffer.from(f.entries.get('.vite/build/bootstrap-DF0QwAxC.js')!.toString()+'\n// changed'))
  assert.equal(f.inspect().supported,true);assert.notEqual(f.inspect().fingerprint,before)
})
test('locale, speed and combined inspections pin distinct checksums and manifest replacement sets',t=>{
  const f=fixture(t),states=new Map<string,string>()
  for(const [enhancements,expectedHash,count] of [['speed',patchedHash,3],['locale',localePatchedHash,1],['speed-locale',combinedPatchedHash,4]] as const){
    const inspection=inspectCodexSpeedMenu({...f.options,enhancements},f.reader)
    assert.equal(inspection.supported,true);assert.equal(inspection.enhancements,enhancements);assert.equal(inspection.patchedSha256,expectedHash)
    states.set(enhancements,inspection.fingerprint)
    const nonce=randomUUID(),hook=prepareCodexSpeedMenu({inspection,directory:f.directory,desktopDirectory:f.desktopDirectory,executable:f.executable,nonce})!
    assert.ok(hook)
    const manifest=JSON.parse(readFileSync(hook.manifest,'utf8'))
    assert.equal(manifest.enhancements,enhancements);assert.equal(manifest.replacements.length,count);assert.equal(manifest.replacementCount,count)
    assert.equal(manifest.replacementsSha256,hash(JSON.stringify(manifest.replacements)))
    assert.equal(manifest.replacements.some((entry:any)=>entry.begin==='function Wal(e){'),enhancements!=='speed')
    assert.equal(manifest.replacements.some((entry:any)=>entry.begin==='function TRa(e){'),enhancements!=='locale')
  }
  assert.equal(new Set(states.values()).size,3)
  const {enhancements:_ignored,...defaults}=f.options
  assert.equal(inspectCodexSpeedMenu(defaults,f.reader).fingerprint,states.get('speed'))
  assert.equal(inspectCodexSpeedMenu({...f.options,enhancements:'unknown' as CodexSpeedMenuEnhancements},f.reader).supported,false)
})
test('locale-only hook leaves speed unchanged, while combined hook applies one atomic resource response',async t=>{
  for(const [enhancements,expected,expectedHash] of [['locale',localePatched,localePatchedHash],['speed-locale',combinedPatched,combinedPatchedHash]] as const){
    const f=fixture(t,enhancements),runtime=runHook(f,f.prepare()),original=response()
    runtime.protocol.handle('app',()=>original)
    const transformed=await runtime.handles.get('app')!({url:target})
    assert.equal(await transformed.text(),expected);assert.equal(transformed.headers.get('etag'),'"'+expectedHash+'"')
    assert.equal(transformed.headers.get('content-security-policy'),"script-src 'self'")
    assert.deepEqual(readCodexSpeedMenuStatus(runtime.scope),{state:'active'})
  }
})
test('hook validates its pinned mode, count and exact replacement set independently of manifest content digest',t=>{
  const f=fixture(t,'locale'),hook=f.prepare(),body=readFileSync(hook.manifest,'utf8')
  for(const change of [(v:any)=>{v.enhancements='speed'},(v:any)=>{v.replacements.push(v.replacements[0])},(v:any)=>{v.replacements[0].after='let c=!1,l=`IDE`'}]){
    const value=JSON.parse(body);change(value);const altered=JSON.stringify(value)
    writeFileSync(hook.manifest,altered)
    const runtime=runHook(f,hook,{cryptoDigest:value=>value===altered?hash(body):f.digest(value)}),handler=()=>response()
    runtime.protocol.handle('app',handler);assert.equal(runtime.handles.get('app'),handler)
    assert.match(readCodexSpeedMenuStatus(runtime.scope).reason!,/适配文件/)
  }
})
test('unsupported platforms, wrong package versions and drifted JS use the original client',t=>{
  const f=fixture(t)
  assert.equal(inspectCodexSpeedMenu({...f.options,platform:'linux'},f.reader).supported,false)
  f.entries.set('package.json',Buffer.from('{"name":"openai-codex-electron","version":"26.999.1","main":".vite/build/early-bootstrap.js"}'))
  assert.match(f.inspect().reason,/版本/)
  f.entries.set('package.json',Buffer.from('{"name":"openai-codex-electron","version":"26.915.31945","main":".vite/build/early-bootstrap.js"}'))
  f.entries.set('webview/assets/app-initial-a498f911edeb.js',Buffer.from(source+'\n// updated'))
  assert.match(f.inspect().reason,/资源已变化/)
})
test('disabled, missing, truncated and disagreeing universal fuse wires disable enhancement',t=>{
  const f=fixture(t)
  for(const wires of [[],[Buffer.from([1,3,49,49,48])],[Buffer.from([2,3,49,49,49])],[Buffer.from([1,4,49,49,49])],[Buffer.from([1,3,49,49,49]),Buffer.from([1,3,49,49,48])]]){
    f.setWires(wires);const state=f.inspect();assert.equal(state.supported,false);assert.match(state.reason,/启动兼容参数/)
  }
})
test('SRI, restrictive CSP and changed registration paths do not weaken page policies',t=>{
  const f=fixture(t),html=f.entries.get('webview/index.html')!
  for(const page of ['<meta content="script-src \'self\' \'strict-dynamic\'"><script src="x.js"></script>', '<meta content="script-src \'self\'"><script integrity="sha256-old" src="x.js"></script>', '<meta content="script-src \'sha256-only\'"><script src="x.js"></script>']){
    f.entries.set('webview/index.html',Buffer.from(page));assert.match(f.inspect().reason,/完整性/)
  }
  f.entries.set('webview/index.html',html);f.entries.set('.vite/build/bootstrap-DF0QwAxC.js',Buffer.from('require("electron");changedLoader();'))
  assert.match(f.inspect().reason,/加载方式/)
})
test('prepare rechecks resource drift, refuses forged inspections and writes only private atomic hook files',t=>{
  const f=fixture(t),inspection=f.inspect()
  assert.equal(prepareCodexSpeedMenu({inspection:{...inspection},directory:f.directory,desktopDirectory:f.desktopDirectory,executable:f.executable,nonce:f.nonce}),undefined)
  f.setIdentity('updated')
  assert.equal(prepareCodexSpeedMenu({inspection,directory:f.directory,desktopDirectory:f.desktopDirectory,executable:f.executable,nonce:f.nonce}),undefined)
  const hook=f.prepare();assert.ok(hook)
  for(const path of [hook.script,hook.manifest,hook.statusLog])assert.equal(lstatSync(path).mode&0o777,0o600)
  assert.equal(lstatSync(join(f.desktopDirectory,'cml-speed-menu',f.nonce)).mode&0o777,0o700)
  assert.deepEqual(Object.keys(hook.env).sort(),['CML_CODEX_SPEED_MENU_LOG','CML_CODEX_SPEED_MENU_MANIFEST'])
  assert.equal(existsSync(join(f.directory,'auth.json')),false);assert.equal(existsSync(join(f.directory,'config.toml')),false)
  assert.equal(f.prepare(),undefined,'existing nonce directory is never overwritten')
})
test('prepare rejects symlink hook directories and paths outside the owned desktop directory',t=>{
  const f=fixture(t)
  const outside=join(f.root,'outside');mkdirSync(outside,{mode:0o700});symlinkSync(outside,join(f.desktopDirectory,'cml-speed-menu'))
  assert.equal(f.prepare(),undefined)
  assert.equal(prepareCodexSpeedMenu({inspection:f.inspect(),directory:f.directory,desktopDirectory:f.desktopDirectory,executable:f.executable,nonce:randomUUID(),hookDirectory:outside}),undefined)
  assert.equal(existsSync(join(outside,f.nonce)),false)
})
test('generated hook patches only the exact matching app resource and preserves response headers',async t=>{
  const f=fixture(t),hook=f.prepare(),runtime=runHook(f,hook)
  const original=response();runtime.protocol.handle('app',()=>original)
  const changed=await runtime.handles.get('app')!({url:target})
  assert.notEqual(changed,original);assert.equal(await changed.text(),patched)
  assert.equal(changed.status,200);assert.equal(changed.statusText,'OK')
  assert.equal(changed.headers.get('content-length'),String(Buffer.byteLength(patched)))
  assert.equal(changed.headers.get('content-security-policy'),"script-src 'self'")
  assert.equal(changed.headers.get('x-fixture'),'retained');assert.equal(changed.headers.get('etag'),'"'+patchedHash+'"')
  assert.equal(changed.headers.has('content-md5'),false)
  assert.deepEqual(readCodexSpeedMenuStatus(runtime.scope),{state:'active'})
  const other=response('export const unrelated = true;'),handler=()=>other
  runtime.protocol.handle('app',handler);assert.equal(await runtime.handles.get('app')!({url:'app://-/assets/other.js'}),other)
  runtime.protocol.handle('fixture',handler);assert.equal(runtime.handles.get('fixture'),handler)
})
test('custom-provider UI requires an explicit local no-auth identity and successful requirements',()=>{
  const begin=patched.indexOf('function TRa(e){'),end=patched.indexOf('}var ERa;',begin)
  const create=new Function('ERa','vf','oD','ZC','bf','Ob',patched.slice(begin,end+1)+';return TRa;')
  function allowed(authMethod:unknown,requiresAuth:unknown,hostId='local',options:{authLoading?:boolean;pending?:boolean;data?:unknown}={}){
    const component=create({c:(length:number)=>new Array(length).fill(Symbol())},()=>'local',null,()=>({authMethod,requiresAuth,isLoading:options.authLoading??false}),()=>({data:options.data===undefined?{requirements:null}:options.data,isPending:options.pending??false}),null)
    return component({hostId}).isServiceTierAllowed
  }
  assert.equal(allowed(null,false),true)
  for(const [method,required,host] of [[null,undefined,'local'],[null,true,'local'],[undefined,false,'local'],[null,false,'remote'],['personalAccessToken',false,'local'],['copilot',false,'local']])assert.equal(allowed(method,required,host as string),false)
  assert.equal(allowed(null,false,'local',{authLoading:true}),false)
  assert.equal(allowed(null,false,'local',{pending:true}),false)
  assert.equal(allowed(null,false,'local',{data:null}),false)
  assert.equal(allowed(null,false,'local',{data:{requirements:{featureRequirements:{fast_mode:false}}}}),false)
  assert.equal(allowed('chatgpt',true),true);assert.equal(allowed('apikey',true),true)
})
test('saved speed distinguishes successful custom-provider identity from failed or incomplete auth',async()=>{
  const begin=patched.indexOf('function Yqt(e,{runtime:t,storage:n},r,i){'),end=patched.indexOf('function Xqt(){',begin)
  const create=new Function('qqt',patched.slice(begin,end)+';return Yqt;')((_client:unknown,_logger:unknown,_model:unknown,authorize:()=>Promise<boolean>)=>authorize())
  async function allowed(options:{method?:unknown;account?:unknown;host?:string;authFailure?:boolean;accountFailure?:boolean;copilot?:boolean}={}){
    const manager={getHostId:()=>options.host??'local',getAccount:async()=>{if(options.accountFailure)throw Error('read failed');return options.account??{account:null,requiresOpenaiAuth:false}},getAuthMethod:async()=>{if(options.authFailure)throw Error('auth failed');return options.method===undefined?null:options.method}}
    return create(manager,{runtime:{isCopilotApiAvailable:async()=>options.copilot??false},storage:{readGlobalState:async()=>options.copilot??false}},()=>{},()=>{}).readServiceTier('fixture-model')
  }
  assert.equal(await allowed(),true)
  assert.equal(await allowed({authFailure:true}),false)
  for(const account of [{account:null},{account:null,requiresOpenaiAuth:true},{requiresOpenaiAuth:false},{account:{type:'unknown'},requiresOpenaiAuth:false}])assert.equal(await allowed({account}),false)
  assert.equal(await allowed({host:'remote'}),false)
  assert.equal(await allowed({method:'personalAccessToken'}),false)
  assert.equal(await allowed({copilot:true}),false)
  assert.equal(await allowed({method:'chatgpt',account:{account:{type:'chatgpt'},requiresOpenaiAuth:true}}),true)
  assert.equal(await allowed({method:'apikey',account:{account:{type:'apiKey'},requiresOpenaiAuth:true}}),true)
  await assert.rejects(allowed({accountFailure:true}),/read failed/)
})
test('follow-up speed confirms account/read before allowing a null custom-provider identity',async()=>{
  const begin=patched.indexOf('async function Qdi(e,t){'),end=patched.indexOf('async function $di(',begin)
  const create=new Function('KI','ep','Iun','Ob',patched.slice(begin,end)+';return Qdi;')
  async function run(options:{method?:unknown;account?:unknown;host?:string;accountFailure?:boolean;requirements?:unknown}={}){
    let accountReads=0,requirementReads=0,queryWrites=0
    const scope={query:{setData(){queryWrites++}}},host=options.host??'local'
    const follow=create(async()=>options.method===undefined?null:options.method,(e:unknown,t:unknown)=>{assert.equal(e,scope);assert.equal(t,host);return {getAccount:async(priority:unknown)=>{assert.deepEqual(priority,{priority:'critical'});accountReads++;if(options.accountFailure)throw Error('account failed');return options.account??{account:null,requiresOpenaiAuth:false}}}},async()=>{requirementReads++;return {requirements:options.requirements??null}},null)
    return {allowed:await follow(scope,host),accountReads,requirementReads,queryWrites}
  }
  assert.deepEqual(await run(),{allowed:true,accountReads:1,requirementReads:1,queryWrites:1})
  for(const options of [{accountFailure:true},{account:{account:null}},{account:{requiresOpenaiAuth:false}},{account:{account:{},requiresOpenaiAuth:false}},{account:{account:null,requiresOpenaiAuth:true}}])assert.deepEqual(await run(options),{allowed:false,accountReads:1,requirementReads:0,queryWrites:0})
  assert.deepEqual(await run({host:'remote'}),{allowed:false,accountReads:0,requirementReads:0,queryWrites:0})
  assert.deepEqual(await run({method:'personalAccessToken'}),{allowed:false,accountReads:0,requirementReads:0,queryWrites:0})
  assert.equal((await run({requirements:{featureRequirements:{fast_mode:false}}})).allowed,false)
  for(const method of ['chatgpt','apikey'])assert.deepEqual(await run({method}),{allowed:true,accountReads:0,requirementReads:1,queryWrites:1})
})
test('audited locale provider loads built-in messages without experiments and follows live manual or system choices',async t=>{
  const archive='/Applications/ChatGPT.app/Contents/Resources/app.asar'
  if(!existsSync(archive)){t.skip('audited local language resources unavailable');return}
  const asar=require('@electron/asar'),whole=asar.extractFile(archive,'webview/assets/app-initial-a498f911edeb.js').toString()
  if(hash(whole)!==originalHash){t.skip('installed renderer is no longer the audited release');return}
  assert.equal(whole.slice(whole.indexOf('function Wal(e){'),whole.indexOf('function Gal(){}',whole.indexOf('function Wal(e){'))),localeSource)
  const localeFns=whole.slice(whole.indexOf('function n2(e){'),whole.indexOf('var mvs,hvs,gvs,_vs;',whole.indexOf('function n2(e){')))
  const val=whole.slice(whole.indexOf('function Val(e){'),whole.indexOf('function Hal(e){'))
  const messages=new Map<string,Record<string,string>>()
  for(const locale of ['zh-CN','zh-TW','fr-FR']){
    const entry:string=asar.listPackage(archive).find((path:string)=>new RegExp('^/webview/assets/'+locale+'-[a-f0-9]+\\.js$').test(path))!
    assert.ok(entry)
    const body:string=asar.extractFile(archive,entry.slice(1)).toString()
    if(locale==='zh-CN')assert.equal(hash(body),'8efc626e770f7cd9d6df48c1c1602e2cccd5e49b90a54db6206c01c1cabacf5d')
    const exported=body.match(/\b([A-Za-z_$][\w$]*) as default/)?.[1]
    assert.ok(exported)
    // Execute only the packaged translation dictionary initialization. The
    // official app renderer, windows, profiles and network are never opened.
    const dictionary=new Function('e',body.replace(/^import\{n as e\}from"\.\/rolldown-runtime-2d059c5e81f4\.js";/,'').replace(/export\{[^}]+\};/,'return '+exported+';'))((initialize:()=>unknown)=>()=>initialize())
    assert.equal(typeof dictionary,'object');messages.set(locale,dictionary)
  }
  assert.equal(messages.get('zh-CN')!['settings.ide.language.description'],'应用 UI 语言')
  assert.equal(messages.get('zh-CN')!['settings.ide.language.auto'],'自动检测')
  function create(component:string){
    let info:{ideLocale?:string;systemLocale?:string}|undefined,layer:{get(name:string,fallback:unknown):unknown}|undefined,state:unknown=null,effects:Array<()=>unknown>=[],effectIndex=0
    const prior=new Map<number,unknown[]>(),cache=new Array(24).fill(Symbol.for('react.memo_cache_sentinel')),store={}
    let loads=0
    const context:any={Intl,document:{documentElement:{}},Kal:{c:()=>cache},xf:()=>store,$:{},vf:()=>({data:info}),sBc:{},K_:()=>layer,
      qal:{useState:()=>[state,(value:unknown)=>{state=value}],useEffect:(effect:()=>unknown,deps:unknown[])=>{const index=effectIndex++,old=prior.get(index);if(!old||deps.some((dep,i)=>dep!==old[i])){effects.push(effect);prior.set(index,deps)}}},
      $t:{error(){}},Ug(){},$4t:{},Jal:{jsx:(_type:unknown,props:unknown)=>props},xne:{},Gal(){},Yal:'en-US',gL:()=> 'ltr',Sre:{zh:'zh-CN',fr:'fr-FR'},
      _vs:[...messages].map(([locale,value])=>({locale,normalized:locale.toLowerCase(),language:locale.split('-')[0].toLowerCase(),load:async()=>{loads++;return{default:value}}}))}
    const render=runInNewContext(localeFns+val+component+';Wal;',context)
    return {async render(override:string|null,localeInfo:typeof info,experiment?:boolean){
      info=localeInfo;layer=experiment===undefined?undefined:{get:(name,fallback)=>name==='enable_i18n'?experiment:name==='locale_source'?'IDE':fallback}
      effectIndex=0;effects=[];render({localeOverride:override,children:'fixture'})
      for(const effect of effects)effect()
      await new Promise<void>(resolve=>setImmediate(resolve))
      effectIndex=0;const output=render({localeOverride:override,children:'fixture'})
      return {locale:output.locale,messages:output.messages,lang:context.document.documentElement.lang,loads}
    }}
  }
  const original=create(localeSource)
  assert.equal((await original.render('zh-CN',{ideLocale:'en-US',systemLocale:'zh-Hans-CN'})).messages,undefined)
  const corrected=create(localePatch(localeSource))
  for(const experiment of [undefined,false,true]){
    const chinese=await corrected.render('zh-CN',{ideLocale:'en-US',systemLocale:'en-US'},experiment)
    assert.equal(chinese.lang,'zh-CN');assert.equal(chinese.messages['settings.ide.language.description'],'应用 UI 语言')
  }
  const auto=await corrected.render(null,{ideLocale:'en-US',systemLocale:'zh-Hans-CN'},false)
  assert.equal(auto.locale,'zh-CN');assert.equal(auto.messages['settings.ide.language.auto'],'自动检测')
  const english=await corrected.render('en-US',{ideLocale:'en-US',systemLocale:'zh-Hans-CN'},false)
  assert.equal(english.locale,'en-US');assert.equal(english.messages,undefined)
  const french=await corrected.render('fr-FR',{ideLocale:'en-US',systemLocale:'zh-Hans-CN'},false)
  assert.equal(french.locale,'fr-FR');assert.equal(french.messages,messages.get('fr-FR'))
  const traditional=await corrected.render('zh-TW',{ideLocale:'en-US',systemLocale:'zh-Hans-CN'},false)
  assert.equal(traditional.locale,'zh-TW');assert.equal(traditional.messages,messages.get('zh-TW'))
  const systemEnglish=await corrected.render(null,{ideLocale:'zh-CN',systemLocale:'en-US'},false)
  assert.equal(systemEnglish.locale,'en-US');assert.equal(systemEnglish.messages,undefined)
  const fallback=await corrected.render(null,{ideLocale:'zh-CN'},false)
  assert.equal(fallback.locale,'zh-CN');assert.equal(fallback.messages,messages.get('zh-CN'))
  const unknown=await corrected.render('zz-ZZ',{ideLocale:'zh-CN',systemLocale:'zh-Hans-CN'},false)
  assert.equal(unknown.locale,'zz-ZZ');assert.equal(unknown.messages,undefined)
  const unready=await corrected.render(null,undefined,false)
  assert.equal(unready.locale,'en-US');assert.equal(unready.messages,undefined)
})
test('generated hook fails closed for changed, compressed, partial and unreadable responses',async t=>{
  const f=fixture(t),runtime=runHook(f,f.prepare())
  for(const original of [response(source+'\n// update'),response(source,{'content-encoding':'gzip'}),response(source,{'content-type':'text/html'}),response(source,{},206)]){
    runtime.protocol.handle('app',()=>original);assert.equal(await runtime.handles.get('app')!({url:target}),original)
  }
  const unreadable=response();unreadable.clone=()=>{throw Error('fixture error with possible secret')}
  runtime.protocol.handle('app',()=>unreadable);assert.equal(await runtime.handles.get('app')!({url:target}),unreadable)
  assert.match(readCodexSpeedMenuStatus(runtime.scope).reason!,/页面适配失败/)
  assert.equal(readFileSync(runtime.scope.statusLog,'utf8').includes('possible secret'),false)
})
test('generated hook refuses a patched checksum mismatch and preserves the original response',async t=>{
  const f=fixture(t),runtime=runHook(f,f.prepare(),{cryptoDigest:value=>value===patched?hash(patched):f.digest(value)})
  const original=response();runtime.protocol.handle('app',()=>original)
  assert.equal(await runtime.handles.get('app')!({url:target}),original)
  assert.match(readCodexSpeedMenuStatus(runtime.scope).reason!,/校验失败/)
})
test('scope requires the exact home, desktop directory, executable and unique nonce',t=>{
  const f=fixture(t),hook=f.prepare()
  for(const change of [{env:{CODEX_HOME:'/other'}},{env:{CODEX_ELECTRON_USER_DATA_PATH:'/other'}},{executable:'/other'},{argv:[f.executable,'--cml-instance=other','--user-data-dir='+f.desktopDirectory]},{argv:[f.executable,'--cml-instance='+f.nonce,'--cml-instance=other','--user-data-dir='+f.desktopDirectory]},{env:{CML_CODEX_SPEED_MENU_MANIFEST:'/other'}},{argv:[f.executable,'--cml-instance='+f.nonce]}]){
    const runtime=runHook(f,hook,change);const handler=()=>response();runtime.protocol.handle('app',handler)
    assert.equal(runtime.handles.get('app'),handler);assert.match(readCodexSpeedMenuStatus(runtime.scope).reason!,/启动参数未生效/)
  }
})
test('worker preloads cannot install the hook or overwrite a successful main-process status',async t=>{
  const f=fixture(t),hook=f.prepare(),main=runHook(f,hook)
  main.protocol.handle('app',()=>response());await main.handles.get('app')!({url:target})
  const before=readFileSync(hook.statusLog,'utf8')
  assert.deepEqual(readCodexSpeedMenuStatus(main.scope),{state:'active'})
  for(const changes of [{mainThread:false,threadId:1,argv:[f.executable]},{mainThread:false,threadId:2},{mainThread:true,threadId:3}]){
    const worker=runHook(f,hook,changes),handler=()=>response()
    worker.protocol.handle('app',handler)
    assert.equal(worker.handles.get('app'),handler)
    assert.equal(readFileSync(hook.statusLog,'utf8'),before)
    assert.deepEqual(readCodexSpeedMenuStatus(main.scope),{state:'active'})
  }
})
test('later real resource failures remain visible after a successful patch',async t=>{
  const f=fixture(t),main=runHook(f,f.prepare())
  main.protocol.handle('app',()=>response());await main.handles.get('app')!({url:target})
  assert.equal(readCodexSpeedMenuStatus(main.scope).state,'active')
  const changed=response(source+'\n// updated release')
  main.protocol.handle('app',()=>changed)
  assert.equal(await main.handles.get('app')!({url:target}),changed)
  const status=readCodexSpeedMenuStatus(main.scope)
  assert.equal(status.state,'fallback');assert.match(status.reason!,/客户端更新后需重新适配/)
})
test('status ignores foreign processes and explicit worker records even when nonce and PID match',async t=>{
  const f=fixture(t),hook=f.prepare(),main=runHook(f,hook)
  main.protocol.handle('app',()=>response());await main.handles.get('app')!({url:target})
  for(const record of [{pid:12346,kind:'disabled',reason:'scope'},{pid:12346,kind:'original',reason:'source'},{pid:12345,mainThread:false,threadId:1,kind:'original',reason:'source'},{pid:12345,mainThread:true,threadId:1,kind:'original',reason:'source'}]){
    appendFileSync(hook.statusLog,JSON.stringify({...main.scope,mainThread:true,threadId:0,...record})+'\n')
    assert.deepEqual(readCodexSpeedMenuStatus(main.scope),{state:'active'})
  }
  const own={...main.scope,mainThread:true,threadId:0}
  appendFileSync(hook.statusLog,JSON.stringify({...own,kind:'original',reason:'source'})+'\n')
  assert.equal(readCodexSpeedMenuStatus(main.scope).state,'fallback')
  appendFileSync(hook.statusLog,JSON.stringify({...own,pid:12346,kind:'patched'})+'\n')
  assert.equal(readCodexSpeedMenuStatus(main.scope).state,'fallback')
})
test('a later aborted preload cannot replace the last actual resource outcome',async t=>{
  const f=fixture(t),hook=f.prepare(),main=runHook(f,hook)
  // Reproduce the historical patched -> disabled/scope sequence without
  // assuming whether the second invocation was a Worker or a main re-entry.
  main.protocol.handle('app',()=>response());await main.handles.get('app')!({url:target})
  const reentry=runHook(f,hook,{argv:[f.executable]}),handler=()=>response()
  reentry.protocol.handle('app',handler);assert.equal(reentry.handles.get('app'),handler)
  assert.match(readFileSync(hook.statusLog,'utf8'),/"kind":"disabled","reason":"scope"/)
  assert.deepEqual(readCodexSpeedMenuStatus(main.scope),{state:'active'})
  const changed=response(source+'\n// updated release')
  main.protocol.handle('app',()=>changed);await main.handles.get('app')!({url:target})
  runHook(f,hook,{argv:[f.executable]})
  assert.match(readCodexSpeedMenuStatus(main.scope).reason!,/客户端更新后需重新适配/)
  main.protocol.handle('app',()=>response());await main.handles.get('app')!({url:target})
  assert.deepEqual(readCodexSpeedMenuStatus(main.scope),{state:'active'})
})
test('fallback explains the affected feature and a next action for each enhancement mode',t=>{
  for(const [enhancements,feature] of [['speed','普通 / Fast 菜单'],['locale','页面翻译'],['speed-locale','页面翻译和普通 / Fast 菜单']] as const){
    const f=fixture(t,enhancements),main=runHook(f,f.prepare(),{argv:[f.executable]})
    assert.deepEqual(readCodexSpeedMenuStatus({...main.scope,enhancements}),{state:'fallback',reason:feature+'未加载（启动参数未生效），请重启实例后再试'})
  }
})
test('tampered or symlink manifest disables the hook and non-browser processes do not install it',t=>{
  const f=fixture(t),hook=f.prepare();appendFileSync(hook.manifest,' ')
  const runtime=runHook(f,hook),handler=()=>response();runtime.protocol.handle('app',handler)
  assert.equal(runtime.handles.get('app'),handler);assert.match(readCodexSpeedMenuStatus(runtime.scope).reason!,/适配文件/)
  const utility=runHook(f,hook,{type:'utility'});utility.protocol.handle('app',handler);assert.equal(utility.handles.get('app'),handler)
  const other=join(f.root,'other.json');writeFileSync(other,'{}');rmSync(hook.manifest);symlinkSync(other,hook.manifest)
  const symlinked=runHook(f,hook);symlinked.protocol.handle('app',handler);assert.equal(symlinked.handles.get('app'),handler)
})
test('status accepts only instance-scoped records and does not expose arbitrary log messages',t=>{
  const f=fixture(t),hook=f.prepare(),scope={statusLog:hook.statusLog,nonce:f.nonce,executable:f.executable,directory:f.directory}
  assert.deepEqual(readCodexSpeedMenuStatus(scope),{state:'pending',reason:'等待客户端加载界面'})
  appendFileSync(hook.statusLog,'not-json\n'+JSON.stringify({nonce:'other',executable:f.executable,directory:f.directory,kind:'patched'})+'\n')
  assert.deepEqual(readCodexSpeedMenuStatus(scope),{state:'pending',reason:'等待客户端加载界面'})
  appendFileSync(hook.statusLog,JSON.stringify({...scope,kind:'disabled',reason:'secret-key-fixture'})+'\n')
  assert.deepEqual(readCodexSpeedMenuStatus(scope),{state:'fallback',reason:'普通 / Fast 菜单未加载，请重启实例后再试'})
})
test('missing or stalled status becomes a clear fallback instead of remaining pending indefinitely',t=>{
  const f=fixture(t),hook=f.prepare(),scope={statusLog:hook.statusLog,nonce:f.nonce,executable:f.executable,directory:f.directory}
  assert.equal(readCodexSpeedMenuStatus(scope,Date.now()+21000).state,'fallback')
  rmSync(hook.statusLog);assert.match(readCodexSpeedMenuStatus(scope).reason!,/无法读取加载状态/)
})
test('aborted requests and upstream handler failures retain the original protocol behavior',async t=>{
  const f=fixture(t),runtime=runHook(f,f.prepare()),original=response()
  runtime.protocol.handle('app',()=>original)
  assert.equal(await runtime.handles.get('app')!({url:target,signal:{aborted:true}}),original)
  runtime.protocol.handle('app',()=>{throw Error('fixture-handler')})
  await assert.rejects(runtime.handles.get('app')!({url:target}),/fixture-handler/)
})

test('all enhancement modes run in project Electron against audited JS without running the official UI',{timeout:45000},t=>{
  const application='/Applications/ChatGPT.app',executable=join(application,'Contents','MacOS','ChatGPT'),inspection=inspectCodexSpeedMenu({application,executable,platform:'darwin'})
  if(process.platform!=='darwin'||!inspection.supported){t.skip('audited local client / macOS fixture unavailable');return}
  const ownElectron=resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const asar=require('@electron/asar')
  const actualSource=asar.extractFile(join(application,'Contents','Resources','app.asar'),'webview/assets/app-initial-a498f911edeb.js')
  for(const [enhancements,expectedHash] of [['speed',patchedHash],['locale',localePatchedHash],['speed-locale',combinedPatchedHash]] as const){
  const f=fixture(t,enhancements)
  f.entries.set('webview/assets/app-initial-a498f911edeb.js',actualSource)
  const fixtureReader={...f.reader,digest:hash},fixtureInspection=inspectCodexSpeedMenu({application:resolve('node_modules/electron/dist/Electron.app'),executable:ownElectron,platform:'darwin',enhancements},fixtureReader)
  const hook=prepareCodexSpeedMenu({inspection:fixtureInspection,directory:f.directory,desktopDirectory:f.desktopDirectory,executable:ownElectron,nonce:f.nonce})!
  assert.ok(hook)
  // Only the project's Electron is executed. The audited source is served as data,
  // fetched and checksummed; no official renderer JavaScript is ever evaluated.
  const fixturePath=join(f.root,'electron-fixture.cjs')
  writeFileSync(fixturePath,`const fs=require('node:fs'),crypto=require('node:crypto'),{app,protocol,net}=require('electron');
app.setPath('userData',${JSON.stringify(f.desktopDirectory)});
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const asar=require(${JSON.stringify(resolve('node_modules/@electron/asar'))});
app.whenReady().then(async()=>{
  const source=asar.extractFile(${JSON.stringify(join(application,'Contents','Resources','app.asar'))},'webview/assets/app-initial-a498f911edeb.js');
  let served=source;
  protocol.handle('app',()=>new Response(served,{headers:{'content-type':'text/javascript','content-length':String(served.length),'content-security-policy':"script-src 'self'",'cache-control':'no-store'}}));
  const fetchBody=async()=>{const response=await net.fetch(${JSON.stringify(target)},{cache:'no-store'});const body=await response.text();return{response,body,digest:crypto.createHash('sha256').update(body).digest('hex')}};
  const {response,body,digest}=await fetchBody();
  if(digest!==${JSON.stringify(expectedHash)}||response.headers.get('content-length')!==String(Buffer.byteLength(body))||response.headers.get('content-security-policy')!=="script-src 'self'")throw Error('fixture mismatch');
  const reenter=()=>{const saved=process.argv;try{process.argv=[process.execPath];delete require.cache[require.resolve(${JSON.stringify(hook.script)})];require(${JSON.stringify(hook.script)});}finally{process.argv=saved;}};
  reenter();
  const log=fs.readFileSync(${JSON.stringify(hook.statusLog)},'utf8');
  const last=JSON.parse(log.trim().split('\\n').at(-1));
  if(last.kind!=='disabled'||last.reason!=='scope'||last.pid!==process.pid||last.mainThread!==true||last.threadId!==0)throw Error('reentry not reproduced');
  fs.writeFileSync(${JSON.stringify(join(f.root,'stage-active.jsonl'))},log);
  served=Buffer.concat([source,Buffer.from('\\n// changed fixture resource')]);
  if((await fetchBody()).body!==served.toString('utf8'))throw Error('original response not preserved');
  reenter();fs.copyFileSync(${JSON.stringify(hook.statusLog)},${JSON.stringify(join(f.root,'stage-original.jsonl'))});
  served=source;
  if((await fetchBody()).digest!==${JSON.stringify(expectedHash)})throw Error('patch did not recover');
  console.log('CML_GENERATED_HOOK_FIXTURE_OK');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});`)
  const output=execFileSync(ownElectron,[fixturePath,'--cml-instance='+f.nonce,'--user-data-dir='+f.desktopDirectory],{env:{...process.env,NODE_OPTIONS:'--require="'+hook.script+'"',CODEX_HOME:f.directory,CODEX_ELECTRON_USER_DATA_PATH:f.desktopDirectory,...hook.env},timeout:15000,encoding:'utf8',maxBuffer:128*1024})
  assert.match(output,/CML_GENERATED_HOOK_FIXTURE_OK/)
  const scope={nonce:f.nonce,executable:ownElectron,directory:f.directory,enhancements}
  assert.equal(readCodexSpeedMenuStatus({...scope,statusLog:join(f.root,'stage-active.jsonl')}).state,'active')
  assert.equal(readCodexSpeedMenuStatus({...scope,statusLog:join(f.root,'stage-original.jsonl')}).state,'fallback')
  assert.equal(readCodexSpeedMenuStatus({...scope,statusLog:hook.statusLog}).state,'active')
  }
})
