/**
 * Proactive interrupts: every so often, Dot looks at what's happening and
 * decides whether to say something unprompted. Gated by presence (she never
 * interrupts when the user is idle / in a call / in Focus mode / screen locked)
 * and rate-limited so she isn't a pest.
 *
 * Design principles:
 *   - Default to silence. MOST ticks produce nothing.
 *   - Cheap: one LLM call per tick, no tool use.
 *   - Rate limited to at most one proactive message per 30 minutes.
 *   - Only fires when presence gates all pass.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadPersonality, loadMemoryIndex, MEMORY_DIR } from './memory.js'
import { ACTIVITY_LOG, type TickSignals } from './observation.js'
import { getAvailability } from './presence.js'
import { log } from './log.js'
import { createDotMcpServer } from './mcp-tools.js'

const execFileP = promisify(execFile)

const MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 min between proactive messages
const PROACTIVE_STATE_FILE = path.join(MEMORY_DIR, 'soul', 'proactive.json')

interface ProactiveState {
  lastFiredAt: number
}

function loadState(): ProactiveState {
  try {
    if (!fs.existsSync(PROACTIVE_STATE_FILE)) return { lastFiredAt: 0 }
    return JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, 'utf8'))
  } catch {
    return { lastFiredAt: 0 }
  }
}

function saveState(state: ProactiveState): void {
  try {
    fs.mkdirSync(path.dirname(PROACTIVE_STATE_FILE), { recursive: true })
    fs.writeFileSync(PROACTIVE_STATE_FILE, JSON.stringify(state), 'utf8')
  } catch {
    // ignore
  }
}

async function getFrontmostAppAndWindow(): Promise<{ app: string; window: string }> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      [
        '-e',
        `tell application "System Events"
           set frontApp to first application process whose frontmost is true
           set appName to name of frontApp
           try
             set winName to name of first window of frontApp
           on error
             set winName to ""
           end try
         end tell
         return appName & "|||" & winName`,
      ],
      { timeout: 2000 },
    )
    const [app = '', windowTitle = ''] = stdout.trim().split('|||')
    return { app, window: windowTitle.slice(0, 140) }
  } catch {
    return { app: '', window: '' }
  }
}

function readRecentActivity(maxBytes = 3_000): string {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return '(no activity log yet)'
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8')
    return raw.slice(-maxBytes)
  } catch {
    return '(activity log unavailable)'
  }
}

function buildAdvisoryPrompt(context: {
  app: string
  window: string
  localTime: string
  dayOfWeek: string
  recentActivity: string
  memoryIndex: string
  signals: TickSignals
}): string {
  const reasons: string[] = []
  if (context.signals.dwellMinutes >= 20)
    reasons.push(`dwell: ${context.signals.dwellMinutes}min on same window`)
  if (context.signals.returnedToProject)
    reasons.push(`returned to project: ${context.signals.returnedToProject}`)
  if (context.signals.errorOnScreen) reasons.push('error/traceback visible in window title')
  if (context.signals.meaningfulChange)
    reasons.push(
      `context switch: left previous window after ${context.signals.prevDwellMinutes}min`,
    )

  return `[Advisory check — the local tick saw something worth a closer look.]

You're Dot. A dumb local check flagged this moment. Your job is to decide:
is there ONE short, useful thing to say to the user right now? If yes, say it.
If not, say NOTHING. Lean toward speaking — the tick already filtered out noise.

Why you were woken up:
${reasons.map((r) => `- ${r}`).join('\n')}

Context:
- Time: ${context.localTime} (${context.dayOfWeek})
- Frontmost app: ${context.app || 'unknown'}
- Active window: ${context.window || '(none)'}

Recent activity (tail):
${context.recentActivity.slice(-1200)}

Memory index:
${context.memoryIndex.slice(0, 800)}

Output rules — pick ONE:
- NOTHING (exact word, alone) — nothing worth saying.
- A single short line (<80 chars) in Dot's voice, lowercase-ish, warm-dry,
  like a sticky note. No greeting, no "I noticed", just the thing.
- ESCALATE: <one-sentence reason> — use this ONLY if the situation is
  genuinely complex (multi-signal synthesis, memory lookup you can't do,
  delicate timing) and a more capable model should take the call.
  Prefer speaking over escalating. Escalate at most ~1 in 20 advisories.

Good tone:
  "stuck on that stack trace a while — want me to search for it?"
  "back in the nadir repo. pick up where you left off?"
  "it's friday. auth PR still open?"

Bad tone:
  "Hi! How's it going?"
  "Just checking in!"
  "Let me know if you need help!"`
}

async function runOpusEscalation(ctx: {
  app: string
  window: string
  localTime: string
  dayOfWeek: string
  recentActivity: string
  memoryIndex: string
  signals: TickSignals
  haikuReason: string
}): Promise<string | null> {
  const prompt = `[Escalated advisory — the small triage model asked for you.]

You're Dot. A cheap triage pass just ran and decided this moment needs
your judgment. Read the context and decide: ONE short line to say, or NOTHING.
Lean toward speaking — you were only woken because it's genuinely ambiguous.

Why Haiku escalated:
${ctx.haikuReason}

Signals:
- dwell: ${ctx.signals.dwellMinutes}min
- returned to project: ${ctx.signals.returnedToProject ?? 'no'}
- error on screen: ${ctx.signals.errorOnScreen}

Context:
- Time: ${ctx.localTime} (${ctx.dayOfWeek})
- Frontmost app: ${ctx.app || 'unknown'}
- Window: ${ctx.window || '(none)'}

Recent activity:
${ctx.recentActivity.slice(-2500)}

Memory index:
${ctx.memoryIndex.slice(0, 1500)}

You may call a few cheap READ-ONLY tools to ground your judgment before
speaking: search_memory, calendar_today, gmail_unread_count, mission_list,
token_stats, screen_now. Call at most 2 of them. Do NOT call any tool that
changes state. After grounding, output one short line OR "NOTHING".

Output: NOTHING, or one short line (<80 chars) in Dot's voice. No greeting.`

  try {
    const mcpServer = createDotMcpServer()
    const iter = query({
      prompt,
      options: {
        model: 'claude-opus-4-6',
        systemPrompt: loadPersonality(),
        mcpServers: { nina: mcpServer },
        allowedTools: [
          'mcp__nina__search_memory',
          'mcp__nina__calendar_today',
          'mcp__nina__gmail_unread_count',
          'mcp__nina__mission_list',
          'mcp__nina__token_stats',
          'mcp__nina__screen_now',
          'mcp__nina__think',
        ],
        permissionMode: 'bypassPermissions',
      },
    })
    let out = ''
    for await (const msg of iter) {
      if (msg.type === 'assistant') {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') out += block.text
          }
        }
      }
    }
    const trimmed = out.trim()
    if (!trimmed || /^NOTHING\b/i.test(trimmed)) return null
    return trimmed.split('\n')[0]!.trim().slice(0, 140) || null
  } catch {
    return null
  }
}

export interface ProactiveResult {
  message: string | null
  reason: string | null
}

/**
 * Run an advisory check. Called by observation.ts only when cheap local
 * signals indicate something worth looking at. Respects presence gates
 * and rate limits. Best-effort, never throws.
 */
