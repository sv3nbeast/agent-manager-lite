import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
interface DirectoryIdentity { path: string; device: number; inode: number; owner: number; mode: number }
interface LinkIdentity { path: string; device: number; inode: number; target: string }
export interface ClaudeDesktopKeychainIdentity {
  home: DirectoryIdentity
  source: DirectoryIdentity
  library: DirectoryIdentity | null
  link: LinkIdentity | null
}

/** Test seams stay in the main process; renderer input never supplies these. */
export interface ClaudeDesktopKeychainOptions {
  platform?: NodeJS.Platform
  systemHome?: string
  userId?: number
  /** Returns only the default keychain's filesystem path, never an item value. */
  defaultKeychain?: (home: string) => Promise<string>
}

function directory(path: string, owner: number, optional = false): DirectoryIdentity | null {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path)) throw new Error('Claude Desktop 钥匙串目录必须是规范化的绝对路径')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || realpathSync(path) !== path) throw new Error('Claude Desktop 钥匙串目录必须归属当前用户，且不能使用替换目录或符号链接')
    // Directory timestamps change during ordinary Keychain use. Ownership and
    // filesystem identity are the stable boundaries needed by launch previews.
    return { path, device: stat.dev, inode: stat.ino, owner: stat.uid, mode: stat.mode }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Inspect only directory/link metadata. No login data or Keychain items are read. */
export function inspectClaudeDesktopKeychain(home: string, options: ClaudeDesktopKeychainOptions = {}): ClaudeDesktopKeychainIdentity {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Claude Desktop 钥匙串兼容当前仅支持 macOS')
  const user = userInfo(), owner = options.userId ?? user.uid, systemHome = options.systemHome ?? user.homedir
  const source = directory(join(systemHome, 'Library', 'Keychains'), owner)!
  const managedHome = directory(home, owner)!
  if (home === systemHome) throw new Error('Claude Desktop 必须使用独立的受管 HOME')
  const libraryPath = join(home, 'Library'), linkPath = join(libraryPath, 'Keychains')
  const library = directory(libraryPath, owner, true)
  if (!library) return { home: managedHome, source, library: null, link: null }
  let link: LinkIdentity | null = null
  try {
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink() || stat.uid !== owner) throw new Error('Claude Desktop 的 Keychains 位置已被占用，现有内容已保留')
    const target = readlinkSync(linkPath)
    if (resolve(dirname(linkPath), target) !== source.path || realpathSync(linkPath) !== source.path) throw new Error('Claude Desktop 的 Keychains 链接指向其他位置，现有链接已保留')
    link = { path: linkPath, device: stat.dev, inode: stat.ino, target }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling link is still an existing link and must not be overwritten.
    try { lstatSync(linkPath); throw new Error('Claude Desktop 的 Keychains 链接已失效，现有链接已保留') }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
  }
  return { home: managedHome, source, library, link }
}

async function readDefaultKeychain(home: string): Promise<string> {
  const { stdout } = await exec('/usr/bin/security', ['default-keychain', '-d', 'user'], {
    env: { PATH: '/usr/bin:/bin', HOME: home, CFFIXED_USER_HOME: home },
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
  })
  const lines = stdout.trim().split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw new Error('Default keychain metadata was unavailable')
  const path = lines[0].replace(/^"(.*)"$/, '$1')
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('Default keychain path was invalid')
  return path
}

/**
 * An isolated HOME hides ~/Library/Keychains from Apple's Security framework.
 * Share only its existing OS service directory. Cookies, OAuth ciphertext and
 * client configuration remain inside the individual Desktop profile.
 */
export async function prepareClaudeDesktopKeychain(home: string, options: ClaudeDesktopKeychainOptions = {}): Promise<ClaudeDesktopKeychainIdentity> {
  const before = inspectClaudeDesktopKeychain(home, options)
  const libraryPath = join(home, 'Library'), linkPath = join(libraryPath, 'Keychains')
  if (!before.library) {
    try { mkdirSync(libraryPath, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const ready = inspectClaudeDesktopKeychain(home, options)
  if (!ready.link) {
    try { symlinkSync(ready.source.path, linkPath, 'dir') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const prepared = inspectClaudeDesktopKeychain(home, options)
  if (!prepared.link || prepared.source.device !== before.source.device || prepared.source.inode !== before.source.inode
    || prepared.home.device !== before.home.device || prepared.home.inode !== before.home.inode) throw new Error('Claude Desktop 钥匙串目录在准备期间发生变化，请重试')
  const systemHome = options.systemHome ?? userInfo().homedir, probe = options.defaultKeychain ?? readDefaultKeychain
  try {
    // No -s, find-password, unlock or create command is used. Compare actual
    // paths so machines with a custom default keychain are handled honestly.
    const [systemDefault, instanceDefault] = await Promise.all([probe(systemHome), probe(home)])
    if (realpathSync(systemDefault) !== realpathSync(instanceDefault)) throw new Error('Default keychain mismatch')
  } catch {
    throw new Error('Claude Desktop 无法访问当前系统默认钥匙串，已阻止启动以避免重复弹窗；请检查系统钥匙串状态')
  }
  const after = inspectClaudeDesktopKeychain(home, options)
  if (JSON.stringify(after) !== JSON.stringify(prepared)) throw new Error('Claude Desktop 钥匙串目录在检查期间发生变化，请重试')
  return after
}
