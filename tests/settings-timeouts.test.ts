import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAPIAccount } from '../src/main/accounts'
import { runtimeManifest } from '../src/main/runtimeManifest'
import { Store } from '../src/main/store'
import { settingsSchema } from '../src/shared/types'

const codec = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }

test('stream open timeout defaults to unlimited and projects the no-deadline sentinel', () => {
  const settings = settingsSchema.parse({})
  assert.equal(settings.streamOpenTimeoutSeconds, 0)
  assert.equal(settings.imageStreamOpenTimeoutSeconds, 0)
  assert.equal(settings.streamIdleTimeoutSeconds, 120)

  const account = createAPIAccount({ name: 'Fixture', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', models: ['fixture-model'], wireApi: 'responses', defaultTier: 'inherit', note: '', tags: [] })
  const profile = { id: account.id, port: 12345, account, apiKey: 'local-fixture' }
  const projection = runtimeManifest(profile, settings, 'management-fixture')
  const streaming = projection.config.streaming as Record<string, number>
  assert.equal(streaming['stream-open-timeout-ms'], -1)
  assert.equal(streaming['image-stream-open-timeout-ms'], -1)
  assert.equal(streaming['stream-idle-timeout-ms'], 120000)

  const bounded = runtimeManifest(profile, settingsSchema.parse({ streamOpenTimeoutSeconds: 30 }), 'management-fixture')
  assert.equal((bounded.config.streaming as Record<string, number>)['stream-open-timeout-ms'], 30000)
})

test('legacy 60-second defaults migrate to unlimited while explicit values remain configurable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cml-stream-timeout-migration-'))
  try {
    writeFileSync(join(directory, 'state.vault'), JSON.stringify({
      version: 1,
      settings: { streamOpenTimeoutSeconds: 60, streamIdleTimeoutSeconds: 120, imageStreamOpenTimeoutSeconds: 60, imageStreamIdleTimeoutSeconds: 180 },
      accounts: [],
      groups: []
    }))
    const store = new Store(directory, codec)
    assert.equal(store.read().settings.streamOpenTimeoutSeconds, 0)
    assert.equal(store.read().settings.imageStreamOpenTimeoutSeconds, 0)

    store.transaction(state => { state.settings.streamOpenTimeoutSeconds = 45 })
    const reopened = new Store(directory, codec)
    assert.equal(reopened.read().settings.streamOpenTimeoutSeconds, 45)
    assert.equal(reopened.read().settings.imageStreamOpenTimeoutSeconds, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
