import fs from 'node:fs'
import path from 'node:path'
import { getSecret, setSecret } from './keychain.js'
import { DOT_DIR } from './memory.js'

const NINA_CONFIG_PATH = path.join(DOT_DIR, 'config.json')

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

/**
 * Read an Anthropic credential from the Keychain or the environment. Does
 * NOT read ~/.openclaw/... — Dot no longer silently imports sibling tools'
 * credentials. The first-run setup UI offers an explicit "import openclaw
 * token" action via providers.findLegacyOpenclawToken().
 */
export function loadAnthropicToken(): string | null {
  const keychainToken = getSecret('anthropic-token')
  if (keychainToken) return keychainToken
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
