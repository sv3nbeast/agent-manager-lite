import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {applyCodexUiReplacements,detectCodexUiCapabilities,type CodexUiFeature} from '../src/main/codexUiCapabilities'
import {inspectCodexDesktopUi,prepareCodexSpeedMenu,type CodexSpeedMenuReader} from '../src/main/codexSpeedMenu'

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

function patches(body=source,features:readonly CodexUiFeature[]=['locale','speed','ultra']){
  const detected=detectCodexUiCapabilities(body)
  return {detected,body:applyCodexUiReplacements(body,features.flatMap(f=>detected.replacements[f]))}
}
function fixture(t:{after(fn:()=>void):void},body=source,version='99.1234.56789'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-ui-capabilities-'))),application=join(root,'Fixture.app'),executable=join(application,'Contents/MacOS/ChatGPT')
  const home=join(root,'home'),desktop=join(root,'desktop');mkdirSync(home,{mode:0o700});mkdirSync(desktop,{mode:0o700})
  const entries=new Map<string,Buffer>([
    ['package.json',Buffer.from(JSON.stringify({name:'openai-codex-electron',version,main:'.vite/build/early-bootstrap.js'}))],
    ['webview/index.html',Buffer.from('<meta content="script-src &#39;self&#39;"><script type="module" src="./assets/index-renamed.js"></script>')],
    ['webview/assets/index-renamed.js',Buffer.from('import("./app-initial-renamed.js")')],
    ['webview/assets/app-initial-renamed.js',Buffer.from(body)],
    ['.vite/build/early-bootstrap.js',Buffer.from('require("./bootstrap-renamed.js")')],
    ['.vite/build/bootstrap-renamed.js',Buffer.from('require("electron");process.env.CODEX_ELECTRON_USER_DATA_PATH;')]
  ])
  let identity='stable'
  const reader:CodexSpeedMenuReader={canonical:p=>p,identity:p=>p+identity,file:()=>Buffer.alloc(0),archive:(_a,p)=>{const b=entries.get(p);if(!b)throw new Error('missing fixture');return b},fuseWires:()=>[Buffer.from([1,8,49,49,48,49,48,49,48,48])]}
  const options={application,executable,platform:'darwin' as const}
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,home,desktop,entries,reader,options,changeIdentity:()=>{identity+='changed'},inspect:(features?:readonly CodexUiFeature[])=>inspectCodexDesktopUi({...options,features},reader)}
}

test('semantic detection survives function names and accepts an unregistered client version',t=>{
  const renamed=source.replace(/translated/g,'minifiedLocale').replace(/confirm/g,'minifiedConfirm').replace(/accountMethod/g,'renamedReader').replace(/catalogue/g,'modelRole').replace(/initLevels/g,'newSettings')
  const f=fixture(t,renamed),result=f.inspect()
  assert.equal(result.version,'99.1234.56789');assert.equal(result.supported,true);assert.equal(result.transport,'cdp')
  assert.deepEqual(result.features,['locale','speed','ultra']);assert.equal(Object.values(result.featureSupport!).every(f=>f.supported),true)
  const hook=prepareCodexSpeedMenu({inspection:result,directory:f.home,desktopDirectory:f.desktop,executable:f.options.executable,nonce:randomUUID()})!
  assert.ok(hook);assert.equal(readFileSync(hook.patchedBody!,'utf8'),patches(renamed).body)
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
  let identity:any={authMethod:null,requiresAuth:false,isLoading:false},data:any=null,pending=true
  const create=new Function('readIdentity','readQuery',menu+controls+';return {menu,speedControls};')
  const {menu:show,speedControls}=create(()=>identity,()=>({data,isPending:pending}))
  assert.equal(show({hostId:'local'}).isServiceTierAllowed,true);assert.equal(show({hostId:'local'}).isLoading,false)
  assert.equal(speedControls(null).serviceTierSettings.isLoading,false,'the consumer must also stop waiting for absent subscription metadata')
  assert.equal(show({hostId:'remote'}).isServiceTierAllowed,false)
  identity={authMethod:null};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:null,requiresAuth:false,isLoading:true};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:'apikey',isLoading:false};assert.equal(show({hostId:'local'}).isServiceTierAllowed,true)
  data={requirements:{featureRequirements:{fast_mode:false}}};assert.equal(show({hostId:'local'}).isServiceTierAllowed,false)
  identity={authMethod:'chatgpt',isLoading:false};data=null;assert.equal(show({hostId:'local'}).isServiceTierAllowed,false);assert.equal(show({hostId:'local'}).isLoading,true)
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
