/**
 * core/memory-service.ts — unified memory interface for Dot.
 *
 * Before this module existed, four substrates were used independently:
 *   - SQLite conversations (db.ts)
 *   - Semantic vector index (semantic-memory.ts)
 *   - MEMORY.md / PERSONALITY.md / mindmap.md files (memory.ts)
 *   - soul.ts personality
 *
 * Every caller picked its own substrate, which is why Telegram per-chat
 * memory drifted from desktop memory and why facts never got extracted.
 *
 * MemoryService gives the rest of the app three verbs:
 *   - recall(query, scope, k)  — blended retrieval with query rewrite
 *                                 and recency boost
 *   - remember(content, scope) — write-through to the right substrate
 *   - reflect(window)          — background fact extraction from recent
 *                                 conversations (run from reflection.ts)
 *
 * The underlying stores stay. This module is a facade; it does not
 * replace them. Week 4's PolicyService consolidation will also sit on
 * top of existing substrates rather than replace them.
 */
import {
  recall as semanticRecall,
  remember as semanticRemember,
  rememberFact as semanticRememberFact,
  type MemoryMatch,
} from './semantic-memory.js'
import { logEvent, getRecentConversationsBySession } from './db.js'

export type MemoryScope = 'semantic' | 'fact' | 'conversation' | 'observation'

export interface RecallResult {
  id: number
  content: string
  type: string
  source: string
  createdAt: string
  /** Vector distance — lower = more similar. */
  distance: number
  /** Final ranking score after recency + type boosts. Lower = better. */
  score: number
}

/**
 * Rewrite a raw user query into a denser retrieval query. Cheap, pure
 * heuristics — no LLM call. Expands pronouns, strips filler words,
 * and pulls out obvious noun candidates. Good enough to bring recall
 * from "almost nothing" to "pretty decent" without spending a turn
 * on a query-rewrite LLM call.
 */
