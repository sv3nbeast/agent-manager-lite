import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {applyCodexUiReplacements,codexUiAccessMapperImportPaths,detectCodexUiCapabilities,type CodexUiFeature} from '../src/main/codexUiCapabilities'
import {inspectCodexDesktopUi,inspectCodexSpeedMenu,prepareCodexSpeedMenu,type CodexSpeedMenuReader} from '../src/main/codexSpeedMenu'

// A synthetic module models semantic roles without copying an upstream bundle.
const source=[
  'function translated({localeOverride:r}){let data=currentLocales(),experiment=getExperiment(),enabled=experiment?.get(`enable_i18n`,!1);let use=enabled,choice=experiment?.get(`locale_source`,`IDE`),ide=data?.ideLocale,system=data?.systemLocale;void `Failed to load locale messages`;return {enabled:use,locale:r??(choice===`SYSTEM`?system:ide)}}',
  'function menu(e){let r=e?.hostId??`local`,i=readIdentity(r),allowed=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`;const key={authMethod:i?.authMethod,hostId:r};let {data:c,isPending:l}=readQuery(key),loading=!!i?.isLoading||allowed&&l,permitted=allowed&&!loading&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1;return {isServiceTierAllowed:permitted,isLoading:loading,key}}',
  'function speedControls(thread){const {data:x,isPending:S}=readQuery({}),{isServiceTierAllowed:E}=menu({hostId:`local`});const loading=thread==null&&S;return {serviceTierSettings:{isLoading:loading,availableOptions:[`standard`,`fast`]},setServiceTier:()=>{}}}',
  'async function confirm(e,t){let n=await accountMethod(e,t);if(n!==`chatgpt`&&n!==`personalAccessToken`)return!1;let r=await readRequirements(e,t);return e.query.setData(requirementKey,{authMethod:n,hostId:t},r),r.requirements?.featureRequirements?.fast_mode!==!1}',
  'async function accountMethod(e,t){let r=e.get(rpcKey,t);const [account,method]=await Promise.all([unwrap(r.rpc.getAccount({priority:`critical`})),r.rpc.getAuthMethod()]);return method}',
  'function initLevels(){return new Set([...readSetting(settings.enabledReasoningEfforts),`persistent`])}',
  'function catalogue({includeUltraReasoningEffort:s,enabledReasoningEfforts:a,models:l}){let max=l.some(m=>m.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),ultra=s&&l.some(m=>m.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));const models=l.map(i=>{let e=s?i.supportedReasoningEfforts:i.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`);return {...i,supportedReasoningEfforts:e.filter(({reasoningEffort:e})=>a.has(e))}});return {models,hasModelSupportingUltraReasoningEffort:ultra,hasModelSupportingMaxReasoningEffort:max}}',
  'function savedReasoning(e,reasoningEffort){return reasoningEffort===`ultra`&&!e(flag,`536305374`)?undefined:reasoningEffort}',
  'function updateReasoning(e,t){return (t.thinkingEffort!==`ultra`||e.get(flag,`536305374`))?t.thinkingEffort:null}',
  'function startReasoning(e,t){return t.thinkingEffort===`ultra`&&!e.get(flag,`536305374`)?null:t.thinkingEffort}'
].join('\n')

// The current client returns per-tier access through a shared mapper. Keep a
// small independent fixture so both protocols remain covered after app updates.
const accessSource=source.split('\n').map(line=>{
  if(line.startsWith('function menu'))return 'import {mapAccess} from \"./app-shared.js\"\nfunction menu(e){let r=e?.hostId??`local`,i=readIdentity(r),allowed=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`;const key={authMethod:i?.authMethod,hostId:r};let {data:c,isPending:l}=readQuery(key),loading=!!i?.isLoading||allowed&&l,access=allowed&&!loading&&c!=null?mapAccess(c):null;return {serviceTierAccess:access,isLoading:loading,key}}'
  if(line.startsWith('function speedControls'))return 'function speedControls(thread){const {data:x,isPending:S}=readQuery({}),{serviceTierAccess:E}=menu({hostId:`local`});const loading=thread==null&&S;return {serviceTierAccess:E,serviceTierSettings:{isLoading:loading,availableOptions:[`standard`,`fast`]},setServiceTier:()=>{}}}'
  if(line.startsWith('async function confirm'))return 'async function confirm(e,t){let n=await accountMethod(e,t);if(n!==`chatgpt`&&n!==`personalAccessToken`)return null;let r=await readRequirements(e,t);return e.query.setData(requirementKey,{authMethod:n,hostId:t},r),mapAccess(r)}'
  return line
}).join('\n')
const accessModules={'./app-shared.js':'export function mapAccess(e){let t=e.requirements?.featureRequirements,n=t?.fast_mode!==!1;return {fast:n,ultrafast:(`supportsIndependentSpeedModes`in e&&e.supportsIndependentSpeedModes===!0||n)&&t?.ultrafast_mode!==!1}}'}

