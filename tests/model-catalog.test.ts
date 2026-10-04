import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,realpathSync,openSync,closeSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {TomlDocument} from '../src/main/tomlPatch'
import {builtInCatalog,buildModelCatalog,defaultModelDefinitions,summarizeCatalog,catalogMetadata,parseNativeCatalog} from '../src/main/modelCatalog'
import {modelDefinitionSchema} from '../src/shared/modelCatalog'

function fixture(t:{after(fn:()=>void):void}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-models-')))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const codec={encrypt:(text:string)=>Buffer.from(text),decrypt:(data:Buffer)=>data.toString()}
  const store=new Store(join(root,'app'),codec),service=new ClientConfigs(store)
  return {root,store,service,codec,target:service.targets()[0]}
}
function enable(f:ReturnType<typeof fixture>,models=defaultModelDefinitions(),defaultModelId:string|null='gpt-6.1-sol') {
  const view=f.service.catalogView(f.target.id)
  const preview=f.service.previewCatalog({id:f.target.id,revision:view.revision,enabled:true,models,defaultModelId})
  f.service.apply(preview.ticket)
  const source=readFileSync(join(f.target.directory,'config.toml'),'utf8')
  return {view,preview,path:new TomlDocument(source).scalar(['model_catalog_json']) as string}
}

test('generated catalogs preserve native capabilities and pass the independent Go client-entry contract',t=>{
  const models=defaultModelDefinitions(),catalog=buildModelCatalog(models,builtInCatalog,null,'"gpt-6.1-sol"')
  const folder=mkdtempSync(join(tmpdir(),'cml-model-contract-')),inputFile=join(folder,'catalog.json')
  t.after(()=>rmSync(folder,{recursive:true,force:true}))
  // Validate exactly the same stdin bytes with a finite regular-file EOF.
  // This removes synchronous pipe delivery from the four-worker integration
  // test while preserving the independent Go contract and its existing timeout.
  const validate=(value:unknown)=>{
    writeFileSync(inputFile,JSON.stringify(value),{mode:0o600})
    const fd=openSync(inputFile,'r')
    try{return execFileSync(resolve('resources/bin/codex-proxy'),['-validate-model-catalog'],{stdio:[fd,'pipe','pipe'],encoding:'utf8',timeout:30000})}
    finally{closeSync(fd)}
  }
  const output=validate(catalog)
  assert.deepEqual(JSON.parse(output),{valid:true})
  for(const baseline of builtInCatalog.models) {
    const model=catalog.models.find(model=>model.slug===baseline.slug)!
    assert.equal(model.base_instructions,baseline.base_instructions)
    assert.deepEqual(model.service_tiers,baseline.service_tiers)
    assert.deepEqual(model.supported_reasoning_levels,baseline.supported_reasoning_levels)
    assert.equal(model.comp_hash,'3000')
  }
  const reordered=buildModelCatalog([...models].reverse(),catalog,null,null)
  assert.deepEqual(reordered.models.filter(model=>model.visibility!=='hide').sort((a,b)=>Number(a.priority)-Number(b.priority)).map(model=>model.slug),[...models].reverse().map(model=>model.modelId))
  const custom=buildModelCatalog([modelDefinitionSchema.parse({modelId:'provider/gpt-6-luna',displayName:'Routed Luna'}),modelDefinitionSchema.parse({modelId:'unknown',displayName:'Unknown'})],builtInCatalog,null,null)
  const routed=custom.models[0],unknown=custom.models[1]
  assert.equal(routed.context_window,256000)
  assert.deepEqual(routed.service_tiers,builtInCatalog.models.find(model=>model.slug==='gpt-6-luna')!.service_tiers)
  assert.deepEqual(unknown.service_tiers,[])
  assert.equal(unknown.max_context_window,272000)
  assert.deepEqual(JSON.parse(validate(custom)),{valid:true})
})

test('overrides can return to the original template without losing custom protocol fields',()=>{
  const baseline=structuredClone(builtInCatalog),native=baseline.models.find(model=>model.slug==='gpt-5.5')!
  native.custom_protocol={future:'fixture-value'}
  const definition=modelDefinitionSchema.parse({modelId:'gpt-5.5',displayName:'My model',contextWindow:500000,reasoningEfforts:['high'],supportsVision:false})
  const configured=buildModelCatalog([definition],baseline,null,null)
  assert.equal(configured.models[0].auto_compact_token_limit,450000)
  assert.equal(configured.models[0].default_reasoning_level,'high')
  assert.deepEqual(configured.models[0].input_modalities,['text'])
  const restored=buildModelCatalog([modelDefinitionSchema.parse({modelId:'gpt-5.5',displayName:'My model'})],configured,null,null)
  assert.equal(restored.models[0].context_window,native.context_window)
  assert.deepEqual(restored.models[0].supported_reasoning_levels,native.supported_reasoning_levels)
  assert.deepEqual(restored.models[0].input_modalities,native.input_modalities)
  assert.deepEqual(restored.models[0].custom_protocol,{future:'fixture-value'})
  assert.equal(catalogMetadata(restored)!.basis._codex_manager_lite,undefined)
  assert.throws(()=>buildModelCatalog([{...definition,reasoningEfforts:['ultra']}],baseline,null,null),/不在目录声明/)
})

