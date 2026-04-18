/**
 * core/rl/policy.ts — rebuild the advisory policy from the replay buffer,
 * render a markdown report, and surface cold-start priors when there's
 * not enough data yet.
 *
 * The agent reads the markdown report via the `rl_policy` MCP tool; the
 * recommendations are advisory, not executive. We never route around the
 * agent — mode collapse risk is too high and debugging is a nightmare.
 */
import { getRL } from './schema.js'

export interface PolicyRow {
  actionType: string
  contentType: string | null
  tone: string | null
  lengthBucket: string | null
  avgReward: number
  count: number
  confidence: number
}

/** Canonical state-bucket key. Keep coarse — fine buckets starve for data. */
export function bucketKey(s: {
  channel: string
  hour: number
  idleSeconds?: number
  screenLocked?: boolean
  onboardingActive?: boolean
}): string {
  const time =
    s.hour >= 6 && s.hour <= 11
      ? 'morning'
      : s.hour >= 12 && s.hour <= 17
        ? 'afternoon'
        : s.hour >= 18 && s.hour <= 22
          ? 'evening'
          : 'night'
  const idle = (s.idleSeconds ?? 0) > 300 ? 'away' : 'active'
  const lock = s.screenLocked ? 'locked' : 'unlocked'
  const onb = s.onboardingActive ? 'onboarding' : 'normal'
  return `channel:${s.channel}|time:${time}|idle:${idle}|lock:${lock}|mode:${onb}`
}

/** Rebuild the `policy` table from `replay_buffer`. */
export function updatePolicy(): void {
  const rl = getRL()
  rl.exec(`DELETE FROM policy;`)
  // We rebuild from rows that have a reward recorded. The SQL mirrors
  // bucketKey() above — keep them in sync.
  rl.prepare(
    `
    INSERT INTO policy (state_bucket, action_type, content_type, tone, length_bucket,
                        avg_reward, count, confidence, last_updated)
    SELECT
      'channel:' || channel || '|time:' ||
        CASE
          WHEN hour BETWEEN 6 AND 11 THEN 'morning'
          WHEN hour BETWEEN 12 AND 17 THEN 'afternoon'
          WHEN hour BETWEEN 18 AND 22 THEN 'evening'
          ELSE 'night'
        END || '|idle:' ||
        CASE WHEN idle_seconds > 300 THEN 'away' ELSE 'active' END || '|lock:' ||
        CASE WHEN screen_locked = 1 THEN 'locked' ELSE 'unlocked' END || '|mode:' ||
        CASE WHEN onboarding_active = 1 THEN 'onboarding' ELSE 'normal' END AS bucket,
      action_type,
      content_type,
      tone,
      length_bucket,
      AVG(reward) AS avg_reward,
      COUNT(*) AS count,
      CAST(COUNT(*) AS REAL) / (COUNT(*) + 10.0) AS confidence,
      datetime('now')
    FROM replay_buffer
    WHERE reward_checked = 1
    GROUP BY bucket, action_type, content_type, tone, length_bucket
    HAVING COUNT(*) >= 2;
  `,
  ).run()
}

/**
 * Fetch recommendations for the current state. Combines learned policy
 * rows with onboarding-seeded priors (lower weight) so cold-start days
 * still return something useful.
 */
export function recommendations(bucket: string, limit = 10): PolicyRow[] {
  const rl = getRL()
  const learned = rl
    .prepare(
      `SELECT action_type, content_type, tone, length_bucket,
              avg_reward, count, confidence
       FROM policy
       WHERE state_bucket = ?
       ORDER BY (avg_reward * confidence) DESC
       LIMIT ?`,
    )
    .all(bucket, limit) as Array<{
    action_type: string
    content_type: string | null
    tone: string | null
    length_bucket: string | null
    avg_reward: number
    count: number
    confidence: number
  }>

  if (learned.length >= 3) {
    return learned.map((r) => ({
      actionType: r.action_type,
      contentType: r.content_type,
      tone: r.tone,
      lengthBucket: r.length_bucket,
      avgReward: r.avg_reward,
      count: r.count,
      confidence: r.confidence,
    }))
  }

  const priorRows = rl
    .prepare(
      `SELECT action_type, content_type, tone, length_bucket, weight, reason
       FROM priors WHERE state_bucket = ?
       ORDER BY weight DESC LIMIT ?`,
    )
    .all(bucket, limit) as Array<{
    action_type: string
    content_type: string | null
    tone: string | null
    length_bucket: string | null
    weight: number
    reason: string | null
  }>

  // Merge — learned rows first, then priors not already covered.
  const seen = new Set(
    learned.map(
      (r) => `${r.action_type}|${r.content_type}|${r.tone}|${r.length_bucket}`,
    ),
  )
  const priors: PolicyRow[] = priorRows
    .filter(
      (p) =>
        !seen.has(
          `${p.action_type}|${p.content_type}|${p.tone}|${p.length_bucket}`,
        ),
    )
    .map((p) => ({
      actionType: p.action_type,
      contentType: p.content_type,
      tone: p.tone,
      lengthBucket: p.length_bucket,
      avgReward: p.weight,
      count: 0,
      confidence: 0.2,
    }))
  return [
    ...learned.map((r) => ({
      actionType: r.action_type,
      contentType: r.content_type,
      tone: r.tone,
      lengthBucket: r.length_bucket,
      avgReward: r.avg_reward,
      count: r.count,
      confidence: r.confidence,
    })),
    ...priors,
  ].slice(0, limit)
}

