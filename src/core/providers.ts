/**
 * core/providers.ts — multi-provider registry.
 *
 * Dot historically hardcoded Anthropic. This module breaks that
 * hardcoding by turning "get credentials + configure env for the LLM
 * call" into a pluggable `Provider` contract.
 *
 * Providers supported today:
 *
 *   - anthropic   — direct API (sk-ant-* key or sk-ant-oat oauth token)
 *   - bedrock     — AWS Bedrock Claude (uses AWS creds; claude-agent-sdk
 *                    routes via CLAUDE_CODE_USE_BEDROCK=1)
 *   - vertex      — Google Vertex AI Claude (CLAUDE_CODE_USE_VERTEX=1)
 *
 * The Agent SDK (`@anthropic-ai/claude-agent-sdk`) natively handles
 * Bedrock + Vertex when those env flags are set, so no alternative
 * SDK integration is needed for those. OpenAI is NOT supported today —
 * the Agent SDK doesn't route to it. Adding OpenAI would require a
 * parallel Agent implementation and is tracked for a future session.
 *
 * Selection order (first non-empty wins):
 *   1. runtime `RunOptions.provider` (when an MCP tool overrides)
 *   2. `config.json` `provider` field
 *   3. Provider-specific env vars that are already set
 *   4. 'anthropic' if Keychain has anthropic-token
 *   5. 'anthropic' fallback → loadAnthropicToken()
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getSecret, setSecret } from './keychain.js'

export type ProviderId = 'anthropic' | 'bedrock' | 'vertex' | 'openai'

export interface ProviderConfig {
  id: ProviderId
  /** Human-facing label for the dashboard and status tools. */
  label: string
  /** Does this provider have credentials available right now? */
  ready: boolean
  /** Model id to pass to the SDK when this provider is active.
   *  Null → SDK picks its own default. */
  model: string | null
  /** Where the credential came from — for the dashboard. */
  credentialSource?: 'keychain' | 'env' | 'legacy-file' | 'aws-profile' | 'gcloud' | 'not-found'
  /** True if this provider is selectable by the Agent SDK today. False
   *  means: credentials can be stored, but the agent can't route to it
   *  without additional work (e.g. openai). */
  supportedByAgentSDK: boolean
}

export interface ActiveProvider extends ProviderConfig {
  /** Env vars that must be set before the SDK call. Applied via applyProvider(). */
  env: Record<string, string>
}

const NINA_CONFIG_PATH = path.join(os.homedir(), '.nina', 'config.json')

// ===== Credential helpers per provider =====

function loadAnthropicCredential(): { token: string | null; source: ProviderConfig['credentialSource'] } {
  const k = getSecret('anthropic-token')
  if (k) return { token: k, source: 'keychain' }
  const legacy = path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json')
  if (fs.existsSync(legacy)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
        profiles?: Record<string, { type?: string; token?: string; access?: string; apiKey?: string }>
      }
      const p = raw.profiles?.['anthropic:default']
      const token = p?.token ?? p?.access ?? p?.apiKey ?? null
      if (token) {
        setSecret('anthropic-token', token) // migrate
        return { token, source: 'legacy-file' }
      }
    } catch {
      // ignore
    }
  }
  const env =
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] || process.env['ANTHROPIC_API_KEY'] || null
  if (env) return { token: env, source: 'env' }
  return { token: null, source: 'not-found' }
}

function bedrockReady(): { ready: boolean; source: ProviderConfig['credentialSource'] } {
  // AWS credentials can come from env vars, the shared credentials file,
  // or an IAM role. We don't try to read them directly — the SDK and AWS
  // SDK for JS handle this. We just check whether the user has an obvious
  // signal.
  if (
    process.env['AWS_ACCESS_KEY_ID'] ||
    process.env['AWS_PROFILE'] ||
    process.env['AWS_SESSION_TOKEN'] ||
    process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']
  ) {
    return { ready: true, source: 'env' }
  }
  const awsDir = path.join(os.homedir(), '.aws', 'credentials')
  if (fs.existsSync(awsDir)) return { ready: true, source: 'aws-profile' }
  return { ready: false, source: 'not-found' }
}

function vertexReady(): { ready: boolean; source: ProviderConfig['credentialSource'] } {
  if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) return { ready: true, source: 'env' }
  const gcloud = path.join(
    os.homedir(),
    '.config',
    'gcloud',
    'application_default_credentials.json',
  )
  if (fs.existsSync(gcloud)) return { ready: true, source: 'gcloud' }
  return { ready: false, source: 'not-found' }
}

function openaiReady(): { token: string | null; source: ProviderConfig['credentialSource'] } {
  const k = getSecret('openai-api-key')
  if (k) return { token: k, source: 'keychain' }
  const env = process.env['OPENAI_API_KEY'] || null
  if (env) return { token: env, source: 'env' }
  return { token: null, source: 'not-found' }
}

// ===== Registry =====

interface PersistedConfig {
  provider?: ProviderId
  model?: string
  providers?: Partial<Record<ProviderId, { model?: string }>>
}

