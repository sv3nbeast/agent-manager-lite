import test from 'node:test'
import assert from 'node:assert/strict'
import { readInstanceModelDefaults } from '../src/main/instanceModelDefaults'
import { builtInCatalog } from '../src/main/modelCatalog'

test('native instance defaults use visible client models in catalog priority order without routing templates', () => {
  const before = JSON.stringify(builtInCatalog)
  const defaults = readInstanceModelDefaults('codex')
  const visible = builtInCatalog.models.filter(model => model.visibility !== 'hide')
  assert.equal(defaults.models.length, visible.length)
  assert.equal(defaults.defaultModelId, visible.reduce((best, model) => Number(model.priority) < Number(best.priority) ? model : best).slug)
  assert.deepEqual(new Set(defaults.models), new Set(visible.map(model => model.slug)))
  assert.ok(!defaults.models.includes('gpt-reserve'))
  assert.ok(builtInCatalog.models.filter(model => model.visibility === 'hide').every(model => !defaults.models.includes(model.slug)))
  defaults.models.reverse()
  assert.equal(readInstanceModelDefaults('codex').models[0], defaults.defaultModelId)
  assert.equal(JSON.stringify(builtInCatalog), before)
})

test('instance model defaults reject unsupported clients and arbitrary catalog inputs', () => {
  for (const input of [undefined, 'claude', '', {}, { clientType: 'codex', directory: '/fixture/custom-catalog' }]) {
    assert.throws(() => readInstanceModelDefaults(input))
  }
})