function patches(body=source,features:readonly CodexUiFeature[]=['locale','speed','ultra']){
  const detected=detectCodexUiCapabilities(body,body.includes('app-shared.js')?accessModules:{})
  return {detected,body:applyCodexUiReplacements(body,features.flatMap(f=>detected.replacements[f]))}
}

// Current bundlers freely switch between declarations, arrows and function
// expressions. Keep the semantic fixture stable while exercising all three
// module-level binding shapes (including an async arrow for request admission).
function moduleBindingSource(body:string):string {
  return body.split('\n').map(line=>{
    const match=line.match(/^(async )?function (\w+)\((.*)\)(\{.*\})$/)
    if(!match)return line
    const [,asyncPrefix,name,params,block]=match
    if(name==='translated'||name==='speedControls'||name==='catalogue'||name==='confirm'||name==='updateReasoning'||name==='startReasoning')return `const ${name}=${asyncPrefix??''}(${params})=>${block}`
    return `const ${name}=${asyncPrefix??''}function(${params})${block}`
  }).join('\n')
}
function fixture(t:{after(fn:()=>void):void},body=source,version='26.1016.51333',modules:Record<string,string>={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-ui-capabilities-'))),application=join(root,'Fixture.app'),executable=join(application,'Contents/MacOS/ChatGPT')
  const home=join(root,'home'),desktop=join(root,'desktop');mkdirSync(home,{mode:0o700});mkdirSync(desktop,{mode:0o700})
  const entries=new Map<string,Buffer>([
    ['package.json',Buffer.from(JSON.stringify({name:'openai-codex-electron',version,main:'.vite/build/early-bootstrap.js'}))],
    ['webview/index.html',Buffer.from('<meta content="script-src &#39;self&#39;"><script type="module" src="./assets/index-renamed.js"></script>')],
    ['webview/assets/index-renamed.js',Buffer.from('import("./app-initial-renamed.js")')],
    ['webview/assets/app-initial-renamed.js',Buffer.from(body)],
    ...Object.entries(modules).map(([path,moduleBody])=>['webview/assets/'+path.slice(2),Buffer.from(moduleBody)] as [string,Buffer]),
    ['.vite/build/early-bootstrap.js',Buffer.from('require("./bootstrap-renamed.js")')],
    ['.vite/build/bootstrap-renamed.js',Buffer.from('require("electron");process.env.CODEX_ELECTRON_USER_DATA_PATH;require("./app-protocol-renamed.js");')],
    ['.vite/build/app-protocol-renamed.js',Buffer.from('app.protocol.handle(`app`,async()=>new Response());')]
  ])
  let identity='stable'
  const reader:CodexSpeedMenuReader={canonical:p=>p,identity:p=>p+identity,file:()=>Buffer.alloc(0),archive:(_a,p)=>{const b=entries.get(p);if(!b)throw new Error('missing fixture');return b},fuseWires:()=>[Buffer.from([1,9,48,49,48,48,49,49,48,48,49])]}
  const options={application,executable,platform:'darwin' as const}
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,home,desktop,entries,reader,options,changeIdentity:()=>{identity+='changed'},inspect:(features?:readonly CodexUiFeature[])=>inspectCodexDesktopUi({...options,features},reader)}
}

