import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { SessionContentPage, SessionRecord } from '../src/shared/sessions'
import type { InstanceLaunchPreview } from '../src/shared/instances'

const session = (id = 'claude:fixture', targetId = '00000000-0000-4000-8000-000000000001'): SessionRecord => ({
  id, sourceSessionId: 'fixture-native-id', title: 'A conversation', cwd: '/fixture/project', cwdCandidates:['/fixture/project'],cwdAvailableCandidates:['/fixture/project'],resumeSourceId:'fixture-source',clientType: 'claude_code', launchMode: 'cli', kind: 'conversation',
  locations: [{ targetId, name: 'Source CLI', directory: '/fixture/claude', running: false, archived: false, ambiguous: false }],
  capabilities: { open: true, content: true, resume: true, transfer: false, archive: false, trash: false, visibilityRepair: false, tokens: false, contentSearch: true },
})
const preview = (ticket: string): InstanceLaunchPreview & { sessionId: string } => ({
  ticket, instanceId: session().locations[0].targetId, name: 'Source CLI', application: '/fixture/claude', directory: '/fixture/config', desktopDirectory: '/fixture/desktop',
  clientType: 'claude_code', launchMode: 'cli', workingDirectory: '/fixture/project', args: ['--resume', 'fixture-native-id'], accountName: 'Fixture API', model: 'fixture-model',
  tierSource: 'instance', connectionMode: 'native', identityStatus: 'api_configured', sessionId: 'fixture-native-id',cwd:'/fixture/project',
})
const content = (sessionId: string, text: string): SessionContentPage => ({
  snapshotId: 'snapshot', sessionId, sourceSessionId: 'fixture-native-id', title: 'A conversation', cwd: '/fixture/project', sourceName: 'Source CLI', clientType: 'claude_code',
  page: 1, pageSize: 40, total: 1, messages: [{ index: 0, role: 'user', blocks: [{ type: 'text', text }] }], warnings: [],
})
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

