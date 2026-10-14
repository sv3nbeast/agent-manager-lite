import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, symlinkSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface CodexSharedSkillsOptions {
  directory: string
  sourceDirectory?: string
  managerDirectory?: string
}
export interface CodexSharedSkillsResult {
  sourceDirectory: string
  sourceMissing: boolean
  added: string[]
  existing: string[]
  conflicts: string[]
  skipped: { name: string; reason: string }[]
  notices: string[]
}

const maxEntries = 20_000
const maxDepth = 32
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const inside = (parent: string, child: string) => {
  const suffix = relative(parent, child)
  return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)
}
const overlaps = (left: string, right: string) => inside(left, right) || inside(right, left)
const sameIdentity = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
const maybeStat = (path: string): Stats | undefined => {
  try { return lstatSync(path) }
  catch (error) { if (absent(error)) return; throw error }
}
const absolutePath = (path: string) => {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path)) throw new Error('技能目录必须使用完整的绝对路径')
  return path
}

// Pin every destination ancestor as well as the opened home. A pre-existing
// skills link must never redirect mkdir/symlink into the user's shared source.
function destinationGuard(directory: string) {
  const paths: string[] = []
  for (let path = absolutePath(directory);; path = dirname(path)) {
    paths.unshift(path)
    if (dirname(path) === path) break
  }
  const marks = paths.map(path => {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('实例技能目录必须位于稳定的普通目录内，不能使用符号链接')
    return { path, stat }
  })
  if (realpathSync(directory) !== directory) throw new Error('实例技能目录路径已改变')
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const check = () => {
    for (const mark of marks) {
      const stat = lstatSync(mark.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(mark.stat, stat)) throw new Error('实例技能目录在准备期间已改变，现有技能已保留')
    }
    if (!sameIdentity(marks.at(-1)!.stat, fstatSync(descriptor)) || realpathSync(directory) !== directory) throw new Error('实例技能目录在准备期间已改变，现有技能已保留')
  }
  return { check, close: () => closeSync(descriptor) }
}

/**
 * Keep the instance's home and system skills private, while exposing the user's
 * legacy ~/.codex/skills through individual, stable source paths. No source file
 * is opened for its contents, and existing destination entries are never changed.
 * This is skill discovery, not a filesystem sandbox: shared skills remain editable
 * at their source, including after the client has started.
 */