export async function runAdvisory(signals: TickSignals): Promise<ProactiveResult> {
  // 1. Rate limit
  const state = loadState()
  const now = Date.now()
  const sinceLast = Math.round((now - state.lastFiredAt) / 60_000)
  if (now - state.lastFiredAt < MIN_INTERVAL_MS) {
    log('advisory.rate-limited', { sinceLastMin: sinceLast })
    return { message: null, reason: 'rate-limited' }
  }

  // 2. Presence gates
  const availability = await getAvailability()
  if (!availability.available) {
    log('advisory.presence-blocked', { reason: availability.reason })
    return { message: null, reason: availability.reason }
  }

  // 3. Gather context
  const { app, window: winTitle } = await getFrontmostAppAndWindow()
  if (/Dot|Electron/.test(app)) {
    log('advisory.skipped', { reason: 'frontmost is dot' })
    return { message: null, reason: 'frontmost is nina' }
  }
  log('advisory.haiku-call', { app, window: winTitle, dwell: signals.dwellMinutes })

  const now2 = new Date()
  const localTime = now2.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const dayOfWeek = now2.toLocaleDateString(undefined, { weekday: 'long' })
  const recentActivity = readRecentActivity(2500)
  const memoryIndex = loadMemoryIndex()

  const prompt = buildAdvisoryPrompt({
    app,
    window: winTitle,
    localTime,
    dayOfWeek,
    recentActivity,
    memoryIndex,
    signals,
  })

  // 4. One-shot LLM call on Haiku — cheap classifier, no tools
  try {
    const iter = query({
      prompt,
      options: {
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: loadPersonality(),
        allowedTools: [],
        permissionMode: 'bypassPermissions',
      },
    })

    let output = ''
    for await (const msg of iter) {
      if (msg.type === 'assistant') {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              output += block.text
            }
          }
        }
      }
    }

    const trimmed = output.trim()
    if (!trimmed || /^NOTHING\b/i.test(trimmed) || trimmed === 'NOTHING') {
      log('advisory.haiku-nothing', {})
      return { message: null, reason: 'haiku said nothing' }
    }

    // Haiku asked for the big model
    const escalateMatch = trimmed.match(/^ESCALATE:\s*(.+)$/im)
    if (escalateMatch) {
      const escalationReason = escalateMatch[1]!.trim()
      log('advisory.haiku-escalate', { reason: escalationReason })
      const opusLine = await runOpusEscalation({
        app,
        window: winTitle,
        localTime,
        dayOfWeek,
        recentActivity,
        memoryIndex,
        signals,
        haikuReason: escalationReason,
      })
      if (!opusLine) {
        log('advisory.opus-nothing', {})
        return { message: null, reason: 'opus said nothing' }
      }
      log('advisory.opus-spoke', { message: opusLine })
      saveState({ lastFiredAt: now })
      return { message: opusLine, reason: `escalated: ${escalationReason}` }
    }

    // Take only the first line, cap length
    const firstLine = trimmed.split('\n')[0]!.trim().slice(0, 140)
    if (!firstLine) {
      return { message: null, reason: 'empty response' }
    }

    // 5. Mark fired
    log('advisory.haiku-spoke', { message: firstLine })
    saveState({ lastFiredAt: now })

    return { message: firstLine, reason: null }
  } catch (err) {
    const emsg = err instanceof Error ? err.message : String(err)
    log('advisory.error', { err: emsg })
    return { message: null, reason: `error: ${emsg}` }
  }
}
