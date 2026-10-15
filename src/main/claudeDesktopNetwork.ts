import { createHash, randomUUID } from 'node:crypto'
import * as nodeFS from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { parse } from 'acorn'
import { atomic, readBounded } from './clientConfig'
import { networkRouteEnvironment } from './desktopNetwork'
import type { DesktopPlan } from './instanceRuntime'

// Electron's patched fs presents an ASAR as a directory. Inspect the physical
// archive without extracting it or changing the installed application.
const physicalFS: typeof nodeFS = process.versions.electron
  ? createRequire(join(dirname(process.execPath), 'cml-runtime.cjs'))('original-fs') : nodeFS
const limit = 1024 * 1024
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const journalName = '.cml-claude-desktop-network.json'
type Document = Record<string, unknown>
const digest = (value: unknown) => createHash('sha256').update(value === undefined ? 'absent' : JSON.stringify(value)).digest('hex')
const ownValue = (object: Document, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined
const journalSchema = z.object({
  version: z.literal(1), entryId: z.string().regex(uuid), previousAppliedId: z.string().regex(uuid).nullable().optional(),
  metaExisted: z.boolean(), proxy: z.string(), baseline: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
}).strict()
type Journal = z.infer<typeof journalSchema>

function archiveFile(archive: string, entry: string, maximum: number): Buffer {
  const fd = physicalFS.openSync(archive, physicalFS.constants.O_RDONLY | physicalFS.constants.O_NOFOLLOW | physicalFS.constants.O_NONBLOCK)
  const read = (offset: number, length: number) => {
    const result = Buffer.alloc(length)
    let count = 0
    while (count < length) {
      const size = physicalFS.readSync(fd, result, count, length - count, offset + count)
      if (!size) throw new Error('archive truncated')
      count += size
    }
    return result
  }
  try {
    const stat = physicalFS.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || physicalFS.realpathSync(archive) !== archive || stat.size < 16) throw new Error('archive identity')
    const size = read(0, 8), headerSize = size.readUInt32LE(4)
    if (size.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 32 * 1024 * 1024 || 8 + headerSize > stat.size) throw new Error('archive header')
    const header = read(8, headerSize), jsonSize = header.readUInt32LE(4)
    if (header.readUInt32LE(0) !== headerSize - 4 || jsonSize > headerSize - 8) throw new Error('archive header')
    let item = JSON.parse(header.subarray(8, 8 + jsonSize).toString('utf8'))
    for (const part of entry.split('/')) {
      if (!part || part === '.' || part === '..' || !item?.files || !Object.hasOwn(item.files, part)) throw new Error('archive entry')
      item = item.files[part]
    }
    if (item?.link || item?.unpacked || item?.files || !Number.isSafeInteger(item?.size) || item.size < 0 || item.size > maximum || typeof item.offset !== 'string' || !/^\d+$/.test(item.offset)) throw new Error('archive entry')
    const offset = Number(item.offset) + 8 + headerSize
    if (!Number.isSafeInteger(offset) || offset + item.size > stat.size) throw new Error('archive bounds')
    return read(offset, item.size)
  } finally { physicalFS.closeSync(fd) }
}

type SyntaxNode = { type: string; [key: string]: any }
const literal = (node: SyntaxNode | undefined): unknown => node?.type === 'Literal' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
function member(node: SyntaxNode | undefined, name: string): SyntaxNode | undefined {
  if (node?.type !== 'ObjectExpression') return
  const matches = node.properties.filter((property: SyntaxNode) => property.type === 'Property' && !property.computed && (property.key.name ?? literal(property.key)) === name)
  return matches.length === 1 ? matches[0].value : undefined
}
function hasNativeProxySchema(source: string): boolean {
  const stack: SyntaxNode[] = [parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as SyntaxNode]
  while (stack.length) {
    const node = stack.pop()!
    if (literal(member(node, 'flatKey')) === 'egressProxyUrl') {
      const behavior = member(node, 'appBehaviorOnly'), scopes = member(member(member(node, 'support'), 'enabled'), 'scopes')
      const enabled = literal(behavior) === true || behavior?.type === 'UnaryExpression' && behavior.operator === '!' && literal(behavior.argument) === 0
      if (enabled && scopes?.type === 'ArrayExpression' && ['1p', '3p'].every(scope => scopes.elements.some((entry: SyntaxNode) => literal(entry) === scope))) return true
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && typeof value.type === 'string') stack.push(value)
      else if (Array.isArray(value)) for (const child of value) if (child && typeof child.type === 'string') stack.push(child)
    }
  }
  return false
}

