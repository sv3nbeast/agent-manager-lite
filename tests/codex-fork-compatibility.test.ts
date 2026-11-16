import test from 'node:test'
import assert from 'node:assert/strict'
import {codexForkPlacementContract,codexForkPlacementReplacements} from '../src/main/codexForkCompatibility'
import {applyCodexUiReplacements} from '../src/main/codexUiCapabilities'
import {forkPlacementFixture,forkWrapper} from './fixtures/codex-fork-placement'

const contract=codexForkPlacementContract(forkPlacementFixture)!
function setup(patched=true){
  const edits=codexForkPlacementReplacements(forkWrapper,contract)
  assert.equal(edits.length,2)
  const source=patched?applyCodexUiReplacements(forkWrapper,edits):forkWrapper
  const forwards:any[]=[],inputs=()=>({config:'native'})
  const forward=async(request:any)=>{forwards.push(request);return request.placement===undefined?{status:'not-ready',reason:'execution-config-loading'}:{status:'ready',request}}
  const modules:Record<string,unknown>={service:{inputs,forkConversationFromLatest:forward,forkConversationFromTurn:forward},identityModule:{auth:'auth'},groupingModule:{grouping:'grouping'},sortingModule:{current:'sort',previous:'legacy'}}
  // The wrapper's third parameter deliberately shadows the bundler loader.
  const fork=new Function('n',source+';return fork')((id:string)=>modules[id])
  const values:any={auth:{authLoading:false,authMethod:null,requiresAuth:false},grouping:false,sort:undefined,legacy:{projectSortMode:'manual'}}
  const scope={get:(atom:string)=>values[atom]}
  return {fork,scope,values,forwards,inputs}
}
test('local API forks supply native placement without waiting for unused grouping settings',async()=>{
  const original=setup(false);await assert.rejects(original.fork(original.scope,'local',{sourceConversationId:'source'}),/execution-config-loading/)
  for(const authMethod of [null,'apikey'])for(const targetTurnId of [undefined,'turn']){
    const f=setup();f.values.auth.authMethod=authMethod
    const params={sourceConversationId:'source',cwd:'/fixture',...(targetTurnId?{targetTurnId}:{})}
    const result=await f.fork(f.scope,'local',params)
    assert.deepEqual(result.request.placement,{prependToManualProject:true,customSection:null})
    assert.equal(result.request.readResumeInputs,f.inputs)
    assert.equal(result.request.cwd,params.cwd)
    assert.equal(result.request.sourceConversationId,params.sourceConversationId)
    assert.equal(result.request.targetTurnId,targetTurnId)
    assert.equal(f.forwards.length,1)
    assert.equal('placement' in params,false)
  }
})
test('official accounts, remote hosts, pending authentication and grouping keep native checks',async()=>{
  for(const change of [
    (f:any)=>f.values.auth.authMethod='chatgpt',
    (f:any)=>f.values.auth.authMethod='personalAccessToken',
    (f:any)=>f.values.auth.requiresAuth=true,
    (f:any)=>f.values.auth.authLoading=true,
    (f:any)=>delete f.values.auth.authLoading,
    (f:any)=>f.values.grouping=true,
    (f:any)=>f.values.grouping=undefined,
  ]){const f=setup();change(f);await assert.rejects(f.fork(f.scope,'local',{}),/execution-config-loading/);assert.equal(f.forwards[0].placement,undefined)}
  const f=setup();await assert.rejects(f.fork(f.scope,'remote',{}),/execution-config-loading/)
})
test('explicit placement and callbacks stay intact; sort validation matches native precedence',async()=>{
  const f=setup(),placement={customSection:{accountId:'account',sectionId:'section',sourceThreadId:'source'},prependToManualProject:true},callback=()=>{}
  assert.equal((await f.fork(f.scope,'local',{placement,afterConversationCreated:callback})).request.placement,placement)
  assert.equal(f.forwards[0].afterConversationCreated,callback)
  assert.equal((await f.fork(f.scope,'local',{placement:null})).request.placement,null)
  for(const [current,legacy,expected] of [['updated_at','manual',false],['invalid','manual',true],['manual','updated_at',true],[undefined,'invalid',false]]){
    f.values.sort=current;f.values.legacy={projectSortMode:legacy}
    assert.equal((await f.fork(f.scope,'local',{})).request.placement.prependToManualProject,expected)
  }
})
test('roles survive renamed modules and reject ambiguous or changed contracts',()=>{
  assert.deepEqual(contract,{identity:{module:'identityModule',export:'auth'},sections:{module:'groupingModule',export:'grouping'},sort:{module:'sortingModule',export:'current'},legacySort:{module:'sortingModule',export:'previous'}})
  assert.equal(codexForkPlacementContract(forkPlacementFixture.replaceAll('identityModule','newIdentity'))?.identity.module,'newIdentity')
  assert.equal(codexForkPlacementContract(forkPlacementFixture.replaceAll('authenticatedAccountId','unrelatedField')),undefined)
  assert.equal(codexForkPlacementContract(forkPlacementFixture.replace('previous:legacy','previous:legacy,duplicate:legacy')),undefined)
  const patched=applyCodexUiReplacements(forkWrapper,codexForkPlacementReplacements(forkWrapper,contract))
  for(const source of [patched,forkWrapper.replace('...n,readResumeInputs','...n,placement:n.placement,readResumeInputs'),forkWrapper.replace('forkConversationFromLatest(request)','otherMethod(request)'),forkWrapper+forkWrapper.replace('async function fork','async function anotherFork')])assert.deepEqual(codexForkPlacementReplacements(source,contract),[])
})
