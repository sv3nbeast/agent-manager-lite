import { z } from 'zod'

/**
 * Claude Code CLI supports the independently verified native API Key/Bearer
 * lifecycle. Subscription OAuth, cloud credentials and Desktop keep their own
 * evidence gates; sharing an identity service does not imply compatibility.
 */
export const claudeCodeClientType = 'claude_code' as const
export type ClaudeCodeClientType = typeof claudeCodeClientType

/**
 * Claude Code is one product client with two separately owned launchers.  The
 * launcher is an installation detail, so it must not become a second agent
 * type or a second account library.  Keeping it explicit still prevents the
 * CLI's config directory rules from accidentally being applied to Desktop.
 */
export const claudeCodeApplicationKindSchema = z.enum(['cli', 'desktop'])
export type ClaudeCodeApplicationKind = z.infer<typeof claudeCodeApplicationKindSchema>

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

export const claudeCodeProtocolSchema = z.literal('anthropic_messages')
export type ClaudeCodeProtocol = z.infer<typeof claudeCodeProtocolSchema>
export const claudeCodeCapabilitySchema = z.object({
  login: z.boolean(), nativeAccounts: z.boolean(), apiKey: z.boolean(), localApi: z.boolean(),
  models: z.boolean(), contextWindow: z.boolean(), fast: z.boolean(),
  launchModes: z.array(claudeCodeApplicationKindSchema).min(1), projectDirectoryModes: z.array(claudeCodeApplicationKindSchema).min(1),
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

/**
 * The CLI probes can verify the executable and the shape of an isolated
 * configuration directory without proving that credentials, shared global
 * state, or transcripts are safe to hand to the common instance lifecycle.
 * Keep those gates explicit so diagnostics cannot accidentally promote the
 * client merely because `claude --version` succeeds.
 */
/** Acceptance applies only to native CLI API Key/Bearer connections. */
export const claudeCodeCliAcceptance = claudeCodeAcceptanceSchema.parse({
  detection: 'verified',
  configProjection: 'verified',
  credentialIsolation: 'verified',
  protocolAdapter: 'verified',
  runtimeLifecycle: 'verified',
  globalStateOwnership: 'verified',
  sessionIndexing: 'verified',
})

/** Desktop has an independently detected bundle, but its Electron profile,
 * Keychain/cookie ownership and Code mode transcript boundary remain pending. */
export const claudeCodeDesktopAcceptance = claudeCodeAcceptanceSchema.parse({
  detection: 'verified',
  configProjection: 'pending',
  credentialIsolation: 'pending',
  protocolAdapter: 'pending',
  runtimeLifecycle: 'pending',
  globalStateOwnership: 'pending',
  sessionIndexing: 'pending',
})

export const claudeCodeClient = {
  id: claudeCodeClientType,
  name: 'Claude Code',
  status: 'implemented' as const,
  identityService: 'anthropic' as const,
  protocol: 'anthropic_messages' as const,
  capabilities: {
    login: false,
    nativeAccounts: true,
    apiKey: true,
    localApi: false,
    models: true,
    contextWindow: false,
    fast: false,
    launchModes: ['cli'] as const,
    projectDirectoryModes: ['cli'] as const,
    configDirectory: true,
    sessionPersistence: true,
  },
} as const

/** Desktop is deliberately described separately from CLI even though both
 * belong to the same Claude Code product family.  Its Electron profile and
 * system login state have not passed the isolation gate yet. */
export const claudeCodeDesktopClient = {
  id: claudeCodeClientType,
  name: 'Claude Code Desktop',
  status: 'planned' as const,
  identityService: 'anthropic' as const,
  protocol: 'anthropic_messages' as const,
  applicationKind: 'desktop' as const,
  capabilities: {
    login: true,
    nativeAccounts: true,
    apiKey: true,
    localApi: false,
    models: true,
    contextWindow: true,
    fast: false,
    launchModes: ['desktop'] as const,
    projectDirectoryModes: ['desktop'] as const,
    configDirectory: false,
    sessionPersistence: true,
  },
} as const

export interface ClaudeCodeCredentialInput {
  kind: ClaudeCodeCredentialKind
  /** The connection protocol is intentionally independent from Account.kind. */
  protocol?: ClaudeCodeProtocol
  model?: string
  baseUrl?: string
}

export interface ClaudeCodeCredentialCompatibility {
  compatible: boolean
  reason?: string
}

/**
 * Static compatibility only.  It does not inspect or refresh credentials and
 * therefore is safe to use while rendering account choices.  Live ownership
 * and token refresh belong to an Anthropic identity adapter.
 */
export function claudeCodeCredentialCompatibility(input: ClaudeCodeCredentialInput): ClaudeCodeCredentialCompatibility {
  if (input.protocol !== undefined && input.protocol !== 'anthropic_messages') return { compatible: false, reason: 'Claude Code 需要 Anthropic Messages 协议' }
  if (!input.model?.trim()) return { compatible: false, reason: 'Claude Code 需要已验证的模型' }
  if (input.baseUrl !== undefined) {
    try {
      const url = new URL(input.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { return { compatible: false, reason: 'Claude Code 网关地址必须是干净的 HTTP(S) 地址' } }
  }
  if (input.kind === 'claude_ai_oauth' || input.kind === 'anthropic_api_key' || input.kind === 'anthropic_bearer' || input.kind === 'anthropic_profile' || input.kind === 'bedrock' || input.kind === 'vertex' || input.kind === 'foundry' || input.kind === 'gateway') return { compatible: true }
  return { compatible: false, reason: '此 Claude Code 凭据类型尚未验证' }
}

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