function loadPersistedConfig(): PersistedConfig {
  try {
    if (fs.existsSync(NINA_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(NINA_CONFIG_PATH, 'utf8')) as PersistedConfig
    }
  } catch {
    // ignore
  }
  return {}
}

function modelFor(id: ProviderId, cfg: PersistedConfig): string | null {
  return cfg.providers?.[id]?.model ?? (id === cfg.provider ? cfg.model ?? null : null)
}

export function listProviders(): ProviderConfig[] {
  const cfg = loadPersistedConfig()
  const anth = loadAnthropicCredential()
  const bed = bedrockReady()
  const vert = vertexReady()
  const oai = openaiReady()
  return [
    {
      id: 'anthropic',
      label: 'Anthropic API',
      ready: !!anth.token,
      model: modelFor('anthropic', cfg),
      credentialSource: anth.source,
      supportedByAgentSDK: true,
    },
    {
      id: 'bedrock',
      label: 'AWS Bedrock (Claude)',
      ready: bed.ready,
      model: modelFor('bedrock', cfg),
      credentialSource: bed.source,
      supportedByAgentSDK: true,
    },
    {
      id: 'vertex',
      label: 'Google Vertex AI (Claude)',
      ready: vert.ready,
      model: modelFor('vertex', cfg),
      credentialSource: vert.source,
      supportedByAgentSDK: true,
    },
    {
      id: 'openai',
      label: 'OpenAI (stored-only, not routable)',
      ready: !!oai.token,
      model: modelFor('openai', cfg),
      credentialSource: oai.source,
      supportedByAgentSDK: false, // see module-level comment
    },
  ]
}

/**
 * Resolve the active provider for this run. Defaults to Anthropic.
 * If `override` is set and that provider is ready, it wins.
 * If the default provider isn't ready, falls back to the first ready
 * provider supported by the Agent SDK.
 */
export function resolveActiveProvider(override?: ProviderId): ActiveProvider {
  const cfg = loadPersistedConfig()
  const all = listProviders()
  const byId = new Map(all.map((p) => [p.id, p]))
  const desired: ProviderId = override ?? cfg.provider ?? 'anthropic'
  const picked = byId.get(desired)
  const usable = (p?: ProviderConfig) => !!p && p.ready && p.supportedByAgentSDK

  let active: ProviderConfig
  if (usable(picked)) {
    active = picked!
  } else {
    // Try the other SDK-supported providers in order.
    const fallback = all.find((p) => p.supportedByAgentSDK && p.ready)
    if (!fallback) {
      // Nothing is ready. Return the desired one anyway so the caller
      // gets a clear error at SDK call time.
      active = picked ?? all[0]
    } else {
      active = fallback
    }
  }

  return { ...active, env: envFor(active) }
}

/** Compute the env vars that must be set for a provider. */
function envFor(p: ProviderConfig): Record<string, string> {
  switch (p.id) {
    case 'anthropic': {
      const { token } = loadAnthropicCredential()
      const env: Record<string, string> = {}
      if (token) {
        if (token.startsWith('sk-ant-oat')) env['CLAUDE_CODE_OAUTH_TOKEN'] = token
        else env['ANTHROPIC_API_KEY'] = token
      }
      return env
    }
    case 'bedrock':
      return { CLAUDE_CODE_USE_BEDROCK: '1' }
    case 'vertex':
      return { CLAUDE_CODE_USE_VERTEX: '1' }
    case 'openai':
      return {} // not routable today
  }
}

/**
 * Apply an active provider to process.env. Idempotent. Call once per
 * agent turn before invoking the SDK.
 */
export function applyProvider(active: ActiveProvider): void {
  // Clear the flags we might flip so switching providers mid-session is clean.
  delete process.env['CLAUDE_CODE_USE_BEDROCK']
  delete process.env['CLAUDE_CODE_USE_VERTEX']
  for (const [k, v] of Object.entries(active.env)) {
    process.env[k] = v
  }
}

/** Store a provider-specific credential in the Keychain. */
export function storeProviderCredential(id: ProviderId, value: string): boolean {
  switch (id) {
    case 'anthropic':
      return setSecret('anthropic-token', value)
    case 'openai':
      return setSecret('openai-api-key', value)
    case 'bedrock':
    case 'vertex':
      // AWS / GCP credentials live in their own well-known locations.
      // Storing them in Keychain would be inconsistent with how every
      // other tool reads them. Refuse.
      return false
  }
}

/** Persist provider + model choice to config.json. */
export function setPreferredProvider(id: ProviderId, model?: string): void {
  let cfg: PersistedConfig = {}
  try {
    if (fs.existsSync(NINA_CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(NINA_CONFIG_PATH, 'utf8')) as PersistedConfig
    }
  } catch {
    // ignore
  }
  cfg.provider = id
  if (model !== undefined) {
    cfg.model = model
    cfg.providers = { ...(cfg.providers ?? {}), [id]: { model } }
  }
  fs.mkdirSync(path.dirname(NINA_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(NINA_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}
