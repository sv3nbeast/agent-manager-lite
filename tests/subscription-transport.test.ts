import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHTTPServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { createServer as createTCPServer, connect, type Server, type Socket } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { fetchSubscriptionWeb, isChatGPTSubscriptionURL } from '../src/main/subscriptionTransport'

type Hooks = { after(fn: () => void | Promise<void>): void }
async function listen(t: Hooks, server: Server | HTTPServer) {
  const sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  return { port: address.port, sockets }
}
async function until(check: () => boolean) {
  const limit = Date.now() + 3000
  while (!check()) { assert.ok(Date.now() < limit, 'loopback condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function target(t: Hooks, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createHTTPServer(handler), fixture = await listen(t, server)
  return { ...fixture, server, url: `http://127.0.0.1:${fixture.port}` }
}
async function httpProxy(t: Hooks, targetPort: number, reject = false, tls?: { key: Buffer; cert: Buffer }) {
  const seen: { destination: string | undefined; authorization: string | undefined }[] = []
  const handler = (_request: IncomingMessage, response: ServerResponse) => response.writeHead(502).end()
  const server = tls ? createHTTPSServer(tls, handler) : createHTTPServer(handler)
  const outbound = new Set<Socket>()
  t.after(() => { for (const socket of outbound) socket.destroy() })
  server.on('connect', (request, socket, head) => {
    seen.push({ destination: request.url, authorization: request.headers['proxy-authorization'] })
    if (reject) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length:0\r\n\r\n'); return }
    const upstream = connect(targetPort, '127.0.0.1')
    outbound.add(upstream); upstream.once('close', () => outbound.delete(upstream))
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket) })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy())
  })
  const fixture = await listen(t, server)
  return { ...fixture, seen, url: `${tls ? 'https' : 'http'}://fixture%3Auser:p%40%3Ass%2F@127.0.0.1:${fixture.port}/` }
}
async function socksProxy(t: Hooks, targetPort: number, stall = false) {
  const seen: { username?: string; password?: string; hostname?: string; port?: number; type?: number }[] = []
  const outbound = new Set<Socket>()
  t.after(() => { for (const socket of outbound) socket.destroy() })
  const server = createTCPServer(socket => {
    const entry: typeof seen[number] = {}; seen.push(entry)
    let buffer = Buffer.alloc(0), stage = 0
    socket.on('error', () => {})
    const parse = () => {
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        assert.equal(buffer[0], 5); assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(2))
        buffer = buffer.subarray(2 + buffer[1]); stage = 1
        if (stall) return
        socket.write(Buffer.from([5, 2]))
      }
      if (stage === 1) {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
        const userLength = buffer[1], passwordLength = buffer[2 + userLength], size = 3 + userLength + passwordLength
        if (buffer.length < size) return
        assert.equal(buffer[0], 1)
        entry.username = buffer.subarray(2, 2 + userLength).toString()
        entry.password = buffer.subarray(3 + userLength, size).toString()
        buffer = buffer.subarray(size); stage = 2; socket.write(Buffer.from([1, 0]))
      }
      if (stage === 2) {
        if (buffer.length < 5) return
        assert.equal(buffer[0], 5); assert.equal(buffer[1], 1)
        entry.type = buffer[3]; assert.equal(entry.type, 3, 'DNS resolution must happen at the selected SOCKS proxy')
        const size = 7 + buffer[4]
        if (buffer.length < size) return
        entry.hostname = buffer.subarray(5, size - 2).toString(); entry.port = buffer.readUInt16BE(size - 2)
        const remainder = buffer.subarray(size); stage = 3; socket.removeListener('data', receive)
        const upstream = connect(targetPort, '127.0.0.1')
        outbound.add(upstream); upstream.once('close', () => outbound.delete(upstream))
        upstream.once('connect', () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (remainder.length) upstream.write(remainder); socket.pipe(upstream).pipe(socket) })
        upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy())
      }
    }
    const receive = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); parse() }
    socket.on('data', receive)
  })
  const fixture = await listen(t, server)
  return { ...fixture, seen, url: `socks5://fixture%3Auser:p%40%3Ass%2F@127.0.0.1:${fixture.port}/` }
}