test('semantic detection survives function names and accepts an unregistered 26.x client version',t=>{
  const renamed=source.replace(/translated/g,'minifiedLocale').replace(/confirm/g,'minifiedConfirm').replace(/accountMethod/g,'renamedReader').replace(/catalogue/g,'modelRole').replace(/initLevels/g,'newSettings')
  const f=fixture(t,renamed),result=f.inspect()
  assert.equal(result.version,'26.1016.51333');assert.equal(result.supported,true);assert.equal(result.transport,'cdp')
  assert.deepEqual(result.features,['locale','speed','ultra']);assert.equal(Object.values(result.featureSupport!).every(f=>f.supported),true)
  const hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()})!
  assert.ok(hook);assert.equal(readFileSync(hook.patchedBody!,'utf8'),patches(renamed).body)
})

test('module-level arrows and function expressions remain compatible after a client update',t=>{
  const body=moduleBindingSource(source)
    .replace(/\btranslated\b/g,'localeRole')
    .replace(/\bconfirm\b/g,'requestRole')
    .replace(/\baccountMethod\b/g,'identityRole')
    .replace(/const /g,'const  ')
    .replace(/=>/g,' => '),f=fixture(t,body,'26.1016.51334'),result=f.inspect()
  assert.equal(result.supported,true,result.reason)
  assert.deepEqual(result.features,['locale','speed','ultra'])
  assert.equal(Object.values(result.featureSupport!).every(feature=>feature.supported),true)
  const detected=detectCodexUiCapabilities(body)
  const patched=applyCodexUiReplacements(body,['locale','speed','ultra'].flatMap(feature=>detected.replacements[feature as CodexUiFeature]))
  assert.match(patched,/const  localeRole=\(\{localeOverride:r\}\) => \{let data/)
  assert.match(patched,/const  requestRole=async \(e,t\) => \{let n=await identityRole\(e,t\);if\(n!==`chatgpt`/)
})

test('nested functions do not create a duplicate module-level feature role',t=>{
  const nested=`function wrapper(){${source.split('\n')[0]}}\n`
  const body=source+'\n'+nested,f=fixture(t,body),result=f.inspect()
  assert.deepEqual(result.features,['locale','speed','ultra'])
  assert.equal(result.featureSupport!.locale.supported,true)
})

test('Ultra settings and persistence survive nested lazy initialization',()=>{
  const nested=source.split('\n').map(line=>{
    if(line.startsWith('function initLevels'))return 'function initLevels(){return (()=>()=>new Set([...readSetting(settings.enabledReasoningEfforts),`persistent`]))()()}'
    if(line.startsWith('function updateReasoning'))return 'function updateReasoning(e,t){return (()=>({mutationFn:()=>{if(!t.sameIdentity||t.thinkingEffort===`ultra`&&!e.get(flag,`536305374`))return null;return t.thinkingEffort}}))().mutationFn()}'
    return line
  }).join('\n')
  const {detected,body}=patches(nested,['ultra'])
  assert.equal(detected.features.ultra.supported,true)
  const roles=body.split('\n').filter(line=>/function (initLevels|catalogue|savedReasoning|updateReasoning|startReasoning)/.test(line)).join('\n')
  const api=new Function('readSetting','settings','flag',roles+';return {initLevels,catalogue,savedReasoning,updateReasoning,startReasoning};')(()=>['high','max'],{enabledReasoningEfforts:[]},{})
  const enabled=api.initLevels(),falseGate=Object.assign(()=>false,{get:()=>false})
  assert.deepEqual([...enabled],['high','max','persistent','ultra'])
  const data=api.catalogue({includeUltraReasoningEffort:false,enabledReasoningEfforts:enabled,models:[{model:'supported',supportedReasoningEfforts:[{reasoningEffort:'max'},{reasoningEffort:'ultra'}]},{model:'limited',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]})
  assert.deepEqual(data.models.map((m:any)=>m.supportedReasoningEfforts.map((e:any)=>e.reasoningEffort)),[['max','ultra'],['high']])
  assert.equal(api.savedReasoning(falseGate,'ultra'),'ultra')
  assert.equal(api.updateReasoning(falseGate,{sameIdentity:true,thinkingEffort:'ultra'}),'ultra')
  assert.equal(api.updateReasoning(falseGate,{sameIdentity:false,thinkingEffort:'ultra'}),null,'identity boundary must remain intact')
  assert.equal(api.startReasoning(falseGate,{thinkingEffort:'ultra'}),'ultra')
})

test('ambiguous or missing reasoning settings discard every Ultra edit',()=>{
  for(const body of [source+'\nfunction duplicate(){return ()=>new Set([...readSetting(settings.enabledReasoningEfforts),`persistent`])}',source.replace('settings.enabledReasoningEfforts','settings.otherSetting')]){
    const detected=detectCodexUiCapabilities(body)
    assert.equal(detected.features.ultra.supported,false)
    assert.deepEqual(detected.replacements.ultra,[])
    assert.equal(detected.features.locale.supported,true)
  assert.equal(detected.features.speed.supported,true,detected.features.speed.reason)
  }
})

test('clients already enabling Ultra keep their setting while remaining persistence gates are adapted',()=>{
  const input=source.replace('`persistent`])','`persistent`,`ultra`])'),{detected,body}=patches(input,['ultra'])
  assert.equal(detected.features.ultra.supported,true)
  assert.equal(body.split('\n').find(line=>line.startsWith('function initLevels')),input.split('\n').find(line=>line.startsWith('function initLevels')))
  assert.equal(body.includes('e.get(flag,`536305374`)'),false)
})

test('the legacy speed-menu entry point uses semantic capabilities for future versions',t=>{
  const f=fixture(t,source,'26.1016.51335'),result=inspectCodexSpeedMenu({...f.options,enhancements:'speed-locale'},f.reader)
  assert.equal(result.supported,true,result.reason)
  assert.equal(result.version,'26.1016.51335')
  assert.equal(result.enhancements,'speed-locale')
  assert.deepEqual(result.features,['locale','speed'])
  const hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()})
  assert.ok(hook?.patchedBody)
  assert.equal(readFileSync(hook!.patchedBody!,'utf8'),patches(source,['locale','speed']).body)
})
test('an ambiguous locale role leaves Fast and Ultra enabled without partial locale edits',t=>{
  const body=source+'\n'+source.split('\n')[0].replace('translated','duplicateLocale'),f=fixture(t,body),result=f.inspect()
  assert.equal(result.supported,true);assert.equal(result.featureSupport!.locale.supported,false)
  assert.deepEqual(result.features,['speed','ultra'])
  const detected=detectCodexUiCapabilities(body);assert.deepEqual(detected.replacements.locale,[])
  assert.equal(applyCodexUiReplacements(body,[...detected.replacements.speed,...detected.replacements.ultra]).includes('let use=enabled,choice=experiment?.get'),true)
})
test('missing Ultra catalogue roles discard every Ultra edit while preserving language and speed',t=>{
  const body=source.replace('hasModelSupportingUltraReasoningEffort','changedModelContract'),f=fixture(t,body),result=f.inspect()
  assert.deepEqual(result.features,['locale','speed']);assert.equal(result.featureSupport!.ultra.supported,false)
  const detected=detectCodexUiCapabilities(body);assert.deepEqual(detected.replacements.ultra,[])
  const changed=applyCodexUiReplacements(body,[...detected.replacements.locale,...detected.replacements.speed])
  assert.equal(changed.includes('e.get(flag,`536305374`)'),true);assert.equal(changed.includes('[...readSetting(settings.enabledReasoningEfforts),`persistent`]'),true)
})
test('native launch requests only language and does not modify speed or Ultra controls',t=>{
  const f=fixture(t),result=f.inspect(['locale'])
  assert.deepEqual(result.features,['locale'])
  const hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()})!
  assert.equal(readFileSync(hook.patchedBody!,'utf8'),patches(source,['locale']).body)
})
test('dynamic prepare refuses resource drift and forged proof; changed loaders and CSP fail closed',t=>{
  const f=fixture(t),result=f.inspect(),options={inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()}
  assert.equal(prepareCodexSpeedMenu({...options,inspection:{...result}}),undefined)
  f.changeIdentity();assert.equal(prepareCodexSpeedMenu(options),undefined)
  f.entries.set('webview/assets/index-renamed.js',Buffer.from('import("./app-initial-a.js");import("./app-initial-b.js")'))
  assert.equal(f.inspect().supported,false)
  f.entries.set('webview/index.html',Buffer.from('<meta content="script-src \'self\' \'strict-dynamic\'"><script src="./assets/index-renamed.js"></script>'))
  assert.match(f.inspect().reason,/完整性/)
})
test('locale adaptation enables native messages while preserving explicit language and live system detection',()=>{
  const {body}=patches(source,['locale']),fn=body.slice(0,body.indexOf('\n'))
  const create=new Function('currentLocales','getExperiment',fn+';return translated;')
  let system='zh-CN'
  const translate=create(()=>({ideLocale:'en-US',systemLocale:system}),()=>({get:()=>false}))
  assert.deepEqual(translate({}),{enabled:true,locale:'zh-CN'})
  assert.deepEqual(translate({localeOverride:'ja-JP'}),{enabled:true,locale:'ja-JP'})
  system='fr-FR';assert.equal(translate({}).locale,'fr-FR')
})
test('Ultra adaptation preserves each model advertised reasoning levels and accepts persistence',()=>{
  const {body}=patches(source,['ultra'])
  const functions=body.split('\n').filter(line=>/function (catalogue|savedReasoning|updateReasoning|startReasoning)/.test(line)).join('\n')
  const create=new Function('flag',functions+';return {catalogue,savedReasoning,updateReasoning,startReasoning};')
  const api=create({}),falseGate=Object.assign(()=>false,{get:()=>false})
  const data=api.catalogue({includeUltraReasoningEffort:false,enabledReasoningEfforts:new Set(['max','ultra']),models:[{model:'a',supportedReasoningEfforts:[{reasoningEffort:'max'},{reasoningEffort:'ultra'}]},{model:'b',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]})
  assert.deepEqual(data.models[0].supportedReasoningEfforts.map((v:any)=>v.reasoningEffort),['max','ultra'])
  assert.deepEqual(data.models[1].supportedReasoningEfforts.map((v:any)=>v.reasoningEffort),['max'])
  assert.equal(api.savedReasoning(falseGate,'ultra'),'ultra');assert.equal(api.updateReasoning(falseGate,{thinkingEffort:'ultra'}),'ultra');assert.equal(api.startReasoning(falseGate,{thinkingEffort:'ultra'}),'ultra')
})
test('Fast no-auth admission verifies local identity and keeps explicit upstream denial',async()=>{
  const {body}=patches(source,['speed']),confirm=body.split('\n').find(line=>line.startsWith('async function confirm'))!
  let account:any={account:null,requiresOpenaiAuth:false},accountReads=0,method:any=null,deny=false
  const create=new Function('accountMethod','readRequirements','unwrap','rpcKey','requirementKey',confirm+';return confirm;')
  const follow=create(async()=>method,async()=>({requirements:{featureRequirements:{fast_mode:!deny}}}),(v:unknown)=>v,'rpc','requirements')
  const store={get:()=>({rpc:{getAccount:async()=>{accountReads++;return account}}}),query:{setData:()=>{}}}
  assert.equal(await follow(store,'local'),true);assert.equal(accountReads,1)
  assert.equal(await follow(store,'remote'),false);assert.equal(accountReads,1)
  for(const value of [{},{account:null},{account:{},requiresOpenaiAuth:false},{account:null,requiresOpenaiAuth:true}]){account=value;assert.equal(await follow(store,'local'),false)}
  account={account:null,requiresOpenaiAuth:false};deny=true;assert.equal(await follow(store,'local'),false)
  deny=false;for(const value of ['chatgpt','personalAccessToken','apikey']){method=value;assert.equal(await follow(store,'local'),true)}
})

test('Fast menu does not wait for ChatGPT subscription metadata on verified local providers',()=>{
  const {body}=patches(source,['speed']),menu=body.split('\n').find(line=>line.startsWith('function menu'))!,controls=body.split('\n').find(line=>line.startsWith('function speedControls'))!
  let identity:any={authMethod:'apikey',isLoading:false},data:any=null,pending=false
  const create=new Function('readIdentity','readQuery',menu+controls+';return {menu,speedControls};')
  const {menu:show,speedControls}=create(()=>identity,()=>({data,isPending:pending}))
  assert.equal(show({hostId:'local'}).isServiceTierAllowed,true);assert.equal(show({hostId:'local'}).isLoading,false)
  assert.equal(speedControls(null).serviceTierSettings.isLoading,false,'the consumer must also stop waiting for absent subscription metadata')
  assert.equal(show({hostId:'remote'}).isServiceTierAllowed,false)
  identity={authMethod:null};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:null,requiresAuth:false,isLoading:true};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:'apikey',isLoading:false};assert.equal(show({hostId:'local'}).isServiceTierAllowed,true)
  data={requirements:{featureRequirements:{fast_mode:false}}};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:'chatgpt',isLoading:false};data=null;pending=true;assert.equal(show({hostId:'local'}).isServiceTierAllowed,false);assert.equal(show({hostId:'local'}).isLoading,true)
  assert.equal(speedControls(null).serviceTierSettings.isLoading,true,'signed-in requirements are still required')
  pending=false;data={requirements:{featureRequirements:{fast_mode:true}}};assert.equal(show({hostId:'local'}).isServiceTierAllowed,true)
})
test('missing subscription metadata is optional only for local API identities; signed-in errors propagate',async()=>{
  const {body}=patches(source,['speed']),confirm=body.split('\n').find(line=>line.startsWith('async function confirm'))!
  let method:any=null
  const create=new Function('accountMethod','readRequirements','unwrap','rpcKey','requirementKey',confirm+';return confirm;')
  const follow=create(async()=>method,async()=>{throw new Error('fixture subscription unavailable')},(v:unknown)=>v,'rpc','requirements')
  const store={get:()=>({rpc:{getAccount:async()=>({account:null,requiresOpenaiAuth:false})}}),query:{setData:()=>{}}}
  assert.equal(await follow(store,'local'),true)
  method='apikey';assert.equal(await follow(store,'local'),true)
  await assert.rejects(follow(store,'remote'),/subscription unavailable/)
  method='chatgpt';await assert.rejects(follow(store,'local'),/subscription unavailable/)
  method='personalAccessToken';await assert.rejects(follow(store,'local'),/subscription unavailable/)
})