test('catalog preview is side-effect free; apply uses immutable files and survives reopening',t=>{
  const f=fixture(t),view=f.service.catalogView(f.target.id)
  assert.equal(view.source,'official');assert.equal(existsSync(f.target.directory),false)
  const preview=f.service.previewCatalog({id:f.target.id,revision:view.revision,enabled:true,models:[modelDefinitionSchema.parse({modelId:'gpt-5.5',displayName:'Selected'})],defaultModelId:'gpt-5.5'})
  assert.equal(existsSync(join(f.root,'app','model-catalogs')),false)
  assert.deepEqual(preview.catalogModels,['gpt-5.5','gpt-reserve'])
  const written=f.service.apply(preview.ticket)
  const path=new TomlDocument(readFileSync(join(f.target.directory,'config.toml'),'utf8')).scalar(['model_catalog_json']) as string
  assert.equal(statSync(path).mode&0o777,0o600)
  const reopened=new ClientConfigs(new Store(f.store.directory,f.codec))
  const restored=reopened.catalogView(f.target.id)
  assert.equal(restored.source,'managed');assert.equal(restored.customized,true)
  assert.deepEqual(restored.models.map(model=>model.modelId),['gpt-5.5','gpt-reserve'])
  assert.equal(JSON.stringify(restored).includes('base_instructions'),false)
  const first=readFileSync(path,'utf8')
  const edited={...restored.models[0],displayName:'Renamed'}
  reopened.apply(reopened.previewCatalog({id:f.target.id,revision:restored.revision,enabled:true,models:[edited],defaultModelId:'gpt-5.5'}).ticket)
  assert.equal(readFileSync(path,'utf8'),first)
  const undo=reopened.previewRestore({id:f.target.id,backup:written.revisions[0].id})
  assert.ok(undo.conflicts.includes('model_catalog_json'))
  assert.equal(undo.changes.length,0)
})

test('external catalogs retain unknown fields and remain untouched; disabling restores owned model only',t=>{
  const f=fixture(t),external=join(f.root,'external');mkdirSync(external)
  const catalog=structuredClone(builtInCatalog)
  catalog.models[0].base_instructions='fixture-private-instructions'
  catalog.custom_root={preserve:true}
  const content=JSON.stringify(catalog),catalogPath=join(external,'mine.json'),configPath=join(external,'config.toml')
  writeFileSync(catalogPath,content);writeFileSync(configPath,'# keep me\nmodel="previous-model"\nmodel_catalog_json="mine.json"\nmodel_context_window=100000\nmodel_auto_compact_token_limit=85000\n')
  f.target=f.service.register(external)
  const {path}=enable(f)
  assert.equal(parseNativeCatalog(readFileSync(path,'utf8')).custom_root && true,true)
  assert.equal(parseNativeCatalog(readFileSync(path,'utf8')).models[0].base_instructions,'fixture-private-instructions')
  const active=f.service.catalogView(f.target.id)
  assert.equal(JSON.stringify(active).includes('fixture-private-instructions'),false)
  const disable=f.service.previewCatalog({id:f.target.id,revision:active.revision,enabled:false,models:'stale invalid draft'})
  f.service.apply(disable.ticket)
  const doc=new TomlDocument(readFileSync(configPath,'utf8'))
  assert.equal(doc.scalar(['model']),'previous-model')
  assert.equal(doc.raw(['model_catalog_json']),null)
  assert.equal(doc.scalar(['model_context_window']),100000)
  assert.equal(readFileSync(catalogPath,'utf8'),content)
  assert.equal(existsSync(path),true)
  enable(f)
  writeFileSync(configPath,readFileSync(configPath,'utf8').replace('"gpt-6.1-sol"','"user-selected"'))
  f.service.apply(f.service.previewCatalog({id:f.target.id,revision:f.service.catalogView(f.target.id).revision,enabled:false}).ticket)
  assert.equal(new TomlDocument(readFileSync(configPath,'utf8')).scalar(['model']),'user-selected')
})

