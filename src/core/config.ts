import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getSecret, setSecret } from './keychain.js'

const NINA_CONFIG_PATH = path.join(os.homedir(), '.nina', 'config.json')

// =========== Nina config ===========

export interface NinaConfig {
  observationIntervalMs: number
  screenWatcherIntervalMs: number
  reflectionHour: number
  diaryHour: number
  diaryMinute: number
  proactiveMinIntervalMs: number
  screenWatcherMaxFrames: number
  screenWatcherMaxIdleSec: number
  missionTickIntervalMs: number
  clipboardPollMs: number
  clipboardMaxEntries: number
  /** Soft daily spend cap in USD. Background jobs are warned/blocked when
   *  today's cost exceeds this. 0 = no cap. Foreground chat always runs. */
  dailyBudgetUsd: number
}

const DEFAULTS: NinaConfig = {
  observationIntervalMs: 15 * 60 * 1000,
  // Screen-watcher cadence: the review flagged 45s as creepy and
  // expensive for low-signal. Bumped to 3 min — still captures the
  // most-recent frame when the user asks "what's on my screen?" but
  // polls 4x less. Users can tighten via config.json.
  screenWatcherIntervalMs: 180_000,
  reflectionHour: 21,
  diaryHour: 22,
  diaryMinute: 30,
  proactiveMinIntervalMs: 30 * 60 * 1000,
  screenWatcherMaxFrames: 12,
  screenWatcherMaxIdleSec: 5 * 60,
  missionTickIntervalMs: 2 * 60 * 1000,
  clipboardPollMs: 800,
  clipboardMaxEntries: 100,
  dailyBudgetUsd: 0,
}

let cachedConfig: NinaConfig | null = null
let lastReadAt = 0
const CACHE_TTL = 30_000

export function loadConfig(): NinaConfig {
  if (cachedConfig && Date.now() - lastReadAt < CACHE_TTL) return cachedConfig
  let userOverrides: Partial<NinaConfig> = {}
  try {
    if (fs.existsSync(NINA_CONFIG_PATH)) {
      const raw = fs.readFileSync(NINA_CONFIG_PATH, 'utf8')
      userOverrides = JSON.parse(raw) as Partial<NinaConfig>
    }
  } catch (err) {
    console.warn('[nina] Failed to read config.json:', err)
  }
  cachedConfig = { ...DEFAULTS, ...userOverrides }
  lastReadAt = Date.now()
  return cachedConfig
}

export function ensureConfigFile(): void {
  if (fs.existsSync(NINA_CONFIG_PATH)) return
  try {
    fs.mkdirSync(path.dirname(NINA_CONFIG_PATH), { recursive: true })
    fs.writeFileSync(NINA_CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8')
  } catch {
    // ignore
  }
}

// =========== Anthropic credential loading ===========

interface AuthProfile {
  type: 'token' | 'oauth' | 'api_key'
  provider: string
  token?: string
  access?: string
  apiKey?: string
}

interface AuthProfilesFile {
  profiles?: Record<string, AuthProfile>
}

export function loadAnthropicToken(): string | null {
  // 1. Prefer Keychain — the only place we want this long-term.
  const keychainToken = getSecret('anthropic-token')
  if (keychainToken) return keychainToken

  // 2. Fall back to legacy plaintext, then automatically migrate into
  //    the Keychain so subsequent boots read from the secure store.
  const candidatePaths = [
    path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json'),
  ]

  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as AuthProfilesFile
      const profile = data.profiles?.['anthropic:default']
      if (!profile) continue
      let token: string | null = null
      if (profile.type === 'token' && profile.token) token = profile.token
      else if (profile.type === 'oauth' && profile.access) token = profile.access
      else if (profile.type === 'api_key' && profile.apiKey) token = profile.apiKey
      if (token) {
        // Best-effort migration. Failure is non-fatal.
        if (setSecret('anthropic-token', token)) {
          console.log('[nina] migrated Anthropic token to macOS Keychain')
        }
        return token
      }
    } catch (err) {
      console.warn(`[nina] Failed to parse ${p}:`, err)
    }
  }

  // 3. Env vars as a last resort (never auto-migrated — env is often
  //    transient and we don't want to capture a one-off shell token).
  return (
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    null
  )
}

export function applyAnthropicCredential(token: string): void {
  if (token.startsWith('sk-ant-oat')) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token
  } else {
    process.env.ANTHROPIC_API_KEY = token
  }
}
