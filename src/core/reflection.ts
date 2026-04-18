import { runAgent } from './agent.js'
import { stashFarewellMessage } from './soul.js'

const REFLECTION_PROMPT = `[Background reflection — no user is watching, don't greet or explain.]

Consolidate today's activity into long-term memory, pick tomorrow's callback,
and stash one good thing for the farewell ritual.

# Part 1 — Memory consolidation
1. Read ~/.dot/memory/activity_log.md (it's in your cwd as activity_log.md).
   If it doesn't exist or is empty, skip to Part 2.
2. Identify patterns worth remembering: new projects, heavy-use apps, shifts
   in focus. Ignore noise (transient tabs, one-off searches).
3. Conservatively update memory files if genuinely new: projects.md,
   preferences.md, user_profile.md, mindmap.md. Do NOT fabricate.
4. Update MEMORY.md index if you added/removed files.
5. Trim activity_log.md: keep only entries from the last 3 days.

# Part 2 — Quirks (for future callbacks)
Read ~/.dot/memory/soul/quirks.jsonl (may not exist yet).

Look over today's activity_log.md AND recent diary entries in ~/.dot/memory/diary/
(last few days). Is there a small, specific, non-obvious thing about the user
that would make a good callback weeks from now? Things like:
  - "hates Mondays with standups"
  - "gets stuck on the same type of bug every time"
  - "always takes a walk at 3pm on tuesdays"
  - "the rainy morning kind of person"

If yes, append ONE new quirk line to ~/.dot/memory/soul/quirks.jsonl as a JSON
object:
  {"id":"<short-slug>","fact":"<the small fact>","trigger":"<when to bring it up>","createdAt":"<iso>","lastFiredAt":null}
The 'trigger' should be a human-readable condition Dot will later check against
the current day: e.g. "rainy monday morning", "after 3 hours without a break",
"first Friday of the month". Rate-limited: at most 1 new quirk per reflection.

If nothing clearly new and specific, SKIP. Do not force it. Fake quirks
pollute the callback system. Most reflections should add 0 quirks.

# Part 3 — Farewell "one good thing"
Write ONE short line (under 60 chars, in Dot's voice) to
~/.dot/memory/soul/farewell.txt. This is the line the user sees when they
quit Dot tonight. It should be:
  - specific to today (not generic)
  - warm but not saccharine
  - one sentence, no period at the end, optional emoji
  - phrased as something YOU would say, not a narration
Examples:
  "you shipped the auth fix today ✨"
  "today was quiet. that's okay too"
  "6 PRs and still standing. rest up"
  "i noticed you took that walk. proud of you"
  "the nadir thing finally clicked — saw it happen"
Do NOT use a greeting. Do NOT write more than one line.

# Response
After all three parts, respond with ONE short sentence summarizing what you
did, like "consolidated log, added 1 quirk, farewell stashed ✓". That's it —
this runs in the background and only appears in a tray tooltip.

Rules:
- Be conservative with memory updates.
- Never use the browser for this task.
- Quirks and farewell are OPTIONAL if you can't do them well — skip rather
  than fabricate.`

export interface ReflectionResult {
  summary: string
  error: string | null
}

export async function runReflection(): Promise<ReflectionResult> {
  // Heuristic fact extraction over the last 24h of conversations, writing
  // type='fact' rows the MemoryService ranker prefers. Best-effort — never
  // blocks the reflection agent turn.
  try {
    const { reflect } = await import('./memory-service.js')
    const { extracted } = await reflect(24)
    if (extracted > 0) {
      console.log(`[reflection] extracted ${extracted} facts from last 24h`)
    }
  } catch (err) {
    console.warn('[reflection] fact extraction failed:', (err as Error).message)
  }

  return new Promise((resolve) => {
    const lines: string[] = []
    let errorMsg: string | null = null

    runAgent(REFLECTION_PROMPT, {
      onText: (text) => {
        lines.push(text)
      },
      onTool: () => {},
      onDone: () => {
        resolve({
          summary: lines.join('').trim().slice(0, 200) || 'reflection complete',
          error: errorMsg,
        })
      },
      onError: (err) => {
        errorMsg = err
        resolve({ summary: '', error: err })
      },
    }, {
      freshSession: true,
      channelContext: { channel: 'reflection', label: 'daily-reflection' },
    }).catch((err) => {
      resolve({
        summary: '',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
}

/**
 * Opportunistic farewell seeding: at the end of every successful user-facing
 * agent run, if the final text is short and warm, stash it as a candidate
 * farewell. The nightly reflection will overwrite with a more curated line.
 */
export function maybeSeedFarewell(finalText: string): void {
  const trimmed = finalText.trim()
  if (!trimmed) return
  if (trimmed.length > 80) return
  if (trimmed.includes('\n')) return
  if (/^(error|sorry|⚠|failed)/i.test(trimmed)) return
  stashFarewellMessage(trimmed)
}

export function nextReflectionDelay(hour = 21): number {
  const now = new Date()
  const target = new Date(now)
  target.setHours(hour, 0, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime() - now.getTime()
}

let reflectionTimer: NodeJS.Timeout | null = null

export function scheduleDailyReflection(
  hour = 21,
  onRun?: (result: ReflectionResult) => void,
): void {
  const delay = nextReflectionDelay(hour)
  reflectionTimer = setTimeout(async () => {
    const result = await runReflection()
    onRun?.(result)
    scheduleDailyReflection(hour, onRun)
  }, delay)
}

export function stopDailyReflection(): void {
  if (reflectionTimer) {
    clearTimeout(reflectionTimer)
    reflectionTimer = null
  }
}
