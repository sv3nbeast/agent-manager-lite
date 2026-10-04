import { randomUUID } from 'node:crypto'
import { open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { accountIdsSchema, type StagedImport } from '../shared/types'
import { parseAccountImport, importParsedAccounts } from './accounts'
import { Store, type StoredAccount } from './store'
import { providerTierForAccount } from './providerLibrary'

const MAX_BYTES = 16 * 1024 * 1024

export function serializeAccounts(accounts: StoredAccount[]): string {
  return JSON.stringify(accounts.map(account => ({
    auth_mode: account.kind === 'api_key' ? 'apikey' : account.kind === 'agent_identity' ? 'agentIdentity' : 'oauth',
    account_name: account.name, account_note: account.note, tags: account.tags,
    email: account.email, plan_type: account.plan, defaultTier: account.defaultTier,
    api_base_url: account.baseUrl, api_wire_api: account.wireApi, models: account.models,
    ...(account.kind === 'api_key' ? { integrationType: account.integrationType } : {}),
    ...(account.kind === 'agent_identity' ? { agent_identity: account.credentials.agentIdentity } : account.kind === 'api_key' ? { openai_api_key: account.credentials.apiKey } : {
      tokens: { access_token: account.credentials.accessToken, refresh_token: account.credentials.refreshToken,
        id_token: account.credentials.idToken, account_id: account.credentials.accountId }
    })
  })), null, 2) + '\n'
}

export async function writeAccountExport(directory:string,accounts:StoredAccount[],path:string,signal?:AbortSignal):Promise<number>{
  signal?.throwIfAborted()
  const content=serializeAccounts(accounts)
  if(Buffer.byteLength(content)>MAX_BYTES)throw new Error('导出超过 16 MB，请分批选择账号以便后续重新导入')
  const destination=join(await realpath(dirname(resolve(path))),basename(path)),location=relative(await realpath(directory),destination)
  if(!location||location!=='..'&&!location.startsWith(`..${sep}`)&&!isAbsolute(location))throw new Error('请将导出文件保存在应用数据目录以外')
  const temporary=`${destination}.${randomUUID()}.tmp`
  try{
    const file=await open(temporary,'wx',0o600)
    try{await file.writeFile(content);await file.sync()}finally{await file.close()}
    signal?.throwIfAborted();await rename(temporary,destination);return accounts.length
  }finally{await rm(temporary,{force:true})}
}

// Paths come only from native dialogs in the main process. Renderer gets a
// short-lived opaque ticket and display metadata, never file credentials.
export class AccountFiles {
  private pending?: { result: ReturnType<typeof parseAccountImport>; ticket: string; expires: number }
  private generation = 0
  private fileSelection?:{id:string;generation:number}
  private expiryTimer?: NodeJS.Timeout
  private readonly exports = new Set<Promise<number>>()
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}
  discard(ticket?:string): void {
    if(ticket!==undefined && this.pending?.ticket!==ticket)return
    this.generation++; this.fileSelection=undefined; this.pending = undefined; clearTimeout(this.expiryTimer)
  }
  stage(raw: string, fileName?: string): StagedImport {
    this.discard()
    const result = parseAccountImport(raw)
    const ticket = randomUUID()
    this.pending = { result, ticket, expires: this.now() + 10 * 60_000 }
    this.expiryTimer = setTimeout(() => this.discard(), 10 * 60_000)
    this.expiryTimer.unref()
    return { ticket, preview: structuredClone(result.preview), fileName }
  }
  beginFileSelection(id:string=randomUUID()):number {this.discard();this.fileSelection={id,generation:this.generation};return this.generation}
  cancelFileSelection(id:string):void {if(this.fileSelection?.id===id&&this.fileSelection.generation===this.generation)this.discard()}
  async finishFileSelection(operation:number,path:string):Promise<StagedImport>{
    if(operation!==this.generation)throw new Error('导入选择已取消或被新预览替换')
    return this.stageFile(path)
  }
  async stageFile(path: string): Promise<StagedImport> {
    this.discard()
    const generation = this.generation
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('请选择不超过 16 MB 的普通账号文件')
      // Bound reads even if another process grows the selected file after stat.
      const chunks: Buffer[] = []
      let size = 0
      while (size <= MAX_BYTES) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - size))
        const { bytesRead } = await file.read(buffer)
        if (!bytesRead) break
        chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead
      }
      if (size > MAX_BYTES) throw new Error('导入文件超过 16 MB')
      if (generation !== this.generation) throw new Error('导入操作已取消或被新预览替换')
      return this.stage(Buffer.concat(chunks).toString('utf8'), basename(path))
    } finally { await file.close() }
  }
  commit(ticket: string): { added: number; duplicates: number; skipped: number; accountIds:string[] } {
    const staged = this.pending
    if (!staged || staged.ticket !== ticket || this.now() >= staged.expires) throw new Error('导入预览已过期，请重新预览')
    if (staged.result.preview.errors.length) throw new Error('请先修正所有导入错误')
    if (!staged.result.accounts.length) throw new Error('没有可导入的 Codex 账号')
    const accountIds=new Set<string>()
    const result = importParsedAccounts(this.store, staged.result.accounts,id=>accountIds.add(id))
    this.discard()
    return { ...result, skipped: staged.result.preview.skipped ?? 0, accountIds:[...accountIds] }
  }
  export(ids: string[], path: string): Promise<number> {
    const task = this.writeExport(ids, path)
    this.exports.add(task)
    void task.then(() => this.exports.delete(task), () => this.exports.delete(task))
    return task
  }
  async stop(): Promise<void> { this.discard(); await Promise.allSettled([...this.exports]) }
  private async writeExport(ids: string[], path: string): Promise<number> {
    const wanted = new Set(accountIdsSchema.parse(ids))
    const state = this.store.read()
    const accounts = state.accounts.filter(a => wanted.has(a.id))
    if (accounts.length !== wanted.size) throw new Error('部分账号已删除，请重新选择')
    // Account exports are standalone. Preserve the provider default when the
    // receiving workspace has no corresponding provider library or association.
    for (const account of accounts) {
      if (account.providerId && account.defaultTier === 'inherit') account.defaultTier = providerTierForAccount(state, account) ?? 'inherit'
    }
    return writeAccountExport(this.store.directory,accounts,path)
  }
}
