import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCompleteClaudeSubscription } from '../src/renderer/src/claudeSubscriptionFlow'

test('Claude subscription completion uses OAuth run identity, not stable account identity', () => {
  const accountId = 'claude-account-1'
  assert.equal(shouldCompleteClaudeSubscription({ id: 'run-2', status: 'success', accountId }, 'run-1'), true)
  assert.equal(shouldCompleteClaudeSubscription({ id: 'run-1', status: 'success', accountId }, 'run-1'), false)
  assert.equal(shouldCompleteClaudeSubscription({ id: 'run-2', status: 'waiting', accountId }, 'run-1'), false)
  assert.equal(shouldCompleteClaudeSubscription({ id: 'run-2', status: 'success' }, 'run-1'), false)
})
