/**
 * core/rl/replay-buffer.ts — write actions + read them back.
 *
 * `recordAction` is the only write path for replay rows. It's called from
 * `core/turn.ts` at the END of every turn (after the agent finishes), so
 * `tools_used` / `output_tokens` / `action_cost` can be filled in with
 * real values instead of guesses.
 *
 * Reward is written later by `reward-signals.ts` — deliberately decoupled
 * so the agent never self-reports its own reward (that path leads to
 * reward hacking).
 */
import type { Database as DB } from 'better-sqlite3'
import { getRL } from './schema.js'

export type ActionType =
  | 'reply'
  | 'proactive'
  | 'mission_step'
  | 'cron_run'
  | 'ritual'
  | 'silent_work'

export type Tone = 'warm' | 'terse' | 'playful' | 'formal' | 'concerned'
export type LengthBucket = 'xs' | 's' | 'm' | 'l'
export type ContentType =
  | 'short_answer'
  | 'long_explanation'
  | 'clarifying_question'
  | 'task_completion'
  | 'suggestion'
  | 'check_in'
  | 'refusal'

export interface ActionState {
  channel: string
  hour: number
  dayOfWeek: number
  idleSeconds?: number
  screenLocked?: boolean
  budgetSpentToday?: number
  budgetHeadroomUsd?: number
  activeMissions?: number
  bgQueueDepth?: number
  onboardingActive?: boolean
  grown?: boolean
  conversationDepth?: number
}

export interface ActionRecord {
  state: ActionState
  actionType: ActionType
  tone?: Tone | null
  lengthBucket?: LengthBucket | null
  toolsUsed?: string[]
  contentType?: ContentType | null
  characterForm?: string | null
  actionCost?: number
  inputTokens?: number
  outputTokens?: number
  sessionId?: string | null
  sessionType?: string
  notes?: string
}

export interface RewardPatch {
  engagement?: number
  outcome?: number
  explicit?: number
  total?: number
  notes?: string
}

/** Classify response length into a bucket. */
export function lengthBucketOf(text: string): LengthBucket {
  const n = text.length
  if (n < 40) return 'xs'
  if (n < 200) return 's'
  if (n < 800) return 'm'
  return 'l'
}

/**
 * Record one action. Returns the new row id so the caller (or
 * reward-signals) can update reward later.
 */
export function recordAction(r: ActionRecord): number {
  const rl = getRL()
  const now = new Date()
  const s = r.state
  const stmt = rl.prepare(`
    INSERT INTO replay_buffer (
      timestamp, session_id, session_type,
      channel, hour, day_of_week, idle_seconds, screen_locked,
      budget_spent_today, budget_headroom_usd,
      active_missions, bg_queue_depth, onboarding_active, grown,
      conversation_depth,
      action_type, tone, length_bucket, tools_used, tool_count,
      character_form, content_type,
      action_cost, input_tokens, output_tokens,
      notes
    ) VALUES (
      @timestamp, @session_id, @session_type,
      @channel, @hour, @day_of_week, @idle_seconds, @screen_locked,
      @budget_spent_today, @budget_headroom_usd,
      @active_missions, @bg_queue_depth, @onboarding_active, @grown,
      @conversation_depth,
      @action_type, @tone, @length_bucket, @tools_used, @tool_count,
      @character_form, @content_type,
      @action_cost, @input_tokens, @output_tokens,
      @notes
    )
  `)
  const tools = r.toolsUsed ?? []
  const info = stmt.run({
    timestamp: now.toISOString(),
    session_id: r.sessionId ?? null,
    session_type: r.sessionType ?? null,
    channel: s.channel,
    hour: s.hour,
    day_of_week: s.dayOfWeek,
    idle_seconds: s.idleSeconds ?? 0,
    screen_locked: s.screenLocked ? 1 : 0,
    budget_spent_today: s.budgetSpentToday ?? 0,
    budget_headroom_usd: s.budgetHeadroomUsd ?? 0,
    active_missions: s.activeMissions ?? 0,
    bg_queue_depth: s.bgQueueDepth ?? 0,
    onboarding_active: s.onboardingActive ? 1 : 0,
    grown: s.grown ? 1 : 0,
    conversation_depth: s.conversationDepth ?? 0,
    action_type: r.actionType,
    tone: r.tone ?? null,
    length_bucket: r.lengthBucket ?? null,
    tools_used: JSON.stringify(tools),
    tool_count: tools.length,
    character_form: r.characterForm ?? null,
    content_type: r.contentType ?? null,
    action_cost: r.actionCost ?? 0,
    input_tokens: r.inputTokens ?? 0,
    output_tokens: r.outputTokens ?? 0,
    notes: r.notes ?? null,
  })
  return Number(info.lastInsertRowid)
}

