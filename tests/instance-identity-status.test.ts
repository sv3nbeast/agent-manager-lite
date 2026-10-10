import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseAccountImport} from '../src/main/accounts'
import {authFor} from '../src/main/nativeAccountProjection'
import {readInstanceIdentityStatus} from '../src/main/instanceIdentityStatus'

const token=(workspace:string,email=`${workspace}@example.invalid`)=>'fixture.'+Buffer.from(JSON.stringify({exp:2_000_000_000,email,'https://api.openai.com/auth':{chatgpt_account_id:workspace,chatgpt_user_id:`user-${workspace}`}})).toString('base64url')+'.signature'
const oauth=(workspace:string)=>parseAccountImport(JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token(workspace),id_token:token(workspace),refresh_token:`refresh-${workspace}`,account_id:workspace}})).accounts[0]
const config='model_provider = "openai"\nforced_login_method = "chatgpt"\nmodel = "fixture-model"\n'

test('instance identity status distinguishes local API from a verified native account without returning credentials',t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-instance-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const account=oauth('workspace-a'),home=join(root,'home');mkdirSync(home)
  assert.deepEqual(readInstanceIdentityStatus(home,'local_api',account),{status:'local_api'})
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'missing'})
  writeFileSync(join(home,'config.toml'),config)
  writeFileSync(join(home,'auth.json'),authFor(account,null))
  const verified=readInstanceIdentityStatus(home,'native',account)
  assert.equal(verified.status,'native_verified')
  assert.equal(verified.email,'workspace-a@example.invalid')
  assert.equal(verified.accountId,'workspace-a')
  assert.equal(JSON.stringify(verified).includes('refresh-workspace-a'),false)
  assert.equal(JSON.stringify(verified).includes(token('workspace-a')),false)
})

test('native identity status reports mismatches and malformed files as unverified, and unsafe files as unknown',t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-instance-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const account=oauth('workspace-a'),other=oauth('workspace-b'),home=join(root,'home');mkdirSync(home)
  writeFileSync(join(home,'config.toml'),config)
  writeFileSync(join(home,'auth.json'),authFor(other,null))
  const mismatch=readInstanceIdentityStatus(home,'native',account)
  assert.equal(mismatch.status,'native_unverified')
  assert.equal(mismatch.accountId,'workspace-b')
  writeFileSync(join(home,'auth.json'),'not-json')
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'native_unverified'})
  rmSync(join(home,'auth.json'))
  writeFileSync(join(home,'auth-target'),'secret')
  symlinkSync(join(home,'auth-target'),join(home,'auth.json'))
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'unknown'})
})

test('native OAuth identity requires the persisted last_refresh timestamp before it can be verified',t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-instance-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const account=oauth('workspace-a'),home=join(root,'home');mkdirSync(home)
  writeFileSync(join(home,'config.toml'),config)
  const auth=JSON.parse(authFor(account,null)) as Record<string,unknown>
  delete auth.last_refresh
  writeFileSync(join(home,'auth.json'),JSON.stringify(auth))
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'native_unverified'})
  auth.last_refresh='2999-01-01T00:00:00.000Z'
  writeFileSync(join(home,'auth.json'),JSON.stringify(auth))
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'native_unverified'})
})

test('native keychain or ephemeral stores remain unknown when no file credential is available',t=>{
  const root=mkdtempSync(join(tmpdir(),'cml-instance-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const account=oauth('workspace-a'),home=join(root,'home');mkdirSync(home)
  writeFileSync(join(home,'config.toml'),'cli_auth_credentials_store = "auto"\n'+config)
  assert.deepEqual(readInstanceIdentityStatus(home,'native',account),{status:'unknown'})
})
