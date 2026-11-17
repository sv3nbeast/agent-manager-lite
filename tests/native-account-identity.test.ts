import assert from 'node:assert/strict'
import test from 'node:test'
import {createAPIAccount} from '../src/main/accounts'
import {sameNativeAccount} from '../src/main/accountIdentity'
import type {StoredAccount} from '../src/main/store'

const metadata=['identityService','protocol','credentialKind'] as const
function account(wireApi:'responses'|'chat_completions'='responses'):StoredAccount {
  return createAPIAccount({name:'Fixture',apiKey:'fixture-key',baseUrl:'https://fixture.invalid/v1',models:['fixture-model'],wireApi})
}

test('native API identity resolves missing legacy metadata without mutating either account',()=>{
  for(const wire of ['responses','chat_completions'] as const)for(let mask=0;mask<8;mask++){
    const current=account(wire),legacy=structuredClone(current)
    metadata.forEach((field,bit)=>{if(mask&(1<<bit))delete legacy[field]})
    const before=structuredClone(legacy),currentBefore=structuredClone(current)
    assert.equal(sameNativeAccount(legacy,current),true,`${wire}: missing metadata mask ${mask}`)
    assert.equal(sameNativeAccount(current,legacy),true)
    assert.deepEqual(legacy,before)
    assert.deepEqual(current,currentBefore)
  }
})

test('legacy compatibility still rejects different keys, endpoints, wire protocols and explicit identity metadata',()=>{
  const current=account(),legacy=structuredClone(current)
  for(const field of metadata)delete legacy[field]
  const changes:Partial<StoredAccount>[]=[
    {credentials:{apiKey:'different-fixture-key'}},{credentials:{}},
    {baseUrl:'https://other.invalid/v1'},{baseUrl:'https://fixture.invalid/other'},
    {wireApi:'chat_completions'},{protocol:'openai_chat_completions'},
    {identityService:'anthropic'},{protocol:'anthropic_messages'},
    {credentialKind:'anthropic_api_key'},{credentialKind:'gateway'},{kind:'oauth'}
  ]
  for(const change of changes){
    const different={...current,...change}
    assert.equal(sameNativeAccount(legacy,different),false)
    assert.equal(sameNativeAccount(different,legacy),false)
  }
})