/** Probe the native config contract, rather than matching an upstream version,
 * bundler directory, minifier name, property order or source formatting. */
export function assertClaudeDesktopNetworkCapability(application: string): void {
  try {
    const archive = join(application, 'Contents', 'Resources', 'app.asar')
    const pkg = JSON.parse(archiveFile(archive, 'package.json', 128 * 1024).toString('utf8'))
    if (pkg.name !== '@ant/desktop' || typeof pkg.main !== 'string' || pkg.main.length > 4096 || isAbsolute(pkg.main) || /^[a-z]:/i.test(pkg.main) || /[\\\0\r\n]/.test(pkg.main)) throw new Error('entry')
    const main = pkg.main.replace(/^\.\//, '')
    if (!main.split('/').every((part: string) => part && part !== '.' && part !== '..')) throw new Error('entry')
    const source = archiveFile(archive, main, 16 * 1024 * 1024).toString('utf8')
    if (!hasNativeProxySchema(source)
      || !['configLibrary', '_meta.json', 'appliedId', 'egressProxyPacUrl', 'proxy-server', 'proxy-pac-url', '-3p'].every(value => source.includes(value))) throw new Error('native proxy contract')
  } catch {
    throw new Error('当前 Claude Desktop 未提供已验证的实例代理配置，无法应用管理器网络设置；请更新客户端后重试')
  }
}

interface Scope {
  root: string; library: string; journal: string; meta: string
  check(): void
}

function scopeFor(plan: DesktopPlan, create: boolean): Scope | undefined {
  if (plan.clientType !== 'claude_code' || plan.mode !== 'desktop') throw new Error('此网络配置仅用于 Claude Desktop 实例')
  const root = dirname(plan.desktopDirectory)
  if (!isAbsolute(root) || resolve(root) !== root || plan.desktopDirectory !== join(root, 'desktop') || plan.directory !== join(root, 'home')) throw new Error('Claude Desktop 网络配置目录不属于当前实例')
  const identities: Array<{ path: string; device: number; inode: number }> = []
  const inspect = (path: string, optional = false): boolean => {
    try {
      const stat = nodeFS.lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || nodeFS.realpathSync(path) !== path) throw new Error('directory changed')
      identities.push({ path, device: stat.dev, inode: stat.ino })
      return true
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error('Claude Desktop 网络配置目录不安全，原文件已保留')
    }
  }
  for (const path of [root, plan.directory, plan.desktopDirectory]) inspect(path)
  const directory = `${plan.desktopDirectory}-3p`, library = join(directory, 'configLibrary')
  const journal = join(root, journalName)
  for (const path of [directory, library]) {
    if (inspect(path, true)) continue
    if (!create) {
      if (readBounded(journal, limit) !== null) throw new Error('Claude Desktop 网络配置恢复目录缺失，原记录已保留')
      return
    }
    nodeFS.mkdirSync(path, { mode: 0o700 }); inspect(path)
  }
  return { root, library, journal, meta: join(library, '_meta.json'), check() {
    for (const identity of identities) {
      const stat = nodeFS.lstatSync(identity.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || nodeFS.realpathSync(identity.path) !== identity.path || stat.dev !== identity.device || stat.ino !== identity.inode) throw new Error('Claude Desktop 网络配置目录已变化，请重试')
    }
  } }
}

function documentAt(scope: Scope, path: string): Document | undefined {
  scope.check()
  const raw = readBounded(path, limit)
  if (raw === null) return
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Claude Desktop 网络配置不是有效 JSON，原文件已保留') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Desktop 网络配置格式无效，原文件已保留')
  return value as Document
}

function writeDocument(scope: Scope, path: string, value: Document): void {
  scope.check(); readBounded(path, limit)
  const content = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(content) > limit) throw new Error('Claude Desktop 网络配置超过大小限制，原文件已保留')
  atomic(path, content)
}

function removeDocument(scope: Scope, path: string): void {
  scope.check()
  if (readBounded(path, limit) !== null) nodeFS.unlinkSync(path)
}

function appliedId(meta: Document | undefined): string | null | undefined {
  const id = meta?.appliedId
  if (id === null || id === undefined) return id
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Claude Desktop 当前配置标识无效，原文件已保留')
  return id
}

function entryAt(scope: Scope, id: string | null | undefined): Document {
  if (!id) return {}
  const value = documentAt(scope, join(scope.library, `${id}.json`))
  if (!value) throw new Error('Claude Desktop 当前配置文件缺失，原文件已保留')
  return value
}

/** Merge edits made in Desktop while the proxy was selected, without losing
 * edits to the original library entry or copying raw credentials into a journal. */
