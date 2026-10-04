import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Store } from '../src/main/store'
import { mutateProvider } from '../src/main/providerLibrary'
import { providerPreset, providerPresets } from '../src/shared/providerPresets'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'cml-provider-capabilities-'))
  const key = randomBytes(32)
  const codec = {
    encrypt(value: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt(value: Buffer) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()
    }
  }
  const store = new Store(join(root, 'vault'), codec)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { store, codec }
}

test('provider presets are offline data and do not create accounts or contact a network', () => {
  assert.ok(providerPresets.length >= 5)
  const preset = providerPreset('deepseek')
  assert.ok(preset)
  assert.equal(preset?.baseUrls[0], 'https://api.deepseek.com')
  assert.deepEqual(preset?.modelCatalog, ['deepseek-flash', 'deepseek-v4-pro'])
})

test('provider capability fields survive save, update, encrypted restart and snapshot redaction', t => {
  const { store, codec } = fixture(t)
  mutateProvider(store, { action: 'create', details: {
    name: 'Capability fixture', baseUrl: 'https://capability.invalid/v1', wireApi: 'responses',
    models: ['vision-model'], defaultTier: 'inherit', presetId: 'custom',
    modelContextWindows: { 'vision-model': 400000 }, supportsVision: true,
    modelCapabilities: { 'vision-model': { supportsVision: true } }, visionRoutingModel: 'vision-model',
    supportsWebsockets: true, enableModePreference: 'gateway'
  } })
  const first = store.read().providers![0]
  assert.deepEqual(store.snapshot().providers![0], {
    id: first.id, revision: 0, name: 'Capability fixture', baseUrl: 'https://capability.invalid/v1',
    models: ['vision-model'], wireApi: 'responses', defaultTier: 'inherit', presetId: 'custom',
    modelContextWindows: { 'vision-model': 400000 }, supportsVision: true,
    modelCapabilities: { 'vision-model': { supportsVision: true } }, visionRoutingModel: 'vision-model',
    supportsWebsockets: true, enableModePreference: 'gateway', createdAt: first.createdAt,
    updatedAt: first.updatedAt, keys: []
  })
  mutateProvider(store, { action: 'update', id: first.id, revision: first.revision, changes: { supportsVision: false, modelContextWindows: { 'vision-model': 300000 } } })
  const reopened = new Store(store.directory, codec)
  const provider = reopened.read().providers![0]
  assert.equal(provider.supportsVision, false)
  assert.deepEqual(provider.modelContextWindows, { 'vision-model': 300000 })
  assert.equal(provider.supportsWebsockets, true)
  assert.equal(provider.enableModePreference, 'gateway')
  assert.equal(readFileSync(join(store.directory, 'state.vault')).includes('Capability fixture'), false)
})