test('access-object Fast detection survives renamed symbols and unknown versions',t=>{
  const renamed=accessSource.replace('import {mapAccess}','import {mapAccess as tierCapabilities}').replace(/\bmenu\b/g,'renamedMenu').replace(/\bconfirm\b/g,'newRequestAccess').replace('mapAccess(c)','tierCapabilities(c)').replace('mapAccess(r)','tierCapabilities(r)').replace(/\baccountMethod\b/g,'identityReader')
  const f=fixture(t,renamed,'26.1016.51336',accessModules),result=f.inspect()
  assert.deepEqual(result.features,['locale','speed','ultra'])
  const hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()})!
  assert.ok(hook)
  const patched=readFileSync(hook.patchedBody!,'utf8')
  assert.match(patched,/tierCapabilities\(c\?\?\{requirements:\{featureRequirements:\{fast_mode:!0,ultrafast_mode:!1\}\}\}\)/)
  assert.match(patched,/authMethod===/)
  assert.doesNotMatch(patched,/fast_mode[^;]*\|\|!0/)
})

test('access-object menus wait for capability results and preserve independent Fast / Ultra Fast restrictions',()=>{
  const {body,detected}=patches(accessSource,['speed'])
  assert.equal(detected.features.speed.supported,true,detected.features.speed.reason)
  const functions=body.split('\n').filter(line=>/^function (menu|speedControls)\b/.test(line)).join('\n')
  let identity:any={authMethod:'apikey',isLoading:false},data:any=null,pending=true
  const create=new Function('readIdentity','readQuery','mapAccess',functions+';return {menu,speedControls};')
  const {menu, speedControls}=create(()=>identity,()=>({data,isPending:pending}),(v:any)=>({fast:v.requirements?.featureRequirements?.fast_mode!==false,ultrafast:(v.supportsIndependentSpeedModes===true||v.requirements?.featureRequirements?.fast_mode!==false)&&v.requirements?.featureRequirements?.ultrafast_mode!==false}))
  pending=false;data={requirements:{featureRequirements:{fast_mode:true,ultrafast_mode:false}}}
  assert.equal(menu({hostId:'local'}).isLoading,false)
  assert.equal(speedControls(null).serviceTierSettings.isLoading,false)
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:false})
  assert.equal(speedControls(null).serviceTierSettings.isLoading,false)
  assert.equal(menu({hostId:'remote'}).serviceTierAccess,null)
  identity={authMethod:null};assert.equal(menu({hostId:'local'}).serviceTierAccess,null)
  identity={authMethod:'apikey',isLoading:true};assert.equal(menu({hostId:'local'}).serviceTierAccess,null)
  assert.equal(menu({hostId:'local'}).isLoading,true)
  identity={authMethod:'apikey',isLoading:false}
  data={requirements:{featureRequirements:{fast_mode:false}}}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:false,ultrafast:false})
  data.supportsIndependentSpeedModes=true
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:false,ultrafast:true})
  identity={authMethod:'chatgpt',isLoading:false};data=null;pending=true
  assert.equal(menu({hostId:'local'}).serviceTierAccess,null)
  assert.equal(speedControls(null).serviceTierSettings.isLoading,true)
  pending=false;data={requirements:{featureRequirements:{fast_mode:true}}}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:true})
})