function mount(name: string, api: Record<string, unknown>, initial: Record<string, unknown> = {}, manager = { error: '', execute: async (action: () => Promise<unknown>) => { await action(); return true } }) {
  const path = new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url)
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
  const script = compileScript(descriptor, { id: 'claude-session-ui-test' }).content.replace('__expose();', '').replace('return __returned__', '__expose(__returned__); return __returned__')
  const javascript = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}, context = { module: { exports }, exports, console, window: { manager: api },
    require: (id: string) => id === 'vue' ? vue : id === '../store' ? { useManager: () => manager } : (() => { throw new Error(`Unexpected module: ${id}`) })() }
  vm.runInNewContext(javascript, context)
  const component = (context.module.exports as { default: vue.Component }).default as vue.Component & { render?: () => null }
  component.render = () => null
  const renderer = vue.createRenderer<object, { children: object[] }>({ patchProp() {}, insert(node, parent) { parent.children.push(node) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const props = vue.reactive({ snapshotId: 'snapshot', record: session(), targetId: session().locations[0].targetId, ...initial }), state = vue.shallowRef<any>(), events: unknown[][] = []
  const app = renderer.createApp({ setup: () => () => vue.h(component, { ...props, ref: state, onClose: () => events.push(['close']), onStarted: (id: string) => events.push(['started', id]) }) })
  app.mount({ children: [] })
  return { state: state.value as Record<string, any>, props, events, unmount: () => app.unmount() }
}

test('Claude reader binds whole-conversation search and pagination to the original source through plain IPC values', async t => {
  const calls: unknown[] = []
  const ui = mount('SessionContentPanel', { sessionContent: async (value: any) => { calls.push(structuredClone(value)); return { ...content(value.sessionId, '<img src="https://fixture.invalid">'), page: value.page } } }, { initialQuery: '  literal [text]  ' })
  t.after(ui.unmount); await settle()
  assert.deepEqual(calls[0], { snapshotId: 'snapshot', sessionId: 'claude:fixture', targetId: session().locations[0].targetId, page: 1, pageSize: 40, query: 'literal [text]' })
  assert.equal(ui.state.result.messages[0].blocks[0].text, '<img src="https://fixture.invalid">')
  ui.state.query = 'second page'; await ui.state.load(2)
  assert.equal((calls[1] as any).page, 2)
  assert.equal((calls[1] as any).query, 'second page')
  assert.equal(ui.state.result.page, 2)
  assert.equal(ui.state.appliedQuery, 'second page')
})

test('Codex reader binds the explicitly selected physical rollout version to transcript IPC', async t => {
  const calls: unknown[] = [], versionId = 'a'.repeat(32)
  const record = session('codex-fixture')
  record.clientType = 'codex'; record.sourceSessionId = undefined
  const ui = mount('SessionContentPanel', { sessionContent: async (value: any) => { calls.push(structuredClone(value)); return { ...content(value.sessionId, 'Codex response'), clientType: 'codex' } } }, { record, versionId })
  t.after(ui.unmount); await settle()
  assert.deepEqual(calls[0], { snapshotId: 'snapshot', sessionId: 'codex-fixture', targetId: session().locations[0].targetId, versionId, page: 1, pageSize: 40, query: '' })
  assert.equal(ui.state.result.clientType, 'codex')
})

test('Codex reader keeps pagination on the selected rollout and explains incomplete history_base without showing partial content', async t => {
  const calls: any[] = [], versionId = 'd'.repeat(32), record = session('codex-paginated')
  record.clientType = 'codex'; record.sourceSessionId = undefined; record.historyMode = 'paginated'
  const ui = mount('SessionContentPanel', { sessionContent: async (value: any) => { calls.push(structuredClone(value)); if (value.page === 2) throw new Error('Error: Codex history_base 未找到 ordinal 与字节边界都匹配的祖先 rollout'); return { ...content(value.sessionId, 'verified page one'), clientType: 'codex' } } }, { record, versionId })
  t.after(ui.unmount); await settle()
  await ui.state.load(2); await settle()
  assert.equal(calls[1].versionId, versionId)
  assert.equal(calls[1].page, 2)
  assert.match(ui.state.error, /history_base 未找到/)
  assert.match(ui.state.error, /没有显示局部内容；请刷新列表并检查来源目录中的 rollout 文件/)
  assert.equal(ui.state.result, undefined, 'a failed page must never leave an earlier or partial transcript looking current')
})

test('a delayed transcript cannot replace another source after navigating between conversations', async t => {
  const first = deferred<SessionContentPage>(), second = deferred<SessionContentPage>(), calls: string[] = []
  const ui = mount('SessionContentPanel', { sessionContent: (value: any) => { calls.push(value.sessionId); return calls.length === 1 ? first.promise : second.promise } })
  t.after(ui.unmount)
  ui.props.record = session('claude:other', '00000000-0000-4000-8000-000000000002'); ui.props.targetId = ui.props.record.locations[0].targetId
  await settle(); second.resolve(content('claude:other', 'Correct source')); await settle()
  first.resolve(content('claude:fixture', 'Earlier source')); await settle()
  assert.equal(ui.state.result.sessionId, 'claude:other')
  assert.equal(ui.state.result.messages[0].blocks[0].text, 'Correct source')
})

test('reader highlights literal text without regular-expression interpretation and bounds repetitive markup', async t => {
  const ui = mount('SessionContentPanel', { sessionContent: async () => content('claude:fixture', 'Text') })
  t.after(ui.unmount); await settle()
  ui.state.appliedQuery = '[x]'
  assert.deepEqual(JSON.parse(JSON.stringify(ui.state.highlight('A [x] B [X]'))), [{ text: 'A ', match: false }, { text: '[x]', match: true }, { text: ' B ', match: false }, { text: '[X]', match: true }])
  ui.state.appliedQuery = 'a'
  const parts = ui.state.highlight('a'.repeat(10_000))
  assert.ok(parts.length <= 601)
  assert.equal(parts.map((part: any) => part.text).join(''), 'a'.repeat(10_000))
})

test('resume preview cancelled before completion discards the delayed ticket and never launches a process', async () => {
  const pending = deferred<ReturnType<typeof preview>>(), discards: string[] = [], starts: string[] = []
  const ui = mount('SessionResumePanel', { previewClaudeSessionResume: () => pending.promise, discardClaudeSessionResume: async (ticket: string) => { discards.push(ticket) } })
  await settle(); await ui.state.close(); ui.unmount()
  pending.resolve(preview('late-ticket')); await settle()
  assert.deepEqual(discards, ['late-ticket'])
  assert.deepEqual(starts, [])
  assert.deepEqual(ui.events, [['close']])
})

test('changing resume source discards stale authorization and displays only the new instance preview', async t => {
  const first = deferred<ReturnType<typeof preview>>(), second = deferred<ReturnType<typeof preview>>(), discards: string[] = []
  let count = 0
  const ui = mount('SessionResumePanel', { previewClaudeSessionResume: () => ++count === 1 ? first.promise : second.promise, discardClaudeSessionResume: async (ticket: string) => { discards.push(ticket) } })
  t.after(ui.unmount); await settle()
  ui.props.record = session('claude:other'); await settle()
  second.resolve(preview('new-ticket')); await settle(); first.resolve(preview('old-ticket')); await settle()
  assert.equal(ui.state.preview.ticket, 'new-ticket')
  assert.deepEqual(discards, ['old-ticket'])
})

test('managed Claude resume binds the selected cwd to the current source snapshot',async t=>{
  const selected=session('claude:multi-cwd'),second='/fixture/second-project';selected.cwdCandidates=['/fixture/project',second];selected.cwdAvailableCandidates=['/fixture/project',second]
  const calls:unknown[]=[]
  const ui=mount('SessionResumePanel',{previewClaudeSessionResume:async(input:any)=>{calls.push(structuredClone(input));return {...preview('multi-cwd-ticket'),workingDirectory:input.cwd}},discardClaudeSessionResume:async()=>{}},{record:selected})
  t.after(ui.unmount);await settle()
  assert.equal((calls[0] as any).cwd,'/fixture/project')
  ui.state.selectedCwd=second;await ui.state.prepare();await settle()
  assert.equal((calls.at(-1) as any).cwd,second)
  assert.equal(ui.state.preview.workingDirectory,second)
  assert.equal((calls.at(-1) as any).sourceId,selected.resumeSourceId)
})

test('resume confirmation starts once with its verified ticket and reports the instance for lifecycle feedback', async t => {
  const pending = deferred<void>(), starts: string[] = [], discards: string[] = []
  const ui = mount('SessionResumePanel', {
    previewClaudeSessionResume: async () => preview('confirmed-ticket'), discardClaudeSessionResume: async (ticket: string) => { discards.push(ticket) },
    startInstance: async (ticket: string) => { starts.push(ticket); await pending.promise },
  })
  t.after(ui.unmount); await settle()
  const first = ui.state.start(); await ui.state.start(); await ui.state.close()
  assert.deepEqual(starts, ['confirmed-ticket']); assert.deepEqual(ui.events, [])
  pending.resolve(); await first
  assert.deepEqual(ui.events, [['started', session().locations[0].targetId], ['close']])
  assert.equal(ui.state.preview, undefined)
  assert.deepEqual(discards, [])
})

test('a failed resume invalidates its consumed ticket so retry requires a fresh preview', async t => {
  const discards: string[] = []
  const ui = mount('SessionResumePanel', { previewClaudeSessionResume: async () => preview('failed-ticket'), discardClaudeSessionResume: async (ticket: string) => { discards.push(ticket) } }, {}, { error: 'Source instance changed', execute: async () => false })
  t.after(ui.unmount); await settle(); await ui.state.start()
  assert.equal(ui.state.error, 'Source instance changed')
  assert.equal(ui.state.preview, undefined)
  assert.deepEqual(discards, ['failed-ticket'])
  assert.deepEqual(ui.events, [])
})
