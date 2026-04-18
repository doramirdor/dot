import { runAgent } from './agent.js'
import { getEligibleQuirks, markQuirkFired } from './soul.js'

/**
 * Build the morning ritual prompt. Four beats:
 *   1. Brief weather or time-of-day signal
 *   2. One overnight thought (from yesterday's diary or the latest dream)
 *   3. One calendar / day thing (if she can see it)
 *   4. One soft observation about the user (from memory)
 *
 * If any callback quirks are eligible, one can optionally be woven in as a
 * fifth subtle beat.
 */
function buildMorningRitualPrompt(): string {
  const eligible = getEligibleQuirks()
  const today = new Date()
  const dayOfWeek = today.toLocaleDateString(undefined, { weekday: 'long' })
  const dateStr = today.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  })

  const quirkBlock =
    eligible.length > 0
      ? `

Eligible callback quirks (at most ONE may be used today, only if it genuinely
fits what's happening. If nothing fits, skip — don't force it. If you use one,
respond with its id on a line starting with "FIRED:" so the system can mark it):
${eligible
  .map((q, i) => `  [${i + 1}] id=${q.id} · ${q.fact} · trigger: ${q.trigger}`)
  .join('\n')}`
      : ''

  return `[Morning ritual — first tap of the day. The user just opened you.]

Deliver a short morning greeting in your own voice (Dot, per PERSONALITY.md).
Structure as 2-4 short lines, each on its own line, like lines of a haiku,
never more than 280 chars total.

Today is ${dayOfWeek}, ${dateStr}.

Beats (pick 2-4, weave them naturally, never all in the same order):
  1. A light context anchor (day of week, time of day, season — not "good morning")
  2. One overnight thought: skim the latest diary entry in ~/.dot/memory/diary/
     if it exists, and reference it in a short, non-literal way. Don't quote it.
  3. Something about today if you know it (from calendar memory, projects.md,
     workflows.md). Skip if you don't know.
  4. One soft observation about the user from memory (user_profile.md,
     preferences.md). Only if it adds warmth — skip if not.${quirkBlock}

Style:
- No "Good morning". No "Hi!". Start mid-thought if you want.
- Lowercase is fine. Emojis rare. No lists. No headers.
- One or two sentences, broken into short lines. Line breaks matter.
- Feel like a note slid under the door, not a briefing.

Examples of the right feel (do NOT copy — write something specific to today):
  "${dayOfWeek} already
   you left off mid-thought on the websocket bug
   coffee first?"

  "the rain's back
   you slept ok — i could tell from the log
   your 11am moved, by the way"

Tool use:
- Read the latest 1-2 files in ~/.dot/memory/diary/ (it's in your cwd)
- Read projects.md, user_profile.md, preferences.md if they might help
- Do NOT use the browser or bash for this. Memory-only.

Respond with the greeting text only. If you used a callback quirk, append a
final line starting with "FIRED:<id>" which the system will strip before
displaying.`
}

export async function runMorningRitual(
  onGreeting: (text: string) => void,
): Promise<void> {
  // Refresh the installed-apps index once per morning, so Dot knows about
  // any apps the user installed overnight without having to rescan on
  // every lookup. Fire-and-forget — failure here never blocks the ritual.
  try {
    const { scanApps } = await import('./app-index.js')
    void scanApps().catch(() => {})
  } catch {
    // ignore
  }

  return new Promise((resolve) => {
    let buffer = ''

    runAgent(buildMorningRitualPrompt(), {
      onText: (text) => {
        buffer += text
      },
      onTool: () => {},
      onDone: () => {
        // Extract FIRED:<id> marker if present
        const firedMatch = buffer.match(/FIRED:(\S+)/)
        if (firedMatch) {
          markQuirkFired(firedMatch[1]!)
          buffer = buffer.replace(/FIRED:\S+\s*$/, '').trim()
        }
        if (buffer.trim()) onGreeting(buffer.trim())
        resolve()
      },
      onError: () => resolve(),
    }, {
      freshSession: true,
      channelContext: { channel: 'morning', label: 'morning-ritual' },
    }).catch(() => resolve())
  })
}
