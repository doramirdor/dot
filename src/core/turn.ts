/**
 * core/turn.ts — the single agent-turn primitive.
 *
 * Every entry point that runs Claude on Dot's behalf goes through here:
 *   - desktop chat (via the main window IPC)
 *   - telegram.ts (inbound messages + proactive push)
 *   - cron.ts (scheduled tasks)
 *   - missions.ts (long-running background work)
 *   - proactive.ts (ambient suggestions)
 *   - morning.ts / diary.ts / reflection.ts (daily rituals)
 *
 * Before this primitive existed, each of those modules independently
 * called runAgent() with its own ad-hoc prompt assembly. That meant
 * situational context (what time is it? what's queued? what's the budget?)
 * was missing from every call site, and policy/memory/audit were
 * re-implemented or forgotten per caller. See the 8-agent review synthesis
 * in CLAUDE.md history for the rationale.
 *
 * This file is deliberately thin. It is NOT the PolicyService — the trust
 * layer still lives in trust.ts and is wired via canUseTool inside
 * runAgent(). Week 3-4 will move policy into a proper service and route
 * it through here.
 */
import { runAgent, type AgentCallbacks, type ChannelContext, type RunOptions } from './agent.js'
import { bgQueueDepth, bgCurrent } from './bg-queue.js'
import { listTasks as cronListTasks } from './cron.js'
import { listMissions } from './missions.js'
import { getDb, getTokenStats } from './db.js'
import { getIdleSeconds, isScreenLocked } from './presence.js'
import { loadConfig } from './config.js'
import { isOnboardingActive } from './soul.js'
import {
  recordAction,
  scoreOnIncomingUserMessage,
  scoreToolOutcomes,
  lengthBucketOf,
  type ActionType,
  type ContentType,
} from './rl/index.js'

export interface RunTurnOptions {
  /** Required — where this turn came from. */
  channel: string
  /** Optional human-readable label (e.g. "tg:12345", "cron:morning-brief"). */
  label?: string
  /** Free-form extras rendered inside the situational frame. */
  extras?: Record<string, string | number | boolean | null>
  /** Pass-through to runAgent — continue vs fresh session. */
  continueSession?: boolean
  freshSession?: boolean
  /**
   * Session key used for RL's replay buffer grouping. Defaults to
   * `channel` — callers should pass something more specific for
   * per-telegram-chat or per-mission isolation (e.g. `tg:12345`,
   * `mission:abc`).
   */
  sessionType?: string
  /**
   * Which RL action bucket this turn belongs to. Defaults are derived
   * from `channel`: 'desktop' | 'telegram' → 'reply', 'cron' → 'cron_run',
   * 'mission' → 'mission_step', 'proactive' → 'proactive',
   * 'morning'|'diary'|'reflection' → 'ritual'.
   */
  rlAction?: ActionType
  /**
   * Optional — caller's own classification of the content they're asking
   * for. Usually left undefined; the agent's response shape is more
   * informative than the prompt's.
   */
  rlContentType?: ContentType
}

/**
 * Collect situational data the agent should know about at the start of
 * a turn: time, idle state, queue depth, today's budget usage, active
 * missions, upcoming crons. Best-effort — every getter is guarded, so
 * a failure in one subsystem never blocks the turn.
 */
