import test from 'node:test'
import assert from 'node:assert/strict'
import { formatModelContextWindow, getModelContextWindow, modelContextChoice, modelContextWindowPresets, setModelContextWindow } from '../src/shared/modelContextWindows'
import { providerDetailsSchema } from '../src/shared/providerLibrary'
import { readModelContextDefaults } from '../src/main/modelContextDefaults'
import { builtInCatalog } from '../src/main/modelCatalog'

test('preset and custom context windows retain imported values and hidden model declarations',()=>{
  const original={current:2_000_000,hidden:200001}
  assert.equal(modelContextChoice(original.current),'custom')
  assert.equal(modelContextChoice(undefined),'default')
  const changed=setModelContextWindow(original,['current'],1_000_000)
  assert.deepEqual(changed,{current:1_000_000,hidden:200001})
  assert.deepEqual(setModelContextWindow(changed,['current'],undefined),{hidden:200001})
  assert.equal(setModelContextWindow(changed,['current','hidden'],undefined),undefined)
  assert.deepEqual(original,{current:2_000_000,hidden:200001})
  for(const preset of modelContextWindowPresets) assert.equal(modelContextChoice(preset.value),preset.value)
  assert.equal(modelContextWindowPresets[0].value,32000)
})

test('custom context values obey the persisted 2..10m integer contract so derived compaction remains positive',()=>{
  const details={name:'Fixture',baseUrl:'https://fixture.invalid/v1',models:['custom']}
  for(const value of [2,32768,199999,2_000_000,10_000_000]) {
    const windows=setModelContextWindow(undefined,['custom'],value)
    assert.deepEqual(providerDetailsSchema.parse({...details,modelContextWindows:windows}).modelContextWindows,windows)
  }
  for(const value of [0,1,-1,1.5,10_000_001,NaN,Infinity]) {
    assert.throws(()=>setModelContextWindow(undefined,['custom'],value))
    assert.throws(()=>providerDetailsSchema.parse({...details,modelContextWindows:{custom:value}}))
  }
})

test('supplier defaults read each native model window without changing the catalog or claiming unknown provider capacity',()=>{
  const original=JSON.stringify(builtInCatalog)
  const known=readModelContextDefaults(builtInCatalog.models.map(model=>model.slug))
  for (const model of builtInCatalog.models) {
    const value=known.find(item=>item.modelId===model.slug)!
    assert.equal(value.contextWindow,model.context_window)
    assert.equal(value.source,'catalog')
  }
  const values=readModelContextDefaults([' GPT-6-LUNA ','gpt-6.1-sol','custom/unknown','provider/gpt-6-luna','gpt-reserve','gpt-6.1-sol'])
  assert.deepEqual(values.map(value=>[value.modelId,value.contextWindow,value.source]),[
    ['GPT-6-LUNA',256000,'catalog'],['gpt-6.1-sol',272000,'catalog'],['custom/unknown',272000,'template'],
    ['provider/gpt-6-luna',256000,'template'],['gpt-reserve',272000,'catalog']
  ])
  assert.equal(JSON.stringify(builtInCatalog),original)
  assert.deepEqual(readModelContextDefaults([]),[])
  for (const input of [null,{},[''],Array(501).fill('model'),['a'.repeat(201)]]) assert.throws(()=>readModelContextDefaults(input))
})

test('context display uses exact decimal counts instead of rounding arbitrary imported windows',()=>{
  assert.equal(formatModelContextWindow(256000),'256K')
  assert.equal(formatModelContextWindow(272000),'272K')
  assert.equal(formatModelContextWindow(1_000_000),'1M')
  assert.equal(formatModelContextWindow(262144),'262,144 tokens')
})

test('model names matching object properties remain exact own declarations without mutating prototypes',()=>{
  for (const model of ['constructor','toString','__proto__']) {
    assert.equal(getModelContextWindow({},model),undefined)
    const configured=setModelContextWindow({normal:256000},[model],128000)!
    assert.equal(Object.getPrototypeOf(configured),Object.prototype)
    assert.equal(getModelContextWindow(configured,model),128000)
    const saved=JSON.parse(JSON.stringify(configured))
    assert.equal(getModelContextWindow(saved,model),128000)
    assert.deepEqual(setModelContextWindow(saved,[model],undefined),{normal:256000})
    assert.equal(getModelContextWindow({},model),undefined)
  }
})
