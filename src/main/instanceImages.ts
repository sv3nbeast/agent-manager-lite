import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import type { InstanceProfile } from '../shared/instances'
import { imageGenerationModelSchema } from '../shared/imageGeneration'
import { atomic, directory, readBounded } from './clientConfig'
import type { Store } from './store'
import { patchToml, TomlDocument } from './tomlPatch'

// Preserve the server/tool identity used by existing chats and approvals.
const serverPath = ['mcp_servers', 'sub2api_images']
const owner = 'agent-manager-lite-images-v1'
const legacyScriptHash = 'a4796fe364d933a96fd4286d5ee57a6504f9e7a4d0fbe46e112f1043cf8f53e9'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type ImageConfig = Record<string, unknown> & { model?: string; manager?: string; instance_id?: string; connection?: string }
export interface InstanceImagesServices {
  prepare(profile: InstanceProfile, connection?: {port: number; key: string}): void
  stop(profile: InstanceProfile): void
  notice(id: string): string | undefined
}

export class InstanceImages implements InstanceImagesServices {
  private readonly root: string
  private readonly messages = new Map<string, string>()
  constructor(private readonly store: Store, private readonly sourceBinary: string) { this.root = realpathSync(store.directory) }
  notice(id: string): string | undefined { return this.messages.get(id) }
  private eligible(profile: InstanceProfile): boolean { return !profile.externalHome && (profile.clientType === undefined || profile.clientType === 'codex') }
  private home(profile: InstanceProfile): string {
    // Only registered, manager-owned homes. Neither external profiles nor
    // symlinked ancestors are eligible for credential/config projection.
    if (!this.store.read().instances?.some(value => value.id === profile.id)) throw new Error('实例未登记')
    let path = this.root
    for (const part of ['instances', profile.id, 'home']) { path = join(path, part); directory(path); if (realpathSync(path) !== path) throw new Error('实例路径已变化') }
    return path
  }
  private binaryPath(): string { return join(this.root, 'tools', 'images-mcp', process.platform === 'win32' ? 'images-mcp.exe' : 'images-mcp') }
  private installBinary(): void {
    const target = this.binaryPath()
    directory(join(this.root, 'tools'), true); directory(dirname(target), true)
    const source = lstatSync(this.sourceBinary)
    if (!source.isFile() || source.isSymbolicLink() || source.size > 32 * 1024 * 1024) throw new Error('图片插件程序未正确打包')
    const data = readFileSync(this.sourceBinary)
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32 * 1024 * 1024) throw new Error('图片插件程序路径不安全')
      if (digest(readFileSync(target)) === digest(data)) return
    }
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700)
      writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, target); chmodSync(target, 0o700)
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, {force: true}) }
  }
  private shim(): string {
    // Old clients may cache the Python command until MCP reconnects. This
    // bridge keeps that command working without requiring a full client exit.
    return `# Agent Manager Lite Images API compatibility launcher\nimport argparse, os\np = argparse.ArgumentParser()\np.add_argument('--config', required=True)\na = p.parse_args()\nb = ${JSON.stringify(this.binaryPath())}\nos.execv(b, [b, '--config', a.config])\n`
  }
  private config(path: string): {raw: string; data: ImageConfig} | undefined {
    const raw = readBounded(path, 64 * 1024)
    if (raw === null) return undefined
    const stat = lstatSync(path)
    if ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('图片配置权限应为当前用户的 0600')
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('图片配置格式无效')
    return {raw, data: data as ImageConfig}
  }
  private inspect(profile: InstanceProfile) {
    const home = this.home(profile), tomlPath = join(home, 'config.toml')
    const source = readBounded(tomlPath, 1024 * 1024) ?? '', doc = new TomlDocument(source)
    const folder = join(home, 'tools', 'sub2api-images'), configPath = join(folder, 'config.json'), script = join(folder, 'codex_images_mcp.py')
    const registered = doc.children(['mcp_servers']).includes('sub2api_images')
    let args: unknown
    const rawArgs = doc.raw([...serverPath, 'args'])
    if (rawArgs) args = (getStaticTOMLValue(parseTOML(`args = ${rawArgs}\n`)) as Record<string, unknown>).args
    const command = doc.scalar([...serverPath, 'command'])
    const managedCommand = command === this.binaryPath() && JSON.stringify(args) === JSON.stringify(['--config', configPath])
    const pythonCommand = (command === '/usr/bin/python3' || typeof command === 'string' && /(?:^|\/)python3(?:\.\d+)?$/.test(command)) && JSON.stringify(args) === JSON.stringify([script, '--config', configPath])
    if (registered && !managedCommand && !pythonCommand) return {home, tomlPath, source, folder, configPath, script, custom: true as const}
    for (const path of [join(home, 'tools'), folder]) if (existsSync(path)) directory(path)
    const config = this.config(configPath)
    if (registered && !config) throw new Error('已登记的图片插件缺少连接配置')
    const scriptText = pythonCommand ? readBounded(script, 256 * 1024) : null
    const legacy = pythonCommand && scriptText !== null && (digest(scriptText) === legacyScriptHash || scriptText === this.shim())
    if (registered && (!legacy && !(managedCommand && config?.data.manager === owner)) || !registered && config) return {home, tomlPath, source, folder, configPath, script, custom: true as const}
    return {home, tomlPath, source, folder, configPath, script, custom: false as const, registered, legacy, scriptText, config}
  }
  private apply(profile: InstanceProfile, connection?: {port: number; key: string}, create = false): void {
    const info = this.inspect(profile)
    if (info.custom) { this.messages.set(profile.id, '已保留自定义图片 MCP；管理器未覆盖其模型或连接，请在该插件中单独配置'); return }
    if (!info.registered && !create) return
    const model = imageGenerationModelSchema.parse(this.store.read().settings.imageGenerationModel)
    let data: ImageConfig = {...info.config?.data, model}
    if (!info.registered || data.connection === 'instance_gateway') {
      data = {...data, manager: owner, instance_id: profile.id, connection: 'instance_gateway', output_dir: join(info.home, 'generated_images', 'images-api'), http_timeout_seconds: 180, tool_timeout_seconds: 240}
      if (connection) data = {...data, base_url: `http://127.0.0.1:${connection.port}/v1`, api_key: connection.key, active: true}
      else if (create || data.instance_id !== info.config?.data.instance_id) data = {...data, base_url: '', api_key: '', active: false}
    } else data = {...data, manager: owner, instance_id: profile.id, connection: 'legacy_external'}
    this.installBinary()
    directory(join(info.home, 'tools'), true); directory(info.folder, true)
    if (readBounded(info.configPath, 64 * 1024) !== (info.config?.raw ?? null) || (readBounded(info.tomlPath, 1024 * 1024) ?? '') !== info.source) throw new Error('图片配置已由其他程序修改，请重试')
    atomic(info.configPath, JSON.stringify(data, null, 2) + '\n')
    if (info.legacy && info.scriptText !== this.shim()) {
      if (readBounded(info.script, 256 * 1024) !== info.scriptText) throw new Error('图片脚本已由其他程序修改，未覆盖')
      atomic(info.script, this.shim())
    }
    const edits = [{path: [...serverPath, 'command'], raw: JSON.stringify(this.binaryPath())}, {path: [...serverPath, 'args'], raw: JSON.stringify(['--config', info.configPath])}]
    // Keep enabled/disabled and approval settings chosen by the user.
    if (!info.registered) edits.push({path:[...serverPath,'enabled'],raw:'true'}, {path:[...serverPath,'startup_timeout_sec'],raw:'10'}, {path:[...serverPath,'tool_timeout_sec'],raw:'240'})
    const next = patchToml(info.source, edits)
    if (next !== info.source) atomic(info.tomlPath, next)
    this.messages.delete(profile.id)
  }
  sync(): number {
    let failures = 0
    for (const profile of this.store.read().instances ?? []) {
      if (!this.eligible(profile)) continue
      try { this.apply(profile) }
      catch { failures++; this.messages.set(profile.id, '图片模型同步失败；原连接已保留，请检查该实例图片配置的权限后重新保存设置') }
    }
    return failures
  }
  prepare(profile: InstanceProfile, connection?: {port: number; key: string}): void {
    if (!this.eligible(profile)) return
    try { if (!connection) this.stop(profile); this.apply(profile, connection, !!connection) }
    catch { this.messages.set(profile.id, '图片插件未能接入，文本对话可继续；请检查图片配置权限或重新安装管理器') }
  }
  stop(profile: InstanceProfile): void {
    if (!this.eligible(profile)) return
    try {
      const info = this.inspect(profile)
      if (!info.custom && info.config?.data.manager === owner && info.config.data.connection === 'instance_gateway' && info.config.data.instance_id === profile.id) atomic(info.configPath, JSON.stringify({...info.config.data, active:false, api_key:'', base_url:''}, null, 2) + '\n')
    } catch { this.messages.set(profile.id, '图片网关已停止，但插件连接配置未能清理，请检查目录权限') }
  }
}

