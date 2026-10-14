import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareCodexSharedSkills } from '../src/main/codexSkills'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-codex-skills-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceDirectory = join(root, 'user', '.codex', 'skills')
  const managerDirectory = join(root, 'manager')
  const directory = join(managerDirectory, 'instances', 'fixture', 'home')
  mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(directory, { recursive: true })
  const options = { directory, sourceDirectory, managerDirectory }
  const skill = (name: string, base = sourceDirectory, text = 'synthetic skill') => {
    const path = join(base, name); mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), text)
    return path
  }
  return { root, sourceDirectory, managerDirectory, directory, options, skill, target: join(directory, 'skills') }
}

test('new and existing Codex homes receive individual skills, preserving the source and private system directory', t => {
  const f = fixture(t), source = f.skill('release')
  const sourceText = readFileSync(join(source, 'SKILL.md'), 'utf8'), sourceBefore = lstatSync(join(source, 'SKILL.md'))
  f.skill('.system'); f.skill('.hidden')
  f.skill('.system', f.target, 'private system skill')
  const systemBefore = lstatSync(join(f.target, '.system', 'SKILL.md'))
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, ['release']); assert.deepEqual(result.notices, [])
  assert.deepEqual(result.skipped.map(item => item.name), ['.hidden', '.system'])
  assert.equal(lstatSync(f.target).isSymbolicLink(), false)
  assert.equal(readlinkSync(join(f.target, 'release')), source)
  assert.equal(readFileSync(join(f.target, '.system', 'SKILL.md'), 'utf8'), 'private system skill')
  assert.equal(lstatSync(join(f.target, '.system', 'SKILL.md')).ino, systemBefore.ino)
  assert.equal(existsSync(join(f.target, '.hidden')), false)
  assert.deepEqual(readdirSync(f.sourceDirectory), ['.hidden', '.system', 'release'])
  assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), sourceText)
  const sourceAfter = lstatSync(join(source, 'SKILL.md'))
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'] as const) assert.equal(sourceAfter[key], sourceBefore[key])
})

test('preparation is idempotent and adds newly installed skills on a later start', t => {
  const f = fixture(t); f.skill('first')
  assert.deepEqual(prepareCodexSharedSkills(f.options).added, ['first'])
  assert.equal(lstatSync(f.target).mode & 0o777, 0o700)
  const before = lstatSync(join(f.target, 'first'))
  f.skill('second')
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, ['second']); assert.deepEqual(result.existing, ['first'])
  const after = lstatSync(join(f.target, 'first'))
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs)
  assert.deepEqual(prepareCodexSharedSkills(f.options).added, [])
})

test('same directory names, files and dangling links are kept without reading or overwriting their contents', t => {
  const f = fixture(t)
  for (const name of ['directory', 'file', 'dangling', 'other-link']) f.skill(name)
  f.skill('directory', f.target, 'instance override')
  writeFileSync(join(f.target, 'file'), 'local file')
  symlinkSync(join(f.root, 'missing'), join(f.target, 'dangling'))
  const other = f.skill('elsewhere', f.root)
  symlinkSync(other, join(f.target, 'other-link'))
  const names = ['dangling', 'directory', 'file', 'other-link']
  const before = names.map(name => lstatSync(join(f.target, name)))
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, []); assert.deepEqual(result.conflicts, names)
  assert.match(result.notices.join(' '), /4.*同名/)
  assert.equal(readFileSync(join(f.target, 'directory', 'SKILL.md'), 'utf8'), 'instance override')
  assert.equal(readFileSync(join(f.target, 'file'), 'utf8'), 'local file')
  assert.equal(readlinkSync(join(f.target, 'dangling')), join(f.root, 'missing'))
  assert.equal(readlinkSync(join(f.target, 'other-link')), other)
  names.forEach((name, i) => assert.equal(lstatSync(join(f.target, name)).ino, before[i].ino))
})