function collectSituation(): Record<string, string | number | boolean | null> {
  const extras: Record<string, string | number | boolean | null> = {}

  // Presence
  try {
    extras['idle_seconds'] = getIdleSeconds()
    extras['screen_locked'] = isScreenLocked()
  } catch {
    // ignore
  }

  // Background queue
  try {
    extras['bg_queue_depth'] = bgQueueDepth()
    const cur = bgCurrent()
    if (cur) {
      extras['bg_current'] = cur
    }
  } catch {
    // ignore
  }

  // Budget — foreground isn't blocked by it, but Dot should know how
  // much headroom she has for autonomous work today.
  try {
    const stats = getTokenStats()
    extras['today_cost_usd'] = Number((stats.todayCostUsd ?? 0).toFixed(4))
    const cap = loadConfig().dailyBudgetUsd
    extras['daily_budget_cap_usd'] = cap
    if (cap > 0) {
      const used = stats.todayCostUsd ?? 0
      extras['budget_headroom_usd'] = Number(Math.max(0, cap - used).toFixed(4))
    }
  } catch {
    // ignore
  }

  // Missions — just count active + next milestone if any. The agent
  // can call mission_list for detail when it actually needs it.
  try {
    const missions = listMissions()
    const active = missions.filter((m) => m.status === 'active')
    extras['active_missions'] = active.length
    if (active.length > 0) {
      extras['active_mission_goals'] = active
        .slice(0, 3)
        .map((m) => m.goal)
        .join(' | ')
    }
  } catch {
    // ignore
  }

  // Cron — count enabled tasks and surface names of the next 3.
  try {
    const tasks = cronListTasks().filter((t) => t.enabled)
    extras['cron_tasks_enabled'] = tasks.length
    if (tasks.length > 0) {
      extras['cron_tasks'] = tasks
        .slice(0, 3)
        .map((t) => `${t.name}@${t.cron}`)
        .join(' | ')
    }
  } catch {
    // ignore
  }

  return extras
}

/**
 * Run one agent turn through the unified core loop.
 *
 * Adds a situational frame to the system prompt, logs the channel in
 * telemetry, and delegates to runAgent() for the actual LLM call and
 * tool dispatch. All policy/trust/memory plumbing remains inside
 * runAgent for now — this primitive is about unifying the entry point
 * and giving Dot situational awareness, not about replacing the existing
 * trust layer.
 */
function defaultRlAction(channel: string): ActionType {
  switch (channel) {
    case 'cron':
      return 'cron_run'
    case 'mission':
      return 'mission_step'
    case 'proactive':
      return 'proactive'
    case 'morning':
    case 'diary':
    case 'reflection':
      return 'ritual'
    case 'desktop':
    case 'telegram':
    default:
      return 'reply'
  }
}

