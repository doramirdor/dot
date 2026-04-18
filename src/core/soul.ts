/**
 * Soul state: the small, quiet state files that make Dot feel like a creature
 * rather than a chatbot.
 *
 * - Nudge budget (3 interrupts/day, visible as dots)
 * - Callback quirks (small facts with trigger conditions)
 * - Morning ritual (once per day, first interaction)
 * - Farewell message (pre-computed "one good thing" shown on quit)
 * - New-day detection
 *
 * All persistence is plain JSON in ~/.dot/memory/. No ORM, no migrations.
 */
import fs from 'node:fs'
import path from 'node:path'
import { MEMORY_DIR } from './memory.js'

export const SOUL_DIR = path.join(MEMORY_DIR, 'soul')
export const DIARY_DIR = path.join(MEMORY_DIR, 'diary')
export const STATE_FILE = path.join(SOUL_DIR, 'state.json')
export const QUIRKS_FILE = path.join(SOUL_DIR, 'quirks.jsonl')
export const FAREWELL_FILE = path.join(SOUL_DIR, 'farewell.txt')

const DAILY_BUDGET = 3

export interface SoulState {
  /** Last date we saw the user (YYYY-MM-DD in local tz). */
  lastSeenDate: string | null
  /** Current date we're tracking budget for. */
  budgetDate: string
  /** Tokens remaining today for proactive interrupts. */
  tokensRemaining: number
  /** Has the morning ritual fired yet for this date? */
  ritualFiredDate: string | null
  /** Did the last shutdown go through the farewell ritual? */
  lastQuitGraceful: boolean
  /**
   * Has Dot "grown up"? She starts as a green seedling during onboarding
   * and transforms into her mature blue form after onboarding completes.
   * Sticky across restarts.
   */
  grown: boolean
  /**
   * Is active onboarding in progress? When true, the agent gets an extra
   * system prompt block telling her to listen hard and update memory from
   * every user response. Multi-turn discovery phase.
   */
  onboardingActive: boolean
  /** How many turns has the active onboarding been running. */
  onboardingTurnCount: number
}

export interface Quirk {
  id: string
  fact: string
  trigger: string // human-readable: "rainy monday mornings", "after a long coding session"
  createdAt: string
  lastFiredAt: string | null
}

// ========== dates ==========

function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ========== init ==========

export function ensureSoulDirs(): void {
  fs.mkdirSync(SOUL_DIR, { recursive: true })
  fs.mkdirSync(DIARY_DIR, { recursive: true })
}

// ========== state ==========

function defaultState(): SoulState {
  return {
    lastSeenDate: null,
    budgetDate: localDateString(),
    tokensRemaining: DAILY_BUDGET,
    ritualFiredDate: null,
    lastQuitGraceful: true,
    grown: false,
    onboardingActive: false,
    onboardingTurnCount: 0,
  }
}

export function loadState(): SoulState {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState()
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return { ...defaultState(), ...raw }
  } catch {
    return defaultState()
  }
}

export function saveState(state: SoulState): void {
  try {
    ensureSoulDirs()
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.warn('[nina] Failed to save soul state:', err)
  }
}

/**
 * Roll over the state for a new day if needed. Returns true if a new day
 * actually started.
 */
export function rolloverIfNewDay(): { state: SoulState; isNewDay: boolean } {
  const state = loadState()
  const today = localDateString()
  if (state.budgetDate !== today) {
    state.budgetDate = today
    state.tokensRemaining = DAILY_BUDGET
    saveState(state)
    return { state, isNewDay: true }
  }
  return { state, isNewDay: false }
}

// ========== first-tap-of-day / morning ritual ==========

/**
 * Returns true if this is the first interaction of a new calendar day.
 * Marks the ritual as fired so subsequent calls return false until tomorrow.
 */
export function shouldFireMorningRitual(): boolean {
  const { state } = rolloverIfNewDay()
  const today = localDateString()
  if (state.ritualFiredDate === today) return false

  state.ritualFiredDate = today
  state.lastSeenDate = today
  saveState(state)
  return true
}

export function touchLastSeen(): void {
  const state = loadState()
  state.lastSeenDate = localDateString()
  saveState(state)
}

// ========== nudge budget ==========

export function getTokensRemaining(): number {
  return rolloverIfNewDay().state.tokensRemaining
}

/**
 * Spend a token. Returns true if spent, false if none left. Use this from
 * proactive interrupt sources before actually interrupting.
 */