/** Full profile copies may copy settings, but never the source plugin's live
 * gateway key, external provider key or writable output/config references. */
export function relocateCopiedImagesPlugin(source: string, sourceHome: string, stagedHome: string, finalHome: string): string {
  const doc = new TomlDocument(source), raw = doc.raw([...serverPath, 'args'])
  if (!raw) return source
  const args = (getStaticTOMLValue(parseTOML(`args = ${raw}\n`)) as Record<string, unknown>).args
  const suffix = join('tools','sub2api-images','config.json')
  if (JSON.stringify(args) !== JSON.stringify(['--config', join(sourceHome, suffix)])) return source
  const path = join(stagedHome, suffix), config = readBounded(path, 64 * 1024)
  if (!config) return source
  const data = JSON.parse(config)
  if (data.manager !== owner) return source
  const binary = doc.scalar([...serverPath, 'command'])
  if (typeof binary !== 'string' || !binary.endsWith('/tools/images-mcp/images-mcp')) return source
  atomic(path, JSON.stringify({...data, instance_id:'', connection:'instance_gateway', active:false, api_key:'', base_url:'', output_dir:join(finalHome,'generated_images','images-api')},null,2)+'\n')
  return patchToml(source,[{path:[...serverPath,'args'],raw:JSON.stringify(['--config',join(finalHome,suffix)])}])
}
