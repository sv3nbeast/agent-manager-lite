import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useManager } from '../src/renderer/src/store'
import { settingsSchema, type AppSnapshot, type ManagerAPI } from '../src/shared/types'

function snapshot(directory: string): AppSnapshot { return { settings: settingsSchema.parse({}), accounts: [], groups: [], dataDirectory: directory } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}

test('late background snapshots cannot overwrite a completed account change or publish stale errors', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const response = deferred<AppSnapshot>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { manager: { load: () => response.promise } as Pick<ManagerAPI, 'load'> } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') })
  setActivePinia(createPinia())
  const manager = useManager()
  const refresh = manager.refresh()
  await manager.execute(async () => snapshot('after-import'))
  response.resolve(snapshot('before-import'))
  await refresh
  assert.equal(manager.data?.dataDirectory, 'after-import')
  const stale = deferred<AppSnapshot>()
  window.manager.load = () => stale.promise
  const failedRefresh = manager.refresh()
  await manager.execute(async () => snapshot('newer'))
  stale.reject(new Error('stale failure'))
  await failedRefresh
  assert.equal(manager.data?.dataDirectory, 'newer')
  assert.equal(manager.error, '')
})

test('an earlier UI operation cannot clear the loading state of a newer operation', async () => {
  setActivePinia(createPinia())
  const manager = useManager()
  const first = deferred<AppSnapshot>(), second = deferred<AppSnapshot>()
  const a = manager.execute(() => first.promise), b = manager.execute(() => second.promise)
  first.resolve(snapshot('first')); await a
  assert.equal(manager.loading, true)
  second.resolve(snapshot('second')); await b
  assert.equal(manager.loading, false)
  assert.equal(manager.data?.dataDirectory, 'second')
})