function restoreContents(managed: Document, original: Document, journal: Journal): Document {
  const result: Array<[string, unknown]> = []
  const keys = new Set([...Object.keys(journal.baseline), ...Object.keys(original), ...Object.keys(managed)])
  for (const key of keys) {
    const old = Object.hasOwn(journal.baseline, key) ? journal.baseline[key] : digest(undefined), source = ownValue(original, key)
    let current = ownValue(managed, key)
    if (key === 'egressProxyUrl' && current === journal.proxy || key === 'egressProxyPacUrl' && current === undefined) current = source
    const a = digest(source), b = digest(current)
    if (a !== b && a !== old && b !== old) throw new Error('Claude Desktop 原配置和当前配置均已修改，请先在客户端中确认配置；管理器已保留两份原文件')
    const value = b === old ? source : current
    if (value !== undefined) result.push([key, value])
  }
  return Object.fromEntries(result)
}

/** Recover a previously pinned loopback before reusing or releasing its entry.
 * The journal is written first and removed last, so retries survive interruption. */
function restoreNetwork(scope: Scope): string | undefined {
  const raw = documentAt(scope, scope.journal)
  if (!raw) return
  const parsed = journalSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Claude Desktop 网络恢复记录无效，原文件已保留')
  const journal = parsed.data
  networkRouteEnvironment({ mode: 'proxy', url: journal.proxy })
  if (journal.previousAppliedId === journal.entryId) throw new Error('Claude Desktop 网络恢复记录引用自身，原文件已保留')
  const meta = documentAt(scope, scope.meta), selected = appliedId(meta), path = join(scope.library, `${journal.entryId}.json`)
  const managed = documentAt(scope, path)
  if (!managed) {
    if (selected === journal.entryId) throw new Error('Claude Desktop 受管网络配置缺失，原记录已保留')
    removeDocument(scope, scope.journal); return journal.entryId
  }
  const original = entryAt(scope, journal.previousAppliedId), restored = restoreContents(managed, original, journal)
  // With no prior entry, settings added inside Desktop become its own native
  // entry after the proxy is removed. They must remain selected and readable.
  const keepEntry = !journal.previousAppliedId && Object.keys(restored).length > 0
  if (keepEntry) writeDocument(scope, path, restored)
  else if (journal.previousAppliedId && digest(restored) !== digest(original)) writeDocument(scope, join(scope.library, `${journal.previousAppliedId}.json`), restored)
  if (selected === journal.entryId && !keepEntry) {
    const next = { ...meta }
    if (journal.previousAppliedId === undefined) delete next.appliedId
    else next.appliedId = journal.previousAppliedId
    if (!journal.metaExisted && !Object.keys(next).length) removeDocument(scope, scope.meta)
    else writeDocument(scope, scope.meta, next)
  }
  if (!keepEntry) removeDocument(scope, path)
  removeDocument(scope, scope.journal)
  return keepEntry ? undefined : journal.entryId
}

/** Use Claude's native pre-ready egress pin. Never pass forbidden Chromium
 * network switches, project account credentials, or change the native mode. */
export function prepareClaudeDesktopNetwork(plan: DesktopPlan): void {
  const route = plan.networkRoute
  networkRouteEnvironment(route)
  if (route?.mode === 'direct') throw new Error('Claude Desktop 直连必须先准备本机网络通道')
  const scope = scopeFor(plan, route !== undefined)
  if (!scope) return
  const previousEntry = restoreNetwork(scope)
  if (route === undefined) return
  assertClaudeDesktopNetworkCapability(plan.application)
  const meta = documentAt(scope, scope.meta)
  if (meta?.hybridPointer !== undefined && meta.hybridPointer !== null) throw new Error('Claude Desktop 由组织或共享配置管理网络，请在客户端的原生配置中设置代理')
  const previousAppliedId = appliedId(meta), original = entryAt(scope, previousAppliedId)
  const entryId = previousEntry ?? randomUUID(), entry = join(scope.library, `${entryId}.json`)
  if (documentAt(scope, entry)) throw new Error('Claude Desktop 受管配置标识发生冲突，原文件已保留')
  const next: Document = { ...original, egressProxyUrl: route.url }
  delete next.egressProxyPacUrl
  const journal: Journal = { version: 1, entryId, previousAppliedId, metaExisted: meta !== undefined, proxy: route.url, baseline: Object.fromEntries(Object.entries(original).map(([key, value]) => [key, digest(value)])) }
  writeDocument(scope, scope.journal, journal)
  writeDocument(scope, entry, next)
  writeDocument(scope, scope.meta, { ...meta, appliedId: entryId })
}