test('access-object Fast keeps local API fallbacks separate from server sign-in and honors explicit denial',()=>{
  const {body,detected}=patches(accessSource,['speed'])
  assert.equal(detected.features.speed.supported,true,detected.features.speed.reason)
  const functions=body.split('\n').filter(line=>/^function (menu|speedControls)\b/.test(line)).join('\n')
  let identity:any={authMethod:'apikey',isLoading:false},data:any=null,pending=true
  const create=new Function('readIdentity','readQuery','mapAccess',functions+';return {menu,speedControls};')
  const {menu,speedControls}=create(()=>identity,()=>({data,isPending:pending}),(v:any)=>({fast:v.requirements?.featureRequirements?.fast_mode!==false,ultrafast:(v.supportsIndependentSpeedModes===true||v.requirements?.featureRequirements?.fast_mode!==false)&&v.requirements?.featureRequirements?.ultrafast_mode!==false}))
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:false})
  assert.equal(menu({hostId:'remote'}).serviceTierAccess,null)
  assert.equal(menu({hostId:'local'}).isLoading,false)
  pending=false;data={requirements:{featureRequirements:{fast_mode:true,ultrafast_mode:false}}}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:false})
  assert.equal(speedControls(null).serviceTierSettings.isLoading,false)
  data={requirements:{featureRequirements:{fast_mode:false}}}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:false,ultrafast:false})
  data={requirements:{featureRequirements:{fast_mode:false}},supportsIndependentSpeedModes:true}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:false,ultrafast:true})
  identity={authMethod:'apikey',isLoading:false};data=null;pending=true
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:false})
  assert.equal(menu({hostId:'local'}).isLoading,false)
  identity={authMethod:null,requiresAuth:false,isLoading:false}
  assert.deepEqual(menu({hostId:'local'}).serviceTierAccess,{fast:true,ultrafast:false})
  identity={authMethod:null,requiresAuth:true,isLoading:false};data=null;pending=true
  assert.equal(menu({hostId:'local'}).serviceTierAccess,null)
  identity={authMethod:'chatgpt',isLoading:false};data=null;pending=true
  assert.equal(menu({hostId:'local'}).serviceTierAccess,null)
})

