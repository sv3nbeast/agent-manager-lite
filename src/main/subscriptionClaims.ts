import type { StoredAccount } from './store'
import { nonempty, object } from './network'

type SubscriptionCredentials = Pick<StoredAccount['credentials'], 'accountId' | 'idToken' | 'accessToken'>
export interface TokenSubscriptionSnapshot { accountId: string; activeUntil: number; plan?: string; observedAt?: number }

function subscriptionTimestamp(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined
  if (numeric !== undefined) {
    const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 8_640_000_000_000_000 ? milliseconds : undefined
  }
  if (typeof value !== 'string') return
  const text = value.trim()
  // A subscription date must be an absolute time, never a locale-dependent date.
  const date = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!date) return
  const year = Number(date[1]), month = Number(date[2]), day = Number(date[3])
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return
  const milliseconds = Date.parse(text)
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined
}

/** Read only the subscription claim belonging to the account's bound workspace.
 * Token exp is login expiry and must never become a subscription expiry.
 */
export function subscriptionFromToken(credentials: SubscriptionCredentials): TokenSubscriptionSnapshot | undefined {
  const accountId = nonempty(credentials.accountId)
  if (!accountId) return
  for (const token of [credentials.idToken, credentials.accessToken]) {
    let payload: Record<string, unknown>
    try { payload = object(JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString())) }
    catch { continue }
    const auth = object(payload['https://api.openai.com/auth'])
    const chatgptId = nonempty(auth.chatgpt_account_id), legacyId = nonempty(auth.account_id)
    const claimedId = chatgptId ?? legacyId
    if (claimedId !== accountId) continue
    // Conflicting identity fields cannot establish the workspace of the date.
    if (chatgptId && legacyId && chatgptId !== legacyId) continue
    const activeUntil = subscriptionTimestamp(auth.chatgpt_subscription_active_until)
    if (activeUntil !== undefined) {
      const observedAt = typeof payload.iat === 'number' && Number.isSafeInteger(payload.iat * 1000) && payload.iat > 0 ? payload.iat * 1000 : undefined
      return { accountId, activeUntil, plan: nonempty(auth.chatgpt_plan_type), ...(observedAt !== undefined ? { observedAt } : {}) }
    }
  }
}

/** Fill an unknown expiry, or replace a known expiry only with a newly issued
 * ID Token observed after the last successful subscription query.
 */
export function projectSubscriptionClaim(account: StoredAccount, update: { previousIDToken?: string; returnedIDToken?: string } = {}): boolean {
  if (account.kind !== 'oauth') return false
  const snapshot = subscriptionFromToken(account.credentials)
  if (!snapshot) return false
  if (account.subscriptionActiveUntil === undefined) {
    account.subscriptionActiveUntil = snapshot.activeUntil
    account.subscriptionSource = 'token'
    return true
  }
  const now = Date.now()
  const isWeb = account.subscriptionSource === 'web'
    || account.subscriptionSource === undefined && account.subscriptionQueryLastSuccessAt !== undefined
  // The web endpoint can include a different paid-access boundary than a JWT.
  // A new login iat does not prove that its entitlement is newer than that date.
  if (isWeb && account.subscriptionActiveUntil > now) return false
  if (account.subscriptionActiveUntil <= now && snapshot.activeUntil > now) {
    account.subscriptionActiveUntil = snapshot.activeUntil
    account.subscriptionSource = 'token'
    return true
  }
  if (!update.returnedIDToken || update.returnedIDToken === update.previousIDToken
    || update.returnedIDToken !== account.credentials.idToken) return false
  // A fresh access token may accompany a reused ID Token; only the newly
  // returned ID Token can establish a newer subscription observation here.
  const idSnapshot = subscriptionFromToken({ accountId: account.credentials.accountId, idToken: update.returnedIDToken })
  if (!idSnapshot?.observedAt || idSnapshot.observedAt <= (account.subscriptionQueryLastSuccessAt ?? 0)
    || account.subscriptionActiveUntil === idSnapshot.activeUntil) return false
  account.subscriptionActiveUntil = idSnapshot.activeUntil
  account.subscriptionSource = 'token'
  return true
}