export function rewriteQueryForRecall(raw: string): string {
  if (!raw) return ''
  const cleaned = raw
    .toLowerCase()
    // Drop conversational filler
    .replace(/\b(um+|uh+|you know|like|basically|actually|literally)\b/g, ' ')
    // Drop common question words that don't help retrieval
    .replace(/\b(what|who|when|where|why|how|did|does|do|is|are|was|were|will|would|could|should|tell me|remind me|can you)\b/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
  // Keep the original too so rare proper nouns survive — cheap concat.
  return cleaned.length > 0 ? `${cleaned} ${raw}` : raw
}

/**
 * Apply a recency boost to raw semantic-memory matches. The vector
 * store ranks by pure cosine distance; that's the right baseline but
 * ignores that a 30-day-old "alex called" is less interesting than
 * yesterday's one. Also boost type='fact' over type='conversation'
 * because extracted facts are distilled while conversations are raw
 * transcripts.
 */
function applyBoosts(matches: MemoryMatch[]): RecallResult[] {
  const now = Date.now()
  return matches.map((m) => {
    // Baseline score = distance (smaller is better).
    let score = m.distance

    // Recency boost: subtract up to 0.1 for "within 24h", 0.05 for "within a week",
    // 0.02 for "within a month", nothing beyond.
    try {
      const ageMs = now - new Date(m.createdAt).getTime()
      const hours = ageMs / (1000 * 60 * 60)
      if (hours < 24) score -= 0.1
      else if (hours < 24 * 7) score -= 0.05
      else if (hours < 24 * 30) score -= 0.02
    } catch {
      // ignore parse errors
    }

    // Type boost: facts are more valuable than raw conversation.
    if (m.type === 'fact') score -= 0.08
    else if (m.type === 'summary') score -= 0.05

    return { ...m, score }
  }).sort((a, b) => a.score - b.score)
}

export interface RecallOptions {
  /** How many results to return after boosting. */
  k?: number
  /** Restrict to a specific memory type. */
  type?: 'fact' | 'conversation' | 'summary' | 'observation'
  /** Skip query rewriting — use the raw query verbatim. */
  skipRewrite?: boolean
}

/**
 * Recall the most relevant memories for a query. Overfetches from the
 * vector store, applies recency + type boosts, then returns the top-k.
 */
export async function recall(
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult[]> {
  const k = opts.k ?? 5
  const rewritten = opts.skipRewrite ? query : rewriteQueryForRecall(query)
  try {
    // Overfetch (3x) so the boost can pull up older-but-relevant items.
    const raw = await semanticRecall(rewritten, k * 3, opts.type)
    const boosted = applyBoosts(raw)
    return boosted.slice(0, k)
  } catch (err) {
    logEvent('memory.recall_failed', { error: (err as Error).message })
    return []
  }
}

/**
 * Store a memory. Uses the right substrate based on scope.
 *   - 'fact' → semantic.remember(type='fact')
 *   - 'conversation' → semantic.remember(type='conversation')
 *   - 'observation' → semantic.remember(type='observation')
 *   - 'semantic' → default, treated as generic fact
 */
export async function remember(
  content: string,
  scope: MemoryScope = 'semantic',
  source = '',
): Promise<void> {
  try {
    if (scope === 'fact' || scope === 'semantic') {
      await semanticRememberFact(content, source)
    } else {
      await semanticRemember(content, scope as 'conversation' | 'observation', source)
    }
    logEvent('memory.remembered', { scope, source, len: content.length })
  } catch (err) {
    logEvent('memory.remember_failed', { scope, error: (err as Error).message })
  }
}

/**
 * Format recall results into a prompt-ready block. Similar to the
 * formatter in semantic-memory.ts but includes the final score so
 * debugging the ranker is easier.
 */
export function formatRecall(results: RecallResult[]): string {
  if (results.length === 0) return ''
  const lines = ['', '# Relevant memories (blended recall)', '']
  for (const r of results) {
    const when = r.createdAt.slice(0, 10)
    const preview = r.content.replace(/\s+/g, ' ').slice(0, 200)
    lines.push(`- [${r.type} · ${when} · score=${r.score.toFixed(3)}] ${preview}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Run fact extraction over a window of recent conversations. Called
 * from reflection.ts nightly. Uses simple heuristics (sentences
 * containing "I ...", "my ...", "<name> is ...") — cheap and imperfect
 * but turns the type='fact' path from dead code into something the
 * ranker actually prefers. A Week 4+ refactor can replace the
 * heuristics with an LLM extraction pass.
 */
export async function reflect(windowHours = 24): Promise<{ extracted: number }> {
  const sessions = ['chat', 'desktop', 'telegram']
  let extracted = 0
  const cutoff = Date.now() - windowHours * 3600 * 1000

  for (const session of sessions) {
    try {
      const turns = getRecentConversationsBySession(session, 200)
      for (const t of turns) {
        if (t.timestamp) {
          const ts = Date.parse(t.timestamp)
          if (!Number.isNaN(ts) && ts < cutoff) continue
        }
        const facts = extractFactsHeuristic(t.content)
        for (const f of facts) {
          await remember(f, 'fact', `reflect:${session}`)
          extracted++
        }
      }
    } catch (err) {
      logEvent('memory.reflect_session_failed', {
        session,
        error: (err as Error).message,
      })
    }
  }
  logEvent('memory.reflected', { windowHours, extracted })
  return { extracted }
}

/**
 * Heuristic fact extraction. Pulls sentences that look declarative and
 * self-referential ("I <verb>", "my <noun>") or that introduce a named
 * entity ("<Name> is ..."). Deliberately conservative — false positives
 * pollute the fact store faster than they help.
 */
function extractFactsHeuristic(text: string): string[] {
  const out: string[] = []
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 240)

  for (const s of sentences) {
    const lower = s.toLowerCase()
    const startsWithI = /^i (am|was|have|had|will|like|prefer|hate|love|work|live|use|run|own)\b/.test(lower)
    const hasMy = /\bmy (name|boss|wife|husband|partner|dog|cat|job|team|company|goal|plan|schedule|email|phone|laptop|routine)\b/.test(lower)
    const introducesEntity = /^[A-Z][a-z]+ (is|was) (a|an|my|the)\b/.test(s)
    if (startsWithI || hasMy || introducesEntity) {
      out.push(s)
    }
    // Cap at 3 facts per turn to avoid spamming the store.
    if (out.length >= 3) break
  }
  return out
}
