/**
 * core/rl/index.ts — public surface + lifecycle.
 *
 * `initRL()` is called once from `main/index.ts` at startup:
 *   - opens rl.db
 *   - seeds default priors (only on first boot)
 *   - starts the periodic sweeper (every 10 minutes) which scores
 *     proactive / silent-work / cron actions that never got a user
 *     reply, then runs `updatePolicy()` once per hour to rebuild the
 *     policy table from the replay buffer.
 *
 * The agent reads the policy via the `rl_policy` MCP tool (see mcp-tools.ts)
 * and via a compact "recommended moves here" block injected into the
 * system prompt by `agent.ts`.
 */
import { initRLDatabase } from './schema.js'
import { seedDefaultPriors, updatePolicy, generateReport, bucketKey } from './policy.js'
import { sweepUnscoredActions } from './reward-signals.js'
import { writeDailySummary } from './replay-buffer.js'

export { initRLDatabase, closeRL } from './schema.js'
export {
  recordAction,
  updateReward,
  recentActionsForSession,
  todayStats,
  writeDailySummary,
  lengthBucketOf,
} from './replay-buffer.js'
export type {
  ActionType,
  Tone,
  LengthBucket,
  ContentType,
  ActionState,
  ActionRecord,
  RewardPatch,
} from './replay-buffer.js'
export {
  updatePolicy,
  recommendations,
  explorationSuggestion,
  generateReport,
  bucketKey,
  setPriors,
  seedDefaultPriors,
} from './policy.js'
export {
  scoreOnIncomingUserMessage,
  sweepUnscoredActions,
  scoreToolOutcomes,
} from './reward-signals.js'

let sweepHandle: ReturnType<typeof setInterval> | null = null
let policyHandle: ReturnType<typeof setInterval> | null = null
let summaryHandle: ReturnType<typeof setInterval> | null = null
let lastSummaryDate = ''

function maybeWriteYesterday(): void {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (lastSummaryDate === yesterday) return
  try {
    writeDailySummary(yesterday)
    lastSummaryDate = yesterday
  } catch {
    // non-critical
  }
}

export function initRL(): void {
  initRLDatabase()
  seedDefaultPriors()
  // Reward sweeper — score stale actions every 10 min.
  sweepHandle = setInterval(() => {
    try {
      sweepUnscoredActions()
    } catch (err) {
      console.warn('[rl] sweep failed:', err)
    }
  }, 10 * 60 * 1000)
  // Policy rebuild — every 60 min.
  policyHandle = setInterval(() => {
    try {
      updatePolicy()
    } catch (err) {
      console.warn('[rl] updatePolicy failed:', err)
    }
  }, 60 * 60 * 1000)
  // Daily summary — every 60 min too (idempotent; writes yesterday once per day).
  summaryHandle = setInterval(maybeWriteYesterday, 60 * 60 * 1000)
  maybeWriteYesterday()
  // First policy build so the tool has something to return on day 1.
  try {
    updatePolicy()
  } catch {
    // ok — no data yet
  }
}

export function stopRL(): void {
  if (sweepHandle) clearInterval(sweepHandle)
  if (policyHandle) clearInterval(policyHandle)
  if (summaryHandle) clearInterval(summaryHandle)
  sweepHandle = null
  policyHandle = null
  summaryHandle = null
}

/** Convenience: bucketKey from current situation + render the full report. */
export function reportForCurrent(situation: {
  channel: string
  hour: number
  idleSeconds?: number
  screenLocked?: boolean
  onboardingActive?: boolean
}): string {
  return generateReport(bucketKey(situation))
}
