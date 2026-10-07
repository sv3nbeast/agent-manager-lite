import { z } from 'zod'

/**
 * Claude Code is intentionally kept outside `implementedAgentClients` until
 * the Anthropic account and runtime transactions have been verified.  This
 * descriptor is the first phase contract: it describes the CLI's own
 * boundaries without making it selectable in the Codex-only wizard.
 */
export const claudeCodeClientType = 'claude_code' as const
export type ClaudeCodeClientType = typeof claudeCodeClientType

export const claudeCodeProtocolSchema = z.literal('anthropic_messages')
export const claudeCodeCredentialKindSchema = z.enum([
  'claude_ai_oauth',
  'anthropic_api_key',
  'anthropic_bearer',
  'anthropic_profile',
  'bedrock',
  'vertex',
  'foundry',
  'gateway',
])
export type ClaudeCodeCredentialKind = z.infer<typeof claudeCodeCredentialKindSchema>

export const claudeCodeCapabilitySchema = z.object({
  login: z.boolean(), nativeAccounts: z.boolean(), apiKey: z.boolean(), localApi: z.boolean(),
  models: z.boolean(), contextWindow: z.boolean(), fast: z.boolean(),
  launchModes: z.array(z.literal('cli')).min(1), projectDirectoryModes: z.array(z.literal('cli')).min(1),
  configDirectory: z.boolean(), sessionPersistence: z.boolean(),
}).strict()
export type ClaudeCodeCapabilities = z.infer<typeof claudeCodeCapabilitySchema>

/** Evidence gates used before this planned client can enter the implemented registry. */
export const claudeCodeAcceptanceSchema = z.object({
  detection: z.enum(['verified', 'pending']),
  configProjection: z.enum(['verified', 'pending']),
  credentialIsolation: z.enum(['verified', 'pending']),
  protocolAdapter: z.enum(['verified', 'pending']),
  runtimeLifecycle: z.enum(['verified', 'pending']),
  globalStateOwnership: z.enum(['verified', 'pending']),
  sessionIndexing: z.enum(['verified', 'pending']),
}).strict()
export type ClaudeCodeAcceptance = z.infer<typeof claudeCodeAcceptanceSchema>

export const claudeCodePhaseOneAcceptance = claudeCodeAcceptanceSchema.parse({
  detection: 'verified', configProjection: 'verified', credentialIsolation: 'pending', protocolAdapter: 'pending',
  runtimeLifecycle: 'pending', globalStateOwnership: 'pending', sessionIndexing: 'pending',
})

export const claudeCodeClient = {
  id: claudeCodeClientType,
  name: 'Claude Code',
  status: 'planned' as const,
  identityService: 'anthropic' as const,
  protocol: 'anthropic_messages' as const,
  capabilities: {
    login: true,
    nativeAccounts: true,
    apiKey: true,
    localApi: false,
    models: true,
    contextWindow: true,
    fast: false,
    launchModes: ['cli'] as const,
    projectDirectoryModes: ['cli'] as const,
    configDirectory: true,
    sessionPersistence: true,
  },
} as const

/**
 * Fields which must be owned by an instance launcher once Claude Code is
 * wired into the common lifecycle.  Keeping this list here prevents a later
 * adapter from accidentally inheriting Codex's `CODEX_HOME` assumptions.
 */
export const claudeCodeOwnedEnvironment = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

export type ClaudeCodeOwnedEnvironment = typeof claudeCodeOwnedEnvironment[number]