/** Find an undersampled action combination — Dot should occasionally try it. */
export function explorationSuggestion(
  bucket: string,
): { actionType: string; contentType: string | null; reason: string } | null {
  const rl = getRL()
  // Build the universe of Dot-appropriate (action_type, content_type) combos.
  const candidates: Array<{ action: string; content: string | null }> = [
    { action: 'reply', content: 'short_answer' },
    { action: 'reply', content: 'long_explanation' },
    { action: 'reply', content: 'clarifying_question' },
    { action: 'reply', content: 'task_completion' },
    { action: 'reply', content: 'suggestion' },
    { action: 'proactive', content: 'check_in' },
    { action: 'proactive', content: 'suggestion' },
    { action: 'ritual', content: 'check_in' },
  ]
  for (const c of candidates) {
    const row = rl
      .prepare(
        `SELECT COUNT(*) as c FROM replay_buffer
         WHERE action_type = ? AND content_type IS ?
           AND reward_checked = 1
           AND 'channel:' || channel || '|time:' ||
               CASE
                 WHEN hour BETWEEN 6 AND 11 THEN 'morning'
                 WHEN hour BETWEEN 12 AND 17 THEN 'afternoon'
                 WHEN hour BETWEEN 18 AND 22 THEN 'evening'
                 ELSE 'night'
               END || '|idle:' ||
               CASE WHEN idle_seconds > 300 THEN 'away' ELSE 'active' END || '|lock:' ||
               CASE WHEN screen_locked = 1 THEN 'locked' ELSE 'unlocked' END || '|mode:' ||
               CASE WHEN onboarding_active = 1 THEN 'onboarding' ELSE 'normal' END = ?`,
      )
      .get(c.action, c.content, bucket) as { c: number }
    if (row.c < 3) {
      return {
        actionType: c.action,
        contentType: c.content,
        reason: `only ${row.c} sample(s) in ${bucket} for ${c.action}/${c.content} — try it to learn`,
      }
    }
  }
  return null
}

export function generateReport(bucket: string): string {
  const rl = getRL()
  const stats = rl
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN reward_checked = 1 THEN 1 ELSE 0 END) as checked,
              AVG(CASE WHEN reward_checked = 1 THEN reward END) as avg_reward,
              MAX(CASE WHEN reward_checked = 1 THEN reward END) as max_reward,
              MIN(CASE WHEN reward_checked = 1 THEN reward END) as min_reward
       FROM replay_buffer`,
    )
    .get() as {
    total: number
    checked: number
    avg_reward: number | null
    max_reward: number | null
    min_reward: number | null
  }

  const recs = recommendations(bucket, 8)
  const explore = explorationSuggestion(bucket)

  const lines: string[] = []
  lines.push(`## RL policy report`)
  lines.push(`Bucket: \`${bucket}\``)
  lines.push(
    `Replay: ${stats.total} actions, ${stats.checked} with reward. ` +
      `avg=${stats.avg_reward?.toFixed(2) ?? 'n/a'} ` +
      `max=${stats.max_reward?.toFixed(1) ?? 'n/a'} ` +
      `min=${stats.min_reward?.toFixed(1) ?? 'n/a'}`,
  )
  lines.push('')
  if (recs.length === 0) {
    lines.push(
      `No learned policy yet for this bucket. Follow your usual instincts; ` +
        `every action becomes a new data point.`,
    )
  } else {
    lines.push(`### Recommended moves here`)
    recs.forEach((r, i) => {
      const bits = [r.actionType]
      if (r.contentType) bits.push(r.contentType)
      if (r.tone) bits.push(`${r.tone}-tone`)
      if (r.lengthBucket) bits.push(`${r.lengthBucket}-length`)
      const evidence =
        r.count === 0
          ? `prior (w=${r.avgReward.toFixed(1)})`
          : `avg=${r.avgReward.toFixed(2)} conf=${(r.confidence * 100).toFixed(0)}% n=${r.count}`
      lines.push(`${i + 1}. ${bits.join(' · ')} — ${evidence}`)
    })
  }

  if (explore) {
    lines.push('')
    lines.push(`### Exploration nudge`)
    lines.push(`- ${explore.reason}`)
    lines.push(
      `- If appropriate for the user's actual request, try ${explore.actionType}/${explore.contentType}.`,
    )
  }

  lines.push('')
  lines.push(
    `Selection rule: ~80% exploit (follow the list above), ~20% explore ` +
      `(the nudge, or something new). Never contort the reply to match — the ` +
      `user's actual need always wins. Policy is advisory.`,
  )
  return lines.join('\n')
}