test('a missing default source has no side effects and inherited CODEX_HOME is never used as the skill source', t => {
  const f = fixture(t), userHome = join(f.root, 'user')
  t.mock.method(os, 'homedir', () => userHome)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(f.root, 'another-instance')
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })
  f.skill('wrong-instance', join(process.env.CODEX_HOME, 'skills'))
  rmSync(f.sourceDirectory, { recursive: true })
  const options = { directory: f.directory, managerDirectory: f.managerDirectory }
  const missing = prepareCodexSharedSkills(options)
  assert.equal(missing.sourceMissing, true); assert.equal(missing.sourceDirectory, f.sourceDirectory)
  assert.deepEqual(missing.added, []); assert.deepEqual(readdirSync(f.directory), [])
  f.skill('correct-user')
  assert.deepEqual(prepareCodexSharedSkills(options).added, ['correct-user'])
  assert.equal(existsSync(join(f.target, 'wrong-instance')), false)
})

test('stable source links follow skill and source-root upgrades without replacing instance entries', t => {
  const f = fixture(t), v1 = f.skill('tool', join(f.root, 'versions', 'v1'), 'version one')
  const v2 = f.skill('tool', join(f.root, 'versions', 'v2'), 'version two')
  const source = join(f.sourceDirectory, 'tool'); symlinkSync(v1, source)
  assert.deepEqual(prepareCodexSharedSkills(f.options).added, ['tool'])
  const destination = join(f.target, 'tool'), before = lstatSync(destination)
  assert.equal(readlinkSync(destination), source)
  rmSync(source); symlinkSync(v2, source)
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'version two')
  assert.deepEqual(prepareCodexSharedSkills(f.options).existing, ['tool'])
  assert.equal(lstatSync(destination).ino, before.ino)
  const moved = join(f.root, 'moved-skills'); renameSync(f.sourceDirectory, moved); symlinkSync(moved, f.sourceDirectory)
  f.skill('after-root-upgrade', moved)
  const upgraded = prepareCodexSharedSkills(f.options)
  assert.deepEqual(upgraded.added, ['after-root-upgrade']); assert.deepEqual(upgraded.existing, ['tool'])
  assert.equal(readlinkSync(destination), source)
})

test('visible groups and normal user source links remain discoverable with all skill resources', t => {
  const f = fixture(t)
  f.skill('group/nested/tool')
  writeFileSync(join(f.sourceDirectory, 'group', 'nested', 'tool', 'resource.txt'), 'resource fixture')
  const outside = f.skill('external-user-skill', join(f.root, 'shared'))
  symlinkSync(outside, join(f.sourceDirectory, 'alias'))
  f.skill('mixed/tool')
  symlinkSync(outside, join(f.sourceDirectory, 'mixed', 'external'))
  mkdirSync(join(f.sourceDirectory, 'empty')); writeFileSync(join(f.sourceDirectory, 'README.md'), 'not a skill directory')
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, ['alias', 'group', 'mixed'])
  assert.deepEqual(result.skipped.map(item => item.name), ['README.md', 'empty'])
  assert.equal(readFileSync(join(f.target, 'group', 'nested', 'tool', 'resource.txt'), 'utf8'), 'resource fixture')
  assert.equal(realpathSync(join(f.target, 'mixed', 'external')), outside)
})

test('visible aliases cannot import hidden or system skills, including aliases outside the source tree', t => {
  const f = fixture(t)
  const hidden = f.skill('.hidden/tool'), system = f.skill('.system/tool'), outside = f.skill('tool', join(f.root, 'other', '.system'))
  symlinkSync(hidden, join(f.sourceDirectory, 'hidden-alias')); symlinkSync(system, join(f.sourceDirectory, 'system-alias'))
  symlinkSync(outside, join(f.sourceDirectory, 'external-system'))
  f.skill('mixed/tool'); symlinkSync(system, join(f.sourceDirectory, 'mixed', 'visible-system'))
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, [])
  assert.match(result.notices.join(' '), /4.*无法安全继承/)
  assert.equal(existsSync(f.target), false)
})

