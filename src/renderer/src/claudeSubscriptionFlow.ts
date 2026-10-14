import type { ClaudeSubscriptionLoginStatus } from '../../shared/types'

/**
 * A Claude account ID is stable across relogins. Completion therefore has to
 * be keyed by the OAuth run ID, otherwise a successful relogin of the same
 * account leaves the dialog open.
 */
export function shouldCompleteClaudeSubscription(
  status: { id?: ClaudeSubscriptionLoginStatus['id']; status?: ClaudeSubscriptionLoginStatus['status']; accountId?: ClaudeSubscriptionLoginStatus['accountId'] } | undefined,
  previousRunId: string | undefined,
): boolean {
  return status?.status === 'success'
    && !!status.accountId
    && !!status.id
    && status.id !== previousRunId
}
