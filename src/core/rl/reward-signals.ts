/**
 * core/rl/reward-signals.ts — derive reward from observable signals
 * instead of asking the agent.
 *
 * Observable signals Dot can see for free:
 *   1. User reply latency in the same session — faster reply = more engaged.
 *      No reply at all after 30 min = cold. (engagement score)
 *   2. Sentiment of the user's next turn — "thanks"/"great" vs "no"/"stop"/"wrong".
 *      Heuristic keyword match; good enough to start, swap for an LLM scorer later.
 *   3. Tool-call success rate during the action — `tool_calls.decision` and
 *      whether subsequent tools got called indicate whether the plan worked.
 *      (outcome score)
 *   4. Explicit `/feedback good` or `/feedback bad` from the user. (explicit score)
 *
 * Called on a periodic timer from `rl/index.ts` AND inline when the user
 * sends a new turn (so the previous assistant turn in the same session
 * gets scored immediately).
 */
import { getDb } from '../db.js'
import { updateReward, recentActionsForSession } from './replay-buffer.js'
import { getRL } from './schema.js'

const POSITIVE_PATTERNS = [
  /\b(thanks|thank you|thx|ty|great|perfect|nice|love it|exactly|yes!|awesome|brilliant|helpful|amazing|cheers|appreciate)\b/i,
  /👍|❤️|🙏|✨|🎉|💯|🔥/,
]
const NEGATIVE_PATTERNS = [
  /\b(no,? that'?s not|wrong|incorrect|stop|don'?t|not helpful|useless|bad|terrible|cancel|undo|nope)\b/i,
  /👎|😠|😤/,
]
const CORRECTION_PATTERNS = [
  /\b(actually|i meant|i said|that'?s not what|re-?read|try again)\b/i,
]

function scoreSentiment(text: string): number {
  const t = text.slice(0, 500)
  let s = 0
  if (POSITIVE_PATTERNS.some((p) => p.test(t))) s += 3
  if (NEGATIVE_PATTERNS.some((p) => p.test(t))) s -= 4
  if (CORRECTION_PATTERNS.some((p) => p.test(t))) s -= 2
  return s
}

/**
 * When a new user message arrives, score Dot's previous action in the
 * same session. Called synchronously from turn.ts at the top of each
 * turn BEFORE the new action is recorded.
 */
export function scoreOnIncomingUserMessage(opts: {
  sessionType: string
  sessionId: string | null
  userText: string
  nowMs?: number
}): void {
  const now = opts.nowMs ?? Date.now()
  const recent = recentActionsForSession(opts.sessionType, opts.sessionId, 1)
  if (recent.length === 0) return
  const last = recent[0]
  if (last.reward_checked === 1) return // already scored
  const actionTsMs = Date.parse(last.timestamp)
  if (isNaN(actionTsMs)) return
  const gapSec = (now - actionTsMs) / 1000

  // Engagement from latency: faster reply = more engaged.
  //   <60s:  +3
  //   <5min: +2
  //   <30min: +1
  //   <2h:   0
  //   else:  -1 (long delay suggests the answer wasn't compelling)
  let engagement = 0
  if (gapSec < 60) engagement = 3
  else if (gapSec < 300) engagement = 2
  else if (gapSec < 1800) engagement = 1
  else if (gapSec < 7200) engagement = 0
  else engagement = -1

  const sentiment = scoreSentiment(opts.userText)

  // Explicit /feedback commands carry the biggest signal.
  let explicit = 0
  const m = /^\/feedback\s+(good|bad|great|awful|awesome|terrible|yes|no)\b/i.exec(
    opts.userText.trim(),
  )
  if (m) {
    const v = m[1].toLowerCase()
    explicit = ['good', 'great', 'awesome', 'yes'].includes(v) ? 5 : -5
  }

  updateReward(last.id, {
    engagement,
    explicit,
    outcome: sentiment, // sentiment folds into outcome
    notes: `latency=${Math.round(gapSec)}s sentiment=${sentiment} explicit=${explicit}`,
  })
}

/**
 * Periodic sweep — score proactive / silent-work / cron actions that
 * never got a user reply. Called every 10 minutes from `rl/index.ts`.
 */
export function sweepUnscoredActions(nowMs?: number): void {
  const now = nowMs ?? Date.now()
  // Score any action older than 30 minutes that still has reward_checked = 0.
  // Actions without a user reply (proactive bubbles ignored, cron runs) get
  // a small engagement score based on what followed — nothing = 0, user
  // started a new session = +1 (dot's push was noticed).
  const db = getDb()
  const rlDb = getRL()
  const cutoff = new Date(now - 30 * 60 * 1000).toISOString()
  const stale = rlDb
    .prepare(
      `SELECT id, timestamp, session_type, session_id, action_type, channel
       FROM replay_buffer
       WHERE reward_checked = 0 AND timestamp < ?
       ORDER BY id ASC LIMIT 100`,
    )
    .all(cutoff) as Array<{
    id: number
    timestamp: string
    session_type: string | null
    session_id: string | null
    action_type: string
    channel: string
  }>

  for (const row of stale) {
    // Did any user conversation turn arrive in the same session after this action?
    const after = db
      .prepare(
        `SELECT COUNT(*) as c FROM conversations
         WHERE role = 'user' AND timestamp > ? AND session_type = ?`,
      )
      .get(row.timestamp, row.session_type ?? 'chat') as { c: number }
    // Proactive actions that got no user reply → mild negative.
    // Replies that got no follow-up → neutral.
    let engagement = 0
    if (row.action_type === 'proactive' || row.action_type === 'ritual') {
      engagement = after.c > 0 ? 1 : -1
    } else if (row.action_type === 'reply') {
      engagement = after.c > 0 ? 1 : 0
    }
    updateReward(row.id, {
      engagement,
      notes: `sweep: followup_user_msgs=${after.c} after ${row.timestamp}`,
    })
  }
}

/** Score tool outcomes for a specific action — called from turn.ts after the
 *  agent finishes. Positive if most tool calls succeeded, negative if errors. */
export function scoreToolOutcomes(actionId: number, duringIso: string, untilIso: string): void {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN decision = 'auto' OR decision = 'user-approved' THEN 1 ELSE 0 END) as ok,
         SUM(CASE WHEN decision = 'user-denied' OR decision = 'blocked-by-rule' THEN 1 ELSE 0 END) as blocked,
         COUNT(*) as total
       FROM tool_calls WHERE timestamp >= ? AND timestamp < ?`,
    )
    .get(duringIso, untilIso) as { ok: number; blocked: number; total: number }
  if (row.total === 0) return
  const ok = row.ok ?? 0
  const blocked = row.blocked ?? 0
  // +0.5 per successful tool use, -1 per blocked/denied.
  const outcome = ok * 0.5 - blocked * 1
  if (outcome !== 0) {
    updateReward(actionId, {
      outcome,
      notes: `tools ok=${ok} blocked=${blocked} total=${row.total}`,
    })
  }
}