test('subscription transport routing matches only the two exact HTTPS ChatGPT endpoints', () => {
  for (const path of ['/backend-api/accounts/check/v4-2023-04-27', '/backend-api/subscriptions']) {
    for (const authority of ['chatgpt.com', 'chatgpt.com:443']) assert.equal(isChatGPTSubscriptionURL(`https://${authority}${path}?account_id=fixture`), true)
    for (const raw of [`http://chatgpt.com${path}`, `https://chatgpt.com:444${path}`, `https://api.chatgpt.com${path}`, `https://chatgpt.com.invalid${path}`,
      `https://fixture:secret@chatgpt.com${path}`, `https://@chatgpt.com${path}`, `https://chatgpt.com${path}#`, `https://chatgpt.com${path}#fragment`,
      `https://chatgpt.com${path}/`, `https://chatgpt.com${path}%2F`, `https://chatgpt.com/backend-api/../${path.slice(1)}`,
      ` https://chatgpt.com${path}`, `https://chatgpt.\ncom${path}`, `https://chatgpt.com\\${path.slice(1)}`]) assert.equal(isChatGPTSubscriptionURL(raw), false, raw)
  }
  assert.equal(isChatGPTSubscriptionURL('https://chatgpt.com/backend-api/wham/usage'), false)
  assert.equal(isChatGPTSubscriptionURL('invalid'), false)
})

test('explicit direct dispatcher ignores the global dispatcher and returns only safe response headers', async t => {
  const fixture = await target(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-target-secret')
    response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'set-cookie': 'fixture-cookie-secret', 'x-secret': 'fixture-header-secret' }).end('<html>fixture</html>')
  })
  const previous = getGlobalDispatcher(), blocked = new MockAgent(); blocked.disableNetConnect()
  setGlobalDispatcher(blocked)
  try {
    const response = await fetchSubscriptionWeb(fixture.url, { headers: { Authorization: 'Bearer fixture-target-secret' } }, 'direct')
    assert.equal(response.status, 403); assert.equal(await response.text(), '<html>fixture</html>')
    assert.deepEqual([...response.headers], [['cf-mitigated', 'challenge'], ['content-type', 'text/html']])
    await until(() => fixture.sockets.size === 0)
  } finally { setGlobalDispatcher(previous); await blocked.close() }
})

test('authenticated HTTP CONNECT preserves the chosen exit and decoded credentials without leaking proxy auth', async t => {
  let hits = 0
  const fixture = await target(t, (request, response) => {
    hits++; assert.equal(request.headers.authorization, 'Bearer fixture-target-secret'); assert.equal(request.headers['proxy-authorization'], undefined)
    response.setHeader('content-type', 'application/json'); response.end('{"ok":true}')
  })
  const proxy = await httpProxy(t, fixture.port)
  const response = await fetchSubscriptionWeb(`http://subscription-upstream.invalid:${fixture.port}/subscription`, { headers: { Authorization: 'Bearer fixture-target-secret' } }, proxy.url)
  assert.deepEqual(await response.json(), { ok: true }); assert.equal(hits, 1)
  assert.deepEqual(proxy.seen, [{ destination: `subscription-upstream.invalid:${fixture.port}`, authorization: 'Basic ' + Buffer.from('fixture:user:p@:ss/').toString('base64') }])
  await until(() => proxy.sockets.size === 0)
})

test('HTTP CONNECT retains explicit authentication when the password is empty', async t => {
  const fixture = await target(t, (_request, response) => response.end('{}'))
  const proxy = await httpProxy(t, fixture.port)
  const parsed = new URL(proxy.url); parsed.password = ''
  await fetchSubscriptionWeb(fixture.url, {}, parsed.toString())
  assert.equal(proxy.seen[0].authorization, 'Basic ' + Buffer.from('fixture:user:').toString('base64'))
})

test('SOCKS5 and SOCKS5H authenticate decoded URL credentials and send the hostname to the proxy', async t => {
  let hits = 0
  const fixture = await target(t, (_request, response) => { hits++; response.end('{"ok":true}') })
  const proxy = await socksProxy(t, fixture.port)
  for (const protocol of ['socks5:', 'socks5h:']) {
    const response = await fetchSubscriptionWeb(`http://subscription-upstream.invalid:${fixture.port}/subscription`, {}, proxy.url.replace('socks5:', protocol))
    assert.deepEqual(await response.json(), { ok: true })
  }
  assert.equal(hits, 2)
  assert.deepEqual(proxy.seen, Array.from({ length: 2 }, () => ({ username: 'fixture:user', password: 'p@:ss/', hostname: 'subscription-upstream.invalid', port: fixture.port, type: 3 })))
  await until(() => proxy.sockets.size === 0)
})

test('proxy refusal never retries directly and never exposes proxy credentials', async t => {
  let hits = 0
  const fixture = await target(t, (_request, response) => { hits++; response.end('{}') })
  const proxy = await httpProxy(t, fixture.port, true)
  await assert.rejects(fetchSubscriptionWeb(fixture.url, {}, proxy.url), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /网络请求失败/)
    assert.equal(String(error).includes('p%40'), false); assert.equal(String(error).includes('fixture:user'), false); return true
  })
  assert.equal(hits, 0); assert.equal(proxy.seen.length, 1)
})