function inferContentType(text: string): ContentType {
  const t = text.trim()
  if (!t) return 'short_answer'
  if (/\?\s*$/.test(t) && t.length < 400) return 'clarifying_question'
  if (t.length < 180) return 'short_answer'
  if (/(here'?s|step \d|^\d\.\s)/im.test(t)) return 'long_explanation'
  if (/(done|completed|finished|created|wrote|updated)/i.test(t.slice(0, 120)))
    return 'task_completion'
  if (/(you could|consider|maybe|suggest|try)/i.test(t.slice(0, 200)))
    return 'suggestion'
  return 'long_explanation'
}

export async function runTurn(
  prompt: string,
  callbacks: AgentCallbacks,
  opts: RunTurnOptions,
): Promise<{ abort: () => void }> {
  const situation = collectSituation()

  const channelContext: ChannelContext = {
    channel: opts.channel,
    label: opts.label,
    extras: {
      ...situation,
      ...(opts.extras ?? {}),
    },
  }

  const runOpts: RunOptions = {
    continueSession: opts.continueSession,
    freshSession: opts.freshSession,
    channelContext,
  }

  const sessionType = opts.sessionType ?? opts.channel
  const isForeground = opts.channel === 'desktop' || opts.channel === 'telegram'

  // Step 1: before running the new turn, score whatever Dot did last
  // in this session. The user's new message IS the reward signal for
  // the previous action — latency + sentiment. Only do this for
  // foreground channels where the user is the one who produced `prompt`.
  if (isForeground) {
    try {
      scoreOnIncomingUserMessage({
        sessionType,
        sessionId: null,
        userText: prompt,
      })
    } catch (err) {
      console.warn('[turn] rl score-in failed:', err)
    }
  }

  // Step 2: wrap callbacks so we can capture assistant text + tools
  // actually used, then record the action after the turn completes.
  const startedAtIso = new Date().toISOString()
  const startedAtMs = Date.now()
  let assistantText = ''
  const toolsUsed: string[] = []

  const wrappedCallbacks: AgentCallbacks = {
    onText: (t) => {
      assistantText += t
      callbacks.onText(t)
    },
    onTool: (name, input) => {
      toolsUsed.push(name)
      callbacks.onTool(name, input)
    },
    onDone: () => {
      // Fire-and-forget — the RL write shouldn't block onDone.
      try {
        recordTurnAction({
          channel: opts.channel,
          rlAction: opts.rlAction ?? defaultRlAction(opts.channel),
          rlContentType: opts.rlContentType,
          sessionType,
          assistantText,
          toolsUsed,
          startedAtIso,
          startedAtMs,
          situation,
        })
      } catch (err) {
        console.warn('[turn] rl recordAction failed:', err)
      }
      callbacks.onDone()
    },
    onError: callbacks.onError,
    onPermissionRequest: callbacks.onPermissionRequest,
  }

  return runAgent(prompt, wrappedCallbacks, runOpts)
}

/**
 * After a turn finishes, write the replay row. Pulls the real
 * token-usage / cost for this turn out of `token_usage` by time window —
 * agent.ts writes there synchronously before it calls onDone.
 */
function recordTurnAction(args: {
  channel: string
  rlAction: ActionType
  rlContentType?: ContentType
  sessionType: string
  assistantText: string
  toolsUsed: string[]
  startedAtIso: string
  startedAtMs: number
  situation: Record<string, string | number | boolean | null>
}): void {
  const { channel, rlAction, sessionType, assistantText, toolsUsed } = args
  const endedAtIso = new Date().toISOString()
  const endedAtMs = Date.now()
  // Pull this turn's token usage out of the token_usage table by time
  // window — cheap and avoids threading values through callbacks.
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  try {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens),0) as i,
           COALESCE(SUM(output_tokens),0) as o,
           COALESCE(SUM(cost_usd),0) as c
         FROM token_usage WHERE timestamp >= ? AND timestamp <= ?`,
      )
      .get(args.startedAtIso, endedAtIso) as {
      i: number
      o: number
      c: number
    }
    inputTokens = row.i
    outputTokens = row.o
    costUsd = row.c
  } catch {
    // ok — best-effort
  }

  const now = new Date(endedAtMs)
  const now2 = new Date(args.startedAtMs)
  const situation = args.situation
  const actionId = recordAction({
    state: {
      channel,
      hour: now2.getHours(),
      dayOfWeek: now2.getDay(),
      idleSeconds: Number(situation['idle_seconds'] ?? 0),
      screenLocked: situation['screen_locked'] === true,
      budgetSpentToday: Number(situation['today_cost_usd'] ?? 0),
      budgetHeadroomUsd:
        situation['budget_headroom_usd'] === undefined
          ? 0
          : Number(situation['budget_headroom_usd']),
      activeMissions: Number(situation['active_missions'] ?? 0),
      bgQueueDepth: Number(situation['bg_queue_depth'] ?? 0),
      onboardingActive: (() => {
        try {
          return isOnboardingActive()
        } catch {
          return false
        }
      })(),
      grown: false,
      conversationDepth: 0,
    },
    actionType: rlAction,
    tone: null,
    lengthBucket: lengthBucketOf(assistantText),
    toolsUsed,
    contentType: args.rlContentType ?? inferContentType(assistantText),
    characterForm: null,
    actionCost: costUsd,
    inputTokens,
    outputTokens,
    sessionType,
    sessionId: null,
    notes: `dur_ms=${endedAtMs - args.startedAtMs}`,
  })

  // Record tool-outcome score against the just-recorded action. Done
  // after the DB write so the row id exists.
  try {
    scoreToolOutcomes(actionId, args.startedAtIso, now.toISOString())
  } catch {
    // best-effort
  }
}