test('cycles, dangling source links and aliases into instance or manager data are skipped visibly', t => {
  const f = fixture(t); f.skill('safe')
  symlinkSync(f.sourceDirectory, join(f.sourceDirectory, 'root-cycle'))
  symlinkSync('self-cycle', join(f.sourceDirectory, 'self-cycle'))
  symlinkSync(join(f.root, 'not-installed'), join(f.sourceDirectory, 'dangling'))
  symlinkSync(f.directory, join(f.sourceDirectory, 'instance-alias'))
  const privateDirectory = join(f.managerDirectory, 'private-fixture'); mkdirSync(privateDirectory)
  writeFileSync(join(privateDirectory, 'do-not-read.txt'), 'synthetic private fixture')
  symlinkSync(privateDirectory, join(f.sourceDirectory, 'manager-alias'))
  f.skill('nested-cycle/tool'); symlinkSync(join(f.sourceDirectory, 'nested-cycle'), join(f.sourceDirectory, 'nested-cycle', 'back'))
  f.skill('nested-private/tool'); symlinkSync(privateDirectory, join(f.sourceDirectory, 'nested-private', 'alias'))
  const result = prepareCodexSharedSkills(f.options)
  assert.deepEqual(result.added, ['safe']); assert.equal(result.skipped.length, 7)
  assert.match(result.notices.join(' '), /7.*无法安全继承/)
  assert.deepEqual(readdirSync(f.target), ['safe'])
  assert.deepEqual(readdirSync(privateDirectory), ['do-not-read.txt'])
})

test('a source root cannot alias the instance, its ancestor, or manager data', t => {
  const f = fixture(t)
  for (const sourceDirectory of [f.directory, f.managerDirectory, f.root]) {
    assert.throws(() => prepareCodexSharedSkills({ ...f.options, sourceDirectory }), /实例或管理器数据目录/)
  }
  const alias = join(f.root, 'source-alias'); symlinkSync(f.managerDirectory, alias)
  assert.throws(() => prepareCodexSharedSkills({ ...f.options, sourceDirectory: alias }), /实例或管理器数据目录/)
  assert.equal(existsSync(f.target), false)
})

test('target home, ancestor and skills symlinks are rejected without following them', t => {
  const f = fixture(t); f.skill('safe')
  const alias = join(f.root, 'home-alias'); symlinkSync(f.directory, alias)
  assert.throws(() => prepareCodexSharedSkills({ ...f.options, directory: alias }), /普通目录|符号链接/)
  const managerAlias = join(f.root, 'manager-alias'); symlinkSync(f.managerDirectory, managerAlias)
  assert.throws(() => prepareCodexSharedSkills({ ...f.options, directory: join(managerAlias, 'instances', 'fixture', 'home') }), /普通目录|符号链接/)
  symlinkSync(f.sourceDirectory, f.target)
  assert.throws(() => prepareCodexSharedSkills(f.options), /skills.*符号链接/)
  assert.deepEqual(readdirSync(f.sourceDirectory), ['safe']); rmSync(f.target)
  symlinkSync(join(f.root, 'missing'), f.target)
  assert.throws(() => prepareCodexSharedSkills(f.options), /skills.*符号链接/)
  assert.equal(readlinkSync(f.target), join(f.root, 'missing'))
})

test('destination ancestor replacement during source inspection is detected before creating any entry', t => {
  const f = fixture(t), source = f.skill('safe'), oldHome = join(f.root, 'old-home')
  const originalRead = fs.readdirSync
  let replaced = false
  const mock = t.mock.method(fs, 'readdirSync', ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    const result = originalRead(path, options as never)
    if (String(path) === source && !replaced) { replaced = true; renameSync(f.directory, oldHome); mkdirSync(f.directory) }
    return result
  }) as typeof fs.readdirSync)
  assert.throws(() => prepareCodexSharedSkills(f.options), /实例技能目录.*已改变/)
  mock.mock.restore()
  assert.equal(replaced, true); assert.deepEqual(readdirSync(f.directory), []); assert.deepEqual(readdirSync(oldHome), [])
})

