import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexSessionContent } from '../src/main/codexSessionContent'

function event(type: string, payload: unknown, timestamp = '2026-10-23T01:02:03.000Z'): string {
  return JSON.stringify({ type, timestamp, payload })
}

async function withRollout(lines: string[], run: (file: Awaited<ReturnType<typeof open>>, size: number) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'aml-codex-content-'))
  const path = join(root, 'rollout.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  const file = await open(path, 'r')
  try { await run(file, (await file.stat()).size) }
  finally { await file.close(); rmSync(root, { recursive: true, force: true }) }
}

test('Codex transcript projects user and assistant messages, function calls/results, and skips metadata', async () => {
  const lines = [
    event('session_meta', { id: 'fixture-session', cwd: '/fixture/project', model_provider: 'private-provider' }),
    event('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }),
    event('event_msg', { type: 'user_message', message: '请检查工具记录' }),
    event('event_msg', { type: 'agent_message', message: '我来读取文件。' }),
    event('response_item', { type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'output_text', text: '准备调用工具' }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_REASONING' }] }] }),
    event('response_item', { type: 'function_call', name: 'Read', arguments: '{"file_path":"/fixture/demo.txt"}', call_id: 'call-1' }),
    event('response_item', { type: 'function_call_output', call_id: 'call-1', output: '文件内容结果' }),
    event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '检查完成。' }] }),
  ]
  await withRollout(lines, async (file, size) => {
    const page = await readCodexSessionContent(file, size)
    assert.equal(page.total, 6)
    assert.deepEqual(page.messages.map(message => message.role), ['user', 'assistant', 'assistant', 'assistant', 'assistant', 'assistant'])
    assert.equal(page.messages[0].blocks[0].text, '请检查工具记录')
    assert.equal(page.messages[3].blocks[0].type, 'tool_use')
    assert.equal(page.messages[3].blocks[0].name, 'Read')
    assert.equal(page.messages[4].blocks[0].type, 'tool_result')
    assert.equal(page.messages[4].blocks[0].text, '文件内容结果')
    assert.equal(page.messages[2].model, 'fixture-model')
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_REASONING|private-provider|token_count/)
    assert.equal((await file.stat()).size, size, 'parser keeps the caller-owned handle open')
  })
})

test('Codex content pages messages and searches message/tool text without exposing metadata', async () => {
  const lines = [
    event('session_meta', { id: 'fixture-session' }),
    event('event_msg', { type: 'user_message', message: 'alpha first' }),
    event('event_msg', { type: 'agent_message', message: 'beta reply' }),
    event('response_item', { type: 'function_call', name: 'Search', arguments: '{"query":"gamma needle"}' }),
    event('response_item', { type: 'function_call_output', output: 'delta output' }),
  ]
  await withRollout(lines, async (file, size) => {
    const second = await readCodexSessionContent(file, size, { page: 2, pageSize: 2 })
    assert.equal(second.total, 4)
    assert.deepEqual(second.messages.map(message => message.blocks[0].text), ['{"query":"gamma needle"}', 'delta output'])
    assert.deepEqual(second.messages.map(message => message.index), [2, 3])
    const found = await readCodexSessionContent(file, size, { page: 1, pageSize: 5, query: 'needle' })
    assert.equal(found.total, 1)
    assert.equal(found.messages[0].blocks[0].name, 'Search')
  })
})

test('Codex transcript bounds long message/page text and returns truncation warnings', async () => {
  const large = '界'.repeat(80_000)
  const lines = [event('event_msg', { type: 'user_message', message: large }), event('event_msg', { type: 'agent_message', message: 'second' })]
  await withRollout(lines, async (file, size) => {
    const page = await readCodexSessionContent(file, size, { pageSize: 2 })
    const chars = page.messages.reduce((sum, message) => sum + message.blocks.reduce((total, block) => total + block.text.length, 0), 0)
    assert.ok(page.messages[0].blocks[0].text.length <= 24_000)
    assert.ok(chars <= 256_000)
    assert.equal(page.messages[0].truncated, true)
    assert.ok(page.warnings.some(warning => warning.includes('截断')))
    const truncatedSearch = await readCodexSessionContent(file, size, { query: 'needle-at-end' })
    assert.equal(truncatedSearch.total, 0)
    assert.ok(truncatedSearch.warnings.some(warning => warning.includes('搜索不包含')))
  })
})

test('Codex transcript checks cancellation during streaming and never closes the caller handle', async () => {
  await withRollout([event('event_msg', { type: 'user_message', message: 'body' })], async (file, size) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(readCodexSessionContent(file, size, {}, controller.signal), { name: 'AbortError' })
    assert.equal((await file.stat()).size, size)
  })
})
