import { parseTOML, ParseError, type AST } from 'toml-eslint-parser'

export type Scalar = string | number | boolean
export interface TomlEdit { path: string[]; raw: string | null }
interface Entry { path: string[]; node: AST.TOMLKeyValue }
interface Container { path: string[]; node: AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable }
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((part, i) => part === b[i])
const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((part, i) => part === b[i])
const key = (path: string[]) => path.map(part => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join('.')
const keys = (node: AST.TOMLKey) => node.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value)

// Keep the original source; the parser is used for ranges and validation, never
// to serialize a whole user document or expose unrelated values to the UI.
export class TomlDocument {
  private entries: Entry[] = []
  private containers: Container[] = []
  private opaque: {path:string[];raw:string}[] = []
  constructor(readonly source: string) {
    let ast: AST.TOMLProgram
    // toml-eslint-parser 1.0.3 gives a bare zero at EOF an empty range.
    // A parse-only newline supplies lookahead without changing source bytes or
    // offsets of real values; edits and backups still use the original source.
    try { ast = parseTOML(source.endsWith('\n') ? source : source + '\n', { tomlVersion: '1.0' }) }
    catch (error) {
      // Parser messages may contain the offending token, including a secret.
      if (error instanceof ParseError) throw new Error(`配置 TOML 格式错误（第 ${error.lineNumber} 行，第 ${error.column + 1} 列），原文件未修改`)
      throw new Error('配置 TOML 无法解析，原文件未修改')
    }
    const visit = (path: string[], node: Container['node']) => {
      this.containers.push({ path, node })
      for (const child of node.body) {
        if (child.type === 'TOMLTable') {
          if (child.kind === 'standard' && child.resolvedKey.every(part => typeof part === 'string')) visit(child.resolvedKey as string[], child)
          else this.opaque.push({path:child.resolvedKey.map(String),raw:this.source.slice(...child.range)})
          continue
        }
        const childPath = [...path, ...keys(child.key)]
        this.entries.push({ path: childPath, node: child })
        if (child.value.type === 'TOMLInlineTable') visit(childPath, child.value)
      }
    }
    visit([], ast.body[0])
  }
  raw(path: string[]): string | null {
    const entry = this.entries.find(entry => equal(entry.path, path))
    return entry ? this.source.slice(...entry.node.value.range) : null
  }
  scalar(path: string[]): Scalar | null {
    const value = this.entries.find(entry => equal(entry.path, path))?.node.value
    if (value?.type !== 'TOMLValue' || value.value instanceof Date || typeof value.value === 'number' && !Number.isFinite(value.value)) return null
    return value.value
  }
  children(path: string[]): string[] {
    return [...new Set([...this.entries, ...this.containers].filter(item => item.path.length > path.length && prefix(path, item.path)).map(item => item.path[path.length]))]
  }
  // Used only as a main-process conflict fingerprint, never returned to UI.
  subtree(path:string[]):string {
    return JSON.stringify([
      ...this.entries.filter(entry=>prefix(path,entry.path)).map(entry=>[entry.path,this.source.slice(...entry.node.value.range)]),
      ...this.containers.filter(entry=>prefix(path,entry.path)).map(entry=>[entry.path,'table']),
      ...this.opaque.filter(entry=>prefix(path,entry.path)).map(entry=>[entry.path,entry.raw])
    ].sort((a,b)=>JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))))
  }
  edit({ path, raw }: TomlEdit): string {
    if (!path.length || path.some(part => !part)) throw new Error('无效配置路径')
    if (raw !== null) {
      const parsed = new TomlDocument(`value = ${raw}`)
      if (parsed.raw(['value']) !== raw || parsed.children([]).length !== 1) throw new Error('无效配置值')
    }
    const replace = (start: number, end: number, replacement: string) => this.source.slice(0, start) + replacement + this.source.slice(end)
    const entry = this.entries.find(entry => equal(entry.path, path))
    let result: string
    if (entry) {
      if (raw !== null) result = replace(...entry.node.value.range, raw)
      else if (entry.node.parent.type === 'TOMLInlineTable') {
        const siblings = entry.node.parent.body, index = siblings.indexOf(entry.node)
        // Remove the adjacent comma as well, preserving all other value bytes.
        if (index < siblings.length - 1) result = replace(entry.node.range[0], siblings[index + 1].range[0], '')
        else if (index > 0) result = replace(siblings[index - 1].range[1], entry.node.range[1], '')
        else result = replace(...entry.node.range, '')
      } else result = replace(...entry.node.range, '')
    } else {
      if (raw === null) return this.source
      const container = this.containers.filter(item => prefix(item.path, path) && item.path.length < path.length).sort((a, b) => b.path.length - a.path.length)[0]
      const assignment = `${key(path.slice(container.path.length))} = ${raw}`
      if (container.node.type === 'TOMLInlineTable') {
        const insertion = container.node.range[1] - 1
        result = replace(insertion, insertion, `${container.node.body.length ? ', ' : ' '}${assignment} `)
      } else {
        const newline = this.source.includes('\r\n') ? '\r\n' : '\n'
        const start = container.node.type === 'TOMLTopLevelTable' ? 0 : container.node.key.range[1]
        // Insert into this table before the following table's header. A header
        // can share a line with its comment, so use the next newline, not ']'.
        const lineEnd = container.node.type === 'TOMLTopLevelTable' ? -1 : this.source.indexOf('\n', start)
        const insertion = container.node.type === 'TOMLTopLevelTable' ? 0 : lineEnd < 0 ? this.source.length : lineEnd + 1
        result = replace(insertion, insertion, `${insertion && this.source[insertion - 1] !== '\n' ? newline : ''}${assignment}${newline}`)
      }
    }
    new TomlDocument(result)
    return result
  }
}
export function patchToml(source: string, edits: TomlEdit[]): string {
  for (const edit of edits) source = new TomlDocument(source).edit(edit)
  return source
}
export function scalarRaw(value: Scalar | null): string | null { return value === null ? null : JSON.stringify(value) }
