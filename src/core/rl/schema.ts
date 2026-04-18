/**
 * core/rl/schema.ts — the replay buffer, daily summary, and policy tables.
 *
 * A separate DB file (`~/.nina/rl.db`) from `nina.db` so the RL subsystem
 * can be wiped and re-seeded without touching conversations / tool_calls.
 *
 * Contextual-bandit shape, not full RL: every turn becomes one
 * (state, action, reward, cost) tuple. The learner is one SQL GROUP BY.
 * No ML deps. Port of the pattern from the user's nanoclaw fork, adapted
 * for Dot's action domain (reply / proactive / mission / cron / ritual).
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { NINA_DIR } from '../memory.js'

let db: Database.Database | null = null

export function initRLDatabase(): void {
  fs.mkdirSync(NINA_DIR, { recursive: true })
  const dbPath = path.join(NINA_DIR, 'rl.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    -- Every turn Dot takes. State before, action taken, reward observed later.
    CREATE TABLE IF NOT EXISTS replay_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      session_type TEXT,                 -- 'desktop' | 'tg:<chatId>' | 'cron:<name>' | 'mission:<id>' | 'proactive' | 'morning' | 'diary' | 'reflection'

      -- State (what the world looked like before the action)
      channel TEXT NOT NULL,             -- 'desktop' | 'telegram' | 'cron' | 'mission' | 'proactive' | 'morning' | 'diary' | 'reflection'
      hour INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      idle_seconds INTEGER DEFAULT 0,
      screen_locked INTEGER DEFAULT 0,
      budget_spent_today REAL DEFAULT 0,
      budget_headroom_usd REAL DEFAULT 0,
      active_missions INTEGER DEFAULT 0,
      bg_queue_depth INTEGER DEFAULT 0,
      onboarding_active INTEGER DEFAULT 0,
      grown INTEGER DEFAULT 0,
      conversation_depth INTEGER DEFAULT 0,   -- turns since last fresh session

      -- Action (what Dot did)
      action_type TEXT NOT NULL,         -- 'reply' | 'proactive' | 'mission_step' | 'cron_run' | 'ritual' | 'silent_work'
      tone TEXT,                         -- 'warm' | 'terse' | 'playful' | 'formal' | 'concerned' | null
      length_bucket TEXT,                -- 'xs' (<40) | 's' (40-200) | 'm' (200-800) | 'l' (>800) | null
      tools_used TEXT,                   -- JSON array of tool names (mcp__nina__*, Bash, Read, etc.)
      tool_count INTEGER DEFAULT 0,
      character_form TEXT,               -- which character / sprite form was active (for M9)
      content_type TEXT,                 -- 'short_answer' | 'long_explanation' | 'clarifying_question' | 'task_completion' | 'suggestion' | 'check_in' | 'refusal' | null

      -- Cost (tokens, paid in dollars)
      action_cost REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,

      -- Reward (filled later by reward-signals.ts)
      reward REAL DEFAULT 0,
      engagement_score REAL DEFAULT 0,   -- derived from user reply latency + sentiment
      outcome_score REAL DEFAULT 0,      -- tool success rate, task completion
      explicit_feedback REAL DEFAULT 0,  -- /feedback good|bad
      reward_checked INTEGER DEFAULT 0,
      checked_at TEXT,
      notes TEXT                          -- free-form for debugging
    );

    -- Per-day aggregates (one row per day)
    CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      total_actions INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_reward REAL DEFAULT 0,
      net_score REAL DEFAULT 0,
      best_action_type TEXT,
      worst_action_type TEXT,
      consecutive_negative INTEGER DEFAULT 0,
      notes TEXT
    );

    -- Learned preferences per state bucket (rebuilt by updatePolicy)
    CREATE TABLE IF NOT EXISTS policy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_bucket TEXT NOT NULL,        -- e.g. "channel:desktop|time:morning|idle:active"
      action_type TEXT NOT NULL,
      content_type TEXT,
      tone TEXT,
      length_bucket TEXT,
      avg_reward REAL DEFAULT 0,
      count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,          -- n / (n + 10)
      last_updated TEXT,
      UNIQUE(state_bucket, action_type, content_type, tone, length_bucket)
    );

    -- Onboarding-seeded priors. Written once from the onboarding flow,
    -- then used as cold-start recommendations until the policy has >= 2
    -- samples for a given bucket.
    CREATE TABLE IF NOT EXISTS priors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_bucket TEXT NOT NULL,
      action_type TEXT NOT NULL,
      content_type TEXT,
      tone TEXT,
      length_bucket TEXT,
      weight REAL DEFAULT 1.0,
      reason TEXT,
      created_at TEXT,
      UNIQUE(state_bucket, action_type, content_type, tone, length_bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_replay_timestamp ON replay_buffer(timestamp);
    CREATE INDEX IF NOT EXISTS idx_replay_checked ON replay_buffer(reward_checked);
    CREATE INDEX IF NOT EXISTS idx_replay_session ON replay_buffer(session_type, session_id);
    CREATE INDEX IF NOT EXISTS idx_replay_channel ON replay_buffer(channel);
    CREATE INDEX IF NOT EXISTS idx_replay_action ON replay_buffer(action_type);
  `)
}

export function getRL(): Database.Database {
  if (!db) initRLDatabase()
  return db!
}

/**
 * Reset the module-level handle — used by tests + the dev `dot_rl_reset`
 * tool. Does NOT delete the DB file.
 */
export function closeRL(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // ignore
    }
    db = null
  }
}
