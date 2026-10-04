// Native consumer coverage for the client settings UI's main-process paths.
// Uses an isolated home, synthetic credentials and a loopback SSE upstream.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute, join} from 'node:path'
import {Store} from '../src/main/store'
import {ClientConfigs} from '../src/main/clientConfig'
import {resolveCliRuntime} from '../src/main/cliResolver'
import {builtInCatalog} from '../src/main/modelCatalog'
import {TomlDocument} from '../src/main/tomlPatch'
import type {ClientConfigChanges} from '../src/shared/clientConfig'

async function main() {
  const selected = process.env.CML_TEST_CODEX_BINARY
  assert.ok(selected && isAbsolute(selected) && existsSync(selected), 'Set CML_TEST_CODEX_BINARY to a native Codex CLI binary or supported npm entry')
  const runtime = resolveCliRuntime(selected)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-config-consumer-')))
  const client = join(root, 'client'), workspace = join(root, 'workspace')
  mkdirSync(client); mkdirSync(workspace)
  const seen: Array<{path: string; authorization?: string; model: string; tier?: string; effort?: string; instructions?: string}> = []
  const children = new Set<ReturnType<typeof spawn>>()
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      seen.push({path: req.url, authorization: req.headers.authorization, model: body.model, tier: body.service_tier, effort: body.reasoning?.effort, instructions: body.instructions})
      const item = {id: 'msg_config_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'config-fixture-ok', annotations: []}]}
      const response = {id: 'resp_config_fixture', object: 'response', model: body.model, status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}
      const events = [
        {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
        {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', content: []}},
        {type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}},
        {type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'config-fixture-ok'},
        {type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'config-fixture-ok'},
        {type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0]},
        {type: 'response.output_item.done', output_index: 0, item},
        {type: 'response.completed', response}
      ]
      res.writeHead(200, {'Content-Type': 'text/event-stream'})
      res.end(events.map((event, sequence_number) => 'data: ' + JSON.stringify({...event, sequence_number}) + '\n\n').join(''))
    } catch { res.writeHead(500).end('fixture failure') }
  })
  const codec = {encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString()}
  let configs = new ClientConfigs(new Store(join(root, 'vault'), codec))
  const target = configs.register(client), file = join(client, 'config.toml')
  async function run(extra: string[] = []) {
    const count = seen.length
    const child = spawn(runtime.executable, ['exec', '--json', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', ...extra, 'Reply with config-fixture-ok. Do not use tools.'], {
      cwd: workspace,
      env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', CODEX_HOME: client},
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.add(child)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString().slice(0, Math.max(0, 20000 - output.length)) })
    child.stderr.on('data', chunk => { output += chunk.toString().slice(0, Math.max(0, 20000 - output.length)) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      assert.equal(code, 0, output)
      assert.ok(output.includes('config-fixture-ok'), output)
      assert.equal(seen.length, count + 1, 'Exactly one response request, without retry')
      return seen.at(-1)!
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); children.delete(child) }
  }
  function save(changes: ClientConfigChanges) {
    return configs.apply(configs.preview({id: target.id, revision: configs.view(target.id).revision, changes}).ticket)
  }
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address === 'object')
    writeFileSync(file, 'cli_auth_credentials_store="file"\nweb_search="disabled"\n# preserve this note\n[analytics]\nenabled=false\n')
    const providerId = 'fixture.provider'
    const provider = configs.previewProvider({id: target.id, revision: configs.providers(target.id).revision, providerId, create: true,
      changes: {name: 'Isolated config consumer', base_url: `http://127.0.0.1:${address.port}/first/v1`, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0},
      auth: {mode: 'token', token: 'fixture-config-first'}, makeDefault: true, serviceTier: 'fast'})
    assert.ok(!JSON.stringify(provider).includes('fixture-config-first'))
    configs.apply(provider.ticket)

    // A unique model and instruction marker prove the native consumer loads the
    // generated catalog, instead of silently using a built-in model fallback.
    const model = structuredClone(builtInCatalog.models.find(value => value.slug === 'gpt-5.5')!)
    const marker = 'CML_CONFIG_CATALOG_INSTRUCTION_MARKER'
    Object.assign(model, {slug: 'cml-config-fixture', display_name: 'Config fixture', description: 'Config fixture', base_instructions: marker})
    delete model.model_messages
    const importedFile = join(root, 'fixture-catalog.json')
    writeFileSync(importedFile, JSON.stringify({models: [model]}))
    const imported = configs.importCatalog(target.id, importedFile)
    const savedCatalog = configs.apply(configs.previewCatalog({id: target.id, revision: configs.catalogView(target.id).revision,
      enabled: true, importTicket: imported.ticket, models: imported.models.map(value => ({...value, reasoningEfforts: ['high'], contextWindow: 123456})), defaultModelId: model.slug}).ticket)
    const catalogBackup = savedCatalog.revisions[0].id
    configs = new ClientConfigs(new Store(join(root, 'vault'), codec))
    const first = await run()
    assert.equal(first.path, '/first/v1/responses'); assert.equal(first.authorization, 'Bearer fixture-config-first')
    assert.equal(first.model, model.slug); assert.equal(first.tier, 'priority'); assert.equal(first.effort, 'high')
    assert.ok(first.instructions?.includes(marker), 'Native consumer must use the generated catalog instructions')
    console.log('PASS: Provider + imported catalog + restart -> native model/reasoning/instructions and Fast=priority')

    for (const tier of ['default', 'flex', 'auto'] as const) {
      save({service_tier: tier})
      const request = await run()
      assert.notEqual(request.tier, 'priority', `${tier} must disable previous Fast`)
      console.log(`PASS: persisted ${tier} disables Fast; native outgoing tier=${request.tier ?? '(omitted)'}`)
    }
    save({service_tier: 'fast'})
    assert.notEqual((await run(['-c', 'service_tier="default"'])).tier, 'priority', 'Explicit native config override wins')
    const beforeChange = readFileSync(file, 'utf8')
    const edited = configs.apply(configs.previewProvider({id: target.id, revision: configs.providers(target.id).revision, providerId, create: false,
      changes: {base_url: `http://127.0.0.1:${address.port}/second/v1`}, auth: {mode: 'token', token: 'fixture-config-second'}, makeDefault: true, serviceTier: 'fast'}).ticket)
    const second = await run()
    assert.equal(second.path, '/second/v1/responses'); assert.equal(second.authorization, 'Bearer fixture-config-second'); assert.equal(second.tier, 'priority')
    configs.apply(configs.previewRestore({id: target.id, backup: edited.revisions[0].id}).ticket)
    assert.equal(readFileSync(file, 'utf8'), beforeChange)
    const restored = await run()
    assert.equal(restored.path, '/first/v1/responses'); assert.equal(restored.authorization, 'Bearer fixture-config-first'); assert.equal(restored.tier, 'priority')
    configs.apply(configs.previewRestore({id: target.id, backup: catalogBackup}).ticket)
    assert.equal(new TomlDocument(readFileSync(file, 'utf8')).raw(['model_catalog_json']), null)
    console.log('PASS: explicit Standard override, Provider endpoint/key edit and exact restore, catalog restore')
    console.log(JSON.stringify({requests: seen.length, binarySHA256: createHash('sha256').update(readFileSync(runtime.executable)).digest('hex'), loopbackOnly: true, systemKeychain: false}))
  } finally {
    for (const child of children) child.kill('SIGKILL')
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, {recursive: true, force: true})
  }
}

void main().catch(error => {console.error(error); process.exitCode = 1})