/** Seed the priors table from an external source (onboarding). */
export function setPriors(
  rows: Array<{
    bucket: string
    actionType: string
    contentType?: string | null
    tone?: string | null
    lengthBucket?: string | null
    weight?: number
    reason?: string
  }>,
): void {
  const rl = getRL()
  const stmt = rl.prepare(
    `INSERT OR REPLACE INTO priors
       (state_bucket, action_type, content_type, tone, length_bucket,
        weight, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
  const tx = rl.transaction(
    (
      xs: Array<{
        bucket: string
        actionType: string
        contentType?: string | null
        tone?: string | null
        lengthBucket?: string | null
        weight?: number
        reason?: string
      }>,
    ) => {
      for (const p of xs) {
        stmt.run(
          p.bucket,
          p.actionType,
          p.contentType ?? null,
          p.tone ?? null,
          p.lengthBucket ?? null,
          p.weight ?? 1.0,
          p.reason ?? null,
        )
      }
    },
  )
  tx(rows)
}

/** Built-in defaults installed on first boot — updated/overridden by onboarding. */
export function seedDefaultPriors(): void {
  const rl = getRL()
  const existing = rl.prepare(`SELECT COUNT(*) as c FROM priors`).get() as {
    c: number
  }
  if (existing.c > 0) return
  setPriors([
    // Morning desktop: quick, warm, short answers.
    {
      bucket: 'channel:desktop|time:morning|idle:active|lock:unlocked|mode:normal',
      actionType: 'reply',
      contentType: 'short_answer',
      tone: 'warm',
      lengthBucket: 's',
      weight: 3.0,
      reason: 'starting the day — keep it tight and friendly',
    },
    // Evening desktop: more patience for long explanations.
    {
      bucket: 'channel:desktop|time:evening|idle:active|lock:unlocked|mode:normal',
      actionType: 'reply',
      contentType: 'long_explanation',
      tone: 'warm',
      lengthBucket: 'm',
      weight: 2.5,
      reason: 'user has time in the evening — teach, don\'t just answer',
    },
    // Telegram anywhere: brief.
    {
      bucket: 'channel:telegram|time:morning|idle:active|lock:unlocked|mode:normal',
      actionType: 'reply',
      contentType: 'short_answer',
      tone: 'terse',
      lengthBucket: 'xs',
      weight: 3.5,
      reason: 'mobile user — one paragraph max',
    },
    {
      bucket: 'channel:telegram|time:afternoon|idle:active|lock:unlocked|mode:normal',
      actionType: 'reply',
      contentType: 'short_answer',
      tone: 'terse',
      lengthBucket: 'xs',
      weight: 3.5,
      reason: 'mobile user — one paragraph max',
    },
    // Proactive: only when away / locked.
    {
      bucket: 'channel:proactive|time:afternoon|idle:away|lock:unlocked|mode:normal',
      actionType: 'proactive',
      contentType: 'check_in',
      tone: 'warm',
      lengthBucket: 'xs',
      weight: 2.0,
      reason: 'user stepped away — a gentle check-in lands well',
    },
    {
      bucket: 'channel:proactive|time:evening|idle:away|lock:locked|mode:normal',
      actionType: 'proactive',
      contentType: 'suggestion',
      tone: 'warm',
      lengthBucket: 's',
      weight: 1.8,
      reason: 'screen locked — push to telegram if something notable happened',
    },
    // Onboarding: always ask questions.
    {
      bucket: 'channel:desktop|time:morning|idle:active|lock:unlocked|mode:onboarding',
      actionType: 'reply',
      contentType: 'clarifying_question',
      tone: 'warm',
      lengthBucket: 's',
      weight: 4.0,
      reason: 'onboarding — every turn should end with a question that reveals the user',
    },
  ])
}