export function prepareCodexSharedSkills(options: CodexSharedSkillsOptions): CodexSharedSkillsResult {
  const sourceDirectory = absolutePath(options.sourceDirectory ?? join(homedir(), '.codex', 'skills'))
  const result: CodexSharedSkillsResult = { sourceDirectory, sourceMissing: false, added: [], existing: [], conflicts: [], skipped: [], notices: [] }
  const guard = destinationGuard(options.directory)
  const skillsDirectory = join(options.directory, 'skills')
  let skillsStat: Stats | undefined
  const checkDestination = () => {
    guard.check()
    const current = maybeStat(skillsDirectory)
    if (current && (!current.isDirectory() || current.isSymbolicLink() || realpathSync(skillsDirectory) !== skillsDirectory) || skillsStat && (!current || !sameIdentity(skillsStat, current))) throw new Error('实例 skills 目录已改变或使用了符号链接，现有技能已保留')
    if (current) skillsStat = current
  }
  try {
    checkDestination()
    const sourceStat = maybeStat(sourceDirectory)
    if (!sourceStat) { result.sourceMissing = true; return result }
    let sourceRoot: string
    try { sourceRoot = realpathSync(sourceDirectory) }
    catch { throw new Error('共享技能目录无法读取或存在循环链接，现有技能已保留') }
    if (!lstatSync(sourceRoot).isDirectory()) throw new Error('共享技能来源不是普通目录，现有技能已保留')
    const forbidden = [options.directory]
    if (options.managerDirectory) forbidden.push(absolutePath(options.managerDirectory), realpathSync(options.managerDirectory))
    const checkSourcePath = (path: string) => {
      if (forbidden.some(root => overlaps(root, path))) throw new Error('来源指向实例或管理器数据目录')
      if (path.split(sep).some(part => part.toLowerCase() === '.system')) throw new Error('来源指向客户端系统技能')
      if (inside(sourceRoot, path) && relative(sourceRoot, path).split(sep).some(part => part.startsWith('.'))) throw new Error('来源指向隐藏技能目录')
    }
    checkSourcePath(sourceDirectory); checkSourcePath(sourceRoot)
    const rootStat = lstatSync(sourceRoot)
    const checkSourceRoot = () => {
      if (!sameIdentity(sourceStat, lstatSync(sourceDirectory)) || realpathSync(sourceDirectory) !== sourceRoot || !sameIdentity(rootStat, lstatSync(sourceRoot))) throw new Error('共享技能来源目录在准备期间已改变')
    }
    let entries = 0
    // Metadata-only traversal supports group directories and ordinary user
    // symlinks. Bound the walk and refuse cycles or aliases into private data.
    const inspect = (path: string, parents: ReadonlySet<string>, depth: number): boolean => {
      if (++entries > maxEntries || depth > maxDepth) throw new Error('共享技能目录超过安全扫描范围')
      const canonical = realpathSync(path)
      checkSourcePath(canonical)
      const stat = lstatSync(canonical)
      if (stat.isFile()) return path.split(sep).at(-1) === 'SKILL.md'
      if (!stat.isDirectory()) throw new Error('来源包含不支持的文件类型')
      if (parents.has(canonical)) throw new Error('来源包含循环目录链接')
      const next = new Set(parents); next.add(canonical)
      let found = false
      for (const name of readdirSync(path).sort()) {
        if (name.startsWith('.')) continue
        found = inspect(join(path, name), next, depth + 1) || found
      }
      if (realpathSync(path) !== canonical || !sameIdentity(stat, lstatSync(canonical))) throw new Error('来源技能目录在准备期间已改变')
      return found
    }
    const names = readdirSync(sourceDirectory).sort()
    if (names.length > maxEntries) throw new Error('共享技能目录超过安全扫描范围')
    for (const name of names) {
      if (name.startsWith('.')) { result.skipped.push({ name, reason: '隐藏目录由客户端自行管理' }); continue }
      const source = join(sourceDirectory, name), destination = join(skillsDirectory, name)
      let sourceEntry: Stats, canonical: string
      try {
        if (/[\0\r\n]/.test(name)) throw new Error('技能目录名包含不支持的字符')
        sourceEntry = lstatSync(source); canonical = realpathSync(source)
        checkSourcePath(canonical)
        if (!lstatSync(canonical).isDirectory()) { result.skipped.push({ name, reason: '来源不是技能目录' }); continue }
        if (!inspect(source, new Set([sourceRoot]), 0)) { result.skipped.push({ name, reason: '目录中没有 SKILL.md' }); continue }
        checkSourceRoot()
        if (!sameIdentity(sourceEntry, lstatSync(source)) || realpathSync(source) !== canonical) throw new Error('来源技能目录在准备期间已改变')
      } catch (error) {
        const reason = error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : '来源无法安全读取，可能已移动或存在循环链接'
        result.skipped.push({ name, reason }); continue
      }
      checkDestination()
      if (!skillsStat) {
        try { mkdirSync(skillsDirectory, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        checkDestination()
      }
      const recordExisting = () => {
        const current = maybeStat(destination)
        if (!current) return false
        if (current.isSymbolicLink() && readlinkSync(destination) === source) result.existing.push(name)
        else result.conflicts.push(name)
        return true
      }
      if (recordExisting()) continue
      checkSourceRoot(); checkDestination()
      try { symlinkSync(source, destination, 'dir') }
      catch (error) {
        checkDestination()
        // symlink creates exclusively. A concurrent user entry wins without
        // being replaced, including a dangling symbolic link.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && recordExisting()) continue
        result.skipped.push({ name, reason: '无法创建共享技能入口，请检查目录权限' }); continue
      }
      checkDestination()
      result.added.push(name)
    }
    const unavailable = result.skipped.filter(item => !['隐藏目录由客户端自行管理', '来源不是技能目录', '目录中没有 SKILL.md'].includes(item.reason))
    if (result.conflicts.length) result.notices.push(`${result.conflicts.length} 个共享技能目录与实例同名，已保留实例中的目录或文件`)
    if (unavailable.length) result.notices.push(`${unavailable.length} 个共享技能目录无法安全继承，原文件已保留`)
    return result
  } finally { guard.close() }
}