test('replacing a destination ancestor is rejected even when the original home inode is retained', t => {
  const f = fixture(t), source = f.skill('safe'), parent = dirname(f.directory), displaced = join(f.root, 'displaced-instance')
  const homeBefore = lstatSync(f.directory), originalRead = fs.readdirSync
  let replaced = false
  const mock = t.mock.method(fs, 'readdirSync', ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    const result = originalRead(path, options as never)
    if (String(path) === source && !replaced) {
      replaced = true; renameSync(parent, displaced); mkdirSync(parent); renameSync(join(displaced, 'home'), f.directory)
    }
    return result
  }) as typeof fs.readdirSync)
  assert.throws(() => prepareCodexSharedSkills(f.options), /实例技能目录.*已改变/)
  mock.mock.restore()
  assert.equal(replaced, true); assert.equal(lstatSync(f.directory).ino, homeBefore.ino)
  assert.deepEqual(readdirSync(f.directory), []); assert.deepEqual(readdirSync(displaced), [])
})

test('replacing skills with a source link during inspection cannot cause a write to the source', t => {
  const f = fixture(t), source = f.skill('safe'), displaced = join(f.root, 'displaced-skills')
  f.skill('.system', f.target, 'keep instance system skill')
  const originalRead = fs.readdirSync
  let replaced = false
  const mock = t.mock.method(fs, 'readdirSync', ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    const result = originalRead(path, options as never)
    if (String(path) === source && !replaced) { replaced = true; renameSync(f.target, displaced); symlinkSync(f.sourceDirectory, f.target) }
    return result
  }) as typeof fs.readdirSync)
  assert.throws(() => prepareCodexSharedSkills(f.options), /skills.*已改变|skills.*符号链接/)
  mock.mock.restore()
  assert.equal(replaced, true); assert.deepEqual(readdirSync(f.sourceDirectory), ['safe'])
  assert.equal(readFileSync(join(displaced, '.system', 'SKILL.md'), 'utf8'), 'keep instance system skill')
  assert.equal(lstatSync(source).isSymbolicLink(), false)
})

test('source replacement during inspection is skipped instead of publishing a stale or private alias', t => {
  const f = fixture(t), source = f.skill('replaced'), oldSource = join(f.root, 'old-source')
  const originalRead = fs.readdirSync
  let replaced = false
  const mock = t.mock.method(fs, 'readdirSync', ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    const result = originalRead(path, options as never)
    if (String(path) === source && !replaced) { replaced = true; renameSync(source, oldSource); symlinkSync(f.directory, source) }
    return result
  }) as typeof fs.readdirSync)
  const result = prepareCodexSharedSkills(f.options)
  mock.mock.restore()
  assert.equal(replaced, true); assert.deepEqual(result.added, []); assert.equal(result.skipped.length, 1)
  assert.match(result.notices.join(' '), /无法安全继承/); assert.equal(existsSync(f.target), false)
})

test('exclusive link creation preserves an entry that appears after destination inspection', t => {
  const f = fixture(t); f.skill('raced')
  const originalLink = fs.symlinkSync
  let inserted = false
  const mock = t.mock.method(fs, 'symlinkSync', ((target: Parameters<typeof fs.symlinkSync>[0], path: Parameters<typeof fs.symlinkSync>[1], type?: Parameters<typeof fs.symlinkSync>[2]) => {
    if (String(path) === join(f.target, 'raced') && !inserted) { inserted = true; writeFileSync(path, 'user arrived first') }
    return originalLink(target, path, type)
  }) as typeof fs.symlinkSync)
  const result = prepareCodexSharedSkills(f.options)
  mock.mock.restore()
  assert.equal(inserted, true); assert.deepEqual(result.added, []); assert.deepEqual(result.conflicts, ['raced'])
  assert.equal(readFileSync(join(f.target, 'raced'), 'utf8'), 'user arrived first')
})

test('unreadable skill entries are reported without reading source contents or blocking other user skills', t => {
  const f = fixture(t); f.skill('unreadable'); f.skill('usable')
  const originalRead = fs.readdirSync
  const mock = t.mock.method(fs, 'readdirSync', ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    if (String(path) === join(f.sourceDirectory, 'unreadable')) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' })
    return originalRead(path, options as never)
  }) as typeof fs.readdirSync)
  const result = prepareCodexSharedSkills(f.options)
  mock.mock.restore()
  assert.deepEqual(result.added, ['usable']); assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].name, 'unreadable'); assert.match(result.notices.join(' '), /1.*无法安全继承/)
})
