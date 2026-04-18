/**
 * core/consolidation.ts — short-tick memory consolidation.
 *
 * The daily reflection (reflection.ts) already runs a full pass at
 * reflectionHour, but once-per-day means the mindmap can go 20+ hours
 * stale and new facts from the afternoon aren't searchable until
 * tomorrow. This module runs a cheap pass every 20 minutes:
 *
 *   1. reflect() over the last 2 hours — heuristic fact extraction from
 *      conversations into type='fact' rows.
 *   2. If any new facts landed, regenerate ~/.dot/memory/mindmap.md
 *      from the top facts, bucketed by simple regex (projects, tools,
 *      identity, preferences). No LLM call — deterministic, free, idem-
 *      potent. The nightly reflection still overwrites with a curated
 *      mermaid diagram if it wants to.
 *
 * This is the "always evolving" part of memory. Long-term semantic
 * recall stays warm, the mindmap doesn't go stale, and none of it costs
 * a token.
 */
import fs from 'node:fs'
import { reflect } from './memory-service.js'
import { remember as semanticRemember } from './semantic-memory.js'
import { getDb } from './db.js'
import { MINDMAP_FILE, ensureMemoryDir } from './memory.js'

const DEFAULT_INTERVAL_MS = 20 * 60 * 1000 // 20 minutes
let timer: NodeJS.Timeout | null = null
let lastRunAt: number | null = null

export interface ConsolidationResult {
  extractedFacts: number
  mindmapUpdated: boolean
  summariesWritten: number
  durationMs: number
}

/**
 * Run one consolidation pass. Safe to call ad-hoc (e.g. from a tray menu
 * item) — does not race with the timer because the heuristics are idem-
 * potent and the mindmap write is atomic.
 */
export async function runConsolidation(): Promise<ConsolidationResult> {
  const started = Date.now()
  let extractedFacts = 0
  let mindmapUpdated = false
  let summariesWritten = 0

  try {
    const result = await reflect(2) // last 2 hours of conversation
    extractedFacts = result.extracted
  } catch (err) {
    console.warn('[consolidation] reflect failed:', (err as Error).message)
  }

  try {
    mindmapUpdated = regenerateMindmap()
  } catch (err) {
    console.warn('[consolidation] mindmap regen failed:', (err as Error).message)
  }

  // Session summaries: cheap heuristic rollup of each session's last 24h
  // of turns into a single type='summary' row. Runs at most once per day
  // per session — tracked by a lightweight meta table — so the tick
  // doesn't churn. Gives broad "what did we talk about this week"
  // queries a coherent chunk to retrieve instead of 200 fragments.
  try {
    summariesWritten = await writeSessionSummariesIfDue()
  } catch (err) {
    console.warn('[consolidation] summary rollup failed:', (err as Error).message)
  }

  lastRunAt = Date.now()
  return {
    extractedFacts,
    mindmapUpdated,
    summariesWritten,
    durationMs: Date.now() - started,
  }
}

export function startConsolidationLoop(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return
  // Fire a pass a minute after boot — not immediately, so startup stays
  // snappy — then on the regular cadence.
  timer = setTimeout(async function tick() {
    try {
      const r = await runConsolidation()
      if (r.extractedFacts > 0 || r.mindmapUpdated) {
        console.log(
          `[consolidation] tick: ${r.extractedFacts} facts, mindmap=${r.mindmapUpdated}, ${r.durationMs}ms`,
        )
      }
    } catch (err) {
      console.warn('[consolidation] tick error:', (err as Error).message)
    } finally {
      timer = setTimeout(tick, intervalMs)
    }
  }, 60_000)
}

