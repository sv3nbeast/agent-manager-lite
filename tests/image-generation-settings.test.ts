import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { createAPIAccount } from '../src/main/accounts'
import { runtimeManifest } from '../src/main/runtimeManifest'
import { settingsSchema } from '../src/shared/types'
import { DEFAULT_IMAGE_GENERATION_MODEL } from '../src/shared/imageGeneration'
import { emptyLocalAccess } from '../src/shared/localAccess'

const codec = { encrypt: (text:string) => Buffer.from(text), decrypt: (data:Buffer) => data.toString() }

test('image defaults accept future provider model IDs and reject invalid IDs', () => {
  assert.equal(settingsSchema.parse({}).imageGenerationModel, 'gpt-image-2.6-sunburst')
  const fallback = readFileSync('sidecars/codex-proxy/manifest_policy.go', 'utf8').match(/const defaultImagesToolModel = "([^"]+)"/)?.[1]
  assert.equal(fallback, DEFAULT_IMAGE_GENERATION_MODEL, 'Manager and standalone relay defaults must agree')
  for (const model of ['future/vendor-image:next', 'custom-image-preview', 'gpt-image-2.5']) {
    assert.equal(settingsSchema.parse({imageGenerationModel:`  ${model}  `}).imageGenerationModel, model)
  }
  for (const model of ['', '   ', 'two models', 'image\nmodel', 'image\u0000model', 'x'.repeat(201)]) {
    assert.equal(settingsSchema.safeParse({imageGenerationModel:model}).success, false)
  }
})

test('old vaults acquire the default without rewriting and saved custom image models survive reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-image-settings-'))
  t.after(() => rmSync(directory, {recursive:true,force:true}))
  const path = join(directory, 'state.vault')
  const original = JSON.stringify({version:1,settings:{theme:'dark'},accounts:[],groups:[]})
  writeFileSync(path, original)
  const store = new Store(directory, codec)
  assert.equal(store.read().settings.imageGenerationModel, DEFAULT_IMAGE_GENERATION_MODEL)
  assert.equal(readFileSync(path, 'utf8'), original)
  store.transaction(state => { state.settings.imageGenerationModel = 'provider/next-image' })
  assert.equal(new Store(directory, codec).read().settings.imageGenerationModel, 'provider/next-image')
  assert.equal(new Store(directory, codec).read().settings.theme, 'dark')
  assert.throws(() => store.transaction(state => { state.settings.imageGenerationModel = '' }))
  assert.equal(new Store(directory, codec).read().settings.imageGenerationModel, 'provider/next-image')
})

test('single-instance and shared-pool manifests project the saved image model without changing account scopes', () => {
  const account = createAPIAccount({name:'Fixture',apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',models:['chat-model','custom-image'],wireApi:'responses'})
  const profile = {id:account.id,port:0,account,apiKey:'local-fixture'}
  const settings = settingsSchema.parse({imageGenerationModel:'custom-image'})
  const single = runtimeManifest(profile, settings, 'control-fixture')
  const pool = runtimeManifest({...profile,pool:{settings:emptyLocalAccess(),accounts:[account],providerTiers:{},tokenUsed:{}}}, settings, 'control-fixture')
  for (const projection of [single,pool]) {
    assert.equal(projection.manifest.imageGenerationModel, 'custom-image')
    assert.deepEqual(projection.manifest.modelIds, ['chat-model','custom-image'])
  }
  assert.deepEqual(account.models, ['chat-model','custom-image'])
})
