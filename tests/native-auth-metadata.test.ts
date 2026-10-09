import test from 'node:test'
import assert from 'node:assert/strict'
import {parseAccountImport,createAPIAccount} from '../src/main/accounts'
import {serializeAccounts} from '../src/main/accountFiles'
import {authFor,adoptNative} from '../src/main/nativeAccountProjection'
import {accountFromAuth} from '../src/main/clientIdentity'
import {TomlDocument} from '../src/main/tomlPatch'
import {settingsSchema} from '../src/shared/types'
import type {State} from '../src/main/store'

const recorded='2026-01-02T03:04:05.000Z'
function fixture(extra:Record<string,unknown>={}) {
  const token='fixture.'+Buffer.from(JSON.stringify({iat:1_700_000_000,exp:2_000_000_000,email:'fixture@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'fixture-workspace'},...extra})).toString('base64url')+'.signature'
  return {auth_mode:'chatgpt',last_refresh:recorded,tokens:{access_token:token,id_token:token,refresh_token:'fixture-refresh',account_id:'fixture-workspace'}}
}
const parse=(value:unknown)=>parseAccountImport(JSON.stringify(value)).accounts[0]

test('OAuth import, native identity reads and export retain the real refresh timestamp',()=>{
  const raw=fixture(),account=parse(raw),native=accountFromAuth(JSON.stringify(raw),new TomlDocument(''))
  assert.equal(account.credentials.lastRefresh,recorded)
  assert.equal(native.credentials.lastRefresh,recorded)
  assert.equal(parse(JSON.parse(serializeAccounts([account]))[0]).credentials.lastRefresh,recorded)
  const projected=JSON.parse(authFor(account,JSON.stringify({...fixture(),last_refresh:'2025-01-01T00:00:00Z',custom:'preserved'})))
  assert.equal(projected.last_refresh,recorded);assert.equal(projected.custom,'preserved')
  assert.deepEqual(projected.tokens,raw.tokens)
  const cockpit=parse({...raw,last_refresh:undefined,token_updated_at:Date.parse(recorded)/1000})
  assert.equal(cockpit.credentials.lastRefresh,recorded)
})

test('legacy credentials expose native token data without pretending they were just refreshed',()=>{
  const account=parse(fixture());delete account.credentials.lastRefresh
  assert.equal(JSON.parse(authFor(account,null)).last_refresh,recorded,'Reuse matching legacy source')
  account.credentials.accessToken=fixture({iat:1_760_000_000}).tokens.access_token
  assert.equal(JSON.parse(authFor(account,null)).last_refresh,new Date(1_760_000_000_000).toISOString(),'Use the current token issue time')
  delete account.source
  account.credentials.accessToken=fixture({iat:undefined}).tokens.access_token
  assert.equal(JSON.parse(authFor(account,null)).last_refresh,'1970-01-01T00:00:00.000Z')
  for(const value of ['invalid','2999-01-01T00:00:00Z',-1]){
    const legacy=parse({...fixture({iat:undefined}),last_refresh:value})
    assert.equal(JSON.parse(authFor(legacy,null)).last_refresh,'1970-01-01T00:00:00.000Z')
  }
})

test('client rotation adopts its refresh timestamp and cannot replay the prior account template timestamp',()=>{
  const account=parse(fixture()),state:State={version:1,settings:settingsSchema.parse({}),accounts:[account],groups:[]}
  const observed=accountFromAuth(JSON.stringify({...fixture(),last_refresh:'2026-02-01T00:00:00Z'}),new TomlDocument(''))
  adoptNative(state,account.id,observed)
  assert.equal(state.accounts[0].credentials.lastRefresh,'2026-02-01T00:00:00.000Z')
  assert.equal(JSON.parse(authFor(state.accounts[0],JSON.stringify(fixture()))).last_refresh,'2026-02-01T00:00:00.000Z')
})

test('API and PAT projections clear unrelated OAuth refresh metadata',()=>{
  const api=createAPIAccount({name:'Fixture',apiKey:'fixture-key',baseUrl:'https://fixture.invalid/v1',wireApi:'responses',models:['fixture-model'],defaultTier:'inherit'})
  const pat=parse({personal_access_token:'fixture-pat'})
  for(const account of [api,pat]){
    const value=JSON.parse(authFor(account,JSON.stringify(fixture())))
    assert.equal(value.last_refresh,undefined);assert.equal(value.tokens,undefined)
  }
})