test('shared access mapper must bind Fast and Ultra Fast results to upstream restrictions',()=>{
  for(const mapper of [
    'export function mapAccess(e){let unused=e.requirements?.featureRequirements?.fast_mode!==!1;return {fast:!0,ultrafast:!0}}',
    'export function mapAccess(e){let t=e.requirements?.featureRequirements,n=t?.fast_mode!==!1;return {fast:n,ultrafast:n}}',
    'export function mapAccess(e){let t=e.requirements?.featureRequirements,n=t?.fast_mode!==!1;return {fast:n,ultrafast:(e.supportsIndependentSpeedModes===!0||n)&&!0}}',
    'export function mapAccess(e){let t=e.unrelated,n=t?.fast_mode!==!1;return {fast:n,ultrafast:(e.supportsIndependentSpeedModes===!0||n)&&t?.ultrafast_mode!==!1}}',
    'export function mapAccess(e){let t=e.requirements?.featureRequirements,n=t?.fast_mode!==!1;return {fast:n,ultrafast:(e.unrelated?.supportsIndependentSpeedModes===!0||n)&&t?.ultrafast_mode!==!1}}'
  ]){
    const detected=detectCodexUiCapabilities(accessSource,{'./app-shared.js':mapper})
    assert.equal(detected.features.speed.supported,false)
    assert.deepEqual(detected.replacements.speed,[])
  }
  const aliased='export function mapAccess(e){const r=e.requirements,s=e.supportsIndependentSpeedModes;const f=r?.featureRequirements,n=f?.fast_mode!==!1;return {fast:n,ultrafast:(s===!0||n)&&f?.ultrafast_mode!==!1}}'
  assert.equal(detectCodexUiCapabilities(accessSource,{'./app-shared.js':aliased}).features.speed.supported,true,'valid aliases of the actual requirement paths remain supported')
  assert.deepEqual(codexUiAccessMapperImportPaths(accessSource),['./app-shared.js'])
  assert.deepEqual(codexUiAccessMapperImportPaths(accessSource.replace('./app-shared.js','../app-shared.js')),[])
})