export function stopConsolidationLoop(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

export function getLastConsolidationAt(): number | null {
  return lastRunAt
}

// ============ mindmap regeneration ============

interface FactRow {
  content: string
  createdAt: string
}

/**
 * Regenerate mindmap.md from recent facts. Returns true if the file was
 * rewritten. Skips the write if nothing changed (no new facts in the
 * last 24h AND the existing file already reflects the current fact set)
 * to avoid needless fs churn and mtime ticks.
 *
 * Precedence: if reflection.ts wrote the mindmap in the last 20 hours,
 * we leave it alone — a curated LLM diagram beats the heuristic. The
 * "written by" line in the frontmatter marks provenance. On a fresh
 * day when reflection hasn't run yet, we own the file.
 */
function regenerateMindmap(): boolean {
  ensureMemoryDir()

  // If the existing mindmap was written by reflection recently, defer.
  try {
    const existing = fs.readFileSync(MINDMAP_FILE, 'utf8')
    const header = existing.slice(0, 400)
    if (/by:\s*reflection/i.test(header)) {
      const updatedMatch = header.match(/updated:\s*([0-9T:-]+)/i)
      if (updatedMatch) {
        const updatedMs = Date.parse(updatedMatch[1]!)
        if (!Number.isNaN(updatedMs) && Date.now() - updatedMs < 20 * 3600 * 1000) {
          return false
        }
      }
    }
  } catch {
    // no existing file — proceed
  }

  const db = getDb()
  // Pull the most recent facts; bias toward newer. 40 is more than we'll
  // render but gives the bucketer some headroom to drop fluff.
  let rows: FactRow[]
  try {
    rows = db
      .prepare(
        `SELECT content, created_at as createdAt
         FROM memories
         WHERE type = 'fact'
         ORDER BY id DESC
         LIMIT 40`,
      )
      .all() as FactRow[]
  } catch {
    return false
  }

  if (rows.length === 0) return false

  const buckets = bucketFacts(rows.map((r) => r.content))
  const nextContent = renderMindmap(buckets)

  // Only write if meaningfully different. Compare normalized body so
  // trailing whitespace / timestamp lines don't churn.
  let current = ''
  try {
    current = fs.readFileSync(MINDMAP_FILE, 'utf8')
  } catch {
    current = ''
  }
  if (normalize(current) === normalize(nextContent)) return false

  fs.writeFileSync(MINDMAP_FILE, nextContent, 'utf8')
  return true
}

function normalize(s: string): string {
  return s
    .split('\n')
    .filter((line) => !/^updated:/i.test(line.trim()))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Buckets {
  identity: string[]
  projects: string[]
  tools: string[]
  preferences: string[]
  people: string[]
  other: string[]
}

/**
 * Bucket facts into mindmap branches using cheap regex. Conservative:
 * anything we can't confidently place goes to 'other' and gets rendered
 * under a catch-all. No LLM call.
 */
function bucketFacts(facts: string[]): Buckets {
  const out: Buckets = {
    identity: [],
    projects: [],
    tools: [],
    preferences: [],
    people: [],
    other: [],
  }
  const seen = new Set<string>()

  for (const raw of facts) {
    const f = raw.trim()
    if (!f) continue
    // De-dupe near-identical facts (first 60 chars, lowercased).
    const key = f.slice(0, 60).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const lower = f.toLowerCase()
    if (
      /\b(email|name|live|work at|role|job title|company)\b/.test(lower) ||
      /@\w+\.\w+/.test(f)
    ) {
      out.identity.push(f)
    } else if (/\b(project|building|shipping|working on|repo|launch)\b/.test(lower)) {
      out.projects.push(f)
    } else if (
      /\b(use|using|uses|prefer|editor|ide|terminal|docker|vscode|cursor|iterm)\b/.test(
        lower,
      )
    ) {
      out.tools.push(f)
    } else if (
      /\b(like|love|hate|avoid|always|never|prefer|don'?t want)\b/.test(lower)
    ) {
      out.preferences.push(f)
    } else if (/^[A-Z][a-z]+ (is|was) /.test(f)) {
      out.people.push(f)
    } else {
      out.other.push(f)
    }
  }

  // Cap each bucket so the diagram stays tight.
  const CAP = 6
  const cap = <T,>(arr: T[]) => arr.slice(0, CAP)
  return {
    identity: cap(out.identity),
    projects: cap(out.projects),
    tools: cap(out.tools),
    preferences: cap(out.preferences),
    people: cap(out.people),
    other: cap(out.other.slice(0, 4)), // tighter cap on the junk drawer
  }
}

function renderMindmap(b: Buckets): string {
  const today = new Date().toISOString().slice(0, 10)
  const lines: string[] = []
  lines.push('---')
  lines.push('name: mindmap')
  lines.push('description: Auto-regenerated from recent facts (short-tick consolidation)')
  lines.push('type: reference')
  lines.push('by: consolidation')
  lines.push(`updated: ${today}`)
  lines.push('---')
  lines.push('')
  lines.push('```mermaid')
  lines.push('mindmap')
  lines.push('  root((you))')

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return
    lines.push(`    ${title}`)
    for (const item of items) {
      lines.push(`      ${sanitize(item)}`)
    }
  }

  section('identity', b.identity)
  section('projects', b.projects)
  section('tools', b.tools)
  section('preferences', b.preferences)
  section('people', b.people)
  section('other', b.other)

  if (
    b.identity.length === 0 &&
    b.projects.length === 0 &&
    b.tools.length === 0 &&
    b.preferences.length === 0 &&
    b.people.length === 0 &&
    b.other.length === 0
  ) {
    lines.push('    unknown')
    lines.push('      say hi, dot will learn')
  }

  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/**
 * Mermaid mindmap node labels cannot contain parens or brackets freely —
 * and very long labels make the diagram unreadable. Clip and strip.
 */
function sanitize(s: string): string {
  return s
    .replace(/["`]/g, '')
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// ============ session summary rollups ============

/**
 * Walk back 24h of conversations, grouped by session_type, and write
 * one heuristic 'summary' memory per session IF none was written for
 * that session today. Deterministic, no LLM call. Nightly reflection
 * can overwrite with richer summaries later.
 */
async function writeSessionSummariesIfDue(): Promise<number> {
  const db = getDb()
  // Track last-rollup timestamps in a tiny key-value table so we don't
  // redo the same session every tick.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  type Row = { session_type: string; n: number }
  let sessions: Row[]
  try {
    sessions = db
      .prepare(
        `SELECT session_type, COUNT(*) as n
         FROM conversations
         WHERE timestamp > datetime('now', '-1 day')
         GROUP BY session_type
         HAVING n >= 4`,
      )
      .all() as Row[]
  } catch {
    return 0
  }

  let written = 0
  for (const { session_type } of sessions) {
    const key = `summary_written:${session_type}`
    const existing = db
      .prepare('SELECT updated_at FROM memory_meta WHERE key = ?')
      .get(key) as { updated_at: string } | undefined
    if (existing) {
      const age = Date.now() - Date.parse(existing.updated_at)
      if (age < 20 * 60 * 60 * 1000) continue // already rolled up in the last 20h
    }

    const summary = buildSessionSummary(session_type)
    if (!summary) continue

    await semanticRemember(summary, 'summary', `session:${session_type}`)
    db.prepare(
      `INSERT INTO memory_meta (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
    ).run(key, 'ok')
    written++
  }
  return written
}

/**
 * Build a compact text summary of the last 24h of turns in a session.
 * Picks up to 8 user turns (the questions/asks are what matter for
 * retrieval), joins them with newlines, and prefixes with a human-
 * readable header so downstream recall knows what it's looking at.
 */
function buildSessionSummary(sessionType: string): string | null {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT role, content, timestamp
       FROM conversations
       WHERE session_type = ?
         AND timestamp > datetime('now', '-1 day')
       ORDER BY id ASC`,
    )
    .all(sessionType) as Array<{ role: string; content: string; timestamp: string }>

  if (rows.length === 0) return null

  const userTurns = rows.filter((r) => r.role === 'user').slice(-8)
  if (userTurns.length === 0) return null

  const dayLabel = new Date().toISOString().slice(0, 10)
  const lines = [`[session ${sessionType} · ${dayLabel}] Topics from the last 24h:`]
  for (const t of userTurns) {
    const preview = t.content.replace(/\s+/g, ' ').slice(0, 160)
    lines.push(`- ${preview}`)
  }
  return lines.join('\n')
}