export function spendToken(): boolean {
  const { state } = rolloverIfNewDay()
  if (state.tokensRemaining <= 0) return false
  state.tokensRemaining -= 1
  saveState(state)
  return true
}

// ========== quirks ==========

export function loadQuirks(): Quirk[] {
  try {
    if (!fs.existsSync(QUIRKS_FILE)) return []
    return fs
      .readFileSync(QUIRKS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Quirk
        } catch {
          return null
        }
      })
      .filter((q): q is Quirk => q !== null)
  } catch {
    return []
  }
}

export function saveQuirks(quirks: Quirk[]): void {
  try {
    ensureSoulDirs()
    const content = quirks.map((q) => JSON.stringify(q)).join('\n') + '\n'
    fs.writeFileSync(QUIRKS_FILE, content, 'utf8')
  } catch (err) {
    console.warn('[nina] Failed to save quirks:', err)
  }
}

export function markQuirkFired(id: string): void {
  const quirks = loadQuirks()
  const q = quirks.find((x) => x.id === id)
  if (!q) return
  q.lastFiredAt = new Date().toISOString()
  saveQuirks(quirks)
}

/**
 * Check if any quirk is eligible to fire today. Rate-limited: no quirk
 * fires more than once a week, and Dot fires at most one callback per week
 * total. Returns the chosen quirk or null.
 *
 * Simple matcher for now: a quirk is eligible if (a) it's never fired or
 * last fired >7 days ago, AND (b) no other quirk has fired in the last 7 days
 * (the total rate limit). We let Claude decide *which* one during the
 * morning ritual by passing the eligible set in the prompt — the text match
 * against "today" (weather, day of week) happens in the LLM layer, not here.
 */
export function getEligibleQuirks(): Quirk[] {
  const quirks = loadQuirks()
  const now = Date.now()
  const WEEK = 7 * 24 * 60 * 60 * 1000

  // Global rate limit: if ANY quirk fired in the last 7 days, none are eligible.
  const anyRecent = quirks.some(
    (q) => q.lastFiredAt && now - Date.parse(q.lastFiredAt) < WEEK,
  )
  if (anyRecent) return []

  return quirks.filter((q) => {
    if (!q.lastFiredAt) return true
    return now - Date.parse(q.lastFiredAt) >= WEEK
  })
}

// ========== farewell "one good thing" ==========

/**
 * Stash a candidate "one good thing" line to show on shutdown. Called from
 * the daily reflection and opportunistically from successful task completions.
 * Overwrites — only the latest is kept.
 */
export function stashFarewellMessage(line: string): void {
  try {
    ensureSoulDirs()
    fs.writeFileSync(FAREWELL_FILE, line.trim(), 'utf8')
  } catch (err) {
    console.warn('[nina] Failed to stash farewell:', err)
  }
}

export function loadFarewellMessage(): string {
  try {
    if (!fs.existsSync(FAREWELL_FILE)) return 'goodnight. see you tomorrow. 🌱'
    const content = fs.readFileSync(FAREWELL_FILE, 'utf8').trim()
    return content || 'goodnight. see you tomorrow. 🌱'
  } catch {
    return 'goodnight. see you tomorrow. 🌱'
  }
}

export function markQuitGraceful(graceful: boolean): void {
  const state = loadState()
  state.lastQuitGraceful = graceful
  saveState(state)
}

export function wasLastQuitGraceful(): boolean {
  return loadState().lastQuitGraceful
}

// ========== growth ==========

export function isGrown(): boolean {
  return loadState().grown === true
}

export function markGrown(): void {
  const state = loadState()
  if (state.grown) return
  state.grown = true
  saveState(state)
}

/** For debugging — reset her to seedling. */
export function resetGrowth(): void {
  const state = loadState()
  state.grown = false
  saveState(state)
}

// ========== onboarding mode ==========

export function isOnboardingActive(): boolean {
  return loadState().onboardingActive === true
}

export function getOnboardingTurnCount(): number {
  return loadState().onboardingTurnCount ?? 0
}

export function startOnboarding(): void {
  const state = loadState()
  state.onboardingActive = true
  state.onboardingTurnCount = 0
  saveState(state)
}

export function incrementOnboardingTurn(): number {
  const state = loadState()
  state.onboardingTurnCount = (state.onboardingTurnCount ?? 0) + 1
  saveState(state)
  return state.onboardingTurnCount
}

export function endOnboarding(): void {
  const state = loadState()
  state.onboardingActive = false
  saveState(state)
}