test('ambiguous access roles disable Fast without leaving partial edits',t=>{
  const body=accessSource+'\n'+accessSource.split('\n').find(line=>line.startsWith('function menu'))!
  const detected=detectCodexUiCapabilities(body),f=fixture(t,body)
  assert.equal(detected.features.speed.supported,false)
  assert.deepEqual(detected.replacements.speed,[])
  assert.equal(f.inspect().supported,false)
})

test('future identity guards with additional restrictions disable only Fast',t=>{
  for(const original of [source]){
    const extraRestriction=original.replace('if(n!==`chatgpt`&&n!==`personalAccessToken`)','if(n!==`chatgpt`&&n!==`personalAccessToken`||t===`remote`)')
    const detected=detectCodexUiCapabilities(extraRestriction),f=fixture(t,extraRestriction)
    assert.equal(detected.features.speed.supported,false)
    assert.deepEqual(detected.replacements.speed,[])
    assert.deepEqual(f.inspect().features,['locale','ultra'])
    const reversed=original.replace('if(n!==`chatgpt`&&n!==`personalAccessToken`)','if(n!==`personalAccessToken`&&n!==`chatgpt`)')
    assert.equal(detectCodexUiCapabilities(reversed).features.speed.supported,true)
  }
})

test('account reader keys and wrappers cannot cross local or shadowed binding scopes',t=>{
  for(const original of [source]){
    const variants=[
      original.replace('let r=e.get(rpcKey,t);','const localKey=rpcKey;let r=e.get(localKey,t);'),
      original.replace('let r=e.get(rpcKey,t);','const {unwrap}=helpers;let r=e.get(rpcKey,t);'),
      original.replace('async function confirm(e,t){','async function confirm(e,t){const [rpcKey]=keys;'),
      original.replace('async function confirm(e,t){','async function confirm(e,t,{unwrap}){'),
      original.replace('async function confirm(e,t){','async function confirm(e,t){const accountMethod=localReader;')
    ]
    for(const body of variants){
      const detected=detectCodexUiCapabilities(body),f=fixture(t,body)
      assert.equal(detected.features.speed.supported,false)
      assert.deepEqual(detected.replacements.speed,[])
      assert.deepEqual(f.inspect().features,['locale','ultra'])
    }
  }
})

test('installed desktop client reports any currently supported capabilities',t=>{
  const application='/Applications/ChatGPT.app',executable=join(application,'Contents/MacOS/ChatGPT')
  if(process.platform!=='darwin'||!existsSync(executable)){t.skip('current desktop client is not installed');return}
  const result=inspectCodexDesktopUi({application,executable})
  if(!result.supported||!result.features?.length){t.skip(`optional diagnostic: ${result.reason}`);return}
  assert.ok(result.features.length>=1)
  const f=fixture(t),hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable,nonce:randomUUID()})
  assert.ok(hook?.patchedBody)
  assert.deepEqual(hook.features,result.features)
  assert.ok(readFileSync(hook.patchedBody,'utf8').length>0)
})
