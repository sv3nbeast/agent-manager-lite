import type {StoredAccount} from './store'

/** A recorded OAuth exchange time, never a time inferred from an import. */
export function authRefreshTimestamp(value:unknown):string|undefined {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return
  const time=Date.parse(value)
  if(Number.isFinite(time)&&time>=0&&time<=Date.now())return new Date(time).toISOString()
}

export function importedAuthRefresh(source:Record<string,unknown>,credentials:Record<string,unknown>):string|undefined {
  const recorded=authRefreshTimestamp(credentials.lastRefresh)??authRefreshTimestamp(source.last_refresh)
  if(recorded)return recorded
  // Cockpit exports its successful token update time as Unix seconds.
  const updated=source.token_updated_at
  if(typeof updated==='number'&&Number.isSafeInteger(updated)&&updated>=0&&updated*1000<=Date.now())return new Date(updated*1000).toISOString()
}

export function nativeAuthRefresh(account:StoredAccount):string {
  const known=authRefreshTimestamp(account.credentials.lastRefresh)
  if(known)return known
  // Older vaults kept the imported file only in source. Do not reuse its
  // timestamp after a different access token has been adopted or refreshed.
  const source=account.source
  if(source){
    const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
    const nested=object(source.credentials),tokens=object(source.tokens)
    const access=tokens.access_token??nested.accessToken??nested.access_token??source.access_token??source.accessToken
    if(access===account.credentials.accessToken){const recorded=importedAuthRefresh(source,nested);if(recorded)return recorded}
  }
  // Codex requires last_refresh to expose ChatGPT token data. The access
  // token's issue time is conservative; an unknown time stays epoch-old so
  // the client's fallback refresh policy is never delayed by a fake "now".
  try{
    const issued=JSON.parse(Buffer.from(account.credentials.accessToken?.split('.')[1]??'','base64url').toString()).iat
    if(typeof issued==='number'&&Number.isSafeInteger(issued)&&issued>=0&&issued*1000<=Date.now())return new Date(issued*1000).toISOString()
  }catch{/* Opaque tokens have no issuance claim. */}
  return new Date(0).toISOString()
}