test('changes to referenced catalogs invalidate preview; restore refuses missing prior catalog files',t=>{
  const f=fixture(t),external=join(f.root,'external');mkdirSync(external)
  const path=join(external,'mine.json');writeFileSync(path,JSON.stringify(builtInCatalog))
  writeFileSync(join(external,'config.toml'),'model_catalog_json="mine.json"\n')
  f.target=f.service.register(external)
  const view=f.service.catalogView(f.target.id)
  const preview=f.service.previewCatalog({id:f.target.id,revision:view.revision,enabled:true,models:view.models,defaultModelId:null})
  writeFileSync(path,readFileSync(path,'utf8')+'\n')
  assert.throws(()=>f.service.apply(preview.ticket),/模型目录已被/)
  assert.throws(()=>f.service.previewCatalog({id:f.target.id,revision:view.revision,enabled:true,models:view.models,defaultModelId:null}),/已改变/)
  enable(f)
  const backup=f.service.view(f.target.id).revisions[0].id
  rmSync(path)
  const restore=f.service.previewRestore({id:f.target.id,backup})
  assert.ok(restore.conflicts.includes('model_catalog_json'))
  assert.equal(restore.changes.length,0)
})

test('native and Cockpit model files import via frozen tickets; invalid drafts cannot partially write',t=>{
  const f=fixture(t),file=join(f.root,'models.json')
  writeFileSync(file,JSON.stringify({models:[{model_id:'gpt-5.5',display_name:'Imported',context_window:600000,reasoning_efforts:['high']}]}))
  const imported=f.service.importCatalog(f.target.id,file)
  writeFileSync(file,'changed after preview')
  const current=f.service.catalogView(f.target.id)
  const preview=f.service.previewCatalog({id:f.target.id,revision:current.revision,enabled:true,models:imported.models,defaultModelId:'gpt-5.5',importTicket:imported.ticket})
  f.service.apply(preview.ticket)
  assert.equal(f.service.catalogView(f.target.id).capabilities.find(model=>model.modelId==='gpt-5.5')!.contextWindow,600000)
  assert.equal(f.service.catalogView(f.target.id).defaultCapabilities.find(model=>model.modelId==='gpt-5.5')!.contextWindow,272000)
  const next=f.service.catalogView(f.target.id),before=readFileSync(join(f.target.directory,'config.toml'),'utf8')
  for(const models of [[],[{...next.models[0],autoCompactTokenLimit:900,contextWindow:800}],[next.models[0],{...next.models[0],modelId:next.models[0].modelId.toUpperCase()}]]) {
    assert.throws(()=>f.service.previewCatalog({id:f.target.id,revision:next.revision,enabled:true,models,defaultModelId:null}))
  }
  assert.equal(readFileSync(join(f.target.directory,'config.toml'),'utf8'),before)
  assert.throws(()=>parseNativeCatalog('{"secret":"fixture-private-token"}'),error=>!String(error).includes('fixture-private-token'))
})

test('native overrides reject ambiguous duplicates and cap the merged model set',()=>{
  const base=structuredClone(builtInCatalog)
  const overridden=parseNativeCatalog(JSON.stringify({...base,model_overrides:[{slug:'gpt-5.5',context_window:500000,max_context_window:500000}]}))
  assert.equal(overridden.models.find(model=>model.slug==='gpt-5.5')!.context_window,500000)
  assert.deepEqual(parseNativeCatalog(JSON.stringify({...base,model_overrides:[]})).models,base.models)
  assert.throws(()=>parseNativeCatalog(JSON.stringify({...base,model_overrides:[{slug:'gpt-5.5'},{slug:'GPT-5.5'}]})),/重复/)
  const models=Array.from({length:512},(_,index)=>({...base.models[0],slug:`fixture-${index}`}))
  assert.throws(()=>parseNativeCatalog(JSON.stringify({models,model_overrides:[{...base.models[0],slug:'overflow'}]})))
})

test('explicit reset repairs a missing or damaged managed catalog into a new immutable file',t=>{
  for(const mode of ['missing','damaged']){
    const f=fixture(t),{path}=enable(f,defaultModelDefinitions(),null)
    if(mode==='missing')rmSync(path);else writeFileSync(path,'broken user-edited catalog')
    const view=f.service.catalogView(f.target.id)
    assert.ok(view.error)
    f.service.apply(f.service.previewCatalog({id:f.target.id,revision:view.revision,enabled:true,models:view.defaults,defaultModelId:null,reset:true}).ticket)
    const repaired=f.service.catalogView(f.target.id)
    assert.equal(repaired.error,undefined);assert.equal(repaired.source,'managed');assert.notEqual(repaired.reference,path)
    if(mode==='damaged')assert.equal(readFileSync(path,'utf8'),'broken user-edited catalog')
    else assert.equal(existsSync(path),false)
  }
})