test('redirects fail without sending credentials to the destination, and overflowing responses stop at 2 MiB', async t => {
  let followed = 0, overflowClosed = false
  const fixture = await target(t, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/destination' }).end(); return }
    if (request.url === '/destination') { followed++; response.end('{}'); return }
    if (request.url === '/limit') { response.end(Buffer.alloc(2 * 1024 * 1024, 'x')); return }
    const interval = setInterval(() => { response.write(Buffer.alloc(128 * 1024, 'x')) }, 1)
    response.once('close', () => { clearInterval(interval); overflowClosed = true })
  })
  await assert.rejects(fetchSubscriptionWeb(fixture.url + '/redirect', { headers: { Authorization: 'Bearer fixture-target-secret' } }, 'direct'), /网络请求失败/)
  assert.equal(followed, 0)
  const exact = await fetchSubscriptionWeb(fixture.url + '/limit', {}, 'direct'); assert.equal((await exact.arrayBuffer()).byteLength, 2 * 1024 * 1024)
  await assert.rejects(fetchSubscriptionWeb(fixture.url + '/overflow', {}, 'direct'), /超过大小限制/)
  await until(() => overflowClosed)
})

test('cancellation interrupts both response streaming and a stalled SOCKS handshake', async t => {
  let waiting = false, disconnected = false
  const fixture = await target(t, (_request, response) => { waiting = true; response.writeHead(200); response.write('{'); response.once('close', () => { disconnected = true }) })
  const controller = new AbortController(), request = fetchSubscriptionWeb(fixture.url, { signal: controller.signal }, 'direct')
  const rejection = assert.rejects(request, /操作已取消/)
  await until(() => waiting); controller.abort(); await rejection; await until(() => disconnected)
  const proxy = await socksProxy(t, fixture.port, true), handshake = new AbortController()
  const pending = assert.rejects(fetchSubscriptionWeb(`http://subscription-upstream.invalid:${fixture.port}`, { signal: handshake.signal }, proxy.url), /操作已取消/)
  await until(() => proxy.seen.length === 1); handshake.abort(); await pending; await until(() => proxy.sockets.size === 0)
})

test('Node TLS verifies certificates for direct, HTTPS CONNECT, HTTP CONNECT and SOCKS exits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aml-subscription-tls-')), keyPath = join(root, 'key.pem'), certPath = join(root, 'cert.pem'), config = join(root, 'openssl.cnf')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-config', config], { stdio: 'ignore', timeout: 10000 })
  const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  let hits = 0
  const server = createHTTPSServer(tls, (request, response) => { hits++; assert.equal(request.headers.authorization, 'Bearer fixture'); assert.equal(request.headers['proxy-authorization'], undefined); response.end('{"ok":true}') })
  const fixture = await listen(t, server), url = `https://localhost:${fixture.port}/subscription`
  // No TLS verification override: an untrusted loopback certificate is rejected.
  await assert.rejects(fetchSubscriptionWeb(url, {}, 'direct'), /网络请求失败/)
  assert.equal(hits, 0)
  const plain = await httpProxy(t, fixture.port), secure = await httpProxy(t, fixture.port, false, tls), socks = await socksProxy(t, fixture.port)
  const module = fileURLToPath(new URL('../src/main/subscriptionTransport.ts', import.meta.url))
  const source = `import { readFileSync } from 'node:fs'; import transport from ${JSON.stringify(module)};
    const { fetchSubscriptionWeb } = transport;
    const input = JSON.parse(readFileSync(0, 'utf8')); const values = [];
    for (const proxy of input.proxies) {
      const response = await fetchSubscriptionWeb(input.url, { headers: { authorization: 'Bearer fixture' } }, proxy);
      values.push(await response.json());
    }
    process.stdout.write(JSON.stringify(values));`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { child.kill() })
  const result = await new Promise<string>((resolve, reject) => {
    let output = '', error = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('TLS loopback child timed out')) }, 15000)
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(error)); else resolve(output) })
    child.stdin.end(JSON.stringify({ url, proxies: ['direct', plain.url, secure.url.replace('127.0.0.1', 'localhost'), socks.url] }))
  })
  assert.deepEqual(JSON.parse(result), Array.from({ length: 4 }, () => ({ ok: true })))
  assert.equal(hits, 4); assert.equal(plain.seen.length, 1); assert.equal(secure.seen.length, 1)
})