/**
 * Patch reward for a single action. Adds to whatever was there so
 * signals from different sources can accumulate over time (engagement
 * at T+2min, explicit feedback at T+5min, outcome scoring on close).
 */
export function updateReward(id: number, patch: RewardPatch): void {
  const rl = getRL()
  const row = rl
    .prepare(
      `SELECT engagement_score, outcome_score, explicit_feedback, reward FROM replay_buffer WHERE id = ?`,
    )
    .get(id) as
    | {
        engagement_score: number
        outcome_score: number
        explicit_feedback: number
        reward: number
      }
    | undefined
  if (!row) return
  const engagement = row.engagement_score + (patch.engagement ?? 0)
  const outcome = row.outcome_score + (patch.outcome ?? 0)
  const explicit = row.explicit_feedback + (patch.explicit ?? 0)
  const total = patch.total ?? engagement + outcome + explicit
  rl.prepare(
    `UPDATE replay_buffer SET
       engagement_score = ?,
       outcome_score = ?,
       explicit_feedback = ?,
       reward = ?,
       reward_checked = 1,
       checked_at = ?,
       notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(
    engagement,
    outcome,
    explicit,
    total,
    new Date().toISOString(),
    patch.notes ?? null,
    id,
  )
}

/** Latest N rows for a session — used by reward-signals to find the action
 *  that corresponds to an incoming user message. */
export function recentActionsForSession(
  sessionType: string,
  sessionId: string | null,
  n = 5,
): Array<{
  id: number
  timestamp: string
  action_type: string
  channel: string
  reward: number
  reward_checked: number
}> {
  const rl = getRL()
  const rows = rl
    .prepare(
      `SELECT id, timestamp, action_type, channel, reward, reward_checked
       FROM replay_buffer
       WHERE session_type = ? AND (session_id IS ? OR session_id = ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionType, sessionId, sessionId, n) as Array<{
    id: number
    timestamp: string
    action_type: string
    channel: string
    reward: number
    reward_checked: number
  }>
  return rows
}

export function todayStats(): {
  totalActions: number
  totalCost: number
  totalReward: number
  netScore: number
} {
  const rl = getRL()
  const today = new Date().toISOString().slice(0, 10)
  const row = rl
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(action_cost),0) as cost,
              COALESCE(SUM(reward),0) as reward
       FROM replay_buffer WHERE timestamp >= ?`,
    )
    .get(today + 'T00:00:00') as { c: number; cost: number; reward: number }
  return {
    totalActions: row.c,
    totalCost: row.cost,
    totalReward: row.reward,
    netScore: row.reward - row.cost,
  }
}

export function writeDailySummary(date: string): void {
  const rl: DB = getRL()
  const row = rl
    .prepare(
      `SELECT
         COUNT(*) as total_actions,
         COALESCE(SUM(action_cost),0) as total_cost,
         COALESCE(SUM(reward),0) as total_reward
       FROM replay_buffer
       WHERE timestamp >= ? AND timestamp < ?`,
    )
    .get(date + 'T00:00:00', date + 'T24:00:00') as {
    total_actions: number
    total_cost: number
    total_reward: number
  }
  const best = rl
    .prepare(
      `SELECT action_type FROM replay_buffer
       WHERE timestamp >= ? AND timestamp < ? AND reward_checked = 1
       GROUP BY action_type ORDER BY AVG(reward) DESC LIMIT 1`,
    )
    .get(date + 'T00:00:00', date + 'T24:00:00') as
    | { action_type: string }
    | undefined
  const worst = rl
    .prepare(
      `SELECT action_type FROM replay_buffer
       WHERE timestamp >= ? AND timestamp < ? AND reward_checked = 1
       GROUP BY action_type ORDER BY AVG(reward) ASC LIMIT 1`,
    )
    .get(date + 'T00:00:00', date + 'T24:00:00') as
    | { action_type: string }
    | undefined
  rl.prepare(
    `INSERT OR REPLACE INTO daily_summary (
       date, total_actions, total_cost, total_reward, net_score,
       best_action_type, worst_action_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    date,
    row.total_actions,
    row.total_cost,
    row.total_reward,
    row.total_reward - row.total_cost,
    best?.action_type ?? null,
    worst?.action_type ?? null,
  )
}
