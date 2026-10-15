import test from 'node:test'
import assert from 'node:assert/strict'
import { sendClaudeDesktopLoginUrl, validateClaudeDesktopLoginUrl } from '../src/main/claudeDesktopLogin'

test('Desktop callback accepts only native login routes and preserves opaque tokens', () => {
  for (const value of [
    'claude://login/google-auth?code=synthetic%2Bcode&hop_nonce=synthetic-nonce',
    'claude://claude.ai/magic-link#token=synthetic-token',
    'claude://claude.ai/sso-callback?code=synthetic-code&state=synthetic-state',
  ]) assert.equal(validateClaudeDesktopLoginUrl(value), value)
})

test('Desktop callback rejects non-login routes, ambiguous targets and unsafe input without leaking it', () => {
  for (const value of [
    'https://claude.ai/magic-link?code=do-not-print', 'claude://login/google-auth',
    'claude://login/google-auth?code=', 'claude://login:123/google-auth?code=do-not-print',
    'claude://user:do-not-print@login/google-auth?code=do-not-print',
    'claude://elsewhere/google-auth?code=do-not-print', 'claude://claude.ai/open-file?path=do-not-print',
    'claude://claude.ai/magic-link', 'claude://login/google-auth/extra?code=do-not-print',
    'claude://login/google-auth?code=do-not-print\n', 'claude://login/google-auth?code=do-not-print extra',
    'claude://login/google-auth?code=' + 'x'.repeat(16400),
  ]) assert.throws(() => validateClaudeDesktopLoginUrl(value), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes('do-not-print'), false)
    return true
  })
})

test('Desktop callback never dispatches to an invalid PID', async () => {
  for (const pid of [0, 1, -12, 1.5, NaN, Infinity]) {
    await assert.rejects(sendClaudeDesktopLoginUrl(pid, 'claude://login/google-auth?code=synthetic'), /目标无效/)
  }
})
